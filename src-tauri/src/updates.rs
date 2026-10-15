//! In-app updates: check GitHub Releases for a newer signed build, download
//! it in the background, and offer "Restart to update".
//!
//! Every update is verified against the public key in `tauri.conf.json`
//! before it's installed, so only builds signed with the project's key can
//! replace the app.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::settings::Settings;

/// How often to look for updates while Plucky is running.
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum UpdateStatus {
    Idle,
    Checking,
    UpToDate,
    Downloading {
        version: String,
        percent: Option<u8>,
    },
    /// Downloaded and verified; restart to install.
    Ready {
        version: String,
        notes: Option<String>,
    },
    Failed {
        message: String,
    },
}

pub struct Updates {
    status: Mutex<UpdateStatus>,
    pending: Mutex<Option<(Update, Vec<u8>)>>,
    busy: Mutex<bool>,
}

impl Default for Updates {
    fn default() -> Self {
        Self {
            status: Mutex::new(UpdateStatus::Idle),
            pending: Mutex::new(None),
            busy: Mutex::new(false),
        }
    }
}

impl Updates {
    pub fn status(&self) -> UpdateStatus {
        self.status
            .lock()
            .map(|s| s.clone())
            .unwrap_or(UpdateStatus::Idle)
    }
}

fn set(app: &AppHandle, status: UpdateStatus) {
    if let Some(u) = app.try_state::<Updates>() {
        if let Ok(mut s) = u.status.lock() {
            *s = status.clone();
        }
    }
    let _ = app.emit("update-status", &status);
    crate::tray::refresh(app);
}

/// Check, and if there's a newer version, download it. Safe to call often:
/// only one check runs at a time.
pub async fn check(app: AppHandle) {
    let updates = app.state::<Updates>();
    {
        let Ok(mut busy) = updates.busy.lock() else {
            return;
        };
        if *busy || matches!(updates.status(), UpdateStatus::Ready { .. }) {
            return;
        }
        *busy = true;
    }
    set(&app, UpdateStatus::Checking);
    let result = check_inner(&app).await;
    if let Err(message) = result {
        log::warn!("update check failed: {message}");
        set(&app, UpdateStatus::Failed { message });
    }
    let released = updates.busy.lock().map(|mut busy| *busy = false);
    if released.is_err() {
        log::warn!("update lock poisoned");
    }
}

async fn check_inner(app: &AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        set(app, UpdateStatus::UpToDate);
        return Ok(());
    };
    let version = update.version.clone();
    log::info!("update {version} available; downloading");
    set(
        app,
        UpdateStatus::Downloading {
            version: version.clone(),
            percent: Some(0),
        },
    );
    let mut received: u64 = 0;
    let mut last_percent = 0u8;
    let progress_app = app.clone();
    let progress_version = version.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                received += chunk as u64;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let pct = ((received * 100) / total).min(100) as u8;
                    if pct >= last_percent + 5 {
                        last_percent = pct;
                        set(
                            &progress_app,
                            UpdateStatus::Downloading {
                                version: progress_version.clone(),
                                percent: Some(pct),
                            },
                        );
                    }
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    let notes = update.body.clone();
    if let Ok(mut p) = app.state::<Updates>().pending.lock() {
        *p = Some((update, bytes));
    }
    set(app, UpdateStatus::Ready { version, notes });
    Ok(())
}

/// Install the downloaded update and relaunch.
pub fn install_and_restart(app: &AppHandle) -> Result<(), String> {
    let pending = app
        .state::<Updates>()
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .take();
    let Some((update, bytes)) = pending else {
        return Err("No update has been downloaded yet.".into());
    };
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}

/// Check shortly after launch, then every few hours, if the user allows it.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            if app.state::<Settings>().get().auto_update {
                check(app.clone()).await;
            }
            tokio::time::sleep(INTERVAL).await;
        }
    });
}
