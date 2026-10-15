//! Local task storage in SQLite (WAL mode).
//!
//! Dates are stored as a plain calendar day (`YYYY-MM-DD`) because a task is
//! "due Friday", not "due at an instant". Creation time is stored as UTC plus
//! the IANA zone the user was in, so history stays interpretable after travel.

use std::path::Path;

use chrono::{NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error("invalid date '{0}', expected YYYY-MM-DD")]
    BadDate(String),
    #[error("task title cannot be empty")]
    EmptyTitle,
    #[error("task {0} not found")]
    NotFound(i64),
    #[error("invalid time '{0}', expected HH:MM")]
    BadTime(String),
    #[error("unknown repeat rule '{0}'")]
    BadRecurrence(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: i64,
    pub title: String,
    /// Calendar day, `YYYY-MM-DD`, or `None` for "someday".
    pub due_date: Option<String>,
    /// The original selection, kept so the user can see where a task came from.
    pub source_text: Option<String>,
    pub done: bool,
    /// RFC 3339 UTC timestamp.
    pub created_at: String,
    /// IANA zone at creation, e.g. `America/Los_Angeles`.
    pub created_tz: Option<String>,
    pub completed_at: Option<String>,
    /// Local time of day, `HH:MM`; only set together with `due_date`.
    pub due_time: Option<String>,
    /// Repeat rule (see [`crate::recurrence::Rule`]), e.g. `weekly`.
    pub recurrence: Option<String>,
    /// The app the text was captured in, e.g. `Slack`.
    pub source_app: Option<String>,
    /// That app's bundle identifier, used to reopen it.
    pub source_bundle: Option<String>,
    /// The page or document the text came from, when the app exposes it.
    pub source_url: Option<String>,
    /// Local time (`YYYY-MM-DDTHH:MM:SS`) a snoozed reminder fires again.
    pub snoozed_until: Option<String>,
    /// Local time the last notification for this task was shown.
    pub notified_at: Option<String>,
    /// For a completed repeating task: the occurrence it created.
    pub next_id: Option<i64>,
    /// The user's own description: links, details, anything useful later.
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NewTask {
    pub title: String,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub recurrence: Option<String>,
    pub source_text: Option<String>,
    pub source_app: Option<String>,
    pub source_bundle: Option<String>,
    pub source_url: Option<String>,
    pub notes: Option<String>,
    pub created_tz: Option<String>,
}

/// Partial update. `due_date: Some(None)` clears the date (and the time).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskPatch {
    pub title: Option<String>,
    #[serde(default, with = "double_option")]
    pub due_date: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub due_time: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub recurrence: Option<Option<String>>,
    /// `Some(None)` (or an empty string) clears the description.
    #[serde(default, with = "double_option")]
    pub notes: Option<Option<String>>,
    /// Local `YYYY-MM-DDTHH:MM:SS`; `Some(None)` cancels a snooze.
    #[serde(default, with = "double_option")]
    pub snoozed_until: Option<Option<String>>,
    pub done: Option<bool>,
}

/// What `Store::update` did besides changing the task itself.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdateEffects {
    /// A repeating task was completed and this next occurrence was created.
    pub spawned: Option<i64>,
    /// A completion was undone and this unstarted occurrence was removed.
    pub removed: Option<i64>,
}

mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn serialize<S: Serializer>(v: &Option<Option<String>>, s: S) -> Result<S::Ok, S::Error> {
        v.serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<Option<String>>, D::Error> {
        Option::<String>::deserialize(d).map(Some)
    }
}

const MIGRATIONS: &[&str] = &[
    r#"
CREATE TABLE tasks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT    NOT NULL CHECK (length(trim(title)) > 0),
    due_date      TEXT    CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    source_text   TEXT,
    done          INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL,
    created_tz    TEXT,
    completed_at  TEXT
);
CREATE INDEX tasks_open_due ON tasks (done, due_date);
"#,
    r#"
