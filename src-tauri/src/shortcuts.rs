//! Configurable global shortcuts, saved in `shortcuts.json`.
//!
//! * Capture selected text — default ⇧⌘S (Ctrl+Shift+S on Windows).
//! * Quick add (type a task) — default ⇧⌘Space (Ctrl+Shift+Space).
//! * Show/hide the panel — optional, unset by default.
//!
//! Shortcuts are kept as plain specs (modifier flags + a W3C key code such
//! as `KeyZ`) and turned into OS registrations on demand.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShortcutSpec {
    /// ⌘ on macOS, the Windows key on Windows.
    pub meta: bool,
    pub ctrl: bool,
    /// ⌥ Option / Alt.
    pub alt: bool,
    pub shift: bool,
    /// W3C key code, e.g. `KeyZ`, `Digit1`, `Space`, `F5`.
    pub code: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Capture,
    QuickAdd,
    TogglePanel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShortcutSettings {
    pub capture: ShortcutSpec,
    /// Missing in files from before 0.2, which get the default.
    #[serde(default = "default_quick_add_opt")]
    pub quick_add: Option<ShortcutSpec>,
    #[serde(default)]
    pub toggle_panel: Option<ShortcutSpec>,
    /// Which built-in defaults this file has been offered (see `new`).
    #[serde(default)]
    pub defaults_version: u32,
}

/// 2 = "Show or hide TodoCity" gained a default (0.3.1), so the panel can be
/// opened while a full-screen app hides the menu bar.
/// 3 = new defaults in 0.4: capture ⇧⌘S (was ⇧⌘Z, which is Redo) and
/// show/hide ⇧⌘H (was ⌥⇧⌘P). Only shortcuts still on the old default move.
const DEFAULTS_VERSION: u32 = 3;

impl Default for ShortcutSettings {
    fn default() -> Self {
        Self {
            capture: default_capture(),
            quick_add: default_quick_add_opt(),
            toggle_panel: Some(default_toggle_panel()),
            defaults_version: DEFAULTS_VERSION,
        }
    }
}

/// ⇧⌘H (Ctrl+Shift+H elsewhere).
pub fn default_toggle_panel() -> ShortcutSpec {
    primary_shift("KeyH")
}

fn primary_shift(code: &str) -> ShortcutSpec {
    ShortcutSpec {
        meta: cfg!(target_os = "macos"),
        ctrl: !cfg!(target_os = "macos"),
        alt: false,
        shift: true,
        code: code.into(),
    }
}

/// The defaults before 0.4, recognised so they can be moved to the new ones.
fn old_default_capture() -> ShortcutSpec {
    primary_shift("KeyZ")
}

fn old_default_toggle_panel() -> ShortcutSpec {
    ShortcutSpec {
        alt: true,
        ..primary_shift("KeyP")
    }
}

pub fn default_quick_add() -> ShortcutSpec {
    ShortcutSpec {
        meta: cfg!(target_os = "macos"),
        ctrl: !cfg!(target_os = "macos"),
        alt: false,
        shift: true,
        code: "Space".into(),
    }
}

fn default_quick_add_opt() -> Option<ShortcutSpec> {
    Some(default_quick_add())
}

impl ShortcutSettings {
    /// Every configured shortcut with its action.
    fn all(&self) -> Vec<(Action, &ShortcutSpec)> {
        let mut v = vec![(Action::Capture, &self.capture)];
        if let Some(q) = &self.quick_add {
            v.push((Action::QuickAdd, q));
        }
        if let Some(t) = &self.toggle_panel {
            v.push((Action::TogglePanel, t));
        }
        v
    }
}

/// ⇧⌘S (Ctrl+Shift+S elsewhere) — S for selection.
pub fn default_capture() -> ShortcutSpec {
    primary_shift("KeyS")
}

impl ShortcutSpec {
    fn primary_only(&self) -> bool {
        let primary = if cfg!(target_os = "macos") {
            self.meta && !self.ctrl
        } else {
            self.ctrl && !self.meta
        };
        primary && !self.alt && !self.shift
    }

