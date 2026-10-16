//! AI agents: a write-only way in.
//!
//! AI apps on this Mac (Claude Desktop, Claude Code, Cursor…) launch
//! `Pluck --mcp`, a tiny MCP server with one tool, `add_task` (see `mcp.rs`).
//! It hands each task to the running app over a Unix socket that only this
//! user can open. The app puts it in an inbox; nothing is added to the task
//! list until the user approves it in the menu-bar dropdown.
//!
//! Write-only means more than "no read tool": every accepted task gets the
//! same reply, with no id, no duplicate check and no counts, so an agent can't
//! learn anything about the user's tasks by probing. Nothing leaves the Mac,
//! and agents in the cloud can't reach it.

// The socket listener is Unix-only; elsewhere most of this is unused.
#![cfg_attr(not(unix), allow(dead_code))]

pub mod mcp;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use pluck_core::NewTask;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::settings::Settings;

pub const SOCKET_NAME: &str = "agents.sock";
const INBOX_FILE: &str = "agent-inbox.json";
/// Waiting tasks kept at most; more are refused until some are reviewed.
const INBOX_MAX: usize = 50;
/// At most this many tasks per `RATE_WINDOW`, from all agents together.
const RATE_MAX: usize = 20;
const RATE_WINDOW: Duration = Duration::from_secs(600);
const TITLE_MAX: usize = 200;
const NOTES_MAX: usize = 2000;
const AGENT_MAX: usize = 40;

/// What `Pluck --mcp` sends to the app: one JSON line per task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Submission {
    /// The AI app, from its MCP `clientInfo` (e.g. "claude-ai").
    pub agent: String,
    pub task: TaskDraft,
}

/// A task as an agent describes it. Deliberately small: no links, tags,
/// repeats or ids.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskDraft {
    pub title: String,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub due_time: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// The app's one-line answer. The same for every accepted task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reply {
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
}

/// Remove control characters; keep newlines only where asked.
fn clean(s: &str, keep_newlines: bool) -> String {
    s.chars()
        .map(|c| if c == '\t' { ' ' } else { c })
        .filter(|c| !c.is_control() || (keep_newlines && *c == '\n'))
        .collect::<String>()
        .trim()
        .to_string()
}

/// Check and tidy a draft. The error text goes back to the agent, so it only
/// talks about the input.
pub fn validate(draft: &TaskDraft) -> Result<TaskDraft, String> {
    let title = clean(&draft.title.replace('\n', " "), false);
    if title.is_empty() {
        return Err("title is required".into());
    }
    if title.chars().count() > TITLE_MAX {
        return Err(format!("title is longer than {TITLE_MAX} characters"));
    }
    let due_date = match draft.due_date.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(d) => {
            chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d")
                .map_err(|_| format!("due_date \"{d}\" is not a YYYY-MM-DD date"))?;
            Some(d.to_string())
        }
    };
    let due_time = match draft.due_time.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(t) => {
            let parsed = chrono::NaiveTime::parse_from_str(t, "%H:%M")
                .map_err(|_| format!("due_time \"{t}\" is not a 24-hour HH:MM time"))?;
            if due_date.is_none() {
                return Err("due_time needs a due_date".into());
            }
            Some(parsed.format("%H:%M").to_string())
        }
    };
    let notes = match draft.notes.as_deref().map(|n| clean(n, true)) {
        None => None,
        Some(n) if n.is_empty() => None,
        Some(n) if n.chars().count() > NOTES_MAX => {
            return Err(format!("notes are longer than {NOTES_MAX} characters"))
        }
        Some(n) => Some(n),
    };
    Ok(TaskDraft {
        title,
        due_date,
        due_time,
        notes,
    })
}

/// "claude-ai" → "Claude", "claude-code" → "Claude Code", "cursor-vscode" →
/// "Cursor Vscode"; never empty.
pub fn agent_label(raw: &str) -> String {
    let raw = clean(raw, false);
    let known = match raw.to_ascii_lowercase().as_str() {
        "claude-ai" | "claude" | "claude-desktop" => Some("Claude"),
        "claude-code" => Some("Claude Code"),
        "cursor" | "cursor-vscode" => Some("Cursor"),
        "vscode" | "visual-studio-code" => Some("VS Code"),
        "zed" => Some("Zed"),
        "goose" => Some("Goose"),
        "lm-studio" | "lmstudio" => Some("LM Studio"),
        _ => None,
    };
    if let Some(k) = known {
        return k.to_string();
    }
    let words: Vec<String> = raw
        .split(|c: char| c == '-' || c == '_' || c.is_whitespace())
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut cs = w.chars();
            match cs.next() {
                Some(f) => f.to_uppercase().chain(cs).collect(),
                None => String::new(),
            }
        })
        .collect();
    let label: String = words.join(" ").chars().take(AGENT_MAX).collect();
    if label.is_empty() {
        "An AI agent".into()
    } else {
        label
    }
}

