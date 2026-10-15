//! Pluck desktop shell: tray icon, global shortcut, docked task panel.
//!
//! Lifecycle of one capture:
//!   shortcut released → pre-warm the bundled model runtime and capture the
//!   selection (worker thread, before the panel takes focus) → emit `capture`
//!   to the panel and show it → the panel calls `extract` (one localhost
//!   request) → user confirms the date → `add_task` (one SQLite write).
//!   The runtime stops itself after a few idle minutes.

mod capture;
mod data;
mod engine;
mod greet;
mod models;
mod notifications;
mod panel;
mod popover;
mod quick;
mod reminders;
#[cfg(target_os = "macos")]
mod services;
mod settings;
mod shortcuts;
mod spaces;
mod tray;
mod updates;

use std::sync::Mutex;
use std::time::Duration;

use pluck_core::{Extraction, NewTask, Store, Task, TaskPatch};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::ShortcutState;

use crate::capture::{CaptureMethod, CaptureResult};
use crate::engine::Engine;
use crate::models::{CustomModel, LocalModels, ModelManager, ModelView};
use crate::settings::{AppSettings, Settings};
use crate::shortcuts::{Action, ShortcutSettings, ShortcutSpec, Shortcuts};
use crate::updates::{UpdateStatus, Updates};

pub struct AppState {
    store: Mutex<Store>,
    data_dir: std::path::PathBuf,
}

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
async fn extract(
    engine: State<'_, Engine>,
    models: State<'_, ModelManager>,
    selection: String,
) -> CmdResult<Extraction> {
    let path = match models.active() {
        Some(m) => m.path,
        None if engine.kind() == "ollama" => Default::default(),
        None => return Err("No model downloaded yet. Open the Models tab to get one.".into()),
    };
    engine.extract(&path, &selection).await
}

#[tauri::command]
fn list_tasks(state: State<'_, AppState>, done_since: Option<String>) -> CmdResult<Vec<Task>> {
    state
        .store
        .lock()
        .map_err(err)?
        .list(done_since.as_deref())
        .map_err(err)
}

#[tauri::command]
fn add_task(app: AppHandle, state: State<'_, AppState>, task: NewTask) -> CmdResult<Task> {
    let task = NewTask {
        created_tz: iana_time_zone::get_timezone().ok(),
        ..task
    };
    let t = state.store.lock().map_err(err)?.insert(task).map_err(err)?;
    let _ = app.emit("tasks-changed", ());
    tray::refresh(&app);
    nudge_reminders(&app);
    Ok(t)
}

#[tauri::command]
fn update_task(app: AppHandle, id: i64, patch: TaskPatch) -> CmdResult<Task> {
    apply_patch(&app, id, patch)
}

/// Update a task and everything that depends on it: a repeating task's next
/// occurrence, its reminder, its notification, the menu bar and windows.
pub(crate) fn apply_patch(app: &AppHandle, id: i64, patch: TaskPatch) -> CmdResult<Task> {
    let state = app.state::<AppState>();
    let completing = patch.done == Some(true);
    let (task, removed_link) = {
        let store = state.store.lock().map_err(err)?;
        // If un-completing removes the next occurrence, its reminder goes too.
        let next_link = store
            .get(id)
            .ok()
            .and_then(|t| t.next_id)
            .and_then(|n| store.reminder_link(n).ok().flatten());
        let (task, effects) = store.update_with_effects(id, patch).map_err(err)?;
        (task, effects.removed.and(next_link))
    };
    if let (Some(link), Some(r)) = (removed_link, app.try_state::<reminders::Reminders>()) {
        r.deleted(link.reminder_id);
    }
    if completing {
        notifications::clear_task(id);
    }
    let _ = app.emit("tasks-changed", ());
    tray::refresh(app);
    nudge_reminders(app);
    Ok(task)
}

/// Open a link from a task's description in the default browser or app.
#[tauri::command]
fn open_url(url: String) -> CmdResult<()> {
    let lower = url.to_ascii_lowercase();
    let ok = (lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("mailto:"))
        && !url.chars().any(char::is_whitespace)
        && url.len() <= 2048;
    if !ok {
        return Err("Only web and email links can be opened.".into());
    }
    open_target(&OpenTarget::Url(url))
}

