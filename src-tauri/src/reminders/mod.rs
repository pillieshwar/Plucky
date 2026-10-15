//! Optional two-way sync with Apple Reminders (macOS).
//!
//! Off by default. When on, a single worker thread owns the EventKit store
//! and runs a sync pass (see `pluck_core::reminders_sync::run_pass`):
//! * soon after any change in Plucky,
//! * every 30 seconds, to pick up changes made in Reminders (e.g. on iPhone),
//! * when asked from Settings.
//!
//! Privacy: Plucky itself never uploads anything, but if the chosen list
//! belongs to iCloud (or another account), macOS syncs it — so the UI warns
//! before turning this on and while it's on.

// Most of the worker is macOS-only; on other platforms it just answers.
#![cfg_attr(not(target_os = "macos"), allow(dead_code, unused_imports))]

#[cfg(target_os = "macos")]
mod eventkit;

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const POLL: Duration = Duration::from_secs(30);
/// Wait for a burst of local edits to finish before syncing.
const DEBOUNCE: Duration = Duration::from_millis(400);
pub const DEFAULT_LIST: &str = "Plucky";
/// The app was called Pluck up to 0.4.1.
const OLD_LIST: &str = "Pluck";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    NotDetermined,
    Denied,
    Restricted,
    Full,
    WriteOnly,
    /// Not macOS.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListInfo {
    pub id: String,
    pub title: String,
    /// "iCloud", "On My Mac", an Exchange account name…
    pub source: String,
    /// Stored with an account that syncs off this Mac.
    pub leaves_mac: bool,
    pub icloud: bool,
    pub writable: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Settings {
    enabled: bool,
    list_id: Option<String>,
    #[serde(default)]
    include_notes: bool,
    /// Tasks created before this aren't pushed (unless the user chose to).
    sync_since: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
struct Runtime {
    last_sync: Option<String>,
    last_error: Option<String>,
    list: Option<ListInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub supported: bool,
    pub access: Access,
    pub enabled: bool,
    pub include_notes: bool,
    pub list: Option<ListInfo>,
    pub linked: usize,
    pub last_sync: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EnableRequest {
    /// An existing list, or None to create a "Plucky" list.
    pub list_id: Option<String>,
    pub include_notes: bool,
    /// Also add tasks that already exist in Plucky.
    pub push_existing: bool,
}

type Reply<T> = Sender<Result<T, String>>;

enum Cmd {
    Sync,
    Deleted(String),
    RequestAccess(Reply<Access>),
    Lists(Reply<Vec<ListInfo>>),
    Enable(EnableRequest, Reply<()>),
    Disable(Reply<()>),
}

pub struct Reminders {
    path: PathBuf,
    tx: Mutex<Sender<Cmd>>,
    settings: Arc<Mutex<Settings>>,
    runtime: Arc<Mutex<Runtime>>,
}

fn load(path: &Path) -> Settings {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save(path: &Path, s: &Settings) {
    match serde_json::to_vec_pretty(s) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(path, bytes) {
                log::warn!("could not save reminders settings: {e}");
            }
        }
        Err(e) => log::warn!("could not encode reminders settings: {e}"),
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

impl Reminders {
    pub fn start(app: &AppHandle, data_dir: &Path) -> Self {
        let path = data_dir.join("reminders.json");
        let settings = Arc::new(Mutex::new(load(&path)));
        let runtime = Arc::new(Mutex::new(Runtime::default()));
        let (tx, rx) = mpsc::channel();
        let worker = Worker {
            app: app.clone(),
            path: path.clone(),
            settings: settings.clone(),
            runtime: runtime.clone(),
        };
        let spawned = std::thread::Builder::new()
            .name("reminders-sync".into())
            .spawn(move || worker.run(rx));
        if let Err(e) = spawned {
            log::error!("could not start reminders sync: {e}");
        }
        Self {
            path,
            tx: Mutex::new(tx),
            settings,
            runtime,
        }
    }

    fn send(&self, cmd: Cmd) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(cmd);
        }
    }

    fn ask<T>(&self, make: impl FnOnce(Reply<T>) -> Cmd, timeout: Duration) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        self.send(make(tx));
        rx.recv_timeout(timeout)
            .map_err(|_| "Reminders didn't respond. Please try again.".to_string())?
    }

    pub fn enabled(&self) -> bool {
        self.settings.lock().map(|s| s.enabled).unwrap_or(false)
    }

    /// Something changed in Plucky; sync soon.
    pub fn nudge(&self) {
        if self.enabled() {
            self.send(Cmd::Sync);
        }
    }

    /// A linked task was deleted in Plucky; delete its reminder too.
    pub fn deleted(&self, reminder_id: String) {
        if self.enabled() {
            self.send(Cmd::Deleted(reminder_id));
        }
    }

    pub fn status(&self, linked: usize) -> Status {
        let s = self.settings.lock().map(|s| s.clone()).unwrap_or_default();
        let r = self.runtime.lock().map(|r| r.clone()).unwrap_or_default();
        Status {
            supported: cfg!(target_os = "macos"),
            access: current_access(),
            enabled: s.enabled,
            include_notes: s.include_notes,
            list: r.list,
            linked,
            last_sync: r.last_sync,
            last_error: r.last_error,
        }
    }

    pub fn request_access(&self) -> Result<Access, String> {
        self.ask(Cmd::RequestAccess, Duration::from_secs(310))
    }

    pub fn lists(&self) -> Result<Vec<ListInfo>, String> {
        self.ask(Cmd::Lists, Duration::from_secs(20))
    }

    pub fn enable(&self, req: EnableRequest) -> Result<(), String> {
        self.ask(|tx| Cmd::Enable(req, tx), Duration::from_secs(60))
    }

    pub fn disable(&self) -> Result<(), String> {
        self.ask(Cmd::Disable, Duration::from_secs(20))
    }

    /// Applies to reminders created from now on.
    pub fn set_include_notes(&self, include: bool) {
        if let Ok(mut s) = self.settings.lock() {
            s.include_notes = include;
            save(&self.path, &s);
        }
    }
}

