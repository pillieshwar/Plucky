//! Two-way sync between TodoCity's timed tasks and a calendar app (Apple
//! Calendar through EventKit, Outlook through Microsoft Graph).
//!
//! **Where tasks go.** Never the user's default calendar: TodoCity makes one
//! calendar per project (a *lane*), grouped by mode, "Work" or "Personal"
//! (the first mode that shows the project), plus one for tasks in no project
//! ("Inbox"). The user picks which lanes to sync; new projects get a lane by
//! themselves. A task is in exactly one lane, so it never shows twice.
//!
//! **What syncs.** Open tasks with a day and a time, as events from their
//! start for their length (30 minutes if none). Each pass is a three-way
//! merge per field against the link's *base* (title, start, end): the side
//! that changed a field wins, and the calendar wins when both did.
//!
//! **Deletes.** A task deleted in TodoCity (any way) queues its event in
//! `calendar_trash`, and the pass deletes it. An event deleted in the
//! calendar deletes its task (the user's choice), behind a safety brake: a
//! pass never deletes more than a handful of tasks at once if that's more
//! than half of them. A whole calendar removed in the calendar app turns
//! that lane off instead of deleting its tasks.
//!
//! **Two Macs.** Each event carries its task's uid (`tag`). Two Macs that
//! sync tasks and write to the same (iCloud) calendars find each other's
//! events by that tag and link to them instead of making a second one, and
//! never import a tagged event as a new task.

use std::collections::{HashMap, HashSet};

use chrono::{Duration, NaiveDate, NaiveDateTime, Timelike};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::modes::ViewMode;
use crate::store::{NewTask, Store, StoreError, Task, TaskPatch};

/// A task with no set length shows for this long.
pub const DEFAULT_MINUTES: u32 = 30;
/// The lane for tasks in no project.
pub const INBOX_LANE: &str = "inbox";
/// Brought in from the calendar: events from this many days back…
const IMPORT_BACK_DAYS: i64 = 7;
/// …to this many days ahead.
const IMPORT_AHEAD_DAYS: i64 = 365;
/// The safety brake: more deletions than this in one pass, if they're also
/// more than half the linked tasks, and none happen.
const BRAKE_COUNT: usize = 5;

/// One calendar TodoCity keeps in the calendar app: a project (or Inbox).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lane {
    /// `p:<project>` or `inbox`.
    pub key: String,
    /// The mode it's grouped under: "Work", "Personal"…, or "Other".
    pub group: String,
    /// The project's name, or "Inbox".
    pub name: String,
    /// The project it holds (`None` for Inbox).
    pub project: Option<String>,
}

impl Lane {
    /// How Apple Calendar shows it: "TodoCity · Work · Offsite".
    pub fn flat_title(&self) -> String {
        format!("TodoCity · {} · {}", self.group, self.name)
    }
}

pub fn lane_key(project: Option<&str>) -> String {
    match project {
        Some(p) => format!("p:{p}"),
        None => INBOX_LANE.to_string(),
    }
}

