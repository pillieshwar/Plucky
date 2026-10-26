//! macOS notifications through UserNotifications, with Done / Snooze
//! buttons.
//!
//! UserNotifications only works inside a real `.app` bundle (it aborts in
//! `cargo run` and unit tests), so everything checks [`available`] first.

#![allow(unused_unsafe)]

use std::ptr::NonNull;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread};
use objc2_foundation::{NSArray, NSError, NSSet, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationAction, UNNotificationActionOptions, UNNotificationCategory,
    UNNotificationCategoryOptions, UNNotificationPresentationOptions, UNNotificationRequest,
    UNNotificationResponse, UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};

use super::{Note, Permission, TASK_CATEGORY};

type Handler = Box<dyn Fn(String, String) + Send + Sync>;
static HANDLER: OnceLock<Handler> = OnceLock::new();

define_class!(
    // SAFETY: NSObject has no subclassing requirements and Delegate has no Drop.
    #[unsafe(super(NSObject))]
    #[name = "PluckNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        /// Show banners even while a Todo City window is in front.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            handler: &block2::Block<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            handler.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            handler: &block2::Block<dyn Fn()>,
        ) {
            let (id, action) = unsafe {
                (
                    response.notification().request().identifier().to_string(),
                    response.actionIdentifier().to_string(),
                )
            };
            if let Some(h) = HANDLER.get() {
                let result =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| h(id, action)));
                if result.is_err() {
                    log::error!("notification handler panicked");
                }
            }
            handler.call(());
        }
    }
);

impl Delegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

/// True when running from an app bundle, where UserNotifications works.
pub fn available() -> bool {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"))
        .unwrap_or(false)
}

fn center() -> Option<Retained<UNUserNotificationCenter>> {
    available().then(|| unsafe { UNUserNotificationCenter::currentNotificationCenter() })
}

fn ns(s: &str) -> Retained<NSString> {
    NSString::from_str(s)
}

/// Install the delegate and the Done / Snooze buttons. Call once, on the
/// main thread, during setup. `on_response(id, action)` runs when the user
/// clicks a notification or one of its buttons.
pub fn init(on_response: impl Fn(String, String) + Send + Sync + 'static) {
    let Some(center) = center() else {
        log::info!("notifications unavailable outside an app bundle");
        return;
    };
    let _ = HANDLER.set(Box::new(on_response));
    let delegate = Delegate::new();
    unsafe {
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    }
    // The center holds its delegate weakly; keep ours for the app's life.
    std::mem::forget(delegate);

    let none = UNNotificationActionOptions::empty();
    let actions = [
        ("done", "Done"),
        ("snooze15", "Snooze 15 min"),
        ("snooze60", "Snooze 1 hour"),
        ("tomorrow", "Tomorrow"),
    ]
    .map(|(id, title)| unsafe {
        UNNotificationAction::actionWithIdentifier_title_options(&ns(id), &ns(title), none)
    });
    unsafe {
        let category =
            UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                &ns(TASK_CATEGORY),
                &NSArray::from_retained_slice(&actions),
                &NSArray::from_retained_slice(&[] as &[Retained<NSString>]),
                UNNotificationCategoryOptions::empty(),
            );
        center.setNotificationCategories(&NSSet::from_retained_slice(&[category]));
    }
}

pub fn permission() -> Permission {
    let Some(center) = center() else {
        return Permission::Unsupported;
    };
    let (tx, rx) = mpsc::channel();
    let block = RcBlock::new(move |s: NonNull<UNNotificationSettings>| {
        let status = unsafe { s.as_ref().authorizationStatus() };
        let _ = tx.send(status);
    });
    unsafe { center.getNotificationSettingsWithCompletionHandler(&block) };
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(s) if s == UNAuthorizationStatus::NotDetermined => Permission::NotDetermined,
        Ok(s) if s == UNAuthorizationStatus::Denied => Permission::Denied,
        Ok(_) => Permission::Granted,
        Err(_) => Permission::NotDetermined,
    }
}

/// Ask once (macOS shows its prompt only the first time) and wait for the
/// answer.
pub fn request_permission() -> Permission {
    let Some(center) = center() else {
        return Permission::Unsupported;
    };
    let (tx, rx) = mpsc::channel();
    let block = RcBlock::new(move |granted: Bool, err: *mut NSError| {
        if let Some(e) = unsafe { err.as_ref() } {
            log::warn!("notification permission error: {}", unsafe {
                e.localizedDescription()
            });
        }
        let _ = tx.send(granted.as_bool());
    });
    let opts = UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound;
    unsafe { center.requestAuthorizationWithOptions_completionHandler(opts, &block) };
    match rx.recv_timeout(Duration::from_secs(120)) {
        Ok(true) => Permission::Granted,
        Ok(false) => Permission::Denied,
        Err(_) => permission(),
    }
}

pub fn send(note: &Note) {
    let Some(center) = center() else { return };
    unsafe {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&ns(&note.title));
        content.setBody(&ns(&note.body));
        content.setThreadIdentifier(&ns("todocity"));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        if note.actions {
            content.setCategoryIdentifier(&ns(TASK_CATEGORY));
        }
        // No trigger: deliver now. The same id replaces an older banner.
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &ns(&note.id),
            &content,
            None,
        );
        let id = note.id.clone();
        let done = RcBlock::new(move |err: *mut NSError| {
            if let Some(e) = err.as_ref() {
                log::warn!("notification {id} failed: {}", e.localizedDescription());
            }
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&done));
    }
}

/// Take a delivered notification off screen (e.g. the task was completed).
pub fn remove(id: &str) {
    let Some(center) = center() else { return };
    unsafe {
        center
            .removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(&[ns(id)]));
    }
}
