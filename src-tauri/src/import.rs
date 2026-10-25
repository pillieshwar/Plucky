//! Data transfer: moving tasks in from Things 3 and Todoist.
//!
//! Things' database is never opened in place: it (and its write-ahead log)
//! is copied into a temporary folder first, read from there, and the copy is
//! deleted (see `things::read_copy`). Things can stay open the whole time.
//! Before anything is added, Todo City's own database is backed up
//! (`tasks-…-before-import.db`), and the import itself is one transaction.

use std::path::{Path, PathBuf};

use pluck_core::things::{self, Options, Preview};
use pluck_core::todoist;
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

// ── Todoist ─────────────────────────────────────────────────────────────────

/// What was read from Todoist, kept between the preview and the move (and
/// dropped after it). The token itself is never kept.
#[derive(Default)]
pub struct TodoistCache(std::sync::Mutex<Option<(todoist::SourceInfo, todoist::Library)>>);

#[derive(Debug, Clone, Serialize)]
pub struct TodoistPreview {
    pub source: todoist::SourceInfo,
    pub preview: Preview,
}

/// Choose exported Todoist CSV files (or the unzipped backup folder).
#[tauri::command]
pub async fn todoist_pick_files() -> CmdResult<Vec<String>> {
    let downloads = home().join("Downloads");
    let start = if downloads.is_dir() {
        downloads
    } else {
        home()
    };
    let script = format!(
        "set picked to choose file with prompt \"Choose your Todoist CSV files (or open a backup folder and select them all)\" \
         of type {{\"public.comma-separated-values-text\", \"public.plain-text\"}} default location (POSIX file \"{}\") \
         with multiple selections allowed\n\
         set out to \"\"\n\
         repeat with f in picked\n\
         set out to out & POSIX path of f & linefeed\n\
         end repeat\n\
         return out",
        start.display().to_string().replace('\\', "\\\\").replace('"', "\\\"")
    );
    let out = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
        .map_err(err)?;
    if !out.status.success() {
        return Ok(Vec::new());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect())
}

/// CSV files from what was picked: files, or folders holding them.
fn csv_files(paths: &[String]) -> CmdResult<Vec<(String, String)>> {
    let mut files = Vec::new();
    for p in paths {
        let p = Path::new(p);
        let list: Vec<PathBuf> = if p.is_dir() {
            let mut v: Vec<PathBuf> = std::fs::read_dir(p)
                .map_err(err)?
                .flatten()
                .map(|e| e.path())
                .filter(|f| f.extension().is_some_and(|x| x.eq_ignore_ascii_case("csv")))
                .collect();
            v.sort();
            v
        } else {
            vec![p.to_path_buf()]
        };
        for f in list {
            let name = f
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let bytes = std::fs::read(&f).map_err(|e| format!("Couldn't read {name}: {e}"))?;
            files.push((name, String::from_utf8_lossy(&bytes).to_string()));
        }
    }
    Ok(files)
}

fn todoist_plan(
    state: &AppState,
    cache: &TodoistCache,
    opts: &Options,
) -> CmdResult<(todoist::SourceInfo, todoist::Plan)> {
    let guard = cache.0.lock().map_err(err)?;
    let Some((source, lib)) = guard.as_ref() else {
        return Err("Connect Todoist or choose its CSV files first.".into());
    };
    let already = state
        .store
        .lock()
        .map_err(err)?
        .imported_ids(todoist::SOURCE)
        .map_err(err)?;
    let today = chrono::Local::now().date_naive();
    Ok((source.clone(), todoist::plan(lib, opts, &already, today)))
}

/// Read Todoist — over its API with `token`, or from CSV `files` — and show
/// what would move in. With neither, re-plans what was read last (for
/// changed options). Nothing in Todo City changes.
#[tauri::command]
pub async fn todoist_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    cache: State<'_, TodoistCache>,
    token: Option<String>,
    files: Option<Vec<String>>,
    options: Option<Options>,
) -> CmdResult<TodoistPreview> {
    let token = token
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let files = files.filter(|f| !f.is_empty());
    if let Some(token) = token {
        let client = reqwest::Client::builder()
            .user_agent(concat!("TodoCity/", env!("CARGO_PKG_VERSION")))
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(err)?;
        let progress = |line: &str| {
            let _ = app.emit("todoist-progress", line);
        };
        let lib = todoist::fetch(
            &client,
            todoist::API_BASE,
            &token,
            chrono::Utc::now(),
            progress,
        )
        .await
        .map_err(|e| e.to_string())?;
        let source = todoist::SourceInfo {
            kind: "api".into(),
            label: "your Todoist account".into(),
        };
        *cache.0.lock().map_err(err)? = Some((source, lib));
    } else if let Some(files) = files {
        let read = csv_files(&files)?;
        let count = read.len();
        let lib = todoist::read_csv(&read).map_err(|e| e.to_string())?;
        let source = todoist::SourceInfo {
            kind: "csv".into(),
            label: format!("{count} CSV {}", if count == 1 { "file" } else { "files" }),
        };
        *cache.0.lock().map_err(err)? = Some((source, lib));
    }
    let (source, plan) = todoist_plan(&state, &cache, &options.unwrap_or_default())?;
    Ok(TodoistPreview {
        source,
        preview: plan.preview,
    })
}

/// Bring in what the last preview read. Todo City is backed up first;
/// anything brought in before is skipped.
#[tauri::command]
pub async fn todoist_import(
    app: AppHandle,
    state: State<'_, AppState>,
    cache: State<'_, TodoistCache>,
    options: Option<Options>,
) -> CmdResult<ImportReport> {
    let (_, plan) = todoist_plan(&state, &cache, &options.unwrap_or_default())?;
    let report = {
        let store = state.store.lock().map_err(err)?;
        if !plan.items.is_empty() {
            data::safety_copy(&store, &state.data_dir, "import")?;
        }
        store
            .import(todoist::SOURCE, &plan.floors, &plan.items)
            .map_err(|e| format!("Nothing was imported: {e}"))?
    };
    *cache.0.lock().map_err(err)? = None;
    log::info!(
        "imported from Todoist: {} added ({} done), {} skipped, {} failed",
        report.added,
        report.done,
        report.skipped,
        report.failed
    );
    let _ = app.emit("tasks-changed", ());
    tray::refresh(&app);
    Ok(report)
}
