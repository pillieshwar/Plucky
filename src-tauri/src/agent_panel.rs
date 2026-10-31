//! The agent panel: terminals inside TodoCity for AI agents (Claude Code,
//! Codex, Gemini CLI, Cursor Agent) or a plain shell, and "Send to agent",
//! which starts an agent on one task.
//!
//! Every agent session has TodoCity's MCP server: before starting an agent,
//! TodoCity connects it (Settings → Connectors → AI agents) if it isn't yet,
//! or hands the server over for the session (Codex). What the agent may do
//! with tasks still follows the person's settings: add for review, or full
//! access.
//!
//! A task sent to an agent becomes a *run* (`todocity_core::agent_runs`):
//! working while the agent's terminal is busy, needs you when it goes quiet
//! or asks, ready when it reports it's done, paused when its terminal
//! closes first. Runs never change the task; the person marks it done.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use todocity_core::agent_runs::{self, AgentCli, AgentRun, RunStatus};

use crate::agents::apps;
use crate::settings::Settings;

/// Output kept per terminal, to show again when the panel reopens.
const KEEP_OUTPUT: usize = 512 * 1024;
/// A working agent this quiet is waiting for the person.
const QUIET: Duration = Duration::from_secs(20);

/// A terminal, as the panel shows it.
#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: u32,
    /// An agent id (`claude`, `codex`…), or none for a plain terminal.
    pub agent: Option<String>,
    /// "Claude Code", or "Terminal".
    pub name: String,
    /// The task's title for "Send to agent", else the folder's name.
    pub title: String,
    pub folder: String,
    pub task_id: Option<i64>,
    pub run_id: Option<i64>,
    pub alive: bool,
}

struct Session {
    info: SessionInfo,
    writer: File,
    master: File,
    pid: u32,
    output: Vec<u8>,
    /// Bytes of text shown since it started (to join replay and live output).
    total: u64,
    last_output: Instant,
    /// Set when the panel marked the run "needs you" for going quiet.
    quiet_since: Option<Instant>,
}

#[derive(Default)]
struct Inner {
    next: u32,
    sessions: BTreeMap<u32, Session>,
    /// Which agents are installed (cached after the first look).
    installed: Option<Vec<String>>,
}

#[derive(Default)]
pub struct Sessions {
    inner: Arc<Mutex<Inner>>,
}

/// An agent the panel can start, and whether it's on this Mac.
#[derive(Debug, Clone, Serialize)]
pub struct CliStatus {
    pub id: &'static str,
    pub name: &'static str,
    pub installed: bool,
}

/// A run, as the task shows it.
#[derive(Debug, Clone, Serialize)]
pub struct RunInfo {
    #[serde(flatten)]
    pub run: AgentRun,
    pub agent_name: String,
    /// The open terminal it's in, if any.
    pub session: Option<u32>,
}

#[derive(Clone, Serialize)]
struct Output {
    id: u32,
    data: String,
    /// Where this text ends, counted from the start of the terminal.
    end: u64,
}

/// What a terminal has shown recently, and where that ends.
#[derive(Clone, Serialize)]
pub struct Replay {
    pub data: String,
    pub end: u64,
}

fn lock(s: &Sessions) -> std::sync::MutexGuard<'_, Inner> {
    s.inner.lock().unwrap_or_else(|e| e.into_inner())
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| s.starts_with('/') && Path::new(s).is_file())
        .unwrap_or_else(|| "/bin/zsh".into())
}

fn agent_name(id: &str) -> String {
    agent_runs::cli(id)
        .map(|c| c.name.to_string())
        .unwrap_or_else(|| id.to_string())
}

/// Split `bytes` into the text that's complete and the start of a character
/// that's still arriving.
fn take_text(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let s = s.to_string();
            pending.clear();
            s
        }
        Err(e) if e.error_len().is_none() => {
            let cut = e.valid_up_to();
            let rest = pending.split_off(cut);
            let s = String::from_utf8_lossy(pending).into_owned();
            *pending = rest;
            s
        }
        Err(_) => {
            let s = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            s
        }
    }
}

fn emit_runs(app: &AppHandle) {
    let _ = app.emit("agent-runs", ());
}

