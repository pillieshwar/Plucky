//! The task panel: one undecorated, always-on-top window.
//!
//! * Until the user moves it, it docks to the right edge of the screen under
//!   the cursor each time it opens.
//! * Once dragged (by its header), it reopens where it was left — remembered
//!   across launches. "Snap to right edge" in the tray menu undoes that.
//! * It can be minimized to a slim bar, and expands again on the next
//!   capture, from the tray, or with its expand button.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

const LABEL: &str = "panel";
/// Logical width of the panel.
const WIDTH: f64 = 360.0;
/// Logical height of the minimized bar.
const COLLAPSED_HEIGHT: f64 = 52.0;
/// Smallest logical height of the expanded panel.
const MIN_HEIGHT: f64 = 320.0;
/// Logical insets that keep the docked panel clear of the menu bar / taskbar.
#[cfg(target_os = "macos")]
const INSETS: (f64, f64) = (32.0, 8.0);
#[cfg(windows)]
const INSETS: (f64, f64) = (8.0, 56.0);
#[cfg(not(any(target_os = "macos", windows)))]
const INSETS: (f64, f64) = (8.0, 8.0);
/// Moves reported this soon after we positioned the window ourselves are
/// ours, not the user's.
const SELF_MOVE_GRACE: Duration = Duration::from_millis(400);

/// A user-chosen spot, in physical pixels.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct Placement {
    x: i32,
    y: i32,
    height: u32,
}

#[derive(Default, Serialize, Deserialize)]
struct Persisted {
    placement: Option<Placement>,
}

#[derive(Default)]
struct Inner {
    placement: Option<Placement>,
    collapsed: bool,
    /// Height to restore when expanding.
    expanded_height: Option<u32>,
    self_moved_at: Option<Instant>,
    dirty: bool,
    last_save: Option<Instant>,
}

pub struct PanelState {
    path: PathBuf,
    inner: Mutex<Inner>,
}

impl PanelState {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join("panel.json");
        let persisted: Persisted = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            path,
            inner: Mutex::new(Inner {
                placement: persisted.placement,
                ..Default::default()
            }),
        }
    }

    fn save(&self, inner: &mut Inner) {
        let data = Persisted {
            placement: inner.placement,
        };
        match serde_json::to_vec_pretty(&data) {
            Ok(bytes) => {
                if let Err(e) = std::fs::write(&self.path, bytes) {
                    log::warn!("could not save panel position: {e}");
                }
            }
            Err(e) => log::warn!("could not encode panel position: {e}"),
        }
        inner.dirty = false;
        inner.last_save = Some(Instant::now());
    }

    /// Write the position if it changed since the last save.
    pub fn flush(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.dirty {
                self.save(&mut inner);
            }
        }
    }
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

fn state(app: &AppHandle) -> tauri::State<'_, PanelState> {
    app.state::<PanelState>()
}

fn monitor_under_cursor(win: &WebviewWindow) -> tauri::Result<Option<Monitor>> {
    let under_cursor = win
        .cursor_position()
        .ok()
        .and_then(|p| win.monitor_from_point(p.x, p.y).ok().flatten());
    match under_cursor {
        Some(m) => Ok(Some(m)),
        None => win.primary_monitor(),
    }
}

/// The monitor containing the point, if any.
fn monitor_at(win: &WebviewWindow, x: i32, y: i32) -> Option<Monitor> {
    win.available_monitors().ok()?.into_iter().find(|m| {
        let (p, s) = (m.position(), m.size());
        x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32
    })
}