/// Open the page or app a task was captured from.
#[tauri::command]
fn open_source(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let task = state.store.lock().map_err(err)?.get(id).map_err(err)?;
    let target = source_target(&task).ok_or("This task doesn't remember where it came from.")?;
    open_target(&target)
}

#[derive(Debug, PartialEq, Eq)]
enum OpenTarget {
    Url(String),
    App(String),
}

/// Slack's web client links reopen in the Slack app.
fn slack_deep_link(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://app.slack.com/client/")?;
    let mut parts = rest.split(['/', '?', '#']);
    let team = parts.next().filter(|t| t.starts_with('T'))?;
    let channel = parts.next().filter(|c| c.starts_with(['C', 'D', 'G']))?;
    let ok = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric());
    (ok(team) && ok(channel)).then(|| format!("slack://channel?team={team}&id={channel}"))
}

fn source_target(task: &Task) -> Option<OpenTarget> {
    if let Some(url) = task.source_url.as_deref() {
        let lower = url.to_ascii_lowercase();
        if lower.starts_with("https://")
            || lower.starts_with("http://")
            || lower.starts_with("file://")
        {
            if task.source_bundle.as_deref() == Some("com.tinyspeck.slackmacgap") {
                if let Some(deep) = slack_deep_link(url) {
                    return Some(OpenTarget::Url(deep));
                }
            }
            return Some(OpenTarget::Url(url.to_string()));
        }
    }
    let bundle = task.source_bundle.as_deref()?;
    let ok = !bundle.is_empty()
        && bundle
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    ok.then(|| OpenTarget::App(bundle.to_string()))
}

fn open_target(target: &OpenTarget) -> CmdResult<()> {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        match target {
            OpenTarget::Url(u) => c.arg(u),
            OpenTarget::App(b) => c.arg("-b").arg(b),
        };
        c
    } else if cfg!(windows) {
        let OpenTarget::Url(u) = target else {
            return Err("Opening apps is only supported on macOS.".into());
        };
        let mut c = std::process::Command::new("explorer");
        c.arg(u);
        c
    } else {
        let OpenTarget::Url(u) = target else {
            return Err("Opening apps is only supported on macOS.".into());
        };
        let mut c = std::process::Command::new("xdg-open");
        c.arg(u);
        c
    };
    cmd.spawn().map(|_| ()).map_err(err)
}

#[tauri::command]
fn delete_task(app: AppHandle, state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let link = {
        let store = state.store.lock().map_err(err)?;
        let link = store.reminder_link(id).ok().flatten();
        store.delete(id).map_err(err)?;
        link
    };
    if let (Some(link), Some(r)) = (link, app.try_state::<reminders::Reminders>()) {
        r.deleted(link.reminder_id);
    }
    notifications::clear_task(id);
    let _ = app.emit("tasks-changed", ());
    tray::refresh(&app);
    Ok(())
}

/// Put back a task deleted moments ago (Undo). It comes back as a new task
/// with the same details.
#[tauri::command]
fn restore_task(app: AppHandle, state: State<'_, AppState>, task: Task) -> CmdResult<Task> {
    let restored = {
        let store = state.store.lock().map_err(err)?;
        let t = store
            .insert(NewTask {
                title: task.title.clone(),
                due_date: task.due_date.clone(),
                due_time: task.due_time.clone(),
                recurrence: task.recurrence.clone(),
                source_text: task.source_text.clone(),
                source_app: task.source_app.clone(),
                source_bundle: task.source_bundle.clone(),
                source_url: task.source_url.clone(),
                notes: task.notes.clone(),
                created_tz: task.created_tz.clone(),
            })
            .map_err(err)?;
        if task.done {
            store
                .update(
                    t.id,
                    TaskPatch {
                        done: Some(true),
                        ..Default::default()
                    },
                )
                .map_err(err)?
        } else {
            t
        }
    };
    let _ = app.emit("tasks-changed", ());
    tray::refresh(&app);
    nudge_reminders(&app);
    Ok(restored)
}