fn with_store<T>(
    app: &AppHandle,
    f: impl FnOnce(&todocity_core::store::Store) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<crate::AppState>();
    let store = state
        .store
        .lock()
        .map_err(|_| "TodoCity is busy; try again.".to_string())?;
    f(&store)
}

// ── Finding agents ────────────────────────────────────────────────────────

/// Where command-line tools usually live, for a Mac app that doesn't get
/// the shell's PATH.
fn usual_places(home: &Path, binary: &str) -> Vec<PathBuf> {
    vec![
        home.join(".local/bin").join(binary),
        home.join(".claude/local").join(binary),
        PathBuf::from("/opt/homebrew/bin").join(binary),
        PathBuf::from("/usr/local/bin").join(binary),
        home.join(".npm-global/bin").join(binary),
        home.join(".volta/bin").join(binary),
        home.join(".bun/bin").join(binary),
        home.join(".cargo/bin").join(binary),
    ]
}

/// Which agents are installed: the usual places, then the person's own
/// shell (which knows nvm, asdf and the like).
fn find_installed() -> Vec<String> {
    let home = home();
    let mut found: Vec<String> = agent_runs::CLIS
        .iter()
        .filter(|c| usual_places(&home, c.binary).iter().any(|p| p.is_file()))
        .map(|c| c.id.to_string())
        .collect();
    if found.len() < agent_runs::CLIS.len() {
        let names: Vec<&str> = agent_runs::CLIS.iter().map(|c| c.binary).collect();
        let script = format!(
            "for b in {}; do command -v \"$b\" >/dev/null 2>&1 && echo \"$b\"; done",
            names.join(" ")
        );
        if let Ok(out) = apps::run(
            std::process::Command::new(shell()).args(["-l", "-i", "-c", &script]),
            Duration::from_secs(8),
        ) {
            for line in out.lines() {
                if let Some(c) = agent_runs::CLIS.iter().find(|c| c.binary == line.trim()) {
                    if !found.iter().any(|f| f == c.id) {
                        found.push(c.id.to_string());
                    }
                }
            }
        }
    }
    found
}

/// The agents the panel offers, and which are installed.
#[tauri::command]
pub async fn agent_clis(
    sessions: State<'_, Sessions>,
    refresh: bool,
) -> Result<Vec<CliStatus>, String> {
    let cached = lock(&sessions).installed.clone();
    let installed = match cached {
        Some(list) if !refresh => list,
        _ => {
            let list = tauri::async_runtime::spawn_blocking(find_installed)
                .await
                .map_err(|e| e.to_string())?;
            lock(&sessions).installed = Some(list.clone());
            list
        }
    };
    Ok(agent_runs::CLIS
        .iter()
        .map(|c| CliStatus {
            id: c.id,
            name: c.name,
            installed: installed.iter().any(|i| i == c.id),
        })
        .collect())
}

// ── TodoCity's MCP server in every agent ──────────────────────────────────

/// Make sure `cli` will have TodoCity's MCP server: connect it the way
/// Connectors → AI agents does if it isn't yet (or points at an old copy).
/// Agents without a settings file TodoCity edits get it per session instead
/// (see `agent_runs::launch_args`).
fn ensure_mcp(app: &AppHandle, cli: &AgentCli) -> Result<(), String> {
    let settings = app.state::<Settings>();
    if !settings.get().agents_enabled {
        settings.update(|s| s.agents_enabled = true);
        let _ = app.emit("agent-changes", ());
    }
    let Some(connector) = cli.connector else {
        return Ok(());
    };
    let command = crate::agents::exe_path();
    let ready = apps::statuses(&command)
        .into_iter()
        .any(|a| a.id == connector && a.connected && !a.stale);
    if ready {
        return Ok(());
    }
    crate::agents::refuse_temporary(&command)?;
    let proactive = settings.get().agents_proactive;
    apps::connect(connector, &command, proactive)
        .map_err(|e| format!("Couldn't connect {} to TodoCity: {e}", cli.name))?;
    log::info!("connected {} to TodoCity for the agent panel", cli.name);
    Ok(())
}

// ── Terminals ─────────────────────────────────────────────────────────────

