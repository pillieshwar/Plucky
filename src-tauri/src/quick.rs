//! Quick add: a Spotlight-style bar for typing a task ("pay rent friday
//! 5pm #home"), opened with a global shortcut from any app.

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};

pub const LABEL: &str = "quick";

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

pub fn toggle(app: &AppHandle) {
    let Some(win) = window(app) else { return };
    if win.is_visible().unwrap_or(false) {
        hide(app);
    } else {
        show(app);
    }
}

pub fn show(app: &AppHandle) {
    let Some(win) = window(app) else { return };
    crate::popover::hide(app);
    crate::spaces::configure(&win, crate::spaces::Kind::Overlay);
    if let Err(e) = place(&win) {
        log::warn!("could not position quick add: {e}");
    }
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit_to(LABEL, "quick-shown", ());
}

pub fn hide(app: &AppHandle) {
    if let Some(win) = window(app) {
        let _ = win.hide();
    }
}

/// Centered horizontally, a little above the middle of the screen the
/// pointer is on — where Spotlight sits.
fn place(win: &WebviewWindow) -> tauri::Result<()> {
    let cursor = win.cursor_position().ok();
    let monitor = match cursor {
        Some(c) => win.monitor_from_point(c.x, c.y)?,
        None => None,
    }
    .or(win.current_monitor()?)
    .or(win.primary_monitor()?);
    let Some(m) = monitor else {
        return win.center();
    };
    let size = win.outer_size()?;
    let (mp, ms) = (m.position(), m.size());
    let x = mp.x as f64 + (ms.width as f64 - size.width as f64) / 2.0;
    let y = mp.y as f64 + ms.height as f64 * 0.2;
    win.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
}
