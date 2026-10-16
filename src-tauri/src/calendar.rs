//! Calendar connector (macOS): read the events in the Mac's Calendar app so
//! Plucky can show them next to tasks.
//!
//! Read-only and local. Events come from EventKit, the same store the Calendar
//! app uses, so Google, Outlook and iCloud calendars that are added to the Mac
//! show up too, without Plucky signing in anywhere or using the network.

#![cfg_attr(not(target_os = "macos"), allow(dead_code, unused_imports))]

use serde::Serialize;

use crate::reminders::Access;

#[derive(Debug, Clone, Serialize)]
pub struct CalendarInfo {
    pub id: String,
    pub title: String,
    /// The account it belongs to: "iCloud", "Google", "On My Mac"…
    pub source: String,
    /// `#rrggbb`, the colour the Calendar app uses for it.
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EventInfo {
    pub id: String,
    pub title: String,
    /// Local `YYYY-MM-DDTHH:MM:SS`.
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub calendar: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub supported: bool,
    pub access: Access,
    pub enabled: bool,
    /// Calendars to show; `None` means all of them.
    pub calendars: Option<Vec<String>>,
}

pub fn access() -> Access {
    #[cfg(target_os = "macos")]
    return macos::access();
    #[cfg(not(target_os = "macos"))]
    Access::Unsupported
}

/// Show the macOS permission prompt (once) and wait for the answer.
pub fn request_access() -> Result<Access, String> {
    #[cfg(target_os = "macos")]
    return macos::request_access();
    #[cfg(not(target_os = "macos"))]
    Err("Calendar is only available on macOS.".into())
}

pub fn calendars() -> Result<Vec<CalendarInfo>, String> {
    #[cfg(target_os = "macos")]
    return Ok(macos::calendars());
    #[cfg(not(target_os = "macos"))]
    Ok(Vec::new())
}

/// Events overlapping the days `from..=to` (`YYYY-MM-DD`), in the chosen
/// calendars (`None` = all), sorted by start.
pub fn events(from: &str, to: &str, ids: Option<&[String]>) -> Result<Vec<EventInfo>, String> {
    let parse = |s: &str| {
        chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| format!("Not a date: {s}"))
    };
    let (from, to) = (parse(from)?, parse(to)?);
    if to < from || (to - from).num_days() > 62 {
        return Err("Ask for at most two months of events at a time.".into());
    }
    #[cfg(target_os = "macos")]
    return Ok(macos::events(from, to, ids));
    #[cfg(not(target_os = "macos"))]
    {
        let _ = ids;
        Ok(Vec::new())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    #![allow(unused_unsafe)]

    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use chrono::{Local, NaiveDate, TimeZone};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObjectProtocol};
    use objc2::sel;
    use objc2_app_kit::NSColorSpace;
    use objc2_event_kit::{EKAuthorizationStatus, EKCalendar, EKEntityType, EKEventStore};
    use objc2_foundation::{NSArray, NSDate, NSError};

    use super::{Access, CalendarInfo, EventInfo};

