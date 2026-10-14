//! When to notify about a task.
//!
//! All times here are local wall-clock times (`NaiveDateTime`), matching how
//! due dates and times are stored: "Friday 3pm" means 3pm wherever the user
//! is on Friday.

use chrono::{Duration, NaiveDate, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};

use crate::store::Task;

/// Notifications older than this are not sent at all (e.g. the Mac was off).
pub const STALE_AFTER: Duration = Duration::hours(12);

pub const LOCAL_FORMAT: &str = "%Y-%m-%dT%H:%M:%S";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct NotifySettings {
    pub enabled: bool,
    /// When to remind about tasks that have a day but no time, `HH:MM`.
    pub all_day_time: String,
    /// One morning summary at `all_day_time` instead of a notification per
    /// all-day task.
    pub daily_summary: bool,
}

impl Default for NotifySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            all_day_time: "09:00".into(),
            daily_summary: false,
        }
    }
}

impl NotifySettings {
    pub fn all_day(&self) -> NaiveTime {
        parse_time(&self.all_day_time).unwrap_or(NaiveTime::from_hms_opt(9, 0, 0).unwrap())
    }
}

pub fn parse_time(s: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(s, "%H:%M").ok()
}

pub fn parse_local(s: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(s, LOCAL_FORMAT).ok()
}

pub fn format_local(t: NaiveDateTime) -> String {
    t.format(LOCAL_FORMAT).to_string()
}

/// The moment a task's own reminder is due: its time, or `all_day` on its
/// day when it has none (`None` = don't remind about all-day tasks).
pub fn due_at(task: &Task, all_day: Option<NaiveTime>) -> Option<NaiveDateTime> {
    let day = NaiveDate::parse_from_str(task.due_date.as_deref()?, "%Y-%m-%d").ok()?;
    let time = match task.due_time.as_deref() {
        Some(t) => parse_time(t)?,
        None => all_day?,
    };
    Some(day.and_time(time))
}

/// When this task should next notify, taking a snooze into account.
pub fn fire_at(task: &Task, all_day: Option<NaiveTime>) -> Option<NaiveDateTime> {
    if task.done {
        return None;
    }
    if let Some(s) = task.snoozed_until.as_deref().and_then(parse_local) {
        return Some(s);
    }
    due_at(task, all_day)
}

/// Should the task notify now? Not before it's due, not twice for the same
/// moment, and not if the moment is long past.
pub fn should_fire(task: &Task, now: NaiveDateTime, all_day: Option<NaiveTime>) -> bool {
    let Some(at) = fire_at(task, all_day) else {
        return false;
    };
    if at > now || now - at > STALE_AFTER {
        return false;
    }
    match task.notified_at.as_deref().and_then(parse_local) {
        Some(n) => n < at,
        None => true,
    }
}

/// Which open tasks should notify now, given the settings. In summary mode,
/// tasks without a time are left to the morning summary.
pub fn due_now<'a>(tasks: &'a [Task], now: NaiveDateTime, s: &NotifySettings) -> Vec<&'a Task> {
    if !s.enabled {
        return Vec::new();
    }
    let all_day = (!s.daily_summary).then(|| s.all_day());
    tasks
        .iter()
        .filter(|t| should_fire(t, now, all_day))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Summary {
    pub due_today: usize,
    pub overdue: usize,
}

/// Counts for the morning summary, or None if there's nothing to say.
pub fn summary(tasks: &[Task], today: NaiveDate) -> Option<Summary> {
    let today = today.format("%Y-%m-%d").to_string();
    let open = tasks.iter().filter(|t| !t.done);
    let (mut due_today, mut overdue) = (0, 0);
    for t in open {
        match t.due_date.as_deref() {
            Some(d) if d == today => due_today += 1,
            Some(d) if d < today.as_str() => overdue += 1,
            _ => {}
        }
    }
    (due_today + overdue > 0).then_some(Summary { due_today, overdue })
}

