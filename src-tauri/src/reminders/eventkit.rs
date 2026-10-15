//! Apple Reminders through EventKit.
//!
//! An `EventKit` value owns one `EKEventStore` and must stay on the thread
//! that created it (the reminders worker). Completion handlers run on
//! EventKit's own queues; they only send plain Rust data back through
//! channels.

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObjectProtocol};
use objc2::sel;
use objc2_event_kit::{
    EKAuthorizationStatus, EKCalendar, EKEntityType, EKEventStore, EKReminder, EKSourceType,
};
use objc2_foundation::{NSArray, NSDateComponents, NSError, NSString};
use pluck_core::reminders_sync::{RemindersBackend, SyncState};

use super::{Access, ListInfo};

const WAIT: Duration = Duration::from_secs(15);
/// NSDateComponentUndefined
const UNDEFINED: isize = isize::MAX;

pub struct EventKit {
    store: Retained<EKEventStore>,
}

fn ns(s: &str) -> Retained<NSString> {
    NSString::from_str(s)
}

#[allow(unused_unsafe)]
fn error_text(e: &NSError) -> String {
    unsafe { e.localizedDescription() }.to_string()
}

pub fn access() -> Access {
    let status = unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Reminder) };
    match status {
        s if s == EKAuthorizationStatus::NotDetermined => Access::NotDetermined,
        s if s == EKAuthorizationStatus::Restricted => Access::Restricted,
        s if s == EKAuthorizationStatus::Denied => Access::Denied,
        s if s == EKAuthorizationStatus::FullAccess => Access::Full,
        s if s == EKAuthorizationStatus::WriteOnly => Access::WriteOnly,
        _ => Access::Denied,
    }
}

fn state_of(rem: &EKReminder) -> SyncState {
    unsafe {
        let due = rem.dueDateComponents().and_then(|c| {
            let (y, m, d) = (c.year(), c.month(), c.day());
            let valid = y != UNDEFINED
                && m != UNDEFINED
                && d != UNDEFINED
                && (1..=9999).contains(&y)
                && (1..=12).contains(&m)
                && (1..=31).contains(&d);
            valid.then(|| format!("{y:04}-{m:02}-{d:02}"))
        });
        SyncState {
            title: rem.title().to_string(),
            due,
            done: rem.isCompleted(),
        }
    }
}

fn apply(rem: &EKReminder, state: &SyncState) {
    unsafe {
        rem.setTitle(Some(&ns(&state.title)));
        match state.due.as_deref().and_then(parse_day) {
            Some((y, m, d)) => {
                let c = NSDateComponents::new();
                c.setYear(y);
                c.setMonth(m);
                c.setDay(d);
                rem.setDueDateComponents(Some(&c));
            }
            None => rem.setDueDateComponents(None),
        }
        if rem.isCompleted() != state.done {
            rem.setCompleted(state.done);
        }
    }
}

fn parse_day(s: &str) -> Option<(isize, isize, isize)> {
    let mut it = s.splitn(3, '-').map(|p| p.parse::<isize>().ok());
    Some((it.next()??, it.next()??, it.next()??))
}

fn list_info(cal: &EKCalendar) -> ListInfo {
    unsafe {
        let (source, kind) = match cal.source() {
            Some(src) => (src.title().to_string(), src.sourceType()),
            None => (String::new(), EKSourceType::Local),
        };
        let icloud = kind == EKSourceType::CalDAV && source.to_lowercase().contains("icloud");
        ListInfo {
            id: cal.calendarIdentifier().to_string(),
            title: cal.title().to_string(),
            leaves_mac: kind != EKSourceType::Local,
            icloud,
            source: if source.is_empty() {
                "On My Mac".into()
            } else {
                source
            },
            writable: cal.allowsContentModifications(),
        }
    }
}

impl EventKit {
    pub fn open() -> Self {
        Self {
            store: unsafe { EKEventStore::new() },
        }
    }

    /// Show the system permission prompt (once) and wait for the answer.
    pub fn request_access(&self) -> Result<Access, String> {
        let (tx, rx) = mpsc::channel::<Result<bool, String>>();
        let block = RcBlock::new(move |granted: Bool, err: *mut NSError| {
            let result = match unsafe { err.as_ref() } {
                Some(e) if !granted.as_bool() => Err(error_text(e)),
                _ => Ok(granted.as_bool()),
            };
            let _ = tx.send(result);
        });
        unsafe {
            let modern = self
                .store
                .respondsToSelector(sel!(requestFullAccessToRemindersWithCompletion:));
            if modern {
                self.store
                    .requestFullAccessToRemindersWithCompletion(RcBlock::as_ptr(&block));
            } else {
                #[allow(deprecated)]
                self.store.requestAccessToEntityType_completion(
                    EKEntityType::Reminder,
                    RcBlock::as_ptr(&block),
                );
            }
        }
        match rx.recv_timeout(Duration::from_secs(300)) {
            Ok(Ok(_)) => Ok(access()),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("No answer to the Reminders permission request.".into()),
        }
    }

