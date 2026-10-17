//! The inference engine: the bundled llama.cpp `llama-server`, started on
//! demand and stopped when idle.
//!
//! * Spawned only when a capture needs it (the shortcut pre-warms it while
//!   the user is still selecting a date).
//! * Bound to 127.0.0.1 on a random port, protected by a random API key.
//! * Stopped after [`IDLE_TIMEOUT`] without use, on model change, and on quit,
//!   so a few GB of RAM aren't held while the app sits in the menu bar.
//!
//! Developers can point at an existing Ollama instead by setting
//! `PLUCK_OLLAMA_URL` (and optionally `PLUCK_MODEL`).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use pluck_core::{
    extract_task, find_actions, Extraction, LlamaServerClient, OllamaClient, OllamaConfig,
};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);
const CONTEXT_TOKENS: &str = "4096";

struct Running {
    child: Child,
    client: LlamaServerClient,
    model_path: PathBuf,
}

pub struct Engine {
    sidecar: PathBuf,
    log_path: PathBuf,
    ollama: Option<OllamaClient>,
    running: Mutex<Option<Running>>,
    last_used: std::sync::Mutex<Instant>,
}

impl Engine {
    pub fn new(log_dir: &Path) -> Self {
        let ollama = std::env::var("PLUCK_OLLAMA_URL").ok().and_then(|url| {
            let mut cfg = OllamaConfig {
                base_url: url,
                ..Default::default()
            };
            if let Ok(m) = std::env::var("PLUCK_MODEL") {
                cfg.model = m;
            }
            OllamaClient::new(cfg)
                .map_err(|e| log::error!("ignoring PLUCK_OLLAMA_URL: {e}"))
                .ok()
        });
        Self {
            sidecar: sidecar_path(),
            log_path: log_dir.join("llama-server.log"),
            ollama,
            running: Mutex::new(None),
            last_used: std::sync::Mutex::new(Instant::now()),
        }
    }

