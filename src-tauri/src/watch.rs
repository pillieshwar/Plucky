//! Watch mode: notice to-dos in Slack and Outlook as they appear.
//!
//! Every few seconds, if the frontmost window belongs to a watched app,
//! Plucky reads its visible static text through Accessibility — the same
//! permission the capture shortcut uses. No screenshots, no recording, never
//! text fields or password fields. When the window settles, only lines that
//! weren't there before are considered; a cheap keyword check skips most of
//! them, and the rest go to the on-device model, which returns zero to three
//! to-dos. Those land in the review inbox; nothing joins the list without
//! the user. The text itself is never stored, logged or sent anywhere.

// Reading other apps' windows is macOS-only; elsewhere most of this is unused.
#![cfg_attr(not(target_os = "macos"), allow(dead_code, unused_imports))]

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{Local, NaiveDateTime};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::agents::{Agents, TaskDraft};
use crate::engine::Engine;
use crate::models::ModelManager;
use crate::settings::{Settings, WatchSettings};

/// Apps watch mode supports: bundle id, name, where it's usually installed.
pub const APPS: &[(&str, &str, &str)] = &[
    ("com.tinyspeck.slackmacgap", "Slack", "Slack.app"),
    ("com.microsoft.Outlook", "Outlook", "Microsoft Outlook.app"),
];

const POLL: Duration = Duration::from_secs(3);
/// The window must look the same this long before Plucky reads new lines,
/// so half-loaded channels and scrolling don't count.
const SETTLE: Duration = Duration::from_secs(4);
const MAX_NODES: usize = 2500;
const READ_BUDGET: Duration = Duration::from_millis(700);
/// Lines remembered per window, so the same message is looked at once.
const SEEN_PER_WINDOW: usize = 6000;
const MAX_WINDOWS: usize = 40;
const LOCAL: &str = "%Y-%m-%dT%H:%M:%S";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Off,
    Watching,
    Paused,
    OnBattery,
    NoModel,
    NoAccess,
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
pub struct Live {
    pub state: State,
    /// The watched app in front right now, if any.
    pub current: Option<String>,
    /// When the last to-do was noticed, local time.
    pub last_found: Option<String>,
}

static LIVE: Mutex<Live> = Mutex::new(Live {
    state: State::Off,
    current: None,
    last_found: None,
});

fn set_live(app: &AppHandle, state: State, current: Option<String>) {
    let changed = match LIVE.lock() {
        Ok(mut l) => {
            let changed = l.state != state || l.current != current;
            l.state = state;
            l.current = current;
            changed
        }
        Err(_) => false,
    };
    if changed {
        let _ = app.emit("watch-changed", ());
    }
}

fn hash<T: Hash + ?Sized>(t: &T) -> u64 {
    let mut h = DefaultHasher::new();
    t.hash(&mut h);
    h.finish()
}

/// What Plucky remembers about one window: hashes of lines it has seen
/// (never the text), and what the window looked like on the last read.
#[derive(Default)]
struct Window {
    seen: HashSet<u64>,
    order: VecDeque<u64>,
    /// Hash of the whole window and since when it's looked like that.
    shape: Option<(u64, Instant)>,
    /// The first read only records what's already there.
    primed: bool,
    used: Option<Instant>,
}

impl Window {
    fn remember(&mut self, h: u64) -> bool {
        if !self.seen.insert(h) {
            return false;
        }
        self.order.push_back(h);
        while self.order.len() > SEEN_PER_WINDOW {
            if let Some(old) = self.order.pop_front() {
                self.seen.remove(&old);
            }
        }
        true
    }
}

/// Decide which lines are new once the window has settled (their indexes).
/// Pure, so the rules are tested without a screen.
fn new_lines(win: &mut Window, lines: &[String], now: Instant) -> Option<Vec<usize>> {
    win.used = Some(now);
    let shape = hash(lines);
    match win.shape {
        Some((s, since)) if s == shape => {
            if now.duration_since(since) < SETTLE {
                return None;
            }
        }
        _ => {
            win.shape = Some((shape, now));
            return None;
        }
    }
    if !win.primed {
        win.primed = true;
        for l in lines {
            win.remember(hash(l.as_str()));
        }
        return None;
    }
    let fresh: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| win.remember(hash(l.as_str())))
        .map(|(i, _)| i)
        .collect();
    (!fresh.is_empty()).then_some(fresh)
}

/// How many earlier messages go with the new ones, for context.
const CONTEXT_MESSAGES: usize = 8;

