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

use std::sync::Mutex;
use std::time::Duration;

use pluck_core::{Extraction, NewTask, Store, Task, TaskPatch};
use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::capture::CaptureResult;
use crate::engine::Engine;
use crate::models::{ModelManager, ModelView};

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
        Some(m) => models.path_for(m),
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
    Ok(t)
}

#[tauri::command]
fn delete_task(app: AppHandle, state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    state.store.lock().map_err(err)?.delete(id).map_err(err)?;
    let _ = app.emit("tasks-changed", ());
    Ok(())
}

#[derive(Serialize)]
struct Status {
    accessibility: bool,
    /// "bundled" (default) or "ollama" (developer override).
    engine: &'static str,
    /// Name of the model captures will use, if one is installed.
    active_model: Option<&'static str>,
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
    let model = pluck_core::models::find(&id).ok_or("unknown model")?;
    if !models.is_installed(model) {
        return Err("Download this model before using it.".into());
    }
    models.set_active(Some(&id))?;
    // Free the old model's memory now; the new one loads on next capture.
    engine.stop().await;
    Ok(())
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

// ── Capture flow ────────────────────────────────────────────────────────────

fn capture_shortcut() -> Shortcut {
    let primary = if cfg!(target_os = "macos") {
        Modifiers::SUPER
    } else {
        Modifiers::CONTROL
    };
    Shortcut::new(Some(primary | Modifiers::SHIFT), Code::KeyT)
}

fn on_capture(app: AppHandle) {
    // Start loading the model while the user reviews the capture.
    let warm_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let models = warm_app.state::<ModelManager>();
        if let Some(m) = models.active() {
            warm_app.state::<Engine>().warm(&models.path_for(m)).await;
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
                    // Act on release so the user's modifier keys are coming up
                    // before any synthesized Copy.
                    if *sc == capture_shortcut() && event.state() == ShortcutState::Released {
                        on_capture(app.clone());
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

            // Release the model's memory after a few idle minutes.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    handle.state::<Engine>().stop_if_idle().await;
                }
            });

            app.global_shortcut().register(capture_shortcut())?;

            let show = MenuItem::with_id(app, "show", "Show tasks", true, None::<&str>)?;
            let models_item = MenuItem::with_id(app, "models", "Models…", true, None::<&str>)?;
            let snap =
                MenuItem::with_id(app, "snap", "Snap panel to right edge", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Pluck", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &models_item, &snap, &quit])?;
            let mut tray = TrayIconBuilder::with_id("pluck")
                .tooltip("Pluck — select text, press ⌘⇧T / Ctrl+Shift+T")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => panel::toggle(app),
                    "snap" => panel::snap_to_edge(app),
                    "models" => {
                        panel::show(app);
                        let _ = app.emit_to("panel", "open-tab", "models");
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

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
            set_active_model
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