CREATE TABLE reminder_links (
    task_id      INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    reminder_id  TEXT    NOT NULL UNIQUE,
    base_title   TEXT    NOT NULL,
    base_due     TEXT,
    base_done    INTEGER NOT NULL,
    -- The reminder was deleted in Reminders: keep the task, never re-add it.
    detached     INTEGER NOT NULL DEFAULT 0
);
"#,
    r#"
ALTER TABLE tasks ADD COLUMN due_time TEXT CHECK (due_time IS NULL OR due_time GLOB '[0-2][0-9]:[0-5][0-9]');
ALTER TABLE tasks ADD COLUMN recurrence TEXT;
ALTER TABLE tasks ADD COLUMN source_app TEXT;
ALTER TABLE tasks ADD COLUMN source_bundle TEXT;
ALTER TABLE tasks ADD COLUMN source_url TEXT;
ALTER TABLE tasks ADD COLUMN snoozed_until TEXT;
ALTER TABLE tasks ADD COLUMN notified_at TEXT;
ALTER TABLE tasks ADD COLUMN next_id INTEGER;
"#,
    r#"
ALTER TABLE tasks ADD COLUMN notes TEXT;
"#,
];

/// A Plucky task linked to an external reminder, with the state both sides
/// last agreed on (see `reminders_sync`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReminderLink {
    pub task_id: i64,
    pub reminder_id: String,
    pub base: crate::reminders_sync::SyncState,
    /// The reminder was deleted outside Plucky; the task no longer syncs.
    #[serde(default)]
    pub detached: bool,
}

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self, StoreError> {
        let _mode: String =
            conn.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            conn.execute_batch(sql)?;
            conn.pragma_update(None, "user_version", (i + 1) as i64)?;
        }
        Ok(Self { conn })
    }

    pub fn insert(&self, t: NewTask) -> Result<Task, StoreError> {
        let title = clean_title(&t.title)?;
        let due = t.due_date.as_deref().map(check_date).transpose()?;
        // A time only means something on a day.
        let time = match due {
            Some(_) => t.due_time.as_deref().map(check_time).transpose()?,
            None => None,
        };
        let rule = t.recurrence.as_deref().map(check_rule).transpose()?;
        self.conn.execute(
            "INSERT INTO tasks (title, due_date, due_time, recurrence, source_text, source_app,
                                source_bundle, source_url, created_at, created_tz)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                title,
                due,
                time,
                rule,
                t.source_text,
                clean_opt(t.source_app),
                clean_opt(t.source_bundle),
                clean_opt(t.source_url),
                now(),
                t.created_tz
            ],
        )?;
        let id = self.conn.last_insert_rowid();
        if let Some(notes) = clean_notes(t.notes.as_deref()) {
            self.conn.execute(
                "UPDATE tasks SET notes = ?1 WHERE id = ?2",
                params![notes, id],
            )?;
        }
        self.get(id)
    }

    pub fn get(&self, id: i64) -> Result<Task, StoreError> {
        self.conn
            .query_row(&format!("{SELECT} WHERE id = ?1"), [id], map_row)
            .optional()?
            .ok_or(StoreError::NotFound(id))
    }

    /// Open tasks plus anything completed on or after `done_since`
    /// (`YYYY-MM-DD`, compared against the UTC completion day), ordered for
    /// the day-grouped panel: dated tasks by day, then undated.
    pub fn list(&self, done_since: Option<&str>) -> Result<Vec<Task>, StoreError> {
        let since = done_since
            .map(check_date)
            .transpose()?
            .unwrap_or_else(|| "9999-12-31".into());
        let mut stmt = self.conn.prepare(&format!(
            "{SELECT} WHERE done = 0 OR substr(completed_at, 1, 10) >= ?1
             ORDER BY {ORDER}"
        ))?;
        let rows = stmt.query_map([since], map_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Every task, done or not (for export).
    pub fn all(&self) -> Result<Vec<Task>, StoreError> {
        let mut stmt = self.conn.prepare(&format!("{SELECT} ORDER BY {ORDER}"))?;
        let rows = stmt.query_map([], map_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Record that a notification for this task was shown at `at` (local).
    pub fn mark_notified(&self, id: i64, at: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE tasks SET notified_at = ?1 WHERE id = ?2",
            params![at, id],
        )?;
        Ok(())
    }

    /// Write a consistent copy of the database to `path` (which must not
    /// exist yet). Safe while the app is running.
    pub fn backup_to(&self, path: impl AsRef<Path>) -> Result<(), StoreError> {
        let path = path.as_ref().to_string_lossy().to_string();
        self.conn.execute("VACUUM INTO ?1", [path])?;
        Ok(())
    }

    pub fn update(&self, id: i64, patch: TaskPatch) -> Result<Task, StoreError> {
        self.update_with_effects(id, patch).map(|(t, _)| t)
    }

    /// Apply `patch`. Completing a repeating task creates its next
    /// occurrence; un-completing it removes that occurrence again if it
    /// hasn't been touched.
    pub fn update_with_effects(
        &self,
        id: i64,
        patch: TaskPatch,
    ) -> Result<(Task, UpdateEffects), StoreError> {
        let before = self.get(id)?;
        let mut effects = UpdateEffects::default();
        let tx = self.conn.unchecked_transaction()?;
        if let Some(title) = patch.title {
            tx.execute(
                "UPDATE tasks SET title = ?1 WHERE id = ?2",
                params![clean_title(&title)?, id],
            )?;
        }
        let mut reschedule = false;
        if let Some(due) = patch.due_date {
            let due = due.as_deref().map(check_date).transpose()?;
            if due.is_none() {
                tx.execute("UPDATE tasks SET due_time = NULL WHERE id = ?1", [id])?;
            }
            tx.execute(
                "UPDATE tasks SET due_date = ?1 WHERE id = ?2",
                params![due, id],
            )?;
            reschedule |= due != before.due_date;
        }
        if let Some(time) = patch.due_time {
            let time = time.as_deref().map(check_time).transpose()?;
            // Ignored on an undated task.
            tx.execute(
                "UPDATE tasks SET due_time = CASE WHEN due_date IS NULL THEN NULL ELSE ?1 END WHERE id = ?2",
                params![time, id],
            )?;
            reschedule |= time != before.due_time;
        }
        if let Some(notes) = patch.notes {
            tx.execute(
                "UPDATE tasks SET notes = ?1 WHERE id = ?2",
                params![clean_notes(notes.as_deref()), id],
            )?;
        }
        if let Some(rule) = patch.recurrence {
            let rule = rule.as_deref().map(check_rule).transpose()?;
            tx.execute(
                "UPDATE tasks SET recurrence = ?1 WHERE id = ?2",
                params![rule, id],
            )?;
        }
        if reschedule {
            // A new due moment gets a fresh notification.
            tx.execute(
                "UPDATE tasks SET snoozed_until = NULL, notified_at = NULL WHERE id = ?1",
                [id],
            )?;
        }
        if let Some(snooze) = patch.snoozed_until {
            tx.execute(
                "UPDATE tasks SET snoozed_until = ?1 WHERE id = ?2",
                params![snooze, id],
            )?;
        }
        if let Some(done) = patch.done {
            tx.execute(
                "UPDATE tasks SET done = ?1, completed_at = CASE WHEN ?1 THEN ?2 ELSE NULL END,
                     snoozed_until = NULL WHERE id = ?3",
                params![done, now(), id],
            )?;
            if done && !before.done && before.next_id.is_none() {
                effects.spawned = spawn_next(&tx, id)?;
            }
            if !done && before.done {
                effects.removed = unspawn_next(&tx, &before)?;
            }
        }
        tx.commit()?;
        Ok((self.get(id)?, effects))
    }

    pub fn reminder_links(&self) -> Result<Vec<ReminderLink>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT task_id, reminder_id, base_title, base_due, base_done, detached FROM reminder_links ORDER BY task_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ReminderLink {
                task_id: r.get(0)?,
                reminder_id: r.get(1)?,
                base: crate::reminders_sync::SyncState {
                    title: r.get(2)?,
                    due: r.get(3)?,
                    done: r.get(4)?,
                },
                detached: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn reminder_link(&self, task_id: i64) -> Result<Option<ReminderLink>, StoreError> {
        Ok(self
            .reminder_links()?
            .into_iter()
            .find(|l| l.task_id == task_id))
    }

    /// Create or replace the link for `link.task_id`.
    pub fn save_reminder_link(&self, link: &ReminderLink) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO reminder_links (task_id, reminder_id, base_title, base_due, base_done, detached)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(task_id) DO UPDATE SET reminder_id = ?2, base_title = ?3, base_due = ?4,
                 base_done = ?5, detached = ?6",
            params![
                link.task_id,
                link.reminder_id,
                link.base.title,
                link.base.due,
                link.base.done,
                link.detached
            ],
        )?;
        Ok(())
    }

    pub fn remove_reminder_link(&self, task_id: i64) -> Result<(), StoreError> {
        self.conn
            .execute("DELETE FROM reminder_links WHERE task_id = ?1", [task_id])?;
        Ok(())
    }

    pub fn delete(&self, id: i64) -> Result<(), StoreError> {
        match self.conn.execute("DELETE FROM tasks WHERE id = ?1", [id])? {
            0 => Err(StoreError::NotFound(id)),
            _ => Ok(()),
        }
    }
}

const SELECT: &str = "SELECT id, title, due_date, source_text, done, created_at, created_tz, completed_at,
    due_time, recurrence, source_app, source_bundle, source_url, snoozed_until, notified_at, next_id, notes FROM tasks";

/// By day, all-day tasks before timed ones, then by time.
const ORDER: &str = "due_date IS NULL, due_date, due_time IS NOT NULL, due_time, done, created_at";

fn map_row(r: &Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        title: r.get(1)?,
        due_date: r.get(2)?,
        source_text: r.get(3)?,
        done: r.get(4)?,
        created_at: r.get(5)?,
        created_tz: r.get(6)?,
        completed_at: r.get(7)?,
        due_time: r.get(8)?,
        recurrence: r.get(9)?,
        source_app: r.get(10)?,
        source_bundle: r.get(11)?,
        source_url: r.get(12)?,
        snoozed_until: r.get(13)?,
        notified_at: r.get(14)?,
        next_id: r.get(15)?,
        notes: r.get(16)?,
    })
}