/// What to run: the person's login shell, starting the agent (with a friendly
/// line if it isn't installed), or just the shell.
fn command_line(cli: Option<&AgentCli>, args: &[String]) -> (String, Vec<String>) {
    let sh = shell();
    match cli {
        None => (sh, vec!["-l".into()]),
        Some(c) => {
            let script = format!(
                "command -v \"$0\" >/dev/null 2>&1 || {{ printf '\\n  Install %s first, then start it again from TodoCity.\\n\\n' '{}'; exit 127; }}; exec \"$0\" \"$@\"",
                c.name
            );
            let mut v = vec![
                "-l".into(),
                "-i".into(),
                "-c".into(),
                script,
                c.binary.into(),
            ];
            v.extend(args.iter().cloned());
            (sh, v)
        }
    }
}

fn terminal_env() -> Vec<(String, String)> {
    let mut env = vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
        ("TERM_PROGRAM".to_string(), "TodoCity".to_string()),
    ];
    if std::env::var_os("LANG").is_none() {
        env.push(("LANG".into(), "en_US.UTF-8".into()));
    }
    env
}

/// Read a terminal until its program ends, passing output to the panel.
fn pump(app: AppHandle, inner: Arc<Mutex<Inner>>, id: u32, mut master: File) {
    let mut buf = [0u8; 16 * 1024];
    let mut pending = Vec::new();
    loop {
        match master.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                pending.extend_from_slice(&buf[..n]);
                let text = take_text(&mut pending);
                if text.is_empty() {
                    continue;
                }
                let end = {
                    let mut g = inner.lock().unwrap_or_else(|e| e.into_inner());
                    match g.sessions.get_mut(&id) {
                        Some(s) => {
                            s.output.extend_from_slice(text.as_bytes());
                            if s.output.len() > KEEP_OUTPUT {
                                let cut = s.output.len() - KEEP_OUTPUT;
                                s.output.drain(..cut);
                            }
                            s.total += text.len() as u64;
                            s.last_output = Instant::now();
                            s.total
                        }
                        None => 0,
                    }
                };
                let _ = app.emit(
                    "term-output",
                    Output {
                        id,
                        data: text,
                        end,
                    },
                );
            }
        }
    }
}

