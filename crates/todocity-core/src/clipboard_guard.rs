//! Clipboard fallback for selections the accessibility APIs can't read
//! (Chrome, Slack and other Electron apps, many web views).
//!
//! The sequence is: save everything on the clipboard → ask the frontmost app
//! to Copy → wait for the clipboard's change counter to move and settle →
//! read the text → put the saved clipboard back, but only if the counter
//! proves nobody else wrote to it in the meantime. If the user (or another
//! app) copied something during the window, their value wins.
//!
//! Every platform step can fail without panicking; failures come back as a
//! [`FallbackOutcome`] the UI can explain.

use std::time::{Duration, Instant};

/// The platform clipboard. Implementations must never panic.
pub trait ClipboardAccess {
    /// Everything needed to put the clipboard back as it was.
    type Saved;

    /// Counter that changes whenever any app writes the clipboard.
    fn change_count(&self) -> Option<u64>;
    /// Snapshot the clipboard. `None` means it can't be saved safely (too
    /// large, or unreadable), so the fallback must not touch it.
    fn save(&self) -> Option<Self::Saved>;
    /// Put a snapshot back.
    fn restore(&self, saved: Self::Saved) -> bool;
    /// The clipboard's plain text, if any.
    fn read_text(&self) -> Option<String>;
    /// Ask the frontmost app to copy its selection.
    fn send_copy(&self) -> Result<(), String>;
}

#[derive(Debug, PartialEq, Eq)]
pub enum FallbackOutcome {
    /// Captured text; `restored` says whether the old clipboard was put back.
    Captured { text: String, restored: bool },
    /// The app never put text on the clipboard (no selection, a secure field,
    /// or the app blocks copying).
    NothingCopied,
    /// The clipboard couldn't be saved, so we didn't risk overwriting it.
    Refused,
    /// Copy couldn't be triggered or the clipboard couldn't be read.
    Failed(String),
}

/// How long the clipboard must stay unchanged before we read it; apps such
/// as Chrome write several formats one after another.
const SETTLE: Duration = Duration::from_millis(40);
const POLL: Duration = Duration::from_millis(10);