fn nudge_reminders(app: &AppHandle) {
    if let Some(r) = app.try_state::<reminders::Reminders>() {
        r.nudge();
    }
}

// ── Apple Reminders ─────────────────────────────────────────────────────────

fn linked_count(state: &State<'_, AppState>) -> usize {
    state
        .store
        .lock()
        .ok()
        .and_then(|s| s.reminder_links().ok())
        .map(|l| l.iter().filter(|l| !l.detached).count())
        .unwrap_or(0)
}

#[tauri::command]
fn reminders_status(
    state: State<'_, AppState>,
    r: State<'_, reminders::Reminders>,
) -> reminders::Status {
    r.status(linked_count(&state))
}

/// Blocking (waits for the user to answer the macOS prompt), so async.
#[tauri::command]
async fn reminders_request_access(
    r: State<'_, reminders::Reminders>,
) -> CmdResult<reminders::Access> {
    r.request_access()
}

#[tauri::command]
async fn reminders_lists(
    r: State<'_, reminders::Reminders>,
) -> CmdResult<Vec<reminders::ListInfo>> {
    r.lists()
}

#[tauri::command]
async fn reminders_enable(
    r: State<'_, reminders::Reminders>,
    request: reminders::EnableRequest,
) -> CmdResult<()> {
    r.enable(request)
}

#[tauri::command]
async fn reminders_disable(r: State<'_, reminders::Reminders>) -> CmdResult<()> {
    r.disable()
}

#[tauri::command]
fn reminders_sync_now(r: State<'_, reminders::Reminders>) {
    r.nudge();
}

/// System Settings → Privacy & Security → Reminders.
#[tauri::command]
fn reminders_open_privacy_settings() -> CmdResult<()> {
    if !cfg!(target_os = "macos") {
        return Err("Only available on macOS.".into());
    }
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders")
        .spawn()
        .map(|_| ())
        .map_err(err)
}

#[tauri::command]
fn reminders_set_include_notes(r: State<'_, reminders::Reminders>, include: bool) {
    r.set_include_notes(include);
}

#[derive(Serialize)]
struct Status {
    accessibility: bool,
    /// "bundled" (default) or "ollama" (developer override).
    engine: &'static str,
    /// Name of the model captures will use, if one is installed.
    active_model: Option<String>,
    version: &'static str,
    platform: &'static str,
}

#[tauri::command]
fn status(engine: State<'_, Engine>, models: State<'_, ModelManager>) -> Status {
    Status {
        accessibility: capture::accessibility_trusted(false),
        engine: engine.kind(),
        active_model: models.active().map(|m| m.name),
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
    }
}

// ── Preferences ─────────────────────────────────────────────────────────────

#[tauri::command]
fn get_settings(settings: State<'_, Settings>) -> AppSettings {
    settings.get()
}

/// Save the user-editable preferences; bookkeeping fields are kept.
#[tauri::command]
fn set_settings(settings: State<'_, Settings>, value: AppSettings) -> AppSettings {
    settings.update(|v| {
        v.notify = value.notify;
        v.auto_update = value.auto_update;
        v.remember_source = value.remember_source;
        v.onboarding_done = value.onboarding_done;
        v.seen_version = value.seen_version;
        v.show_on_start = value.show_on_start;
    })
}

#[tauri::command]
async fn notification_permission() -> notifications::Permission {
    tauri::async_runtime::spawn_blocking(notifications::permission)
        .await
        .unwrap_or(notifications::Permission::NotDetermined)
}

#[tauri::command]
async fn request_notification_permission() -> notifications::Permission {
    tauri::async_runtime::spawn_blocking(notifications::request_permission)
        .await
        .unwrap_or(notifications::Permission::NotDetermined)
}

#[tauri::command]
fn test_notification(app: AppHandle) {
    notifications::send_test(&app);
}

/// System Settings → Notifications.
#[tauri::command]
fn open_notification_settings() -> CmdResult<()> {
    if !cfg!(target_os = "macos") {
        return Err("Only available on macOS.".into());
    }
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.notifications")
        .spawn()
        .map(|_| ())
        .map_err(err)
}

