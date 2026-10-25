//! Moving from Things 3: read its database and turn it into Todo City tasks.
//!
//! Things keeps everything in one SQLite file on the Mac
//! (`…/Things Database.thingsdatabase/main.sqlite`). This module only reads
//! it — the caller opens a *copy* — and maps it like this:
//!
//! | Things 3              | Todo City                          |
//! |-----------------------|------------------------------------|
//! | Project               | Project (a building)               |
//! | Heading               | Floor                              |
//! | To-do                 | Task (a home)                      |
//! | Checklist             | Sub-tasks                          |
//! | Area (its own to-dos) | A project named after the area     |
//! | Inbox / loose to-dos  | Tasks with no project (houses)     |
//! | When / This Evening   | Day / evening                      |
//! | Someday               | Someday                            |
//! | Deadline, reminder    | Deadline, time of day              |
//! | Repeating to-do       | Repeat rule, when it maps          |
//! | Tags                  | `#tags` at the end of the title    |
//! | Logbook               | Done tasks (lit windows)           |
//!
//! Cancelled and trashed to-dos stay behind (cancelled ones can come along
//! as done, if asked). The schema has changed over the years, so every
//! column is optional: a missing one just reads as empty.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Local, NaiveDate, TimeZone, Utc};
use rusqlite::{types::Value, Connection};
use serde::{Deserialize, Serialize};

use crate::recurrence::Rule;
use crate::store::{ChecklistItem, Imported, NewTask};

/// Where imported tasks are recorded as coming from.
pub const SOURCE: &str = "things3";
/// What the task says it came from.
pub const APP_NAME: &str = "Things 3";

/// The key of the building for to-dos with no project and no area.
pub const LOOSE_KEY: &str = "";

#[derive(Debug, thiserror::Error)]
pub enum ThingsError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error("This doesn't look like a Things 3 database.")]
    NotThings,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// One raw row of `TMTask`.
#[derive(Debug, Clone, Default)]
struct Row {
    uuid: String,
    kind: i64,
    status: i64,
    trashed: bool,
    title: String,
    notes: Option<String>,
    start: i64,
    start_date: Option<f64>,
    evening: bool,
    deadline: Option<f64>,
    stop: Option<f64>,
    created: Option<f64>,
    project: Option<String>,
    heading: Option<String>,
    area: Option<String>,
    index: i64,
    reminder: Option<i64>,
    rule: Option<Vec<u8>>,
    template: Option<String>,
    next_start: Option<f64>,
}

/// Everything read from a Things database, before any choices are made.
#[derive(Debug, Clone, Default)]
pub struct Library {
    rows: Vec<Row>,
    areas: HashMap<String, String>,
    checklists: HashMap<String, Vec<ChecklistItem>>,
    tags: HashMap<String, Vec<String>>,
}

/// What to bring over.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Options {
    /// Bring the Logbook too (finished to-dos light up the city).
    pub include_done: bool,
    /// Bring cancelled to-dos, as done.
    pub include_canceled: bool,
    /// Buildings (by [`BuildingPreview::key`]) to leave behind.
    pub skip: Vec<String>,
}

/// One building-to-be in the preview.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct BuildingPreview {
    /// Stable key: the Things project or area id, or [`LOOSE_KEY`].
    pub key: String,
    /// The name it gets here (blank for loose to-dos).
    pub name: String,
    /// "project", "area" or "loose".
    pub kind: String,
    /// The Things area a project sits in, if any.
    pub area: Option<String>,
    pub open: usize,
    pub done: usize,
    pub floors: usize,
}

/// What an import would bring, shown before anything changes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Preview {
    pub buildings: Vec<BuildingPreview>,
    pub open: usize,
    pub done: usize,
    pub someday: usize,
    pub repeating: usize,
    pub subtasks: usize,
    pub canceled: usize,
    /// Repeats whose pattern Todo City can't follow (kept as one-off tasks).
    pub unmapped_repeats: usize,
    /// Brought in by an earlier import, so they'll be skipped.
    pub already: usize,
}

/// The result of turning a library into tasks.
#[derive(Debug, Clone, Default)]
pub struct Plan {
    pub preview: Preview,
    /// Projects and floors to create, in Things' order: `(project, None)`
    /// for a building, `(project, Some(floor))` for each floor.
    pub floors: Vec<(String, Option<String>)>,
    pub items: Vec<Imported>,
}

// ── Reading ─────────────────────────────────────────────────────────────────

fn columns(conn: &Connection, table: &str) -> Result<HashSet<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
    rows.collect()
}

/// `name` if the table has it, otherwise `NULL`, so old schemas still read.
fn col(have: &HashSet<String>, name: &str) -> String {
    if have.contains(name) {
        format!("\"{name}\"")
    } else {
        "NULL".into()
    }
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Integer(i) => Some(*i as f64),
        Value::Real(f) => Some(*f),
        Value::Text(t) => t.trim().parse().ok(),
        _ => None,
    }
}

fn text(v: &Value) -> Option<String> {
    match v {
        Value::Text(t) => Some(t.clone()),
        Value::Blob(b) => String::from_utf8(b.clone()).ok(),
        _ => None,
    }
}

fn int(v: &Value) -> i64 {
    num(v).map_or(0, |f| f as i64)
}