fn current_access() -> Access {
    #[cfg(target_os = "macos")]
    {
        eventkit::access()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Access::Unsupported
    }
}

struct Worker {
    app: AppHandle,
    path: PathBuf,
    settings: Arc<Mutex<Settings>>,
    runtime: Arc<Mutex<Runtime>>,
}

impl Worker {
    fn settings(&self) -> Settings {
        self.settings.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn update_settings(&self, f: impl FnOnce(&mut Settings)) {
        if let Ok(mut s) = self.settings.lock() {
            f(&mut s);
            save(&self.path, &s);
        }
    }

    fn set_runtime(&self, f: impl FnOnce(&mut Runtime)) {
        if let Ok(mut r) = self.runtime.lock() {
            f(&mut r);
        }
        let _ = self.app.emit("reminders-changed", ());
    }

    #[cfg(not(target_os = "macos"))]
    fn run(self, rx: Receiver<Cmd>) {
        // Reminders sync is macOS-only; answer requests so callers never hang.
        while let Ok(cmd) = rx.recv() {
            const UNSUPPORTED: &str = "Apple Reminders is only available on macOS.";
            match cmd {
                Cmd::RequestAccess(tx) => {
                    let _ = tx.send(Ok(Access::Unsupported));
                }
                Cmd::Lists(tx) => {
                    let _ = tx.send(Err(UNSUPPORTED.to_string()));
                }
                Cmd::Enable(_, tx) | Cmd::Disable(tx) => {
                    let _ = tx.send(Err(UNSUPPORTED.to_string()));
                }
                Cmd::Sync | Cmd::Deleted(_) => {}
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn run(self, rx: Receiver<Cmd>) {
        let mut ek = eventkit::EventKit::open();
        if self.settings().enabled && eventkit::access() == Access::Full {
            self.sync(&mut ek);
        }
        loop {
            let cmd = match rx.recv_timeout(POLL) {
                Ok(cmd) => Some(cmd),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            };
            let mut want_sync = cmd.is_none();
            if let Some(cmd) = cmd {
                want_sync |= self.handle(&ek, cmd);
                // Coalesce a burst of commands into one pass.
                std::thread::sleep(DEBOUNCE);
                while let Ok(more) = rx.try_recv() {
                    want_sync |= self.handle(&ek, more);
                }
            }
            if want_sync && self.settings().enabled {
                self.sync(&mut ek);
            }
        }
    }

    /// Handle one command; returns whether a sync pass should follow.
    #[cfg(target_os = "macos")]
    fn handle(&self, ek: &eventkit::EventKit, cmd: Cmd) -> bool {
        match cmd {
            Cmd::Sync => true,
            Cmd::Deleted(id) => {
                if let Err(e) = ek.delete(&id) {
                    log::warn!("could not delete reminder: {e}");
                }
                false
            }
            Cmd::RequestAccess(tx) => {
                let result = match eventkit::access() {
                    Access::NotDetermined => ek.request_access(),
                    other => Ok(other),
                };
                let _ = tx.send(result);
                false
            }
            Cmd::Lists(tx) => {
                let result = if eventkit::access() == Access::Full {
                    ek.refresh();
                    Ok(ek.lists())
                } else {
                    Err("Plucky doesn't have access to Reminders.".into())
                };
                let _ = tx.send(result);
                false
            }
            Cmd::Enable(req, tx) => {
                let result = self.enable(ek, req);
                let ok = result.is_ok();
                let _ = tx.send(result);
                ok
            }
            Cmd::Disable(tx) => {
                // Links are kept, so turning sync back on resumes cleanly.
                self.update_settings(|s| s.enabled = false);
                self.set_runtime(|r| r.last_error = None);
                let _ = tx.send(Ok(()));
                false
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn enable(&self, ek: &eventkit::EventKit, req: EnableRequest) -> Result<(), String> {
        if eventkit::access() != Access::Full {
            return Err("Allow Plucky to use Reminders first.".into());
        }
        ek.refresh();
        let list = match req.list_id {
            Some(id) => ek
                .list(&id)
                .ok_or("That Reminders list no longer exists.")?,
            None => match ek
                .lists()
                .into_iter()
                .find(|l| l.title == DEFAULT_LIST && l.writable)
                .or_else(|| {
                    // The list versions before the rename made.
                    ek.lists()
                        .into_iter()
                        .find(|l| l.title == OLD_LIST && l.writable)
                }) {
                Some(existing) => existing,
                None => ek.create_list(DEFAULT_LIST)?,
            },
        };
        if !list.writable {
            return Err(format!("The “{}” list is read-only.", list.title));
        }
        let since = if req.push_existing { None } else { Some(now()) };
        self.update_settings(|s| {
            s.enabled = true;
            s.list_id = Some(list.id.clone());
            s.include_notes = req.include_notes;
            s.sync_since = since;
        });
        self.set_runtime(|r| {
            r.list = Some(list);
            r.last_error = None;
        });
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn sync(&self, ek: &mut eventkit::EventKit) {
        use pluck_core::reminders_sync::{run_pass, PassOptions};

        let settings = self.settings();
        let Some(list_id) = settings.list_id.clone() else {
            return;
        };
        if eventkit::access() != Access::Full {
            self.set_runtime(|r| {
                r.last_error = Some("Plucky no longer has access to Reminders. Allow it in System Settings → Privacy & Security → Reminders.".into());
            });
            return;
        }
        ek.refresh();
        let list = ek.list(&list_id);
        if list.is_none() {
            self.set_runtime(|r| {
                r.list = None;
                r.last_error = Some("The Reminders list Plucky syncs with was deleted. Choose another list in Settings.".into());
            });
            return;
        }

        let Some(state) = self.app.try_state::<crate::AppState>() else {
            return;
        };
        let report = {
            let Ok(store) = state.store.lock() else {
                return;
            };
            run_pass(
                &store,
                ek,
                &PassOptions {
                    list_id: &list_id,
                    include_notes: settings.include_notes,
                    sync_since: settings.sync_since.as_deref(),
                },
            )
        };
        match report {
            Ok(report) => {
                if report.changed_local() {
                    let _ = self.app.emit("tasks-changed", ());
                    crate::tray::refresh(&self.app);
                }
                if report != Default::default() {
                    log::info!("reminders sync: {report:?}");
                }
                self.set_runtime(|r| {
                    r.list = list;
                    r.last_sync = Some(now());
                    r.last_error = report.errors.first().cloned();
                });
            }
            Err(e) => {
                log::error!("reminders sync failed: {e}");
                self.set_runtime(|r| r.last_error = Some(e.to_string()));
            }
        }
    }
}
