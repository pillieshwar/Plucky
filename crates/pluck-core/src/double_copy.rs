//! "Press ⌘C twice to capture": spot two copies of the same text in quick
//! succession by watching the clipboard's change count. The first ⌘C copies
//! as usual; the second, within a moment, sends that text to Plucky.
//!
//! Nothing is intercepted, so ⌘C keeps working everywhere.

use std::time::{Duration, Instant};

/// Longest text taken from a double copy, in characters.
pub const MAX_CHARS: usize = 20_000;

#[derive(Debug)]
pub struct DoubleCopy {
    window: Duration,
    last_count: Option<i64>,
    prev: Option<(Instant, String)>,
}

impl DoubleCopy {
    /// `window`: the most time allowed between the two copies.
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            last_count: None,
            prev: None,
        }
    }

    /// Forget what was seen (e.g. while Plucky itself uses the clipboard);
    /// the next look starts afresh.
    pub fn reset(&mut self) {
        self.last_count = None;
        self.prev = None;
    }

    /// Feed one look at the clipboard: its change count and its text, if
    /// any. Returns the text when this is the second copy of it in time.
    pub fn observe(&mut self, now: Instant, count: i64, text: Option<&str>) -> Option<String> {
        let last = self.last_count.replace(count)?;
        if last == count {
            return None;
        }
        let text = text.map(str::trim).filter(|t| !t.is_empty());
        let Some(text) = text else {
            self.prev = None;
            return None;
        };
        let again = self
            .prev
            .as_ref()
            .is_some_and(|(at, t)| now.duration_since(*at) <= self.window && t == text);
        if again {
            self.prev = None;
            return Some(text.chars().take(MAX_CHARS).collect());
        }
        self.prev = Some((now, text.to_string()));
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(base: Instant, n: u64) -> Instant {
        base + Duration::from_millis(n)
    }

    #[test]
    fn two_quick_copies_of_the_same_text() {
        let t0 = Instant::now();
        let mut d = DoubleCopy::new(Duration::from_millis(700));
        assert_eq!(d.observe(t0, 10, Some("old")), None); // first look: baseline
        assert_eq!(d.observe(ms(t0, 70), 10, Some("old")), None); // unchanged
        assert_eq!(
            d.observe(ms(t0, 140), 11, Some("Send the deck by Fri")),
            None
        );
        assert_eq!(
            d.observe(ms(t0, 420), 12, Some("Send the deck by Fri")),
            Some("Send the deck by Fri".into())
        );
        // A third copy starts over rather than firing again.
        assert_eq!(
            d.observe(ms(t0, 600), 13, Some("Send the deck by Fri")),
            None
        );
    }

    #[test]
    fn slow_or_different_copies_dont_count() {
        let t0 = Instant::now();
        let mut d = DoubleCopy::new(Duration::from_millis(700));
        d.observe(t0, 1, None);
        d.observe(ms(t0, 100), 2, Some("a"));
        assert_eq!(d.observe(ms(t0, 1000), 3, Some("a")), None); // too slow
        assert_eq!(d.observe(ms(t0, 1200), 4, Some("b")), None); // different text
        assert_eq!(d.observe(ms(t0, 1300), 5, None), None); // an image, say
        assert_eq!(d.observe(ms(t0, 1400), 6, Some("b")), None);
    }

    #[test]
    fn reset_ignores_changes_made_meanwhile() {
        let t0 = Instant::now();
        let mut d = DoubleCopy::new(Duration::from_millis(700));
        d.observe(t0, 1, None);
        d.observe(ms(t0, 100), 2, Some("x"));
        d.reset();
        // Plucky's own clipboard use bumped the count; that's a new baseline.
        assert_eq!(d.observe(ms(t0, 200), 4, Some("x")), None);
        assert_eq!(d.observe(ms(t0, 300), 5, Some("x")), None);
        assert_eq!(d.observe(ms(t0, 400), 6, Some("x")), Some("x".into()));
    }
}