/// Every lane: one per project (not kept on this Mac only), grouped under
/// the first mode that shows it, then Inbox.
pub fn lanes(projects: &[String], modes: &[ViewMode], local_only: &HashSet<String>) -> Vec<Lane> {
    let group_of = |project: Option<&str>| -> String {
        modes
            .iter()
            .find(|m| m.shows_project(project))
            .map_or_else(|| "Other".to_string(), |m| m.name.clone())
    };
    let mut out: Vec<Lane> = projects
        .iter()
        .filter(|p| !local_only.contains(*p))
        .map(|p| Lane {
            key: lane_key(Some(p)),
            group: group_of(Some(p)),
            name: p.clone(),
            project: Some(p.clone()),
        })
        .collect();
    out.push(Lane {
        key: INBOX_LANE.into(),
        group: group_of(None),
        name: "Inbox".into(),
        project: None,
    });
    // Grouped as the modes are ordered, then A–Z.
    let order = |g: &str| modes.iter().position(|m| m.name == g).unwrap_or(usize::MAX);
    out.sort_by(|a, b| {
        order(&a.group)
            .cmp(&order(&b.group))
            .then((a.key == INBOX_LANE).cmp(&(b.key == INBOX_LANE)))
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

/// What an event says, as far as sync cares.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventState {
    pub title: String,
    /// Local time.
    pub start: NaiveDateTime,
    pub end: NaiveDateTime,
}

impl EventState {
    pub fn of_task(t: &Task) -> Option<Self> {
        let date = NaiveDate::parse_from_str(t.due_date.as_deref()?, "%Y-%m-%d").ok()?;
        let time = chrono::NaiveTime::parse_from_str(t.due_time.as_deref()?, "%H:%M").ok()?;
        let start = date.and_time(time);
        let minutes = t.duration.unwrap_or(DEFAULT_MINUTES).max(1);
        Some(Self {
            title: t.title.clone(),
            start,
            end: start + Duration::minutes(i64::from(minutes)),
        })
    }
}

/// An event as the calendar app has it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteEvent {
    pub id: String,
    pub calendar_id: String,
    pub state: EventState,
    pub all_day: bool,
    /// The uid of the TodoCity task it was made for, if any.
    pub tag: Option<String>,
}

/// The calendar app, as the pass needs it. Implementations must not panic;
/// failures come back as `Err(message)`.
pub trait CalendarBackend {
    /// The calendar for a lane: `known` if it still exists (renamed or
    /// regrouped to match), otherwise an existing one with the same name, or
    /// a new one. Returns its id.
    fn ensure_calendar(&mut self, lane: &Lane, known: Option<&str>) -> Result<String, String>;
    /// Whether a calendar still exists.
    fn calendar_exists(&mut self, id: &str) -> Result<bool, String>;
    /// Remove a calendar TodoCity made (and its events).
    fn remove_calendar(&mut self, id: &str) -> Result<(), String>;
    /// One event; `Ok(None)` if it was deleted.
    fn get(&mut self, event_id: &str) -> Result<Option<RemoteEvent>, String>;
    /// Every event in a calendar between two days.
    fn events_in(
        &mut self,
        calendar_id: &str,
        from: NaiveDate,
        to: NaiveDate,
    ) -> Result<Vec<RemoteEvent>, String>;
    /// Make an event, tagged with its task's uid. Returns its id.
    fn create(
        &mut self,
        calendar_id: &str,
        state: &EventState,
        tag: &str,
    ) -> Result<String, String>;
    /// Change an event, moving it to `calendar_id` if it's elsewhere.
    fn update(
        &mut self,
        event_id: &str,
        calendar_id: &str,
        state: &EventState,
    ) -> Result<(), String>;
    /// Delete an event. One that's already gone is `Ok`.
    fn delete(&mut self, event_id: &str) -> Result<(), String>;
    /// Mark an event (added by the user) as belonging to a task.
    fn tag(&mut self, event_id: &str, tag: &str) -> Result<(), String>;
}

/// What the user chose.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Choice {
    /// Lanes the user turned off (by key). Everything else syncs, including
    /// projects made later.
    pub off: Vec<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct PassReport {
    /// Events made for tasks.
    pub created: usize,
    /// Events changed to match their tasks.
    pub pushed: usize,
    /// Tasks changed to match their events.
    pub pulled: usize,
    /// Tasks made from events added in a TodoCity calendar.
    pub imported: usize,
    /// Events removed (task done, deleted, untimed, or lane off).
    pub removed: usize,
    /// Tasks deleted because their event was deleted.
    pub deleted_tasks: usize,
    /// Lanes turned off because their calendar was removed in the app.
    pub lanes_off: Vec<String>,
    /// Deletions held back by the safety brake.
    pub held_back: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone)]
struct Link {
    task_id: i64,
    event_id: String,
    lane: String,
    base: EventState,
}

fn fmt(t: NaiveDateTime) -> String {
    t.format("%Y-%m-%dT%H:%M").to_string()
}

fn parse(s: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M").ok()
}

// ── Storage ────────────────────────────────────────────────────────────────

impl Store {
    fn cal_links(&self, provider: &str) -> Result<Vec<Link>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT task_id, event_id, lane, base_title, base_start, base_end FROM calendar_links WHERE provider = ?1",
        )?;
        let rows = stmt.query_map([provider], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (task_id, event_id, lane, title, start, end) = row?;
            if let (Some(start), Some(end)) = (parse(&start), parse(&end)) {
                out.push(Link {
                    task_id,
                    event_id,
                    lane,
                    base: EventState { title, start, end },
                });
            }
        }
        Ok(out)
    }

    fn cal_link_save(&self, provider: &str, l: &Link) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO calendar_links (provider, task_id, event_id, lane, base_title, base_start, base_end)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (provider, task_id) DO UPDATE SET event_id = ?3, lane = ?4, base_title = ?5,
                 base_start = ?6, base_end = ?7",
            params![provider, l.task_id, l.event_id, l.lane, l.base.title, fmt(l.base.start), fmt(l.base.end)],
        )?;
        Ok(())
    }

    fn cal_link_drop(&self, provider: &str, task_id: i64) -> Result<(), StoreError> {
        self.conn.execute(
            "DELETE FROM calendar_links WHERE provider = ?1 AND task_id = ?2",
            params![provider, task_id],
        )?;
        Ok(())
    }

    /// Lane key → calendar id, for calendars TodoCity made in this app.
    pub fn calendar_lanes(&self, provider: &str) -> Result<HashMap<String, String>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT lane, calendar_id FROM calendar_lanes WHERE provider = ?1")?;
        let rows = stmt.query_map([provider], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn cal_lane_save(
        &self,
        provider: &str,
        lane: &Lane,
        calendar_id: &str,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO calendar_lanes (provider, lane, calendar_id, name) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (provider, lane) DO UPDATE SET calendar_id = ?3, name = ?4",
            params![provider, lane.key, calendar_id, lane.flat_title()],
        )?;
        Ok(())
    }

    fn cal_lane_drop(&self, provider: &str, lane: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "DELETE FROM calendar_lanes WHERE provider = ?1 AND lane = ?2",
            params![provider, lane],
        )?;
        Ok(())
    }

    fn cal_trash(&self, provider: &str) -> Result<Vec<String>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT event_id FROM calendar_trash WHERE provider = ?1 ORDER BY queued_at",
        )?;
        let rows = stmt.query_map([provider], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn cal_trash_clear(&self, provider: &str, event_id: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "DELETE FROM calendar_trash WHERE provider = ?1 AND event_id = ?2",
            params![provider, event_id],
        )?;
        Ok(())
    }

    /// A task's sync uid (the same on every Mac).
    pub fn uid_of(&self, id: i64) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .query_row("SELECT uid FROM tasks WHERE id = ?1", [id], |r| r.get(0))
            .optional()?
            .flatten())
    }

    /// The task with this sync uid, if it's here.
    pub fn id_by_uid(&self, uid: &str) -> Result<Option<i64>, StoreError> {
        Ok(self
            .conn
            .query_row("SELECT id FROM tasks WHERE uid = ?1", [uid], |r| r.get(0))
            .optional()?)
    }

    /// Forget everything synced with this calendar app (turning it off). The
    /// tasks stay as they are; `calendar_lanes` comes back so the app can
    /// remove the calendars.
    pub fn calendar_forget(&self, provider: &str) -> Result<Vec<String>, StoreError> {
        let ids: Vec<String> = self.calendar_lanes(provider)?.into_values().collect();
        self.conn
            .execute("DELETE FROM calendar_links WHERE provider = ?1", [provider])?;
        self.conn
            .execute("DELETE FROM calendar_lanes WHERE provider = ?1", [provider])?;
        self.conn
            .execute("DELETE FROM calendar_trash WHERE provider = ?1", [provider])?;
        Ok(ids)
    }
}