    /// Reject combinations that would break the system or basic editing.
    pub fn validate(&self) -> Result<(), String> {
        if !(self.meta || self.ctrl || self.alt) {
            return Err("Include ⌘, ⌃ or ⌥ so the shortcut doesn't fire while you type.".into());
        }
        if self.code.starts_with("Meta")
            || self.code.starts_with("Control")
            || self.code.starts_with("Alt")
            || self.code.starts_with("Shift")
        {
            return Err("Finish the shortcut with a letter, number or other key.".into());
        }
        let reserved = [
            "KeyC", "KeyV", "KeyX", "KeyA", "KeyZ", "KeyQ", "KeyW", "Tab", "Space",
        ];
        if self.primary_only() && reserved.contains(&self.code.as_str()) {
            return Err(format!(
                "{} is used by the system for basic editing or switching apps.",
                self.label()
            ));
        }
        if cfg!(target_os = "macos")
            && self.meta
            && self.shift
            && !self.alt
            && !self.ctrl
            && ["Digit3", "Digit4", "Digit5"].contains(&self.code.as_str())
        {
            return Err(format!(
                "{} is the macOS screenshot shortcut.",
                self.label()
            ));
        }
        Ok(())
    }

    pub fn to_shortcut(&self) -> Result<Shortcut, String> {
        self.validate()?;
        let code = parse_code(&self.code)
            .ok_or_else(|| format!("TodoCity can't use the key “{}” in a shortcut.", self.code))?;
        let mut mods = Modifiers::empty();
        if self.meta {
            mods |= Modifiers::SUPER;
        }
        if self.ctrl {
            mods |= Modifiers::CONTROL;
        }
        if self.alt {
            mods |= Modifiers::ALT;
        }
        if self.shift {
            mods |= Modifiers::SHIFT;
        }
        Ok(Shortcut::new(Some(mods), code))
    }

    /// "⌘⇧Z" on macOS, "Ctrl+Shift+Z" elsewhere.
    pub fn label(&self) -> String {
        let key = key_label(&self.code);
        if cfg!(target_os = "macos") {
            let mut s = String::new();
            if self.ctrl {
                s.push('⌃');
            }
            if self.alt {
                s.push('⌥');
            }
            if self.shift {
                s.push('⇧');
            }
            if self.meta {
                s.push('⌘');
            }
            s + &key
        } else {
            let mut parts = Vec::new();
            if self.ctrl {
                parts.push("Ctrl".to_string());
            }
            if self.meta {
                parts.push("Win".to_string());
            }
            if self.alt {
                parts.push("Alt".to_string());
            }
            if self.shift {
                parts.push("Shift".to_string());
            }
            parts.push(key);
            parts.join("+")
        }
    }
}

/// The keys TodoCity accepts in shortcuts, by W3C code name.
fn parse_code(code: &str) -> Option<Code> {
    Some(match code {
        "KeyA" => Code::KeyA,
        "KeyB" => Code::KeyB,
        "KeyC" => Code::KeyC,
        "KeyD" => Code::KeyD,
        "KeyE" => Code::KeyE,
        "KeyF" => Code::KeyF,
        "KeyG" => Code::KeyG,
        "KeyH" => Code::KeyH,
        "KeyI" => Code::KeyI,
        "KeyJ" => Code::KeyJ,
        "KeyK" => Code::KeyK,
        "KeyL" => Code::KeyL,
        "KeyM" => Code::KeyM,
        "KeyN" => Code::KeyN,
        "KeyO" => Code::KeyO,
        "KeyP" => Code::KeyP,
        "KeyQ" => Code::KeyQ,
        "KeyR" => Code::KeyR,
        "KeyS" => Code::KeyS,
        "KeyT" => Code::KeyT,
        "KeyU" => Code::KeyU,
        "KeyV" => Code::KeyV,
        "KeyW" => Code::KeyW,
        "KeyX" => Code::KeyX,
        "KeyY" => Code::KeyY,
        "KeyZ" => Code::KeyZ,
        "Digit0" => Code::Digit0,
        "Digit1" => Code::Digit1,
        "Digit2" => Code::Digit2,
        "Digit3" => Code::Digit3,
        "Digit4" => Code::Digit4,
        "Digit5" => Code::Digit5,
        "Digit6" => Code::Digit6,
        "Digit7" => Code::Digit7,
        "Digit8" => Code::Digit8,
        "Digit9" => Code::Digit9,
        "F1" => Code::F1,
        "F2" => Code::F2,
        "F3" => Code::F3,
        "F4" => Code::F4,
        "F5" => Code::F5,
        "F6" => Code::F6,
        "F7" => Code::F7,
        "F8" => Code::F8,
        "F9" => Code::F9,
        "F10" => Code::F10,
        "F11" => Code::F11,
        "F12" => Code::F12,
        "Space" => Code::Space,
        "Enter" => Code::Enter,
        "Tab" => Code::Tab,
        "Backspace" => Code::Backspace,
        "Escape" => Code::Escape,
        "ArrowUp" => Code::ArrowUp,
        "ArrowDown" => Code::ArrowDown,
        "ArrowLeft" => Code::ArrowLeft,
        "ArrowRight" => Code::ArrowRight,
        "Comma" => Code::Comma,
        "Period" => Code::Period,
        "Slash" => Code::Slash,
        "Semicolon" => Code::Semicolon,
        "Quote" => Code::Quote,
        "BracketLeft" => Code::BracketLeft,
        "BracketRight" => Code::BracketRight,
        "Backslash" => Code::Backslash,
        "Backquote" => Code::Backquote,
        "Minus" => Code::Minus,
        "Equal" => Code::Equal,
        _ => return None,
    })
}

