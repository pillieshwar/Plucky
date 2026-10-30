//! What AI agents did, and undoing it.
//!
//! Every full-access tool call runs inside [`record`]: it notes every task
//! before the call, runs it, and compares. Each task the call added, changed
//! or deleted becomes an `agent_changes` row with how the task was before
//! (so it can be put back) and a short, plain summary ("Today → Monday").
//! Tasks it added or changed are marked with the agent until the person
//! changes them; the UI shows those under "Agents" for 7 days.
//!
//! One call is one *batch*: "Plan my day" scheduling six tasks is undone in
//! one click. Undo restores each task exactly as it was, deleted ones too
//! (with the same sync id, so other Macs see the same task come back).

use std::collections::BTreeMap;

use chrono::{Duration, Utc};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use crate::store::{NewTask, Store, StoreError, Task, TaskPatch};

/// How long agent changes stay listed and marked.
pub const KEEP_DAYS: i64 = 7;

/// One thing an agent did to one task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentChange {
    pub id: i64,
    /// RFC 3339 UTC.
    pub at: String,
    /// The agent as it named itself ("claude-code").
    pub agent: String,
    pub batch: String,
    pub tool: String,
    pub task_id: i64,
    /// "added", "scheduled", "moved", "filed", "completed", "reopened",
    /// "changed" or "deleted".
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub undone: bool,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// A task's content, without what isn't the task itself (who touched it
/// last, when it last notified).
fn content(t: &Task) -> Value {
    let mut v = serde_json::to_value(t).unwrap_or(Value::Null);
    if let Value::Object(m) = &mut v {
        for k in ["agent", "agent_at", "notified_at", "next_id", "id"] {
            m.remove(k);
        }
    }
    v
}

fn when(t: &Task) -> String {
    match (&t.due_date, &t.due_time) {
        (None, _) if t.someday => "Someday".into(),
        (None, _) => "no date".into(),
        (Some(d), None) => d.clone(),
        (Some(d), Some(tm)) => format!("{d} {tm}"),
    }
}

fn place(t: &Task) -> String {
    match (&t.project, &t.heading) {
        (None, _) => "Inbox".into(),
        (Some(p), None) => p.clone(),
        (Some(p), Some(h)) => format!("{p} · # {h}"),
    }
}

/// What kind of change, and a short summary of it.
fn describe(before: &Task, after: &Task) -> (String, String) {
    if !before.done && after.done {
        return ("completed".into(), "Completed".into());
    }
    if before.done && !after.done {
        return ("reopened".into(), "Not done again".into());
    }
    let moved_day = before.due_date != after.due_date || before.someday != after.someday;
    let timed = before.due_time != after.due_time || before.duration != after.duration;
    if moved_day || timed {
        let kind = if after.due_time.is_some() {
            "scheduled"
        } else {
            "moved"
        };
        let len = after
            .duration
            .map(|m| format!(", {m} min"))
            .unwrap_or_default();
        return (
            kind.into(),
            format!("{} → {}{len}", when(before), when(after)),
        );
    }
    if before.project != after.project || before.heading != after.heading {
        return (
            "filed".into(),
            format!("{} → {}", place(before), place(after)),
        );
    }
    if before.title != after.title {
        return ("changed".into(), format!("Renamed from “{}”", before.title));
    }
    ("changed".into(), "Details changed".into())
}

impl Store {
    fn snapshot(&self) -> Result<BTreeMap<i64, Task>, StoreError> {
        Ok(self.all()?.into_iter().map(|t| (t.id, t)).collect())
    }

