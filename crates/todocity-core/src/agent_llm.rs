//! Asking an agent the person already uses (Claude Code, Codex, Antigravity
//! CLI, Gemini CLI, Cursor Agent) instead of the open model on this Mac —
//! for Watch, when the person picks one.
//!
//! The agent runs once per question in its non-interactive mode, signed in
//! as the person, and answers in text. TodoCity asks for one JSON object,
//! finds it in the reply and checks it exactly as it checks the open
//! model's answers: the agent only suggests to-dos, code works out dates,
//! and the person reviews each one.
//!
//! Pure: the app runs the command (see `src-tauri/src/watch_agent.rs`).

use serde_json::Value;

use crate::llm::ChatMessage;

/// Longest message handed to an agent on its command line.
pub const MAX_MESSAGE: usize = 24_000;

/// How to ask agent `id` one question and get one answer back, or `None`
/// if it can't answer non-interactively. Each argument is passed as is,
/// never through a shell.
pub fn headless_args(id: &str, message: &str) -> Option<Vec<String>> {
    let m = message.to_string();
    let args: Vec<String> = match id {
        // Print mode, the small fast model, no MCP servers, one turn: it
        // answers, it doesn't act.
        "claude" => vec![
            "-p".into(),
            "--model".into(),
            "haiku".into(),
            "--strict-mcp-config".into(),
            "--max-turns".into(),
            "1".into(),
            m,
        ],
        // Read-only sandbox, outside any project.
        "codex" => vec![
            "exec".into(),
            "--skip-git-repo-check".into(),
            "--sandbox".into(),
            "read-only".into(),
            m,
        ],
        "antigravity" | "gemini" => vec!["-p".into(), m],
        // Without --force it can't change files.
        "cursor" => vec!["-p".into(), "--output-format".into(), "text".into(), m],
        _ => return None,
    };
    Some(args)
}

/// Whether Watch can send to agent `id`.
pub fn can_watch(id: &str) -> bool {
    headless_args(id, "").is_some()
}

/// A chat (system prompt, messages, any earlier answer to fix) as the one
/// message an agent's command line takes, ending with the JSON it must
/// reply with.
pub fn one_message(messages: &[ChatMessage], schema: &Value) -> String {
    let mut out = String::new();
    for m in messages.iter().filter(|m| m.role == "system") {
        out.push_str(m.content.trim());
        out.push_str("\n\n");
    }
    for m in messages.iter().filter(|m| m.role != "system") {
        let who = if m.role == "assistant" {
            "Your earlier answer"
        } else {
            "Message"
        };
        out.push_str(&format!("{who}:\n{}\n\n", m.content.trim()));
    }
    out.push_str(
        "Answer with one JSON object that matches this JSON Schema, and nothing else — no prose, no code fences, no tools:\n",
    );
    out.push_str(&serde_json::to_string(schema).unwrap_or_default());
    out.push('\n');
    if out.len() > MAX_MESSAGE {
        // Keep the end: the newest messages and the schema.
        let mut cut = out.len() - MAX_MESSAGE;
        while !out.is_char_boundary(cut) {
            cut += 1;
        }
        out = out[cut..].to_string();
    }
    out
}

/// The JSON object in an agent's reply: the last complete `{…}` that parses,
/// so prose or code fences around it (and logs before it) don't matter.
pub fn json_from_reply(reply: &str) -> Option<String> {
    let bytes: Vec<char> = reply.chars().collect();
    let mut found: Option<String> = None;
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut in_str = false;
    let mut escaped = false;
    for (i, &c) in bytes.iter().enumerate() {
        if in_str {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' if depth > 0 => in_str = true,
            '{' => {
                if depth == 0 {
                    start = i;
                }
                depth += 1;
            }
            '}' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    let candidate: String = bytes[start..=i].iter().collect();
                    if serde_json::from_str::<Value>(&candidate).is_ok_and(|v| v.is_object()) {
                        found = Some(candidate);
                    }
                }
            }
            _ => {}
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn each_agent_answers_once_without_acting() {
        let claude = headless_args("claude", "hi").unwrap();
        assert_eq!(claude.first().map(String::as_str), Some("-p"));
        assert!(claude.windows(2).any(|w| w == ["--max-turns", "1"]));
        assert!(claude.contains(&"--strict-mcp-config".to_string()));
        assert_eq!(claude.last().map(String::as_str), Some("hi"));
        let codex = headless_args("codex", "hi").unwrap();
        assert_eq!(codex[0], "exec");
        assert!(codex.windows(2).any(|w| w == ["--sandbox", "read-only"]));
        assert_eq!(
            headless_args("antigravity", "hi").unwrap(),
            vec!["-p", "hi"]
        );
        assert!(!headless_args("cursor", "hi")
            .unwrap()
            .contains(&"--force".to_string()));
        assert!(headless_args("vscode", "hi").is_none());
        for id in ["claude", "codex", "antigravity", "gemini", "cursor"] {
            assert!(can_watch(id), "{id}");
        }
        // Every agent Watch can use is one the terminal knows.
        for c in crate::agent_runs::CLIS {
            assert!(can_watch(c.id), "{}", c.id);
        }
    }

    #[test]
    fn the_message_carries_the_prompt_the_chat_and_the_schema() {
        let schema = json!({ "type": "object", "properties": { "actions": { "type": "array" } } });
        let m = one_message(
            &[
                ChatMessage::new("system", "Find to-dos."),
                ChatMessage::new("user", "Sam: can you send the deck?"),
                ChatMessage::new("assistant", "{oops"),
                ChatMessage::new("user", "That wasn't valid JSON."),
            ],
            &schema,
        );
        assert!(m.starts_with("Find to-dos."));
        assert!(m.contains("Message:\nSam: can you send the deck?"));
        assert!(m.contains("Your earlier answer:\n{oops"));
        assert!(m.contains("\"actions\""));
        assert!(m.trim_end().ends_with('}'));
        let long = one_message(
            &[ChatMessage::new("user", "x".repeat(MAX_MESSAGE * 2))],
            &schema,
        );
        assert!(long.len() <= MAX_MESSAGE);
        assert!(long.contains("\"actions\""));
    }

    #[test]
    fn json_is_found_in_whatever_the_agent_says() {
        assert_eq!(
            json_from_reply("{\"actions\":[]}").as_deref(),
            Some("{\"actions\":[]}")
        );
        let fenced =
            "Here you go:\n```json\n{\"actions\": [{\"title\": \"Send {the} deck\"}]}\n```\nDone.";
        assert_eq!(
            json_from_reply(fenced).as_deref(),
            Some("{\"actions\": [{\"title\": \"Send {the} deck\"}]}")
        );
        // Logs first, then the answer: the last object wins.
        let logged = "[info] {\"model\":\"x\"}\n{\"actions\":[]}";
        assert_eq!(json_from_reply(logged).as_deref(), Some("{\"actions\":[]}"));
        assert_eq!(json_from_reply("no json here { not json"), None);
        assert_eq!(
            json_from_reply("{\"a\": \"}\"}").as_deref(),
            Some("{\"a\": \"}\"}")
        );
    }
}
