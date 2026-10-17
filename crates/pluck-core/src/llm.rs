//! Local inference.
//!
//! [`LlamaServerClient`] talks to the llama-server runtime bundled inside the
//! app; [`OllamaClient`] talks to an existing Ollama install (developer
//! option). Both refuse any base URL that is not a loopback address: "local"
//! is enforced in code, not just in docs.
//! [`extract_task`] runs the constrain → validate → retry-once loop against
//! any [`LlmBackend`], which keeps it testable without a model.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::extraction::{json_schema, Extraction};
use crate::prompt;

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("refusing non-loopback model endpoint: {0}")]
    NonLocalEndpoint(String),
    #[error("invalid endpoint URL: {0}")]
    BadUrl(String),
    #[error("local model is not reachable ({0})")]
    Unreachable(String),
    #[error("local model returned an error: {0}")]
    Backend(String),
    #[error("model output failed validation twice: {0}")]
    InvalidOutput(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

impl ChatMessage {
    pub fn new(role: &str, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: content.into(),
        }
    }
}

/// Something that can answer a schema-constrained chat request.
#[allow(async_fn_in_trait)]
pub trait LlmBackend {
    async fn chat(&self, messages: &[ChatMessage], schema: &Value) -> Result<String, LlmError>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaConfig {
    /// Must be loopback, e.g. `http://127.0.0.1:11434`.
    pub base_url: String,
    /// e.g. `qwen3:4b-instruct` or `llama3.2:3b`.
    pub model: String,
    /// How long Ollama keeps the model loaded after a request ("5m", "0").
    pub keep_alive: String,
    /// Generous to cover cold model loads.
    pub timeout_secs: u64,
}

impl Default for OllamaConfig {
    fn default() -> Self {
        Self {
            base_url: "http://127.0.0.1:11434".into(),
            model: "llama3.2:3b".into(),
            keep_alive: "5m".into(),
            timeout_secs: 60,
        }
    }
}

pub struct OllamaClient {
    http: reqwest::Client,
    chat_url: url::Url,
    config: OllamaConfig,
}

/// Accept only loopback hosts.
pub fn ensure_loopback(raw: &str) -> Result<url::Url, LlmError> {
    let url = url::Url::parse(raw).map_err(|e| LlmError::BadUrl(e.to_string()))?;
    let ok = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        None => false,
    };
    if !ok || !matches!(url.scheme(), "http" | "https") {
        return Err(LlmError::NonLocalEndpoint(raw.to_string()));
    }
    Ok(url)
}

impl OllamaClient {
    pub fn new(config: OllamaConfig) -> Result<Self, LlmError> {
        let base = ensure_loopback(&config.base_url)?;
        let chat_url = base
            .join("/api/chat")
            .map_err(|e| LlmError::BadUrl(e.to_string()))?;
        let http = reqwest::Client::builder()
            // Never route localhost traffic through a system proxy.
            .no_proxy()
            .timeout(Duration::from_secs(config.timeout_secs))
            .build()
            .map_err(|e| LlmError::Backend(e.to_string()))?;
        Ok(Self {
            http,
            chat_url,
            config,
        })
    }

    pub fn config(&self) -> &OllamaConfig {
        &self.config
    }

    /// Load the model without generating, so the first real capture is warm.
    pub async fn warm_up(&self) -> Result<(), LlmError> {
        let body = json!({ "model": self.config.model, "messages": [], "keep_alive": self.config.keep_alive });
        self.post(&body).await.map(|_| ())
    }

    /// Ask Ollama to unload the model immediately (e.g. on battery).
    pub async fn unload(&self) -> Result<(), LlmError> {
        let body = json!({ "model": self.config.model, "messages": [], "keep_alive": 0 });
        self.post(&body).await.map(|_| ())
    }

    async fn post(&self, body: &Value) -> Result<Value, LlmError> {
        let resp = self
            .http
            .post(self.chat_url.clone())
            .json(body)
            .send()
            .await
            .map_err(|e| LlmError::Unreachable(e.to_string()))?;
        let status = resp.status();
        let value: Value = resp
            .json()
            .await
            .map_err(|e| LlmError::Backend(e.to_string()))?;
        if !status.is_success() {
            let msg = value["error"]
                .as_str()
                .unwrap_or("unknown error")
                .to_string();
            return Err(LlmError::Backend(format!("{status}: {msg}")));
        }
        Ok(value)
    }
}