/// A task waiting for review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboxItem {
    pub id: u64,
    pub title: String,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub notes: Option<String>,
    /// Display name of the AI app that sent it.
    pub agent: String,
    /// Local time, `YYYY-MM-DDTHH:MM:SS`.
    pub received_at: String,
}

#[derive(Default, Serialize, Deserialize)]
struct InboxFile {
    next_id: u64,
    items: Vec<InboxItem>,
}

pub struct Agents {
    path: PathBuf,
    #[cfg_attr(not(unix), allow(dead_code))]
    socket: PathBuf,
    inbox: Mutex<InboxFile>,
    recent: Mutex<VecDeque<Instant>>,
}

impl Agents {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join(INBOX_FILE);
        let inbox = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            path,
            socket: data_dir.join(SOCKET_NAME),
            inbox: Mutex::new(inbox),
            recent: Mutex::new(VecDeque::new()),
        }
    }

    pub fn items(&self) -> Vec<InboxItem> {
        self.inbox
            .lock()
            .map(|i| i.items.clone())
            .unwrap_or_default()
    }

    fn save(&self, inbox: &InboxFile) {
        match serde_json::to_vec_pretty(inbox) {
            Ok(bytes) => {
                if let Err(e) = write_private(&self.path, &bytes) {
                    log::warn!("could not save the agent inbox: {e}");
                }
            }
            Err(e) => log::warn!("could not encode the agent inbox: {e}"),
        }
    }

    /// Take a task into the inbox, within the limits.
    fn receive(&self, agent: &str, draft: TaskDraft) -> Result<(), String> {
        let busy = "Plucky can't take more tasks right now. Try again later.";
        {
            let mut recent = self.recent.lock().map_err(|e| e.to_string())?;
            while recent.front().is_some_and(|t| t.elapsed() > RATE_WINDOW) {
                recent.pop_front();
            }
            if recent.len() >= RATE_MAX {
                return Err(busy.into());
            }
            recent.push_back(Instant::now());
        }
        let mut inbox = self.inbox.lock().map_err(|e| e.to_string())?;
        if inbox.items.len() >= INBOX_MAX {
            return Err(busy.into());
        }
        inbox.next_id += 1;
        let item = InboxItem {
            id: inbox.next_id,
            title: draft.title,
            due_date: draft.due_date,
            due_time: draft.due_time,
            notes: draft.notes,
            agent: agent_label(agent),
            received_at: chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
        };
        inbox.items.push(item);
        self.save(&inbox);
        Ok(())
    }

    fn take(&self, id: u64) -> Option<InboxItem> {
        let mut inbox = self.inbox.lock().ok()?;
        let pos = inbox.items.iter().position(|i| i.id == id)?;
        let item = inbox.items.remove(pos);
        self.save(&inbox);
        Some(item)
    }
}

/// Write a file only this user can read.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)
}

/// Handle one submission from `Pluck --mcp`.
fn on_submission(app: &AppHandle, sub: Submission) -> Reply {
    if !app.state::<Settings>().get().agents_enabled {
        return Reply {
            ok: false,
            error: Some(mcp::NOT_REACHABLE.into()),
        };
    }
    let draft = match validate(&sub.task) {
        Ok(d) => d,
        Err(e) => {
            return Reply {
                ok: false,
                error: Some(e),
            }
        }
    };
    let agents = app.state::<Agents>();
    if let Err(e) = agents.receive(&sub.agent, draft) {
        return Reply {
            ok: false,
            error: Some(e),
        };
    }
    let _ = app.emit("inbox-changed", ());
    crate::tray::refresh(app);
    // Open the dropdown on the inbox (without taking the keyboard), or
    // notify if the menu-bar icon is hidden.
    if !crate::popover::show_focus(app, crate::popover::Focus::Inbox) {
        let n = agents.items().len();
        crate::notifications::send_plain(
            app,
            "pluck-inbox",
            if n == 1 {
                "1 task to review".into()
            } else {
                format!("{n} tasks to review")
            },
            "An AI agent sent tasks to Plucky. Open Plucky to add or discard them.".into(),
        );
    }
    Reply {
        ok: true,
        error: None,
    }
}