// ── The pass ───────────────────────────────────────────────────────────────

/// What a pass needs to know besides the store and the calendar.
pub struct PassOptions<'a> {
    /// "apple" or "outlook".
    pub provider: &'a str,
    pub lanes: &'a [Lane],
    pub choice: &'a Choice,
    /// The user's local time now.
    pub now: NaiveDateTime,
}

fn eligible(t: &Task) -> bool {
    !t.done && !t.paused && t.due_date.is_some() && t.due_time.is_some()
}

/// The patch that makes a task match an event (title, day, time, length).
fn patch_to(state: &EventState) -> TaskPatch {
    let minutes = (state.end - state.start).num_minutes().clamp(1, 1440) as u32;
    TaskPatch {
        title: Some(state.title.clone()),
        due_date: Some(Some(state.start.date().format("%Y-%m-%d").to_string())),
        due_time: Some(Some(format!(
            "{:02}:{:02}",
            state.start.hour(),
            state.start.minute()
        ))),
        duration: Some(Some(minutes)),
        // A repeating task moved in the calendar: just this one.
        only_this: Some(true),
        ..Default::default()
    }
}

fn merge(base: &EventState, local: &EventState, remote: &EventState) -> EventState {
    let pick = |b, l, r| if r != b { r } else { l };
    // Start and end move together when the event is dragged: keep the pair.
    let (start, end) = if (remote.start, remote.end) != (base.start, base.end) {
        (remote.start, remote.end)
    } else {
        (local.start, local.end)
    };
    EventState {
        title: pick(&base.title, &local.title, &remote.title).clone(),
        start,
        end,
    }
}

