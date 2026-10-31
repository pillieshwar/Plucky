//! The icons of AI apps installed on this Mac (Claude, Codex, Cursor…),
//! read from each app the way Finder shows them, for the Agents settings
//! and the agent panel. Apps that aren't installed get a lettered tile in
//! the UI instead.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use crate::agents::apps;

/// Which app's icon stands for each agent or connector id, first found wins.
const APPS: &[(&str, &[&str])] = &[
    ("claude", &["Claude.app"]),
    ("claude_code", &["Claude.app"]),
    ("claude_desktop", &["Claude.app"]),
    ("codex", &["Codex.app", "ChatGPT.app"]),
    ("antigravity", &["Antigravity.app"]),
    ("cursor", &["Cursor.app"]),
    ("vscode", &["Visual Studio Code.app"]),
    ("windsurf", &["Windsurf.app"]),
    ("lm_studio", &["LM Studio.app"]),
];

static CACHE: Mutex<Option<BTreeMap<String, String>>> = Mutex::new(None);

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding.
pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn find_app(names: &[&str]) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    names.iter().find_map(|n| {
        let mut places = vec![PathBuf::from("/Applications").join(n)];
        if let Some(h) = &home {
            places.push(h.join("Applications").join(n));
        }
        places.into_iter().find(|p| p.is_dir())
    })
}

/// An app's icon as a small PNG, converted by macOS's own `sips`.
fn icon_png(app: &Path, out_dir: &Path) -> Option<Vec<u8>> {
    let plist = app.join("Contents/Info.plist");
    let name = apps::run(
        Command::new("/usr/bin/plutil").args([
            "-extract",
            "CFBundleIconFile",
            "raw",
            "-o",
            "-",
            &plist.to_string_lossy(),
        ]),
        Duration::from_secs(3),
    )
    .ok()?;
    let name = name.trim();
    if name.is_empty() || name.contains('/') {
        return None;
    }
    let file = if name.ends_with(".icns") {
        name.to_string()
    } else {
        format!("{name}.icns")
    };
    let icns = app.join("Contents/Resources").join(file);
    if !icns.is_file() {
        return None;
    }
    let stem = app.file_stem()?.to_string_lossy().replace(' ', "-");
    let png = out_dir.join(format!("{stem}.png"));
    apps::run(
        Command::new("/usr/bin/sips").args([
            "-s",
            "format",
            "png",
            "-Z",
            "64",
            &icns.to_string_lossy(),
            "--out",
            &png.to_string_lossy(),
        ]),
        Duration::from_secs(5),
    )
    .ok()?;
    std::fs::read(&png).ok()
}

fn load() -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if !cfg!(target_os = "macos") {
        return out;
    }
    let dir = std::env::temp_dir().join("todocity-icons");
    if std::fs::create_dir_all(&dir).is_err() {
        return out;
    }
    let mut by_app: BTreeMap<PathBuf, Option<String>> = BTreeMap::new();
    for (id, names) in APPS {
        let Some(app) = find_app(names) else { continue };
        let url = by_app
            .entry(app.clone())
            .or_insert_with(|| {
                icon_png(&app, &dir).map(|png| format!("data:image/png;base64,{}", base64(&png)))
            })
            .clone();
        if let Some(url) = url {
            out.insert((*id).to_string(), url);
        }
    }
    out
}

/// Icons of the AI apps on this Mac, by agent or connector id.
#[tauri::command]
pub async fn app_icons(refresh: bool) -> BTreeMap<String, String> {
    if !refresh {
        if let Some(cached) = CACHE.lock().ok().and_then(|c| c.clone()) {
            return cached;
        }
    }
    let icons = tauri::async_runtime::spawn_blocking(load)
        .await
        .unwrap_or_default();
    if let Ok(mut c) = CACHE.lock() {
        *c = Some(icons.clone());
    }
    icons
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0x00]), "//4A");
    }

    #[test]
    fn every_agent_has_an_icon_rule() {
        for c in todocity_core::agent_runs::CLIS {
            let has = APPS.iter().any(|(id, _)| *id == c.id);
            // Gemini CLI has no app of its own: a lettered tile.
            assert!(has || c.id == "gemini", "{}", c.id);
        }
    }
}