/// A terminal's program ended: mark it, and pause its run if unfinished.
fn ended(app: &AppHandle, inner: &Arc<Mutex<Inner>>, id: u32) {
    let run = {
        let mut g = inner.lock().unwrap_or_else(|e| e.into_inner());
        g.sessions.get_mut(&id).and_then(|s| {
            s.info.alive = false;
            s.info.run_id
        })
    };
    if let Some(run) = run {
        let _ = with_store(app, |s| {
            let r = s.run(run).map_err(|e| e.to_string())?;
            if r.status.active() {
                s.set_run_status(run, RunStatus::Paused)
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        });
    }
    let _ = app.emit("term-exit", id);
    emit_runs(app);
}

/// Start a terminal: an agent (`agent` = its id) or a plain shell, in
/// `folder` (home if none). With `task_id`, the agent starts on that task
/// ("Send to agent"), with `extra` added to its first message; without one,
/// `prompt` (a ready-made request like "Plan my day") is its first message.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn term_start(
    app: AppHandle,
    agent: Option<String>,
    folder: Option<String>,
    task_id: Option<i64>,
    extra: Option<String>,
    prompt: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<SessionInfo, String> {
    let cli = match agent.as_deref() {
        Some(id) => Some(agent_runs::cli(id).ok_or("Pick an agent from the list.")?),
        None => None,
    };
    if task_id.is_some() && cli.is_none() {
        return Err("Pick an agent to send the task to.".into());
    }
    let folder = folder
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .map(|f| match f.strip_prefix("~/") {
            Some(rest) => home().join(rest),
            None if f == "~" => home(),
            None => PathBuf::from(f),
        })
        .unwrap_or_else(home);
    if !folder.is_dir() {
        return Err(format!(
            "Pick a folder that exists ({} isn't one).",
            folder.display()
        ));
    }
    if let Some(c) = cli {
        let app2 = app.clone();
        tauri::async_runtime::spawn_blocking(move || ensure_mcp(&app2, c))
            .await
            .map_err(|e| e.to_string())??;
    }

    // "Send to agent": the run, and the task as the first message.
    let folder_text = folder.display().to_string();
    let (run, title, prompt) = match (task_id, cli) {
        (Some(task_id), Some(c)) => {
            let extra = extra.unwrap_or_default();
            let (run, task) = with_store(&app, |s| {
                let task = s.get(task_id).map_err(|e| e.to_string())?;
                let run = s
                    .start_run(task_id, c.id, Some(&folder_text))
                    .map_err(|e| e.to_string())?;
                Ok((run, task))
            })?;
            let prompt = agent_runs::task_prompt(&task, &extra, &run.token);
            (Some(run), task.title, Some(prompt))
        }
        _ => {
            let name = folder
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| folder_text.clone());
            let prompt = prompt
                .map(|p| p.trim().chars().take(4000).collect::<String>())
                .filter(|p| !p.is_empty() && cli.is_some());
            (None, name, prompt)
        }
    };

    let command = crate::agents::exe_path();
    let args = cli
        .map(|c| agent_runs::launch_args(c.id, &command, prompt.as_deref()))
        .unwrap_or_default();
    let (program, argv) = command_line(cli, &args);
    let pty =
        crate::pty::spawn(&program, &argv, &folder, &terminal_env(), cols, rows).map_err(|e| {
            if let Some(r) = &run {
                let _ = with_store(&app, |s| s.remove_run(r.id).map_err(|e| e.to_string()));
            }
            format!("Couldn't open a terminal: {e}")
        })?;

    let sessions = app.state::<Sessions>();
    let inner = sessions.inner.clone();
    let reader = pty.master.try_clone().map_err(|e| e.to_string())?;
    let writer = pty.master.try_clone().map_err(|e| e.to_string())?;
    let pid = pty.child.id();
    let info = {
        let mut g = lock(&sessions);
        g.next += 1;
        let id = g.next;
        let info = SessionInfo {
            id,
            agent: cli.map(|c| c.id.to_string()),
            name: cli
                .map(|c| c.name.to_string())
                .unwrap_or_else(|| "Terminal".into()),
            title,
            folder: folder_text,
            task_id,
            run_id: run.as_ref().map(|r| r.id),
            alive: true,
        };
        g.sessions.insert(
            id,
            Session {
                info: info.clone(),
                writer,
                master: pty.master,
                pid,
                output: Vec::new(),
                total: 0,
                last_output: Instant::now(),
                quiet_since: None,
            },
        );
        info
    };

    let id = info.id;
    {
        let app = app.clone();
        let inner = inner.clone();
        let _ = std::thread::Builder::new()
            .name(format!("term-{id}"))
            .spawn(move || {
                pump(app.clone(), inner.clone(), id, reader);
                let mut child = pty.child;
                let _ = child.wait();
                ended(&app, &inner, id);
            });
    }
    if run.is_some() {
        emit_runs(&app);
    }
    Ok(info)
}

#[tauri::command]
pub fn term_list(sessions: State<'_, Sessions>) -> Vec<SessionInfo> {
    lock(&sessions)
        .sessions
        .values()
        .map(|s| s.info.clone())
        .collect()
}

/// Everything a terminal has shown recently, to draw it again.
#[tauri::command]
pub fn term_attach(sessions: State<'_, Sessions>, id: u32) -> Result<Replay, String> {
    let g = lock(&sessions);
    let s = g.sessions.get(&id).ok_or("That terminal has closed.")?;
    Ok(Replay {
        data: String::from_utf8_lossy(&s.output).into_owned(),
        end: s.total,
    })
}

