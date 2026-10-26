//! The task panel: one undecorated, always-on-top window.
//!
//! * Until the user moves it, it docks to the right edge of the screen under
//!   the cursor each time it opens.
//! * Once dragged (by its header), it reopens where it was left — remembered
//!   across launches. "Snap to right edge" in the tray menu undoes that.
//! * It can be minimized to a slim bar, and expands again on the next
//!   capture, from the tray, or with its expand button.
//! * Full screen turns it into an ordinary app window that fills the
//!   screen (sidebar, task details, a week calendar), with a Dock icon while
//!   it lasts; leaving full screen docks it again.

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
/// Tallest logical height of the docked panel; on big screens it floats as
/// a card rather than running edge to edge.
const MAX_HEIGHT: f64 = 760.0;
/// Logical gaps kept between the docked panel and the usable screen area
/// (the screen minus the menu bar and the Dock or taskbar).
const GAP: (f64, f64) = (10.0, 14.0);
/// Smallest logical size of the full-screen window.
const MIN_FULL: (f64, f64) = (960.0, 600.0);
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
    /// Full screen: a normal, resizable window filling the screen.
    full: bool,
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

/// The part of a monitor windows can use: without the menu bar and the Dock
/// (or the taskbar), as (x, y, width, height) in physical pixels.
fn usable(m: &Monitor) -> (i32, i32, i32, i32) {
    let area = m.work_area();
    (
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
    )
}

/// Dock to the right edge of the monitor under the cursor, clear of the
/// menu bar and the Dock.
fn dock(win: &WebviewWindow, inner: &mut Inner) -> tauri::Result<()> {
    let Some(m) = monitor_under_cursor(win)? else {
        return Ok(());
    };
    let scale = m.scale_factor();
    let (top, bottom) = ((GAP.0 * scale) as i32, (GAP.1 * scale) as i32);
    let width = (WIDTH * scale).round() as i32;
    let margin = (10.0 * scale) as i32;
    let (x, y, w, h) = usable(&m);
    let height = (h - top - bottom)
        .min((MAX_HEIGHT * scale) as i32)
        .max((MIN_HEIGHT * scale) as i32);
    apply(
        win,
        inner,
        x + w - width - margin,
        y + top,
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
    let (ux, uy, uw, uh) = usable(&m);
    let width = (WIDTH * scale).round() as i32;
    let gap = (GAP.1 * scale) as i32;
    let min_h = (MIN_HEIGHT * scale) as i32;
    let max_h = (uh - gap).min((MAX_HEIGHT * scale) as i32);
    let height = (p.height as i32).clamp(min_h.min(max_h), max_h);
    let x = p.x.clamp(ux, ux + uw - width);
    let y = p.y.clamp(uy, (uy + uh - gap - height).max(uy));
    apply(win, inner, x, y, width as u32, height as u32)?;
    Ok(true)
}

/// Show the panel expanded, at the user's spot or docked.
pub fn show(app: &AppHandle) {
    let Some(win) = window(app) else { return };
    let st = state(app);
    let full = st.inner.lock().map(|i| i.full).unwrap_or(false);
    if full {
        crate::spaces::configure(&win, crate::spaces::Kind::Full);
        let _ = win.show();
        let _ = win.unminimize();
        crate::spaces::bring_to_front(&win);
        let _ = win.set_focus();
        return;
    }
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
    crate::spaces::bring_to_front(&win);
    let _ = win.set_focus();
    let _ = app.emit_to(LABEL, "panel-collapsed", false);
}

/// What opening Todo City shows: full screen (the default), or the side
/// panel if the person turned that off.
pub fn open_main_window(app: &AppHandle) {
    let open_full = app
        .try_state::<crate::settings::Settings>()
        .map(|s| s.get().open_full)
        .unwrap_or(true);
    if is_full(app) || !open_full {
        show(app);
    } else if let Err(e) = set_full(app, true) {
        log::warn!("could not open full screen: {e}");
        show(app);
    }
}

pub fn hide(app: &AppHandle) {
    // Hiding the full-screen window ends full screen (and its Dock icon);
    // Todo City opens as the side panel next time.
    if is_full(app) {
        if let Err(e) = switch_full(app, false) {
            log::warn!("could not leave full screen: {e}");
        }
    }
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
    if inner.collapsed == collapsed || inner.full {
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
    if inner.full
        || inner
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

/// Whether the panel is in full screen.
pub fn is_full(app: &AppHandle) -> bool {
    state(app).inner.lock().map(|i| i.full).unwrap_or(false)
}

/// Enter or leave full screen. Entering fills the usable part of the screen
/// the panel is on (clear of the menu bar and the Dock) with an ordinary,
/// resizable window; leaving puts the panel back where it was.
pub fn set_full(app: &AppHandle, full: bool) -> tauri::Result<()> {
    switch_full(app, full)?;
    show(app);
    Ok(())
}

/// Change the window between full screen and the side panel, without
/// showing it.
fn switch_full(app: &AppHandle, full: bool) -> tauri::Result<()> {
    let Some(win) = window(app) else {
        return Ok(());
    };
    {
        let st = state(app);
        let Ok(mut inner) = st.inner.lock() else {
            return Ok(());
        };
        if inner.full == full {
            return Ok(());
        }
        inner.full = full;
        inner.collapsed = false;
        inner.expanded_height = None;
        if full {
            let monitor = match win.current_monitor()? {
                Some(m) => Some(m),
                None => monitor_under_cursor(&win)?,
            };
            win.set_always_on_top(false)?;
            win.set_resizable(true)?;
            if let Some(m) = monitor {
                win.set_min_size(Some(tauri::LogicalSize::new(MIN_FULL.0, MIN_FULL.1)))?;
                let (x, y, w, h) = usable(&m);
                apply(&win, &mut inner, x, y, w as u32, h as u32)?;
            }
        } else {
            win.set_min_size(None::<tauri::LogicalSize<f64>>)?;
            win.set_resizable(false)?;
            win.set_always_on_top(true)?;
        }
    }
    #[cfg(target_os = "macos")]
    {
        // A Dock icon (and ⌘-Tab) while it's a full app window.
        let _ = app.set_activation_policy(if full {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        });
    }
    let _ = app.emit_to(LABEL, "panel-full", full);
    crate::tray::refresh(app);
    Ok(())
}
