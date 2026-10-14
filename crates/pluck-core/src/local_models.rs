//! Using model files the user already has on disk.
//!
//! * [`inspect_gguf`] checks that a path is a readable GGUF model and reads
//!   its display name from the file's metadata.
//! * [`discover`] looks in the places other local-AI apps keep models
//!   (Ollama, LM Studio, the Hugging Face cache) so users can pick one
//!   instead of downloading it again.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Files smaller than this can't be a useful chat model.
const MIN_MODEL_BYTES: u64 = 50 * 1024 * 1024;
const MAX_FOUND: usize = 50;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LocalModelError {
    #[error("No file at that path.")]
    NotFound,
    #[error("That's a folder — choose the model file inside it (it usually ends in .gguf).")]
    IsDirectory,
    #[error("Pluck can't read that file: {0}")]
    Unreadable(String),
    #[error("That isn't a GGUF model file. Pluck runs models in the GGUF format (usually ending in .gguf).")]
    NotGguf,
    #[error("That file is too small to be a language model.")]
    TooSmall,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GgufInfo {
    pub path: PathBuf,
    pub size: u64,
    /// `general.name` from the file's metadata, if present.
    pub name: Option<String>,
}

/// A model found on disk, with where it came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FoundModel {
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
    /// "Ollama", "LM Studio", "Hugging Face".
    pub source: String,
}

/// Turn what a user typed or pasted into a path: trims quotes and spaces,
/// accepts `file://` URLs, and expands a leading `~`.
pub fn normalize_user_path(input: &str, home: Option<&Path>) -> PathBuf {
    let mut s = input.trim().trim_matches(['"', '\'']).trim().to_string();
    if let Some(rest) = s.strip_prefix("file://") {
        s = percent_decode(rest);
    }
    // Paths copied from Terminal often escape spaces.
    s = s.replace("\\ ", " ");
    if let (Some(home), Some(rest)) = (home, s.strip_prefix('~')) {
        let rest = rest.trim_start_matches(['/', '\\']);
        return if rest.is_empty() {
            home.to_path_buf()
        } else {
            home.join(rest)
        };
    }
    PathBuf::from(s)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Check that `path` is a GGUF model and read its name.
pub fn inspect_gguf(path: &Path) -> Result<GgufInfo, LocalModelError> {
    let meta = std::fs::metadata(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => LocalModelError::NotFound,
        _ => LocalModelError::Unreadable(e.to_string()),
    })?;
    if meta.is_dir() {
        return Err(LocalModelError::IsDirectory);
    }
    let file = File::open(path).map_err(|e| LocalModelError::Unreadable(e.to_string()))?;
    let mut r = BufReader::new(file);
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic)
        .map_err(|_| LocalModelError::NotGguf)?;
    if &magic != b"GGUF" {
        return Err(LocalModelError::NotGguf);
    }
    if meta.len() < MIN_MODEL_BYTES {
        return Err(LocalModelError::TooSmall);
    }
    Ok(GgufInfo {
        path: path.to_path_buf(),
        size: meta.len(),
        name: read_general_name(&mut r),
    })
}

/// Read `general.name` from the GGUF header. Stops at the first array value
/// (vocabularies come after the general.* keys) or after a few dozen keys.
fn read_general_name(r: &mut impl Read) -> Option<String> {
    let version = read_u32(r)?;
    if !(2..=3).contains(&version) {
        return None;
    }
    let _tensors = read_u64(r)?;
    let kv_count = read_u64(r)?;
    for _ in 0..kv_count.min(48) {
        let key = read_string(r)?;
        let ty = read_u32(r)?;
        if ty == 8 {
            let value = read_string(r)?;
            if key == "general.name" {
                let v = value.trim().to_string();
                return (!v.is_empty()).then_some(v);
            }
        } else {
            skip_scalar(r, ty)?;
        }
    }
    None
}

fn read_u32(r: &mut impl Read) -> Option<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b).ok()?;
    Some(u32::from_le_bytes(b))
}

fn read_u64(r: &mut impl Read) -> Option<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b).ok()?;
    Some(u64::from_le_bytes(b))
}

