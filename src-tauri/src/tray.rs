//! The menu-bar icon, which carries a count of today's open tasks.
//!
//! * Left click: the calendar popover (see `popover`).
//! * Right click: a menu with today's tasks and app actions.

use chrono::Local;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};
use todocity_core::Task;

use crate::shortcuts::Shortcuts;
use crate::updates::{UpdateStatus, Updates};
use crate::{panel, popover, quick, AppState};

const TRAY_ID: &str = "todocity";

/// Where the menu-bar icon is on screen, if it's showing.
pub fn icon_rect(app: &AppHandle) -> Option<tauri::Rect> {
    app.tray_by_id(TRAY_ID)?.rect().ok().flatten()
}
const MAX_TASKS: usize = 8;
const MAX_TITLE: usize = 48;

/// Give the menu-bar icon its starting spot, once per install: at the right
/// end of the menu bar, next to the battery and just left of Control Center
/// and the clock (which always stay rightmost).
///
/// macOS has no API for this. It remembers each status item's spot in the
/// app's own defaults, under `NSStatusItem Preferred Position <name>` — the
/// distance in points from the right edge of the screen — and reads it when
/// the item is created. Tauri doesn't let us name the item, so AppKit calls
/// it `Item-0` (the app's first and only status item). That key lives in the
/// `app.pluck.desktop` defaults, which the rename to TodoCity kept, so a spot
/// the user picks by ⌘-dragging survives updates. Writing a small distance
/// before the item exists places it as far right as macOS allows. After
/// this one time the spot is left to the user.
#[cfg(target_os = "macos")]
fn place(app: &AppHandle) {
    #![allow(unused_unsafe)]
    use objc2_foundation::{NSString, NSUserDefaults};

    let settings = app.state::<crate::settings::Settings>();
    if settings.get().menubar_placed {
        return;
    }
    let key = NSString::from_str("NSStatusItem Preferred Position Item-0");
    unsafe {
        let defaults = NSUserDefaults::standardUserDefaults();
        defaults.setDouble_forKey(RIGHT_EDGE, &key);
        defaults.synchronize();
    }
    settings.update(|s| s.menubar_placed = true);
    log::info!("placed the menu-bar icon at the right end of the menu bar");
}

/// Points from the right edge of the screen; anything this small means "as
/// far right as third-party icons may go".
#[cfg(target_os = "macos")]
const RIGHT_EDGE: f64 = 1.0;

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    place(app);
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip(app))
        .menu(&menu(app)?)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                popover::toggle(tray.app_handle(), rect);
            }
        });
    // A black-on-transparent template image: macOS tints it to match the
    // menu bar (dark or light, highlighted or not).
    match tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png")) {
        Ok(icon) => tray = tray.icon(icon).icon_as_template(true),
        Err(e) => {
            log::warn!("tray icon failed to load: {e}");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
        }
    }
    tray.build(app)?;
    refresh(app);
    Ok(())
}

/// Rebuild the menu and count. Call after tasks change and at midnight.
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    match menu(app) {
        Ok(m) => {
            let _ = tray.set_menu(Some(m));
        }
        Err(e) => log::warn!("could not rebuild tray menu: {e}"),
    }
    let _ = tray.set_tooltip(Some(tooltip(app)));
    #[cfg(target_os = "macos")]
    {
        let count = due_today(app).len();
        let title = (count > 0).then(|| count.to_string());
        let _ = tray.set_title(title);
    }
}

fn today() -> String {
    Local::now().date_naive().format("%Y-%m-%d").to_string()
}

/// Open tasks due today or earlier, overdue first.
fn due_today(app: &AppHandle) -> Vec<Task> {
    let Some(state) = app.try_state::<AppState>() else {
        return Vec::new();
    };
    let today = today();
    let tasks = state
        .store
        .lock()
        .ok()
        .and_then(|s| s.list(None).ok())
        .unwrap_or_default();
    let mode = crate::active_mode(app);
    tasks
        .into_iter()
        .filter(|t| !t.done && t.due_date.as_deref().is_some_and(|d| d <= today.as_str()))
        .filter(|t| mode.as_ref().map_or(true, |m| m.shows(t)))
        .collect()
}

fn capture_label(app: &AppHandle) -> String {
    app.try_state::<Shortcuts>()
        .map(|s| s.capture_label())
        .unwrap_or_default()
}

