//! The real clipboard behind `todocity_core::clipboard_guard::ClipboardAccess`.

#[cfg(target_os = "macos")]
pub use mac::SystemClipboard;
#[cfg(not(target_os = "macos"))]
pub use other::SystemClipboard;

/// macOS: NSPasteboard, accessed only on the main thread. AppKit objects are
/// not thread-safe, and the panel's WebKit view reads the pasteboard on the
/// main thread too, so touching it from a worker can crash the app.
#[cfg(target_os = "macos")]
mod mac {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{
        NSPasteboard, NSPasteboardItem, NSPasteboardTypeString, NSPasteboardWriting,
    };
    use objc2_foundation::{NSArray, NSData, NSString};
    use tauri::AppHandle;
    use todocity_core::clipboard_guard::ClipboardAccess;

    use crate::capture::{macos, on_main};

    /// Larger clipboards (big images, file promises) aren't snapshotted; the
    /// fallback then leaves the clipboard alone instead of risking it.
    const MAX_SAVE_BYTES: usize = 64 * 1024 * 1024;

    /// One pasteboard item: (type identifier, bytes) for each representation.
    pub type SavedItem = Vec<(String, Vec<u8>)>;

    pub struct SystemClipboard {
        app: AppHandle,
    }

    impl SystemClipboard {
        pub fn new(app: &AppHandle) -> Result<Self, String> {
            Ok(Self { app: app.clone() })
        }
    }

    fn save_now() -> Option<Vec<SavedItem>> {
        let pb = NSPasteboard::generalPasteboard();
        let Some(items) = pb.pasteboardItems() else {
            return Some(Vec::new());
        };
        let mut total = 0usize;
        let mut saved = Vec::new();
        for item in items.to_vec() {
            let mut reps = Vec::new();
            for ty in item.types().to_vec() {
                if let Some(data) = item.dataForType(&ty) {
                    total += data.len();
                    if total > MAX_SAVE_BYTES {
                        log::info!("clipboard too large to snapshot ({total} bytes)");
                        return None;
                    }
                    reps.push((ty.to_string(), data.to_vec()));
                }
            }
            saved.push(reps);
        }
        Some(saved)
    }

    fn restore_now(saved: Vec<SavedItem>) -> bool {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        if saved.is_empty() {
            return true;
        }
        let items: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = saved
            .into_iter()
            .map(|reps| {
                let item = NSPasteboardItem::new();
                for (ty, bytes) in reps {
                    let ty = NSString::from_str(&ty);
                    let data = NSData::with_bytes(&bytes);
                    item.setData_forType(&data, &ty);
                }
                ProtocolObject::from_retained(item)
            })
            .collect();
        pb.writeObjects(&NSArray::from_retained_slice(&items))
    }

    #[allow(unused_unsafe)]
    fn text_now() -> Option<String> {
        let pb = NSPasteboard::generalPasteboard();
        let ty = unsafe { NSPasteboardTypeString };
        pb.stringForType(ty).map(|s| s.to_string())
    }

    impl ClipboardAccess for SystemClipboard {
        type Saved = Vec<SavedItem>;

        fn change_count(&self) -> Option<u64> {
            on_main(&self.app, || {
                NSPasteboard::generalPasteboard().changeCount() as u64
            })
        }

        fn save(&self) -> Option<Self::Saved> {
            on_main(&self.app, save_now).flatten()
        }

        fn restore(&self, saved: Self::Saved) -> bool {
            on_main(&self.app, move || restore_now(saved)).unwrap_or(false)
        }

        fn read_text(&self) -> Option<String> {
            on_main(&self.app, text_now).flatten()
        }