/// Listen for `Pluck --mcp` on the private socket.
pub fn start(app: &AppHandle) {
    #[cfg(unix)]
    {
        let socket = app.state::<Agents>().socket.clone();
        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("agents-socket".into())
            .spawn(move || listen(&app, &socket));
        if let Err(e) = spawned {
            log::warn!("could not start the agent listener: {e}");
        }
    }
    #[cfg(not(unix))]
    let _ = app;
}

#[cfg(unix)]
fn listen(app: &AppHandle, socket: &Path) {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};

    // A socket left over from a crash; but not one another Plucky is using.
    if socket.exists() {
        if UnixStream::connect(socket).is_ok() {
            log::warn!("another Plucky is listening for agents; not starting a second listener");
            return;
        }
        let _ = std::fs::remove_file(socket);
    }
    let listener = match UnixListener::bind(socket) {
        Ok(l) => l,
        Err(e) => {
            log::warn!("could not listen for agents at {}: {e}", socket.display());
            return;
        }
    };
    // Only this user can connect.
    if let Err(e) = std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600)) {
        log::warn!("could not restrict the agent socket: {e}");
        return;
    }
    log::info!("listening for AI agents at {}", socket.display());

    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
        let mut line = String::new();
        let read = BufReader::new((&stream).take(16 * 1024)).read_line(&mut line);
        let reply = match read {
            Ok(_) => match serde_json::from_str::<Submission>(&line) {
                Ok(sub) => on_submission(app, sub),
                Err(_) => Reply {
                    ok: false,
                    error: Some("Plucky couldn't read that request.".into()),
                },
            },
            Err(_) => continue,
        };
        if let Ok(mut out) = serde_json::to_string(&reply) {
            out.push('\n');
            let _ = stream.write_all(out.as_bytes());
        }
    }
}

// ── Commands ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    /// The MCP server needs Unix sockets (macOS).
    pub supported: bool,
    pub enabled: bool,
    /// The program AI apps should launch, with `--mcp`.
    pub command: String,
    /// Plucky is running from somewhere temporary (a disk image, or moved by
    /// macOS Gatekeeper), so the path above won't last.
    pub temporary_location: bool,
    /// Claude Desktop is installed / already set up with Plucky.
    pub claude_desktop: bool,
    pub claude_desktop_connected: bool,
    pub pending: usize,
}

