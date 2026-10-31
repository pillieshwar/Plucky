//! Watch through an agent the person already uses (Settings → Watch → Send
//! to): the new messages go to that agent, signed in as the person, which
//! answers with the to-dos it sees. Same prompt, schema and checks as the
//! open model; see `todocity_core::agent_llm`.

use std::process::Command;
use std::time::Duration;

use serde_json::Value;
use todocity_core::agent_llm;
use todocity_core::agent_runs::{self, AgentCli};
use todocity_core::extraction::Extraction;
use todocity_core::llm::{ChatMessage, LlmBackend, LlmError};

use crate::agents::apps;

/// One question can take a while: the agent starts, signs in and answers.
const ANSWER_TIME: Duration = Duration::from_secs(120);

/// "On this Mac": the open model.
pub const LOCAL: &str = "local";

/// An agent Watch can send to, and whether it's ready (TodoCity's MCP
/// server is connected in it, so it's set up and known to the person).
#[derive(Debug, Clone, serde::Serialize)]
pub struct Reader {
    pub id: &'static str,
    pub name: &'static str,
    pub installed: bool,
    pub connected: bool,
}

/// Every agent Watch can send to, with its connection.
pub fn readers() -> Vec<Reader> {
    let command = crate::agents::exe_path();
    let apps = apps::statuses(&command);
    agent_runs::CLIS
        .iter()
        .filter(|c| agent_llm::can_watch(c.id))
        .map(|c| {
            let app = c.connector.and_then(|k| apps.iter().find(|a| a.id == k));
            Reader {
                id: c.id,
                name: c.name,
                installed: app.is_some_and(|a| a.installed),
                connected: app.is_some_and(|a| a.connected),
            }
        })
        .collect()
}

/// The agent picked in Watch, if it's still connected.
pub fn ready(id: &str) -> Option<&'static AgentCli> {
    let cli = agent_runs::cli(id)?;
    readers()
        .iter()
        .any(|r| r.id == id && r.connected)
        .then_some(cli)
}

struct AgentBackend {
    cli: &'static AgentCli,
}

impl LlmBackend for AgentBackend {
    async fn chat(&self, messages: &[ChatMessage], schema: &Value) -> Result<String, LlmError> {
        let message = agent_llm::one_message(messages, schema);
        let args = agent_llm::headless_args(self.cli.id, &message)
            .ok_or_else(|| LlmError::Backend(format!("{} can't answer here", self.cli.name)))?;
        let (program, argv) = crate::agent_panel::agent_argv(self.cli, &args);
        // An empty folder of its own, so it has nothing to look through.
        let dir = std::env::temp_dir().join("todocity-watch");
        let _ = std::fs::create_dir_all(&dir);
        let name = self.cli.name;
        let reply = tauri::async_runtime::spawn_blocking(move || {
            apps::run(
                Command::new(program).args(argv).current_dir(dir),
                ANSWER_TIME,
            )
        })
        .await
        .map_err(|e| LlmError::Backend(e.to_string()))?
        .map_err(|e| {
            let e = e.lines().last().unwrap_or_default().to_string();
            LlmError::Backend(format!("{name}: {e}"))
        })?;
        // The JSON if there is some; otherwise the reply, so the one retry
        // can ask for JSON again.
        Ok(agent_llm::json_from_reply(&reply).unwrap_or(reply))
    }
}

/// Watch's question, put to `cli`.
pub async fn find_actions(
    cli: &'static AgentCli,
    app: &str,
    user: &[String],
    earlier: &[String],
    new: &[String],
) -> Result<Vec<Extraction>, String> {
    todocity_core::llm::find_actions(&AgentBackend { cli }, app, user, earlier, new)
        .await
        .map_err(|e| e.to_string())
}
