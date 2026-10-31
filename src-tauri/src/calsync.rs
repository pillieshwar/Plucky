//! Two-way sync of timed tasks with Apple Calendar (and, later, Outlook).
//!
//! The rules live in `todocity_core::calendar_sync`; this is the Mac side: a
//! worker thread that owns an `EKEventStore`, runs a pass when tasks change
//! (and every minute, to see edits made in Calendar), and the commands the
//! Connectors page uses. TodoCity's calendars live in the account the user
//! picks (On My Mac, or iCloud to see them on iPhone), never in the default
//! calendar, one per project grouped by mode: "TodoCity · Work · Launch".
//!
//! Choices are kept in `calendar-sync.json` in the data folder.

#![cfg_attr(not(target_os = "macos"), allow(dead_code, unused_imports))]

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Listener, Manager};
use todocity_core::calendar_sync::{self, Choice, Lane, PassOptions};

use crate::reminders::Access;
use crate::settings::Settings;

const FILE: &str = "calendar-sync.json";
const PROVIDER: &str = "apple";
/// Look for edits made in Calendar this often.
const POLL: Duration = Duration::from_secs(60);
/// Let a burst of edits settle into one pass.
const DEBOUNCE: Duration = Duration::from_millis(800);

/// Every TodoCity calendar's title starts with this, so the meetings view
/// can leave them out (the tasks are already there).
pub const TITLE_PREFIX: &str = "TodoCity · ";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AppleChoice {
    pub enabled: bool,
    /// The account TodoCity's calendars live in (`EKSource` identifier).
    pub source: Option<String>,
    pub choice: Choice,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct SavedSettings {
    apple: AppleChoice,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Runtime {
    pub last_sync: Option<String>,
    pub last_error: Option<String>,
    pub synced: usize,
}

/// An account that can hold TodoCity's calendars.
#[derive(Debug, Clone, Serialize)]
pub struct SourceInfo {
    pub id: String,
    pub title: String,
    /// Stays on this Mac (On My Mac), or syncs through the account (iCloud…).
    pub local: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LaneInfo {
    pub key: String,
    pub group: String,
    pub name: String,
    pub on: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub supported: bool,
    pub access: Access,
    pub enabled: bool,
    pub source: Option<String>,
    pub sources: Vec<SourceInfo>,
    pub lanes: Vec<LaneInfo>,
    pub last_sync: Option<String>,
    pub last_error: Option<String>,
    pub synced: usize,
}

enum Cmd {
    Sync,
    Sources(Sender<Vec<SourceInfo>>),
    /// Remove TodoCity's calendars (turning sync off).
    RemoveCalendars(Vec<String>, Sender<()>),
}

pub struct CalendarSync {
    path: PathBuf,
    saved: Arc<Mutex<SavedSettings>>,
    runtime: Arc<Mutex<Runtime>>,
    tx: Mutex<Sender<Cmd>>,
}

fn load(path: &Path) -> SavedSettings {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save(path: &Path, s: &SavedSettings) {
    if let Ok(json) = serde_json::to_vec_pretty(s) {
        let _ = std::fs::write(path, json);
    }
}

/// The lanes right now: every project (not kept on this Mac only), grouped
/// by the modes, plus Inbox.
fn current_lanes(app: &AppHandle) -> Vec<Lane> {
    let projects: Vec<String> = app
        .state::<crate::AppState>()
        .store
        .lock()
        .ok()
        .and_then(|s| s.projects().ok())
        .map(|ps| ps.into_iter().map(|p| p.name).collect())
        .unwrap_or_default();
    let modes = app.state::<Settings>().get().modes;
    let local_only: HashSet<String> = crate::sync::local_only_projects(app);
    calendar_sync::lanes(&projects, &modes, &local_only)
}

impl CalendarSync {
    pub fn start(app: &AppHandle, data_dir: &Path) -> Self {
        let path = data_dir.join(FILE);
        let saved = Arc::new(Mutex::new(load(&path)));
        let runtime = Arc::new(Mutex::new(Runtime::default()));
        let (tx, rx) = mpsc::channel::<Cmd>();
        let worker = Worker {
            app: app.clone(),
            path: path.clone(),
            saved: saved.clone(),
            runtime: runtime.clone(),
        };
        let spawned = std::thread::Builder::new()
            .name("todocity-calendar-sync".into())
            .spawn(move || worker.run(rx));
        if let Err(e) = spawned {
            log::warn!("could not start calendar sync: {e}");
        }
        // Any change to tasks: sync soon.
        let nudge = tx.clone();
        app.listen_any("tasks-changed", move |_| {
            let _ = nudge.send(Cmd::Sync);
        });
        Self {
            path,
            saved,
            runtime,
            tx: Mutex::new(tx),
        }
    }

    fn send(&self, cmd: Cmd) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(cmd);
        }
    }

    fn saved(&self) -> SavedSettings {
        self.saved.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn update(&self, f: impl FnOnce(&mut SavedSettings)) {
        if let Ok(mut s) = self.saved.lock() {
            f(&mut s);
            save(&self.path, &s);
        }
    }

    fn sources(&self) -> Vec<SourceInfo> {
        let (tx, rx) = mpsc::channel();
        self.send(Cmd::Sources(tx));
        rx.recv_timeout(Duration::from_secs(15)).unwrap_or_default()
    }

    pub fn status(&self, app: &AppHandle) -> Status {
        let s = self.saved().apple;
        let r = self.runtime.lock().map(|r| r.clone()).unwrap_or_default();
        let off: HashSet<&str> = s.choice.off.iter().map(String::as_str).collect();
        let access = crate::calendar::access();
        Status {
            supported: cfg!(target_os = "macos"),
            enabled: s.enabled,
            source: s.source.clone(),
            sources: if access == Access::Full {
                self.sources()
            } else {
                Vec::new()
            },
            access,
            lanes: current_lanes(app)
                .into_iter()
                .map(|l| LaneInfo {
                    on: !off.contains(l.key.as_str()),
                    key: l.key,
                    group: l.group,
                    name: l.name,
                })
                .collect(),
            last_sync: r.last_sync,
            last_error: r.last_error,
            synced: r.synced,
        }
    }

    /// Something changed in TodoCity; sync soon.
    pub fn nudge(&self) {
        self.send(Cmd::Sync);
    }
}

struct Worker {
    app: AppHandle,
    path: PathBuf,
    saved: Arc<Mutex<SavedSettings>>,
    runtime: Arc<Mutex<Runtime>>,
}

impl Worker {
    fn saved(&self) -> SavedSettings {
        self.saved.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn set_runtime(&self, f: impl FnOnce(&mut Runtime)) {
        if let Ok(mut r) = self.runtime.lock() {
            f(&mut r);
        }
        let _ = self.app.emit("calendar-sync-changed", ());
    }

    #[cfg(not(target_os = "macos"))]
    fn run(self, rx: Receiver<Cmd>) {
        while let Ok(cmd) = rx.recv() {
            match cmd {
                Cmd::Sources(tx) => {
                    let _ = tx.send(Vec::new());
                }
                Cmd::RemoveCalendars(_, tx) => {
                    let _ = tx.send(());
                }
                Cmd::Sync => {}
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn run(self, rx: Receiver<Cmd>) {
        let mut ek = apple::Apple::open(None);
        loop {
            let cmd = match rx.recv_timeout(POLL) {
                Ok(cmd) => Some(cmd),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            };
            let mut want = cmd.is_none();
            if let Some(cmd) = cmd {
                want |= self.handle(&mut ek, cmd);
                std::thread::sleep(DEBOUNCE);
                while let Ok(more) = rx.try_recv() {
                    want |= self.handle(&mut ek, more);
                }
            }
            if want {
                self.sync(&mut ek);
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn handle(&self, ek: &mut apple::Apple, cmd: Cmd) -> bool {
        match cmd {
            Cmd::Sync => true,
            Cmd::Sources(tx) => {
                ek.refresh();
                let _ = tx.send(ek.sources());
                false
            }
            Cmd::RemoveCalendars(ids, tx) => {
                for id in ids {
                    if let Err(e) = ek.remove(&id) {
                        log::warn!("could not remove a TodoCity calendar: {e}");
                    }
                }
                let _ = tx.send(());
                false
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn sync(&self, ek: &mut apple::Apple) {
        let s = self.saved().apple;
        if !s.enabled || crate::calendar::access() != Access::Full {
            return;
        }
        ek.refresh();
        ek.set_source(s.source.as_deref());
        let lanes = current_lanes(&self.app);
        let now = chrono::Local::now().naive_local();
        let result = {
            let state = self.app.state::<crate::AppState>();
            let Ok(store) = state.store.lock() else {
                return;
            };
            calendar_sync::run_pass(
                &store,
                ek,
                &PassOptions {
                    provider: PROVIDER,
                    lanes: &lanes,
                    choice: &s.choice,
                    now,
                },
            )
            .map(|r| {
                let synced = store
                    .calendar_lanes(PROVIDER)
                    .map(|l| l.len())
                    .unwrap_or_default();
                (r, synced)
            })
        };
        match result {
            Ok((report, synced)) => {
                // A calendar the user removed in Calendar: that lane is off now.
                if !report.lanes_off.is_empty() {
                    if let Ok(mut saved) = self.saved.lock() {
                        for key in &report.lanes_off {
                            if !saved.apple.choice.off.contains(key) {
                                saved.apple.choice.off.push(key.clone());
                            }
                        }
                        save(&self.path, &saved);
                    }
                }
                let changed_here = report.pulled + report.imported + report.deleted_tasks > 0;
                if report.created
                    + report.pushed
                    + report.pulled
                    + report.imported
                    + report.removed
                    + report.deleted_tasks
                    > 0
                {
                    log::info!(
                        "calendar sync: {} made, {} sent, {} taken in, {} new tasks, {} removed, {} tasks deleted",
                        report.created, report.pushed, report.pulled, report.imported, report.removed, report.deleted_tasks
                    );
                }
                self.set_runtime(|r| {
                    r.last_sync =
                        Some(chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string());
                    r.last_error = report.errors.first().cloned();
                    r.synced = synced;
                });
                if changed_here {
                    let _ = self.app.emit("tasks-changed", ());
                    crate::tray::refresh(&self.app);
                }
            }
            Err(e) => self.set_runtime(|r| r.last_error = Some(e.to_string())),
        }
    }
}

// ── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn calsync_status(app: AppHandle) -> Status {
    app.state::<CalendarSync>().status(&app)
}

/// Turn Apple Calendar sync on, keeping TodoCity's calendars in `source`.
#[tauri::command]
pub async fn calsync_apple_enable(app: AppHandle, source: String) -> Result<Status, String> {
    if crate::calendar::access() != Access::Full {
        let granted = tauri::async_runtime::spawn_blocking(crate::calendar::request_access)
            .await
            .map_err(|e| e.to_string())??;
        if granted != Access::Full {
            return Err("Allow TodoCity full access to Calendars in System Settings → Privacy & Security → Calendars, then try again.".into());
        }
    }
    let cs = app.state::<CalendarSync>();
    cs.update(|s| {
        s.apple.enabled = true;
        s.apple.source = Some(source);
    });
    cs.nudge();
    Ok(cs.status(&app))
}

/// Turn it off. `remove`: also remove TodoCity's calendars (and their
/// events) from Calendar. Tasks stay as they are either way.
#[tauri::command]
pub async fn calsync_apple_disable(app: AppHandle, remove: bool) -> Result<Status, String> {
    let cs = app.state::<CalendarSync>();
    cs.update(|s| s.apple.enabled = false);
    let ids = {
        let state = app.state::<crate::AppState>();
        let store = state.store.lock().map_err(|e| e.to_string())?;
        store.calendar_forget(PROVIDER).map_err(|e| e.to_string())?
    };
    if remove && !ids.is_empty() {
        let (tx, rx) = mpsc::channel();
        cs.send(Cmd::RemoveCalendars(ids, tx));
        let _ =
            tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(30)))
                .await;
    }
    Ok(cs.status(&app))
}

/// Sync a project (or Inbox) or not.
#[tauri::command]
pub fn calsync_set_lane(app: AppHandle, key: String, on: bool) -> Status {
    let cs = app.state::<CalendarSync>();
    cs.update(|s| {
        s.apple.choice.off.retain(|k| *k != key);
        if !on {
            s.apple.choice.off.push(key);
        }
    });
    cs.nudge();
    cs.status(&app)
}

/// Sync a whole group (Work, Personal…) or not.
#[tauri::command]
pub fn calsync_set_group(app: AppHandle, group: String, on: bool) -> Status {
    let keys: Vec<String> = current_lanes(&app)
        .into_iter()
        .filter(|l| l.group == group)
        .map(|l| l.key)
        .collect();
    let cs = app.state::<CalendarSync>();
    cs.update(|s| {
        s.apple.choice.off.retain(|k| !keys.contains(k));
        if !on {
            s.apple.choice.off.extend(keys);
        }
    });
    cs.nudge();
    cs.status(&app)
}

#[tauri::command]
pub fn calsync_sync_now(app: AppHandle) -> Status {
    let cs = app.state::<CalendarSync>();
    cs.nudge();
    cs.status(&app)
}

// ── EventKit ───────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod apple {
    use chrono::{Local, NaiveDate, NaiveDateTime, TimeZone};
    use objc2::rc::Retained;
    use objc2_event_kit::{
        EKCalendar, EKEntityType, EKEvent, EKEventStore, EKSource, EKSourceType, EKSpan,
    };
    use objc2_foundation::{NSArray, NSDate, NSError, NSString, NSURL};
    use todocity_core::calendar_sync::{CalendarBackend, EventState, Lane, RemoteEvent};

    use super::{SourceInfo, TITLE_PREFIX};

    const TAG_PREFIX: &str = "todocity://task/";

    pub struct Apple {
        store: Retained<EKEventStore>,
        source: Option<String>,
    }

    fn ns(s: &str) -> Retained<NSString> {
        NSString::from_str(s)
    }

    fn error_text(e: &NSError) -> String {
        e.localizedDescription().to_string()
    }

    fn date(t: NaiveDateTime) -> Retained<NSDate> {
        let secs = Local
            .from_local_datetime(&t)
            .earliest()
            .map(|d| d.timestamp())
            .unwrap_or_default();
        NSDate::dateWithTimeIntervalSince1970(secs as f64)
    }

    fn naive(d: &NSDate) -> NaiveDateTime {
        Local
            .timestamp_opt(d.timeIntervalSince1970().floor() as i64, 0)
            .single()
            .map(|t| t.naive_local())
            .unwrap_or_default()
    }

    fn midnight(day: NaiveDate) -> Retained<NSDate> {
        date(day.and_hms_opt(0, 0, 0).unwrap_or_default())
    }

    fn remote(e: &EKEvent) -> Option<RemoteEvent> {
        unsafe {
            let id = e.eventIdentifier()?.to_string();
            let calendar_id = e.calendar()?.calendarIdentifier().to_string();
            let tag = e
                .URL()
                .and_then(|u| u.absoluteString())
                .map(|s| s.to_string())
                .and_then(|s| s.strip_prefix(TAG_PREFIX).map(String::from));
            Some(RemoteEvent {
                id,
                calendar_id,
                state: EventState {
                    title: e.title().to_string(),
                    start: naive(&e.startDate()),
                    end: naive(&e.endDate()),
                },
                all_day: e.isAllDay(),
                tag,
            })
        }
    }

    fn usable(kind: EKSourceType) -> bool {
        kind == EKSourceType::Local
            || kind == EKSourceType::CalDAV
            || kind == EKSourceType::Exchange
    }

    impl Apple {
        pub fn open(source: Option<String>) -> Self {
            Self {
                store: unsafe { EKEventStore::new() },
                source,
            }
        }

        pub fn set_source(&mut self, source: Option<&str>) {
            self.source = source.map(String::from);
        }

        /// See changes made in Calendar.
        pub fn refresh(&mut self) {
            unsafe {
                self.store.refreshSourcesIfNecessary();
                self.store.reset();
            }
        }

        pub fn sources(&self) -> Vec<SourceInfo> {
            let mut out: Vec<SourceInfo> = unsafe { self.store.sources() }
                .to_vec()
                .iter()
                .filter(|s| usable(unsafe { s.sourceType() }))
                .map(|s| unsafe {
                    let kind = s.sourceType();
                    let title = s.title().to_string();
                    SourceInfo {
                        id: s.sourceIdentifier().to_string(),
                        title: if title.is_empty() || kind == EKSourceType::Local {
                            "On My Mac".into()
                        } else {
                            title
                        },
                        local: kind == EKSourceType::Local,
                    }
                })
                .collect();
            out.sort_by(|a, b| b.local.cmp(&a.local).then(a.title.cmp(&b.title)));
            out
        }

        fn source(&self) -> Option<Retained<EKSource>> {
            let want = self.source.as_deref()?;
            unsafe { self.store.sources() }
                .to_vec()
                .into_iter()
                .find(|s| unsafe { s.sourceIdentifier() }.to_string() == want)
        }

        fn calendar(&self, id: &str) -> Option<Retained<EKCalendar>> {
            unsafe { self.store.calendarWithIdentifier(&ns(id)) }
        }

        fn event(&self, id: &str) -> Option<Retained<EKEvent>> {
            unsafe { self.store.eventWithIdentifier(&ns(id)) }
        }

        pub fn remove(&mut self, id: &str) -> Result<(), String> {
            let Some(cal) = self.calendar(id) else {
                return Ok(());
            };
            // Only ever a calendar TodoCity made.
            if !unsafe { cal.title() }.to_string().starts_with(TITLE_PREFIX) {
                return Ok(());
            }
            unsafe { self.store.removeCalendar_commit_error(&cal, true) }
                .map_err(|e| error_text(&e))
        }

        fn save(&self, e: &EKEvent) -> Result<(), String> {
            unsafe {
                self.store
                    .saveEvent_span_commit_error(e, EKSpan::ThisEvent, true)
            }
            .map_err(|e| error_text(&e))
        }
    }

    impl CalendarBackend for Apple {
        fn ensure_calendar(&mut self, lane: &Lane, known: Option<&str>) -> Result<String, String> {
            let title = lane.flat_title();
            unsafe {
                if let Some(cal) = known.and_then(|id| self.calendar(id)) {
                    if cal.title().to_string() != title {
                        cal.setTitle(&ns(&title));
                        self.store
                            .saveCalendar_commit_error(&cal, true)
                            .map_err(|e| error_text(&e))?;
                    }
                    return Ok(cal.calendarIdentifier().to_string());
                }
                let source = self
                    .source()
                    .ok_or("Pick where TodoCity's calendars go in Settings → Calendar & Reminders → Apple Calendar.")?;
                let source_id = source.sourceIdentifier().to_string();
                // One already there (made by TodoCity on another Mac): use it.
                let existing = self
                    .store
                    .calendarsForEntityType(EKEntityType::Event)
                    .to_vec()
                    .into_iter()
                    .find(|c| {
                        c.title().to_string() == title
                            && c.source().map(|s| s.sourceIdentifier().to_string())
                                == Some(source_id.clone())
                    });
                if let Some(cal) = existing {
                    return Ok(cal.calendarIdentifier().to_string());
                }
                let cal =
                    EKCalendar::calendarForEntityType_eventStore(EKEntityType::Event, &self.store);
                cal.setTitle(&ns(&title));
                cal.setSource(Some(&source));
                self.store.saveCalendar_commit_error(&cal, true).map_err(|e| {
                    format!("TodoCity couldn't add calendars to {}: {}. Pick another account in Settings → Calendar & Reminders → Apple Calendar.", source.title(), error_text(&e))
                })?;
                Ok(cal.calendarIdentifier().to_string())
            }
        }

        fn calendar_exists(&mut self, id: &str) -> Result<bool, String> {
            Ok(self.calendar(id).is_some())
        }

        fn remove_calendar(&mut self, id: &str) -> Result<(), String> {
            self.remove(id)
        }

        fn get(&mut self, event_id: &str) -> Result<Option<RemoteEvent>, String> {
            Ok(self.event(event_id).and_then(|e| remote(&e)))
        }

        fn events_in(
            &mut self,
            calendar_id: &str,
            from: NaiveDate,
            to: NaiveDate,
        ) -> Result<Vec<RemoteEvent>, String> {
            let Some(cal) = self.calendar(calendar_id) else {
                return Ok(Vec::new());
            };
            let cals = NSArray::from_retained_slice(&[cal]);
            let found = unsafe {
                let p = self
                    .store
                    .predicateForEventsWithStartDate_endDate_calendars(
                        &midnight(from),
                        &midnight(to),
                        Some(&cals),
                    );
                self.store.eventsMatchingPredicate(&p)
            };
            Ok(found.to_vec().iter().filter_map(|e| remote(e)).collect())
        }

        fn create(
            &mut self,
            calendar_id: &str,
            state: &EventState,
            tag: &str,
        ) -> Result<String, String> {
            let cal = self
                .calendar(calendar_id)
                .ok_or("A TodoCity calendar is missing; it will be made again.")?;
            unsafe {
                let e = EKEvent::eventWithEventStore(&self.store);
                e.setCalendar(Some(&cal));
                e.setTitle(Some(&ns(&state.title)));
                e.setStartDate(Some(&date(state.start)));
                e.setEndDate(Some(&date(state.end)));
                if let Some(url) = NSURL::URLWithString(&ns(&format!("{TAG_PREFIX}{tag}"))) {
                    e.setURL(Some(&url));
                }
                self.save(&e)?;
                e.eventIdentifier()
                    .map(|s| s.to_string())
                    .ok_or_else(|| "Calendar didn't keep the event.".into())
            }
        }

        fn update(
            &mut self,
            event_id: &str,
            calendar_id: &str,
            state: &EventState,
        ) -> Result<(), String> {
            let e = self.event(event_id).ok_or("The event was deleted.")?;
            unsafe {
                if e.calendar()
                    .map(|c| c.calendarIdentifier().to_string())
                    .as_deref()
                    != Some(calendar_id)
                {
                    if let Some(cal) = self.calendar(calendar_id) {
                        e.setCalendar(Some(&cal));
                    }
                }
                e.setTitle(Some(&ns(&state.title)));
                e.setStartDate(Some(&date(state.start)));
                e.setEndDate(Some(&date(state.end)));
            }
            self.save(&e)
        }

        fn delete(&mut self, event_id: &str) -> Result<(), String> {
            let Some(e) = self.event(event_id) else {
                return Ok(());
            };
            unsafe {
                self.store
                    .removeEvent_span_commit_error(&e, EKSpan::ThisEvent, true)
            }
            .map_err(|e| error_text(&e))
        }

        fn tag(&mut self, event_id: &str, tag: &str) -> Result<(), String> {
            let e = self.event(event_id).ok_or("The event was deleted.")?;
            unsafe {
                if let Some(url) = NSURL::URLWithString(&ns(&format!("{TAG_PREFIX}{tag}"))) {
                    e.setURL(Some(&url));
                }
            }
            self.save(&e)
        }
    }
}
