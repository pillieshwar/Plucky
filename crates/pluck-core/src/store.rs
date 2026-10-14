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
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NewTask {
    pub title: String,
    pub due_date: Option<String>,
    pub source_text: Option<String>,
    pub created_tz: Option<String>,
}

/// Partial update. `due_date: Some(None)` clears the date.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskPatch {
    pub title: Option<String>,
    #[serde(default, with = "double_option")]
    pub due_date: Option<Option<String>>,
    pub done: Option<bool>,
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

const MIGRATIONS: &[&str] = &[r#"
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
"#];

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
        self.conn.execute(
            "INSERT INTO tasks (title, due_date, source_text, created_at, created_tz)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![title, due, t.source_text, now(), t.created_tz],
        )?;
        self.get(self.conn.last_insert_rowid())
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
             ORDER BY due_date IS NULL, due_date, done, created_at"
        ))?;
        let rows = stmt.query_map([since], map_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn update(&self, id: i64, patch: TaskPatch) -> Result<Task, StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        if let Some(title) = patch.title {
            tx.execute(
                "UPDATE tasks SET title = ?1 WHERE id = ?2",
                params![clean_title(&title)?, id],
            )?;
        }
        if let Some(due) = patch.due_date {
            let due = due.as_deref().map(check_date).transpose()?;
            tx.execute(
                "UPDATE tasks SET due_date = ?1 WHERE id = ?2",
                params![due, id],
            )?;
        }
        if let Some(done) = patch.done {
            tx.execute(
                "UPDATE tasks SET done = ?1, completed_at = CASE WHEN ?1 THEN ?2 ELSE NULL END WHERE id = ?3",
                params![done, now(), id],
            )?;
        }
        tx.commit()?;
        self.get(id)
    }

    pub fn delete(&self, id: i64) -> Result<(), StoreError> {
        match self.conn.execute("DELETE FROM tasks WHERE id = ?1", [id])? {
            0 => Err(StoreError::NotFound(id)),
            _ => Ok(()),
        }
    }
}

const SELECT: &str = "SELECT id, title, due_date, source_text, done, created_at, created_tz, completed_at FROM tasks";

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
    })
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
}
