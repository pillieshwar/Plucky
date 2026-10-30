//! `TodoCity --mcp`: a write-only MCP server over stdio.
//!
//! AI apps launch this and talk JSON-RPC 2.0 over stdin/stdout, one message
//! per line. It offers a single tool, `add_task`, and no resources or
//! prompts. Each task is passed to the running TodoCity app over its private
//! socket; the reply to the agent never says anything about existing tasks.
//!
//! Nothing but protocol messages may go to stdout.

// The socket hand-off is Unix-only; elsewhere most of this is unused.
#![cfg_attr(not(unix), allow(dead_code))]

use std::io::{BufRead, Write};

use serde_json::{json, Value};

use super::{Submission, TaskDraft};

/// Protocol versions this server speaks, newest first.
const VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

/// `clientInfo.name` of TodoCity's own "Send test task".
pub const SELF_TEST: &str = "todocity-self-test";

pub const NOT_REACHABLE: &str = "TodoCity isn't accepting tasks: it isn't running, or \"Let AI agents add tasks\" is off in TodoCity → Connectors → AI agents.";
const RECEIVED: &str =
    "Sent to TodoCity. The user will review it there before it's added to their tasks.";

const INSTRUCTIONS: &str = "TodoCity is the user's private to-do list on their Mac. You can add tasks to it with add_task; the user reviews each one before it's added. You can't read, search, change or delete tasks, and the reply never says what else is on the list.";

/// Added when the user lets agents suggest tasks on their own.
const PROACTIVE: &str = " Use this proactively: whenever the user mentions something they need to do later — a deadline, an appointment, a follow-up, \"remind me\" — send it to TodoCity without being asked, one call per task. Skip things that are already done or have nothing to do.";

fn tool(proactive: bool) -> Value {
    let mut description = String::from("Send a to-do to the user's TodoCity task list on their Mac. The user reviews it before it's added. Write-only: you can't see existing tasks, and the reply is the same every time. Use the user's local date and time.");
    if proactive {
        description.push_str(PROACTIVE);
    }
    json!({
        "name": "add_task",
        "title": "Add a task to TodoCity",
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "What to do, short and actionable, e.g. \"Send the Q3 deck to Priya\".",
                    "maxLength": 200
                },
                "due_date": {
                    "type": "string",
                    "description": "Day it's due, YYYY-MM-DD in the user's local time. Leave out if there's no date.",
                    "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
                },
                "due_time": {
                    "type": "string",
                    "description": "Time it's due, 24-hour HH:MM local time. Needs due_date.",
                    "pattern": "^\\d{1,2}:\\d{2}$"
                },
                "notes": {
                    "type": "string",
                    "description": "Optional details or context.",
                    "maxLength": 2000
                }
            },
            "required": ["title"],
            "additionalProperties": false
        },
        "annotations": {
            "title": "Add a task to TodoCity",
            "readOnlyHint": false,
            "destructiveHint": false,
            "idempotentHint": false,
            "openWorldHint": false
        }
    })
}

