//! Email → tasks, on a schedule.
//!
//! Every `interval` minutes between `start` and `end` (local time), Plucky
//! runs Claude Code headless with `/email-tasks` (see `apps::email_command`).
//! Claude Code reads recent mail through the user's own mail MCP server and
//! sends action items back to Plucky's write-only `add_task`; they land in the
//! review inbox like any other agent task. The run may use only that mail
//! server's tools and `add_task`. Plucky itself never reads the mail.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::{Datelike, Local, NaiveDateTime, NaiveTime, Weekday};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::apps;
use crate::settings::{EmailRun, EmailSchedule, Settings};

static RUNNING: AtomicBool = AtomicBool::new(false);
const LOCAL: &str = "%Y-%m-%dT%H:%M:%S";
/// How far back the first run of a day may read: never more than this.
const MAX_LOOKBACK_DAYS: i64 = 3;
const RUN_LIMIT: Duration = Duration::from_secs(6 * 60);

fn time(s: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(s, "%H:%M").ok()
}

/// The start of the scheduled slot `now` is in, or `None` outside the hours.
pub fn current_slot(now: NaiveDateTime, s: &EmailSchedule) -> Option<NaiveDateTime> {
    let (start, end) = (time(&s.start)?, time(&s.end)?);
    if s.weekdays_only && matches!(now.weekday(), Weekday::Sat | Weekday::Sun) {
        return None;
    }
    let t = now.time();
    if t < start {
        return None;
    }
    let interval = i64::from(s.interval.clamp(5, 240));
    let since = (t - start).num_minutes();
    let slot = start + chrono::Duration::minutes(since / interval * interval);
    // `slot < start` means the addition wrapped past midnight.
    if slot > end || slot < start {
        return None;
    }
    Some(now.date().and_time(slot))
}

/// Should a run start now? Once per slot, whether the last one worked or not.
pub fn due(now: NaiveDateTime, s: &EmailSchedule) -> bool {
    let Some(slot) = current_slot(now, s) else {
        return false;
    };
    let last = s
        .last
        .as_ref()
        .and_then(|r| NaiveDateTime::parse_from_str(&r.at, LOCAL).ok());
    !last.is_some_and(|l| l >= slot)
}

/// The argument for `/email-tasks`: mail since the last successful run, but
/// at most a few days back.
pub fn window(now: NaiveDateTime, last_ok: Option<&str>) -> String {
    let floor = (now.date() - chrono::Duration::days(MAX_LOOKBACK_DAYS))
        .and_hms_opt(0, 0, 0)
        .unwrap_or(now);
    match last_ok.and_then(|l| NaiveDateTime::parse_from_str(l, LOCAL).ok()) {
        Some(l) => format!(
            "emails I received since {} (my local time)",
            l.max(floor).format("%Y-%m-%dT%H:%M")
        ),
        None => "emails I received today".into(),
    }
}

/// Make sense of Claude Code's final line.
fn outcome(stdout: &str, server: &str) -> (bool, String) {
    let last = stdout
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("");
    if stdout.contains("NO_EMAIL_TOOL") {
        return (
            false,
            format!("Claude Code couldn't find email tools in “{server}”."),
        );
    }
    if last.is_empty() {
        return (true, "Done.".into());
    }
    let short: String = last.chars().take(160).collect();
    (true, short)
}

