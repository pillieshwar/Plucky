//! Keeping Pluck's windows reachable over full-screen apps (macOS).
//!
//! A full-screen app lives in its own Space, and by default other apps'
//! windows can't appear there — so showing the panel, the menu-bar popover
//! or quick add would either do nothing visible or yank the user back to
//! the desktop. Marking the windows as *full-screen auxiliary* lets them
//! open on top of the full-screen app, in the Space the user is in.

use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Clone, Copy)]
pub enum Kind {
    /// The side panel: follows the user to whichever Space is active.
    Panel,
    /// Popover and quick add: on every Space, above full-screen windows.
    Overlay,
}

/// Apply the right Space behaviour to every Pluck window. Call during
/// setup (main thread) and again before showing a window.
pub fn configure_all(app: &AppHandle) {
    for (label, kind) in [
        ("panel", Kind::Panel),
        (crate::popover::LABEL, Kind::Overlay),
        (crate::quick::LABEL, Kind::Overlay),
    ] {
        if let Some(win) = app.get_webview_window(label) {
            configure(&win, kind);
        }
    }
}

/// Re-apply on the main thread (safe to call from any thread).
pub fn configure(win: &WebviewWindow, kind: Kind) {
    #[cfg(target_os = "macos")]
    {
        let w = win.clone();
        let _ = win.run_on_main_thread(move || macos::apply(&w, kind));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (win, kind);
}

#[cfg(target_os = "macos")]
mod macos {
    #![allow(unused_unsafe)]

    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    use tauri::WebviewWindow;

    use super::Kind;

    /// NSFloatingWindowLevel and NSPopUpMenuWindowLevel.
    const FLOATING: isize = 3;
    const POP_UP_MENU: isize = 101;

    pub fn apply(win: &WebviewWindow, kind: Kind) {
        let Ok(ptr) = win.ns_window() else {
            return;
        };
        if ptr.is_null() {
            return;
        }
        // SAFETY: Tauri hands out the window's live NSWindow, and this runs
        // on the main thread (see `configure`).
        let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        let (behavior, level) = match kind {
            Kind::Panel => (
                NSWindowCollectionBehavior::MoveToActiveSpace
                    | NSWindowCollectionBehavior::FullScreenAuxiliary,
                FLOATING,
            ),
            Kind::Overlay => (
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::FullScreenAuxiliary
                    | NSWindowCollectionBehavior::IgnoresCycle,
                POP_UP_MENU,
            ),
        };
        unsafe {
            ns.setCollectionBehavior(behavior);
            ns.setLevel(level);
            ns.setHidesOnDeactivate(false);
        }
    }
}