/// Split the window into earlier and new messages, each as `Speaker: text`.
/// `None` unless a new message looks like a request, deadline or promise.
fn conversation(lines: &[String], fresh: &[usize]) -> Option<(Vec<String>, Vec<String>)> {
    use pluck_core::transcript::structure;
    let fresh: HashSet<usize> = fresh.iter().copied().collect();
    let render = |speaker: &Option<String>, parts: &[&str]| -> String {
        let text = parts.join("\n");
        match speaker {
            Some(s) => format!("{s}: {text}"),
            None => text,
        }
    };
    let mut earlier = Vec::new();
    let mut new = Vec::new();
    for m in structure(lines) {
        // The text lines of the message (not the name line that starts it).
        let text_lines: Vec<usize> = m
            .lines
            .iter()
            .copied()
            .filter(|&i| m.speaker.as_deref() != Some(lines[i].trim()))
            .collect();
        let (new_parts, old_parts): (Vec<usize>, Vec<usize>) =
            text_lines.into_iter().partition(|i| fresh.contains(i));
        let old: Vec<&str> = old_parts.iter().map(|&i| lines[i].trim()).collect();
        let neu: Vec<&str> = new_parts.iter().map(|&i| lines[i].trim()).collect();
        if !old.is_empty() {
            earlier.push(render(&m.speaker, &old));
        }
        if !neu.is_empty() {
            new.push(render(&m.speaker, &neu));
        }
    }
    if !new.iter().any(|l| pluck_core::prompt::has_task_cue(l)) {
        return None;
    }
    let skip = earlier.len().saturating_sub(CONTEXT_MESSAGES);
    Some((earlier.split_off(skip), new))
}

/// The user's names in `bundle`'s app: what they typed in the connector,
/// or their Mac account's full name.
fn user_names(s: &WatchSettings, bundle: &str) -> Vec<String> {
    let typed = s
        .names
        .get(bundle)
        .map(|n| pluck_core::transcript::split_names(n.as_str()))
        .unwrap_or_default();
    if typed.is_empty() {
        mac_full_name().into_iter().collect()
    } else {
        typed
    }
}

/// The Mac account's full name ("Sam Rivera"), looked up once.
pub fn mac_full_name() -> Option<String> {
    static NAME: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        if !cfg!(target_os = "macos") {
            return None;
        }
        let out = std::process::Command::new("/usr/bin/id")
            .arg("-F")
            .output()
            .ok()?;
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !name.is_empty() && name.chars().count() <= 80).then_some(name)
    })
    .clone()
}

fn paused(s: &WatchSettings, now: NaiveDateTime) -> bool {
    s.paused_until
        .as_deref()
        .and_then(|p| NaiveDateTime::parse_from_str(p, LOCAL).ok())
        .is_some_and(|until| now < until)
}

#[cfg(target_os = "macos")]
fn on_power() -> bool {
    use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPSCopyPowerSourcesInfo() -> CFTypeRef;
        fn IOPSGetProvidingPowerSourceType(blob: CFTypeRef) -> CFStringRef;
    }
    unsafe {
        let blob = IOPSCopyPowerSourcesInfo();
        if blob.is_null() {
            return true;
        }
        let kind = IOPSGetProvidingPowerSourceType(blob);
        let on_ac = kind.is_null() || CFString::wrap_under_get_rule(kind) == "AC Power";
        CFRelease(blob);
        on_ac
    }
}

#[cfg(not(target_os = "macos"))]
fn on_power() -> bool {
    true
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("watch".into())
        .spawn(move || run(&app));
    if let Err(e) = spawned {
        log::warn!("could not start watch mode: {e}");
    }
}

fn run(app: &AppHandle) {
    let mut windows: HashMap<u64, Window> = HashMap::new();
    loop {
        std::thread::sleep(POLL);
        let s = app.state::<Settings>().get().watch;
        if !s.enabled {
            windows.clear();
            set_live(app, State::Off, None);
            continue;
        }
        if !cfg!(target_os = "macos") {
            set_live(app, State::Unsupported, None);
            continue;
        }
        if paused(&s, Local::now().naive_local()) {
            set_live(app, State::Paused, None);
            continue;
        }
        if s.plugged_in_only && !on_power() {
            set_live(app, State::OnBattery, None);
            continue;
        }
        if !crate::capture::accessibility_trusted(false) {
            set_live(app, State::NoAccess, None);
            continue;
        }
        // A downloaded model, or the developer's Ollama.
        let model = match app.state::<ModelManager>().active() {
            Some(m) => m.path,
            None if app.state::<Engine>().kind() == "ollama" => Default::default(),
            None => {
                set_live(app, State::NoModel, None);
                continue;
            }
        };
        tick(app, &s, &model, &mut windows);
    }
}

