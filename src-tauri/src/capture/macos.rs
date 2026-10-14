//! macOS: reading the selection through Accessibility (AX), and triggering
//! Copy in the frontmost app.
//!
//! Everything here is safe to call from a background thread: AX client calls
//! and Quartz event posting are thread-safe. Nothing here touches the Text
//! Input Source (TIS/TSM) APIs, which macOS only allows on the main thread —
//! calling those from a worker thread is what crashed earlier builds.

use std::ffi::c_void;
use std::ptr;

use core_foundation::array::CFArray;
use core_foundation::base::{CFRelease, CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};

type AXUIElementRef = *const c_void;
type AXError = i32;
const AX_ERROR_SUCCESS: AXError = 0;
/// Seconds to wait for another app to answer an AX request. A hung app must
/// not hang Pluck (the default is 6 s).
const AX_TIMEOUT_SECS: f32 = 0.35;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout: f32) -> AXError;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceCreate(state_id: i32) -> *mut c_void;
    fn CGEventCreateKeyboardEvent(
        source: *mut c_void,
        virtual_key: u16,
        key_down: bool,
    ) -> *mut c_void;
    fn CGEventSetFlags(event: *mut c_void, flags: u64);
    fn CGEventPost(tap: u32, event: *mut c_void);
}

const EVENT_SOURCE_STATE_PRIVATE: i32 = -1;
const HID_EVENT_TAP: u32 = 0;
const EVENT_FLAG_COMMAND: u64 = 0x0010_0000;
/// kVK_ANSI_C — the key in the "C" position on a US layout.
const KEYCODE_C: u16 = 8;

pub fn is_trusted(prompt: bool) -> bool {
    let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
    let value = if prompt {
        CFBoolean::true_value()
    } else {
        CFBoolean::false_value()
    };
    let opts = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);
    unsafe { AXIsProcessTrustedWithOptions(opts.as_concrete_TypeRef()) }
}

/// Copy an AX attribute; the returned CFType owns the +1 reference.
unsafe fn copy_attr(element: AXUIElementRef, name: &'static str) -> Option<CFType> {
    if element.is_null() {
        return None;
    }
    let attr = CFString::from_static_string(name);
    let mut value: CFTypeRef = ptr::null();
    let err = AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut value);
    if err != AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    Some(CFType::wrap_under_create_rule(value))
}

fn as_element(t: &CFType) -> AXUIElementRef {
    t.as_CFTypeRef() as AXUIElementRef
}

/// The system-wide AX element, with a short messaging timeout.
fn system_element() -> Option<CFType> {
    unsafe {
        let raw = AXUIElementCreateSystemWide();
        if raw.is_null() {
            return None;
        }
        AXUIElementSetMessagingTimeout(raw, AX_TIMEOUT_SECS);
        Some(CFType::wrap_under_create_rule(raw as CFTypeRef))
    }
}

/// The frontmost app's AX element.
fn focused_app() -> Option<CFType> {
    let system = system_element()?;
    let app = unsafe { copy_attr(as_element(&system), "AXFocusedApplication")? };
    unsafe {
        AXUIElementSetMessagingTimeout(as_element(&app), AX_TIMEOUT_SECS);
    }
    Some(app)
}

/// The selected text in the focused element, if the app exposes it.
pub fn selected_text() -> Option<String> {
    let system = system_element()?;
    unsafe {
        let focused = copy_attr(as_element(&system), "AXFocusedUIElement")?;
        let selected = copy_attr(as_element(&focused), "AXSelectedText")?;
        selected.downcast::<CFString>().map(|s| s.to_string())
    }
}

