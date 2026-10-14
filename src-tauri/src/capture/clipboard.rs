//! Real clipboard behind `pluck_core::clipboard_guard::ClipboardAccess`.

use std::cell::RefCell;

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use pluck_core::clipboard_guard::{ClipboardAccess, Snapshot};

pub struct SystemClipboard {
    inner: RefCell<arboard::Clipboard>,
}

impl SystemClipboard {
    pub fn new() -> Result<Self, arboard::Error> {
        Ok(Self {
            inner: RefCell::new(arboard::Clipboard::new()?),
        })
    }
}

impl ClipboardAccess for SystemClipboard {
    fn change_count(&self) -> u64 {
        platform_change_count(self)
    }

    fn snapshot(&self) -> Snapshot {
        let mut cb = self.inner.borrow_mut();
        // Note: rich text that also carries a plain-text flavor is restored as
        // plain text only. Images and files are never touched.
        if let Ok(t) = cb.get_text() {
            return Snapshot::Text(t);
        }
        if cb.get_image().is_ok() {
            return Snapshot::Unsupported;
        }
        Snapshot::Empty
    }

    fn read_text(&self) -> Option<String> {
        self.inner.borrow_mut().get_text().ok()
    }

    fn write_text(&self, text: &str) {
        if let Err(e) = self.inner.borrow_mut().set_text(text) {
            log::warn!("failed to restore clipboard: {e}");
        }
    }

    fn clear(&self) {
        let _ = self.inner.borrow_mut().clear();
    }

    fn send_copy(&self) {
        let modifier = if cfg!(target_os = "macos") {
            Key::Meta
        } else {
            Key::Control
        };
        let mut enigo = match Enigo::new(&Settings::default()) {
            Ok(e) => e,
            Err(err) => {
                log::warn!("could not create input synthesizer: {err}");
                return;
            }
        };
        let result = enigo
            .key(modifier, Direction::Press)
            .and_then(|_| enigo.key(Key::Unicode('c'), Direction::Click));
        // Always release the modifier, even if the click failed.
        let _ = enigo.key(modifier, Direction::Release);
        if let Err(err) = result {
            log::warn!("could not synthesize copy: {err}");
        }
    }
}

#[cfg(target_os = "macos")]
#[allow(unused_unsafe)]
fn platform_change_count(_: &SystemClipboard) -> u64 {
    use objc2_app_kit::NSPasteboard;
    let n = unsafe { NSPasteboard::generalPasteboard().changeCount() };
    n as u64
}

#[cfg(windows)]
fn platform_change_count(_: &SystemClipboard) -> u64 {
    unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() as u64 }
}

/// Linux has no portable change counter; hash the text as a best effort.
/// (Linux is a development target only.)
#[cfg(not(any(target_os = "macos", windows)))]
fn platform_change_count(c: &SystemClipboard) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    c.read_text().hash(&mut h);
    h.finish()
}
