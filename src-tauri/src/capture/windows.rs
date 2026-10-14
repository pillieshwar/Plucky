//! Windows UI Automation selection reading (TextPattern).
//!
//! Elevated (admin) windows are isolated from non-elevated processes by UIPI,
//! so they fall through to the clipboard path, which will also fail there.

use uiautomation::patterns::UITextPattern;
use uiautomation::UIAutomation;

pub fn selected_text() -> Option<String> {
    let automation = UIAutomation::new().ok()?;
    let element = automation.get_focused_element().ok()?;
    let pattern: UITextPattern = element.get_pattern().ok()?;
    let ranges = pattern.get_selection().ok()?;
    let parts: Vec<String> = ranges.iter().filter_map(|r| r.get_text(-1).ok()).collect();
    let text = parts.join("\n");
    (!text.trim().is_empty()).then_some(text)
}