    pub fn access() -> Access {
        let status = unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) };
        match status {
            s if s == EKAuthorizationStatus::NotDetermined => Access::NotDetermined,
            s if s == EKAuthorizationStatus::Restricted => Access::Restricted,
            s if s == EKAuthorizationStatus::Denied => Access::Denied,
            s if s == EKAuthorizationStatus::FullAccess => Access::Full,
            s if s == EKAuthorizationStatus::WriteOnly => Access::WriteOnly,
            _ => Access::Denied,
        }
    }

    pub fn request_access() -> Result<Access, String> {
        let store = unsafe { EKEventStore::new() };
        let (tx, rx) = mpsc::channel::<Result<bool, String>>();
        let block = RcBlock::new(move |granted: Bool, err: *mut NSError| {
            let result = match unsafe { err.as_ref() } {
                Some(e) if !granted.as_bool() => {
                    Err(unsafe { e.localizedDescription() }.to_string())
                }
                _ => Ok(granted.as_bool()),
            };
            let _ = tx.send(result);
        });
        unsafe {
            if store.respondsToSelector(sel!(requestFullAccessToEventsWithCompletion:)) {
                store.requestFullAccessToEventsWithCompletion(RcBlock::as_ptr(&block));
            } else {
                #[allow(deprecated)]
                store.requestAccessToEntityType_completion(
                    EKEntityType::Event,
                    RcBlock::as_ptr(&block),
                );
            }
        }
        match rx.recv_timeout(Duration::from_secs(300)) {
            Ok(Ok(_)) => Ok(access()),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("No answer to the Calendar permission request.".into()),
        }
    }

    fn hex(cal: &EKCalendar) -> Option<String> {
        let color = unsafe { cal.color() };
        let rgb = color.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
        let c = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        Some(format!(
            "#{:02x}{:02x}{:02x}",
            c(rgb.redComponent()),
            c(rgb.greenComponent()),
            c(rgb.blueComponent())
        ))
    }

    fn info(cal: &EKCalendar) -> CalendarInfo {
        unsafe {
            let source = cal
                .source()
                .map(|s| s.title().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "On My Mac".into());
            CalendarInfo {
                id: cal.calendarIdentifier().to_string(),
                title: cal.title().to_string(),
                source,
                color: hex(cal),
            }
        }
    }

    fn all(store: &EKEventStore) -> Vec<Retained<EKCalendar>> {
        unsafe { store.calendarsForEntityType(EKEntityType::Event) }.to_vec()
    }

    pub fn calendars() -> Vec<CalendarInfo> {
        if access() != Access::Full {
            return Vec::new();
        }
        let store = unsafe { EKEventStore::new() };
        let mut list: Vec<CalendarInfo> = all(&store).iter().map(|c| info(c)).collect();
        list.sort_by(|a, b| a.source.cmp(&b.source).then(a.title.cmp(&b.title)));
        list
    }

    fn local(secs: f64) -> String {
        Local
            .timestamp_opt(secs.floor() as i64, 0)
            .single()
            .map(|t| t.format("%Y-%m-%dT%H:%M:%S").to_string())
            .unwrap_or_default()
    }

    fn midnight(day: NaiveDate) -> f64 {
        day.and_hms_opt(0, 0, 0)
            .and_then(|t| Local.from_local_datetime(&t).earliest())
            .map(|t| t.timestamp() as f64)
            .unwrap_or_default()
    }

    pub fn events(from: NaiveDate, to: NaiveDate, ids: Option<&[String]>) -> Vec<EventInfo> {
        if access() != Access::Full {
            return Vec::new();
        }
        let store = unsafe { EKEventStore::new() };
        let chosen: Vec<Retained<EKCalendar>> = all(&store)
            .into_iter()
            .filter(|c| match ids {
                Some(ids) => {
                    let id = unsafe { c.calendarIdentifier() }.to_string();
                    ids.contains(&id)
                }
                None => true,
            })
            .collect();
        if chosen.is_empty() {
            return Vec::new();
        }
        let calendars = NSArray::from_retained_slice(&chosen);
        let start = NSDate::dateWithTimeIntervalSince1970(midnight(from));
        let end = NSDate::dateWithTimeIntervalSince1970(midnight(to + chrono::Duration::days(1)));
        let mut out: Vec<EventInfo> = unsafe {
            let predicate = store.predicateForEventsWithStartDate_endDate_calendars(
                &start,
                &end,
                Some(&calendars),
            );
            store.eventsMatchingPredicate(&predicate)
        }
        .to_vec()
        .iter()
        .map(|e| unsafe {
            let cal = e.calendar();
            EventInfo {
                id: e
                    .eventIdentifier()
                    .map(|s| s.to_string())
                    .unwrap_or_default(),
                title: e.title().to_string(),
                start: local(e.startDate().timeIntervalSince1970()),
                end: local(e.endDate().timeIntervalSince1970()),
                all_day: e.isAllDay(),
                calendar: cal
                    .as_ref()
                    .map(|c| c.title().to_string())
                    .unwrap_or_default(),
                color: cal.as_ref().and_then(|c| hex(c)),
            }
        })
        .collect();
        out.sort_by(|a, b| b.all_day.cmp(&a.all_day).then(a.start.cmp(&b.start)));
        out
    }
}