#[tauri::command]
fn autostart_enabled(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> CmdResult<bool> {
    let al = app.autolaunch();
    if enabled {
        al.enable().map_err(err)?;
    } else {
        al.disable().map_err(err)?;
    }
    Ok(al.is_enabled().unwrap_or(enabled))
}

#[tauri::command]
fn update_status(updates: State<'_, Updates>) -> UpdateStatus {
    updates.status()
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> UpdateStatus {
    updates::check(app.clone()).await;
    app.state::<Updates>().status()
}

#[tauri::command]
fn install_update(app: AppHandle) -> CmdResult<()> {
    updates::install_and_restart(&app)
}

// ── Backups and export ──────────────────────────────────────────────────────

#[tauri::command]
fn list_backups(state: State<'_, AppState>) -> Vec<data::BackupInfo> {
    data::list(&state.data_dir)
}

#[tauri::command]
fn backup_now(state: State<'_, AppState>) -> CmdResult<Vec<data::BackupInfo>> {
    let store = state.store.lock().map_err(err)?;
    let path = data::backup_dir(&state.data_dir).join(format!(
        "tasks-{}-manual.db",
        chrono::Local::now().format("%Y-%m-%d-%H%M%S")
    ));
    std::fs::create_dir_all(data::backup_dir(&state.data_dir)).map_err(err)?;
    store.backup_to(&path).map_err(err)?;
    Ok(data::list(&state.data_dir))
}

/// Replace the task list with a backup. The current list is saved first.
#[tauri::command]
fn restore_backup(app: AppHandle, state: State<'_, AppState>, name: String) -> CmdResult<()> {
    let source = data::backup_path(&state.data_dir, &name)?;
    let db = state.data_dir.join("tasks.db");
    let staged = state.data_dir.join("tasks.db.restoring");
    let _ = std::fs::remove_file(&staged);
    std::fs::copy(&source, &staged).map_err(err)?;
    // Make sure it opens (and is migrated) before touching the live file.
    drop(Store::open(&staged).map_err(|e| format!("That backup can't be read: {e}"))?);
    {
        let mut store = state.store.lock().map_err(err)?;
        data::safety_copy(&store, &state.data_dir)?;
        // Close the live database before swapping files.
        *store = Store::open_in_memory().map_err(err)?;
        for ext in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", db.display()));
        }
        std::fs::rename(&staged, &db).map_err(err)?;
        *store = open_store(&db);
    }
    log::info!("restored tasks from {name}");
    let _ = app.emit("tasks-changed", ());
    tray::refresh(&app);
    nudge_reminders(&app);
    Ok(())
}

#[tauri::command]
fn reveal_backups(state: State<'_, AppState>) -> CmdResult<()> {
    let dir = data::backup_dir(&state.data_dir);
    std::fs::create_dir_all(&dir).map_err(err)?;
    reveal(&dir, false)
}

/// Save every task to Downloads as CSV or JSON and show it.
#[tauri::command]
fn export_tasks(state: State<'_, AppState>, format: String) -> CmdResult<String> {
    let tasks = state.store.lock().map_err(err)?.all().map_err(err)?;
    let (ext, body) = match format.as_str() {
        "csv" => ("csv", data::to_csv(&tasks)),
        "json" => ("json", serde_json::to_string_pretty(&tasks).map_err(err)?),
        other => return Err(format!("Unknown export format {other}")),
    };
    let stem = format!("Pluck tasks {}", chrono::Local::now().format("%Y-%m-%d"));
    let path = data::free_name(&data::downloads_dir(), &stem, ext);
    std::fs::write(&path, body).map_err(err)?;
    reveal(&path, true)?;
    Ok(path.display().to_string())
}

fn reveal(path: &std::path::Path, select: bool) -> CmdResult<()> {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        if select {
            c.arg("-R");
        }
        c.arg(path);
        c
    } else if cfg!(windows) {
        let mut c = std::process::Command::new("explorer");
        if select {
            c.arg(format!("/select,{}", path.display()));
        } else {
            c.arg(path);
        }
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(if select {
            path.parent().unwrap_or(path)
        } else {
            path
        });
        c
    };
    cmd.spawn().map(|_| ()).map_err(err)
}