/// One full two-way pass.
pub fn run_pass(
    store: &Store,
    backend: &mut impl CalendarBackend,
    opts: &PassOptions<'_>,
) -> Result<PassReport, StoreError> {
    let p = opts.provider;
    let mut report = PassReport::default();
    let off: HashSet<&str> = opts.choice.off.iter().map(String::as_str).collect();
    let lane_on = |key: &str| !off.contains(key) && opts.lanes.iter().any(|l| l.key == key);

    // 0. Events of tasks deleted in TodoCity.
    for id in store.cal_trash(p)? {
        match backend.delete(&id) {
            Ok(()) => {
                store.cal_trash_clear(p, &id)?;
                report.removed += 1;
            }
            Err(e) => report.errors.push(e),
        }
    }

    // 1. Calendars: one per lane that's on. A calendar the user removed in
    //    the calendar app turns its lane off (its tasks stay). Calendars of
    //    lanes turned off or gone are removed.
    let mut known = store.calendar_lanes(p)?;
    let mut cal_of: HashMap<String, String> = HashMap::new();
    let mut removed_by_user: HashSet<String> = HashSet::new();
    for lane in opts.lanes.iter().filter(|l| lane_on(&l.key)) {
        if let Some(id) = known.get(&lane.key) {
            match backend.calendar_exists(id) {
                Ok(true) => {}
                Ok(false) => {
                    removed_by_user.insert(lane.key.clone());
                    continue;
                }
                Err(e) => {
                    report.errors.push(e);
                    continue;
                }
            }
        }
        match backend.ensure_calendar(lane, known.get(&lane.key).map(String::as_str)) {
            Ok(id) => {
                store.cal_lane_save(p, lane, &id)?;
                cal_of.insert(lane.key.clone(), id);
            }
            Err(e) => report.errors.push(e),
        }
    }
    for key in &removed_by_user {
        store.cal_lane_drop(p, key)?;
        known.remove(key);
        report.lanes_off.push(key.clone());
    }
    for (key, id) in known.iter() {
        if !cal_of.contains_key(key) && !removed_by_user.contains(key) && !lane_on(key) {
            match backend.remove_calendar(id) {
                Ok(()) => store.cal_lane_drop(p, key)?,
                Err(e) => report.errors.push(e),
            }
        }
    }
    let lane_of_cal: HashMap<&str, &str> = cal_of
        .iter()
        .map(|(k, v)| (v.as_str(), k.as_str()))
        .collect();
    let lane_by_key: HashMap<&str, &Lane> =
        opts.lanes.iter().map(|l| (l.key.as_str(), l)).collect();

    // 2. Linked pairs.
    let links = store.cal_links(p)?;
    let mut linked_tasks: HashSet<i64> = HashSet::new();
    let mut linked_events: HashSet<String> = HashSet::new();
    let mut to_delete: Vec<(Link, i64)> = Vec::new();
    for link in links {
        linked_tasks.insert(link.task_id);
        linked_events.insert(link.event_id.clone());
        let Ok(task) = store.get(link.task_id) else {
            store.cal_link_drop(p, link.task_id)?;
            continue;
        };
        let want_lane = lane_key(task.project.as_deref());
        // Its lane's calendar is gone (off, or removed by the user): forget
        // the pair; the calendar took the event with it.
        if !cal_of.contains_key(&link.lane) {
            if !removed_by_user.contains(&link.lane) {
                let _ = backend.delete(&link.event_id);
            }
            store.cal_link_drop(p, link.task_id)?;
            continue;
        }
        let remote = match backend.get(&link.event_id) {
            Ok(r) => r,
            Err(e) => {
                report.errors.push(e);
                continue;
            }
        };
        let Some(remote) = remote else {
            // Deleted in the calendar: the task goes too (after the brake).
            to_delete.push((link.clone(), task.id));
            continue;
        };
        // Moved to a calendar that isn't TodoCity's: it's theirs now.
        let Some(remote_lane) = lane_of_cal.get(remote.calendar_id.as_str()).copied() else {
            store.cal_link_drop(p, link.task_id)?;
            continue;
        };
        // No longer a timed task here (done, untimed, paused): the event goes.
        let Some(local) = EventState::of_task(&task).filter(|_| eligible(&task)) else {
            match backend.delete(&link.event_id) {
                Ok(()) => {
                    store.cal_link_drop(p, link.task_id)?;
                    report.removed += 1;
                }
                Err(e) => report.errors.push(e),
            }
            continue;
        };
        if remote.all_day {
            // Made all-day in the calendar: the task keeps its day, loses its time.
            store.update(
                task.id,
                TaskPatch {
                    due_time: Some(None),
                    due_date: Some(Some(
                        remote.state.start.date().format("%Y-%m-%d").to_string(),
                    )),
                    only_this: Some(true),
                    ..Default::default()
                },
            )?;
            let _ = backend.delete(&link.event_id);
            store.cal_link_drop(p, link.task_id)?;
            report.pulled += 1;
            continue;
        }
        let merged = merge(&link.base, &local, &remote.state);
        let mut lane = want_lane.clone();
        // Dragged to another TodoCity calendar: the task moves to that project.
        if remote_lane != link.lane && remote_lane != want_lane {
            if let Some(l) = lane_by_key.get(remote_lane) {
                store.update(
                    task.id,
                    TaskPatch {
                        project: Some(l.project.clone()),
                        heading: Some(None),
                        ..Default::default()
                    },
                )?;
                lane = remote_lane.to_string();
                report.pulled += 1;
            }
        }
        // The task moved to a lane that's off: its event goes.
        let Some(target_cal) = cal_of.get(&lane) else {
            match backend.delete(&link.event_id) {
                Ok(()) => {
                    store.cal_link_drop(p, link.task_id)?;
                    report.removed += 1;
                }
                Err(e) => report.errors.push(e),
            }
            continue;
        };
        if merged != local {
            store.update(task.id, patch_to(&merged))?;
            report.pulled += 1;
        }
        if merged != remote.state || remote.calendar_id != *target_cal {
            if let Err(e) = backend.update(&link.event_id, target_cal, &merged) {
                report.errors.push(e);
                continue;
            }
            report.pushed += 1;
        }
        store.cal_link_save(
            p,
            &Link {
                task_id: task.id,
                event_id: link.event_id.clone(),
                lane,
                base: merged,
            },
        )?;
    }

    // The safety brake for tasks whose events were deleted.
    let linked_count = linked_tasks.len();
    if to_delete.len() > BRAKE_COUNT && to_delete.len() * 2 > linked_count {
        report.held_back = to_delete.len();
        report.errors.push(format!(
            "{} events were deleted from TodoCity's calendars at once, so their tasks were kept. Delete the tasks in TodoCity if you meant to.",
            to_delete.len()
        ));
        for (link, _) in &to_delete {
            store.cal_link_drop(p, link.task_id)?;
        }
    } else {
        for (link, task_id) in &to_delete {
            store.cal_link_drop(p, link.task_id)?;
            // The trash trigger only queues linked events; this one is gone already.
            store.delete(*task_id)?;
            store.cal_trash_clear(p, &link.event_id)?;
            report.deleted_tasks += 1;
        }
    }

    // 3. Events in TodoCity's calendars: other Macs' (link by tag) and new
    //    ones the user added (import as tasks).
    let today = opts.now.date();
    let (from, to) = (
        today - Duration::days(IMPORT_BACK_DAYS),
        today + Duration::days(IMPORT_AHEAD_DAYS),
    );
    let mut tagged: HashMap<String, RemoteEvent> = HashMap::new();
    for (key, cal) in &cal_of {
        let events = match backend.events_in(cal, from, to) {
            Ok(e) => e,
            Err(e) => {
                report.errors.push(e);
                continue;
            }
        };
        for ev in events {
            if linked_events.contains(&ev.id) || ev.all_day {
                continue;
            }
            match &ev.tag {
                Some(uid) => {
                    tagged.insert(uid.clone(), ev);
                }
                None => {
                    let lane = lane_by_key.get(key.as_str());
                    let minutes =
                        (ev.state.end - ev.state.start).num_minutes().clamp(1, 1440) as u32;
                    let task = store.insert(NewTask {
                        title: if ev.state.title.trim().is_empty() {
                            "New task".into()
                        } else {
                            ev.state.title.clone()
                        },
                        due_date: Some(ev.state.start.date().format("%Y-%m-%d").to_string()),
                        due_time: Some(format!(
                            "{:02}:{:02}",
                            ev.state.start.hour(),
                            ev.state.start.minute()
                        )),
                        duration: Some(minutes),
                        project: lane.and_then(|l| l.project.clone()),
                        ..Default::default()
                    })?;
                    if let Some(uid) = store.uid_of(task.id)? {
                        // Tagged, so other Macs link to it instead of importing it again.
                        if let Err(e) = backend.tag(&ev.id, &uid) {
                            report.errors.push(e);
                        }
                    }
                    let base = EventState::of_task(&task).unwrap_or(ev.state.clone());
                    store.cal_link_save(
                        p,
                        &Link {
                            task_id: task.id,
                            event_id: ev.id.clone(),
                            lane: key.clone(),
                            base,
                        },
                    )?;
                    linked_tasks.insert(task.id);
                    report.imported += 1;
                }
            }
        }
    }

    // 4. Timed tasks with no event yet: link to another Mac's event for the
    //    same task, or make one.
    for task in store.list(None)?.into_iter().filter(eligible) {
        if linked_tasks.contains(&task.id) {
            continue;
        }
        let key = lane_key(task.project.as_deref());
        let Some(cal) = cal_of.get(&key) else {
            continue;
        };
        let Some(state) = EventState::of_task(&task) else {
            continue;
        };
        let Some(uid) = store.uid_of(task.id)? else {
            continue;
        };
        if let Some(ev) = tagged.remove(&uid) {
            let base = ev.state.clone();
            store.cal_link_save(
                p,
                &Link {
                    task_id: task.id,
                    event_id: ev.id.clone(),
                    lane: key.clone(),
                    base,
                },
            )?;
            // Bring them in step on the next pass, field by field.
            continue;
        }
        match backend.create(cal, &state, &uid) {
            Ok(id) => {
                store.cal_link_save(
                    p,
                    &Link {
                        task_id: task.id,
                        event_id: id,
                        lane: key,
                        base: state,
                    },
                )?;
                report.created += 1;
            }
            Err(e) => report.errors.push(e),
        }
    }
    // Tagged events whose task isn't here are left alone: it may not have
    // synced to this Mac yet, or it was deleted (its own Mac removes it).
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[derive(Default)]
    struct Fake {
        next: usize,
        calendars: BTreeMap<String, String>, // id → title
        events: BTreeMap<String, RemoteEvent>,
        fail_delete: bool,
    }

    impl Fake {
        fn cal_named(&self, title_end: &str) -> String {
            self.calendars
                .iter()
                .find(|(_, t)| t.ends_with(title_end))
                .map(|(id, _)| id.clone())
                .unwrap()
        }
        fn in_cal(&self, cal: &str) -> Vec<&RemoteEvent> {
            self.events
                .values()
                .filter(|e| e.calendar_id == cal)
                .collect()
        }
    }

    impl CalendarBackend for Fake {
        fn ensure_calendar(&mut self, lane: &Lane, known: Option<&str>) -> Result<String, String> {
            if let Some(id) = known.filter(|id| self.calendars.contains_key(*id)) {
                self.calendars.insert(id.to_string(), lane.flat_title());
                return Ok(id.to_string());
            }
            if let Some((id, _)) = self
                .calendars
                .iter()
                .find(|(_, t)| **t == lane.flat_title())
            {
                return Ok(id.clone());
            }
            self.next += 1;
            let id = format!("C{}", self.next);
            self.calendars.insert(id.clone(), lane.flat_title());
            Ok(id)
        }
        fn calendar_exists(&mut self, id: &str) -> Result<bool, String> {
            Ok(self.calendars.contains_key(id))
        }
        fn remove_calendar(&mut self, id: &str) -> Result<(), String> {
            self.calendars.remove(id);
            self.events.retain(|_, e| e.calendar_id != id);
            Ok(())
        }
        fn get(&mut self, event_id: &str) -> Result<Option<RemoteEvent>, String> {
            Ok(self.events.get(event_id).cloned())
        }
        fn events_in(
            &mut self,
            calendar_id: &str,
            _: NaiveDate,
            _: NaiveDate,
        ) -> Result<Vec<RemoteEvent>, String> {
            Ok(self
                .events
                .values()
                .filter(|e| e.calendar_id == calendar_id)
                .cloned()
                .collect())
        }
        fn create(
            &mut self,
            calendar_id: &str,
            state: &EventState,
            tag: &str,
        ) -> Result<String, String> {
            self.next += 1;
            let id = format!("E{}", self.next);
            self.events.insert(
                id.clone(),
                RemoteEvent {
                    id: id.clone(),
                    calendar_id: calendar_id.into(),
                    state: state.clone(),
                    all_day: false,
                    tag: Some(tag.into()),
                },
            );
            Ok(id)
        }
        fn update(
            &mut self,
            event_id: &str,
            calendar_id: &str,
            state: &EventState,
        ) -> Result<(), String> {
            let e = self.events.get_mut(event_id).ok_or("missing")?;
            e.calendar_id = calendar_id.into();
            e.state = state.clone();
            Ok(())
        }
        fn delete(&mut self, event_id: &str) -> Result<(), String> {
            if self.fail_delete {
                return Err("Calendar is busy".into());
            }
            self.events.remove(event_id);
            Ok(())
        }
        fn tag(&mut self, event_id: &str, tag: &str) -> Result<(), String> {
            self.events.get_mut(event_id).ok_or("missing")?.tag = Some(tag.into());
            Ok(())
        }
    }

    fn now() -> NaiveDateTime {
        NaiveDateTime::parse_from_str("2026-11-02T08:00", "%Y-%m-%dT%H:%M").unwrap()
    }

    fn at(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M").unwrap()
    }

    fn modes() -> Vec<ViewMode> {
        let mut work = ViewMode::work();
        work.projects = vec!["Launch".into()];
        work.new_projects = false;
        work.no_project = false;
        let mut personal = ViewMode::personal();
        personal.new_projects = true;
        personal.projects = vec!["Launch".into()];
        personal.no_project = true;
        vec![work, personal]
    }

    fn pass(store: &Store, cal: &mut Fake, choice: &Choice) -> PassReport {
        let projects: Vec<String> = store
            .projects()
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();
        let lanes = lanes(&projects, &modes(), &HashSet::new());
        run_pass(
            store,
            cal,
            &PassOptions {
                provider: "apple",
                lanes: &lanes,
                choice,
                now: now(),
            },
        )
        .unwrap()
    }

    fn timed(
        store: &Store,
        title: &str,
        project: Option<&str>,
        date: &str,
        time: &str,
        minutes: Option<u32>,
    ) -> Task {
        if let Some(p) = project {
            store.create_project(p).unwrap();
        }
        store
            .insert(NewTask {
                title: title.into(),
                due_date: Some(date.into()),
                due_time: Some(time.into()),
                duration: minutes,
                project: project.map(Into::into),
                ..Default::default()
            })
            .unwrap()
    }

    #[test]
    fn lanes_group_projects_by_mode_with_no_duplicates() {
        let projects = vec![
            "Launch".to_string(),
            "Home".to_string(),
            "Garden".to_string(),
            "Secret".to_string(),
        ];
        let local: HashSet<String> = ["Secret".to_string()].into();
        let l = lanes(&projects, &modes(), &local);
        let shown: Vec<String> = l.iter().map(|l| l.flat_title()).collect();
        assert_eq!(
            shown,
            vec![
                "TodoCity · Work · Launch",
                "TodoCity · Personal · Garden",
                "TodoCity · Personal · Home",
                "TodoCity · Personal · Inbox"
            ]
        );
    }

    #[test]
    fn timed_tasks_become_events_in_their_project_calendar() {
        let s = Store::open_in_memory().unwrap();
        let mut cal = Fake::default();
        timed(
            &s,
            "Stand-up",
            Some("Launch"),
            "2026-11-03",
            "09:07",
            Some(7),
        );
        timed(&s, "Dentist", None, "2026-11-04", "15:00", None);
        s.insert(NewTask {
            title: "No time".into(),
            due_date: Some("2026-11-03".into()),
            ..Default::default()
        })
        .unwrap();
        let r = pass(&s, &mut cal, &Choice::default());
        assert_eq!(r.created, 2);
        let launch = cal.cal_named("Work · Launch");
        let ev = cal.in_cal(&launch)[0].clone();
        assert_eq!(
            (ev.state.start, ev.state.end),
            (at("2026-11-03T09:07"), at("2026-11-03T09:14"))
        );
        let inbox = cal.cal_named("Personal · Inbox");
        assert_eq!(cal.in_cal(&inbox)[0].state.end, at("2026-11-04T15:30"));
        // A second pass changes nothing.
        assert_eq!(
            pass(&s, &mut cal, &Choice::default()),
            PassReport::default()
        );
    }

    #[test]
    fn edits_flow_both_ways() {
        let s = Store::open_in_memory().unwrap();
        let mut cal = Fake::default();
        let t = timed(
            &s,
            "Review",
            Some("Launch"),
            "2026-11-03",
            "13:00",
            Some(30),
        );
        pass(&s, &mut cal, &Choice::default());
        let ev = cal.events.values().next().unwrap().id.clone();
        // Dragged and stretched in the calendar.
        {
            let e = cal.events.get_mut(&ev).unwrap();
            e.state.start = at("2026-11-04T10:15");
            e.state.end = at("2026-11-04T11:00");
        }
        let r = pass(&s, &mut cal, &Choice::default());
        assert_eq!(r.pulled, 1);
        let t2 = s.get(t.id).unwrap();
        assert_eq!(
            (t2.due_date.as_deref(), t2.due_time.as_deref(), t2.duration),
            (Some("2026-11-04"), Some("10:15"), Some(45))
        );
        // Renamed in TodoCity: the event follows.
        s.update(
            t.id,
            TaskPatch {
                title: Some("Review the deck".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let r = pass(&s, &mut cal, &Choice::default());
        assert_eq!(r.pushed, 1);
        assert_eq!(cal.events[&ev].state.title, "Review the deck");
    }

    #[test]
    fn deletes_and_done_tasks() {
        let s = Store::open_in_memory().unwrap();
        let mut cal = Fake::default();
        let a = timed(&s, "A", None, "2026-11-03", "09:00", None);
        let b = timed(&s, "B", None, "2026-11-03", "10:00", None);
        let c = timed(&s, "C", None, "2026-11-03", "11:00", None);
        pass(&s, &mut cal, &Choice::default());
        assert_eq!(cal.events.len(), 3);
        // Deleted in TodoCity: the event goes.
        s.delete(a.id).unwrap();
        // Done in TodoCity: the event goes, the task stays.
        s.update(
            b.id,
            TaskPatch {
                done: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        let r = pass(&s, &mut cal, &Choice::default());
        assert_eq!(r.removed, 2);
        assert_eq!(cal.events.len(), 1);
        assert!(s.get(b.id).unwrap().done);
        // Deleted in the calendar: the task goes.
        cal.events.clear();
        let r = pass(&s, &mut cal, &Choice::default());
        assert_eq!(r.deleted_tasks, 1);
        assert!(s.get(c.id).is_err());
        assert_eq!(
            pass(&s, &mut cal, &Choice::default()),
            PassReport::default()
        );
    }

    #[test]
    fn the_brake_keeps_tasks_when_many_events_vanish() {
        let s = Store::open_in_memory().unwrap();
        let mut cal = Fake::default();
        for i in 0..8 {
            timed(
                &s,
                &format!("T{i}"),
                None,
                "2026-11-03",
                &format!("{:02}:00", 9 + i),
                None,
            );
        }
        pass(&s, &mut cal, &Choice::default());
        cal.events.clear();
        let r = pass(&s, &mut cal, &Choice::default());
        assert_eq!((r.held_back, r.deleted_tasks), (8, 0));
        assert_eq!(s.all().unwrap().len(), 8);
        // Next time they get new events (they're still timed tasks).
        assert_eq!(pass(&s, &mut cal, &Choice::default()).created, 8);
    }

    #[test]
    fn a_calendar_removed_in_the_app_turns_its_lane_off_and_keeps_tasks() {
        let s = Store::open_in_memory().unwrap();
        let mut cal = Fake::default();
        timed(&s, "Ship it", Some("Launch"), "2026-11-03", "09:00", None);
        pass(&s, &mut cal, &Choice::default());
        let id = cal.cal_named("Work · Launch");
        cal.remove_calendar(&id).unwrap();
        let r = pass(&s, &mut cal, &Choice::default());
        assert_eq!(r.lanes_off, vec!["p:Launch".to_string()]);
        assert_eq!(r.deleted_tasks, 0);
        assert_eq!(s.all().unwrap().len(), 1);
    }

    #[test]
    fn lanes_turned_off_lose_their_calendar_not_their_tasks() {
        let s = Store::open_in_memory().unwrap();
        let mut cal = Fake::default();
        timed(&s, "Ship it", Some("Launch"), "2026-11-03", "09:00", None);
        timed(&s, "Dentist", None, "2026-11-04", "15:00", None);
        pass(&s, &mut cal, &Choice::default());
        let off = Choice {
            off: vec!["p:Launch".into()],
        };
        pass(&s, &mut cal, &off);
        assert!(!cal.calendars.values().any(|t| t.ends_with("Launch")));
        assert_eq!(cal.events.len(), 1);
        assert_eq!(s.all().unwrap().len(), 2);
        // On again: back it comes.
        let r = pass(&s, &mut cal, &Choice::default());
        assert_eq!(r.created, 1);
    }

    #[test]
    fn moving_an_event_between_project_calendars_moves_the_task() {
        let s = Store::open_in_memory().unwrap();
        let mut cal = Fake::default();
        s.create_project("Home").unwrap();
        let t = timed(
            &s,
            "Fix the tap",
            Some("Launch"),
            "2026-11-03",
            "18:00",
            None,
        );
        pass(&s, &mut cal, &Choice::default());
        let home = cal.cal_named("Personal · Home");
        let ev = cal.events.keys().next().unwrap().clone();
        cal.events.get_mut(&ev).unwrap().calendar_id = home.clone();
        pass(&s, &mut cal, &Choice::default());
        assert_eq!(s.get(t.id).unwrap().project.as_deref(), Some("Home"));
        // And a project change in TodoCity moves the event.
        s.update(
            t.id,
            TaskPatch {
                project: Some(Some("Launch".into())),
                ..Default::default()
            },
        )
        .unwrap();
        pass(&s, &mut cal, &Choice::default());
        assert_eq!(cal.events[&ev].calendar_id, cal.cal_named("Work · Launch"));
    }

    #[test]
    fn events_added_in_a_todocity_calendar_become_tasks() {
        let s = Store::open_in_memory().unwrap();
        let mut cal = Fake::default();
        s.create_project("Home").unwrap();
        pass(&s, &mut cal, &Choice::default());
        let home = cal.cal_named("Personal · Home");
        cal.events.insert(
            "X1".into(),
            RemoteEvent {
                id: "X1".into(),
                calendar_id: home,
                state: EventState {
                    title: "Call the plumber".into(),
                    start: at("2026-11-05T08:30"),
                    end: at("2026-11-05T08:45"),
                },
                all_day: false,
                tag: None,
            },
        );
        let r = pass(&s, &mut cal, &Choice::default());
        assert_eq!(r.imported, 1);
        assert!(cal.events["X1"].tag.is_some(), "tagged for the other Macs");
        let t = s
            .all()
            .unwrap()
            .into_iter()
            .find(|t| t.title == "Call the plumber")
            .unwrap();
        assert_eq!(
            (t.project.as_deref(), t.due_time.as_deref(), t.duration),
            (Some("Home"), Some("08:30"), Some(15))
        );
        assert_eq!(pass(&s, &mut cal, &Choice::default()).imported, 0);
    }

    #[test]
    fn two_macs_sharing_calendars_make_one_event_per_task() {
        // Mac A and Mac B have the same task (same uid, via Mac sync) and
        // write to the same iCloud calendars.
        let a = Store::open_in_memory().unwrap();
        let b = Store::open_in_memory().unwrap();
        let ta = timed(&a, "Stand-up", None, "2026-11-03", "09:00", None);
        let uid = a.uid_of(ta.id).unwrap().unwrap();
        let tb = timed(&b, "Stand-up", None, "2026-11-03", "09:00", None);
        b.conn
            .execute(
                "UPDATE tasks SET uid = ?1 WHERE id = ?2",
                params![uid, tb.id],
            )
            .unwrap();
        let mut shared = Fake::default();
        pass(&a, &mut shared, &Choice::default());
        let r = pass(&b, &mut shared, &Choice::default());
        assert_eq!((r.created, r.imported), (0, 0));
        assert_eq!(shared.events.len(), 1);
        assert_eq!(shared.calendars.len(), 1, "both Macs use the same calendar");
        // A tagged event whose task this Mac doesn't have yet isn't imported.
        let c = Store::open_in_memory().unwrap();
        assert_eq!(pass(&c, &mut shared, &Choice::default()).imported, 0);
        assert!(c.all().unwrap().is_empty());
    }

    #[test]
    fn a_failed_delete_is_retried() {
        let s = Store::open_in_memory().unwrap();
        let mut cal = Fake::default();
        let t = timed(&s, "A", None, "2026-11-03", "09:00", None);
        pass(&s, &mut cal, &Choice::default());
        s.delete(t.id).unwrap();
        cal.fail_delete = true;
        assert_eq!(pass(&s, &mut cal, &Choice::default()).errors.len(), 1);
        cal.fail_delete = false;
        assert_eq!(pass(&s, &mut cal, &Choice::default()).removed, 1);
        assert!(cal.events.is_empty());
    }

    #[test]
    fn forgetting_keeps_tasks() {
        let s = Store::open_in_memory().unwrap();
        let mut cal = Fake::default();
        timed(&s, "A", Some("Launch"), "2026-11-03", "09:00", None);
        pass(&s, &mut cal, &Choice::default());
        let ids = s.calendar_forget("apple").unwrap();
        assert_eq!(ids.len(), 2);
        assert_eq!(s.all().unwrap().len(), 1);
    }
}