/// Read everything an import needs. `conn` should be a copy of the
/// database, opened read-only.
pub fn read(conn: &Connection) -> Result<Library, ThingsError> {
    let have = columns(conn, "TMTask")?;
    if !have.contains("uuid") || !have.contains("title") {
        return Err(ThingsError::NotThings);
    }
    let names = [
        "uuid",
        "type",
        "status",
        "trashed",
        "title",
        "notes",
        "start",
        "startDate",
        "startBucket",
        "deadline",
        "stopDate",
        "creationDate",
        "project",
        "heading",
        "area",
        "index",
        "reminderTime",
        "rt1_recurrenceRule",
        "rt1_repeatingTemplate",
        "rt1_nextInstanceStartDate",
    ];
    let select = names
        .iter()
        .map(|n| col(&have, n))
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn.prepare(&format!("SELECT {select} FROM TMTask"))?;
    let rows = stmt.query_map([], |r| {
        let v = |i: usize| r.get::<_, Value>(i);
        Ok(Row {
            uuid: text(&v(0)?).unwrap_or_default(),
            kind: int(&v(1)?),
            status: int(&v(2)?),
            trashed: int(&v(3)?) != 0,
            title: text(&v(4)?).unwrap_or_default(),
            notes: text(&v(5)?),
            start: int(&v(6)?),
            start_date: num(&v(7)?),
            evening: int(&v(8)?) == 1,
            deadline: num(&v(9)?),
            stop: num(&v(10)?),
            created: num(&v(11)?),
            project: text(&v(12)?),
            heading: text(&v(13)?),
            area: text(&v(14)?),
            index: int(&v(15)?),
            reminder: num(&v(16)?).map(|f| f as i64),
            rule: match v(17)? {
                Value::Blob(b) => Some(b),
                Value::Text(t) => Some(t.into_bytes()),
                _ => None,
            },
            template: text(&v(18)?),
            next_start: num(&v(19)?),
        })
    })?;
    let rows = rows
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|r| !r.uuid.is_empty())
        .collect();

    let mut lib = Library {
        rows,
        ..Default::default()
    };

    if table_exists(conn, "TMArea")? {
        let mut stmt = conn.prepare("SELECT uuid, title FROM TMArea")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, Value>(0)?, r.get::<_, Value>(1)?)))? {
            let (id, title) = row?;
            if let (Some(id), Some(title)) = (text(&id), text(&title)) {
                lib.areas.insert(id, title);
            }
        }
    }

    if table_exists(conn, "TMChecklistItem")? {
        let have = columns(conn, "TMChecklistItem")?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {}, {}, {}, {} FROM TMChecklistItem ORDER BY {}",
            col(&have, "task"),
            col(&have, "title"),
            col(&have, "status"),
            col(&have, "index"),
            col(&have, "index"),
        ))?;
        for row in stmt.query_map([], |r| {
            Ok((
                r.get::<_, Value>(0)?,
                r.get::<_, Value>(1)?,
                r.get::<_, Value>(2)?,
            ))
        })? {
            let (task, title, status) = row?;
            let (Some(task), Some(title)) = (text(&task), text(&title)) else {
                continue;
            };
            lib.checklists.entry(task).or_default().push(ChecklistItem {
                text: title,
                // Completed (3) or cancelled (2): nothing left to do.
                done: int(&status) != 0,
            });
        }
    }

    if table_exists(conn, "TMTaskTag")? && table_exists(conn, "TMTag")? {
        let mut stmt = conn.prepare(
            "SELECT tt.tasks, t.title FROM TMTaskTag tt JOIN TMTag t ON t.uuid = tt.tags
             ORDER BY t.title COLLATE NOCASE",
        )?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, Value>(0)?, r.get::<_, Value>(1)?)))? {
            let (task, tag) = row?;
            if let (Some(task), Some(tag)) = (text(&task), text(&tag)) {
                lib.tags.entry(task).or_default().push(tag);
            }
        }
    }
    Ok(lib)
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, rusqlite::Error> {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [name],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
}

// ── Values ──────────────────────────────────────────────────────────────────

const TODO: i64 = 0;
const PROJECT: i64 = 1;
const HEADING: i64 = 2;
const OPEN: i64 = 0;
const CANCELED: i64 = 2;
const COMPLETED: i64 = 3;
const SOMEDAY: i64 = 2;

/// A Things day. Newer versions pack it as `year<<16 | month<<12 | day<<7`;
/// older ones stored a Unix timestamp.
fn day(v: Option<f64>) -> Option<NaiveDate> {
    let v = v?;
    if v <= 0.0 {
        return None;
    }
    let i = v as i64;
    if ((2000 << 16)..(2200 << 16)).contains(&i) {
        NaiveDate::from_ymd_opt(
            (i >> 16) as i32,
            ((i >> 12) & 0xF) as u32,
            ((i >> 7) & 0x1F) as u32,
        )
    } else {
        Local.timestamp_opt(i, 0).single().map(|d| d.date_naive())
    }
}