impl LlmBackend for OllamaClient {
    async fn chat(&self, messages: &[ChatMessage], schema: &Value) -> Result<String, LlmError> {
        let body = json!({
            "model": self.config.model,
            "messages": messages,
            "format": schema,
            "stream": false,
            "keep_alive": self.config.keep_alive,
            "options": { "temperature": 0, "num_predict": max_tokens(schema) }
        });
        let value = self.post(&body).await?;
        value["message"]["content"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| LlmError::Backend("response had no message content".into()))
    }
}

/// Client for the bundled llama.cpp `llama-server` (OpenAI-compatible API).
///
/// The server is started by the app on a random loopback port with a random
/// API key, so other local processes can't use it while it runs.
pub struct LlamaServerClient {
    http: reqwest::Client,
    chat_url: url::Url,
    health_url: url::Url,
    api_key: String,
}

impl LlamaServerClient {
    pub fn new(
        base_url: &str,
        api_key: impl Into<String>,
        timeout: Duration,
    ) -> Result<Self, LlmError> {
        let base = ensure_loopback(base_url)?;
        let join = |p: &str| base.join(p).map_err(|e| LlmError::BadUrl(e.to_string()));
        let http = reqwest::Client::builder()
            .no_proxy()
            .timeout(timeout)
            .build()
            .map_err(|e| LlmError::Backend(e.to_string()))?;
        Ok(Self {
            http,
            chat_url: join("/v1/chat/completions")?,
            health_url: join("/health")?,
            api_key: api_key.into(),
        })
    }

    /// True once the model is loaded and the server accepts requests.
    pub async fn healthy(&self) -> bool {
        match self.http.get(self.health_url.clone()).send().await {
            Ok(r) => r.status().is_success(),
            Err(_) => false,
        }
    }
}

/// Request body for llama-server's OpenAI-compatible chat endpoint.
pub fn llama_server_body(messages: &[ChatMessage], schema: &Value) -> Value {
    json!({
        "messages": messages,
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": "task", "schema": schema }
        },
        "temperature": 0,
        "max_tokens": max_tokens(schema),
        "stream": false
    })
}

/// Room for the answer: one task, or a short list of them.
fn max_tokens(schema: &Value) -> u32 {
    if schema["properties"].get("tasks").is_some() {
        420
    } else {
        160
    }
}

impl LlmBackend for LlamaServerClient {
    async fn chat(&self, messages: &[ChatMessage], schema: &Value) -> Result<String, LlmError> {
        let resp = self
            .http
            .post(self.chat_url.clone())
            .bearer_auth(&self.api_key)
            .json(&llama_server_body(messages, schema))
            .send()
            .await
            .map_err(|e| LlmError::Unreachable(e.to_string()))?;
        let status = resp.status();
        let value: Value = resp
            .json()
            .await
            .map_err(|e| LlmError::Backend(e.to_string()))?;
        if !status.is_success() {
            let msg = value["error"]["message"]
                .as_str()
                .unwrap_or("unknown error")
                .to_string();
            return Err(LlmError::Backend(format!("{status}: {msg}")));
        }
        value["choices"][0]["message"]["content"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| LlmError::Backend("response had no message content".into()))
    }
}

/// Extract one task from a selection: constrained request, validation, and
/// a single repair retry. A second failure is returned so the UI can fall
/// back to a manual edit state seeded with the selection.
pub async fn extract_task<B: LlmBackend>(
    backend: &B,
    selection: &str,
) -> Result<Extraction, LlmError> {
    let schema = json_schema();
    let mut messages = vec![
        ChatMessage::new("system", prompt::SYSTEM_PROMPT),
        ChatMessage::new("user", prompt::user_message(selection)),
    ];

    let first = backend.chat(&messages, &schema).await?;
    let err = match Extraction::parse(&first) {
        Ok(e) => return Ok(e),
        Err(err) => err,
    };
    log::warn!("extraction rejected, retrying once: {err}");

    messages.push(ChatMessage::new("assistant", first));
    messages.push(ChatMessage::new(
        "user",
        prompt::repair_message(&err.to_string()),
    ));
    let second = backend.chat(&messages, &schema).await?;
    Extraction::parse(&second).map_err(|e| LlmError::InvalidOutput(e.to_string()))
}