fn exe_path() -> String {
    std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn claude_desktop_config() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        home().map(|h| h.join("Library/Application Support/Claude/claude_desktop_config.json"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

fn claude_desktop_installed() -> bool {
    if cfg!(target_os = "macos") {
        Path::new("/Applications/Claude.app").exists()
            || home().is_some_and(|h| h.join("Applications/Claude.app").exists())
            || claude_desktop_config().is_some_and(|p| p.parent().is_some_and(Path::exists))
    } else {
        false
    }
}

fn claude_desktop_connected(command: &str) -> bool {
    claude_desktop_config()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .is_some_and(|v| v["mcpServers"]["plucky"]["command"].as_str() == Some(command))
}

fn status(app: &AppHandle) -> Status {
    let command = exe_path();
    Status {
        supported: cfg!(unix),
        enabled: app.state::<Settings>().get().agents_enabled,
        temporary_location: command.contains("/AppTranslocation/")
            || command.starts_with("/Volumes/"),
        claude_desktop: claude_desktop_installed(),
        claude_desktop_connected: claude_desktop_connected(&command),
        command,
        pending: app.state::<Agents>().items().len(),
    }
}

#[tauri::command]
pub fn agents_status(app: AppHandle) -> Status {
    status(&app)
}

#[tauri::command]
pub fn agents_set_enabled(app: AppHandle, enabled: bool) -> Status {
    app.state::<Settings>()
        .update(|s| s.agents_enabled = enabled);
    status(&app)
}

/// Add Plucky to Claude Desktop's MCP servers, keeping everything else in
/// its config (and a backup of the original).
#[tauri::command]
pub fn agents_connect_claude_desktop(app: AppHandle) -> Result<Status, String> {
    let path = claude_desktop_config().ok_or("Claude Desktop isn't supported here.")?;
    let mut config: serde_json::Value = match std::fs::read(&path) {
        Ok(bytes) => {
            let _ = std::fs::write(path.with_extension("json.plucky-backup"), &bytes);
            serde_json::from_slice(&bytes).map_err(|_| {
                "Claude Desktop's settings file isn't valid JSON, so Plucky left it alone."
            })?
        }
        Err(_) => serde_json::json!({}),
    };
    if !config.is_object() {
        return Err(
            "Claude Desktop's settings file has an unexpected shape, so Plucky left it alone."
                .into(),
        );
    }
    if !config["mcpServers"].is_object() {
        config["mcpServers"] = serde_json::json!({});
    }
    config["mcpServers"]["plucky"] = serde_json::json!({
        "command": exe_path(),
        "args": ["--mcp"],
    });
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes)
        .map_err(|e| format!("Couldn't update Claude Desktop's settings: {e}"))?;
    Ok(status(&app))
}

#[tauri::command]
pub fn inbox_list(agents: State<'_, Agents>) -> Vec<InboxItem> {
    agents.items()
}

/// Approve a task: it joins the task list, labelled with the agent.
#[tauri::command]
pub fn inbox_accept(app: AppHandle, id: u64) -> Result<pluck_core::Task, String> {
    let item = app
        .state::<Agents>()
        .take(id)
        .ok_or("That task was already reviewed.")?;
    let _ = app.emit("inbox-changed", ());
    crate::tray::refresh(&app);
    crate::insert_task(
        &app,
        NewTask {
            title: item.title,
            due_date: item.due_date,
            due_time: item.due_time,
            notes: item.notes,
            source_app: Some(item.agent),
            ..Default::default()
        },
    )
}

#[tauri::command]
pub fn inbox_discard(app: AppHandle, id: u64) {
    if app.state::<Agents>().take(id).is_some() {
        let _ = app.emit("inbox-changed", ());
        crate::tray::refresh(&app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(title: &str) -> TaskDraft {
        TaskDraft {
            title: title.into(),
            ..Default::default()
        }
    }

    #[test]
    fn validates_and_tidies() {
        let d = validate(&TaskDraft {
            title: "  Send the\\ndeck\u{7}  ".replace("\\n", "\n"),
            due_date: Some("2026-10-23".into()),
            due_time: Some("9:05".into()),
            notes: Some(" line one\nline two \u{1b}[31m ".into()),
        })
        .unwrap();
        assert_eq!(d.title, "Send the deck");
        assert_eq!(d.due_time.as_deref(), Some("09:05"));
        assert_eq!(d.notes.as_deref(), Some("line one\nline two [31m"));
    }

    #[test]
    fn rejects_bad_input() {
        assert!(validate(&draft("   ")).is_err());
        assert!(validate(&draft(&"x".repeat(201))).is_err());
        let mut d = draft("x");
        d.due_date = Some("next friday".into());
        assert!(validate(&d).is_err());
        let mut d = draft("x");
        d.due_time = Some("15:00".into());
        assert!(validate(&d).unwrap_err().contains("due_date"));
        let mut d = draft("x");
        d.due_date = Some("2026-10-23".into());
        d.due_time = Some("3pm".into());
        assert!(validate(&d).is_err());
    }

    #[test]
    fn labels_agents() {
        assert_eq!(agent_label("claude-ai"), "Claude");
        assert_eq!(agent_label("claude-code"), "Claude Code");
        assert_eq!(agent_label("my_local-agent"), "My Local Agent");
        assert_eq!(agent_label("\u{7}"), "An AI agent");
    }

    #[test]
    fn inbox_limits_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let a = Agents::new(dir.path());
        for i in 0..RATE_MAX {
            a.receive("claude-ai", draft(&format!("t{i}"))).unwrap();
        }
        assert!(a.receive("claude-ai", draft("one too many")).is_err());
        let b = Agents::new(dir.path());
        assert_eq!(b.items().len(), RATE_MAX);
        let first = b.items()[0].id;
        assert_eq!(b.take(first).unwrap().title, "t0");
        assert!(b.take(first).is_none());
        assert_eq!(Agents::new(dir.path()).items().len(), RATE_MAX - 1);
    }
}