    /// Drop cached objects so changes made in Reminders are seen.
    pub fn refresh(&self) {
        unsafe {
            self.store.refreshSourcesIfNecessary();
            self.store.reset();
        }
    }

    pub fn lists(&self) -> Vec<ListInfo> {
        let cals = unsafe { self.store.calendarsForEntityType(EKEntityType::Reminder) };
        let mut lists: Vec<ListInfo> = cals.to_vec().iter().map(|c| list_info(c)).collect();
        lists.sort_by(|a, b| a.source.cmp(&b.source).then(a.title.cmp(&b.title)));
        lists
    }

    pub fn list(&self, id: &str) -> Option<ListInfo> {
        unsafe { self.store.calendarWithIdentifier(&ns(id)) }.map(|c| list_info(&c))
    }

    /// Create a list called `title` where new reminders normally go (or the
    /// first writable source).
    pub fn create_list(&self, title: &str) -> Result<ListInfo, String> {
        unsafe {
            let cal =
                EKCalendar::calendarForEntityType_eventStore(EKEntityType::Reminder, &self.store);
            cal.setTitle(&ns(title));
            let source = self
                .store
                .defaultCalendarForNewReminders()
                .and_then(|c| c.source())
                .or_else(|| self.store.sources().to_vec().into_iter().next());
            let Some(source) = source else {
                return Err("No Reminders account is available on this Mac.".into());
            };
            cal.setSource(Some(&source));
            self.store
                .saveCalendar_commit_error(&cal, true)
                .map_err(|e| error_text(&e))?;
            Ok(list_info(&cal))
        }
    }

    fn reminder(&self, id: &str) -> Option<Retained<EKReminder>> {
        let item = unsafe { self.store.calendarItemWithIdentifier(&ns(id)) }?;
        item.downcast::<EKReminder>().ok()
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let Some(rem) = self.reminder(id) else {
            return Ok(());
        };
        unsafe { self.store.removeReminder_commit_error(&rem, true) }.map_err(|e| error_text(&e))
    }
}

impl RemindersBackend for EventKit {
    fn get(&mut self, id: &str) -> Result<Option<SyncState>, String> {
        Ok(self.reminder(id).map(|r| state_of(&r)))
    }

    fn update(&mut self, id: &str, state: &SyncState) -> Result<(), String> {
        let rem = self.reminder(id).ok_or("The reminder no longer exists.")?;
        apply(&rem, state);
        unsafe { self.store.saveReminder_commit_error(&rem, true) }.map_err(|e| error_text(&e))
    }

    fn create(
        &mut self,
        list_id: &str,
        state: &SyncState,
        notes: Option<&str>,
    ) -> Result<String, String> {
        unsafe {
            let cal = self
                .store
                .calendarWithIdentifier(&ns(list_id))
                .ok_or("The Reminders list Plucky syncs with no longer exists.")?;
            let rem = EKReminder::reminderWithEventStore(&self.store);
            rem.setCalendar(Some(&cal));
            apply(&rem, state);
            if let Some(n) = notes.filter(|n| !n.trim().is_empty()) {
                rem.setNotes(Some(&ns(n)));
            }
            self.store
                .saveReminder_commit_error(&rem, true)
                .map_err(|e| error_text(&e))?;
            Ok(rem.calendarItemIdentifier().to_string())
        }
    }

    fn incomplete_in_list(&mut self, list_id: &str) -> Result<Vec<(String, SyncState)>, String> {
        let cal = unsafe { self.store.calendarWithIdentifier(&ns(list_id)) }
            .ok_or("The Reminders list Plucky syncs with no longer exists.")?;
        let cals = NSArray::from_retained_slice(&[cal]);
        let predicate = unsafe { self.store.predicateForRemindersInCalendars(Some(&cals)) };
        let (tx, rx) = mpsc::channel::<Vec<(String, SyncState)>>();
        let block = RcBlock::new(move |found: *mut NSArray<EKReminder>| {
            let items = unsafe { found.as_ref() }
                .map(|a| a.to_vec())
                .unwrap_or_default()
                .iter()
                .filter(|r| unsafe { !r.isCompleted() })
                .map(|r| {
                    (
                        unsafe { r.calendarItemIdentifier() }.to_string(),
                        state_of(r),
                    )
                })
                .collect();
            let _ = tx.send(items);
        });
        unsafe {
            let _ = self
                .store
                .fetchRemindersMatchingPredicate_completion(&predicate, &block);
        }
        rx.recv_timeout(WAIT)
            .map_err(|_| "Reminders took too long to answer.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reading the permission state must work (and not prompt) even with no
    /// access granted, as on CI.
    #[test]
    fn authorization_status_is_readable_off_main_thread() {
        let a = std::thread::spawn(access).join().expect("no panic");
        assert_ne!(a, Access::Unsupported);
    }

    #[test]
    fn parses_due_days() {
        assert_eq!(parse_day("2026-10-14"), Some((2026, 10, 14)));
        assert_eq!(parse_day("2026-10"), None);
        assert_eq!(parse_day("nope"), None);
    }
}
