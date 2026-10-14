//! Clipboard fallback for selections the accessibility APIs can't read.
//!
//! The sequence is: snapshot the clipboard → synthesize Copy → wait for the
//! clipboard's change counter to move → read the text → restore the snapshot,
//! but only if the counter proves nobody else wrote to the clipboard in the
//! meantime. If the user (or another app) copied something during the window,
//! their value wins and nothing is restored.
//!
//! Platform code supplies a [`ClipboardAccess`] (NSPasteboard `changeCount`
//! on macOS, `GetClipboardSequenceNumber` on Windows).

use std::time::{Duration, Instant};

/// Minimal clipboard surface. Only plain text is snapshotted in the MVP; see
/// [`Snapshot::Unsupported`] for how richer contents are protected.
pub trait ClipboardAccess {
    /// Monotonic counter that changes whenever any app writes the clipboard.
    fn change_count(&self) -> u64;
    /// Current contents, classified.
    fn snapshot(&self) -> Snapshot;
    fn read_text(&self) -> Option<String>;
    fn write_text(&self, text: &str);
    fn clear(&self);
    /// Post the platform Copy shortcut to the frontmost app.
    fn send_copy(&self);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Snapshot {
    Empty,
    Text(String),
    /// Images, files, rich text… We can't round-trip these faithfully yet, so
    /// the fallback refuses to run rather than destroy them.
    Unsupported,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FallbackOutcome {
    /// Captured text; `restored` says whether the old clipboard was put back.
    Captured { text: String, restored: bool },
    /// The app never put anything on the clipboard (no selection, secure
    /// field, or the copy was blocked).
    NothingCopied,
    /// The clipboard holds non-text data we would clobber.
    Refused,
}

pub fn capture_via_clipboard<C: ClipboardAccess>(clip: &C, timeout: Duration) -> FallbackOutcome {
    let before = clip.snapshot();
    if before == Snapshot::Unsupported {
        return FallbackOutcome::Refused;
    }
    let start_count = clip.change_count();
    clip.send_copy();

    let deadline = Instant::now() + timeout;
    let copied_count = loop {
        let c = clip.change_count();
        if c != start_count {
            break Some(c);
        }
        if Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let Some(copied_count) = copied_count else {
        return FallbackOutcome::NothingCopied;
    };

    let text = clip
        .read_text()
        .map(|t| t.trim().to_string())
        .unwrap_or_default();

    // Restore only if the clipboard still holds *our* temporary value.
    let restored = if clip.change_count() == copied_count {
        match &before {
            Snapshot::Text(t) => clip.write_text(t),
            Snapshot::Empty => clip.clear(),
            Snapshot::Unsupported => unreachable!(),
        }
        true
    } else {
        false
    };

    if text.is_empty() {
        FallbackOutcome::NothingCopied
    } else {
        FallbackOutcome::Captured { text, restored }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct Fake {
        count: Cell<u64>,
        content: RefCell<Snapshot>,
        on_copy: Option<&'static str>,
        /// Simulate another app writing right after our copy.
        intruder: Option<&'static str>,
    }

    impl Fake {
        fn new(content: Snapshot, on_copy: Option<&'static str>) -> Self {
            Self {
                count: Cell::new(1),
                content: RefCell::new(content),
                on_copy,
                intruder: None,
            }
        }
        fn set(&self, s: Snapshot) {
            *self.content.borrow_mut() = s;
            self.count.set(self.count.get() + 1);
        }
    }

    impl ClipboardAccess for Fake {
        fn change_count(&self) -> u64 {
            self.count.get()
        }
        fn snapshot(&self) -> Snapshot {
            self.content.borrow().clone()
        }
        fn read_text(&self) -> Option<String> {
            let text = match &*self.content.borrow() {
                Snapshot::Text(t) => Some(t.clone()),
                _ => None,
            };
            // Another app writes just after we read our temporary value.
            if let Some(t) = self.intruder {
                self.set(Snapshot::Text(t.into()))
            }
            text
        }
        fn write_text(&self, t: &str) {
            self.set(Snapshot::Text(t.into()))
        }
        fn clear(&self) {
            self.set(Snapshot::Empty)
        }
        fn send_copy(&self) {
            if let Some(t) = self.on_copy {
                self.set(Snapshot::Text(t.into()))
            }
        }
    }

    const T: Duration = Duration::from_millis(30);

    #[test]
    fn captures_and_restores_previous_text() {
        let c = Fake::new(Snapshot::Text("old".into()), Some(" selected "));
        assert_eq!(
            capture_via_clipboard(&c, T),
            FallbackOutcome::Captured {
                text: "selected".into(),
                restored: true
            }
        );
        assert_eq!(c.snapshot(), Snapshot::Text("old".into()));
    }

    #[test]
    fn restores_empty_clipboard() {
        let c = Fake::new(Snapshot::Empty, Some("sel"));
        capture_via_clipboard(&c, T);
        assert_eq!(c.snapshot(), Snapshot::Empty);
    }

    #[test]
    fn does_not_clobber_a_newer_copy() {
        let mut c = Fake::new(Snapshot::Text("old".into()), Some("sel"));
        c.intruder = Some("user copied this");
        let out = capture_via_clipboard(&c, T);
        assert_eq!(
            out,
            FallbackOutcome::Captured {
                text: "sel".into(),
                restored: false
            }
        );
        assert_eq!(c.snapshot(), Snapshot::Text("user copied this".into()));
    }

    #[test]
    fn reports_nothing_copied_on_timeout() {
        let c = Fake::new(Snapshot::Text("old".into()), None);
        assert_eq!(capture_via_clipboard(&c, T), FallbackOutcome::NothingCopied);
        assert_eq!(c.snapshot(), Snapshot::Text("old".into()));
    }

    #[test]
    fn refuses_when_clipboard_has_rich_content() {
        let c = Fake::new(Snapshot::Unsupported, Some("sel"));
        assert_eq!(capture_via_clipboard(&c, T), FallbackOutcome::Refused);
        assert_eq!(c.count.get(), 1, "copy must not be sent");
    }
}