fn result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_text(text: &str, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

/// Sends a validated task to the app; `Err` is a message for the agent.
pub trait Deliver {
    fn deliver(&mut self, sub: &Submission) -> Result<(), String>;
}

/// The MCP conversation, separate from stdio and the socket so it's testable.
pub struct Server<D: Deliver> {
    deliver: D,
    client: String,
    proactive: bool,
}

impl<D: Deliver> Server<D> {
    pub fn new(deliver: D) -> Self {
        Self {
            deliver,
            client: String::new(),
            proactive: false,
        }
    }

    /// Encourage agents to add to-dos they notice on their own.
    pub fn proactive(mut self, on: bool) -> Self {
        self.proactive = on;
        self
    }

    /// Answer one message; `None` for notifications.
    pub fn handle(&mut self, msg: &Value) -> Option<Value> {
        let Some(obj) = msg.as_object() else {
            return Some(error(&Value::Null, -32600, "Invalid Request"));
        };
        let method = obj.get("method").and_then(Value::as_str);
        // No id: a notification (e.g. notifications/initialized), no reply.
        let id = obj.get("id")?.clone();
        let params = obj.get("params").cloned().unwrap_or(Value::Null);
        Some(match method {
            Some("initialize") => {
                if let Some(name) = params["clientInfo"]["name"].as_str() {
                    self.client = name.chars().take(80).collect();
                }
                let asked = params["protocolVersion"].as_str().unwrap_or("");
                let version = VERSIONS
                    .iter()
                    .find(|v| **v == asked)
                    .unwrap_or(&VERSIONS[0]);
                result(
                    &id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": { "tools": { "listChanged": false } },
                        "serverInfo": {
                            "name": "todocity",
                            "title": "TodoCity",
                            "version": env!("CARGO_PKG_VERSION")
                        },
                        "instructions": if self.proactive {
                            format!("{INSTRUCTIONS}{PROACTIVE}")
                        } else {
                            INSTRUCTIONS.to_string()
                        }
                    }),
                )
            }
            Some("ping") => result(&id, json!({})),
            Some("tools/list") => result(&id, json!({ "tools": [tool(self.proactive)] })),
            Some("tools/call") => {
                if params["name"].as_str() != Some("add_task") {
                    return Some(error(
                        &id,
                        -32602,
                        "Unknown tool. TodoCity only has add_task.",
                    ));
                }
                result(&id, self.add_task(&params["arguments"]))
            }
            // Nothing to read: say so the standard way.
            Some("resources/list") => result(&id, json!({ "resources": [] })),
            Some("prompts/list") => result(&id, json!({ "prompts": [] })),
            _ => error(&id, -32601, "Method not found"),
        })
    }

    fn add_task(&mut self, args: &Value) -> Value {
        let draft: TaskDraft = match serde_json::from_value(args.clone()) {
            Ok(d) => d,
            Err(_) => {
                return tool_text(
                    "add_task needs a \"title\" string, and optionally \"due_date\" (YYYY-MM-DD), \"due_time\" (HH:MM) and \"notes\".",
                    true,
                )
            }
        };
        let draft = match super::validate(&draft) {
            Ok(d) => d,
            Err(e) => return tool_text(&format!("Not sent: {e}."), true),
        };
        let sub = Submission {
            agent: self.client.clone(),
            task: draft,
        };
        match self.deliver.deliver(&sub) {
            Ok(()) => tool_text(RECEIVED, false),
            Err(e) => tool_text(&e, true),
        }
    }
}

/// Delivers over the app's Unix socket.
struct Socket;

/// TodoCity's data folder: `TodoCity` on a Mac (or `app.pluck.desktop` until
/// the app has moved it), Tauri's default elsewhere. This helper only looks;
/// the app itself does the move.
fn data_dir() -> Option<std::path::PathBuf> {
    use todocity_core::data_folder;
    let home = std::path::PathBuf::from(std::env::var_os("HOME")?);
    if cfg!(target_os = "macos") {
        return Some(data_folder::locate(
            &home.join("Library/Application Support"),
        ));
    }
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    Some(data.join(data_folder::OLD_NAME))
}

/// Whether the user lets agents add to-dos on their own (default yes).
fn proactive_setting() -> bool {
    data_dir()
        .and_then(|d| std::fs::read(d.join("settings.json")).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["agents_proactive"].as_bool())
        .unwrap_or(true)
}

impl Deliver for Socket {
    #[cfg(unix)]
    fn deliver(&mut self, sub: &Submission) -> Result<(), String> {
        use std::io::{BufReader, Read};
        use std::os::unix::net::UnixStream;
        use std::time::Duration;

        let path = data_dir().ok_or(NOT_REACHABLE)?.join(super::SOCKET_NAME);
        let mut stream = UnixStream::connect(&path).map_err(|_| NOT_REACHABLE.to_string())?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let mut line = serde_json::to_string(sub).map_err(|e| e.to_string())?;
        line.push('\n');
        stream
            .write_all(line.as_bytes())
            .map_err(|_| NOT_REACHABLE.to_string())?;
        let mut answer = String::new();
        BufReader::new((&stream).take(4096))
            .read_line(&mut answer)
            .map_err(|_| NOT_REACHABLE.to_string())?;
        let reply: super::Reply =
            serde_json::from_str(&answer).map_err(|_| NOT_REACHABLE.to_string())?;
        if reply.ok {
            Ok(())
        } else {
            Err(reply.error.unwrap_or_else(|| NOT_REACHABLE.into()))
        }
    }