fn children(element: AXUIElementRef) -> Vec<CFType> {
    let Some(value) = (unsafe { copy_attr(element, "AXChildren") }) else {
        return Vec::new();
    };
    let Some(array) = value.downcast::<CFArray>() else {
        return Vec::new();
    };
    array
        .get_all_values()
        .into_iter()
        .filter(|p| !p.is_null())
        // Retain each child so it outlives the array.
        .map(|p| unsafe { CFType::wrap_under_get_rule(p as CFTypeRef) })
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
enum MenuCopy {
    Pressed,
    Disabled,
    NotFound,
}

/// Find the frontmost app's Copy menu item — the one whose shortcut is ⌘C,
/// so this works in any language and keyboard layout — and press it.
fn press_copy_menu_item() -> MenuCopy {
    let Some(app) = focused_app() else {
        return MenuCopy::NotFound;
    };
    let Some(bar) = (unsafe { copy_attr(as_element(&app), "AXMenuBar") }) else {
        return MenuCopy::NotFound;
    };
    // Skip the Apple menu; Copy lives in Edit, usually the 3rd or 4th menu.
    for bar_item in children(as_element(&bar)).iter().skip(1).take(8) {
        for menu in children(as_element(bar_item)) {
            for item in children(as_element(&menu)) {
                let el = as_element(&item);
                let is_cmd_c = unsafe {
                    let char_ok = copy_attr(el, "AXMenuItemCmdChar")
                        .and_then(|v| v.downcast::<CFString>())
                        .is_some_and(|s| s.to_string().eq_ignore_ascii_case("c"));
                    // 0 = ⌘ only (no ⇧ ⌥ ⌃).
                    let mods_ok = copy_attr(el, "AXMenuItemCmdModifiers")
                        .and_then(|v| v.downcast::<CFNumber>())
                        .and_then(|n| n.to_i64())
                        == Some(0);
                    char_ok && mods_ok
                };
                if !is_cmd_c {
                    continue;
                }
                let enabled = unsafe { copy_attr(el, "AXEnabled") }
                    .and_then(|v| v.downcast::<CFBoolean>())
                    .map(bool::from)
                    .unwrap_or(true);
                if !enabled {
                    return MenuCopy::Disabled;
                }
                let press = CFString::from_static_string("AXPress");
                let err = unsafe { AXUIElementPerformAction(el, press.as_concrete_TypeRef()) };
                return if err == AX_ERROR_SUCCESS {
                    MenuCopy::Pressed
                } else {
                    MenuCopy::NotFound
                };
            }
        }
    }
    MenuCopy::NotFound
}

/// Post ⌘C as raw key events. The events carry their own modifier flags, so
/// keys the user is still holding from the shortcut (⇧, ⌥) don't leak in.
fn post_cmd_c() -> Result<(), String> {
    unsafe {
        let source = CGEventSourceCreate(EVENT_SOURCE_STATE_PRIVATE);
        let down = CGEventCreateKeyboardEvent(source, KEYCODE_C, true);
        let up = CGEventCreateKeyboardEvent(source, KEYCODE_C, false);
        let ok = !down.is_null() && !up.is_null();
        if ok {
            CGEventSetFlags(down, EVENT_FLAG_COMMAND);
            CGEventSetFlags(up, EVENT_FLAG_COMMAND);
            CGEventPost(HID_EVENT_TAP, down);
            std::thread::sleep(std::time::Duration::from_millis(8));
            CGEventPost(HID_EVENT_TAP, up);
        }
        for p in [down, up, source] {
            if !p.is_null() {
                CFRelease(p as CFTypeRef);
            }
        }
        if ok {
            Ok(())
        } else {
            Err("macOS refused to create a keyboard event".into())
        }
    }
}

/// Ask the frontmost app to copy its selection.
pub fn trigger_copy() -> Result<(), String> {
    match press_copy_menu_item() {
        MenuCopy::Pressed => {
            log::debug!("copy: pressed the app's Copy menu item");
            Ok(())
        }
        // Menus can report stale "disabled" state; the keystroke is cheap.
        other => {
            log::debug!("copy: menu item {other:?}, sending ⌘C");
            post_cmd_c()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The crash fixed in 0.1.4 happened when Copy was triggered from a
    /// worker thread. These calls must be safe there (CI has no
    /// Accessibility permission, so they exercise the failure paths).
    #[test]
    fn copy_and_ax_calls_are_safe_off_the_main_thread() {
        let handle = std::thread::spawn(|| {
            let _ = selected_text();
            let _ = press_copy_menu_item();
            let _ = is_trusted(false);
            post_cmd_c()
        });
        let posted = handle.join().expect("worker thread must not panic");
        assert!(posted.is_ok(), "{posted:?}");
    }
}