fn read_string(r: &mut impl Read) -> Option<String> {
    let len = read_u64(r)?;
    if len > 64 * 1024 {
        return None;
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Skip a scalar value. Returns None for arrays and unknown types, which
/// ends the scan.
fn skip_scalar(r: &mut impl Read, ty: u32) -> Option<()> {
    let n = match ty {
        0 | 1 | 7 => 1,    // u8, i8, bool
        2 | 3 => 2,        // u16, i16
        4 | 5 | 6 => 4,    // u32, i32, f32
        10 | 11 | 12 => 8, // u64, i64, f64
        _ => return None,
    };
    let mut b = [0u8; 8];
    r.read_exact(&mut b[..n]).ok()
}

/// Find GGUF models from other apps under `home`.
pub fn discover(home: &Path) -> Vec<FoundModel> {
    let mut found = Vec::new();
    found.extend(discover_ollama(&home.join(".ollama/models")));
    for (dir, source) in [
        (home.join(".lmstudio/models"), "LM Studio"),
        (home.join(".cache/lm-studio/models"), "LM Studio"),
        (home.join(".cache/huggingface/hub"), "Hugging Face"),
    ] {
        scan_gguf(&dir, source, 0, &mut found);
    }
    found.sort_by(|a, b| a.source.cmp(&b.source).then(a.name.cmp(&b.name)));
    found.dedup_by(|a, b| a.path == b.path);
    found.truncate(MAX_FOUND);
    found
}

fn scan_gguf(dir: &Path, source: &str, depth: usize, out: &mut Vec<FoundModel>) {
    if depth > 6 || out.len() >= MAX_FOUND {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Follows symlinks: the Hugging Face cache links snapshots to blobs.
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            scan_gguf(&path, source, depth + 1, out);
        } else if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("gguf"))
            && meta.len() >= MIN_MODEL_BYTES
            && !is_projector(&path)
        {
            let name = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            out.push(FoundModel {
                name,
                path,
                size: meta.len(),
                source: source.into(),
            });
        }
    }
}

/// Vision projector files ("mmproj") aren't chat models on their own.
fn is_projector(path: &Path) -> bool {
    path.file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase().contains("mmproj"))
        .unwrap_or(false)
}