fn key_label(code: &str) -> String {
    if let Some(k) = code.strip_prefix("Key") {
        return k.to_string();
    }
    if let Some(d) = code.strip_prefix("Digit") {
        return d.to_string();
    }
    match code {
        "Space" => "Space",
        "ArrowUp" => "↑",
        "ArrowDown" => "↓",
        "ArrowLeft" => "←",
        "ArrowRight" => "→",
        "Enter" => "↩",
        "Backspace" => "⌫",
        "Comma" => ",",
        "Period" => ".",
        "Slash" => "/",
        "Semicolon" => ";",
        "Quote" => "'",
        "BracketLeft" => "[",
        "BracketRight" => "]",
        "Backslash" => "\\",
        "Backquote" => "`",
        "Minus" => "-",
        "Equal" => "=",
        other => other,
    }
    .to_string()
}

/// Every shortcut must be valid and different from the others.
fn check_distinct(s: &ShortcutSettings) -> Result<(), String> {
    let all = s.all();
    for (i, (_, a)) in all.iter().enumerate() {
        a.to_shortcut()?;
        if all[..i].iter().any(|(_, b)| b == a) {
            return Err(format!(
                "{} is already used by another TodoCity shortcut.",
                a.label()
            ));
        }
    }
    Ok(())
}

pub struct Shortcuts {
    path: PathBuf,
    settings: Mutex<ShortcutSettings>,
}