fn run_once(app: &AppHandle) -> EmailRun {
    let settings = app.state::<Settings>().get();
    let started = Local::now().naive_local();
    let fail = |message: String| EmailRun {
        at: started.format(LOCAL).to_string(),
        ok: false,
        message,
    };
    let Some(home) = apps::home() else {
        return fail("Couldn't find your home folder.".into());
    };
    let Some(claude) = apps::find_claude(&home, true) else {
        return fail("Claude Code isn't installed, or Plucky can't find it.".into());
    };
    let Some(server) = settings.email.server.clone().filter(|s| !s.is_empty()) else {
        return fail("Choose your mail connection first.".into());
    };
    let prompt = format!(
        "/email-tasks {}",
        window(started, settings.email.last_ok.as_deref())
    );
    let allowed = format!("mcp__{}__add_task,mcp__{server}", apps::SERVER);
    // Through a login shell, so Claude Code gets the same environment (PATH,
    // sign-in, Bedrock settings…) as in Terminal.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = std::process::Command::new(shell);
    cmd.args(["-l", "-i", "-c", r#"exec "$0" "$@""#])
        .arg(&claude)
        .args(["-p", &prompt, "--allowedTools", &allowed])
        .current_dir(&home);
    match apps::run(&mut cmd, RUN_LIMIT) {
        Ok(stdout) => {
            let (ok, message) = outcome(&stdout, &server);
            EmailRun {
                at: started.format(LOCAL).to_string(),
                ok,
                message,
            }
        }
        Err(e) if e == "timed out" => fail("Claude Code didn't finish within 6 minutes.".into()),
        Err(e) => {
            let first = e
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .unwrap_or("");
            let first: String = first.chars().take(160).collect();
            fail(if first.is_empty() {
                "Claude Code stopped with an error.".into()
            } else {
                format!("Claude Code: {first}")
            })
        }
    }
}

/// Run once (unless a run is already going) and record the result.
fn run_and_record(app: &AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app.emit("email-tasks-changed", ());
    let result = run_once(app);
    log::info!("email tasks run: ok={} {}", result.ok, result.message);
    app.state::<Settings>().update(|s| {
        if result.ok {
            s.email.last_ok = Some(result.at.clone());
        }
        s.email.last = Some(result.clone());
    });
    RUNNING.store(false, Ordering::SeqCst);
    let _ = app.emit("email-tasks-changed", ());
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            let s = app.state::<Settings>().get();
            if s.email.enabled && s.agents_enabled && due(Local::now().naive_local(), &s.email) {
                let a = app.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || run_and_record(&a)).await;
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

// ── Commands ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub schedule: EmailSchedule,
    /// MCP servers in Claude Code, mail-looking ones first.
    pub servers: Vec<String>,
    pub claude_code_connected: bool,
    pub running: bool,
}

fn status(app: &AppHandle) -> Status {
    let command = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    Status {
        schedule: app.state::<Settings>().get().email,
        servers: apps::claude_code_servers(),
        claude_code_connected: apps::statuses(&command)
            .iter()
            .any(|a| a.id == "claude_code" && a.connected),
        running: RUNNING.load(Ordering::SeqCst),
    }
}

/// What the user can change.
#[derive(Debug, Clone, Deserialize)]
pub struct Change {
    pub enabled: bool,
    pub start: String,
    pub end: String,
    pub interval: u32,
    pub weekdays_only: bool,
    pub server: Option<String>,
}

#[tauri::command]
pub fn email_tasks_status(app: AppHandle) -> Status {
    status(&app)
}

#[tauri::command]
pub fn email_tasks_set(app: AppHandle, change: Change) -> Result<Status, String> {
    let (start, end) = match (time(&change.start), time(&change.end)) {
        (Some(a), Some(b)) if a < b => (change.start, change.end),
        _ => return Err("Pick a start time before the end time.".into()),
    };
    let interval = match change.interval {
        15 | 30 | 60 => change.interval,
        _ => 30,
    };
    let server = change
        .server
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || "-_.".contains(c)));
    app.state::<Settings>().update(|s| {
        s.email.enabled = change.enabled;
        s.email.start = start;
        s.email.end = end;
        s.email.interval = interval;
        s.email.weekdays_only = change.weekdays_only;
        s.email.server = server;
        // Tasks from the runs need agent access.
        if change.enabled {
            s.agents_enabled = true;
        }
    });
    Ok(status(&app))
}

/// "Check now", outside the schedule.
#[tauri::command]
pub async fn email_tasks_run_now(app: AppHandle) -> Status {
    let a = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || run_and_record(&a)).await;
    status(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, LOCAL).unwrap()
    }

    #[test]
    fn slots_every_half_hour_nine_to_five() {
        let s = EmailSchedule::default();
        assert_eq!(current_slot(at("2026-10-16T08:59:00"), &s), None);
        assert_eq!(
            current_slot(at("2026-10-16T09:00:00"), &s),
            Some(at("2026-10-16T09:00:00"))
        );
        assert_eq!(
            current_slot(at("2026-10-16T09:44:00"), &s),
            Some(at("2026-10-16T09:30:00"))
        );
        assert_eq!(
            current_slot(at("2026-10-16T17:00:30"), &s),
            Some(at("2026-10-16T17:00:00"))
        );
        assert_eq!(current_slot(at("2026-10-16T17:31:00"), &s), None);
        // Saturday.
        let weekdays = EmailSchedule {
            weekdays_only: true,
            ..EmailSchedule::default()
        };
        assert_eq!(current_slot(at("2026-10-17T10:00:00"), &weekdays), None);
        assert!(current_slot(at("2026-10-16T10:00:00"), &weekdays).is_some());
    }

    #[test]
    fn runs_once_per_slot() {
        let mut s = EmailSchedule::default();
        assert!(due(at("2026-10-16T09:01:00"), &s));
        s.last = Some(EmailRun {
            at: "2026-10-16T09:01:00".into(),
            ok: false,
            message: String::new(),
        });
        assert!(!due(at("2026-10-16T09:29:00"), &s));
        assert!(due(at("2026-10-16T09:30:00"), &s));
        assert!(!due(at("2026-10-16T20:00:00"), &s));
    }

    #[test]
    fn reads_mail_since_the_last_good_run() {
        let now = at("2026-10-16T10:00:00");
        assert_eq!(window(now, None), "emails I received today");
        assert_eq!(
            window(now, Some("2026-10-16T09:30:12")),
            "emails I received since 2026-10-16T09:30 (my local time)"
        );
        // Back from a week away: only the last few days.
        assert_eq!(
            window(now, Some("2026-10-02T17:00:00")),
            "emails I received since 2026-10-13T00:00 (my local time)"
        );
    }

    #[test]
    fn understands_the_result() {
        assert_eq!(
            outcome("…\nSent 2 tasks to Plucky.\n", "outlook"),
            (true, "Sent 2 tasks to Plucky.".into())
        );
        assert!(!outcome("NO_EMAIL_TOOL\n", "outlook").0);
    }
}
