//! Backups and export.
//!
//! * Once a day Plucky writes a copy of the task database to
//!   `backups/tasks-YYYY-MM-DD.db` and keeps the newest seven.
//! * Settings can restore one of those copies (the current database is
//!   backed up first) or export every task as CSV or JSON to Downloads.

use std::path::{Path, PathBuf};

use chrono::Local;
use pluck_core::{Store, Task};
use serde::Serialize;

const KEEP: usize = 7;

pub fn backup_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("backups")
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BackupInfo {
    pub name: String,
    /// `YYYY-MM-DD` taken from the file name.
    pub day: String,
    pub size: u64,
}

/// Write today's backup if it doesn't exist yet, then prune old ones.
pub fn daily_backup(store: &Store, data_dir: &Path) -> Result<Option<PathBuf>, String> {
    let dir = backup_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("tasks-{}.db", Local::now().format("%Y-%m-%d")));
    if path.exists() {
        return Ok(None);
    }
    store.backup_to(&path).map_err(|e| e.to_string())?;
    prune(&dir, KEEP);
    Ok(Some(path))
}

fn prune(dir: &Path, keep: usize) {
    let mut all = list_in(dir);
    // Newest first; keep "before-restore" copies out of the rotation count
    // but still prune them with everything else past `keep`.
    all.sort_by(|a, b| b.name.cmp(&a.name));
    for old in all.into_iter().skip(keep) {
        let _ = std::fs::remove_file(dir.join(&old.name));
    }
}

fn list_in(dir: &Path) -> Vec<BackupInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<BackupInfo> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let day = name
                .strip_prefix("tasks-")?
                .strip_suffix(".db")?
                .get(..10)?
                .to_string();
            let size = e.metadata().ok()?.len();
            Some(BackupInfo { name, day, size })
        })
        .collect();
    out.sort_by(|a, b| b.name.cmp(&a.name));
    out
}

pub fn list(data_dir: &Path) -> Vec<BackupInfo> {
    list_in(&backup_dir(data_dir))
}

/// Resolve a backup name from the UI to a path inside the backups folder,
/// refusing anything that tries to leave it.
pub fn backup_path(data_dir: &Path, name: &str) -> Result<PathBuf, String> {
    let ok = name.starts_with("tasks-")
        && name.ends_with(".db")
        && !name.contains(['/', '\\'])
        && !name.contains("..");
    if !ok {
        return Err("That isn't a Todo City backup.".into());
    }
    let path = backup_dir(data_dir).join(name);
    if !path.is_file() {
        return Err("That backup no longer exists.".into());
    }
    Ok(path)
}

/// Copy the current database aside before a restore (or an import) changes
/// it: `tasks-…-before-{what}.db`.
pub fn safety_copy(store: &Store, data_dir: &Path, what: &str) -> Result<PathBuf, String> {
    let dir = backup_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!(
        "tasks-{}-before-{what}.db",
        Local::now().format("%Y-%m-%d-%H%M%S")
    ));
    store.backup_to(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

pub fn to_csv(tasks: &[Task]) -> String {
    let mut out = String::from(
        "title,due_date,due_time,repeats,done,completed_at,created_at,description,source_app,source_url,source_text\n",
    );
    for t in tasks {
        let row = [
            t.title.as_str(),
            t.due_date.as_deref().unwrap_or(""),
            t.due_time.as_deref().unwrap_or(""),
            t.recurrence.as_deref().unwrap_or(""),
            if t.done { "yes" } else { "no" },
            t.completed_at.as_deref().unwrap_or(""),
            t.created_at.as_str(),
            t.notes.as_deref().unwrap_or(""),
            t.source_app.as_deref().unwrap_or(""),
            t.source_url.as_deref().unwrap_or(""),
            t.source_text.as_deref().unwrap_or(""),
        ];
        out.push_str(&row.map(csv_field).join(","));
        out.push('\n');
    }
    out
}

/// A file name in `dir` that doesn't exist yet: `stem.ext`, `stem 2.ext`…
pub fn free_name(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    (2..1000)
        .map(|n| dir.join(format!("{stem} {n}.{ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

pub fn downloads_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let d = home.join("Downloads");
    if d.is_dir() {
        d
    } else {
        home
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pluck_core::NewTask;

    #[test]
    fn csv_escapes_and_has_a_header() {
        let s = Store::open_in_memory().unwrap();
        s.insert(NewTask {
            title: "Reply to \"Sam\", re: budget".into(),
            due_date: Some("2026-10-16".into()),
            source_text: Some("line one\nline two".into()),
            ..Default::default()
        })
        .unwrap();
        let csv = to_csv(&s.all().unwrap());
        let mut lines = csv.lines();
        assert!(lines.next().unwrap().starts_with("title,due_date"));
        assert!(csv.contains("\"Reply to \"\"Sam\"\", re: budget\",2026-10-16"));
        assert!(csv.contains("\"line one\nline two\""));
    }

    #[test]
    fn daily_backup_once_per_day_and_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open_in_memory().unwrap();
        s.insert(NewTask {
            title: "x".into(),
            ..Default::default()
        })
        .unwrap();
        let bdir = backup_dir(dir.path());
        std::fs::create_dir_all(&bdir).unwrap();
        for d in 1..=9 {
            std::fs::write(bdir.join(format!("tasks-2020-01-0{d}.db")), b"old").unwrap();
        }
        assert!(daily_backup(&s, dir.path()).unwrap().is_some());
        assert!(daily_backup(&s, dir.path()).unwrap().is_none());
        let all = list(dir.path());
        assert_eq!(all.len(), KEEP);
        // Today's copy is the newest and it's a real database.
        let newest = backup_path(dir.path(), &all[0].name).unwrap();
        assert_eq!(Store::open(newest).unwrap().all().unwrap().len(), 1);
    }

    #[test]
    fn backup_names_cannot_escape_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        for bad in [
            "../tasks.db",
            "tasks-../../x.db",
            "other.db",
            "tasks-a/b.db",
        ] {
            assert!(backup_path(dir.path(), bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn free_names_count_up() {
        let dir = tempfile::tempdir().unwrap();
        let a = free_name(dir.path(), "Todo City tasks", "csv");
        std::fs::write(&a, "").unwrap();
        let b = free_name(dir.path(), "Todo City tasks", "csv");
        assert!(b.ends_with("Todo City tasks 2.csv"));
    }
}