pub fn capture_via_clipboard<C: ClipboardAccess>(clip: &C, timeout: Duration) -> FallbackOutcome {
    let Some(start_count) = clip.change_count() else {
        return FallbackOutcome::Failed("the clipboard isn't available".into());
    };
    let Some(saved) = clip.save() else {
        return FallbackOutcome::Refused;
    };
    if let Err(e) = clip.send_copy() {
        // Nothing was changed, so there's nothing to restore.
        return FallbackOutcome::Failed(e);
    }

    // Wait for the copy to land, then for the clipboard to settle.
    let deadline = Instant::now() + timeout;
    let mut last = start_count;
    let mut last_change: Option<Instant> = None;
    loop {
        let now = Instant::now();
        match clip.change_count() {
            Some(c) if c != last => {
                last = c;
                last_change = Some(now);
            }
            Some(_) => {}
            None => return FallbackOutcome::Failed("the clipboard stopped responding".into()),
        }
        if let Some(t) = last_change {
            if now.duration_since(t) >= SETTLE {
                break;
            }
        }
        if now >= deadline {
            break;
        }
        std::thread::sleep(POLL);
    }
    if last_change.is_none() {
        return FallbackOutcome::NothingCopied;
    }

    let text = clip
        .read_text()
        .map(|t| t.trim().to_string())
        .unwrap_or_default();

    // Restore only if the clipboard still holds *our* temporary value.
    let restored = clip.change_count() == Some(last) && clip.restore(saved);

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

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Content {
        Empty,
        Text(String),
        Image(Vec<u8>),
    }

    struct Fake {
        count: Cell<u64>,
        content: RefCell<Content>,
        /// What Copy puts on the clipboard; None = nothing selected.
        on_copy: Option<&'static str>,
        /// Copy writes in two steps (clear, then text), like Chrome.
        two_step: bool,
        /// Another app writes just after we read.
        intruder: Option<&'static str>,
        save_fails: bool,
        copy_fails: bool,
    }

    impl Fake {
        fn new(content: Content, on_copy: Option<&'static str>) -> Self {
            Self {
                count: Cell::new(1),
                content: RefCell::new(content),
                on_copy,
                two_step: false,
                intruder: None,
                save_fails: false,
                copy_fails: false,
            }
        }
        fn set(&self, c: Content) {
            *self.content.borrow_mut() = c;
            self.count.set(self.count.get() + 1);
        }
    }

    impl ClipboardAccess for Fake {
        type Saved = Content;
        fn change_count(&self) -> Option<u64> {
            Some(self.count.get())
        }
        fn save(&self) -> Option<Content> {
            (!self.save_fails).then(|| self.content.borrow().clone())
        }
        fn restore(&self, saved: Content) -> bool {
            self.set(saved);
            true
        }
        fn read_text(&self) -> Option<String> {
            let text = match &*self.content.borrow() {
                Content::Text(t) => Some(t.clone()),
                _ => None,
            };
            if let Some(t) = self.intruder {
                self.set(Content::Text(t.into()));
            }
            text
        }
        fn send_copy(&self) -> Result<(), String> {
            if self.copy_fails {
                return Err("no copy".into());
            }
            if let Some(t) = self.on_copy {
                if self.two_step {
                    self.set(Content::Empty);
                }
                self.set(Content::Text(t.into()));
            }
            Ok(())
        }
    }

    const T: Duration = Duration::from_millis(120);

    #[test]
    fn captures_and_restores_previous_text() {
        let c = Fake::new(Content::Text("old".into()), Some(" selected "));
        assert_eq!(
            capture_via_clipboard(&c, T),
            FallbackOutcome::Captured {
                text: "selected".into(),
                restored: true
            }
        );
        assert_eq!(*c.content.borrow(), Content::Text("old".into()));
    }

    #[test]
    fn restores_images_and_empty_clipboards() {
        let c = Fake::new(Content::Image(vec![1, 2, 3]), Some("sel"));
        assert!(matches!(
            capture_via_clipboard(&c, T),
            FallbackOutcome::Captured { restored: true, .. }
        ));
        assert_eq!(*c.content.borrow(), Content::Image(vec![1, 2, 3]));

        let c = Fake::new(Content::Empty, Some("sel"));
        capture_via_clipboard(&c, T);
        assert_eq!(*c.content.borrow(), Content::Empty);
    }

    #[test]
    fn waits_for_multi_step_writes() {
        let mut c = Fake::new(Content::Text("old".into()), Some("sel"));
        c.two_step = true;
        assert!(matches!(
            capture_via_clipboard(&c, T),
            FallbackOutcome::Captured { .. }
        ));
    }

    #[test]
    fn does_not_clobber_a_newer_copy() {
        let mut c = Fake::new(Content::Text("old".into()), Some("sel"));
        c.intruder = Some("user copied this");
        assert_eq!(
            capture_via_clipboard(&c, T),
            FallbackOutcome::Captured {
                text: "sel".into(),
                restored: false
            }
        );
        assert_eq!(
            *c.content.borrow(),
            Content::Text("user copied this".into())
        );
    }

    #[test]
    fn nothing_selected_times_out_cleanly() {
        let c = Fake::new(Content::Text("old".into()), None);
        assert_eq!(capture_via_clipboard(&c, T), FallbackOutcome::NothingCopied);
        assert_eq!(*c.content.borrow(), Content::Text("old".into()));
    }

    #[test]
    fn refuses_when_clipboard_cannot_be_saved() {
        let mut c = Fake::new(Content::Image(vec![9]), Some("sel"));
        c.save_fails = true;
        assert_eq!(capture_via_clipboard(&c, T), FallbackOutcome::Refused);
        assert_eq!(c.count.get(), 1, "copy must not be sent");
    }

    #[test]
    fn reports_copy_failures_without_touching_clipboard() {
        let mut c = Fake::new(Content::Text("old".into()), Some("sel"));
        c.copy_fails = true;
        assert_eq!(
            capture_via_clipboard(&c, T),
            FallbackOutcome::Failed("no copy".into())
        );
        assert_eq!(*c.content.borrow(), Content::Text("old".into()));
    }
}