    #[cfg(not(unix))]
    fn deliver(&mut self, _sub: &Submission) -> Result<(), String> {
        Err("TodoCity's AI agent connection is available on macOS.".into())
    }
}

/// Serve stdin/stdout until the AI app closes the pipe.
pub fn run() -> i32 {
    let mut server = Server::new(Socket).proactive(proactive_setting());
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => server.handle(&msg),
            Err(_) => Some(error(&Value::Null, -32700, "Parse error")),
        };
        if let Some(reply) = reply {
            if writeln!(stdout, "{reply}")
                .and_then(|_| stdout.flush())
                .is_err()
            {
                break;
            }
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Fake {
        sent: Vec<Submission>,
        fail: Option<String>,
    }
    impl Deliver for &mut Fake {
        fn deliver(&mut self, sub: &Submission) -> Result<(), String> {
            if let Some(e) = &self.fail {
                return Err(e.clone());
            }
            self.sent.push(sub.clone());
            Ok(())
        }
    }

    fn call(args: Value) -> Value {
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_task","arguments":args}})
    }

    #[test]
    fn handshake_and_tools() {
        let mut fake = Fake::default();
        let mut s = Server::new(&mut fake);
        let init = s
            .handle(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
                "protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"claude-ai","version":"1"}}}))
            .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(init["result"]["capabilities"].get("resources").is_none());
        assert!(s
            .handle(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .is_none());
        let list = s
            .handle(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))
            .unwrap();
        let tools = list["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "add_task");
        let unknown = s
            .handle(&json!({"jsonrpc":"2.0","id":9,"method":"resources/read"}))
            .unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
        let v = s
            .handle(&json!({"jsonrpc":"2.0","id":4,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}))
            .unwrap();
        assert_eq!(v["result"]["protocolVersion"], VERSIONS[0]);
    }

    #[test]
    fn proactive_wording_only_when_allowed() {
        let mut fake = Fake::default();
        let mut quiet = Server::new(&mut fake);
        let list = quiet
            .handle(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
            .unwrap();
        assert!(!list["result"]["tools"][0]["description"]
            .as_str()
            .unwrap()
            .contains("proactively"));
        let mut fake = Fake::default();
        let mut eager = Server::new(&mut fake).proactive(true);
        let list = eager
            .handle(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
            .unwrap();
        assert!(list["result"]["tools"][0]["description"]
            .as_str()
            .unwrap()
            .contains("proactively"));
    }

    #[test]
    fn add_task_replies_the_same_every_time() {
        let mut fake = Fake::default();
        {
            let mut s = Server::new(&mut fake);
            s.handle(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"claude-code"}}}));
            let a = s
                .handle(&call(
                    json!({"title":"Send deck","due_date":"2026-10-23","due_time":"15:00"}),
                ))
                .unwrap();
            let b = s
                .handle(&call(
                    json!({"title":"Send deck","due_date":"2026-10-23","due_time":"15:00"}),
                ))
                .unwrap();
            assert_eq!(a["result"], b["result"]);
            assert_eq!(a["result"]["isError"], false);
            assert_eq!(a["result"]["content"][0]["text"], RECEIVED);
        }
        assert_eq!(fake.sent.len(), 2);
        assert_eq!(fake.sent[0].agent, "claude-code");
        assert_eq!(fake.sent[0].task.due_time.as_deref(), Some("15:00"));
    }

    #[test]
    fn bad_input_and_unreachable_app_are_tool_errors() {
        let mut fake = Fake::default();
        let mut s = Server::new(&mut fake);
        let r = s.handle(&call(json!({"due_date":"2026-10-23"}))).unwrap();
        assert_eq!(r["result"]["isError"], true);
        let r = s
            .handle(&call(json!({"title":"x","due_date":"friday"})))
            .unwrap();
        assert!(r["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("due_date"));
        let r = s
            .handle(&json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_tasks"}}))
            .unwrap();
        assert_eq!(r["error"]["code"], -32602);
        drop(s);
        fake.fail = Some(NOT_REACHABLE.into());
        let mut s = Server::new(&mut fake);
        let r = s.handle(&call(json!({"title":"x"}))).unwrap();
        assert_eq!(r["result"]["content"][0]["text"], NOT_REACHABLE);
    }
}