#[cfg(target_os = "macos")]
fn tick(
    app: &AppHandle,
    s: &WatchSettings,
    model: &std::path::Path,
    windows: &mut HashMap<u64, Window>,
) {
    let read = crate::capture::front_window_text(&s.apps, MAX_NODES, READ_BUDGET);
    let Some(read) = read else {
        set_live(app, State::Watching, None);
        return;
    };
    set_live(app, State::Watching, Some(read.app.clone()));
    let key = hash(&(read.bundle.as_str(), read.title.as_str()));
    let now = Instant::now();
    if windows.len() > MAX_WINDOWS && !windows.contains_key(&key) {
        // Forget the window used longest ago.
        if let Some(old) = windows.iter().min_by_key(|(_, w)| w.used).map(|(k, _)| *k) {
            windows.remove(&old);
        }
    }
    let win = windows.entry(key).or_default();
    let Some(fresh) = new_lines(win, &read.lines, now) else {
        return;
    };
    let Some((earlier, new)) = conversation(&read.lines, &fresh) else {
        return;
    };
    let user = user_names(s, &read.bundle);
    let engine = app.state::<Engine>();
    let found = tauri::async_runtime::block_on(
        engine.find_actions(model, &read.app, &user, &earlier, &new),
    );
    let actions = match found {
        Ok(a) => a,
        Err(e) => {
            log::warn!("watch: model failed: {e}");
            return;
        }
    };
    let agents = app.state::<Agents>();
    let mut added = 0;
    for a in actions {
        let draft = TaskDraft {
            title: a.task,
            date_text: a.date_text,
            notes: Some(if read.title.is_empty() {
                format!("Noticed in {}", read.app)
            } else {
                format!("Noticed in {} · {}", read.app, read.title)
            }),
            ..Default::default()
        };
        match agents.receive_watch(&read.app, draft) {
            Ok(true) => added += 1,
            Ok(false) => {}
            Err(e) => log::warn!("watch: {e}"),
        }
    }
    if added == 0 {
        return;
    }
    log::info!("watch: noticed {added} to-do(s) in {}", read.app);
    if let Ok(mut l) = LIVE.lock() {
        l.last_found = Some(Local::now().format(LOCAL).to_string());
    }
    let _ = app.emit("inbox-changed", ());
    let _ = app.emit("watch-changed", ());
    crate::tray::refresh(app);
    if s.show_right_away {
        crate::popover::show_focus(app, crate::popover::Focus::Inbox);
    }
}

#[cfg(not(target_os = "macos"))]
fn tick(_: &AppHandle, _: &WatchSettings, _: &std::path::Path, _: &mut HashMap<u64, Window>) {}

// ── Commands ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct WatchApp {
    pub bundle: &'static str,
    pub name: &'static str,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub supported: bool,
    /// The Mac account's full name, the default for "your name".
    pub default_name: Option<String>,
    /// The model in use, so the UI can suggest a better one for watching.
    pub model: Option<String>,
    pub settings: WatchSettings,
    pub apps: Vec<WatchApp>,
    pub live: Live,
}

fn installed(file: &str) -> bool {
    std::path::Path::new("/Applications").join(file).exists()
        || std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .is_some_and(|h| h.join("Applications").join(file).exists())
}

