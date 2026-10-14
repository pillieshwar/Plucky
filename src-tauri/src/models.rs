//! Model management for the Models tab: which models are installed, which is
//! active, and downloads with progress events.
//!
//! Downloads are the app's only outbound network traffic, and they happen
//! only when the user presses Download.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pluck_core::download::{check_url, download_client, download_file, part_path, DownloadError};
use pluck_core::models::{self, parse_tree_listing, CatalogModel, CATALOG};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::engine::Engine;

#[derive(Default, Serialize, Deserialize)]
struct Settings {
    active_model: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct Progress {
    pub downloaded: u64,
    pub total: u64,
}

#[derive(Serialize)]
pub struct ModelView {
    #[serde(flatten)]
    pub model: &'static CatalogModel,
    pub installed: bool,
    pub active: bool,
    /// Bytes on disk from an interrupted download, if any.
    pub partial_bytes: u64,
    pub progress: Option<Progress>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DownloadEvent {
    Progress {
        id: String,
        downloaded: u64,
        total: u64,
    },
    Done {
        id: String,
    },
    Cancelled {
        id: String,
    },
    Failed {
        id: String,
        error: String,
    },
}

pub struct ModelManager {
    dir: PathBuf,
    settings_path: PathBuf,
    settings: Mutex<Settings>,
    downloads: Mutex<HashMap<String, (Arc<AtomicBool>, Progress)>>,
}

impl ModelManager {
    pub fn new(data_dir: &Path) -> Self {
        let settings_path = data_dir.join("settings.json");
        let settings = std::fs::read(&settings_path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            dir: data_dir.join("models"),
            settings_path,
            settings: Mutex::new(settings),
            downloads: Mutex::new(HashMap::new()),
        }
    }

    pub fn path_for(&self, m: &CatalogModel) -> PathBuf {
        self.dir.join(m.file)
    }

    pub fn is_installed(&self, m: &CatalogModel) -> bool {
        self.path_for(m).is_file()
    }

    /// The active model if it is installed; otherwise the first installed one.
    pub fn active(&self) -> Option<&'static CatalogModel> {
        let chosen = self
            .settings
            .lock()
            .ok()
            .and_then(|s| s.active_model.clone())
            .and_then(|id| models::find(&id))
            .filter(|m| self.is_installed(m));
        chosen.or_else(|| CATALOG.iter().find(|m| self.is_installed(m)))
    }

    pub fn set_active(&self, id: Option<&str>) -> Result<(), String> {
        let mut s = self.settings.lock().map_err(|e| e.to_string())?;
        s.active_model = id.map(str::to_string);
        let bytes = serde_json::to_vec_pretty(&*s).map_err(|e| e.to_string())?;
        std::fs::write(&self.settings_path, bytes).map_err(|e| e.to_string())
    }

    pub fn list(&self) -> Vec<ModelView> {
        let active = self.active().map(|m| m.id);
        let downloads = self.downloads.lock().ok();
        CATALOG
            .iter()
            .map(|m| ModelView {
                model: m,
                installed: self.is_installed(m),
                active: active == Some(m.id),
                partial_bytes: std::fs::metadata(part_path(&self.path_for(m)))
                    .map(|md| md.len())
                    .unwrap_or(0),
                progress: downloads
                    .as_ref()
                    .and_then(|d| d.get(m.id).map(|(_, p)| p.clone())),
            })
            .collect()
    }

    pub fn cancel(&self, id: &str) {
        if let Ok(d) = self.downloads.lock() {
            if let Some((flag, _)) = d.get(id) {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    /// Delete a model's files. Stops the engine first if it is using them.
    pub async fn delete(&self, engine: &Engine, id: &str) -> Result<(), String> {
        let m = models::find(id).ok_or("unknown model")?;
        self.cancel(id);
        if self.active().map(|a| a.id) == Some(id) {
            engine.stop().await;
        }
        for p in [self.path_for(m), part_path(&self.path_for(m))] {
            if p.exists() {
                std::fs::remove_file(&p).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    fn set_progress(&self, id: &str, p: Progress) {
        if let Ok(mut d) = self.downloads.lock() {
            if let Some(entry) = d.get_mut(id) {
                entry.1 = p;
            }
        }
    }

    fn finish(&self, id: &str) {
        if let Ok(mut d) = self.downloads.lock() {
            d.remove(id);
        }
    }
}

/// Start downloading `id` in the background. Progress, completion and errors
/// arrive as `model-download` events.
pub fn start_download(app: AppHandle, id: String) -> Result<(), String> {
    let model = models::find(&id).ok_or("unknown model")?;
    let manager = app.state::<ModelManager>();
    if manager.is_installed(model) {
        return Ok(());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut d = manager.downloads.lock().map_err(|e| e.to_string())?;
        if d.contains_key(&id) {
            return Ok(()); // already running
        }
        let start = Progress {
            downloaded: 0,
            total: model.approx_size_mb * 1_000_000,
        };
        d.insert(id.clone(), (cancel.clone(), start));
    }

    tauri::async_runtime::spawn(async move {
        let manager = app.state::<ModelManager>();
        let event = match run_download(&app, &manager, model, &cancel).await {
            Ok(()) => {
                if manager.active().map(|a| a.id) == Some(model.id) {
                    let _ = manager.set_active(Some(model.id));
                }
                DownloadEvent::Done { id: id.clone() }
            }
            Err(DownloadError::Cancelled) => DownloadEvent::Cancelled { id: id.clone() },
            Err(e) => DownloadEvent::Failed {
                id: id.clone(),
                error: e.to_string(),
            },
        };
        manager.finish(&id);
        let _ = app.emit("model-download", event);
    });
    Ok(())
}

async fn run_download(
    app: &AppHandle,
    manager: &ModelManager,
    model: &'static CatalogModel,
    cancel: &AtomicBool,
) -> Result<(), DownloadError> {
    let url = model.download_url();
    check_url(&url)?;
    check_url(&model.metadata_url())?;
    let client = download_client()?;

    let listing: serde_json::Value = client
        .get(model.metadata_url())
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| DownloadError::Network(e.to_string()))?
        .json()
        .await
        .map_err(|e| DownloadError::Network(e.to_string()))?;
    let meta = parse_tree_listing(&listing, model.file).ok_or_else(|| {
        DownloadError::Network(format!("{} is not listed in {}", model.file, model.repo))
    })?;
    if meta.sha256.is_none() {
        log::warn!(
            "no published checksum for {}; verifying size only",
            model.file
        );
    }

    let id = model.id.to_string();
    let mut last_emit: Option<Instant> = None;
    download_file(
        &client,
        &url,
        &manager.path_for(model),
        &meta,
        cancel,
        |downloaded, total| {
            manager.set_progress(&id, Progress { downloaded, total });
            let due = !matches!(last_emit, Some(t) if t.elapsed() < Duration::from_millis(200));
            if due || downloaded == total {
                last_emit = Some(Instant::now());
                let _ = app.emit(
                    "model-download",
                    DownloadEvent::Progress {
                        id: id.clone(),
                        downloaded,
                        total,
                    },
                );
            }
        },
    )
    .await
}
