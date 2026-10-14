//! macOS Accessibility (AX) selection reading.

use std::ffi::c_void;
use std::ptr;

use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::string::{CFString, CFStringRef};

type AXUIElementRef = *const c_void;
type AXError = i32;
const AX_ERROR_SUCCESS: AXError = 0;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
}

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
    let attr = CFString::from_static_string(name);
    let mut value: CFTypeRef = ptr::null();
    let err = AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut value);
    if err != AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    Some(CFType::wrap_under_create_rule(value))
}

pub fn selected_text() -> Option<String> {
    unsafe {
        let system_ref = AXUIElementCreateSystemWide();
        if system_ref.is_null() {
            return None;
        }
        // Take ownership so it is released on drop.
        let system = CFType::wrap_under_create_rule(system_ref as CFTypeRef);
        let focused = copy_attr(
            system.as_CFTypeRef() as AXUIElementRef,
            "AXFocusedUIElement",
        )?;
        let selected = copy_attr(focused.as_CFTypeRef() as AXUIElementRef, "AXSelectedText")?;
        selected.downcast::<CFString>().map(|s| s.to_string())
    }
}
