//! App preferences that aren't shortcuts or Reminders, saved in
//! `settings.json` next to the task database.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use pluck_core::notify::NotifySettings;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub notify: NotifySettings,
    /// Check for (and download) updates in the background.
    pub auto_update: bool,
    /// Remember which app and page a capture came from.
    pub remember_source: bool,
    /// The first-run walkthrough was finished or skipped.
    pub onboarding_done: bool,
    /// "Open at login" was set up once; after that it's the user's choice.
    pub autostart_initialized: bool,
    /// Last day (`YYYY-MM-DD`) the morning summary went out.
    pub last_summary: Option<String>,
    /// Last day an automatic backup was written.
    pub last_backup: Option<String>,
    /// The "what's new" note for this version was dismissed.
    pub seen_version: Option<String>,
    /// Open the task panel when Plucky starts and the first time the Mac
    /// wakes each day, so it's never out of sight for long.
    pub show_on_start: bool,
    /// Last day (`YYYY-MM-DD`) the panel was shown for that reason.
    pub last_greeted: Option<String>,
    /// The menu-bar icon was given its starting spot (see `tray::place`).
    pub menubar_placed: bool,
    /// Review captures in the dropdown under the menu-bar icon (true) or in
    /// the side panel.
    pub capture_in_menu_bar: bool,
    /// Calendar connector: show events from the Mac's calendars.
    pub calendar_enabled: bool,
    /// Calendars to show (ids); `None` = all.
    pub calendar_ids: Option<Vec<String>>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            notify: NotifySettings::default(),
            auto_update: true,
            remember_source: true,
            onboarding_done: false,
            autostart_initialized: false,
            last_summary: None,
            last_backup: None,
            seen_version: None,
            show_on_start: true,
            last_greeted: None,
            menubar_placed: false,
            capture_in_menu_bar: true,
            calendar_enabled: false,
            calendar_ids: None,
        }
    }
}

pub struct Settings {
    path: PathBuf,
    value: Mutex<AppSettings>,
}

impl Settings {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join("settings.json");
        let value = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            path,
            value: Mutex::new(value),
        }
    }

    pub fn get(&self) -> AppSettings {
        self.value.lock().map(|v| v.clone()).unwrap_or_default()
    }

    /// Change the settings and save them; returns the new value.
    pub fn update(&self, f: impl FnOnce(&mut AppSettings)) -> AppSettings {
        let next = match self.value.lock() {
            Ok(mut v) => {
                f(&mut v);
                v.clone()
            }
            Err(_) => return AppSettings::default(),
        };
        if let Err(e) = self.save(&next) {
            log::warn!("could not save settings: {e}");
        }
        next
    }

    fn save(&self, s: &AppSettings) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(s)?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(tmp, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings::new(dir.path());
        assert!(s.get().notify.enabled && s.get().auto_update && !s.get().onboarding_done);
        s.update(|v| {
            v.onboarding_done = true;
            v.notify.daily_summary = true;
        });
        let again = Settings::new(dir.path());
        assert!(again.get().onboarding_done && again.get().notify.daily_summary);
    }

    #[test]
    fn older_files_keep_new_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"onboarding_done":true}"#,
        )
        .unwrap();
        let s = Settings::new(dir.path()).get();
        assert!(s.onboarding_done && s.auto_update && s.remember_source);
    }
}
