//! Platform-independent rules for two-way sync with an external reminders
//! app (Apple Reminders on macOS).
//!
//! Each linked task keeps a *base*: the title, due day and done state both
//! sides last agreed on. On every sync pass we compare the base with the
//! current Plucky task (local) and the current reminder (remote) and merge
//! field by field — a three-way merge, like version control:
//!
//! * only one side changed a field → that change wins;
//! * both changed the same field → the reminder wins (it is the side the
//!   user most recently touched outside Plucky, e.g. on their iPhone).
//!
//! Deleting a reminder never deletes the Plucky task; the task is *detached*
//! and is never re-added to Reminders.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::store::{NewTask, ReminderLink, Store, StoreError, Task, TaskPatch};

/// The synced fields of a task or reminder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncState {
    pub title: String,
    /// `YYYY-MM-DD`
    pub due: Option<String>,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merge {
    /// What both sides should hold now; becomes the new base.
    pub result: SyncState,
    /// The reminder must be updated.
    pub push_remote: bool,
    /// The Plucky task must be updated.
    pub update_local: bool,
}

fn pick<T: PartialEq + Clone>(base: &T, local: &T, remote: &T) -> T {
    if remote != base {
        remote.clone()
    } else {
        local.clone()
    }
}

pub fn merge(base: &SyncState, local: &SyncState, remote: &SyncState) -> Merge {
    let result = SyncState {
        title: pick(&base.title, &local.title, &remote.title),
        due: pick(&base.due, &local.due, &remote.due),
        done: pick(&base.done, &local.done, &remote.done),
    };
    Merge {
        push_remote: result != *remote,
        update_local: result != *local,
        result,
    }
}

fn normalize(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Pair unlinked Plucky tasks with unlinked reminders that are evidently the
/// same item (same title, ignoring case and spacing, and the same due day),
/// so turning sync back on doesn't create duplicates. Each side is used at
/// most once. Returns `(local_index, remote_index)` pairs.
pub fn pair_duplicates(local: &[SyncState], remote: &[SyncState]) -> Vec<(usize, usize)> {
    let mut used = vec![false; remote.len()];
    let mut pairs = Vec::new();
    for (li, l) in local.iter().enumerate() {
        let key = normalize(&l.title);
        if let Some(ri) = remote
            .iter()
            .enumerate()
            .position(|(ri, r)| !used[ri] && r.due == l.due && normalize(&r.title) == key)
        {
            used[ri] = true;
            pairs.push((li, ri));
        }
    }
    pairs
}

impl SyncState {
    pub fn of_task(t: &Task) -> Self {
        Self {
            title: t.title.clone(),
            due: t.due_date.clone(),
            done: t.done,
        }
    }
}

/// The reminders app, as the sync pass needs it. Implementations must not
/// panic; failures are reported as `Err(message)`.
pub trait RemindersBackend {
    /// The reminder's current state; `Ok(None)` if it no longer exists.
    fn get(&mut self, id: &str) -> Result<Option<SyncState>, String>;
    fn update(&mut self, id: &str, state: &SyncState) -> Result<(), String>;
    /// Create a reminder in `list_id`; returns its identifier.
    fn create(
        &mut self,
        list_id: &str,
        state: &SyncState,
        notes: Option<&str>,
    ) -> Result<String, String>;
    /// Incomplete reminders currently in `list_id`.
    fn incomplete_in_list(&mut self, list_id: &str) -> Result<Vec<(String, SyncState)>, String>;
}

pub struct PassOptions<'a> {
    pub list_id: &'a str,
    /// Put the original selected text in the reminder's notes.
    pub include_notes: bool,
    /// Only tasks created at or after this RFC 3339 time get new reminders
    /// (so turning sync on doesn't push old tasks unless asked).
    pub sync_since: Option<&'a str>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct PassReport {
    /// Plucky tasks updated from Reminders.
    pub pulled: usize,
    /// Reminders updated from Plucky.
    pub pushed: usize,
    /// New reminders created for Plucky tasks.
    pub created: usize,
    /// New Plucky tasks created from reminders.
    pub imported: usize,
    /// Tasks detached because their reminder was deleted.
    pub unlinked: usize,
    /// Per-item failures; the rest of the pass still ran.
    pub errors: Vec<String>,
}

impl PassReport {
    pub fn changed_local(&self) -> bool {
        self.pulled > 0 || self.imported > 0
    }
}

/// Patch turning `from` into `to`, or None if they already match.
fn patch_between(from: &SyncState, to: &SyncState) -> Option<TaskPatch> {
    let patch = TaskPatch {
        title: (from.title != to.title).then(|| to.title.clone()),
        due_date: (from.due != to.due).then(|| to.due.clone()),
        done: (from.done != to.done).then_some(to.done),
        ..Default::default()
    };
    (patch.title.is_some() || patch.due_date.is_some() || patch.done.is_some()).then_some(patch)
}

