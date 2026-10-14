//! Pluck desktop shell: tray icon, global shortcut, docked task panel.
//!
//! Lifecycle of one capture:
//!   shortcut released → pre-warm the bundled model runtime and capture the
//!   selection (worker thread, before the panel takes focus) → emit `capture`
//!   to the panel and show it → the panel calls `extract` (one localhost
//!   request) → user confirms the date → `add_task` (one SQLite write).
//!   The runtime stops itself after a few idle minutes.

mod capture;
mod engine;
mod models;
mod panel;
mod popover;
mod shortcuts;
mod tray;

use std::sync::Mutex;
use std::time::Duration;

use pluck_core::{Extraction, NewTask, Store, Task, TaskPatch};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::ShortcutState;

use crate::capture::CaptureResult;
use crate::engine::Engine;
use crate::models::{CustomModel, LocalModels, ModelManager, ModelView};
use crate::shortcuts::{Action, ShortcutSettings, ShortcutSpec, Shortcuts};

pub struct AppState {
    store: Mutex<Store>,
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
    Ok(t)
}

#[tauri::command]
fn update_task(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    patch: TaskPatch,
) -> CmdResult<Task> {
    let t = state
        .store
        .lock()
        .map_err(err)?
        .update(id, patch)
        .map_err(err)?;
    let _ = app.emit("tasks-changed", ());
    tray::refresh(&app);
    Ok(t)
}

#[tauri::command]
fn delete_task(app: AppHandle, state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    state.store.lock().map_err(err)?.delete(id).map_err(err)?;
    let _ = app.emit("tasks-changed", ());
    tray::refresh(&app);
    Ok(())
}

#[derive(Serialize)]
struct Status {
    accessibility: bool,
    /// "bundled" (default) or "ollama" (developer override).
    engine: &'static str,
    /// Name of the model captures will use, if one is installed.
    active_model: Option<String>,
}

#[tauri::command]
fn status(engine: State<'_, Engine>, models: State<'_, ModelManager>) -> Status {
    Status {
        accessibility: capture::accessibility_trusted(false),
        engine: engine.kind(),
        active_model: models.active().map(|m| m.name),
    }
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
        let joined =
            tauri::async_runtime::spawn_blocking(move || capture::capture_selection(&worker_app))
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
        panel::show(&app);
        if let Err(e) = app.emit_to("panel", "capture", &result) {
            log::error!("failed to deliver capture: {e}");
        }
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
    tauri::Builder::default()
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
            app.manage(AppState {
                store: Mutex::new(store),
            });
            app.manage(ModelManager::new(&data_dir));
            app.manage(panel::PanelState::new(&data_dir));
            app.manage(Engine::new(&log_dir));
            app.manage(Shortcuts::new(&data_dir));

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
                    }
                }
            });

            app.state::<Shortcuts>().register_all(app.handle());
            tray::build(app.handle())?;

            // First launch: no model yet, so open the panel (on the Models tab)
            // instead of starting silently in the menu bar.
            if app.state::<ModelManager>().active().is_none()
                && app.state::<Engine>().kind() == "bundled"
            {
                panel::show(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Moved(pos) if window.label() == "panel" => {
                panel::on_moved(window.app_handle(), *pos);
            }
            // The popover behaves like a menu: clicking elsewhere closes it.
            tauri::WindowEvent::Focused(false) if window.label() == popover::LABEL => {
                popover::hide(window.app_handle());
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
            hide_popover
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
