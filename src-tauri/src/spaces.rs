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
    /// The side panel: on every Space while it's open, floating.
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

/// Apply now when called on the main thread (tray clicks, shortcuts), else
/// queue it there.
pub fn configure(win: &WebviewWindow, kind: Kind) {
    #[cfg(target_os = "macos")]
    {
        if objc2::MainThreadMarker::new().is_some() {
            macos::apply(win, kind);
        } else {
            let w = win.clone();
            let _ = win.run_on_main_thread(move || macos::apply(&w, kind));
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (win, kind);
}

/// Put a just-shown window in front even over a full-screen app, whether or
/// not macOS finished activating Pluck.
pub fn bring_to_front(win: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let w = win.clone();
        let run = move || macos::order_front(&w);
        if objc2::MainThreadMarker::new().is_some() {
            run();
        } else {
            let _ = win.run_on_main_thread(run);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = win;
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

    /// SAFETY of the cast: Tauri hands out the window's live NSWindow, and
    /// callers only run this on the main thread.
    fn ns_window(win: &WebviewWindow) -> Option<&NSWindow> {
        let ptr = win.ns_window().ok()?;
        (!ptr.is_null()).then(|| unsafe { &*(ptr as *const NSWindow) })
    }

    pub fn order_front(win: &WebviewWindow) {
        if let Some(ns) = ns_window(win) {
            unsafe { ns.orderFrontRegardless() };
        }
    }

    pub fn apply(win: &WebviewWindow, kind: Kind) {
        let Some(ns) = ns_window(win) else {
            return;
        };
        // Every window joins all Spaces: if one sat on the desktop Space,
        // activating Pluck from a full-screen app would make macOS jump
        // back to the desktop instead of showing the popover.
        let (behavior, level) = match kind {
            Kind::Panel => (
                NSWindowCollectionBehavior::CanJoinAllSpaces
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
