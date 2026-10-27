//! Due-time notifications and the morning summary.
//!
//! A scheduler checks every 15 seconds which tasks are due (the rules are in
//! `todocity_core::notify`) and shows a notification for each. On macOS each
//! one has Done / Snooze / Tomorrow buttons; clicking it opens the task.
//! Everything happens on this Mac — nothing is scheduled with a server.

#[cfg(target_os = "macos")]
mod macos;

use std::time::Duration;

use chrono::{Local, NaiveDateTime};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use todocity_core::notify::{self, format_local, NotifySettings};
use todocity_core::{Task, TaskPatch};

use crate::settings::Settings;
use crate::AppState;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const TASK_CATEGORY: &str = "todocity-task";
const SUMMARY_ID: &str = "todocity-summary";
const TICK: Duration = Duration::from_secs(15);
/// More due at once than this become one combined notification.
const MAX_SEPARATE: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum Permission {
    NotDetermined,
    Denied,
    Granted,
    Unsupported,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct Note {
    pub id: String,
    pub title: String,
    pub body: String,
    /// Show Done / Snooze buttons.
    pub actions: bool,
}

fn task_note_id(id: i64) -> String {
    format!("task-{id}")
}

/// Install the macOS delegate. Call during setup (main thread).
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        macos::init(move |id, action| {
            let app = handle.clone();
            // Leave the delegate callback quickly; do the work elsewhere.
            tauri::async_runtime::spawn(async move { on_response(&app, &id, &action) });
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn permission() -> Permission {
    #[cfg(target_os = "macos")]
    {
        macos::permission()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Permission::Granted
    }
}

/// Blocking: waits for the user to answer the macOS prompt.
pub fn request_permission() -> Permission {
    #[cfg(target_os = "macos")]
    {
        macos::request_permission()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Permission::Granted
    }
}

fn send(app: &AppHandle, note: Note) {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        macos::send(&note);
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        if let Err(e) = app
            .notification()
            .builder()
            .title(&note.title)
            .body(&note.body)
            .show()
        {
            log::warn!("notification failed: {e}");
        }
    }
}

/// A plain notification without buttons; clicking it opens TodoCity.
pub fn send_plain(app: &AppHandle, id: &str, title: String, body: String) {
    send(
        app,
        Note {
            id: id.into(),
            title,
            body,
            actions: false,
        },
    );
}

/// Clear a task's banner, e.g. once it's done.
pub fn clear_task(id: i64) {
    #[cfg(target_os = "macos")]
    macos::remove(&task_note_id(id));
    #[cfg(not(target_os = "macos"))]
    let _ = id;
}

/// Show a test notification (from Settings).
pub fn send_test(app: &AppHandle) {
    send(
        app,
        Note {
            id: "todocity-test".into(),
            title: "Notifications are on".into(),
            body: "TodoCity will remind you like this when a task is due.".into(),
            actions: false,
        },
    );
}

/// "3:00 PM" / "15:00" style, following the user's 12/24-hour habit is not
/// knowable here, so use the unambiguous short 12-hour form.
fn time_label(hhmm: &str) -> String {
    match chrono::NaiveTime::parse_from_str(hhmm, "%H:%M") {
        Ok(t) => t.format("%-I:%M %p").to_string(),
        Err(_) => hhmm.to_string(),
    }
}

fn body_for(task: &Task) -> String {
    let mut parts = Vec::new();
    parts.push(match task.due_time.as_deref() {
        Some(t) => format!("Due {}", time_label(t)),
        None => "Due today".to_string(),
    });
    if task.snoozed_until.is_some() {
        parts[0] = "Snoozed reminder".into();
    }
    if let Some(app) = &task.source_app {
        parts.push(format!("from {app}"));
    }
    if task.recurrence.is_some() {
        parts.push("repeats".into());
    }
    parts.join(" · ")
}

/// Tasks to notify about: in a mode that follows notifications, only the
/// ones it shows.
fn open_tasks(app: &AppHandle) -> Vec<Task> {
    let tasks = app
        .try_state::<AppState>()
        .and_then(|s| s.store.lock().ok().and_then(|st| st.list(None).ok()))
        .unwrap_or_default();
    match crate::active_mode(app).filter(|m| m.notify) {
        Some(m) => tasks.into_iter().filter(|t| m.shows(t)).collect(),
        None => tasks,
    }
}

/// One scheduler tick: send whatever is due now.
fn tick(app: &AppHandle) {
    let settings = app.state::<Settings>().get();
    let s: &NotifySettings = &settings.notify;
    let now: NaiveDateTime = Local::now().naive_local();

    // The daily check-in on tasks with no date, in the menu-bar dropdown.
    if settings.undated_nudge {
        let at = notify::parse_time(&settings.undated_time)
            .unwrap_or(chrono::NaiveTime::from_hms_opt(16, 0, 0).unwrap());
        if notify::undated_nudge_due(now, at, settings.last_undated_nudge.as_deref()) {
            let today = now.date().format("%Y-%m-%d").to_string();
            app.state::<Settings>()
                .update(|v| v.last_undated_nudge = Some(today));
            let tasks = open_tasks(app);
            let count = notify::undated(&tasks).len();
            if count > 0 && !crate::popover::show_focus(app, crate::popover::Focus::Undated) {
                // The menu-bar icon is hidden: fall back to a notification.
                send(
                    app,
                    Note {
                        id: "todocity-undated".into(),
                        title: if count == 1 {
                            "1 task has no date".into()
                        } else {
                            format!("{count} tasks have no date")
                        },
                        body: "Open TodoCity to plan them.".into(),
                        actions: false,
                    },
                );
            }
        }
    }

    // Due tasks: a notification, and the dropdown opened on them.
    if !s.enabled && !settings.due_spotlight {
        return;
    }
    let rules = NotifySettings {
        enabled: true,
        ..s.clone()
    };
    let tasks = open_tasks(app);
    let due: Vec<&Task> = notify::due_now(&tasks, now, &rules);
    if !due.is_empty() {
        let stamp = format_local(now);
        if let Some(state) = app.try_state::<AppState>() {
            if let Ok(store) = state.store.lock() {
                for t in &due {
                    let _ = store.mark_notified(t.id, &stamp);
                }
            }
        }
        // Windows show a "Due now" card for reminders that just went off.
        let _ = app.emit("tasks-changed", ());
        // Tasks with a set time (or a snooze ending) get the spotlight; all-day
        // reminders stay a quiet notification.
        let timed: Vec<i64> = due
            .iter()
            .filter(|t| t.due_time.is_some() || t.snoozed_until.is_some())
            .map(|t| t.id)
            .collect();
        if settings.due_spotlight && !timed.is_empty() {
            crate::popover::show_focus(app, crate::popover::Focus::Due { ids: timed });
        }
        // With notifications off, the spotlight above is all there is.
        if s.enabled && due.len() > MAX_SEPARATE {
            send(
                app,
                Note {
                    id: "todocity-many".into(),
                    title: format!("{} tasks are due", due.len()),
                    body: due
                        .iter()
                        .take(3)
                        .map(|t| t.title.as_str())
                        .collect::<Vec<_>>()
                        .join(" · "),
                    actions: false,
                },
            );
        } else if s.enabled {
            for t in due {
                send(
                    app,
                    Note {
                        id: task_note_id(t.id),
                        title: t.title.clone(),
                        body: body_for(t),
                        actions: true,
                    },
                );
            }
        }
    }

    // Morning summary, once a day at the all-day time.
    if s.enabled && s.daily_summary {
        let today = now.date().format("%Y-%m-%d").to_string();
        let at = now.date().and_time(s.all_day());
        let fresh = now >= at && now - at < notify::STALE_AFTER;
        if fresh && settings.last_summary.as_deref() != Some(today.as_str()) {
            app.state::<Settings>()
                .update(|v| v.last_summary = Some(today.clone()));
            if let Some(summary) = notify::summary(&tasks, now.date()) {
                send(
                    app,
                    Note {
                        id: SUMMARY_ID.into(),
                        title: "Good morning".into(),
                        body: format!("{} — open TodoCity to plan your day.", summary.text()),
                        actions: false,
                    },
                );
            }
        }
    }
}

pub fn start_scheduler(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Let the app finish launching first.
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            let a = app.clone();
            let r = tauri::async_runtime::spawn_blocking(move || tick(&a)).await;
            if let Err(e) = r {
                log::error!("notification tick failed: {e}");
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

/// The user clicked a notification (`action` = the default action) or one
/// of its buttons.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn on_response(app: &AppHandle, id: &str, action: &str) {
    let Some(task_id) = id.strip_prefix("task-").and_then(|n| n.parse::<i64>().ok()) else {
        // Summary, "several due" or test notification: open the list.
        crate::open_main_at(app, None);
        return;
    };
    let now = Local::now().naive_local();
    let patch = match action {
        "done" => TaskPatch {
            done: Some(true),
            ..Default::default()
        },
        "snooze15" | "snooze60" => {
            let mins = if action == "snooze15" { 15 } else { 60 };
            let at = now + chrono::Duration::minutes(mins);
            let repeats = app
                .try_state::<AppState>()
                .and_then(|st| st.store.lock().ok().and_then(|s| s.get(task_id).ok()))
                .is_some_and(|t| t.recurrence.is_some());
            if repeats {
                // A repeating task keeps its time; only the reminder waits.
                TaskPatch {
                    snoozed_until: Some(Some(format_local(at))),
                    ..Default::default()
                }
            } else {
                // Otherwise the task itself moves to the later time.
                TaskPatch {
                    due_date: Some(Some(at.date().format("%Y-%m-%d").to_string())),
                    due_time: Some(Some(at.format("%H:%M").to_string())),
                    ..Default::default()
                }
            }
        }
        "tomorrow" => TaskPatch {
            due_date: Some(Some(
                (now.date() + chrono::Duration::days(1))
                    .format("%Y-%m-%d")
                    .to_string(),
            )),
            ..Default::default()
        },
        _ => {
            crate::open_main_at(app, Some(task_id));
            return;
        }
    };
    if let Err(e) = crate::apply_patch(app, task_id, patch) {
        log::warn!("notification action {action} on task {task_id} failed: {e}");
    }
    let _ = app.emit("tasks-changed", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_bodies() {
        assert_eq!(time_label("15:05"), "3:05 PM");
        assert_eq!(time_label("09:00"), "9:00 AM");
        let mut t = Task {
            id: 1,
            title: "x".into(),
            due_date: Some("2026-10-14".into()),
            due_time: Some("15:00".into()),
            source_text: None,
            done: false,
            created_at: String::new(),
            created_tz: None,
            completed_at: None,
            recurrence: Some("weekly".into()),
            source_app: Some("Slack".into()),
            source_bundle: None,
            source_url: None,
            snoozed_until: None,
            notified_at: None,
            next_id: None,
            notes: None,
            ..Default::default()
        };
        assert_eq!(body_for(&t), "Due 3:00 PM · from Slack · repeats");
        t.snoozed_until = Some("2026-10-14T15:15:00".into());
        assert!(body_for(&t).starts_with("Snoozed reminder"));
    }
}
