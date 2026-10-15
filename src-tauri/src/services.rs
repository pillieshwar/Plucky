//! macOS Services menu: select text in any app, then right-click →
//! Services → "Add to Pluck". The text arrives through the pasteboard macOS
//! hands us, so the user's clipboard is never touched.
//!
//! The menu item itself is declared in `Info.plist` (`NSServices`).

#![allow(unused_unsafe)]

use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol};
use objc2::MainThreadMarker;
use objc2::{define_class, msg_send, AnyThread};
use objc2_app_kit::{NSApplication, NSPasteboard, NSPasteboardTypeString};
use objc2_foundation::NSString;
use std::sync::OnceLock;

type Handler = Box<dyn Fn(String) + Send + Sync>;
static HANDLER: OnceLock<Handler> = OnceLock::new();

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this has no Drop.
    #[unsafe(super(NSObject))]
    #[name = "PluckServicesProvider"]
    struct Provider;

    unsafe impl NSObjectProtocol for Provider {}

    impl Provider {
        /// Matches `NSMessage = addToPluck` in Info.plist.
        #[unsafe(method(addToPluck:userData:error:))]
        fn add_to_pluck(
            &self,
            pboard: &NSPasteboard,
            _user_data: Option<&NSString>,
            _error: *mut *mut NSString,
        ) {
            let text = unsafe { pboard.stringForType(NSPasteboardTypeString) }
                .map(|s| s.to_string())
                .unwrap_or_default();
            let text = text.trim().to_string();
            if text.is_empty() {
                return;
            }
            if let Some(h) = HANDLER.get() {
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| h(text))).is_err() {
                    log::error!("services handler panicked");
                }
            }
        }
    }
);

impl Provider {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

/// Register the provider. Must run on the main thread (during setup).
pub fn register(on_text: impl Fn(String) + Send + Sync + 'static) {
    let Some(mtm) = MainThreadMarker::new() else {
        log::warn!("services provider must be registered on the main thread");
        return;
    };
    let _ = HANDLER.set(Box::new(on_text));
    let provider = Provider::new();
    let object: &objc2::runtime::AnyObject = &provider;
    unsafe {
        let app = NSApplication::sharedApplication(mtm);
        app.setServicesProvider(Some(object));
        // Ask macOS to pick up the Services entry from Info.plist.
        objc2_app_kit::NSUpdateDynamicServices();
    }
    // NSApplication doesn't retain its services provider.
    std::mem::forget(provider);
}