/// Ollama stores weights as content-addressed blobs, named by manifests at
/// `manifests/<registry>/<namespace>/<model>/<tag>`.
fn discover_ollama(models_dir: &Path) -> Vec<FoundModel> {
    let mut out = Vec::new();
    let manifests = models_dir.join("manifests");
    let mut stack = vec![(manifests.clone(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth < 4 {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let Some(blob) = ollama_model_blob(&path, models_dir) else {
                continue;
            };
            let Ok(meta) = std::fs::metadata(&blob) else {
                continue;
            };
            if meta.len() < MIN_MODEL_BYTES {
                continue;
            }
            out.push(FoundModel {
                name: ollama_display_name(&manifests, &path),
                path: blob,
                size: meta.len(),
                source: "Ollama".into(),
            });
        }
    }
    out
}

fn ollama_model_blob(manifest: &Path, models_dir: &Path) -> Option<PathBuf> {
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(manifest).ok()?).ok()?;
    let digest = json["layers"]
        .as_array()?
        .iter()
        .find(|l| l["mediaType"].as_str() == Some("application/vnd.ollama.image.model"))?["digest"]
        .as_str()?;
    let hex = digest.strip_prefix("sha256:")?;
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(models_dir.join("blobs").join(format!("sha256-{hex}")))
}

/// `registry.ollama.ai/library/llama3.2/3b` → `llama3.2:3b`;
/// `hf.co/user/repo/Q4_K_M` → `hf.co/user/repo:Q4_K_M`.
fn ollama_display_name(manifests: &Path, manifest: &Path) -> String {
    let rel = manifest.strip_prefix(manifests).unwrap_or(manifest);
    let parts: Vec<String> = rel
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    match parts.as_slice() {
        [registry, ns, model, tag] if registry == "registry.ollama.ai" && ns == "library" => {
            format!("{model}:{tag}")
        }
        [registry, ns, model, tag] if registry == "registry.ollama.ai" => {
            format!("{ns}/{model}:{tag}")
        }
        [registry, ns, model, tag] => format!("{registry}/{ns}/{model}:{tag}"),
        _ => parts.join("/"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A GGUF header with a few metadata keys.
    fn gguf_header(name: Option<&str>) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(b"GGUF");
        b.extend_from_slice(&3u32.to_le_bytes());
        b.extend_from_slice(&0u64.to_le_bytes()); // tensors
        let kvs = if name.is_some() { 3u64 } else { 2 };
        b.extend_from_slice(&kvs.to_le_bytes());
        let put_key = |b: &mut Vec<u8>, k: &str| {
            b.extend_from_slice(&(k.len() as u64).to_le_bytes());
            b.extend_from_slice(k.as_bytes());
        };
        put_key(&mut b, "general.architecture");
        b.extend_from_slice(&8u32.to_le_bytes());
        b.extend_from_slice(&5u64.to_le_bytes());
        b.extend_from_slice(b"llama");
        put_key(&mut b, "general.file_type");
        b.extend_from_slice(&4u32.to_le_bytes());
        b.extend_from_slice(&15u32.to_le_bytes());
        if let Some(n) = name {
            put_key(&mut b, "general.name");
            b.extend_from_slice(&8u32.to_le_bytes());
            b.extend_from_slice(&(n.len() as u64).to_le_bytes());
            b.extend_from_slice(n.as_bytes());
        }
        b
    }

    /// Write `bytes`, then extend the file to `size` (sparse, so it's fast).
    fn write(path: &Path, bytes: &[u8], size: u64) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(bytes).unwrap();
        f.set_len(size.max(bytes.len() as u64)).unwrap();
    }

    const BIG: u64 = MIN_MODEL_BYTES;

    #[test]
    fn inspects_valid_gguf_and_reads_name() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("m.gguf");
        write(&p, &gguf_header(Some("Llama 3.2 3B Instruct")), BIG);
        let info = inspect_gguf(&p).unwrap();
        assert_eq!(info.name.as_deref(), Some("Llama 3.2 3B Instruct"));
        assert_eq!(info.size, BIG);
    }

    #[test]
    fn name_is_optional() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("m.gguf");
        write(&p, &gguf_header(None), BIG);
        assert_eq!(inspect_gguf(&p).unwrap().name, None);
    }

    #[test]
    fn rejects_bad_inputs() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            inspect_gguf(&dir.path().join("nope.gguf")),
            Err(LocalModelError::NotFound)
        );
        assert_eq!(inspect_gguf(dir.path()), Err(LocalModelError::IsDirectory));
        let txt = dir.path().join("notes.txt");
        write(&txt, b"not a model", BIG);
        assert_eq!(inspect_gguf(&txt), Err(LocalModelError::NotGguf));
        let small = dir.path().join("small.gguf");
        write(&small, &gguf_header(Some("x")), 1024);
        assert_eq!(inspect_gguf(&small), Err(LocalModelError::TooSmall));
    }

    #[test]
    fn normalizes_user_paths() {
        let home = Path::new("/Users/eshwar");
        assert_eq!(
            normalize_user_path("  ~/Models/llama.gguf ", Some(home)),
            PathBuf::from("/Users/eshwar/Models/llama.gguf")
        );
        assert_eq!(
            normalize_user_path("'/Volumes/My Drive/m.gguf'", Some(home)),
            PathBuf::from("/Volumes/My Drive/m.gguf")
        );
        assert_eq!(
            normalize_user_path("/Users/eshwar/My\\ Models/m.gguf", Some(home)),
            PathBuf::from("/Users/eshwar/My Models/m.gguf")
        );
        assert_eq!(
            normalize_user_path("file:///Users/eshwar/My%20Models/m.gguf", Some(home)),
            PathBuf::from("/Users/eshwar/My Models/m.gguf")
        );
    }

    #[test]
    fn discovers_ollama_lmstudio_and_hf_models() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let hex = "ab".repeat(32);
        // Ollama: manifest -> blob
        write(
            &h.join(format!(".ollama/models/blobs/sha256-{hex}")),
            &gguf_header(None),
            BIG,
        );
        let manifest = serde_json::json!({
            "layers": [
                { "mediaType": "application/vnd.ollama.image.template", "digest": format!("sha256:{}", "cd".repeat(32)) },
                { "mediaType": "application/vnd.ollama.image.model", "digest": format!("sha256:{hex}") }
            ]
        });
        write(
            &h.join(".ollama/models/manifests/registry.ollama.ai/library/llama3.2/3b"),
            manifest.to_string().as_bytes(),
            0,
        );
        // LM Studio
        write(
            &h.join(".lmstudio/models/lmstudio-community/Qwen/Qwen3-4B-Q4_K_M.gguf"),
            &gguf_header(None),
            BIG,
        );
        write(
            &h.join(".lmstudio/models/lmstudio-community/Qwen/mmproj-Qwen3.gguf"),
            &gguf_header(None),
            BIG,
        );
        write(
            &h.join(".lmstudio/models/tiny/too-small.gguf"),
            &gguf_header(None),
            1024,
        );
        // Hugging Face cache
        write(
            &h.join(".cache/huggingface/hub/models--bartowski--Llama/snapshots/abc/Llama-3.2-1B-Q4_K_M.gguf"),
            &gguf_header(None), BIG,
        );

        let found = discover(h);
        let names: Vec<(&str, &str)> = found
            .iter()
            .map(|f| (f.source.as_str(), f.name.as_str()))
            .collect();
        assert_eq!(
            names,
            [
                ("Hugging Face", "Llama-3.2-1B-Q4_K_M"),
                ("LM Studio", "Qwen3-4B-Q4_K_M"),
                ("Ollama", "llama3.2:3b"),
            ]
        );
        assert!(found[2].path.ends_with(format!("sha256-{hex}")));
    }

    #[test]
    fn discover_handles_missing_dirs() {
        let home = tempfile::tempdir().unwrap();
        assert!(discover(home.path()).is_empty());
    }

    #[test]
    fn ollama_names() {
        let m = Path::new("/m");
        assert_eq!(
            ollama_display_name(m, Path::new("/m/registry.ollama.ai/library/qwen3/4b")),
            "qwen3:4b"
        );
        assert_eq!(
            ollama_display_name(m, Path::new("/m/registry.ollama.ai/jane/model/latest")),
            "jane/model:latest"
        );
        assert_eq!(
            ollama_display_name(m, Path::new("/m/hf.co/bartowski/Llama/Q4_K_M")),
            "hf.co/bartowski/Llama:Q4_K_M"
        );
    }
}
