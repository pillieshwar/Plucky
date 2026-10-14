//! System-wide selection capture.
//!
//! Fallback ladder:
//! 1. Accessibility API (macOS AX `AXSelectedText`, Windows UIA TextPattern).
//!    No side effects, so always tried first. Native apps answer here.
//! 2. Guarded clipboard: save the clipboard, trigger Copy in the frontmost
//!    app, read the text, put the clipboard back (see
//!    `pluck_core::clipboard_guard`). Chrome, Slack and other Electron or web
//!    apps usually need this path.
//!
//! Robustness rules, learned the hard way:
//! * On macOS, AppKit (NSPasteboard) runs on the main thread only — see
//!   [`on_main`]. Keyboard-layout (TIS/TSM) APIs are never used at all.
//! * Nothing in a capture may take the app down: every step returns an
//!   error instead of panicking, and the whole capture is wrapped in
//!   `catch_unwind` as a last line of defence.
//! * One capture at a time; a second shortcut press while one is running is
//!   ignored rather than racing on the clipboard.

mod clipboard;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use pluck_core::clipboard_guard::{capture_via_clipboard, FallbackOutcome};
use serde::Serialize;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CaptureResult {
    Text {
        text: String,
        method: CaptureMethod,
    },
    /// Nothing was selected, or the app doesn't allow copying it.
    NothingSelected,
    /// macOS: Accessibility permission has not been granted yet.
    PermissionNeeded,
    /// The clipboard holds something too large to save and restore safely.
    ClipboardBusy,
    /// Something went wrong; the message says what.
    Failed {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMethod {
    Accessibility,
    Clipboard,
}

/// How long to wait for the frontmost app to put its selection on the
/// clipboard. Electron apps (Slack) can take several hundred milliseconds.
const COPY_TIMEOUT: Duration = Duration::from_millis(1200);
/// How long to wait for a main-thread clipboard call.
#[cfg(target_os = "macos")]
const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(3);

static CAPTURING: AtomicBool = AtomicBool::new(false);

/// Tests that touch the real system clipboard or post key events run one at
/// a time.
#[cfg(all(test, target_os = "macos"))]
pub(crate) static SYSTEM_CLIPBOARD_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Run `f` on the main thread and wait for its result. Returns None if the
/// main thread is unavailable, too slow, or `f` panicked. Never call this
/// from the main thread itself. (Only macOS needs this.)
#[cfg(target_os = "macos")]
pub(crate) fn on_main<T, F>(app: &AppHandle, f: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let scheduled = app.run_on_main_thread(move || match catch_unwind(AssertUnwindSafe(f)) {
        Ok(value) => {
            let _ = tx.send(value);
        }
        Err(_) => log::error!("a main-thread clipboard call panicked"),
    });
    if let Err(e) = scheduled {
        log::error!("could not reach the main thread: {e}");
        return None;
    }
    match rx.recv_timeout(MAIN_THREAD_TIMEOUT) {
        Ok(v) => Some(v),
        Err(e) => {
            log::error!("main-thread clipboard call did not finish: {e}");
            None
        }
    }
}

/// Capture the current selection. Blocking: call from a worker thread.
/// Returns None if another capture is already running.
pub fn capture_selection(app: &AppHandle) -> Option<CaptureResult> {
    if CAPTURING.swap(true, Ordering::SeqCst) {
        log::info!("capture already in progress; ignoring shortcut");
        return None;
    }
    let result = catch_unwind(AssertUnwindSafe(|| capture_inner(app))).unwrap_or_else(|_| {
        log::error!("capture panicked");
        CaptureResult::Failed {
            message: "Something went wrong reading the selection. Please try again.".into(),
        }
    });
    CAPTURING.store(false, Ordering::SeqCst);
    Some(result)
}

fn capture_inner(app: &AppHandle) -> CaptureResult {
    if !accessibility_trusted(false) {
        return CaptureResult::PermissionNeeded;
    }

    if let Some(text) = read_selection_via_accessibility() {
        let text = text.trim().to_string();
        if !text.is_empty() {
            log::info!("captured {} chars via accessibility", text.chars().count());
            return CaptureResult::Text {
                text,
                method: CaptureMethod::Accessibility,
            };
        }
    }

    // Give the user a moment to let go of the shortcut keys.
    std::thread::sleep(Duration::from_millis(120));

    let clip = match clipboard::SystemClipboard::new(app) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("clipboard unavailable: {e}");
            return CaptureResult::Failed {
                message: format!("Pluck couldn't open the clipboard ({e})."),
            };
        }
    };
    match capture_via_clipboard(&clip, COPY_TIMEOUT) {
        FallbackOutcome::Captured { text, restored } => {
            log::info!(
                "captured {} chars via clipboard (restored: {restored})",
                text.chars().count()
            );
            CaptureResult::Text {
                text,
                method: CaptureMethod::Clipboard,
            }
        }
        FallbackOutcome::NothingCopied => {
            log::info!("nothing was copied");
            CaptureResult::NothingSelected
        }
        FallbackOutcome::Refused => CaptureResult::ClipboardBusy,
        FallbackOutcome::Failed(e) => {
            log::warn!("clipboard capture failed: {e}");
            CaptureResult::Failed {
                message: format!("Pluck couldn't copy the selection ({e})."),
            }
        }
    }
}

/// Whether the app may read other apps' UI. Only macOS gates this; with
/// `prompt` the system shows its "grant access" dialog.
pub fn accessibility_trusted(prompt: bool) -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::is_trusted(prompt)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = prompt;
        true
    }
}

fn read_selection_via_accessibility() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        macos::selected_text()
    }
    #[cfg(windows)]
    {
        windows::selected_text()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        None
    }
}