/// Watch mode: the to-dos (often none) in messages that just appeared in
/// `app`. One repair retry, like `extract_task`.
pub async fn find_actions<B: LlmBackend>(
    backend: &B,
    app: &str,
    text: &str,
) -> Result<Vec<Extraction>, LlmError> {
    let schema = crate::extraction::actions_schema();
    let mut messages = vec![
        ChatMessage::new("system", prompt::WATCH_SYSTEM_PROMPT),
        ChatMessage::new("user", prompt::watch_message(app, text)),
    ];
    let first = backend.chat(&messages, &schema).await?;
    let err = match crate::extraction::parse_actions(&first) {
        Ok(a) => return Ok(a),
        Err(err) => err,
    };
    messages.push(ChatMessage::new("assistant", first));
    messages.push(ChatMessage::new(
        "user",
        prompt::repair_message(&err.to_string()),
    ));
    let second = backend.chat(&messages, &schema).await?;
    crate::extraction::parse_actions(&second).map_err(|e| LlmError::InvalidOutput(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DateConfidence;
    use std::cell::RefCell;

    struct Scripted {
        replies: RefCell<Vec<String>>,
        seen: RefCell<Vec<Vec<ChatMessage>>>,
    }

    impl Scripted {
        fn new(replies: &[&str]) -> Self {
            Self {
                replies: RefCell::new(replies.iter().rev().map(|s| s.to_string()).collect()),
                seen: RefCell::new(vec![]),
            }
        }
    }

    impl LlmBackend for Scripted {
        async fn chat(
            &self,
            messages: &[ChatMessage],
            _schema: &Value,
        ) -> Result<String, LlmError> {
            self.seen.borrow_mut().push(messages.to_vec());
            Ok(self
                .replies
                .borrow_mut()
                .pop()
                .expect("unexpected extra call"))
        }
    }

    const GOOD: &str =
        r#"{"task":"Review rollout checklist","date_text":"by Friday","date_confidence":"high"}"#;

    #[tokio::test]
    async fn returns_first_valid_answer() {
        let b = Scripted::new(&[GOOD]);
        let e = extract_task(&b, "Please review the rollout checklist by Friday")
            .await
            .unwrap();
        assert_eq!(e.date_confidence, DateConfidence::High);
        assert_eq!(b.seen.borrow().len(), 1);
        let first = &b.seen.borrow()[0];
        assert_eq!(first[0].role, "system");
        assert!(first[1].content.starts_with("<selection>"));
    }

    #[tokio::test]
    async fn retries_once_with_error_feedback() {
        let b = Scripted::new(&["not json", GOOD]);
        let e = extract_task(&b, "x").await.unwrap();
        assert_eq!(e.task, "Review rollout checklist");
        let calls = b.seen.borrow();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].len(), 4);
        assert!(calls[1][3].content.contains("rejected"));
    }

    #[tokio::test]
    async fn gives_up_after_second_failure() {
        let b = Scripted::new(&[
            "nope",
            r#"{"task":"","date_text":null,"date_confidence":"none"}"#,
        ]);
        assert!(matches!(
            extract_task(&b, "x").await,
            Err(LlmError::InvalidOutput(_))
        ));
    }

    #[test]
    fn only_loopback_endpoints_are_allowed() {
        assert!(ensure_loopback("http://127.0.0.1:11434").is_ok());
        assert!(ensure_loopback("http://localhost:11434").is_ok());
        assert!(ensure_loopback("http://[::1]:11434").is_ok());
        for bad in [
            "http://10.0.0.5:11434",
            "https://api.example.com",
            "http://localhost.evil.com",
            "file:///tmp/x",
        ] {
            assert!(ensure_loopback(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn llama_server_body_constrains_output() {
        let msgs = [ChatMessage::new("user", "x")];
        let body = llama_server_body(&msgs, &json_schema());
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(
            body["response_format"]["json_schema"]["schema"]["required"][0],
            "task"
        );
        assert_eq!(body["temperature"], 0);
        assert_eq!(body["stream"], false);
    }

    #[test]
    fn llama_server_client_is_loopback_only() {
        let t = Duration::from_secs(1);
        assert!(LlamaServerClient::new("http://127.0.0.1:5123", "k", t).is_ok());
        assert!(matches!(
            LlamaServerClient::new("http://example.com:5123", "k", t),
            Err(LlmError::NonLocalEndpoint(_))
        ));
    }

    #[test]
    fn client_rejects_remote_config() {
        let cfg = OllamaConfig {
            base_url: "http://192.168.1.4:11434".into(),
            ..Default::default()
        };
        assert!(matches!(
            OllamaClient::new(cfg),
            Err(LlmError::NonLocalEndpoint(_))
        ));
    }
}