#[tauri::command]
fn show_quick_add(app: AppHandle) {
    quick::show(&app);
}

#[tauri::command]
fn hide_quick_add(app: AppHandle) {
    quick::hide(&app);
}

// ── Models tab ──────────────────────────────────────────────────────────────

#[tauri::command]
fn list_models(models: State<'_, ModelManager>) -> Vec<ModelView> {
    models.list()
}

#[tauri::command]
fn download_model(app: AppHandle, id: String) -> CmdResult<()> {
    models::start_download(app, id)
}

#[tauri::command]
fn cancel_download(models: State<'_, ModelManager>, id: String) {
    models.cancel(&id);
}

#[tauri::command]
async fn delete_model(
    engine: State<'_, Engine>,
    models: State<'_, ModelManager>,
    id: String,
) -> CmdResult<()> {
    models.delete(&engine, &id).await
}

#[tauri::command]
async fn set_active_model(
    engine: State<'_, Engine>,
    models: State<'_, ModelManager>,
    id: String,
) -> CmdResult<()> {
    if !models.is_available(&id) {
        return Err("That model's file isn't available — download or add it first.".into());
    }
    models.set_active(Some(&id))?;
    // Free the old model's memory now; the new one loads on next capture.
    engine.stop().await;
    Ok(())
}

#[tauri::command]
fn list_local_models(models: State<'_, ModelManager>) -> LocalModels {
    models.local_models()
}

#[tauri::command]
async fn add_model_file(
    engine: State<'_, Engine>,
    models: State<'_, ModelManager>,
    path: String,
    source: Option<String>,
) -> CmdResult<CustomModel> {
    let model = models.add_file(&path, source)?;
    // The new file becomes active; free the previous model's memory.
    engine.stop().await;
    Ok(model)
}

#[tauri::command]
async fn remove_model_file(
    engine: State<'_, Engine>,
    models: State<'_, ModelManager>,
    id: String,
) -> CmdResult<()> {
    models.remove_file(&engine, &id).await
}

#[tauri::command]
fn request_accessibility() -> bool {
    capture::accessibility_trusted(true)
}

#[tauri::command]
fn hide_panel(app: AppHandle) {
    panel::hide(&app);
}

/// From the popover: open the main panel, optionally at a task or tab.
#[tauri::command]
fn open_main(app: AppHandle, task_id: Option<i64>, tab: Option<String>) {
    popover::hide(&app);
    panel::show(&app);
    let _ = app.emit_to("panel", "open-tab", tab.as_deref().unwrap_or("tasks"));
    if let Some(id) = task_id {
        let _ = app.emit_to("panel", "highlight-task", id);
    }
}

/// Show the panel on the task list, optionally flashing one task.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn open_main_at(app: &AppHandle, task_id: Option<i64>) {
    open_main(app.clone(), task_id, None);
}

#[tauri::command]
fn hide_popover(app: AppHandle) {
    popover::hide(&app);
}

#[tauri::command]
fn set_panel_collapsed(app: AppHandle, collapsed: bool) -> CmdResult<()> {
    panel::set_collapsed(&app, collapsed).map_err(err)
}

#[tauri::command]
fn snap_panel_to_edge(app: AppHandle) {
    panel::snap_to_edge(&app);
}

// ── Shortcuts ───────────────────────────────────────────────────────────────

#[tauri::command]
fn get_shortcuts(shortcuts: State<'_, Shortcuts>) -> ShortcutSettings {
    shortcuts.get()
}

fn shortcuts_changed(app: &AppHandle, settings: &ShortcutSettings) {
    let _ = app.emit("shortcuts-changed", settings);
    tray::refresh(app);
}

#[tauri::command]
fn set_shortcut(
    app: AppHandle,
    shortcuts: State<'_, Shortcuts>,
    action: Action,
    spec: Option<ShortcutSpec>,
) -> CmdResult<ShortcutSettings> {
    let next = shortcuts.set(&app, action, spec)?;
    shortcuts_changed(&app, &next);
    Ok(next)
}