impl Shortcuts {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join("shortcuts.json");
        let mut settings: ShortcutSettings = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        if settings.capture.to_shortcut().is_err() {
            settings.capture = default_capture();
        }
        if settings.defaults_version < DEFAULTS_VERSION {
            // Offer the new panel shortcut once, unless the user already
            // set one (or it would clash with theirs).
            if settings.defaults_version < 2 && settings.toggle_panel.is_none() {
                settings.toggle_panel = Some(default_toggle_panel());
                if check_distinct(&settings).is_err() {
                    settings.toggle_panel = None;
                }
            }
            if settings.defaults_version < 3 {
                // Move shortcuts still on the old defaults; keep anything the
                // user picked, and back off if the new key clashes with theirs.
                let before = settings.clone();
                if settings.capture == old_default_capture() {
                    settings.capture = default_capture();
                }
                if settings.toggle_panel == Some(old_default_toggle_panel()) {
                    settings.toggle_panel = Some(default_toggle_panel());
                }
                if check_distinct(&settings).is_err() {
                    settings = before;
                }
            }
            settings.defaults_version = DEFAULTS_VERSION;
            if let Ok(bytes) = serde_json::to_vec_pretty(&settings) {
                let _ = std::fs::write(&path, bytes);
            }
        }
        if check_distinct(&settings).is_err() {
            settings.quick_add = None;
        }
        Self {
            path,
            settings: Mutex::new(settings),
        }
    }

    pub fn get(&self) -> ShortcutSettings {
        self.settings.lock().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn capture_label(&self) -> String {
        self.get().capture.label()
    }

    pub fn toggle_panel_label(&self) -> Option<String> {
        self.get().toggle_panel.map(|t| t.label())
    }

    pub fn quick_add_label(&self) -> Option<String> {
        self.get().quick_add.map(|q| q.label())
    }

    /// Which action, if any, a pressed shortcut belongs to.
    pub fn action_for(&self, pressed: &Shortcut) -> Option<Action> {
        let s = self.get();
        s.all()
            .into_iter()
            .find(|(_, spec)| spec.to_shortcut().ok().as_ref() == Some(pressed))
            .map(|(a, _)| a)
    }

    fn save(&self, s: &ShortcutSettings) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, bytes).map_err(|e| e.to_string())
    }

    /// Register every configured shortcut with the OS.
    pub fn register_all(&self, app: &AppHandle) {
        let s = self.get();
        let gs = app.global_shortcut();
        for (_, spec) in s.all() {
            match spec.to_shortcut() {
                Ok(sc) => {
                    if let Err(e) = gs.register(sc) {
                        log::error!("could not register {}: {e}", spec.label());
                    }
                }
                Err(e) => log::error!("invalid shortcut {}: {e}", spec.label()),
            }
        }
    }

    /// Stop listening (while the user records a new shortcut), or resume.
    pub fn pause(&self, app: &AppHandle, paused: bool) {
        let _ = app.global_shortcut().unregister_all();
        if !paused {
            self.register_all(app);
        }
    }

    /// Change one shortcut; `None` clears it (only the panel shortcut can be
    /// cleared). On failure the previous shortcuts stay registered.
    pub fn set(
        &self,
        app: &AppHandle,
        action: Action,
        spec: Option<ShortcutSpec>,
    ) -> Result<ShortcutSettings, String> {
        let old = self.get();
        let mut next = old.clone();
        match (action, spec) {
            (Action::Capture, Some(s)) => next.capture = s,
            (Action::Capture, None) => return Err("The capture shortcut can't be empty.".into()),
            (Action::QuickAdd, s) => next.quick_add = s,
            (Action::TogglePanel, s) => next.toggle_panel = s,
        }
        check_distinct(&next)?;
        self.apply(app, &old, next)
    }

    pub fn reset(&self, app: &AppHandle) -> Result<ShortcutSettings, String> {
        let old = self.get();
        self.apply(app, &old, ShortcutSettings::default())
    }

    fn apply(
        &self,
        app: &AppHandle,
        old: &ShortcutSettings,
        next: ShortcutSettings,
    ) -> Result<ShortcutSettings, String> {
        let gs = app.global_shortcut();
        let _ = gs.unregister_all();
        let mut failed = None;
        for (_, spec) in next.all() {
            if let Ok(sc) = spec.to_shortcut() {
                if let Err(e) = gs.register(sc) {
                    failed = Some(format!(
                        "{} couldn't be registered — another app may be using it. ({e})",
                        spec.label()
                    ));
                    break;
                }
            }
        }
        if let Some(msg) = failed {
            // Roll back to the shortcuts that worked before.
            let _ = gs.unregister_all();
            if let Ok(mut s) = self.settings.lock() {
                *s = old.clone();
            }
            self.register_all(app);
            return Err(msg);
        }
        self.save(&next)?;
        if let Ok(mut s) = self.settings.lock() {
            *s = next.clone();
        }
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(meta: bool, ctrl: bool, alt: bool, shift: bool, code: &str) -> ShortcutSpec {
        ShortcutSpec {
            meta,
            ctrl,
            alt,
            shift,
            code: code.into(),
        }
    }

    #[test]
    fn default_is_primary_shift_s() {
        let d = default_capture();
        assert!(d.shift && d.code == "KeyS");
        assert!(d.validate().is_ok());
        assert!(d.to_shortcut().is_ok());
    }

    #[test]
    fn requires_a_real_modifier() {
        assert!(spec(false, false, false, true, "KeyZ").validate().is_err());
        assert!(spec(false, false, false, false, "KeyZ").validate().is_err());
        assert!(spec(false, false, true, false, "KeyZ").validate().is_ok());
    }

    #[test]
    fn rejects_modifier_only_and_reserved() {
        assert!(spec(true, false, false, true, "ShiftLeft")
            .validate()
            .is_err());
        let primary_c = if cfg!(target_os = "macos") {
            spec(true, false, false, false, "KeyC")
        } else {
            spec(false, true, false, false, "KeyC")
        };
        assert!(primary_c.validate().is_err());
    }

    #[test]
    fn labels() {
        let s = spec(true, false, false, true, "KeyZ");
        let l = s.label();
        if cfg!(target_os = "macos") {
            assert_eq!(l, "⇧⌘Z");
        } else {
            assert_eq!(l, "Win+Shift+Z");
        }
        assert_eq!(key_label("Digit5"), "5");
        assert_eq!(key_label("ArrowUp"), "↑");
        assert_eq!(key_label("F5"), "F5");
    }

    #[test]
    fn parses_common_codes() {
        for code in [
            "KeyZ", "Digit1", "Space", "F5", "ArrowUp", "Slash", "Period",
        ] {
            assert!(
                spec(false, true, true, false, code).to_shortcut().is_ok(),
                "{code}"
            );
        }
        assert!(spec(false, true, true, false, "NotAKey")
            .to_shortcut()
            .is_err());
    }

    #[test]
    fn settings_file_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let s = Shortcuts::new(dir.path());
        assert_eq!(s.get().capture, default_capture());
        let custom = ShortcutSettings {
            capture: spec(false, true, true, false, "KeyT"),
            quick_add: None,
            toggle_panel: Some(spec(false, true, true, false, "KeyY")),
            defaults_version: DEFAULTS_VERSION,
        };
        s.save(&custom).unwrap();
        let s2 = Shortcuts::new(dir.path());
        assert_eq!(s2.get().capture, custom.capture);
        assert_eq!(s2.get().toggle_panel, custom.toggle_panel);
        assert_eq!(s2.get().quick_add, None);
    }

    #[test]
    fn old_files_get_the_quick_add_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("shortcuts.json"),
            r#"{"capture":{"meta":false,"ctrl":true,"alt":true,"shift":false,"code":"KeyT"}}"#,
        )
        .unwrap();
        let s = Shortcuts::new(dir.path()).get();
        assert_eq!(s.quick_add, Some(default_quick_add()));
        assert!(default_quick_add().validate().is_ok());
        // Older files also get the show/hide shortcut, once.
        assert_eq!(s.toggle_panel, Some(default_toggle_panel()));
        assert!(default_toggle_panel().validate().is_ok());
    }

    #[test]
    fn old_defaults_move_to_the_new_ones() {
        let dir = tempfile::tempdir().unwrap();
        let old = ShortcutSettings {
            capture: old_default_capture(),
            quick_add: Some(default_quick_add()),
            toggle_panel: Some(old_default_toggle_panel()),
            defaults_version: 2,
        };
        std::fs::write(
            dir.path().join("shortcuts.json"),
            serde_json::to_vec(&old).unwrap(),
        )
        .unwrap();
        let s = Shortcuts::new(dir.path()).get();
        assert_eq!(s.capture, default_capture());
        assert_eq!(s.toggle_panel, Some(default_toggle_panel()));
        assert_eq!(s.defaults_version, DEFAULTS_VERSION);
    }

    #[test]
    fn custom_shortcuts_survive_the_new_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let mine = ShortcutSettings {
            capture: spec(false, true, true, false, "KeyT"),
            quick_add: Some(default_quick_add()),
            toggle_panel: Some(spec(false, true, true, false, "KeyY")),
            defaults_version: 2,
        };
        std::fs::write(
            dir.path().join("shortcuts.json"),
            serde_json::to_vec(&mine).unwrap(),
        )
        .unwrap();
        let s = Shortcuts::new(dir.path()).get();
        assert_eq!(s.capture, mine.capture);
        assert_eq!(s.toggle_panel, mine.toggle_panel);
    }

    #[test]
    fn a_cleared_panel_shortcut_stays_cleared() {
        let dir = tempfile::tempdir().unwrap();
        let s = Shortcuts::new(dir.path());
        let mut cleared = s.get();
        cleared.toggle_panel = None;
        s.save(&cleared).unwrap();
        assert_eq!(Shortcuts::new(dir.path()).get().toggle_panel, None);
    }

    #[test]
    fn duplicate_shortcuts_are_rejected() {
        let mut s = ShortcutSettings::default();
        assert!(check_distinct(&s).is_ok());
        s.toggle_panel = Some(s.capture.clone());
        assert!(check_distinct(&s).is_err());
    }

    #[test]
    fn invalid_saved_capture_falls_back_to_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("shortcuts.json"),
            r#"{"capture":{"meta":false,"ctrl":false,"alt":false,"shift":true,"code":"KeyZ"}}"#,
        )
        .unwrap();
        assert_eq!(Shortcuts::new(dir.path()).get().capture, default_capture());
    }
}
