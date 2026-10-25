//! Data transfer: moving tasks in from Things 3.
//!
//! Things' database is never opened in place: it (and its write-ahead log)
//! is copied into a temporary folder first, read from there, and the copy is
//! deleted (see `things::read_copy`). Things can stay open the whole time.
//! Before anything is added, Todo City's own database is backed up
//! (`tasks-…-before-import.db`), and the import itself is one transaction.

use std::path::{Path, PathBuf};

use pluck_core::things::{self, Options, Preview};
use pluck_core::ImportReport;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::{data, err, tray, AppState, CmdResult};

#[derive(Debug, Clone, Serialize)]
pub struct ThingsSource {
    /// The `main.sqlite` that would be read.
    pub path: String,
    /// When Things last wrote it (RFC 3339), to tell copies apart.
    pub modified: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThingsPreview {
    pub source: ThingsSource,
    pub preview: Preview,
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

fn source_of(path: &Path) -> ThingsSource {
    let modified = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());
    ThingsSource {
        path: path.display().to_string(),
        modified,
    }
}

fn friendly(e: things::ThingsError) -> String {
    let denied = matches!(&e, things::ThingsError::Io(io) if io.kind() == std::io::ErrorKind::PermissionDenied);
    if denied {
        "macOS didn't let Todo City read Things' data. Click Allow when macOS asks, or turn on Todo City in \
         System Settings → Privacy & Security → Full Disk Access, then try again."
            .into()
    } else {
        match e {
            things::ThingsError::NotThings => e.to_string(),
            e => format!("Couldn't read the Things database: {e}"),
        }
    }
}

/// The database to read: the one the user picked, or the newest on this Mac.
fn locate(path: Option<&str>) -> CmdResult<PathBuf> {
    match path.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => things::resolve_pick(Path::new(p)).ok_or_else(|| {
            "That isn't a Things database. Choose main.sqlite, or the \"Things Database.thingsdatabase\" folder."
                .to_string()
        }),
        None => things::find_databases(&home())
            .into_iter()
            .next()
            .ok_or_else(|| {
                "Things 3 isn't on this Mac (or hasn't saved anything yet). Open Things once, or choose its \
                 database yourself."
                    .to_string()
            }),
    }
}

fn read_plan(
    state: &AppState,
    path: Option<&str>,
    opts: &Options,
) -> CmdResult<(ThingsSource, things::Plan)> {
    let db = locate(path)?;
    let lib = things::read_copy(&db, &state.data_dir).map_err(friendly)?;
    let already = state
        .store
        .lock()
        .map_err(err)?
        .imported_ids(things::SOURCE)
        .map_err(err)?;
    let today = chrono::Local::now().date_naive();
    Ok((source_of(&db), things::plan(&lib, opts, &already, today)))
}

/// The Things 3 databases on this Mac (usually one), newest first.
#[tauri::command]
pub async fn things_find() -> CmdResult<Vec<ThingsSource>> {
    Ok(things::find_databases(&home())
        .iter()
        .map(PathBuf::as_path)
        .map(source_of)
        .collect())
}

/// Ask for a Things database with the standard macOS file picker.
#[tauri::command]
pub async fn things_pick() -> CmdResult<Option<String>> {
    let group = home().join("Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac");
    let start = if group.is_dir() { group } else { home() };
    let script = format!(
        "POSIX path of (choose file with prompt \"Choose your Things 3 database (main.sqlite, or Things \
         Database.thingsdatabase)\" default location (POSIX file \"{}\"))",
        start.display().to_string().replace('\\', "\\\\").replace('"', "\\\"")
    );
    let out = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
        .map_err(err)?;
    if !out.status.success() {
        // Cancelled.
        return Ok(None);
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((!path.is_empty()).then_some(path))
}

/// What an import would bring in. Nothing changes.
#[tauri::command]
pub async fn things_preview(
    state: State<'_, AppState>,
    path: Option<String>,
    options: Option<Options>,
) -> CmdResult<ThingsPreview> {
    let (source, plan) = read_plan(&state, path.as_deref(), &options.unwrap_or_default())?;
    Ok(ThingsPreview {
        source,
        preview: plan.preview,
    })
}

/// Bring the tasks in. Todo City's database is backed up first; anything
/// brought in before is skipped.
#[tauri::command]
pub async fn things_import(
    app: AppHandle,
    state: State<'_, AppState>,
    path: Option<String>,
    options: Option<Options>,
) -> CmdResult<ImportReport> {
    let (_, plan) = read_plan(&state, path.as_deref(), &options.unwrap_or_default())?;
    let report = {
        let store = state.store.lock().map_err(err)?;
        if !plan.items.is_empty() {
            data::safety_copy(&store, &state.data_dir, "import")?;
        }
        store
            .import(things::SOURCE, &plan.floors, &plan.items)
            .map_err(|e| format!("Nothing was imported: {e}"))?
    };
    log::info!(
        "imported from Things 3: {} added ({} done), {} skipped, {} failed",
        report.added,
        report.done,
        report.skipped,
        report.failed
    );
    let _ = app.emit("tasks-changed", ());
    tray::refresh(&app);
    Ok(report)
}