impl Summary {
    pub fn text(&self) -> String {
        let plural = |n: usize, one: &str, many: &str| {
            if n == 1 {
                format!("1 {one}")
            } else {
                format!("{n} {many}")
            }
        };
        match (self.due_today, self.overdue) {
            (d, 0) => format!("{} due today", plural(d, "task", "tasks")),
            (0, o) => format!("{} overdue", plural(o, "task", "tasks")),
            (d, o) => format!("{} due today, {o} overdue", plural(d, "task", "tasks")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(due: Option<&str>, time: Option<&str>) -> Task {
        Task {
            id: 1,
            title: "x".into(),
            due_date: due.map(Into::into),
            due_time: time.map(Into::into),
            source_text: None,
            done: false,
            created_at: "2026-10-01T00:00:00Z".into(),
            created_tz: None,
            completed_at: None,
            recurrence: None,
            source_app: None,
            source_bundle: None,
            source_url: None,
            snoozed_until: None,
            notified_at: None,
            next_id: None,
        }
    }

    fn at(s: &str) -> NaiveDateTime {
        parse_local(s).unwrap()
    }

    const NINE: Option<NaiveTime> = NaiveTime::from_hms_opt(9, 0, 0);

    #[test]
    fn fires_at_the_due_time_once() {
        let mut t = task(Some("2026-10-14"), Some("15:00"));
        assert!(!should_fire(&t, at("2026-10-14T14:59:00"), NINE));
        assert!(should_fire(&t, at("2026-10-14T15:00:30"), NINE));
        t.notified_at = Some("2026-10-14T15:00:30".into());
        assert!(!should_fire(&t, at("2026-10-14T15:05:00"), NINE));
    }

    #[test]
    fn all_day_tasks_use_the_setting() {
        let t = task(Some("2026-10-14"), None);
        assert!(!should_fire(&t, at("2026-10-14T08:59:00"), NINE));
        assert!(should_fire(&t, at("2026-10-14T09:00:00"), NINE));
        assert!(!should_fire(&t, at("2026-10-14T09:00:00"), None));
    }

    #[test]
    fn snooze_fires_again_later() {
        let mut t = task(Some("2026-10-14"), Some("15:00"));
        t.notified_at = Some("2026-10-14T15:00:10".into());
        t.snoozed_until = Some("2026-10-14T15:15:00".into());
        assert!(!should_fire(&t, at("2026-10-14T15:10:00"), NINE));
        assert!(should_fire(&t, at("2026-10-14T15:15:05"), NINE));
    }

    #[test]
    fn stale_and_done_tasks_stay_quiet() {
        let mut t = task(Some("2026-10-13"), Some("09:00"));
        assert!(!should_fire(&t, at("2026-10-14T10:00:00"), NINE));
        t.due_date = Some("2026-10-14".into());
        t.done = true;
        assert!(!should_fire(&t, at("2026-10-14T09:01:00"), NINE));
        assert!(!should_fire(
            &task(None, None),
            at("2026-10-14T09:01:00"),
            NINE
        ));
    }

    #[test]
    fn summary_mode_leaves_all_day_tasks_to_the_summary() {
        let tasks = [
            task(Some("2026-10-14"), None),
            task(Some("2026-10-14"), Some("09:00")),
        ];
        let mut s = NotifySettings::default();
        assert_eq!(due_now(&tasks, at("2026-10-14T09:00:00"), &s).len(), 2);
        s.daily_summary = true;
        assert_eq!(due_now(&tasks, at("2026-10-14T09:00:00"), &s).len(), 1);
        s.enabled = false;
        assert!(due_now(&tasks, at("2026-10-14T09:00:00"), &s).is_empty());
    }

    #[test]
    fn summary_counts_and_text() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 14).unwrap();
        let tasks = [
            task(Some("2026-10-14"), None),
            task(Some("2026-10-14"), None),
            task(Some("2026-10-10"), None),
            task(Some("2026-10-20"), None),
            task(None, None),
        ];
        let s = summary(&tasks, today).unwrap();
        assert_eq!(
            s,
            Summary {
                due_today: 2,
                overdue: 1
            }
        );
        assert_eq!(s.text(), "2 tasks due today, 1 overdue");
        assert_eq!(
            Summary {
                due_today: 0,
                overdue: 1
            }
            .text(),
            "1 task overdue"
        );
        assert!(summary(&tasks[3..], today).is_none());
    }
}
