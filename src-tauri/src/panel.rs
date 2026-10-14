//! The right-edge task rail: one undecorated, always-on-top window that is
//! docked to the monitor under the cursor each time it is shown.

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const LABEL: &str = "panel";
/// Logical width of the rail.
const WIDTH: f64 = 360.0;
/// Logical insets that keep the rail clear of the menu bar / taskbar.
#[cfg(target_os = "macos")]
const INSETS: (f64, f64) = (32.0, 8.0);
#[cfg(windows)]
const INSETS: (f64, f64) = (8.0, 56.0);
#[cfg(not(any(target_os = "macos", windows)))]
const INSETS: (f64, f64) = (8.0, 8.0);

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

fn dock(win: &WebviewWindow) -> tauri::Result<()> {
    let monitor = match win
        .cursor_position()
        .ok()
        .and_then(|p| win.monitor_from_point(p.x, p.y).ok().flatten())
    {
        Some(m) => Some(m),
        None => win.primary_monitor()?,
    };
    let Some(m) = monitor else { return Ok(()) };
    let scale = m.scale_factor();
    let (top, bottom) = ((INSETS.0 * scale) as i32, (INSETS.1 * scale) as i32);
    let width = (WIDTH * scale).round() as i32;
    let margin = (8.0 * scale) as i32;
    let size = m.size();
    let pos = m.position();
    let height = (size.height as i32 - top - bottom).max(200);
    win.set_size(PhysicalSize::new(width as u32, height as u32))?;
    win.set_position(PhysicalPosition::new(
        pos.x + size.width as i32 - width - margin,
        pos.y + top,
    ))?;
    Ok(())
}

pub fn show(app: &AppHandle) {
    if let Some(win) = window(app) {
        if let Err(e) = dock(&win) {
            log::warn!("could not dock panel: {e}");
        }
        let _ = win.show();
        let _ = win.set_focus();
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(win) = window(app) {
        let _ = win.hide();
    }
}

pub fn toggle(app: &AppHandle) {
    match window(app).map(|w| w.is_visible().unwrap_or(false)) {
        Some(true) => hide(app),
        Some(false) => show(app),
        None => {}
    }
}