    /// "bundled" or "ollama", for the UI.
    pub fn kind(&self) -> &'static str {
        if self.ollama.is_some() {
            "ollama"
        } else {
            "bundled"
        }
    }

    fn touch(&self) {
        if let Ok(mut t) = self.last_used.lock() {
            *t = Instant::now();
        }
    }

    /// Run one extraction with `model_path`, starting the server if needed.
    pub async fn extract(&self, model_path: &Path, selection: &str) -> Result<Extraction, String> {
        self.touch();
        if let Some(ollama) = &self.ollama {
            return extract_task(ollama, selection)
                .await
                .map_err(|e| e.to_string());
        }
        let mut guard = self.running.lock().await;
        self.ensure_running(&mut guard, model_path).await?;
        let running = guard.as_ref().expect("server just started");
        let result = extract_task(&running.client, selection)
            .await
            .map_err(|e| e.to_string());
        self.touch();
        result
    }

    /// Watch mode: to-dos in new messages from `app` (usually none).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub async fn find_actions(
        &self,
        model_path: &Path,
        app: &str,
        user: &[String],
        earlier: &[String],
        new: &[String],
    ) -> Result<Vec<Extraction>, String> {
        self.touch();
        if let Some(ollama) = &self.ollama {
            return find_actions(ollama, app, user, earlier, new)
                .await
                .map_err(|e| e.to_string());
        }
        let mut guard = self.running.lock().await;
        self.ensure_running(&mut guard, model_path).await?;
        let running = guard.as_ref().expect("server just started");
        let result = find_actions(&running.client, app, user, earlier, new)
            .await
            .map_err(|e| e.to_string());
        self.touch();
        result
    }

    /// Start the server for `model_path` in the background (best effort).
    pub async fn warm(&self, model_path: &Path) {
        if self.ollama.is_some() {
            return;
        }
        self.touch();
        let mut guard = self.running.lock().await;
        if let Err(e) = self.ensure_running(&mut guard, model_path).await {
            log::warn!("warm-up failed: {e}");
        }
    }

    pub async fn stop(&self) {
        let mut guard = self.running.lock().await;
        if let Some(mut r) = guard.take() {
            log::info!("stopping llama-server");
            let _ = r.child.kill().await;
        }
    }

    /// Stop the server if it hasn't been used for [`IDLE_TIMEOUT`].
    pub async fn stop_if_idle(&self) {
        let idle = self
            .last_used
            .lock()
            .map(|t| t.elapsed() >= IDLE_TIMEOUT)
            .unwrap_or(false);
        if idle && self.running.lock().await.is_some() {
            self.stop().await;
        }
    }

    /// Synchronous kill for app shutdown.
    pub fn kill_now(&self) {
        if let Ok(mut guard) = self.running.try_lock() {
            if let Some(mut r) = guard.take() {
                let _ = r.child.start_kill();
            }
        }
    }

    async fn ensure_running(
        &self,
        slot: &mut Option<Running>,
        model_path: &Path,
    ) -> Result<(), String> {
        if let Some(r) = slot.as_mut() {
            let alive = matches!(r.child.try_wait(), Ok(None));
            if alive && r.model_path == model_path {
                return Ok(());
            }
            let _ = r.child.kill().await;
            *slot = None;
        }
        if !model_path.exists() {
            return Err(
                "The selected model isn't downloaded. Open the Models tab to get one.".into(),
            );
        }
        if !self.sidecar.exists() {
            return Err(format!(
                "The model runtime is missing from this build ({}).",
                self.sidecar.display()
            ));
        }

        let port = free_port().map_err(|e| format!("no free local port: {e}"))?;
        let api_key = random_key()?;
        let log = std::fs::File::create(&self.log_path).map_err(|e| e.to_string())?;
        let log_err = log.try_clone().map_err(|e| e.to_string())?;

        log::info!(
            "starting llama-server on 127.0.0.1:{port} with {}",
            model_path.display()
        );
        let mut child = Command::new(&self.sidecar)
            .arg("--model")
            .arg(model_path)
            .args(["--host", "127.0.0.1", "--port", &port.to_string()])
            .args(["--api-key", &api_key])
            .args(["--ctx-size", CONTEXT_TOKENS, "--parallel", "1"])
            .args(["--n-gpu-layers", "99", "--jinja", "--no-webui"])
            // Models with a "thinking" mode (Gemma 4, Qwen3.5) would spend the
            // answer budget reasoning; Plucky only wants the JSON.
            .args(["--reasoning-budget", "0"])
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err))
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("couldn't start the model runtime: {e}"))?;

        let client = LlamaServerClient::new(
            &format!("http://127.0.0.1:{port}"),
            api_key,
            REQUEST_TIMEOUT,
        )
        .map_err(|e| e.to_string())?;

        let deadline = Instant::now() + STARTUP_TIMEOUT;
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!(
                    "The model runtime stopped while loading ({status}). {}",
                    last_log_line(&self.log_path)
                ));
            }
            if client.healthy().await {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill().await;
                return Err("The model took too long to load.".into());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        log::info!("llama-server ready");
        *slot = Some(Running {
            child,
            client,
            model_path: model_path.to_path_buf(),
        });
        Ok(())
    }
}

/// Tauri places sidecars next to the main executable (`Contents/MacOS` on
/// macOS), with the target triple stripped from the name.
fn sidecar_path() -> PathBuf {
    let name = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(name)))
        .unwrap_or_else(|| PathBuf::from(name))
}

fn free_port() -> std::io::Result<u16> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(l.local_addr()?.port())
}

fn random_key() -> Result<String, String> {
    let mut buf = [0u8; 24];
    getrandom::fill(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

fn last_log_line(path: &Path) -> String {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| {
            s.lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .map(|l| l.chars().take(200).collect())
        })
        .unwrap_or_default()
}