/// Keystrokes (or pasted text) for a terminal.
#[tauri::command]
pub fn term_write(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let run = {
        let mut g = lock(&sessions);
        let s = g.sessions.get_mut(&id).ok_or("That terminal has closed.")?;
        if !s.info.alive {
            return Ok(());
        }
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        s.quiet_since = None;
        s.info.run_id
    };
    // The person answered: the agent is back at work.
    if let Some(run) = run {
        let changed = with_store(&app, |s| {
            let r = s.run(run).map_err(|e| e.to_string())?;
            if r.status == RunStatus::NeedsYou {
                s.set_run_status(run, RunStatus::Working)
                    .map_err(|e| e.to_string())?;
                return Ok(true);
            }
            Ok(false)
        })
        .unwrap_or(false);
        if changed {
            emit_runs(&app);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn term_resize(
    sessions: State<'_, Sessions>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let g = lock(&sessions);
    let s = g.sessions.get(&id).ok_or("That terminal has closed.")?;
    if s.info.alive {
        crate::pty::resize(&s.master, cols, rows).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Close a terminal (ending its program, like closing a Terminal window).
#[tauri::command]
pub fn term_close(app: AppHandle, sessions: State<'_, Sessions>, id: u32) {
    let removed = lock(&sessions).sessions.remove(&id);
    if let Some(s) = removed {
        if s.info.alive {
            crate::pty::hang_up(s.pid);
        }
        if let Some(run) = s.info.run_id {
            let _ = with_store(&app, |st| {
                let r = st.run(run).map_err(|e| e.to_string())?;
                if r.status.active() {
                    st.set_run_status(run, RunStatus::Paused)
                        .map_err(|e| e.to_string())?;
                }
                Ok(())
            });
            emit_runs(&app);
        }
    }
}

/// Every few seconds: a working agent that has gone quiet is waiting for
/// the person; one that starts talking again on its own is back at work.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("agent-quiet".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(3));
            let sessions = app.state::<Sessions>();
            let watch: Vec<(u32, i64, Instant, Option<Instant>)> = lock(&sessions)
                .sessions
                .values()
                .filter(|s| s.info.alive)
                .filter_map(|s| Some((s.info.id, s.info.run_id?, s.last_output, s.quiet_since)))
                .collect();
            let mut changed = false;
            for (id, run, last, quiet_since) in watch {
                let Ok(r) = with_store(&app, |s| s.run(run).map_err(|e| e.to_string())) else {
                    continue;
                };
                // Quiet while working: waiting for you. Talking again on
                // its own after that: back at work.
                let next = if r.status == RunStatus::Working && last.elapsed() >= QUIET {
                    Some((RunStatus::NeedsYou, Some(Instant::now())))
                } else if r.status == RunStatus::NeedsYou
                    && quiet_since.is_some_and(|q| last > q + Duration::from_secs(2))
                {
                    Some((RunStatus::Working, None))
                } else {
                    None
                };
                let Some((status, quiet)) = next else {
                    continue;
                };
                let saved = with_store(&app, |s| {
                    s.set_run_status(run, status).map_err(|e| e.to_string())
                });
                if saved.is_ok() {
                    if let Some(s) = lock(&sessions).sessions.get_mut(&id) {
                        s.quiet_since = quiet;
                    }
                    changed = true;
                }
            }
            if changed {
                emit_runs(&app);
            }
        });
}

// ── Runs ──────────────────────────────────────────────────────────────────

/// Tasks handed to agents, with where each one is.
#[tauri::command]
pub fn agent_run_list(
    app: AppHandle,
    sessions: State<'_, Sessions>,
) -> Result<Vec<RunInfo>, String> {
    let live: BTreeMap<i64, u32> = lock(&sessions)
        .sessions
        .values()
        .filter_map(|s| Some((s.info.run_id?, s.info.id)))
        .collect();
    let alive: Vec<i64> = lock(&sessions)
        .sessions
        .values()
        .filter(|s| s.info.alive)
        .filter_map(|s| s.info.run_id)
        .collect();
    with_store(&app, |s| {
        let runs = s.recent_runs().map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(runs.len());
        for mut run in runs {
            // Its terminal is gone (TodoCity restarted): it's paused.
            if run.status.active() && !alive.contains(&run.id) {
                run = s
                    .set_run_status(run.id, RunStatus::Paused)
                    .map_err(|e| e.to_string())?;
            }
            out.push(RunInfo {
                agent_name: agent_name(&run.agent),
                session: live.get(&run.id).copied(),
                run,
            });
        }
        Ok(out)
    })
}

/// The person is done with a run: it leaves the task.
#[tauri::command]
pub fn agent_run_dismiss(app: AppHandle, id: i64) -> Result<(), String> {
    with_store(&app, |s| s.remove_run(id).map_err(|e| e.to_string()))?;
    emit_runs(&app);
    Ok(())
}

/// `report_progress` from an agent's MCP server: what it says about a run.
pub fn on_report(app: &AppHandle, args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let token = args["run"].as_str().unwrap_or_default();
    let status = args["status"].as_str().unwrap_or_default();
    let summary = args["summary"].as_str();
    let links: Vec<String> = args["links"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let (run, title) = with_store(app, |s| {
        let run = s.report_run(token, status, summary, &links)?;
        let title = s.get(run.task_id).map(|t| t.title).unwrap_or_default();
        Ok((run, title))
    })?;
    // It spoke up: it isn't just quiet any more.
    {
        let sessions = app.state::<Sessions>();
        let mut g = lock(&sessions);
        for s in g.sessions.values_mut() {
            if s.info.run_id == Some(run.id) {
                s.quiet_since = None;
                s.last_output = Instant::now();
            }
        }
    }
    let name = agent_name(&run.agent);
    match run.status {
        RunStatus::Ready => crate::notifications::send_plain(
            app,
            &format!("todocity-run-{}", run.id),
            "Ready to review".into(),
            format!("{name} finished “{title}”."),
        ),
        RunStatus::NeedsYou => crate::notifications::send_plain(
            app,
            &format!("todocity-run-{}", run.id),
            format!("{name} needs you"),
            run.summary.clone().unwrap_or(title),
        ),
        _ => {}
    }
    emit_runs(app);
    Ok(serde_json::json!({
        "ok": true,
        "message": "TodoCity shows this on the task. The user marks it done after reviewing."
    }))
}

/// Ask the person to pick a folder (macOS's own folder picker).
#[tauri::command]
pub async fn pick_folder() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let out = tauri::async_runtime::spawn_blocking(|| {
            apps::run(
                std::process::Command::new("/usr/bin/osascript").args([
                    "-e",
                    "POSIX path of (choose folder with prompt \"Pick the folder the agent works in\")",
                ]),
                Duration::from_secs(600),
            )
        })
        .await
        .map_err(|e| e.to_string())?;
        // Cancelled: no folder, no error.
        Ok(out
            .ok()
            .map(|p| p.trim().trim_end_matches('/').to_string())
            .filter(|p| !p.is_empty()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

/// Your home folder, for the folder field.
#[tauri::command]
pub fn home_folder() -> String {
    home().display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_waits_for_whole_characters() {
        let mut p = "héllo".as_bytes().to_vec();
        p.extend_from_slice(&"✓".as_bytes()[..2]);
        assert_eq!(take_text(&mut p), "héllo");
        assert_eq!(p.len(), 2);
        p.push("✓".as_bytes()[2]);
        assert_eq!(take_text(&mut p), "✓");
        assert!(p.is_empty());
        // Bytes that can never be text don't hold the rest back.
        let mut bad = vec![b'a', 0xff, b'b'];
        assert_eq!(take_text(&mut bad), "a\u{fffd}b");
        assert!(bad.is_empty());
    }

    #[test]
    fn agents_start_through_the_login_shell() {
        let claude = agent_runs::cli("claude").unwrap();
        let (_, argv) = command_line(Some(claude), &["Fix it".into()]);
        assert_eq!(&argv[..3], ["-l", "-i", "-c"]);
        assert!(argv[3].contains("exec \"$0\" \"$@\""));
        assert!(argv[3].contains("Install %s first") && argv[3].contains("'Claude Code'"));
        assert_eq!(argv[4], "claude");
        assert_eq!(argv[5], "Fix it");
        let (_, plain) = command_line(None, &[]);
        assert_eq!(plain, vec!["-l"]);
    }

    #[test]
    fn the_first_message_is_one_argument_never_shell_text() {
        let claude = agent_runs::cli("claude").unwrap();
        let tricky = "Fix it\"; rm -rf ~; echo \"$(whoami)";
        let (_, argv) = command_line(Some(claude), &[tricky.into()]);
        assert_eq!(argv.last().unwrap(), tricky);
        assert!(!argv[3].contains("rm -rf"));
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_script_runs_the_agent_with_its_arguments() {
        // The same script, with `printf` standing in for the agent.
        let script = "command -v \"$0\" >/dev/null 2>&1 || exit 127; exec \"$0\" \"$@\"";
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", script, "printf", "%s|", "a b", "c\"d"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "a b|c\"d|");
        let missing = std::process::Command::new("/bin/sh")
            .args(["-c", script, "no-such-agent-here"])
            .status()
            .unwrap();
        assert_eq!(missing.code(), Some(127));
    }
}