#[tauri::command]
fn reset_shortcuts(app: AppHandle, shortcuts: State<'_, Shortcuts>) -> CmdResult<ShortcutSettings> {
    let next = shortcuts.reset(&app)?;
    shortcuts_changed(&app, &next);
    Ok(next)
}

/// Stop the global shortcuts while the user records a new one, so pressing
/// the current shortcut doesn't trigger a capture.
#[tauri::command]
fn pause_shortcuts(app: AppHandle, shortcuts: State<'_, Shortcuts>, paused: bool) {
    shortcuts.pause(&app, paused);
}

// ── Capture flow ────────────────────────────────────────────────────────────

fn on_capture(app: AppHandle) {
    // Start loading the model while the user reviews the capture.
    let warm_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let models = warm_app.state::<ModelManager>();
        if let Some(m) = models.active() {
            warm_app.state::<Engine>().warm(&m.path).await;
        }
    });
    tauri::async_runtime::spawn(async move {
        // Capture before showing the panel so the source app still has focus.
        let worker_app = app.clone();
        let with_source = app.state::<Settings>().get().remember_source;
        let joined = tauri::async_runtime::spawn_blocking(move || {
            capture::capture_selection(&worker_app, with_source)
        })
        .await;
        let result = match joined {
            Ok(Some(r)) => r,
            // Another capture is already running.
            Ok(None) => return,
            Err(e) => {
                log::error!("capture task failed: {e}");
                CaptureResult::Failed {
                    message: "Something went wrong reading the selection. Please try again.".into(),
                }
            }
        };
        deliver_capture(&app, &result);
    });
}

fn deliver_capture(app: &AppHandle, result: &CaptureResult) {
    quick::hide(app);
    panel::show(app);
    if let Err(e) = app.emit_to("panel", "capture", result) {
        log::error!("failed to deliver capture: {e}");
    }
}

/// Text sent through Services → "Add to Pluck".
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn on_service_text(app: AppHandle, text: String) {
    let with_source = app.state::<Settings>().get().remember_source;
    tauri::async_runtime::spawn(async move {
        let source = if with_source {
            tauri::async_runtime::spawn_blocking(capture::source_info)
                .await
                .ok()
                .flatten()
        } else {
            None
        };
        let models = app.state::<ModelManager>();
        if let Some(m) = models.active() {
            app.state::<Engine>().warm(&m.path).await;
        }
        deliver_capture(
            &app,
            &CaptureResult::Text {
                text,
                method: CaptureMethod::Service,
                source,
            },
        );
    });
}

/// Open the task database. If it can't be opened (e.g. the file is damaged),
/// set it aside as `tasks.db.unreadable-<time>` and start a fresh one rather
/// than refusing to launch; as a last resort, run with an in-memory store.
fn open_store(path: &std::path::Path) -> Store {
    match Store::open(path) {
        Ok(s) => return s,
        Err(e) => log::error!("could not open {}: {e}", path.display()),
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    for ext in ["", "-wal", "-shm"] {
        let from = std::path::PathBuf::from(format!("{}{ext}", path.display()));
        if from.exists() {
            let to = format!("{}.unreadable-{stamp}{ext}", path.display());
            if let Err(e) = std::fs::rename(&from, &to) {
                log::error!("could not move {} aside: {e}", from.display());
            }
        }
    }
    match Store::open(path) {
        Ok(s) => s,
        Err(e) => {
            log::error!("starting with an in-memory task list: {e}");
            Store::open_in_memory().expect("in-memory SQLite is always available")
        }
    }
}

// ── Logging ─────────────────────────────────────────────────────────────────

/// `~/Library/Logs/Pluck/pluck.log` on macOS; the temp folder elsewhere.
fn log_file_path() -> Option<std::path::PathBuf> {
    if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(|h| std::path::PathBuf::from(h).join("Library/Logs/Pluck/pluck.log"))
    } else {
        Some(std::env::temp_dir().join("Pluck").join("pluck.log"))
    }
}