        fn send_copy(&self) -> Result<(), String> {
            macos::trigger_copy()
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::capture::SYSTEM_CLIPBOARD_TEST_LOCK as PASTEBOARD;

        fn write_items(items: &[&[(&str, &[u8])]]) {
            let pb = NSPasteboard::generalPasteboard();
            pb.clearContents();
            let objs: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = items
                .iter()
                .map(|reps| {
                    let item = NSPasteboardItem::new();
                    for (ty, bytes) in reps.iter() {
                        item.setData_forType(&NSData::with_bytes(bytes), &NSString::from_str(ty));
                    }
                    ProtocolObject::from_retained(item)
                })
                .collect();
            assert!(pb.writeObjects(&NSArray::from_retained_slice(&objs)));
        }

        /// Runs against the real pasteboard on the macOS CI runner.
        #[test]
        fn snapshot_round_trip_keeps_every_type_and_item() {
            let _guard = PASTEBOARD.lock().unwrap_or_else(|e| e.into_inner());
            let first: &[(&str, &[u8])] = &[
                ("public.utf8-plain-text", &b"hello todocity"[..]),
                ("public.html", &b"<b>hello</b> todocity"[..]),
                ("com.example.todocity-test", &[0u8, 1, 2, 255][..]),
            ];
            let second: &[(&str, &[u8])] = &[("public.utf8-plain-text", &b"second item"[..])];
            write_items(&[first, second]);
            let saved = save_now().expect("snapshot");
            assert_eq!(saved.len(), 2);

            let temp: &[(&str, &[u8])] = &[("public.utf8-plain-text", &b"temporary"[..])];
            write_items(&[temp]);
            assert_eq!(text_now().as_deref(), Some("temporary"));

            assert!(restore_now(saved));
            // macOS joins the text of multiple pasteboard items with newlines.
            assert_eq!(text_now().as_deref(), Some("hello todocity\nsecond item"));
            let again = save_now().expect("snapshot after restore");
            assert_eq!(again.len(), 2);
            assert!(again[0]
                .iter()
                .any(|(t, b)| t == "com.example.todocity-test" && b == &[0, 1, 2, 255]));
            assert!(again[0].iter().any(|(t, _)| t == "public.html"));
        }

        #[test]
        fn empty_pasteboard_round_trips() {
            let _guard = PASTEBOARD.lock().unwrap_or_else(|e| e.into_inner());
            NSPasteboard::generalPasteboard().clearContents();
            let saved = save_now().expect("snapshot");
            assert!(saved.is_empty());
            let x: &[(&str, &[u8])] = &[("public.utf8-plain-text", &b"x"[..])];
            write_items(&[x]);
            assert!(restore_now(saved));
            assert_eq!(text_now(), None);
        }
    }
}

/// Windows and Linux: arboard for the clipboard, enigo for the keystroke.
/// Only plain text is snapshotted; a clipboard holding only an image is left
/// alone.
#[cfg(not(target_os = "macos"))]
mod other {
    use std::sync::Mutex;

    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    use tauri::AppHandle;
    use todocity_core::clipboard_guard::ClipboardAccess;

    pub struct SystemClipboard {
        inner: Mutex<arboard::Clipboard>,
    }

    impl SystemClipboard {
        pub fn new(_app: &AppHandle) -> Result<Self, String> {
            let cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            Ok(Self {
                inner: Mutex::new(cb),
            })
        }

        fn with<T>(&self, f: impl FnOnce(&mut arboard::Clipboard) -> T) -> Option<T> {
            self.inner.lock().ok().map(|mut cb| f(&mut cb))
        }
    }

    #[cfg(windows)]
    fn platform_change_count(_: &SystemClipboard) -> Option<u64> {
        Some(unsafe {
            windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() as u64
        })
    }

    /// No portable change counter on Linux; hash the text as a best effort.
    #[cfg(not(windows))]
    fn platform_change_count(c: &SystemClipboard) -> Option<u64> {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        c.read_text().hash(&mut h);
        Some(h.finish())
    }

    impl ClipboardAccess for SystemClipboard {
        /// The previous text, or None for an empty clipboard.
        type Saved = Option<String>;

        fn change_count(&self) -> Option<u64> {
            platform_change_count(self)
        }

        fn save(&self) -> Option<Self::Saved> {
            self.with(|cb| match cb.get_text() {
                Ok(t) => Some(Some(t)),
                Err(_) if cb.get_image().is_ok() => None,
                Err(_) => Some(None),
            })
            .flatten()
        }

        fn restore(&self, saved: Self::Saved) -> bool {
            self.with(|cb| match saved {
                Some(t) => cb.set_text(t).is_ok(),
                None => cb.clear().is_ok(),
            })
            .unwrap_or(false)
        }

        fn read_text(&self) -> Option<String> {
            self.with(|cb| cb.get_text().ok()).flatten()
        }

        fn send_copy(&self) -> Result<(), String> {
            let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
            let modifier = Key::Control;
            let result = enigo
                .key(modifier, Direction::Press)
                .and_then(|_| enigo.key(Key::Unicode('c'), Direction::Click));
            // Always release the modifier, even if the click failed.
            let _ = enigo.key(modifier, Direction::Release);
            result.map_err(|e| e.to_string())
        }
    }
}
