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

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use todocity_core::download::{
    check_url, download_client, download_file, part_path, DownloadError,
};
use todocity_core::local_models::{self, FoundModel};
use todocity_core::models::{self, parse_tree_listing, CatalogModel, CATALOG};

use crate::engine::Engine;

#[derive(Default, Serialize, Deserialize)]
struct Settings {
    active_model: Option<String>,
    /// Model files the user pointed Todo City at instead of downloading.
    #[serde(default)]
    custom_models: Vec<CustomModel>,
}

/// A GGUF file elsewhere on disk that the user added by path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomModel {
    /// `file:<hash of path>`
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
    /// Where it was found ("Ollama", "LM Studio", …), if detected.
    pub source: Option<String>,
}

/// The model captures will use.
pub struct ActiveModel {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

#[derive(Serialize)]
pub struct CustomModelView {
    #[serde(flatten)]
    pub model: CustomModel,
    pub active: bool,
    /// False if the file has been moved or deleted since it was added.
    pub available: bool,
}

#[derive(Serialize)]
pub struct LocalModels {
    pub added: Vec<CustomModelView>,
    /// Models found from other apps that haven't been added yet.
    pub found: Vec<FoundModel>,
}

fn custom_id(path: &Path) -> String {
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    let hex: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
    format!("file:{hex}")
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

#[derive(Clone, Serialize)]
pub struct Progress {
    pub downloaded: u64,
    pub total: u64,
}

/// This Mac's memory in GB (16 when it can't be read), looked up once.
pub fn ram_gb() -> u32 {
    static RAM: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *RAM.get_or_init(|| {
        if !cfg!(target_os = "macos") {
            return 16;
        }
        std::process::Command::new("/usr/sbin/sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|t| t.trim().parse::<u64>().ok())
            .map(|bytes| (bytes / (1 << 30)) as u32)
            .filter(|gb| *gb > 0)
            .unwrap_or(16)
    })
}

#[derive(Serialize)]
pub struct ModelView {
    #[serde(flatten)]
    pub model: &'static CatalogModel,
    /// The best model for this Mac's memory.
    pub recommended: bool,
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

    fn catalog_active(&self, m: &CatalogModel) -> ActiveModel {
        ActiveModel {
            id: m.id.into(),
            name: m.name.into(),
            path: self.path_for(m),
        }
    }

    /// The best downloaded model this Mac has the memory for — so a better
    /// model is used as soon as it's downloaded. A file the user added by
    /// path is used when they chose it. Otherwise the first model present.
    pub fn active(&self) -> Option<ActiveModel> {
        let s = self.settings.lock().ok()?;
        let ram = ram_gb();
        let chose_file = s
            .active_model
            .as_deref()
            .is_some_and(|id| id.starts_with("file:"));
        if !chose_file {
            let best = CATALOG
                .iter()
                .filter(|m| m.min_ram_gb <= ram && self.is_installed(m))
                .min_by_key(|m| m.rank);
            if let Some(m) = best {
                return Some(self.catalog_active(m));
            }
        }
        if let Some(id) = s.active_model.as_deref() {
            if let Some(m) = models::find(id).filter(|m| self.is_installed(m)) {
                return Some(self.catalog_active(m));
            }
            if let Some(c) = s
                .custom_models
                .iter()
                .find(|c| c.id == id && c.path.is_file())
            {
                return Some(ActiveModel {
                    id: c.id.clone(),
                    name: c.name.clone(),
                    path: c.path.clone(),
                });
            }
        }
        if let Some(m) = CATALOG.iter().find(|m| self.is_installed(m)) {
            return Some(self.catalog_active(m));
        }
        s.custom_models
            .iter()
            .find(|c| c.path.is_file())
            .map(|c| ActiveModel {
                id: c.id.clone(),
                name: c.name.clone(),
                path: c.path.clone(),
            })
    }

    /// Whether `id` names a model whose file is present.
    pub fn is_available(&self, id: &str) -> bool {
        if let Some(m) = models::find(id) {
            return self.is_installed(m);
        }
        self.settings
            .lock()
            .map(|s| {
                s.custom_models
                    .iter()
                    .any(|c| c.id == id && c.path.is_file())
            })
            .unwrap_or(false)
    }

    fn write_settings(&self, s: &Settings) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
        std::fs::write(&self.settings_path, bytes).map_err(|e| e.to_string())
    }

    pub fn set_active(&self, id: Option<&str>) -> Result<(), String> {
        let mut s = self.settings.lock().map_err(|e| e.to_string())?;
        s.active_model = id.map(str::to_string);
        self.write_settings(&s)
    }

    /// Added files plus models found from other apps.
    pub fn local_models(&self) -> LocalModels {
        let active = self.active().map(|a| a.id);
        let added: Vec<CustomModel> = self
            .settings
            .lock()
            .map(|s| s.custom_models.clone())
            .unwrap_or_default();
        let found = home_dir()
            .map(|h| local_models::discover(&h))
            .unwrap_or_default()
            .into_iter()
            .filter(|f| !added.iter().any(|c| c.path == f.path))
            .collect();
        LocalModels {
            added: added
                .into_iter()
                .map(|c| CustomModelView {
                    active: active.as_deref() == Some(c.id.as_str()),
                    available: c.path.is_file(),
                    model: c,
                })
                .collect(),
            found,
        }
    }

    /// Validate a model file the user pointed at, remember it, and make it
    /// the active model.
    pub fn add_file(&self, input: &str, source: Option<String>) -> Result<CustomModel, String> {
        let path = local_models::normalize_user_path(input, home_dir().as_deref());
        if path.as_os_str().is_empty() {
            return Err("Enter the path of a model file.".into());
        }
        let info = local_models::inspect_gguf(&path).map_err(|e| e.to_string())?;
        let path = std::fs::canonicalize(&info.path).unwrap_or(info.path);
        let fallback = path
            .file_stem()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Custom model".into());
        let model = CustomModel {
            id: custom_id(&path),
            name: info.name.unwrap_or(fallback),
            path,
            size: info.size,
            source,
        };
        let mut s = self.settings.lock().map_err(|e| e.to_string())?;
        s.custom_models.retain(|c| c.id != model.id);
        s.custom_models.push(model.clone());
        s.active_model = Some(model.id.clone());
        self.write_settings(&s)?;
        Ok(model)
    }

    /// Forget an added file. The file itself is never deleted.
    pub async fn remove_file(&self, engine: &Engine, id: &str) -> Result<(), String> {
        if self.active().map(|a| a.id).as_deref() == Some(id) {
            engine.stop().await;
        }
        let mut s = self.settings.lock().map_err(|e| e.to_string())?;
        s.custom_models.retain(|c| c.id != id);
        if s.active_model.as_deref() == Some(id) {
            s.active_model = None;
        }
        self.write_settings(&s)
    }

    pub fn list(&self) -> Vec<ModelView> {
        let active = self.active().map(|m| m.id);
        let active = active.as_deref();
        let downloads = self.downloads.lock().ok();
        CATALOG
            .iter()
            .map(|m| ModelView {
                model: m,
                recommended: m.id == models::best_for(ram_gb()).id,
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
        if self.active().map(|a| a.id).as_deref() == Some(id) {
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
            Ok(()) => DownloadEvent::Done { id: id.clone() },
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