/// Log to a file users can send with a bug report, and record panics (with
/// a backtrace) there before the default handler runs.
fn init_logging() {
    let mut builder =
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
    builder.format_timestamp_millis();
    if let Some(path) = log_file_path() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Start a fresh file once it passes 2 MB.
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > 2_000_000) {
            let _ = std::fs::remove_file(&path);
        }
        if let Ok(file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            builder.target(env_logger::Target::Pipe(Box::new(file)));
        }
    }
    let _ = builder.try_init();
    log::info!("Pluck {} starting", env!("CARGO_PKG_VERSION"));

    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!(
            "panic: {info}\n{}",
            std::backtrace::Backtrace::force_capture()
        );
        default_hook(info);
    }));
}

/// Show the log file in Finder / Explorer.
#[tauri::command]
fn reveal_logs() -> CmdResult<String> {
    let path = log_file_path().ok_or("no log location")?;
    let shown = path.display().to_string();
    let result = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
    } else if cfg!(windows) {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
    } else {
        std::process::Command::new("xdg-open")
            .arg(path.parent().unwrap_or(&path))
            .spawn()
    };
    result.map(|_| shown).map_err(err)
}

// ── Entry point ─────────────────────────────────────────────────────────────

pub fn run() {
    init_logging();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_notification::init());
    builder
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, sc, event| {
                    let Some(shortcuts) = app.try_state::<Shortcuts>() else {
                        return;
                    };
                    match (shortcuts.action_for(sc), event.state()) {
                        // Act on release so the user's modifier keys are coming
                        // up before any synthesized Copy.
                        (Some(Action::Capture), ShortcutState::Released) => on_capture(app.clone()),
                        (Some(Action::QuickAdd), ShortcutState::Pressed) => quick::toggle(app),
                        (Some(Action::TogglePanel), ShortcutState::Pressed) => panel::toggle(app),
                        _ => {}
                    }
                })
                .build(),
        )
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let log_dir = app.path().app_log_dir()?;
            std::fs::create_dir_all(&log_dir)?;
            let store = open_store(&data_dir.join("tasks.db"));
            match data::daily_backup(&store, &data_dir) {
                Ok(Some(p)) => log::info!("backup written to {}", p.display()),
                Ok(None) => {}
                Err(e) => log::warn!("daily backup failed: {e}"),
            }
            app.manage(AppState {
                store: Mutex::new(store),
                data_dir: data_dir.clone(),
            });
            app.manage(Settings::new(&data_dir));
            app.manage(Updates::default());
            app.manage(ModelManager::new(&data_dir));
            app.manage(panel::PanelState::new(&data_dir));
            app.manage(Engine::new(&log_dir));
            app.manage(Shortcuts::new(&data_dir));
            app.manage(reminders::Reminders::start(app.handle(), &data_dir));

            // Every 30 s: release the model's memory when idle, and roll the
            // menu-bar list over to the new day at midnight.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut day = chrono::Local::now().date_naive();
                loop {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    handle.state::<Engine>().stop_if_idle().await;
                    let now = chrono::Local::now().date_naive();
                    if now != day {
                        day = now;
                        tray::refresh(&handle);
                        let _ = handle.emit("tasks-changed", ());
                        let state = handle.state::<AppState>();
                        let result = match state.store.lock() {
                            Ok(store) => data::daily_backup(&store, &state.data_dir),
                            Err(e) => Err(e.to_string()),
                        };
                        if let Err(e) = result {
                            log::warn!("daily backup failed: {e}");
                        }
                    }
                }
            });

            app.state::<Shortcuts>().register_all(app.handle());
            tray::build(app.handle())?;
            // Let Pluck's windows open over full-screen apps.
            spaces::configure_all(app.handle());
            notifications::init(app.handle());
            notifications::start_scheduler(app.handle());
            updates::start(app.handle());
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle().clone();
                services::register(move |text| on_service_text(handle.clone(), text));
            }

            // Pluck lives in the menu bar, so open it at login — once, by
            // default; after that it's the user's switch in Settings.
            let settings = app.state::<Settings>();
            if !settings.get().autostart_initialized {
                if let Err(e) = app.autolaunch().enable() {
                    log::warn!("could not enable open at login: {e}");
                }
                settings.update(|s| s.autostart_initialized = true);
            }

            // Show the panel at launch (always on a first run, for the tour),
            // and again on the first wake of each day.
            let first_run = !app.state::<Settings>().get().onboarding_done
                && app.state::<ModelManager>().active().is_none()
                && app.state::<Engine>().kind() == "bundled";
            greet::on_launch(app.handle(), first_run);
            greet::start(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Moved(pos) if window.label() == "panel" => {
                panel::on_moved(window.app_handle(), *pos);
            }
            // The popover behaves like a menu: clicking elsewhere closes it.
            tauri::WindowEvent::Focused(false) if window.label() == popover::LABEL => {
                popover::on_blur(window.app_handle());
            }
            tauri::WindowEvent::Focused(false) if window.label() == quick::LABEL => {
                quick::hide(window.app_handle());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            extract,
            list_tasks,
            add_task,
            update_task,
            delete_task,
            status,
            request_accessibility,
            hide_panel,
            set_panel_collapsed,
            snap_panel_to_edge,
            list_models,
            download_model,
            cancel_download,
            delete_model,
            set_active_model,
            list_local_models,
            add_model_file,
            remove_model_file,
            get_shortcuts,
            set_shortcut,
            reset_shortcuts,
            pause_shortcuts,
            reveal_logs,
            open_main,
            hide_popover,
            reminders_status,
            reminders_request_access,
            reminders_lists,
            reminders_enable,
            reminders_disable,
            reminders_sync_now,
            reminders_set_include_notes,
            reminders_open_privacy_settings,
            open_source,
            open_url,
            restore_task,
            get_settings,
            set_settings,
            notification_permission,
            request_notification_permission,
            test_notification,
            open_notification_settings,
            autostart_enabled,
            set_autostart,
            update_status,
            check_for_updates,
            install_update,
            list_backups,
            backup_now,
            restore_backup,
            reveal_backups,
            export_tasks,
            show_quick_add,
            hide_quick_add
        ])
        .build(tauri::generate_context!())
        .expect("error while building Pluck")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<Engine>().kill_now();
                app.state::<panel::PanelState>().flush();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task() -> Task {
        Task {
            id: 1,
            title: "x".into(),
            due_date: None,
            source_text: None,
            done: false,
            created_at: String::new(),
            created_tz: None,
            completed_at: None,
            due_time: None,
            recurrence: None,
            source_app: None,
            source_bundle: None,
            source_url: None,
            snoozed_until: None,
            notified_at: None,
            next_id: None,
            notes: None,
        }
    }

    #[test]
    fn slack_links_open_in_the_app() {
        assert_eq!(
            slack_deep_link("https://app.slack.com/client/T0123/C0456"),
            Some("slack://channel?team=T0123&id=C0456".into())
        );
        assert_eq!(
            slack_deep_link("https://app.slack.com/client/T0123/C0456/thread/C0456-1.2"),
            Some("slack://channel?team=T0123&id=C0456".into())
        );
        assert_eq!(slack_deep_link("https://app.slack.com/client/T0123"), None);
        assert_eq!(slack_deep_link("https://evil.example/client/T1/C2"), None);
    }

    #[test]
    fn source_targets() {
        let mut t = task();
        assert_eq!(source_target(&t), None);
        t.source_bundle = Some("com.apple.Notes".into());
        assert_eq!(
            source_target(&t),
            Some(OpenTarget::App("com.apple.Notes".into()))
        );
        t.source_url = Some("https://example.com/a?b=1".into());
        assert_eq!(
            source_target(&t),
            Some(OpenTarget::Url("https://example.com/a?b=1".into()))
        );
        // Only web and file links are opened.
        t.source_url = Some("javascript:alert(1)".into());
        assert_eq!(
            source_target(&t),
            Some(OpenTarget::App("com.apple.Notes".into()))
        );
        t.source_bundle = Some("bad bundle; rm -rf".into());
        assert_eq!(source_target(&t), None);
    }
}
