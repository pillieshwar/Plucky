//! Keeping Plucky's windows reachable over full-screen apps (macOS).
//!
//! The menu-bar popover and quick add are turned into *non-activating
//! panels* — the kind of window Spotlight and other menu-bar dropdowns use.
//! An ordinary window has to activate Plucky to take the keyboard, and when
//! another app is full screen, activating a menu-bar app either shows
//! nothing or switches back to the desktop. A non-activating panel floats
//! over the full-screen app and takes typing while that app stays active.
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

/// Apply the right Space behaviour to every Plucky window, and turn the
/// popover and quick add into panels. Call once during setup (main thread).
pub fn configure_all(app: &AppHandle) {
    for (label, kind) in [
        ("panel", Kind::Panel),
        (crate::popover::LABEL, Kind::Overlay),
        (crate::quick::LABEL, Kind::Overlay),
    ] {
        if let Some(win) = app.get_webview_window(label) {
            #[cfg(target_os = "macos")]
            if matches!(kind, Kind::Overlay) {
                if objc2::MainThreadMarker::new().is_some() {
                    macos::make_panel(&win);
                } else {
                    let w = win.clone();
                    let _ = win.run_on_main_thread(move || macos::make_panel(&w));
                }
            }
            configure(&win, kind);
        }
    }
}

/// Show a panel in front, over full-screen apps too, without taking the
/// keyboard: for things Plucky brings up on its own (a task coming due), so
/// whatever the user is typing in keeps the keystrokes.
pub fn present_passive(win: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let w = win.clone();
        let run = move || {
            if !macos::show_panel_passive(&w) {
                let _ = w.show();
            }
        };
        if objc2::MainThreadMarker::new().is_some() {
            run();
        } else {
            let _ = win.run_on_main_thread(run);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = win.show();
    }
}

/// Show a window and give it the keyboard. Panels (popover, quick add) do
/// this without activating Plucky, so they open over full-screen apps;
/// other windows are shown and focused as usual.
pub fn present(win: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let w = win.clone();
        let run = move || {
            if !macos::present_panel(&w) {
                let _ = w.show();
                macos::order_front(&w);
                let _ = w.set_focus();
            }
        };
        if objc2::MainThreadMarker::new().is_some() {
            run();
        } else {
            let _ = win.run_on_main_thread(run);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = win.show();
        let _ = win.set_focus();
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
/// not macOS finished activating Plucky.
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

    use std::panic::AssertUnwindSafe;

    use objc2::runtime::{AnyObject, NSObjectProtocol};
    use objc2::{define_class, msg_send, sel, ClassType, MainThreadOnly};
    use objc2_app_kit::{
        NSPanel, NSResponder, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
    };
    use objc2_foundation::NSObject;
    use tauri::WebviewWindow;

    use super::Kind;

    define_class!(
        // SAFETY: no ivars and no Drop, so an existing NSWindow can be
        // re-classed to this NSPanel subclass (as tauri-nspanel does). It
        // only answers two questions differently from NSPanel.
        #[unsafe(super(NSPanel, NSWindow, NSResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "PluckyPanel"]
        struct PluckyPanel;

        unsafe impl NSObjectProtocol for PluckyPanel {}

        impl PluckyPanel {
            /// Take the keyboard (typing a task, arrow keys) even though
            /// Plucky isn't the active app.
            #[unsafe(method(canBecomeKeyWindow))]
            fn can_become_key_window(&self) -> bool {
                true
            }

            #[unsafe(method(canBecomeMainWindow))]
            fn can_become_main_window(&self) -> bool {
                false
            }
        }
    );

    fn is_panel(ns: &NSWindow) -> bool {
        unsafe { msg_send![ns, isKindOfClass: PluckyPanel::class()] }
    }

    /// Turn a Tauri window into a non-activating panel. Main thread only.
    pub fn make_panel(win: &WebviewWindow) {
        let Some(ns) = ns_window(win) else {
            return;
        };
        if is_panel(ns) {
            return;
        }
        // SAFETY: PluckyPanel adds no ivars, so the object's memory layout
        // is unchanged; NSPanel is an NSWindow subclass.
        unsafe {
            let obj: &AnyObject = &*(ns as *const NSWindow as *const AnyObject);
            let _ = AnyObject::set_class(obj, PluckyPanel::class());
        }
        let result = objc2::exception::catch(AssertUnwindSafe(|| unsafe {
            ns.setStyleMask(ns.styleMask() | NSWindowStyleMask::NonactivatingPanel);
            // Re-classing skips NSPanel's own setup, which is where AppKit
            // tells the window server not to activate the app for clicks in
            // this window. Do that part by hand where it exists.
            let prevent = sel!(_setPreventsActivation:);
            let responds: bool = msg_send![ns, respondsToSelector: prevent];
            if responds {
                let _: () = msg_send![ns, _setPreventsActivation: true];
            }
            let panel: &NSPanel = &*(ns as *const NSWindow as *const NSPanel);
            panel.setFloatingPanel(true);
            panel.setBecomesKeyOnlyIfNeeded(false);
            panel.setWorksWhenModal(true);
        }));
        match result {
            Ok(()) => log::info!("{} is now a non-activating panel", win.label()),
            Err(e) => log::warn!("could not make {} non-activating: {e:?}", win.label()),
        }
    }

    /// Bring a panel to the front without making it key. False for windows
    /// that aren't panels.
    pub fn show_panel_passive(win: &WebviewWindow) -> bool {
        let Some(ns) = ns_window(win) else {
            return false;
        };
        if !is_panel(ns) {
            return false;
        }
        unsafe { ns.orderFrontRegardless() };
        true
    }

    /// Show a panel and make it key without activating Plucky. Returns
    /// false for windows that aren't panels.
    pub fn present_panel(win: &WebviewWindow) -> bool {
        let Some(ns) = ns_window(win) else {
            return false;
        };
        if !is_panel(ns) {
            return false;
        }
        unsafe {
            ns.orderFrontRegardless();
            ns.makeKeyWindow();
        }
        true
    }

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
        // activating Plucky from a full-screen app would make macOS jump
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
