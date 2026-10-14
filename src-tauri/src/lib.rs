//! Pluck desktop shell: tray icon, global shortcut, docked task panel.
//!
//! Lifecycle of one capture:
//!   shortcut released → capture selection (worker thread, before the panel
//!   takes focus) → emit `capture` to the panel and show it → the panel calls
//!   `extract` (one localhost request) → user confirms the date → `add_task`
//!   (one SQLite write). Nothing runs in the background between captures.

mod capture;
mod panel;

use std::sync::Mutex;

use pluck_core::{
    extract_task, Extraction, NewTask, OllamaClient, OllamaConfig, Store, Task, TaskPatch,
};
use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::capture::CaptureResult;

pub struct AppState {
    store: Mutex<Store>,
    llm: OllamaClient,
}

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
async fn extract(state: State<'_, AppState>, selection: String) -> CmdResult<Extraction> {
    extract_task(&state.llm, &selection).await.map_err(err)
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
    model: String,
    model_reachable: bool,
    model_error: Option<String>,
}

#[tauri::command]
async fn status(state: State<'_, AppState>) -> CmdResult<Status> {
    let warm = state.llm.warm_up().await;
    Ok(Status {
        accessibility: capture::accessibility_trusted(false),
        model: state.llm.config().model.clone(),
        model_reachable: warm.is_ok(),
        model_error: warm.err().map(err),
    })
}

#[tauri::command]
fn request_accessibility() -> bool {
    capture::accessibility_trusted(true)
}

#[tauri::command]
fn hide_panel(app: AppHandle) {
    panel::hide(&app);
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

fn llm_config() -> OllamaConfig {
    let mut cfg = OllamaConfig::default();
    if let Ok(m) = std::env::var("PLUCK_MODEL") {
        cfg.model = m;
    }
    if let Ok(u) = std::env::var("PLUCK_OLLAMA_URL") {
        cfg.base_url = u;
    }
    cfg
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
            let store = Store::open(data_dir.join("tasks.db"))?;
            let llm = OllamaClient::new(llm_config())?;
            app.manage(AppState {
                store: Mutex::new(store),
                llm,
            });

            app.global_shortcut().register(capture_shortcut())?;

            let show = MenuItem::with_id(app, "show", "Show tasks", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Pluck", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("pluck")
                .tooltip("Pluck — select text, press ⌘⇧T / Ctrl+Shift+T")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => panel::toggle(app),
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            extract,
            list_tasks,
            add_task,
            update_task,
            delete_task,
            status,
            request_accessibility,
            hide_panel
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pluck");
}
