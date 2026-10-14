//! System-wide selection capture.
//!
//! Fallback ladder, per the feasibility study:
//! 1. Accessibility API (macOS AX `AXSelectedText`, Windows UIA TextPattern).
//!    No side effects, so always tried first.
//! 2. Guarded clipboard: synthesize Copy, read, restore the user's clipboard
//!    only if nothing else wrote to it (see `pluck_core::clipboard_guard`).
//!
//! Secure fields are intentionally unreadable by both paths.

mod clipboard;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

use std::time::Duration;

use pluck_core::clipboard_guard::{capture_via_clipboard, FallbackOutcome};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CaptureResult {
    Text {
        text: String,
        method: CaptureMethod,
    },
    /// Nothing was selected, or the app doesn't expose its selection.
    NothingSelected,
    /// macOS: Accessibility permission has not been granted yet.
    PermissionNeeded,
    /// The clipboard holds images/files we'd destroy, so we didn't touch it.
    ClipboardBusy,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMethod {
    Accessibility,
    Clipboard,
}

/// How long to wait for the frontmost app to respond to a synthesized Copy.
const COPY_TIMEOUT: Duration = Duration::from_millis(400);

/// Blocking: call from a worker thread, never the UI thread.
pub fn capture_selection() -> CaptureResult {
    if !accessibility_trusted(false) {
        return CaptureResult::PermissionNeeded;
    }

    if let Some(text) = read_selection_via_accessibility() {
        let text = text.trim().to_string();
        if !text.is_empty() {
            return CaptureResult::Text {
                text,
                method: CaptureMethod::Accessibility,
            };
        }
    }

    // Give the user a moment to release the shortcut's modifier keys so the
    // synthesized Copy isn't merged with them (Cmd+Shift+C ≠ Cmd+C).
    std::thread::sleep(Duration::from_millis(150));

    let clip = match clipboard::SystemClipboard::new() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("clipboard unavailable: {e}");
            return CaptureResult::NothingSelected;
        }
    };
    match capture_via_clipboard(&clip, COPY_TIMEOUT) {
        FallbackOutcome::Captured { text, restored } => {
            log::debug!("clipboard capture ok, restored={restored}");
            CaptureResult::Text {
                text,
                method: CaptureMethod::Clipboard,
            }
        }
        FallbackOutcome::NothingCopied => CaptureResult::NothingSelected,
        FallbackOutcome::Refused => CaptureResult::ClipboardBusy,
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
