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
        let result = tauri::async_runtime::spawn_blocking(capture::capture_selection)
            .await
            .unwrap_or(CaptureResult::NothingSelected);
        panel::show(&app);
        if let Err(e) = app.emit_to("panel", "capture", &result) {
            log::error!("failed to deliver capture: {e}");
        }
    });
}

// ── Entry point ─────────────────────────────────────────────────────────────

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
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
            let store = Store::open(data_dir.join("tasks.db"))?;
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
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Moved(pos) = event {
                if window.label() == "panel" {
                    panel::on_moved(window.app_handle(), *pos);
                }
            }
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
            pause_shortcuts
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