fn tooltip(app: &AppHandle) -> String {
    let n = due_today(app).len();
    let due = match n {
        0 => "nothing due today".to_string(),
        1 => "1 task due today".to_string(),
        n => format!("{n} tasks due today"),
    };
    format!(
        "TodoCity — {due}. Select text and press {}.",
        capture_label(app)
    )
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max - 1).collect();
        format!("{}…", cut.trim_end())
    }
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let tasks = due_today(app);
    let today = today();
    let menu = Menu::new(app)?;
    let heading = format!("Today · {}", Local::now().format("%a, %b %-d"));
    menu.append(&MenuItem::with_id(
        app,
        "heading",
        heading,
        false,
        None::<&str>,
    )?)?;

    if tasks.is_empty() {
        menu.append(&MenuItem::with_id(
            app,
            "none",
            "Nothing due today",
            false,
            None::<&str>,
        )?)?;
    }
    for t in tasks.iter().take(MAX_TASKS) {
        let overdue = t.due_date.as_deref().is_some_and(|d| d < today.as_str());
        let title = truncate(&t.title, MAX_TITLE);
        let label = if overdue {
            format!("{title} · overdue")
        } else {
            title
        };
        menu.append(&MenuItem::with_id(
            app,
            format!("task:{}", t.id),
            label,
            true,
            None::<&str>,
        )?)?;
    }
    if tasks.len() > MAX_TASKS {
        let more = format!("{} more…", tasks.len() - MAX_TASKS);
        menu.append(&MenuItem::with_id(app, "more", more, true, None::<&str>)?)?;
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let quick_label = match app
        .try_state::<Shortcuts>()
        .and_then(|s| s.quick_add_label())
    {
        Some(sc) => format!("Quick add…  {sc}"),
        None => "Quick add…".to_string(),
    };
    menu.append(&MenuItem::with_id(
        app,
        "quick",
        quick_label,
        true,
        None::<&str>,
    )?)?;
    let open_label = match app
        .try_state::<Shortcuts>()
        .and_then(|s| s.toggle_panel_label())
    {
        Some(sc) => format!("Open TodoCity  {sc}"),
        None => "Open TodoCity".to_string(),
    };
    menu.append(&MenuItem::with_id(
        app,
        "show",
        open_label,
        true,
        None::<&str>,
    )?)?;
    let hint = format!("Capture: select text, press {}", capture_label(app));
    menu.append(&MenuItem::with_id(app, "hint", hint, false, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "models",
        "Models…",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "settings",
        "Preferences…",
        true,
        None::<&str>,
    )?)?;
    let full_label = if panel::is_full(app) {
        "Back to the side panel"
    } else {
        "Open full screen"
    };
    menu.append(&MenuItem::with_id(
        app,
        "full",
        full_label,
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "snap",
        "Snap panel to right edge",
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let update = app.try_state::<Updates>().map(|u| u.status());
    let (update_label, update_enabled) = match update {
        Some(UpdateStatus::Ready { version, .. }) => {
            (format!("Restart to update to {version}"), true)
        }
        Some(UpdateStatus::Downloading { version, .. }) => {
            (format!("Downloading update {version}…"), false)
        }
        Some(UpdateStatus::Checking) => ("Checking for updates…".to_string(), false),
        _ => ("Check for updates…".to_string(), true),
    };
    menu.append(&MenuItem::with_id(
        app,
        "update",
        update_label,
        update_enabled,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "Quit TodoCity",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

fn open_tab(app: &AppHandle, tab: &str) {
    popover::hide(app);
    panel::show(app);
    let _ = app.emit_to("panel", "open-tab", tab);
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id.as_ref();
    match id {
        "show" | "more" => open_tab(app, "tasks"),
        "quick" => quick::show(app),
        "update" => {
            let ready = app
                .try_state::<Updates>()
                .is_some_and(|u| matches!(u.status(), UpdateStatus::Ready { .. }));
            if ready {
                if let Err(e) = crate::updates::install_and_restart(app) {
                    log::error!("update failed: {e}");
                }
            } else {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { crate::updates::check(app).await });
            }
        }
        "models" => open_tab(app, "models"),
        "settings" => open_tab(app, "settings"),
        "full" => {
            popover::hide(app);
            let full = !panel::is_full(app);
            if let Err(e) = panel::set_full(app, full) {
                log::warn!("could not change full screen: {e}");
            }
        }
        "snap" => {
            if panel::is_full(app) {
                let _ = panel::set_full(app, false);
            }
            panel::snap_to_edge(app)
        }
        "quit" => app.exit(0),
        _ => {
            if let Some(task_id) = id.strip_prefix("task:").and_then(|n| n.parse::<i64>().ok()) {
                open_tab(app, "tasks");
                let _ = app.emit_to("panel", "highlight-task", task_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::truncate;

    #[test]
    fn truncates_on_char_boundaries() {
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate("Review the rollout checklist", 10), "Review th…");
        assert_eq!(truncate("日本語のタスクです", 5), "日本語の…");
    }
}