/// Create the next occurrence of repeating task `id` (inside `tx`).
fn spawn_next(tx: &rusqlite::Transaction<'_>, id: i64) -> Result<Option<i64>, StoreError> {
    let t = tx.query_row(&format!("{SELECT} WHERE id = ?1"), [id], map_row)?;
    let Some(rule) = t
        .recurrence
        .as_deref()
        .and_then(crate::recurrence::Rule::parse)
    else {
        return Ok(None);
    };
    let due = t
        .due_date
        .as_deref()
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
    let today = chrono::Local::now().date_naive();
    let next = crate::recurrence::next_due(rule, due, today)
        .format("%Y-%m-%d")
        .to_string();
    tx.execute(
        "INSERT INTO tasks (title, due_date, due_time, recurrence, source_text, source_app,
                            source_bundle, source_url, created_at, created_tz)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            t.title,
            next,
            t.due_time,
            t.recurrence,
            t.source_text,
            t.source_app,
            t.source_bundle,
            t.source_url,
            now(),
            t.created_tz
        ],
    )?;
    let next_id = tx.last_insert_rowid();
    tx.execute(
        "UPDATE tasks SET notes = ?1 WHERE id = ?2",
        params![t.notes, next_id],
    )?;
    tx.execute(
        "UPDATE tasks SET next_id = ?1 WHERE id = ?2",
        params![next_id, id],
    )?;
    Ok(Some(next_id))
}