/// Size and move the window, marking the move as ours.
fn apply(
    win: &WebviewWindow,
    inner: &mut Inner,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> tauri::Result<()> {
    inner.self_moved_at = Some(Instant::now());
    win.set_size(PhysicalSize::new(w, h))?;
    // Re-position after resizing: some platforms keep the bottom edge fixed.
    win.set_position(PhysicalPosition::new(x, y))?;
    Ok(())
}

/// Dock to the right edge of the monitor under the cursor.
fn dock(win: &WebviewWindow, inner: &mut Inner) -> tauri::Result<()> {
    let Some(m) = monitor_under_cursor(win)? else {
        return Ok(());
    };
    let scale = m.scale_factor();
    let (top, bottom) = ((INSETS.0 * scale) as i32, (INSETS.1 * scale) as i32);
    let width = (WIDTH * scale).round() as i32;
    let margin = (8.0 * scale) as i32;
    let (size, pos) = (m.size(), m.position());
    let height = (size.height as i32 - top - bottom).max((MIN_HEIGHT * scale) as i32);
    apply(
        win,
        inner,
        pos.x + size.width as i32 - width - margin,
        pos.y + top,
        width as u32,
        height as u32,
    )
}

/// Put the window where the user left it, kept fully on screen. Returns
/// false if that spot is no longer on any monitor (e.g. a display was
/// unplugged), so the caller can dock instead.
fn restore(win: &WebviewWindow, inner: &mut Inner, p: Placement) -> tauri::Result<bool> {
    let Some(m) = monitor_at(win, p.x + 20, p.y + 10) else {
        return Ok(false);
    };
    let scale = m.scale_factor();
    let (mpos, msize) = (m.position(), m.size());
    let width = (WIDTH * scale).round() as i32;
    let top_inset = (INSETS.0 * scale) as i32;
    let min_h = (MIN_HEIGHT * scale) as i32;
    let max_h = msize.height as i32 - top_inset;
    let height = (p.height as i32).clamp(min_h.min(max_h), max_h);
    let x = p.x.clamp(mpos.x, mpos.x + msize.width as i32 - width);
    let y =
        p.y.clamp(mpos.y + top_inset, mpos.y + msize.height as i32 - height);
    apply(win, inner, x, y, width as u32, height as u32)?;
    Ok(true)
}

/// Show the panel expanded, at the user's spot or docked.
pub fn show(app: &AppHandle) {
    let Some(win) = window(app) else { return };
    let st = state(app);
    if let Ok(mut inner) = st.inner.lock() {
        inner.collapsed = false;
        inner.expanded_height = None;
        let placed = match inner.placement {
            Some(p) => restore(&win, &mut inner, p),
            None => Ok(false),
        };
        let result = match placed {
            Ok(true) => Ok(()),
            _ => dock(&win, &mut inner),
        };
        if let Err(e) = result {
            log::warn!("could not position panel: {e}");
        }
    }
    crate::spaces::configure(&win, crate::spaces::Kind::Panel);
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit_to(LABEL, "panel-collapsed", false);
}

pub fn hide(app: &AppHandle) {
    if let Some(win) = window(app) {
        let _ = win.hide();
    }
    state(app).flush();
}

pub fn toggle(app: &AppHandle) {
    match window(app).map(|w| w.is_visible().unwrap_or(false)) {
        Some(true) => hide(app),
        Some(false) => show(app),
        None => {}
    }
}

/// Minimize to a slim bar, or expand back, keeping the top edge in place.
pub fn set_collapsed(app: &AppHandle, collapsed: bool) -> tauri::Result<()> {
    let Some(win) = window(app) else {
        return Ok(());
    };
    let st = state(app);
    let Ok(mut inner) = st.inner.lock() else {
        return Ok(());
    };
    if inner.collapsed == collapsed {
        return Ok(());
    }
    let scale = win.scale_factor()?;
    let pos = win.outer_position()?;
    let size = win.outer_size()?;
    let height = if collapsed {
        inner.expanded_height = Some(size.height);
        (COLLAPSED_HEIGHT * scale).round() as u32
    } else {
        inner
            .expanded_height
            .take()
            .unwrap_or((MIN_HEIGHT * scale) as u32)
    };
    inner.collapsed = collapsed;
    apply(&win, &mut inner, pos.x, pos.y, size.width, height)?;
    drop(inner);
    let _ = app.emit_to(LABEL, "panel-collapsed", collapsed);
    Ok(())
}

/// Forget the user's spot and dock to the right edge again.
pub fn snap_to_edge(app: &AppHandle) {
    let st = state(app);
    if let Ok(mut inner) = st.inner.lock() {
        inner.placement = None;
        st.save(&mut inner);
    }
    show(app);
}

/// Window-moved hook: remember positions the user dragged to.
pub fn on_moved(app: &AppHandle, pos: PhysicalPosition<i32>) {
    let Some(win) = window(app) else { return };
    let st = state(app);
    let Ok(mut inner) = st.inner.lock() else {
        return;
    };
    if inner
        .self_moved_at
        .is_some_and(|t| t.elapsed() < SELF_MOVE_GRACE)
    {
        return;
    }
    let height = match inner.expanded_height {
        Some(h) if inner.collapsed => h,
        _ => win.outer_size().map(|s| s.height).unwrap_or(0),
    };
    inner.placement = Some(Placement {
        x: pos.x,
        y: pos.y,
        height,
    });
    inner.dirty = true;
    // Save at most a few times a second while dragging; hide/quit flush.
    let due = match inner.last_save {
        Some(t) => t.elapsed() > Duration::from_millis(500),
        None => true,
    };
    if due {
        st.save(&mut inner);
    }
}