fn status(app: &AppHandle) -> Status {
    let live = LIVE.lock().map(|l| l.clone()).unwrap_or(Live {
        state: State::Off,
        current: None,
        last_found: None,
    });
    Status {
        supported: cfg!(target_os = "macos"),
        default_name: mac_full_name(),
        model: app.state::<ModelManager>().active().map(|m| m.id),
        settings: app.state::<Settings>().get().watch,
        apps: APPS
            .iter()
            .map(|(bundle, name, file)| WatchApp {
                bundle,
                name,
                installed: installed(file),
            })
            .collect(),
        live,
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Change {
    pub enabled: bool,
    pub apps: Vec<String>,
    pub plugged_in_only: bool,
    pub show_right_away: bool,
    /// Your name in each app, by bundle id.
    #[serde(default)]
    pub names: std::collections::BTreeMap<String, String>,
}

#[tauri::command]
pub fn watch_status(app: AppHandle) -> Status {
    status(&app)
}

#[tauri::command]
pub fn watch_set(app: AppHandle, change: Change) -> Status {
    let apps: Vec<String> = change
        .apps
        .into_iter()
        .filter(|a| APPS.iter().any(|(b, _, _)| b == a))
        .collect();
    app.state::<Settings>().update(|s| {
        s.watch.enabled = change.enabled;
        s.watch.apps = apps;
        s.watch.plugged_in_only = change.plugged_in_only;
        s.watch.show_right_away = change.show_right_away;
        s.watch.names = change
            .names
            .into_iter()
            .filter(|(b, _)| APPS.iter().any(|(id, _, _)| id == b))
            .map(|(b, n)| (b, n.trim().chars().take(200).collect::<String>()))
            .filter(|(_, n)| !n.is_empty())
            .collect();
        if !change.enabled {
            s.watch.paused_until = None;
        }
    });
    let _ = app.emit("watch-changed", ());
    status(&app)
}

/// Pause for `minutes` (at most a day), or resume with `minutes: 0`.
#[tauri::command]
pub fn watch_pause(app: AppHandle, minutes: u32) -> Status {
    let until = (minutes > 0).then(|| {
        (Local::now().naive_local() + chrono::Duration::minutes(i64::from(minutes.min(24 * 60))))
            .format(LOCAL)
            .to_string()
    });
    app.state::<Settings>()
        .update(|s| s.watch.paused_until = until);
    let _ = app.emit("watch-changed", ());
    status(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn waits_to_settle_then_primes_then_finds_only_new_lines() {
        let mut w = Window::default();
        let t0 = Instant::now();
        let a = lines(&["#general", "Priya: morning!"]);
        // First sight, then settled: just remembered, nothing reported.
        assert!(new_lines(&mut w, &a, t0).is_none());
        assert!(new_lines(&mut w, &a, t0 + SETTLE).is_none());
        // A new message, still changing: wait.
        let b = lines(&[
            "#general",
            "Priya: morning!",
            "Priya: can you send the deck by Friday?",
        ]);
        assert!(new_lines(&mut w, &b, t0 + SETTLE + POLL).is_none());
        // Settled: only the new line.
        assert_eq!(new_lines(&mut w, &b, t0 + SETTLE * 3).unwrap(), vec![2]);
        // Same window again: nothing new.
        assert!(new_lines(&mut w, &b, t0 + SETTLE * 5).is_none());
    }

    #[test]
    fn new_messages_come_with_earlier_context() {
        let window = lines(&[
            "Thursday, October 15th",
            "Maya Chen",
            "1:49 PM",
            "Hi Sam, we need a way to benchmark the agents.",
            "Please also loop in Lena Ortiz.",
            "Sam Rivera",
            "1:53 PM",
            "Sounds good, I'll set up time with everyone early next week",
            "1",
        ]);
        let (earlier, new) = conversation(&window, &[5, 6, 7, 8]).unwrap();
        assert_eq!(
            earlier,
            vec!["Maya Chen: Hi Sam, we need a way to benchmark the agents.\nPlease also loop in Lena Ortiz."]
        );
        assert_eq!(
            new,
            vec!["Sam Rivera: Sounds good, I'll set up time with everyone early next week"]
        );
        // Nothing that looks like a task: the model isn't asked.
        let chat = lines(&["Jordan Lee", "9:02 AM", "lol nice", "great demo 🎉"]);
        assert!(conversation(&chat, &[3]).is_none());
        // A follow-up in the same block: only the new line is new.
        let block = lines(&[
            "Jordan Lee",
            "9:02 AM",
            "morning!",
            "can you send the notes?",
        ]);
        let (earlier, new) = conversation(&block, &[3]).unwrap();
        assert_eq!(earlier, vec!["Jordan Lee: morning!"]);
        assert_eq!(new, vec!["Jordan Lee: can you send the notes?"]);
    }

    #[test]
    fn names_typed_or_from_the_mac() {
        let mut s = WatchSettings::default();
        s.names.insert(
            "com.microsoft.Outlook".into(),
            "Rivera, Sam; sam@example.com".into(),
        );
        assert_eq!(
            user_names(&s, "com.microsoft.Outlook"),
            vec!["Rivera, Sam", "sam@example.com"]
        );
        // Not typed: the Mac's account name (none in tests off macOS).
        let fallback = user_names(&s, "com.tinyspeck.slackmacgap");
        assert!(fallback.len() <= 1);
    }

    #[test]
    fn pause_until() {
        let mut s = WatchSettings::default();
        let now = NaiveDateTime::parse_from_str("2026-10-16T10:00:00", LOCAL).unwrap();
        assert!(!paused(&s, now));
        s.paused_until = Some("2026-10-16T11:00:00".into());
        assert!(paused(&s, now));
        s.paused_until = Some("2026-10-16T09:00:00".into());
        assert!(!paused(&s, now));
    }
}