/// A Things moment (Unix seconds) as RFC 3339 UTC.
fn moment(v: Option<f64>) -> Option<String> {
    let v = v.filter(|v| *v > 0.0)?;
    DateTime::<Utc>::from_timestamp(v as i64, 0)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// A reminder time, packed as `hour<<26 | minute<<20`, as `HH:MM`.
fn clock(v: Option<i64>) -> Option<String> {
    let v = v?;
    let (h, m) = ((v >> 26) & 0x1F, (v >> 20) & 0x3F);
    (v > 0 && h < 24 && m < 60).then(|| format!("{h:02}:{m:02}"))
}

/// Notes as plain text: old versions wrap them in `<note>` XML.
fn clean_notes(s: Option<&str>) -> Option<String> {
    let s = s?.trim();
    let s = if s.starts_with("<note") {
        let inner = s.split_once('>').map_or("", |(_, rest)| rest);
        let inner = inner.strip_suffix("</note>").unwrap_or(inner);
        inner
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&amp;", "&")
    } else {
        s.to_string()
    };
    let s = s.trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// A Things tag as a Todo City `#tag`: spaces become dashes, and only
/// letters, digits, `_` and `-` are kept ("Work Stuff!" → `#Work-Stuff`).
fn hashtag(tag: &str) -> Option<String> {
    let t: String = tag
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    let t = t.trim_matches('-');
    (!t.is_empty()).then(|| format!("#{t}"))
}

/// The first `<integer>` after `<key>name</key>` in an XML plist.
fn plist_int(xml: &str, name: &str) -> Option<i64> {
    let key = format!("<key>{name}</key>");
    let rest = &xml[xml.find(&key)? + key.len()..];
    let rest = rest.trim_start().strip_prefix("<integer>")?;
    rest[..rest.find("</integer>")?].trim().parse().ok()
}

fn plist_ints(xml: &str, name: &str) -> Vec<i64> {
    let key = format!("<key>{name}</key>");
    let mut out = Vec::new();
    let mut s = xml;
    while let Some(i) = s.find(&key) {
        s = &s[i + key.len()..];
        if let Some(rest) = s.trim_start().strip_prefix("<integer>") {
            if let Some(n) = rest
                .find("</integer>")
                .and_then(|e| rest[..e].trim().parse().ok())
            {
                out.push(n);
            }
        }
    }
    out
}

/// A Things repeat rule (an XML plist) as one of Todo City's, when there's
/// a match. `fu` is the unit (16 day, 256 week, 8 month, 4 year), `fa`
/// how many of them, `wd` the weekdays (1 Sunday … 7 Saturday).
pub fn repeat_rule(blob: &[u8]) -> Option<Rule> {
    let xml = std::str::from_utf8(blob).ok()?;
    let unit = plist_int(xml, "fu")?;
    let every = plist_int(xml, "fa").unwrap_or(1);
    let mut days = plist_ints(xml, "wd");
    days.sort_unstable();
    days.dedup();
    match (unit, every) {
        (16, 1) => Some(Rule::Daily),
        (256 | 8192, 1) if days == [2, 3, 4, 5, 6] => Some(Rule::Weekdays),
        (256 | 8192, 1) if days.len() <= 1 => Some(Rule::Weekly),
        (256 | 8192, 2) if days.len() <= 1 => Some(Rule::Biweekly),
        (16, 7) => Some(Rule::Weekly),
        (16, 14) => Some(Rule::Biweekly),
        (8, 1) => Some(Rule::Monthly),
        (8, 12) | (4, 1) => Some(Rule::Yearly),
        _ => None,
    }
}

// ── Planning ────────────────────────────────────────────────────────────────

struct Building {
    key: String,
    name: String,
    kind: &'static str,
    area: Option<String>,
    index: i64,
}

/// Turn a library into tasks for Todo City. `already` holds the ids brought
/// in before (they're counted, not repeated); `today` is the local day.
pub fn plan(lib: &Library, opts: &Options, already: &HashSet<String>, today: NaiveDate) -> Plan {
    let by_id: HashMap<&str, &Row> = lib.rows.iter().map(|r| (r.uuid.as_str(), r)).collect();
    let skip: HashSet<&str> = opts.skip.iter().map(String::as_str).collect();

    // Buildings: live projects, and areas that hold loose to-dos. Names are
    // made unique so two Things projects called "Home" stay apart.
    let mut buildings: BTreeMap<String, Building> = BTreeMap::new();
    let mut used: HashSet<String> = HashSet::new();
    let unique = |name: &str, used: &mut HashSet<String>| -> String {
        let base: String = {
            let n = name.split_whitespace().collect::<Vec<_>>().join(" ");
            let n: String = n.chars().take(54).collect();
            if n.is_empty() {
                "Untitled project".into()
            } else {
                n
            }
        };
        let mut name = base.clone();
        let mut i = 2;
        while !used.insert(name.to_lowercase()) {
            name = format!("{base} ({i})");
            i += 1;
        }
        name
    };
    let mut projects: Vec<&Row> = lib
        .rows
        .iter()
        .filter(|r| r.kind == PROJECT && !r.trashed && r.status != CANCELED)
        .collect();
    projects.sort_by_key(|r| r.index);
    for p in &projects {
        let name = unique(&p.title, &mut used);
        let area = p.area.as_ref().and_then(|a| lib.areas.get(a)).cloned();
        buildings.insert(
            p.uuid.clone(),
            Building {
                key: p.uuid.clone(),
                name,
                kind: "project",
                area,
                index: p.index,
            },
        );
    }

    // Which building a to-do lives in, and on which floor.
    let place = |r: &Row| -> (Option<&Row>, Option<&Row>) {
        let heading = r
            .heading
            .as_deref()
            .and_then(|h| by_id.get(h).copied())
            .filter(|h| h.kind == HEADING);
        let project = r
            .project
            .as_deref()
            .or(heading.and_then(|h| h.project.as_deref()))
            .and_then(|p| by_id.get(p).copied())
            .filter(|p| p.kind == PROJECT);
        (project, heading)
    };

    let mut preview = Preview::default();
    let mut floors: Vec<(String, Option<String>)> = Vec::new();
    let mut floor_seen: HashSet<(String, String)> = HashSet::new();
    let mut items: Vec<Imported> = Vec::new();
    let mut counts: HashMap<String, (usize, usize)> = HashMap::new();

    // Repeating: templates hold the rule; instances point at them. The rule
    // goes on the earliest open instance, so finishing it makes the next.
    let templates: HashMap<&str, &Row> = lib
        .rows
        .iter()
        .filter(|r| r.kind == TODO && r.rule.is_some() && !r.trashed)
        .map(|r| (r.uuid.as_str(), r))
        .collect();
    let mut first_open: HashMap<&str, &Row> = HashMap::new();
    for r in &lib.rows {
        if let Some(t) = r.template.as_deref().filter(|t| templates.contains_key(t)) {
            if r.status == OPEN && !r.trashed {
                let e = first_open.entry(t).or_insert(r);
                if day(r.start_date) < day(e.start_date) {
                    *e = r;
                }
            }
        }
    }

    let mut todos: Vec<&Row> = lib
        .rows
        .iter()
        .filter(|r| r.kind == TODO && !r.trashed)
        .collect();
    todos.sort_by_key(|r| r.index);

    for r in todos {
        let is_template = templates.contains_key(r.uuid.as_str());
        if is_template {
            // A template only comes in when no copy of it is open yet: as
            // its next occurrence.
            if first_open.contains_key(r.uuid.as_str()) || r.status != OPEN {
                continue;
            }
        }
        let canceled = r.status == CANCELED;
        if canceled && !opts.include_canceled {
            preview.canceled += 1;
            continue;
        }
        let done = r.status == COMPLETED || canceled;
        if done && !opts.include_done {
            continue;
        }

        let (project, heading) = place(r);
        // A to-do in a trashed or cancelled project stays behind with it.
        if let Some(p) = project {
            if p.trashed || (p.status == CANCELED && !opts.include_canceled) {
                continue;
            }
        }
        let key = match (project, r.area.as_deref()) {
            (Some(p), _) => p.uuid.clone(),
            (None, Some(a)) if lib.areas.contains_key(a) => format!("area:{a}"),
            _ => LOOSE_KEY.to_string(),
        };
        if !buildings.contains_key(&key) && key != LOOSE_KEY {
            if let Some(a) = key.strip_prefix("area:") {
                let name = unique(&lib.areas[a], &mut used);
                buildings.insert(
                    key.clone(),
                    Building {
                        key: key.clone(),
                        name,
                        kind: "area",
                        area: None,
                        index: i64::MAX,
                    },
                );
            } else {
                // A project that was itself cancelled but whose to-dos came.
                let p = project.unwrap();
                let name = unique(&p.title, &mut used);
                buildings.insert(
                    key.clone(),
                    Building {
                        key: key.clone(),
                        name,
                        kind: "project",
                        area: None,
                        index: p.index,
                    },
                );
            }
        }
        if already.contains(&r.uuid) {
            preview.already += 1;
            continue;
        }
        // Counted before the skip list, so an unticked building still
        // shows what it holds.
        let c = counts.entry(key.clone()).or_default();
        if done {
            c.1 += 1
        } else {
            c.0 += 1
        }
        if skip.contains(key.as_str()) {
            continue;
        }

        let building = buildings.get(&key).map(|b| b.name.clone());
        let floor = building.as_ref().and(heading).map(|h| {
            let t = h.title.split_whitespace().collect::<Vec<_>>().join(" ");
            if t.is_empty() {
                "Untitled heading".to_string()
            } else {
                t
            }
        });
        if let Some(b) = &building {
            if floor_seen.insert((b.clone(), String::new())) {
                floors.push((b.clone(), None));
            }
            if let Some(f) = &floor {
                if floor_seen.insert((b.clone(), f.clone())) {
                    floors.push((b.clone(), Some(f.clone())));
                }
            }
        }

        // When: a to-do whose day has come is on Things' Today list, so it
        // comes in for today rather than as overdue.
        let template_day = is_template.then(|| day(r.next_start)).flatten();
        let mut due = template_day.or(day(r.start_date));
        if !done {
            due = due.map(|d| d.max(today));
        }
        let in_someday_project =
            project.is_some_and(|p| p.start == SOMEDAY && day(p.start_date).is_none());
        let someday = !done && due.is_none() && (r.start == SOMEDAY || in_someday_project);

        let rule_row = if is_template {
            Some(r)
        } else {
            r.template
                .as_deref()
                .filter(|t| first_open.get(t).is_some_and(|o| o.uuid == r.uuid))
                .and_then(|t| templates.get(t).copied())
        };
        let mut rule = None;
        let mut repeat_note = false;
        if let Some(t) = rule_row {
            match t.rule.as_deref().and_then(repeat_rule) {
                Some(x) if due.is_some() => {
                    rule = Some(x);
                    preview.repeating += 1;
                }
                _ => {
                    repeat_note = true;
                    preview.unmapped_repeats += 1;
                }
            }
        }

        let mut notes = clean_notes(r.notes.as_deref()).unwrap_or_default();
        if repeat_note {
            if !notes.is_empty() {
                notes.push_str("\n\n");
            }
            notes.push_str("Repeated in Things 3 — set a repeat here if you still need it.");
        }

        let checklist = lib.checklists.get(&r.uuid).cloned().unwrap_or_default();
        preview.subtasks += checklist.len();
        let mut title = {
            let t = r.title.split_whitespace().collect::<Vec<_>>().join(" ");
            if t.is_empty() {
                "Untitled to-do".to_string()
            } else {
                t
            }
        };
        for tag in lib.tags.get(&r.uuid).into_iter().flatten() {
            if let Some(tag) = hashtag(tag) {
                if !title.to_lowercase().contains(&tag.to_lowercase()) {
                    title.push(' ');
                    title.push_str(&tag);
                }
            }
        }
        let due_s = due.map(|d| d.format("%Y-%m-%d").to_string());
        let task = NewTask {
            title,
            due_time: due_s.as_ref().and(clock(r.reminder)),
            evening: due_s.is_some() && r.evening,
            due_date: due_s,
            recurrence: rule.map(|x| x.as_str().to_string()),
            notes: (!notes.is_empty()).then_some(notes),
            deadline: day(r.deadline).map(|d| d.format("%Y-%m-%d").to_string()),
            someday,
            project: building,
            heading: floor,
            checklist,
            source_app: Some(APP_NAME.into()),
            ..Default::default()
        };
        if done {
            preview.done += 1
        } else {
            preview.open += 1;
            preview.someday += someday as usize;
        }
        items.push(Imported {
            ext_id: r.uuid.clone(),
            task,
            done,
            completed_at: moment(r.stop),
            created_at: moment(r.created),
        });
    }

    // Projects with nothing in them still come, so the city matches.
    for p in &projects {
        if skip.contains(p.uuid.as_str()) {
            continue;
        }
        let name = buildings[&p.uuid].name.clone();
        if floor_seen.insert((name.clone(), String::new())) {
            floors.push((name.clone(), None));
        }
        let mut heads: Vec<&Row> = lib
            .rows
            .iter()
            .filter(|h| h.kind == HEADING && !h.trashed && h.project.as_deref() == Some(&p.uuid))
            .collect();
        heads.sort_by_key(|h| h.index);
        for h in heads {
            let t = h.title.split_whitespace().collect::<Vec<_>>().join(" ");
            if !t.is_empty() && floor_seen.insert((name.clone(), t.clone())) {
                floors.push((name.clone(), Some(t)));
            }
        }
    }

    let floor_count = |name: &str| {
        floors
            .iter()
            .filter(|(p, f)| p == name && f.is_some())
            .count()
    };
    let mut list: Vec<&Building> = buildings.values().collect();
    list.sort_by(|a, b| {
        (a.kind != "project", a.index, &a.name).cmp(&(b.kind != "project", b.index, &b.name))
    });
    for b in list {
        let (open, done) = counts.get(&b.key).copied().unwrap_or_default();
        preview.buildings.push(BuildingPreview {
            key: b.key.clone(),
            name: b.name.clone(),
            kind: b.kind.into(),
            area: b.area.clone(),
            open,
            done,
            floors: floor_count(&b.name),
        });
    }
    if let Some(&(open, done)) = counts.get(LOOSE_KEY) {
        preview.buildings.push(BuildingPreview {
            key: LOOSE_KEY.into(),
            name: String::new(),
            kind: "loose".into(),
            area: None,
            open,
            done,
            floors: 0,
        });
    }
    Plan {
        preview,
        floors,
        items,
    }
}

/// Read the database at `db` without touching it: it (and its write-ahead
/// log, so the latest changes come too) is copied into a fresh folder under
/// `work`, read from there, and the copy is deleted again.
pub fn read_copy(db: &std::path::Path, work: &std::path::Path) -> Result<Library, ThingsError> {
    let dir = work.join(format!("things-import-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let result = read_in(db, &dir.join("main.sqlite"));
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn read_in(db: &std::path::Path, copy: &std::path::Path) -> Result<Library, ThingsError> {
    std::fs::copy(db, copy)?;
    for ext in ["-wal", "-shm"] {
        let side = std::path::PathBuf::from(format!("{}{ext}", db.display()));
        if side.is_file() {
            std::fs::copy(&side, format!("{}{ext}", copy.display()))?;
        }
    }
    let conn = Connection::open(copy)?;
    let lib = read(&conn);
    drop(conn);
    lib
}

// ── Finding the database ────────────────────────────────────────────────────

/// The Things 3 databases on this Mac, newest first. Things 3.15 and later
/// keep it in a `ThingsData-…` folder; older versions one level up.
pub fn find_databases(home: &std::path::Path) -> Vec<std::path::PathBuf> {
    let group = home.join("Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac");
    let db = |dir: &std::path::Path| dir.join("Things Database.thingsdatabase/main.sqlite");
    let mut found = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&group) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with("ThingsData-") {
                let p = db(&e.path());
                if p.is_file() {
                    found.push(p);
                }
            }
        }
    }
    let old = db(&group);
    if old.is_file() {
        found.push(old);
    }
    found.sort_by_key(|p| std::cmp::Reverse(std::fs::metadata(p).and_then(|m| m.modified()).ok()));
    found
}

/// The `main.sqlite` for a path the user picked: the file itself, or a
/// `.thingsdatabase` package (or the folder holding one).
pub fn resolve_pick(path: &std::path::Path) -> Option<std::path::PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    [
        path.join("main.sqlite"),
        path.join("Things Database.thingsdatabase/main.sqlite"),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packed(y: i64, m: i64, d: i64) -> i64 {
        (y << 16) | (m << 12) | (d << 7)
    }

    /// A small Things-shaped database.
    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            r#"
CREATE TABLE TMTask (uuid TEXT PRIMARY KEY, type INTEGER, status INTEGER, trashed INTEGER, title TEXT,
  notes TEXT, start INTEGER, startDate INTEGER, startBucket INTEGER, deadline INTEGER, stopDate REAL,
  creationDate REAL, project TEXT, heading TEXT, area TEXT, "index" INTEGER, reminderTime INTEGER,
  rt1_recurrenceRule BLOB, rt1_repeatingTemplate TEXT, rt1_nextInstanceStartDate INTEGER);
CREATE TABLE TMArea (uuid TEXT, title TEXT);
CREATE TABLE TMChecklistItem (uuid TEXT, task TEXT, title TEXT, status INTEGER, "index" INTEGER);
CREATE TABLE TMTag (uuid TEXT, title TEXT);
CREATE TABLE TMTaskTag (tasks TEXT, tags TEXT);
INSERT INTO TMArea VALUES ('A1', 'Home');
INSERT INTO TMTag VALUES ('G1', 'errand');
"#,
        )
        .unwrap();
        c
    }

    #[allow(clippy::too_many_arguments)]
    fn task(
        c: &Connection,
        uuid: &str,
        kind: i64,
        status: i64,
        title: &str,
        start: i64,
        start_date: Option<i64>,
        project: Option<&str>,
        heading: Option<&str>,
        area: Option<&str>,
    ) {
        c.execute(
            "INSERT INTO TMTask (uuid, type, status, trashed, title, start, startDate, project, heading, area, \"index\", creationDate, stopDate)
             VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, ?8, ?9, 0, 1700000000, CASE WHEN ?3 = 3 THEN 1710000000 END)",
            rusqlite::params![uuid, kind, status, title, start, start_date, project, heading, area],
        )
        .unwrap();
    }

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, 25).unwrap()
    }

    #[test]
    fn maps_projects_headings_areas_and_dates() {
        let c = fixture();
        task(
            &c,
            "P1",
            PROJECT,
            OPEN,
            "Kitchen",
            1,
            None,
            None,
            None,
            Some("A1"),
        );
        task(
            &c,
            "H1",
            HEADING,
            OPEN,
            "Buy",
            1,
            None,
            Some("P1"),
            None,
            None,
        );
        task(
            &c,
            "H2",
            HEADING,
            OPEN,
            "Empty floor",
            1,
            None,
            Some("P1"),
            None,
            None,
        );
        task(
            &c,
            "T1",
            TODO,
            OPEN,
            "Pick tiles",
            1,
            Some(packed(2026, 11, 3)),
            None,
            Some("H1"),
            None,
        );
        task(
            &c,
            "T2",
            TODO,
            OPEN,
            "Old today",
            1,
            Some(packed(2026, 10, 1)),
            Some("P1"),
            None,
            None,
        );
        task(
            &c,
            "T3",
            TODO,
            OPEN,
            "Water plants",
            1,
            None,
            None,
            None,
            Some("A1"),
        );
        task(
            &c,
            "T4",
            TODO,
            OPEN,
            "Learn piano",
            SOMEDAY,
            None,
            None,
            None,
            None,
        );
        task(
            &c,
            "T5",
            TODO,
            COMPLETED,
            "Call Sam",
            1,
            None,
            Some("P1"),
            None,
            None,
        );
        task(&c, "T6", TODO, CANCELED, "Nope", 1, None, None, None, None);
        task(
            &c,
            "P2",
            PROJECT,
            OPEN,
            "Empty project",
            1,
            None,
            None,
            None,
            None,
        );
        c.execute_batch(
            "UPDATE TMTask SET deadline = 132824832, notes = '<note xml:space=\"preserve\">a &amp; b</note>',
                 reminderTime = (9 << 26) | (30 << 20), startBucket = 1 WHERE uuid = 'T1';
             INSERT INTO TMChecklistItem VALUES ('C1', 'T1', 'Measure', 3, 0), ('C2', 'T1', 'Order', 0, 1);
             INSERT INTO TMTaskTag VALUES ('T1', 'G1');",
        )
        .unwrap();
        let lib = read(&c).unwrap();
        let opts = Options {
            include_done: true,
            ..Default::default()
        };
        let plan = plan(&lib, &opts, &HashSet::new(), today());
        let get = |id: &str| plan.items.iter().find(|i| i.ext_id == id).unwrap();

        let t1 = &get("T1").task;
        assert_eq!(t1.project.as_deref(), Some("Kitchen"));
        assert_eq!(t1.heading.as_deref(), Some("Buy"));
        assert_eq!(t1.due_date.as_deref(), Some("2026-11-03"));
        assert_eq!(t1.due_time.as_deref(), Some("09:30"));
        assert!(t1.evening);
        assert_eq!(t1.deadline.as_deref(), Some("2026-11-30"));
        assert_eq!(t1.notes.as_deref(), Some("a & b"));
        assert_eq!(t1.title, "Pick tiles #errand");
        assert_eq!(t1.checklist.len(), 2);
        assert!(t1.checklist[0].done && !t1.checklist[1].done);
        assert_eq!(t1.source_app.as_deref(), Some("Things 3"));

        // Past Today items come in for today, not overdue.
        assert_eq!(get("T2").task.due_date.as_deref(), Some("2026-10-25"));
        // Area to-dos get a building named after the area.
        assert_eq!(get("T3").task.project.as_deref(), Some("Home"));
        // Loose Someday stays someday, with no project.
        assert!(get("T4").task.someday && get("T4").task.project.is_none());
        // Done keeps its finish time.
        let t5 = get("T5");
        assert!(t5.done);
        assert_eq!(t5.completed_at.as_deref(), Some("2024-03-09T16:00:00Z"));
        // Cancelled stays behind.
        assert!(plan.items.iter().all(|i| i.ext_id != "T6"));
        assert_eq!(plan.preview.canceled, 1);

        // Empty projects and floors still come.
        assert!(plan.floors.contains(&("Empty project".into(), None)));
        assert!(plan
            .floors
            .contains(&("Kitchen".into(), Some("Empty floor".into()))));
        let kitchen = plan
            .preview
            .buildings
            .iter()
            .find(|b| b.key == "P1")
            .unwrap();
        assert_eq!((kitchen.open, kitchen.done, kitchen.floors), (2, 1, 2));
        assert_eq!(kitchen.area.as_deref(), Some("Home"));
        assert_eq!(plan.preview.open, 4);
        assert_eq!(plan.preview.done, 1);
        assert_eq!(plan.preview.someday, 1);
        assert_eq!(plan.preview.subtasks, 2);
    }

    #[test]
    fn options_skip_buildings_done_and_already_imported() {
        let c = fixture();
        task(&c, "P1", PROJECT, OPEN, "Work", 1, None, None, None, None);
        task(&c, "T1", TODO, OPEN, "a", 1, None, Some("P1"), None, None);
        task(&c, "T2", TODO, OPEN, "b", 0, None, None, None, None);
        task(&c, "T3", TODO, COMPLETED, "c", 0, None, None, None, None);
        task(&c, "T4", TODO, CANCELED, "d", 0, None, None, None, None);
        let lib = read(&c).unwrap();

        let p = plan(&lib, &Options::default(), &HashSet::new(), today());
        assert_eq!(p.items.len(), 2, "no Logbook unless asked");

        let opts = Options {
            include_done: true,
            include_canceled: true,
            skip: vec!["P1".into()],
        };
        let already: HashSet<String> = ["T2".to_string()].into();
        let p = plan(&lib, &opts, &already, today());
        let ids: Vec<&str> = p.items.iter().map(|i| i.ext_id.as_str()).collect();
        assert_eq!(ids, ["T3", "T4"]);
        assert!(p.items.iter().all(|i| i.done));
        assert_eq!(p.preview.already, 1);
        assert!(!p.floors.iter().any(|(n, _)| n == "Work"));
    }

    #[test]
    fn same_named_projects_stay_apart() {
        let c = fixture();
        task(&c, "P1", PROJECT, OPEN, "Home", 1, None, None, None, None);
        task(&c, "P2", PROJECT, OPEN, "Home", 1, None, None, None, None);
        task(&c, "T1", TODO, OPEN, "x", 1, None, None, None, Some("A1"));
        let p = plan(
            &read(&c).unwrap(),
            &Options::default(),
            &HashSet::new(),
            today(),
        );
        let names: Vec<&str> = p
            .preview
            .buildings
            .iter()
            .map(|b| b.name.as_str())
            .collect();
        assert_eq!(names, ["Home", "Home (2)", "Home (3)"]);
    }

    #[test]
    fn repeats_go_on_the_next_open_copy() {
        let c = fixture();
        let weekly = "<?xml version=\"1.0\"?><plist><dict><key>fa</key><integer>1</integer><key>fu</key><integer>256</integer><key>of</key><array><dict><key>wd</key><integer>2</integer></dict></array></dict></plist>";
        task(&c, "R", TODO, OPEN, "Bins out", 1, None, None, None, None);
        task(
            &c,
            "R1",
            TODO,
            COMPLETED,
            "Bins out",
            1,
            Some(packed(2026, 10, 19)),
            None,
            None,
            None,
        );
        task(
            &c,
            "R2",
            TODO,
            OPEN,
            "Bins out",
            1,
            Some(packed(2026, 10, 26)),
            None,
            None,
            None,
        );
        task(&c, "Q", TODO, OPEN, "Odd repeat", 1, None, None, None, None);
        c.execute(
            "UPDATE TMTask SET rt1_recurrenceRule = ?1 WHERE uuid = 'R'",
            [weekly.as_bytes()],
        )
        .unwrap();
        c.execute_batch(
            "UPDATE TMTask SET rt1_repeatingTemplate = 'R' WHERE uuid IN ('R1', 'R2');
             UPDATE TMTask SET rt1_recurrenceRule = X'62706C697374', rt1_nextInstanceStartDate = 132820352 WHERE uuid = 'Q';",
        )
        .unwrap();
        let opts = Options {
            include_done: true,
            ..Default::default()
        };
        let p = plan(&read(&c).unwrap(), &opts, &HashSet::new(), today());
        let ids: Vec<&str> = p.items.iter().map(|i| i.ext_id.as_str()).collect();
        assert!(!ids.contains(&"R"), "the template itself stays behind");
        let r2 = p.items.iter().find(|i| i.ext_id == "R2").unwrap();
        assert_eq!(r2.task.recurrence.as_deref(), Some("weekly"));
        let r1 = p.items.iter().find(|i| i.ext_id == "R1").unwrap();
        assert!(r1.task.recurrence.is_none());
        // A rule Todo City can't read: one task on its next day, with a note.
        let q = p.items.iter().find(|i| i.ext_id == "Q").unwrap();
        assert!(q.task.recurrence.is_none());
        assert_eq!(q.task.due_date.as_deref(), Some("2026-10-27"));
        assert!(q
            .task
            .notes
            .as_deref()
            .unwrap()
            .contains("Repeated in Things 3"));
        assert_eq!((p.preview.repeating, p.preview.unmapped_repeats), (1, 1));
    }

    #[test]
    fn repeat_rules() {
        let rule = |fu: i64, fa: i64, wd: &[i64]| {
            let days: String = wd
                .iter()
                .map(|d| format!("<dict><key>wd</key><integer>{d}</integer></dict>"))
                .collect();
            let xml = format!(
                "<plist><dict><key>fa</key><integer>{fa}</integer><key>fu</key><integer>{fu}</integer><key>of</key><array>{days}</array></dict></plist>"
            );
            repeat_rule(xml.as_bytes())
        };
        assert_eq!(rule(16, 1, &[]), Some(Rule::Daily));
        assert_eq!(rule(256, 1, &[2, 3, 4, 5, 6]), Some(Rule::Weekdays));
        assert_eq!(rule(256, 1, &[4]), Some(Rule::Weekly));
        assert_eq!(rule(256, 2, &[4]), Some(Rule::Biweekly));
        assert_eq!(rule(8, 1, &[]), Some(Rule::Monthly));
        assert_eq!(rule(4, 1, &[]), Some(Rule::Yearly));
        assert_eq!(rule(256, 1, &[2, 4]), None);
        assert_eq!(rule(16, 3, &[]), None);
        assert_eq!(repeat_rule(b"bplist00"), None);
    }

    #[test]
    fn dates_and_times() {
        assert_eq!(
            day(Some(packed(2026, 2, 28) as f64)),
            NaiveDate::from_ymd_opt(2026, 2, 28)
        );
        assert_eq!(day(Some(0.0)), None);
        assert_eq!(
            clock(Some((17 << 26) | (5 << 20))).as_deref(),
            Some("17:05")
        );
        assert_eq!(clock(Some(0)), None);
        assert_eq!(clean_notes(Some("  plain  ")).as_deref(), Some("plain"));
        assert_eq!(hashtag("Work Stuff!").as_deref(), Some("#Work-Stuff"));
        assert_eq!(hashtag("  !! "), None);
        assert_eq!(
            clean_notes(Some("<note xml:space=\"preserve\"></note>")),
            None
        );
    }

    #[test]
    fn reads_a_copy_and_leaves_no_trace() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("main.sqlite");
        let c = Connection::open(&db).unwrap();
        c.execute_batch(
            "CREATE TABLE TMTask (uuid TEXT, type INTEGER, status INTEGER, title TEXT);
             INSERT INTO TMTask VALUES ('T1', 0, 0, 'Hello');",
        )
        .unwrap();
        drop(c);
        let work = dir.path().join("work");
        let lib = read_copy(&db, &work).unwrap();
        let p = plan(&lib, &Options::default(), &HashSet::new(), today());
        assert_eq!(p.items[0].task.title, "Hello");
        assert_eq!(std::fs::read_dir(&work).unwrap().count(), 0);
        assert!(matches!(
            read_copy(&dir.path().join("missing"), &work),
            Err(ThingsError::Io(_))
        ));
    }

    #[test]
    fn rejects_other_databases() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE other (x INTEGER);").unwrap();
        assert!(matches!(read(&c), Err(ThingsError::NotThings)));
    }

    #[test]
    fn imports_once_with_history() {
        let c = fixture();
        task(&c, "P1", PROJECT, OPEN, "Garden", 1, None, None, None, None);
        task(
            &c,
            "H1",
            HEADING,
            OPEN,
            "Spring",
            1,
            None,
            Some("P1"),
            None,
            None,
        );
        task(
            &c,
            "T1",
            TODO,
            OPEN,
            "Plant",
            1,
            None,
            None,
            Some("H1"),
            None,
        );
        task(
            &c,
            "T2",
            TODO,
            COMPLETED,
            "Rake",
            1,
            None,
            Some("P1"),
            None,
            None,
        );
        let lib = read(&c).unwrap();
        let opts = Options {
            include_done: true,
            ..Default::default()
        };
        let store = crate::Store::open_in_memory().unwrap();
        let p = plan(&lib, &opts, &store.imported_ids(SOURCE).unwrap(), today());
        let r = store.import(SOURCE, &p.floors, &p.items).unwrap();
        assert_eq!((r.added, r.done, r.skipped), (2, 1, 0));
        let all = store.all().unwrap();
        let rake = all.iter().find(|t| t.title == "Rake").unwrap();
        assert!(rake.done);
        assert_eq!(rake.completed_at.as_deref(), Some("2024-03-09T16:00:00Z"));
        assert_eq!(rake.created_at, "2023-11-14T22:13:20Z");
        assert_eq!(store.floors().unwrap()[0].name, "Spring");
        assert_eq!(store.city_windows(10).unwrap().len(), 1);

        // Again: nothing new, even after deleting one here.
        store.delete(rake.id).unwrap();
        let p = plan(&lib, &opts, &store.imported_ids(SOURCE).unwrap(), today());
        assert!(p.items.is_empty());
        assert_eq!(p.preview.already, 2);
        let r = store.import(SOURCE, &p.floors, &p.items).unwrap();
        assert_eq!(r.added, 0);
        assert_eq!(store.all().unwrap().len(), 1);
    }

    #[test]
    fn picks_resolve_to_the_sqlite_file() {
        let dir = tempfile::tempdir().unwrap();
        let pkg = dir.path().join("Things Database.thingsdatabase");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("main.sqlite"), b"").unwrap();
        let want = Some(pkg.join("main.sqlite"));
        assert_eq!(resolve_pick(&pkg), want);
        assert_eq!(resolve_pick(dir.path()), want);
        assert_eq!(resolve_pick(&pkg.join("main.sqlite")), want);
        assert_eq!(resolve_pick(&dir.path().join("nope")), None);
    }

    #[test]
    fn finds_new_and_old_locations() {
        let home = tempfile::tempdir().unwrap();
        let group = home
            .path()
            .join("Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac");
        let new = group.join("ThingsData-ABCDE/Things Database.thingsdatabase");
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join("main.sqlite"), b"").unwrap();
        assert_eq!(find_databases(home.path()), vec![new.join("main.sqlite")]);
        assert!(find_databases(&home.path().join("x")).is_empty());
    }
}