/// One full two-way sync pass.
pub fn run_pass(
    store: &Store,
    backend: &mut impl RemindersBackend,
    opts: &PassOptions<'_>,
) -> Result<PassReport, StoreError> {
    let mut report = PassReport::default();
    let mut linked_tasks = HashSet::new();
    let mut linked_reminders = HashSet::new();

    // 1. Reconcile every linked pair.
    for link in store.reminder_links()? {
        if link.detached {
            linked_tasks.insert(link.task_id);
            continue;
        }
        let task = match store.get(link.task_id) {
            Ok(t) => t,
            Err(StoreError::NotFound(_)) => {
                store.remove_reminder_link(link.task_id)?;
                continue;
            }
            Err(e) => return Err(e),
        };
        let mut remote = match backend.get(&link.reminder_id) {
            Ok(Some(r)) => r,
            Ok(None) => {
                // Deleted in Reminders: keep the task, and remember not to
                // add it back.
                store.save_reminder_link(&ReminderLink {
                    detached: true,
                    ..link.clone()
                })?;
                linked_tasks.insert(link.task_id);
                report.unlinked += 1;
                continue;
            }
            Err(e) => {
                report.errors.push(e);
                linked_tasks.insert(link.task_id);
                linked_reminders.insert(link.reminder_id.clone());
                continue;
            }
        };
        // A reminder with an empty title can't become a task title.
        if remote.title.trim().is_empty() {
            remote.title = link.base.title.clone();
        }
        linked_tasks.insert(link.task_id);
        linked_reminders.insert(link.reminder_id.clone());

        let local = SyncState::of_task(&task);
        let m = merge(&link.base, &local, &remote);
        if m.push_remote {
            if let Err(e) = backend.update(&link.reminder_id, &m.result) {
                report.errors.push(e);
                continue;
            }
            report.pushed += 1;
        }
        if m.update_local {
            if let Some(patch) = patch_between(&local, &m.result) {
                store.update(task.id, patch)?;
                report.pulled += 1;
            }
        }
        if m.result != link.base {
            store.save_reminder_link(&ReminderLink {
                task_id: link.task_id,
                reminder_id: link.reminder_id,
                base: m.result,
                detached: false,
            })?;
        }
    }

    // 2. New items on either side.
    let since = opts.sync_since.unwrap_or("");
    let local_new: Vec<Task> = store
        .list(None)?
        .into_iter()
        .filter(|t| !t.done && !linked_tasks.contains(&t.id) && t.created_at.as_str() >= since)
        .collect();
    let remote_new: Vec<(String, SyncState)> = match backend.incomplete_in_list(opts.list_id) {
        Ok(items) => items
            .into_iter()
            .filter(|(id, s)| !linked_reminders.contains(id) && !s.title.trim().is_empty())
            .collect(),
        Err(e) => {
            report.errors.push(e);
            Vec::new()
        }
    };

    // 3. Link obvious duplicates instead of copying them both ways.
    let local_states: Vec<SyncState> = local_new.iter().map(SyncState::of_task).collect();
    let remote_states: Vec<SyncState> = remote_new.iter().map(|(_, s)| s.clone()).collect();
    let pairs = pair_duplicates(&local_states, &remote_states);
    let paired_local: HashSet<usize> = pairs.iter().map(|p| p.0).collect();
    let paired_remote: HashSet<usize> = pairs.iter().map(|p| p.1).collect();
    for (li, ri) in pairs {
        store.save_reminder_link(&ReminderLink {
            task_id: local_new[li].id,
            reminder_id: remote_new[ri].0.clone(),
            base: local_states[li].clone(),
            detached: false,
        })?;
    }

    // 4. Plucky → Reminders.
    for (i, task) in local_new.iter().enumerate() {
        if paired_local.contains(&i) {
            continue;
        }
        let state = &local_states[i];
        let notes = if opts.include_notes {
            task.source_text.as_deref()
        } else {
            None
        };
        match backend.create(opts.list_id, state, notes) {
            Ok(id) => {
                store.save_reminder_link(&ReminderLink {
                    task_id: task.id,
                    reminder_id: id,
                    base: state.clone(),
                    detached: false,
                })?;
                report.created += 1;
            }
            Err(e) => report.errors.push(e),
        }
    }

    // 5. Reminders → Plucky.
    for (i, (id, state)) in remote_new.iter().enumerate() {
        if paired_remote.contains(&i) {
            continue;
        }
        let task = store.insert(NewTask {
            title: state.title.clone(),
            due_date: state.due.clone(),
            ..Default::default()
        })?;
        store.save_reminder_link(&ReminderLink {
            task_id: task.id,
            reminder_id: id.clone(),
            base: SyncState::of_task(&task),
            detached: false,
        })?;
        report.imported += 1;
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(title: &str, due: Option<&str>, done: bool) -> SyncState {
        SyncState {
            title: title.into(),
            due: due.map(Into::into),
            done,
        }
    }

    #[test]
    fn no_changes_means_nothing_to_do() {
        let b = s("Call Sam", Some("2026-10-16"), false);
        let m = merge(&b, &b, &b);
        assert_eq!(m.result, b);
        assert!(!m.push_remote && !m.update_local);
    }

    #[test]
    fn local_change_is_pushed() {
        let b = s("Call Sam", Some("2026-10-16"), false);
        let local = s("Call Sam", Some("2026-10-16"), true);
        let m = merge(&b, &local, &b);
        assert_eq!(m.result, local);
        assert!(m.push_remote && !m.update_local);
    }

    #[test]
    fn remote_change_is_pulled() {
        let b = s("Call Sam", Some("2026-10-16"), false);
        let remote = s("Call Sam re: hiring", Some("2026-10-18"), false);
        let m = merge(&b, &b, &remote);
        assert_eq!(m.result, remote);
        assert!(!m.push_remote && m.update_local);
    }

    #[test]
    fn different_fields_merge() {
        let b = s("Call Sam", Some("2026-10-16"), false);
        let local = s("Call Sam about hiring", Some("2026-10-16"), false);
        let remote = s("Call Sam", Some("2026-10-16"), true);
        let m = merge(&b, &local, &remote);
        assert_eq!(
            m.result,
            s("Call Sam about hiring", Some("2026-10-16"), true)
        );
        assert!(m.push_remote && m.update_local);
    }

    #[test]
    fn same_field_conflict_prefers_reminder() {
        let b = s("Call Sam", Some("2026-10-16"), false);
        let local = s("Call Sam", Some("2026-10-17"), false);
        let remote = s("Call Sam", Some("2026-10-20"), false);
        assert_eq!(
            merge(&b, &local, &remote).result.due.as_deref(),
            Some("2026-10-20")
        );
    }

    #[test]
    fn clearing_a_due_date_syncs() {
        let b = s("x", Some("2026-10-16"), false);
        let remote = s("x", None, false);
        let m = merge(&b, &b, &remote);
        assert_eq!(m.result.due, None);
        assert!(m.update_local);
    }

    #[test]
    fn pairs_obvious_duplicates_once() {
        let local = [
            s("Book  flights", Some("2026-10-20"), false),
            s("Pay rent", None, false),
            s("Book flights", Some("2026-10-20"), false),
        ];
        let remote = [
            s("book flights", Some("2026-10-20"), false),
            s("Pay rent", Some("2026-11-01"), false),
        ];
        // Only the first "Book flights" pairs; "Pay rent" differs by date.
        assert_eq!(pair_duplicates(&local, &remote), vec![(0, 0)]);
    }

    // ── Full passes against a fake Reminders app ────────────────────────────

    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeReminders {
        items: HashMap<String, (String, SyncState, Option<String>)>, // id -> (list, state, notes)
        next: usize,
        fail_get: bool,
    }

    impl FakeReminders {
        fn add(&mut self, list: &str, st: SyncState) -> String {
            self.next += 1;
            let id = format!("R{}", self.next);
            self.items.insert(id.clone(), (list.into(), st, None));
            id
        }
    }

    impl RemindersBackend for FakeReminders {
        fn get(&mut self, id: &str) -> Result<Option<SyncState>, String> {
            if self.fail_get {
                return Err("offline".into());
            }
            Ok(self.items.get(id).map(|(_, s, _)| s.clone()))
        }
        fn update(&mut self, id: &str, state: &SyncState) -> Result<(), String> {
            let item = self.items.get_mut(id).ok_or("missing")?;
            item.1 = state.clone();
            Ok(())
        }
        fn create(
            &mut self,
            list_id: &str,
            state: &SyncState,
            notes: Option<&str>,
        ) -> Result<String, String> {
            let id = self.add(list_id, state.clone());
            self.items.get_mut(&id).unwrap().2 = notes.map(Into::into);
            Ok(id)
        }
        fn incomplete_in_list(
            &mut self,
            list_id: &str,
        ) -> Result<Vec<(String, SyncState)>, String> {
            let mut v: Vec<_> = self
                .items
                .iter()
                .filter(|(_, (l, s, _))| l == list_id && !s.done)
                .map(|(id, (_, s, _))| (id.clone(), s.clone()))
                .collect();
            v.sort_by(|a, b| a.0.cmp(&b.0));
            Ok(v)
        }
    }

    const LIST: &str = "pluck-list";

    fn opts() -> PassOptions<'static> {
        PassOptions {
            list_id: LIST,
            include_notes: false,
            sync_since: None,
        }
    }

    fn new_task(store: &Store, title: &str, due: Option<&str>) -> Task {
        store
            .insert(NewTask {
                title: title.into(),
                due_date: due.map(Into::into),
                source_text: Some("original selection".into()),
                ..Default::default()
            })
            .unwrap()
    }

    #[test]
    fn pushes_new_tasks_and_imports_new_reminders() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        new_task(&store, "Book flights", Some("2026-10-20"));
        rem.add(LIST, s("Buy milk", None, false));
        rem.add("other-list", s("Not ours", None, false));

        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!((r.created, r.imported), (1, 1));
        let titles: Vec<String> = store
            .list(None)
            .unwrap()
            .into_iter()
            .map(|t| t.title)
            .collect();
        assert!(titles.contains(&"Buy milk".to_string()));
        assert!(!titles.contains(&"Not ours".to_string()));
        assert_eq!(store.reminder_links().unwrap().len(), 2);

        // A second pass is a no-op.
        assert_eq!(
            run_pass(&store, &mut rem, &opts()).unwrap(),
            PassReport::default()
        );
    }

    #[test]
    fn completion_syncs_both_ways() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        let a = new_task(&store, "A", None);
        let b = new_task(&store, "B", None);
        run_pass(&store, &mut rem, &opts()).unwrap();
        let rid = |task_id| store.reminder_link(task_id).unwrap().unwrap().reminder_id;

        // Done in Plucky → completed in Reminders.
        store
            .update(
                a.id,
                TaskPatch {
                    done: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        // Completed in Reminders → done in Plucky.
        rem.items.get_mut(&rid(b.id)).unwrap().1.done = true;

        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!((r.pushed, r.pulled), (1, 1));
        assert!(rem.items[&rid(a.id)].1.done);
        assert!(store.get(b.id).unwrap().done);
    }

    #[test]
    fn edits_in_reminders_reach_pluck() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        let t = new_task(&store, "Call Sam", Some("2026-10-16"));
        run_pass(&store, &mut rem, &opts()).unwrap();
        let id = store.reminder_link(t.id).unwrap().unwrap().reminder_id;
        rem.items.get_mut(&id).unwrap().1 = s("Call Sam about hiring", Some("2026-10-18"), false);
        run_pass(&store, &mut rem, &opts()).unwrap();
        let t = store.get(t.id).unwrap();
        assert_eq!(t.title, "Call Sam about hiring");
        assert_eq!(t.due_date.as_deref(), Some("2026-10-18"));
    }

    #[test]
    fn deleting_a_reminder_keeps_the_task() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        let t = new_task(&store, "Keep me", None);
        run_pass(&store, &mut rem, &opts()).unwrap();
        rem.items.clear();
        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!(r.unlinked, 1);
        assert_eq!(r.created, 0, "a deleted reminder must not be re-created");
        assert_eq!(store.get(t.id).unwrap().title, "Keep me");
        assert!(store.reminder_links().unwrap().iter().all(|l| l.detached));
        // …and it stays deleted on later passes.
        assert_eq!(
            run_pass(&store, &mut rem, &opts()).unwrap(),
            PassReport::default()
        );
        assert!(rem.items.is_empty());
    }

    #[test]
    fn backend_errors_do_not_unlink_or_duplicate() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        new_task(&store, "A", None);
        run_pass(&store, &mut rem, &opts()).unwrap();
        rem.fail_get = true;
        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!(r.errors.len(), 1);
        assert_eq!(
            r.created, 0,
            "a temporarily unreadable link must not be recreated"
        );
        assert_eq!(store.reminder_links().unwrap().len(), 1);
        assert_eq!(rem.items.len(), 1);
    }

    #[test]
    fn re_enabling_links_duplicates_instead_of_copying() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        new_task(&store, "Pay rent", Some("2026-11-01"));
        rem.add(LIST, s("pay  rent", Some("2026-11-01"), false));
        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!((r.created, r.imported), (0, 0));
        assert_eq!(rem.items.len(), 1);
        assert_eq!(store.list(None).unwrap().len(), 1);
        assert_eq!(store.reminder_links().unwrap().len(), 1);
    }

    #[test]
    fn respects_sync_since_and_notes_setting() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        new_task(&store, "Old task", None);
        let since = "2999-01-01T00:00:00Z";
        let o = PassOptions {
            list_id: LIST,
            include_notes: true,
            sync_since: Some(since),
        };
        assert_eq!(run_pass(&store, &mut rem, &o).unwrap().created, 0);

        let o = PassOptions {
            list_id: LIST,
            include_notes: true,
            sync_since: None,
        };
        run_pass(&store, &mut rem, &o).unwrap();
        let (_, _, notes) = rem.items.values().next().unwrap();
        assert_eq!(notes.as_deref(), Some("original selection"));
    }
}