/// Undo `spawn_next`: remove the next occurrence unless it was completed.
fn unspawn_next(tx: &rusqlite::Transaction<'_>, before: &Task) -> Result<Option<i64>, StoreError> {
    let Some(next) = before.next_id else {
        return Ok(None);
    };
    let removed = tx.execute("DELETE FROM tasks WHERE id = ?1 AND done = 0", [next])?;
    tx.execute("UPDATE tasks SET next_id = NULL WHERE id = ?1", [before.id])?;
    Ok((removed > 0).then_some(next))
}

/// Longest description kept, in characters.
pub const MAX_NOTES_CHARS: usize = 2000;

/// Trimmed, capped, and `None` when empty.
fn clean_notes(s: Option<&str>) -> Option<String> {
    let s = s?.trim();
    (!s.is_empty()).then(|| s.chars().take(MAX_NOTES_CHARS).collect())
}

fn clean_opt(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn check_time(t: &str) -> Result<String, StoreError> {
    chrono::NaiveTime::parse_from_str(t, "%H:%M")
        .map(|nt| nt.format("%H:%M").to_string())
        .map_err(|_| StoreError::BadTime(t.to_string()))
}

fn check_rule(r: &str) -> Result<String, StoreError> {
    crate::recurrence::Rule::parse(r)
        .map(|r| r.as_str().to_string())
        .ok_or_else(|| StoreError::BadRecurrence(r.to_string()))
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn clean_title(t: &str) -> Result<String, StoreError> {
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        Err(StoreError::EmptyTitle)
    } else {
        Ok(t)
    }
}

fn check_date(d: &str) -> Result<String, StoreError> {
    NaiveDate::parse_from_str(d, "%Y-%m-%d")
        .map(|nd| nd.format("%Y-%m-%d").to_string())
        .map_err(|_| StoreError::BadDate(d.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(title: &str, due: Option<&str>) -> NewTask {
        NewTask {
            title: title.into(),
            due_date: due.map(Into::into),
            ..Default::default()
        }
    }

    #[test]
    fn insert_and_list_orders_by_day_then_undated() {
        let s = Store::open_in_memory().unwrap();
        s.insert(task("someday", None)).unwrap();
        s.insert(task("friday", Some("2026-10-16"))).unwrap();
        s.insert(task("today", Some("2026-10-13"))).unwrap();
        let titles: Vec<_> = s.list(None).unwrap().into_iter().map(|t| t.title).collect();
        assert_eq!(titles, ["today", "friday", "someday"]);
    }

    #[test]
    fn rejects_bad_dates_and_empty_titles() {
        let s = Store::open_in_memory().unwrap();
        assert!(matches!(
            s.insert(task("x", Some("Friday"))),
            Err(StoreError::BadDate(_))
        ));
        assert!(matches!(
            s.insert(task("x", Some("2026-02-30"))),
            Err(StoreError::BadDate(_))
        ));
        assert!(matches!(
            s.insert(task("   ", None)),
            Err(StoreError::EmptyTitle)
        ));
    }

    #[test]
    fn update_patch_semantics() {
        let s = Store::open_in_memory().unwrap();
        let t = s.insert(task("a", Some("2026-10-16"))).unwrap();
        let t = s
            .update(
                t.id,
                TaskPatch {
                    title: Some(" b  c ".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(t.title, "b c");
        assert_eq!(t.due_date.as_deref(), Some("2026-10-16"));
        let t = s
            .update(
                t.id,
                TaskPatch {
                    due_date: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(t.due_date, None);
        let t = s
            .update(
                t.id,
                TaskPatch {
                    done: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(t.done && t.completed_at.is_some());
        let t = s
            .update(
                t.id,
                TaskPatch {
                    done: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(!t.done && t.completed_at.is_none());
    }

    #[test]
    fn patch_json_distinguishes_clear_from_absent() {
        let absent: TaskPatch = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(absent.due_date, None);
        let clear: TaskPatch = serde_json::from_str(r#"{"due_date":null}"#).unwrap();
        assert_eq!(clear.due_date, Some(None));
    }

    #[test]
    fn done_tasks_hidden_unless_recent() {
        let s = Store::open_in_memory().unwrap();
        let t = s.insert(task("x", None)).unwrap();
        s.update(
            t.id,
            TaskPatch {
                done: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(s.list(None).unwrap().is_empty());
        assert_eq!(s.list(Some("2000-01-01")).unwrap().len(), 1);
    }

    #[test]
    fn delete_and_not_found() {
        let s = Store::open_in_memory().unwrap();
        let t = s.insert(task("x", None)).unwrap();
        s.delete(t.id).unwrap();
        assert!(matches!(s.delete(t.id), Err(StoreError::NotFound(_))));
    }

    #[test]
    fn file_db_uses_wal_and_migrates_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tasks.db");
        {
            let s = Store::open(&path).unwrap();
            s.insert(task("persisted", None)).unwrap();
        }
        let s = Store::open(&path).unwrap();
        let mode: String = s
            .conn
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        assert_eq!(s.list(None).unwrap()[0].title, "persisted");
    }

    #[test]
    fn reminder_links_round_trip_and_cascade() {
        use crate::reminders_sync::SyncState;
        let s = Store::open_in_memory().unwrap();
        let t = s.insert(task("x", Some("2026-10-16"))).unwrap();
        let mut link = ReminderLink {
            task_id: t.id,
            reminder_id: "ABC-123".into(),
            base: SyncState {
                title: "x".into(),
                due: Some("2026-10-16".into()),
                done: false,
            },
            detached: false,
        };
        s.save_reminder_link(&link).unwrap();
        assert_eq!(s.reminder_link(t.id).unwrap(), Some(link.clone()));
        link.base.done = true;
        s.save_reminder_link(&link).unwrap();
        assert_eq!(s.reminder_links().unwrap(), vec![link]);
        // Deleting the task removes its link.
        s.delete(t.id).unwrap();
        assert!(s.reminder_links().unwrap().is_empty());
    }

    #[test]
    fn times_sort_after_all_day_and_clear_with_the_date() {
        let s = Store::open_in_memory().unwrap();
        let mk = |title: &str, time: Option<&str>| NewTask {
            title: title.into(),
            due_date: Some("2026-10-16".into()),
            due_time: time.map(Into::into),
            ..Default::default()
        };
        s.insert(mk("late", Some("17:30"))).unwrap();
        s.insert(mk("early", Some("9:05"))).unwrap();
        s.insert(mk("all day", None)).unwrap();
        let list = s.list(None).unwrap();
        let titles: Vec<_> = list.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(titles, ["all day", "early", "late"]);
        assert_eq!(list[1].due_time.as_deref(), Some("09:05"));
        let t = s
            .update(
                list[1].id,
                TaskPatch {
                    due_date: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!((t.due_date, t.due_time), (None, None));
        assert!(matches!(
            s.insert(NewTask {
                due_time: Some("25:00".into()),
                ..mk("x", None)
            }),
            Err(StoreError::BadTime(_))
        ));
        // A time without a day is dropped.
        let t = s
            .insert(NewTask {
                title: "y".into(),
                due_time: Some("10:00".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(t.due_time, None);
    }

    #[test]
    fn completing_a_repeating_task_creates_the_next_one_and_undo_removes_it() {
        let s = Store::open_in_memory().unwrap();
        let today = chrono::Local::now().date_naive();
        let t = s
            .insert(NewTask {
                title: "Water plants".into(),
                due_date: Some(today.format("%Y-%m-%d").to_string()),
                due_time: Some("08:00".into()),
                recurrence: Some("daily".into()),
                source_app: Some("Notes".into()),
                ..Default::default()
            })
            .unwrap();
        let (done, fx) = s
            .update_with_effects(
                t.id,
                TaskPatch {
                    done: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        let next_id = fx.spawned.expect("next occurrence");
        assert_eq!(done.next_id, Some(next_id));
        let next = s.get(next_id).unwrap();
        let tomorrow = (today + chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        assert_eq!(next.due_date.as_deref(), Some(tomorrow.as_str()));
        assert_eq!(next.due_time.as_deref(), Some("08:00"));
        assert_eq!(next.recurrence.as_deref(), Some("daily"));
        assert_eq!(next.source_app.as_deref(), Some("Notes"));
        assert!(!next.done);

        // Completing again doesn't spawn twice.
        let (_, fx) = s
            .update_with_effects(
                t.id,
                TaskPatch {
                    done: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(fx.spawned, None);

        // Undo: the untouched next occurrence goes away.
        let (undone, fx) = s
            .update_with_effects(
                t.id,
                TaskPatch {
                    done: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(fx.removed, Some(next_id));
        assert_eq!(undone.next_id, None);
        assert!(matches!(s.get(next_id), Err(StoreError::NotFound(_))));
        assert!(matches!(
            s.insert(NewTask {
                title: "z".into(),
                recurrence: Some("hourly".into()),
                ..Default::default()
            }),
            Err(StoreError::BadRecurrence(_))
        ));
    }

    #[test]
    fn rescheduling_resets_notification_state() {
        let s = Store::open_in_memory().unwrap();
        let t = s.insert(task("x", Some("2026-10-16"))).unwrap();
        s.mark_notified(t.id, "2026-10-16T09:00:00").unwrap();
        let t = s
            .update(
                t.id,
                TaskPatch {
                    snoozed_until: Some(Some("2026-10-16T09:15:00".into())),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(t.notified_at.as_deref(), Some("2026-10-16T09:00:00"));
        assert_eq!(t.snoozed_until.as_deref(), Some("2026-10-16T09:15:00"));
        let t = s
            .update(
                t.id,
                TaskPatch {
                    due_date: Some(Some("2026-10-17".into())),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!((t.notified_at, t.snoozed_until), (None, None));
        // Moving a fired reminder to another day while clearing its snooze
        // also forgets the old notification.
        s.mark_notified(t.id, "2026-10-17T09:00:00").unwrap();
        let t = s
            .update(
                t.id,
                TaskPatch {
                    due_date: Some(Some("2026-10-18".into())),
                    snoozed_until: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!((t.notified_at, t.snoozed_until), (None, None));
    }

    #[test]
    fn descriptions_are_saved_cleared_and_carried_to_the_next_repeat() {
        let s = Store::open_in_memory().unwrap();
        let t = s
            .insert(NewTask {
                title: "Pay rent".into(),
                notes: Some("  https://bank.example/pay  ".into()),
                due_date: Some(
                    chrono::Local::now()
                        .date_naive()
                        .format("%Y-%m-%d")
                        .to_string(),
                ),
                recurrence: Some("monthly".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(t.notes.as_deref(), Some("https://bank.example/pay"));
        let (_, fx) = s
            .update_with_effects(
                t.id,
                TaskPatch {
                    done: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        let next = s.get(fx.spawned.unwrap()).unwrap();
        assert_eq!(next.notes, t.notes);
        let t = s
            .update(
                t.id,
                TaskPatch {
                    notes: Some(Some("   ".into())),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(t.notes, None);
        let long = "x".repeat(MAX_NOTES_CHARS + 10);
        let t = s
            .update(
                t.id,
                TaskPatch {
                    notes: Some(Some(long)),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(t.notes.unwrap().chars().count(), MAX_NOTES_CHARS);
    }

    #[test]
    fn backup_copies_everything() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open_in_memory().unwrap();
        s.insert(task("keep me", None)).unwrap();
        let path = dir.path().join("copy.db");
        s.backup_to(&path).unwrap();
        let copy = Store::open(&path).unwrap();
        assert_eq!(copy.all().unwrap()[0].title, "keep me");
    }

    #[test]
    fn upgrades_a_version_1_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tasks.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATIONS[0]).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute(
                "INSERT INTO tasks (title, created_at) VALUES ('old task', '2026-10-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }
        let s = Store::open(&path).unwrap();
        assert_eq!(s.list(None).unwrap()[0].title, "old task");
        assert!(s.reminder_links().unwrap().is_empty());
    }
}
