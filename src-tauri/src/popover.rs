//! The menu-bar popover: a small calendar + agenda window that drops down
//! from the Pluck icon when it's clicked, and hides when it loses focus.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Rect, WebviewWindow};

pub const LABEL: &str = "popover";
/// Gap between the menu bar icon and the popover, in logical pixels.
const GAP: f64 = 6.0;
/// A click on the icon right after the popover hid itself (because that same
/// click took focus away) should close it, not reopen it.
const REOPEN_GUARD: Duration = Duration::from_millis(250);

static LAST_HIDDEN: Mutex<Option<Instant>> = Mutex::new(None);

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

fn recently_hidden() -> bool {
    LAST_HIDDEN
        .lock()
        .ok()
        .and_then(|t| *t)
        .is_some_and(|t| t.elapsed() < REOPEN_GUARD)
}

/// Show the popover under the icon at `icon`, or hide it if it's open.
pub fn toggle(app: &AppHandle, icon: Rect) {
    let Some(win) = window(app) else { return };
    if win.is_visible().unwrap_or(false) {
        hide(app);
        return;
    }
    if recently_hidden() {
        return;
    }
    if let Err(e) = place(&win, icon) {
        log::warn!("could not position popover: {e}");
    }
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit_to(LABEL, "popover-shown", ());
}

pub fn hide(app: &AppHandle) {
    if let Some(win) = window(app) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            if let Ok(mut t) = LAST_HIDDEN.lock() {
                *t = Some(Instant::now());
            }
        }
    }
}

/// Centre the popover under the icon, kept on screen. On a bottom taskbar
/// (Windows) it opens upwards instead.
fn place(win: &WebviewWindow, icon: Rect) -> tauri::Result<()> {
    let scale = win.scale_factor()?;
    let pos = icon.position.to_physical::<f64>(scale);
    let size = icon.size.to_physical::<f64>(scale);
    let win_size = win.outer_size()?;
    let (w, h) = (win_size.width as f64, win_size.height as f64);
    let gap = GAP * scale;

    let center_x = pos.x + size.width / 2.0;
    let mut x = center_x - w / 2.0;
    let mut y = pos.y + size.height + gap;

    if let Some(m) = win.monitor_from_point(center_x, pos.y + size.height / 2.0)? {
        let (mp, ms) = (m.position(), m.size());
        let (left, top) = (mp.x as f64, mp.y as f64);
        let (right, bottom) = (left + ms.width as f64, top + ms.height as f64);
        x = x.clamp(left + gap, (right - w - gap).max(left + gap));
        if y + h > bottom {
            y = (pos.y - h - gap).max(top);
        }
    }
    win.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
}