    /// Each task's sync id, to bring a deleted task back as the same task.
    fn uids(&self) -> Result<BTreeMap<i64, String>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, uid FROM tasks WHERE uid IS NOT NULL")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    #[allow(clippy::too_many_arguments)]
    fn log_change(
        &self,
        agent: &str,
        batch: &str,
        tool: &str,
        task: &Task,
        kind: &str,
        summary: &str,
        before: Option<&Task>,
        uid: Option<&str>,
    ) -> Result<(), StoreError> {
        let before = before.map(|b| {
            let mut v = serde_json::to_value(b).unwrap_or(Value::Null);
            if let (Value::Object(m), Some(uid)) = (&mut v, uid) {
                m.insert("uid".into(), Value::from(uid));
            }
            v.to_string()
        });
        self.conn.execute(
            "INSERT INTO agent_changes (at, agent, batch, tool, task_id, kind, title, summary, before)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![now(), agent, batch, tool, task.id, kind, task.title, summary, before],
        )?;
        Ok(())
    }

    fn mark_agent(&self, id: i64, agent: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE tasks SET agent = ?1, agent_at = ?2 WHERE id = ?3",
            params![agent, now(), id],
        )?;
        Ok(())
    }

    /// Agent changes from the last `days` days, newest first.
    pub fn agent_changes(&self, days: i64) -> Result<Vec<AgentChange>, StoreError> {
        let since =
            (Utc::now() - Duration::days(days)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let mut stmt = self.conn.prepare(
            "SELECT id, at, agent, batch, tool, task_id, kind, title, summary, undone FROM agent_changes
             WHERE at >= ?1 ORDER BY id DESC",
        )?;
        let rows = stmt.query_map([since], |r| {
            Ok(AgentChange {
                id: r.get(0)?,
                at: r.get(1)?,
                agent: r.get(2)?,
                batch: r.get(3)?,
                tool: r.get(4)?,
                task_id: r.get(5)?,
                kind: r.get(6)?,
                title: r.get(7)?,
                summary: r.get(8)?,
                undone: r.get(9)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Forget agent changes older than [`KEEP_DAYS`], and the marks with them.
    pub fn agent_prune(&self) -> Result<(), StoreError> {
        let before = (Utc::now() - Duration::days(KEEP_DAYS))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        self.conn
            .execute("DELETE FROM agent_changes WHERE at < ?1", [&before])?;
        self.conn.execute(
            "UPDATE tasks SET agent = NULL, agent_at = NULL WHERE agent_at < ?1",
            [&before],
        )?;
        Ok(())
    }

    /// Put one change back. Returns whether anything changed.
    fn undo_one(&self, change_id: i64) -> Result<bool, StoreError> {
        let row: Option<(i64, String, Option<String>, bool)> = self
            .conn
            .query_row(
                "SELECT task_id, kind, before, undone FROM agent_changes WHERE id = ?1",
                [change_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((task_id, kind, before, undone)) = row else {
            return Ok(false);
        };
        if undone {
            return Ok(false);
        }
        let before_json: Option<Value> =
            before.as_deref().and_then(|b| serde_json::from_str(b).ok());
        let before: Option<Task> = before.and_then(|b| serde_json::from_str(&b).ok());
        let changed = match (kind.as_str(), before) {
            // Added by the agent: take it away again.
            ("added", _) => match self.get(task_id) {
                Ok(_) => {
                    self.delete(task_id)?;
                    true
                }
                Err(StoreError::NotFound(_)) => false,
                Err(e) => return Err(e),
            },
            // Deleted by the agent: bring it back as it was.
            ("deleted", Some(b)) => {
                let uid = before_json
                    .as_ref()
                    .and_then(|v| v["uid"].as_str().map(String::from));
                self.restore_task(&b, uid.as_deref())?;
                true
            }
            // Changed: put every field back.
            (_, Some(b)) => match self.get(task_id) {
                Ok(_) => {
                    self.update(task_id, patch_back(&b))?;
                    true
                }
                Err(StoreError::NotFound(_)) => false,
                Err(e) => return Err(e),
            },
            _ => false,
        };
        self.conn.execute(
            "UPDATE agent_changes SET undone = 1 WHERE id = ?1",
            [change_id],
        )?;
        Ok(changed)
    }

    /// Undo changes, newest first. Returns how many tasks changed.
    fn undo_where(&self, clause: &str, arg: &dyn rusqlite::ToSql) -> Result<usize, StoreError> {
        let ids: Vec<i64> = {
            let mut stmt = self.conn.prepare(&format!(
                "SELECT id FROM agent_changes WHERE undone = 0 AND {clause} ORDER BY id DESC"
            ))?;
            let rows = stmt.query_map([arg], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut n = 0;
        for id in ids {
            n += usize::from(self.undo_one(id)?);
        }
        Ok(n)
    }

    /// Undo one change.
    pub fn agent_undo_change(&self, change_id: i64) -> Result<usize, StoreError> {
        self.undo_where("id = ?1", &change_id)
    }

    /// Undo everything one agent call did.
    pub fn agent_undo_batch(&self, batch: &str) -> Result<usize, StoreError> {
        self.undo_where("batch = ?1", &batch)
    }

    /// Undo everything agents did to one task.
    pub fn agent_undo_task(&self, task_id: i64) -> Result<usize, StoreError> {
        self.undo_where("task_id = ?1", &task_id)
    }

    /// Bring back a deleted task exactly as it was, with its sync id.
    fn restore_task(&self, t: &Task, uid: Option<&str>) -> Result<i64, StoreError> {
        let made = self.insert(NewTask {
            title: t.title.clone(),
            due_date: t.due_date.clone(),
            due_time: t.due_time.clone(),
            recurrence: t.recurrence.clone(),
            source_text: t.source_text.clone(),
            source_app: t.source_app.clone(),
            source_bundle: t.source_bundle.clone(),
            source_url: t.source_url.clone(),
            notes: t.notes.clone(),
            created_tz: t.created_tz.clone(),
            deadline: t.deadline.clone(),
            evening: t.evening,
            someday: t.someday,
            project: t.project.clone(),
            heading: t.heading.clone(),
            checklist: t.checklist.clone(),
            priority: t.priority,
            duration: t.duration,
        })?;
        self.conn.execute(
            "UPDATE tasks SET created_at = ?1, done = ?2, completed_at = ?3, paused = ?4, series_date = ?5 WHERE id = ?6",
            params![t.created_at, t.done, t.completed_at, t.paused, t.series_date, made.id],
        )?;
        if let Some(uid) = uid {
            // Free unless it came back some other way meanwhile.
            let _ = self.conn.execute(
                "UPDATE tasks SET uid = ?1 WHERE id = ?2",
                params![uid, made.id],
            );
        }
        // Later undos of this task find it under its new id.
        self.conn.execute(
            "UPDATE agent_changes SET task_id = ?1 WHERE task_id = ?2",
            params![made.id, t.id],
        )?;
        Ok(made.id)
    }
}

/// The patch that puts every field of a task back as in `b`.
fn patch_back(b: &Task) -> TaskPatch {
    TaskPatch {
        title: Some(b.title.clone()),
        due_date: Some(b.due_date.clone()),
        due_time: Some(b.due_time.clone()),
        recurrence: Some(b.recurrence.clone()),
        notes: Some(b.notes.clone()),
        snoozed_until: Some(b.snoozed_until.clone()),
        done: Some(b.done),
        deadline: Some(b.deadline.clone()),
        evening: Some(b.evening),
        someday: Some(b.someday),
        project: Some(b.project.clone()),
        heading: Some(b.heading.clone()),
        checklist: Some(b.checklist.clone()),
        paused: Some(b.paused),
        priority: Some(b.priority),
        duration: Some(b.duration),
        only_this: Some(true),
    }
}

/// Run `f` (an agent's tool call) and record what it did to tasks, as one
/// batch. Read-only calls record nothing.
pub fn record<T>(
    store: &Store,
    agent: &str,
    tool: &str,
    f: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let before = store.snapshot().map_err(|e| e.to_string())?;
    let uids = store.uids().map_err(|e| e.to_string())?;
    let out = f()?;
    let after = store.snapshot().map_err(|e| e.to_string())?;
    let batch = format!(
        "{}-{tool}",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    let agent = if agent.trim().is_empty() {
        "agent"
    } else {
        agent
    };
    let log = |task: &Task, kind: &str, summary: &str, prev: Option<&Task>| {
        let uid = uids.get(&task.id).map(String::as_str);
        store
            .log_change(agent, &batch, tool, task, kind, summary, prev, uid)
            .map_err(|e| e.to_string())
    };
    for (id, b) in &before {
        match after.get(id) {
            None => log(b, "deleted", &format!("Deleted from {}", place(b)), Some(b))?,
            Some(a) if content(a) != content(b) => {
                let (kind, summary) = describe(b, a);
                log(a, &kind, &summary, Some(b))?;
                store.mark_agent(a.id, agent).map_err(|e| e.to_string())?;
            }
            Some(_) => {}
        }
    }
    for (id, a) in &after {
        if !before.contains_key(id) {
            // A repeat's next one, made by completing: part of that change.
            let spawned = before.values().any(|b| {
                b.recurrence.is_some() && after.get(&b.id).is_some_and(|x| x.next_id == Some(*id))
            });
            if spawned {
                continue;
            }
            log(a, "added", &format!("Added to {}", place(a)), None)?;
            store.mark_agent(a.id, agent).map_err(|e| e.to_string())?;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(s: &Store, title: &str) -> Task {
        s.insert(NewTask {
            title: title.into(),
            due_date: Some("2026-11-02".into()),
            ..Default::default()
        })
        .unwrap()
    }

    #[test]
    fn records_adds_changes_and_deletes_as_one_batch() {
        let s = Store::open_in_memory().unwrap();
        let keep = task(&s, "Review deck");
        let gone = task(&s, "Old idea");
        record(&s, "claude-ai", "plan", || {
            s.update(
                keep.id,
                TaskPatch {
                    due_time: Some(Some("09:30".into())),
                    duration: Some(Some(45)),
                    ..Default::default()
                },
            )
            .unwrap();
            s.delete(gone.id).unwrap();
            s.insert(NewTask {
                title: "Book taxi".into(),
                ..Default::default()
            })
            .unwrap();
            Ok(())
        })
        .unwrap();
        let log = s.agent_changes(7).unwrap();
        assert_eq!(log.len(), 3);
        assert!(log
            .iter()
            .all(|c| c.batch == log[0].batch && c.agent == "claude-ai"));
        let kinds: Vec<&str> = log.iter().map(|c| c.kind.as_str()).collect();
        assert!(
            kinds.contains(&"scheduled") && kinds.contains(&"deleted") && kinds.contains(&"added")
        );
        let sched = log.iter().find(|c| c.kind == "scheduled").unwrap();
        assert_eq!(sched.summary, "2026-11-02 → 2026-11-02 09:30, 45 min");
        assert_eq!(s.get(keep.id).unwrap().agent.as_deref(), Some("claude-ai"));
    }

    #[test]
    fn reading_records_nothing() {
        let s = Store::open_in_memory().unwrap();
        task(&s, "A");
        record(&s, "claude-ai", "list_tasks", || Ok(s.all().unwrap().len())).unwrap();
        assert!(s.agent_changes(7).unwrap().is_empty());
    }

    #[test]
    fn undoing_a_batch_puts_everything_back() {
        let s = Store::open_in_memory().unwrap();
        let keep = task(&s, "Review deck");
        let gone = task(&s, "Old idea");
        s.update(
            gone.id,
            TaskPatch {
                notes: Some(Some("keep these notes".into())),
                project: Some(Some("Launch".into())),
                ..Default::default()
            },
        )
        .unwrap();
        let gone = s.get(gone.id).unwrap();
        let uid: String = s
            .conn
            .query_row("SELECT uid FROM tasks WHERE id = ?1", [gone.id], |r| {
                r.get(0)
            })
            .unwrap();
        record(&s, "claude-ai", "plan", || {
            s.update(
                keep.id,
                TaskPatch {
                    due_date: Some(Some("2026-11-09".into())),
                    ..Default::default()
                },
            )
            .unwrap();
            s.delete(gone.id).unwrap();
            s.insert(NewTask {
                title: "Book taxi".into(),
                ..Default::default()
            })
            .unwrap();
            Ok(())
        })
        .unwrap();
        let batch = s.agent_changes(7).unwrap()[0].batch.clone();
        assert_eq!(s.agent_undo_batch(&batch).unwrap(), 3);
        let titles: Vec<String> = s.all().unwrap().into_iter().map(|t| t.title).collect();
        assert!(
            titles.contains(&"Old idea".to_string()) && !titles.contains(&"Book taxi".to_string())
        );
        assert_eq!(
            s.get(keep.id).unwrap().due_date.as_deref(),
            Some("2026-11-02")
        );
        assert!(s.get(keep.id).unwrap().agent.is_none());
        let back = s
            .all()
            .unwrap()
            .into_iter()
            .find(|t| t.title == "Old idea")
            .unwrap();
        assert_eq!(
            (back.notes.as_deref(), back.project.as_deref()),
            (Some("keep these notes"), Some("Launch"))
        );
        let back_uid: String = s
            .conn
            .query_row("SELECT uid FROM tasks WHERE id = ?1", [back.id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(back_uid, uid, "the same task for sync, not a copy");
        // Undoing again changes nothing.
        assert_eq!(s.agent_undo_batch(&batch).unwrap(), 0);
        assert!(s.agent_changes(7).unwrap().iter().all(|c| c.undone));
    }

    #[test]
    fn the_person_changing_a_task_makes_it_theirs() {
        let s = Store::open_in_memory().unwrap();
        let t = task(&s, "Review deck");
        record(&s, "cursor", "update_task", || {
            s.update(
                t.id,
                TaskPatch {
                    title: Some("Review the deck".into()),
                    ..Default::default()
                },
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
        assert_eq!(s.get(t.id).unwrap().agent.as_deref(), Some("cursor"));
        s.update(
            t.id,
            TaskPatch {
                priority: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(s.get(t.id).unwrap().agent.is_none());
    }

    #[test]
    fn undoing_a_completion_removes_the_repeats_next_one() {
        let s = Store::open_in_memory().unwrap();
        let t = s
            .insert(NewTask {
                title: "Water plants".into(),
                due_date: Some("2026-11-02".into()),
                recurrence: Some("weekly".into()),
                ..Default::default()
            })
            .unwrap();
        record(&s, "claude-ai", "complete_task", || {
            s.update(
                t.id,
                TaskPatch {
                    done: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
        assert_eq!(s.all().unwrap().len(), 2);
        let log = s.agent_changes(7).unwrap();
        assert_eq!(
            log.len(),
            1,
            "the next one is part of completing, not a separate add"
        );
        s.agent_undo_task(t.id).unwrap();
        let all = s.all().unwrap();
        assert_eq!(all.len(), 1);
        assert!(!all[0].done);
    }

    #[test]
    fn old_changes_are_forgotten() {
        let s = Store::open_in_memory().unwrap();
        let t = task(&s, "A");
        record(&s, "claude-ai", "update_task", || {
            s.update(
                t.id,
                TaskPatch {
                    title: Some("B".into()),
                    ..Default::default()
                },
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
        s.conn
            .execute("UPDATE agent_changes SET at = '2020-01-01T00:00:00Z'", [])
            .unwrap();
        s.conn
            .execute("UPDATE tasks SET agent_at = '2020-01-01T00:00:00Z'", [])
            .unwrap();
        s.agent_prune().unwrap();
        assert!(s.agent_changes(30).unwrap().is_empty());
        assert!(s.get(t.id).unwrap().agent.is_none());
    }
}
