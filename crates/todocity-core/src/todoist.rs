//! Moving from Todoist: read it (over its API with the user's own token, or
//! from exported CSV files) and turn it into Todo City tasks.
//!
//! | Todoist                    | Todo City                              |
//! |----------------------------|----------------------------------------|
//! | Project                    | Project (a building)                   |
//! | Inbox                      | Tasks with no project (houses)         |
//! | Section                    | Floor                                  |
//! | Task                       | Task (a home)                          |
//! | Sub-task (any depth)       | Sub-task (its own date is dropped)     |
//! | Labels                     | `#tags` at the end of the title        |
//! | Priority 1–3 (optional)    | `#p1`–`#p3`                            |
//! | Description and comments   | Notes                                  |
//! | Due date and time          | Day and time                           |
//! | Deadline                   | Deadline                               |
//! | Recurring due date         | Repeat rule, when it maps              |
//! | Completed tasks (API only) | Done tasks (lit windows)               |
//!
//! The token is only used for the requests here and never stored. CSV
//! exports have no completed tasks, and their dates are free text, so the
//! common forms are read and anything else is kept in the notes.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};

pub use crate::things::{BuildingPreview, Options, Plan, Preview, LOOSE_KEY};

use crate::recurrence::Rule;
use crate::store::{ChecklistItem, Imported, NewTask};
use crate::things::hashtag;

/// Where imported tasks are recorded as coming from.
pub const SOURCE: &str = "todoist";
/// What the task says it came from.
pub const APP_NAME: &str = "Todoist";
pub const API_BASE: &str = "https://api.todoist.com";

/// Completed tasks are fetched in windows this long (the API allows ~3 months).
const WINDOW_DAYS: i64 = 90;
/// Stop looking further back after this many empty windows in a row (~3 years).
const EMPTY_WINDOWS: usize = 12;
/// At most this many completed tasks (the city shows up to 20,000 windows).
const MAX_DONE: usize = 20_000;

#[derive(Debug, thiserror::Error)]
pub enum TodoistError {
    #[error("Todoist didn't accept that token. Copy it again from Todoist → Settings → Integrations → Developer.")]
    BadToken,
    #[error("Todoist is busy right now (too many requests). Wait a minute and try again.")]
    RateLimited,
    #[error("Todoist answered with an error ({0}). Try again in a moment.")]
    Status(u16),
    #[error("Couldn't reach Todoist: {0}")]
    Network(#[from] reqwest::Error),
    #[error("Todoist sent something unexpected: {0}")]
    Format(String),
    #[error("Couldn't read that file: {0}")]
    Io(#[from] std::io::Error),
    #[error("No Todoist CSV files there. Export a project as CSV in Todoist, or unzip a backup, and choose the .csv files (or their folder).")]
    NoCsv,
}

// ── Data ────────────────────────────────────────────────────────────────────

/// Todoist ids are strings in API v1 but numbers in older payloads.
fn id<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::String(s) => s,
        serde_json::Value::Number(n) => n.to_string(),
        _ => String::new(),
    })
}

fn opt_id<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::String(s) if !s.is_empty() => Some(s),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Project {
    #[serde(deserialize_with = "id")]
    pub id: String,
    pub name: String,
    #[serde(deserialize_with = "opt_id")]
    pub parent_id: Option<String>,
    pub child_order: i64,
    pub inbox_project: bool,
    pub is_archived: bool,
    pub is_deleted: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Section {
    #[serde(deserialize_with = "id")]
    pub id: String,
    #[serde(deserialize_with = "id")]
    pub project_id: String,
    pub name: String,
    pub section_order: i64,
    pub is_deleted: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Due {
    /// `YYYY-MM-DD`, or a date-time (`…T09:00:00`, `…Z` when fixed to a zone).
    pub date: String,
    /// Older payloads keep the time here.
    pub datetime: Option<String>,
    /// How the user wrote it: "every monday at 9am".
    pub string: String,
    pub is_recurring: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Deadline {
    pub date: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Task {
    #[serde(deserialize_with = "id")]
    pub id: String,
    pub content: String,
    pub description: String,
    #[serde(deserialize_with = "opt_id")]
    pub project_id: Option<String>,
    #[serde(deserialize_with = "opt_id")]
    pub section_id: Option<String>,
    #[serde(deserialize_with = "opt_id")]
    pub parent_id: Option<String>,
    pub labels: Vec<String>,
    /// API order: 4 is the most urgent (p1), 1 is normal (p4).
    pub priority: i64,
    pub due: Option<Due>,
    pub deadline: Option<Deadline>,
    pub checked: bool,
    pub completed_at: Option<String>,
    pub added_at: Option<String>,
    pub child_order: i64,
    pub is_deleted: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct Note {
    #[serde(deserialize_with = "opt_id")]
    item_id: Option<String>,
    content: String,
    is_deleted: bool,
}

/// Everything read from Todoist, before any choices are made.
#[derive(Debug, Clone, Default)]
pub struct Library {
    pub projects: Vec<Project>,
    pub sections: Vec<Section>,
    pub tasks: Vec<Task>,
    /// Comments by task id, oldest first.
    pub comments: HashMap<String, Vec<String>>,
    /// Read from CSV files: no completed tasks, free-text dates.
    pub from_csv: bool,
}

// ── The API ─────────────────────────────────────────────────────────────────

#[derive(Default, Deserialize)]
#[serde(default)]
struct SyncResponse {
    projects: Vec<Project>,
    items: Vec<Task>,
    sections: Vec<Section>,
    notes: Vec<Note>,
}

#[derive(Deserialize)]
struct Page<T> {
    #[serde(default = "Vec::new", alias = "items")]
    results: Vec<T>,
    #[serde(default)]
    next_cursor: Option<String>,
}

async fn get_json<T: serde::de::DeserializeOwned>(
    req: reqwest::RequestBuilder,
) -> Result<T, TodoistError> {
    let res = req.send().await?;
    match res.status().as_u16() {
        200..=299 => {}
        401 | 403 => return Err(TodoistError::BadToken),
        429 => return Err(TodoistError::RateLimited),
        s => return Err(TodoistError::Status(s)),
    }
    let body = res.bytes().await?;
    serde_json::from_slice(&body).map_err(|e| TodoistError::Format(e.to_string()))
}

/// Read everything over the API: active projects, sections, tasks and
/// comments in one sync, archived projects, then completed tasks going back
/// a window at a time until a long quiet stretch. `progress` gets a short
/// line for the UI ("Reading completed tasks… 2023").
pub async fn fetch(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    now: DateTime<Utc>,
    progress: impl Fn(&str),
) -> Result<Library, TodoistError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(TodoistError::BadToken);
    }
    let auth = format!("Bearer {token}");
    progress("Reading your projects and tasks…");
    let sync: SyncResponse = get_json(
        client
            .post(format!("{base}/api/v1/sync"))
            .header("Authorization", &auth)
            .form(&[
                ("sync_token", "*"),
                (
                    "resource_types",
                    r#"["projects","items","sections","notes"]"#,
                ),
            ]),
    )
    .await?;
    let mut lib = Library {
        projects: sync.projects,
        sections: sync.sections,
        tasks: sync.items,
        ..Default::default()
    };
    for n in sync.notes {
        if let (false, Some(item)) = (n.is_deleted, n.item_id) {
            if !n.content.trim().is_empty() {
                lib.comments.entry(item).or_default().push(n.content);
            }
        }
    }

    // Archived projects: their completed tasks still light windows.
    let mut cursor: Option<String> = None;
    loop {
        let mut req = client
            .get(format!("{base}/api/v1/projects/archived"))
            .header("Authorization", &auth)
            .query(&[("limit", "200")]);
        if let Some(c) = &cursor {
            req = req.query(&[("cursor", c.as_str())]);
        }
        // Older accounts may not have this; it's a bonus, not required.
        let Ok(page) = get_json::<Page<Project>>(req).await else {
            break;
        };
        lib.projects.extend(page.results.into_iter().map(|mut p| {
            p.is_archived = true;
            p
        }));
        match page.next_cursor {
            Some(c) if !c.is_empty() => cursor = Some(c),
            _ => break,
        }
    }

    // Completed tasks, newest first, a window at a time.
    let known: HashSet<String> = lib.tasks.iter().map(|t| t.id.clone()).collect();
    let mut until = now;
    let mut empty = 0;
    let mut done = 0;
    // Todoist began in 2007: nothing to find before that.
    let oldest = DateTime::<Utc>::from_timestamp(1_167_609_600, 0).unwrap_or(now);
    while empty < EMPTY_WINDOWS && done < MAX_DONE && until > oldest {
        let since = until - Duration::days(WINDOW_DAYS);
        progress(&format!("Reading completed tasks… {}", since.year()));
        let mut found = 0;
        let mut cursor: Option<String> = None;
        loop {
            let fmt = |d: DateTime<Utc>| d.format("%Y-%m-%dT%H:%M:%SZ").to_string();
            let mut req = client
                .get(format!("{base}/api/v1/tasks/completed/by_completion_date"))
                .header("Authorization", &auth)
                .query(&[
                    ("since", fmt(since)),
                    ("until", fmt(until)),
                    ("limit", "200".to_string()),
                ]);
            if let Some(c) = &cursor {
                req = req.query(&[("cursor", c.as_str())]);
            }
            let page: Page<Task> = get_json(req).await?;
            for mut t in page.results {
                if known.contains(&t.id) || t.is_deleted {
                    continue;
                }
                t.checked = true;
                found += 1;
                lib.tasks.push(t);
            }
            match page.next_cursor {
                Some(c) if !c.is_empty() && done + found < MAX_DONE => cursor = Some(c),
                _ => break,
            }
        }
        done += found;
        empty = if found == 0 { empty + 1 } else { 0 };
        until = since;
    }
    Ok(lib)
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/// Split CSV text into rows (quotes, doubled quotes and newlines in quotes).
fn csv_rows(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    field.push('"');
                    chars.next();
                }
                '"' => quoted = false,
                _ => field.push(c),
            }
            continue;
        }
        match c {
            '"' => quoted = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            _ => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows.retain(|r| r.iter().any(|f| !f.trim().is_empty()));
    rows
}

/// A project's name from its export file: "Home [2203306141].csv" → "Home".
fn project_from_file(name: &str) -> String {
    let stem = name
        .strip_suffix(".csv")
        .or(name.strip_suffix(".CSV"))
        .unwrap_or(name);
    let stem = match (stem.rfind(" ["), stem.ends_with(']')) {
        (Some(i), true) => &stem[..i],
        _ => stem,
    };
    stem.trim().to_string()
}

/// Read Todoist CSV exports (one per project). `files` is (file name, text).
pub fn read_csv(files: &[(String, String)]) -> Result<Library, TodoistError> {
    let mut lib = Library {
        from_csv: true,
        ..Default::default()
    };
    let mut any = false;
    for (fi, (file, text)) in files.iter().enumerate() {
        let rows = csv_rows(text);
        let Some(header) = rows.first() else { continue };
        let col = |name: &str| {
            header
                .iter()
                .position(|h| h.trim().eq_ignore_ascii_case(name))
        };
        let (Some(ty), Some(content)) = (col("TYPE"), col("CONTENT")) else {
            continue;
        };
        any = true;
        let get = |r: &[String], i: Option<usize>| {
            i.and_then(|i| r.get(i))
                .map(|s| s.trim().to_string())
                .unwrap_or_default()
        };
        let (desc, prio, indent, date, deadline) = (
            col("DESCRIPTION"),
            col("PRIORITY"),
            col("INDENT"),
            col("DATE"),
            col("DEADLINE"),
        );
        let name = project_from_file(file);
        let pid = format!("csv{fi}");
        lib.projects.push(Project {
            id: pid.clone(),
            inbox_project: name.eq_ignore_ascii_case("inbox"),
            name,
            child_order: fi as i64,
            ..Default::default()
        });
        let mut section: Option<String> = None;
        // The task at each indent level, for sub-tasks.
        let mut stack: Vec<String> = Vec::new();
        let mut last_task: Option<String> = None;
        for (ri, r) in rows.iter().enumerate().skip(1) {
            let kind = get(r, Some(ty)).to_lowercase();
            let text = get(r, Some(content));
            match kind.as_str() {
                "section" => {
                    let id = format!("{pid}-s{ri}");
                    lib.sections.push(Section {
                        id: id.clone(),
                        project_id: pid.clone(),
                        name: text,
                        section_order: ri as i64,
                        ..Default::default()
                    });
                    section = Some(id);
                    stack.clear();
                }
                "task" => {
                    let level = get(r, indent).parse::<usize>().unwrap_or(1).max(1);
                    stack.truncate(level - 1);
                    let parent = stack.last().cloned();
                    let id = format!("{pid}-t{ri}");
                    // Labels are written into the name: "Call Sam @phone".
                    let mut labels = Vec::new();
                    let words: Vec<&str> = text
                        .split(' ')
                        .filter(|w| match w.strip_prefix('@') {
                            Some(l) if !l.is_empty() => {
                                labels.push(l.to_string());
                                false
                            }
                            _ => true,
                        })
                        .collect();
                    // CSV order: 1 is p1 (most urgent); the API's is reversed.
                    let p = get(r, prio).parse::<i64>().unwrap_or(4).clamp(1, 4);
                    let due = Some(get(r, date)).filter(|d| !d.is_empty()).map(|d| Due {
                        is_recurring: d.to_lowercase().starts_with("every"),
                        string: d,
                        ..Default::default()
                    });
                    lib.tasks.push(Task {
                        id: id.clone(),
                        content: words.join(" "),
                        description: get(r, desc),
                        project_id: Some(pid.clone()),
                        section_id: section.clone(),
                        parent_id: parent,
                        labels,
                        priority: 5 - p,
                        due,
                        deadline: Some(get(r, deadline))
                            .filter(|d| !d.is_empty())
                            .map(|date| Deadline { date }),
                        // Files in the order given, rows in file order.
                        child_order: (fi * 1_000_000 + ri) as i64,
                        ..Default::default()
                    });
                    while stack.len() < level - 1 {
                        stack.push(id.clone());
                    }
                    stack.push(id.clone());
                    last_task = Some(id);
                }
                "note" => {
                    if let Some(t) = &last_task {
                        if !text.is_empty() {
                            lib.comments.entry(t.clone()).or_default().push(text);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    if !any {
        return Err(TodoistError::NoCsv);
    }
    Ok(lib)
}

// ── Dates and repeats ───────────────────────────────────────────────────────

/// A due date (and time, if any) as Todo City's local day and `HH:MM`.
fn due_of(d: &Due, today: NaiveDate) -> Option<(NaiveDate, Option<String>)> {
    let raw = d
        .datetime
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&d.date)
        .trim();
    if raw.is_empty() {
        return text_date(&d.string, today);
    }
    if let Ok(day) = NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
        return Some((day, None));
    }
    // Fixed to a zone ("…Z" or "+02:00"): show it in local time.
    if let Ok(t) = DateTime::parse_from_rfc3339(raw) {
        let t = t.with_timezone(&Local);
        return Some((t.date_naive(), Some(t.format("%H:%M").to_string())));
    }
    for f in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
    ] {
        if let Ok(t) = NaiveDateTime::parse_from_str(raw, f) {
            return Some((t.date(), Some(t.format("%H:%M").to_string())));
        }
    }
    text_date(&d.string, today)
}

/// A date written out (CSV exports): "2026-10-25", "Oct 25 2026",
/// "25 Oct 2026 9:00 AM", "Oct 25"… Recurring phrases ("every monday")
/// start today.
fn text_date(s: &str, today: NaiveDate) -> Option<(NaiveDate, Option<String>)> {
    let s = s.trim().trim_end_matches('.');
    if s.is_empty() {
        return None;
    }
    let lower = s.to_lowercase();
    if lower.starts_with("every") {
        return Some((today, time_in(&lower)));
    }
    match lower.as_str() {
        "today" => return Some((today, None)),
        "tomorrow" => return Some((today + Duration::days(1), None)),
        _ => {}
    }
    // Split off a time at the end: "… 9:00 AM", "… 17:30", "… 9am".
    let (date_part, time) = match time_at_end(s) {
        Some((rest, t)) => (rest, Some(t)),
        None => (s, None),
    };
    let date_part = date_part.trim().trim_end_matches(',').replace(',', "");
    for f in [
        "%Y-%m-%d", "%b %d %Y", "%d %b %Y", "%B %d %Y", "%d %B %Y", "%m/%d/%Y", "%d.%m.%Y",
    ] {
        if let Ok(d) = NaiveDate::parse_from_str(&date_part, f) {
            return Some((d, time));
        }
    }
    // No year: this year, or next if that day has passed.
    for f in ["%b %d %Y", "%d %b %Y", "%B %d %Y", "%d %B %Y"] {
        let with = format!("{date_part} {}", today.year());
        if let Ok(d) = NaiveDate::parse_from_str(&with, f) {
            let d = if d < today {
                d.with_year(d.year() + 1).unwrap_or(d)
            } else {
                d
            };
            return Some((d, time));
        }
    }
    None
}

/// "9:00 AM", "9am", "17:30" as `HH:MM`.
fn parse_time(s: &str) -> Option<String> {
    let s = s.trim().to_lowercase().replace(' ', "");
    let (s, pm, am) = match (s.strip_suffix("pm"), s.strip_suffix("am")) {
        (Some(x), _) => (x.to_string(), true, false),
        (_, Some(x)) => (x.to_string(), false, true),
        _ => (s.clone(), false, false),
    };
    let (h, m) = match s.split_once(':') {
        Some((h, m)) => (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?),
        None if am || pm => (s.parse::<u32>().ok()?, 0),
        None => return None,
    };
    let h = match (h, am, pm) {
        (12, true, _) => 0,
        (h, _, true) if h < 12 => h + 12,
        (h, _, _) => h,
    };
    NaiveTime::from_hms_opt(h, m, 0).map(|t| t.format("%H:%M").to_string())
}

fn time_at_end(s: &str) -> Option<(&str, String)> {
    let words: Vec<&str> = s.split_whitespace().collect();
    for take in [2, 1] {
        if words.len() > take {
            let tail = words[words.len() - take..].join(" ");
            if let Some(t) = parse_time(&tail) {
                let cut = s.rfind(words[words.len() - take]).unwrap_or(s.len());
                return Some((&s[..cut], t));
            }
        }
    }
    None
}

/// The time in a recurring phrase: "every monday at 9am" → 09:00.
fn time_in(lower: &str) -> Option<String> {
    let (_, after) = lower.split_once(" at ")?;
    let t = after.split(" starting").next()?.split(" ending").next()?;
    parse_time(t)
}

/// A Todoist recurring phrase as one of Todo City's repeats, when it maps.
pub fn repeat_rule(phrase: &str) -> Option<Rule> {
    let mut s = phrase.trim().to_lowercase().replace("every!", "every");
    for cut in [
        " at ",
        " starting ",
        " ending ",
        " until ",
        " from ",
        " for ",
    ] {
        if let Some(i) = s.find(cut) {
            s.truncate(i);
        }
    }
    let s = s.trim().trim_end_matches('.');
    const DAYS: [&str; 14] = [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "mon",
        "tue",
        "wed",
        "thu",
        "fri",
        "sat",
        "sun",
    ];
    let is_day = |w: &str| DAYS.contains(&w);
    let ordinal = |w: &str| {
        let w = w
            .trim_end_matches("st")
            .trim_end_matches("nd")
            .trim_end_matches("rd")
            .trim_end_matches("th");
        w.parse::<u32>().is_ok_and(|n| (1..=31).contains(&n)) || w == "last day"
    };
    let words: Vec<&str> = s.split_whitespace().collect();
    match words.as_slice() {
        ["daily"]
        | ["every", "day"]
        | ["every", "1", "day"]
        | ["every", "morning"]
        | ["every", "evening"]
        | ["every", "night"] => Some(Rule::Daily),
        ["every", "weekday"] | ["every", "workday"] | ["every", "work", "day"] | ["weekdays"] => {
            Some(Rule::Weekdays)
        }
        ["weekly"] | ["every", "week"] | ["every", "1", "week"] | ["every", "7", "days"] => {
            Some(Rule::Weekly)
        }
        ["every", d] if is_day(d) => Some(Rule::Weekly),
        ["biweekly"]
        | ["every", "other", "week"]
        | ["every", "2", "weeks"]
        | ["every", "14", "days"] => Some(Rule::Biweekly),
        ["every", "other", d] if is_day(d) => Some(Rule::Biweekly),
        ["every", "2", "weeks", "on", d] if is_day(d) => Some(Rule::Biweekly),
        ["monthly"] | ["every", "month"] | ["every", "1", "month"] => Some(Rule::Monthly),
        ["every", n] if ordinal(n) => Some(Rule::Monthly),
        ["every", "last", "day"] => Some(Rule::Monthly),
        ["yearly"] | ["annually"] | ["every", "year"] | ["every", "1", "year"] => {
            Some(Rule::Yearly)
        }
        ["every", a, b] if (month(a) && ordinal(b)) || (ordinal(a) && month(b)) => {
            Some(Rule::Yearly)
        }
        _ => None,
    }
}

fn month(w: &str) -> bool {
    [
        "jan",
        "feb",
        "mar",
        "apr",
        "may",
        "jun",
        "jul",
        "aug",
        "sep",
        "sept",
        "oct",
        "nov",
        "dec",
        "january",
        "february",
        "march",
        "april",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
    ]
    .contains(&w)
}

// ── Planning ────────────────────────────────────────────────────────────────

/// Turn a library into tasks for Todo City (see the table at the top).
pub fn plan(lib: &Library, opts: &Options, already: &HashSet<String>, today: NaiveDate) -> Plan {
    let skip: HashSet<&str> = opts.skip.iter().map(String::as_str).collect();
    let projects: HashMap<&str, &Project> = lib
        .projects
        .iter()
        .filter(|p| !p.is_deleted)
        .map(|p| (p.id.as_str(), p))
        .collect();
    let sections: HashMap<&str, &Section> = lib
        .sections
        .iter()
        .filter(|s| !s.is_deleted)
        .map(|s| (s.id.as_str(), s))
        .collect();
    let tasks: Vec<&Task> = lib.tasks.iter().filter(|t| !t.is_deleted).collect();
    let by_id: HashMap<&str, &Task> = tasks.iter().map(|t| (t.id.as_str(), *t)).collect();
    let is_done = |t: &Task| t.checked || t.completed_at.is_some();

    // Buildings: every project but the Inbox, with unique names.
    let mut used: HashSet<String> = HashSet::new();
    let mut names: HashMap<&str, String> = HashMap::new();
    let mut order: Vec<&Project> = projects
        .values()
        .copied()
        .filter(|p| !p.inbox_project)
        .collect();
    order.sort_by(|a, b| {
        (a.is_archived, a.child_order, &a.name).cmp(&(b.is_archived, b.child_order, &b.name))
    });
    for p in &order {
        let base: String = {
            let n = p.name.split_whitespace().collect::<Vec<_>>().join(" ");
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
        names.insert(p.id.as_str(), name);
    }
    let key_of = |t: &Task| -> String {
        match t.project_id.as_deref().and_then(|p| projects.get(p)) {
            Some(p) if !p.inbox_project => p.id.clone(),
            _ => LOOSE_KEY.to_string(),
        }
    };

    // The top-level task each sub-task folds into, and children in order.
    let root = |t: &Task| -> Option<String> {
        let mut cur = t;
        let mut hops = 0;
        while let Some(p) = cur.parent_id.as_deref().and_then(|p| by_id.get(p)) {
            cur = p;
            hops += 1;
            if hops > 50 {
                break;
            }
        }
        (cur.id != t.id).then(|| cur.id.clone())
    };
    let mut children: BTreeMap<String, Vec<&Task>> = BTreeMap::new();
    let mut tops: Vec<&Task> = Vec::new();
    for t in &tasks {
        match root(t) {
            Some(r) => children.entry(r).or_default().push(t),
            None => tops.push(t),
        }
    }
    // Depth-first order of a family: parent before child, siblings by order.
    let depth_first = |r: &str, kids: &[&Task]| -> Vec<(String, bool)> {
        let mut out = Vec::new();
        let mut walk: Vec<(&str, usize)> = vec![(r, 0)];
        while let Some((id, depth)) = walk.pop() {
            let mut sub: Vec<&&Task> = kids
                .iter()
                .filter(|k| k.parent_id.as_deref() == Some(id))
                .collect();
            sub.sort_by_key(|k| std::cmp::Reverse(k.child_order));
            for k in sub {
                walk.push((k.id.as_str(), depth + 1));
            }
            if depth > 0 {
                if let Some(t) = by_id.get(id) {
                    out.push((t.content.clone(), is_done(t)));
                }
            }
        }
        out
    };
    tops.sort_by_key(|t| (is_done(t), t.child_order));

    let mut preview = Preview::default();
    let mut floors: Vec<(String, Option<String>)> = Vec::new();
    let mut floor_seen: HashSet<(String, String)> = HashSet::new();
    let mut items: Vec<Imported> = Vec::new();
    let mut counts: HashMap<String, (usize, usize)> = HashMap::new();

    for t in tops {
        let done = is_done(t);
        if done && !opts.include_done {
            continue;
        }
        let key = key_of(t);
        if already.contains(&t.id) {
            preview.already += 1;
            continue;
        }
        let c = counts.entry(key.clone()).or_default();
        if done {
            c.1 += 1
        } else {
            c.0 += 1
        }
        if skip.contains(key.as_str()) {
            continue;
        }

        let building = names.get(key.as_str()).cloned();
        let floor = building.as_ref().and(
            t.section_id
                .as_deref()
                .and_then(|s| sections.get(s))
                .filter(|s| Some(s.project_id.as_str()) == t.project_id.as_deref())
                .map(|s| s.name.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|s| !s.is_empty()),
        );
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

        let mut notes: Vec<String> = Vec::new();
        if !t.description.trim().is_empty() {
            notes.push(t.description.trim().to_string());
        }
        let when = t.due.as_ref().and_then(|d| due_of(d, today));
        if let (Some(d), None) = (&t.due, &when) {
            if !d.string.trim().is_empty() {
                notes.push(format!("Todoist date: {}", d.string.trim()));
            }
        }
        let mut rule = None;
        if let Some(d) = t.due.as_ref().filter(|d| d.is_recurring && !done) {
            match repeat_rule(&d.string).filter(|_| when.is_some()) {
                Some(r) => {
                    rule = Some(r);
                    preview.repeating += 1;
                }
                None => {
                    preview.unmapped_repeats += 1;
                    notes.push(format!(
                        "Repeated in Todoist (“{}”) — set a repeat here if you still need it.",
                        d.string.trim()
                    ));
                }
            }
        }
        if let Some(cs) = lib.comments.get(&t.id) {
            notes.push(format!(
                "Comments from Todoist:\n{}",
                cs.iter()
                    .map(|c| format!("– {}", c.trim()))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }

        let mut title = {
            let s = t.content.split_whitespace().collect::<Vec<_>>().join(" ");
            if s.is_empty() {
                "Untitled task".to_string()
            } else {
                s
            }
        };
        let mut tags: Vec<String> = t
            .labels
            .iter()
            .map(String::as_str)
            .filter_map(hashtag)
            .collect();
        if opts.priority_tags && (2..=4).contains(&t.priority) {
            tags.push(format!("#p{}", 5 - t.priority));
        }
        for tag in tags {
            if !title.to_lowercase().contains(&tag.to_lowercase()) {
                title.push(' ');
                title.push_str(&tag);
            }
        }

        let checklist: Vec<ChecklistItem> = children
            .get(&t.id)
            .map(|kids| {
                depth_first(&t.id, kids)
                    .into_iter()
                    .filter(|(text, _)| !text.trim().is_empty())
                    .map(|(text, done)| ChecklistItem { text, done })
                    .collect()
            })
            .unwrap_or_default();
        preview.subtasks += checklist.len();

        let (due, time) = match when {
            Some((d, time)) => (Some(d.format("%Y-%m-%d").to_string()), time),
            None => (None, None),
        };
        let deadline = t
            .deadline
            .as_ref()
            .and_then(|d| {
                NaiveDate::parse_from_str(d.date.trim(), "%Y-%m-%d")
                    .ok()
                    .or_else(|| text_date(&d.date, today).map(|x| x.0))
            })
            .map(|d| d.format("%Y-%m-%d").to_string());
        if done {
            preview.done += 1
        } else {
            preview.open += 1
        }
        items.push(Imported {
            ext_id: t.id.clone(),
            task: NewTask {
                title,
                due_time: due.as_ref().and(time),
                due_date: due,
                recurrence: rule.map(|r| r.as_str().to_string()),
                notes: (!notes.is_empty()).then(|| notes.join("\n\n")),
                deadline,
                project: building,
                heading: floor,
                checklist,
                source_app: Some(APP_NAME.into()),
                ..Default::default()
            },
            done,
            completed_at: t.completed_at.as_deref().and_then(rfc3339),
            created_at: t.added_at.as_deref().and_then(rfc3339),
        });
    }

    // Projects and sections with nothing in them still come (archived ones
    // only when something of theirs did).
    for p in &order {
        if skip.contains(p.id.as_str()) || p.is_archived {
            continue;
        }
        let name = names[p.id.as_str()].clone();
        if floor_seen.insert((name.clone(), String::new())) {
            floors.push((name.clone(), None));
        }
        let mut secs: Vec<&&Section> = sections.values().filter(|s| s.project_id == p.id).collect();
        secs.sort_by_key(|s| s.section_order);
        for s in secs {
            let n = s.name.split_whitespace().collect::<Vec<_>>().join(" ");
            if !n.is_empty() && floor_seen.insert((name.clone(), n.clone())) {
                floors.push((name.clone(), Some(n)));
            }
        }
    }

    let floor_count = |name: &str| {
        floors
            .iter()
            .filter(|(p, f)| p == name && f.is_some())
            .count()
    };
    for p in &order {
        let (open, done) = counts.get(p.id.as_str()).copied().unwrap_or_default();
        if p.is_archived && open + done == 0 {
            continue;
        }
        let name = names[p.id.as_str()].clone();
        let parent = p.parent_id.as_deref().and_then(|x| names.get(x)).cloned();
        preview.buildings.push(BuildingPreview {
            key: p.id.clone(),
            floors: floor_count(&name),
            name,
            kind: "project".into(),
            area: parent.or(p.is_archived.then(|| "archived".to_string())),
            open,
            done,
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

/// A Todoist time as RFC 3339 UTC (seconds).
fn rfc3339(s: &str) -> Option<String> {
    let t = DateTime::parse_from_rfc3339(s.trim())
        .map(|t| t.with_timezone(&Utc))
        .or_else(|_| {
            NaiveDateTime::parse_from_str(s.trim(), "%Y-%m-%dT%H:%M:%S%.f").map(|t| t.and_utc())
        })
        .ok()?;
    Some(t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// What the preview says the data came from.
#[derive(Debug, Clone, Serialize)]
pub struct SourceInfo {
    /// "api" or "csv".
    pub kind: String,
    pub label: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, 25).unwrap()
    }

    fn lib() -> Library {
        let sync: SyncResponse = serde_json::from_str(
            r#"{
              "projects": [
                {"id": "100", "name": "Inbox", "inbox_project": true, "child_order": 0},
                {"id": "200", "name": "Kitchen", "child_order": 1},
                {"id": "201", "name": "Tiles", "parent_id": "200", "child_order": 2},
                {"id": 202, "name": "Empty one", "child_order": 3}
              ],
              "sections": [
                {"id": "s1", "project_id": "200", "name": "Buy", "section_order": 1},
                {"id": "s2", "project_id": "200", "name": "Later", "section_order": 2}
              ],
              "items": [
                {"id": "t1", "content": "Order tiles", "description": "From the shop", "project_id": "200",
                 "section_id": "s1", "labels": ["errand", "Big Job"], "priority": 4,
                 "due": {"date": "2026-11-03T09:30:00", "string": "Nov 3 9:30am", "is_recurring": false},
                 "deadline": {"date": "2026-11-30"}, "added_at": "2026-09-01T10:00:00Z", "child_order": 1},
                {"id": "t2", "content": "Measure", "project_id": "200", "parent_id": "t1", "child_order": 1},
                {"id": "t3", "content": "Pick colour", "project_id": "200", "parent_id": "t1", "child_order": 2, "checked": true},
                {"id": "t4", "content": "Ask Sam", "project_id": "200", "parent_id": "t2", "child_order": 1},
                {"id": "t5", "content": "Take out bins", "project_id": "100",
                 "due": {"date": "2026-10-27", "string": "every tue", "is_recurring": true}},
                {"id": "t6", "content": "Water plants", "project_id": "100",
                 "due": {"date": "2026-10-26", "string": "every 3rd tuesday", "is_recurring": true}},
                {"id": "t7", "content": "Gone", "project_id": "100", "is_deleted": true}
              ],
              "notes": [
                {"item_id": "t1", "content": "Grey, not white"},
                {"item_id": "t1", "content": "old", "is_deleted": true}
              ]
            }"#,
        )
        .unwrap();
        let mut done: Task = serde_json::from_str(
            r#"{"id": "d1", "content": "Call plumber", "project_id": "200", "completed_at": "2024-03-09T16:00:00.000000Z", "added_at": "2024-03-01T08:00:00Z"}"#,
        )
        .unwrap();
        done.checked = true;
        let mut tasks = sync.items;
        tasks.push(done);
        Library {
            projects: sync.projects,
            sections: sync.sections,
            tasks,
            comments: [("t1".to_string(), vec!["Grey, not white".to_string()])].into(),
            from_csv: false,
        }
    }

    #[test]
    fn maps_projects_sections_subtasks_and_dates() {
        let opts = Options {
            include_done: true,
            priority_tags: true,
            ..Default::default()
        };
        let p = plan(&lib(), &opts, &HashSet::new(), today());
        let get = |id: &str| p.items.iter().find(|i| i.ext_id == id).unwrap();

        let t1 = &get("t1").task;
        assert_eq!(t1.title, "Order tiles #errand #Big-Job #p1");
        assert_eq!(t1.project.as_deref(), Some("Kitchen"));
        assert_eq!(t1.heading.as_deref(), Some("Buy"));
        assert_eq!(t1.due_date.as_deref(), Some("2026-11-03"));
        assert_eq!(t1.due_time.as_deref(), Some("09:30"));
        assert_eq!(t1.deadline.as_deref(), Some("2026-11-30"));
        assert_eq!(
            t1.notes.as_deref(),
            Some("From the shop\n\nComments from Todoist:\n– Grey, not white")
        );
        let steps: Vec<(&str, bool)> = t1
            .checklist
            .iter()
            .map(|c| (c.text.as_str(), c.done))
            .collect();
        assert_eq!(
            steps,
            [
                ("Measure", false),
                ("Ask Sam", false),
                ("Pick colour", true)
            ]
        );
        assert_eq!(
            get("t1").created_at.as_deref(),
            Some("2026-09-01T10:00:00Z")
        );
        // Sub-tasks don't come on their own.
        assert!(p
            .items
            .iter()
            .all(|i| !["t2", "t3", "t4", "t7"].contains(&i.ext_id.as_str())));

        // Inbox tasks are houses; a weekly repeat maps, an odd one doesn't.
        let t5 = &get("t5").task;
        assert!(t5.project.is_none());
        assert_eq!(t5.recurrence.as_deref(), Some("weekly"));
        let t6 = &get("t6").task;
        assert!(t6.recurrence.is_none());
        assert!(t6.notes.as_deref().unwrap().contains("every 3rd tuesday"));
        assert_eq!((p.preview.repeating, p.preview.unmapped_repeats), (1, 1));

        let d1 = get("d1");
        assert!(d1.done);
        assert_eq!(d1.completed_at.as_deref(), Some("2024-03-09T16:00:00Z"));

        // Empty projects and sections still come; sub-projects show their parent.
        assert!(p.floors.contains(&("Empty one".into(), None)));
        assert!(p.floors.contains(&("Kitchen".into(), Some("Later".into()))));
        let tiles = p.preview.buildings.iter().find(|b| b.key == "201").unwrap();
        assert_eq!(tiles.area.as_deref(), Some("Kitchen"));
        let kitchen = p.preview.buildings.iter().find(|b| b.key == "200").unwrap();
        assert_eq!((kitchen.open, kitchen.done, kitchen.floors), (1, 1, 2));
        let loose = p
            .preview
            .buildings
            .iter()
            .find(|b| b.kind == "loose")
            .unwrap();
        assert_eq!(loose.open, 2);
        assert_eq!(p.preview.subtasks, 3);
    }

    #[test]
    fn options_and_earlier_imports() {
        let p = plan(&lib(), &Options::default(), &HashSet::new(), today());
        assert!(
            p.items.iter().all(|i| !i.done),
            "no completed tasks unless asked"
        );
        assert!(p
            .items
            .iter()
            .find(|i| i.ext_id == "t1")
            .unwrap()
            .task
            .title
            .ends_with("#Big-Job"));

        let opts = Options {
            include_done: true,
            skip: vec!["200".into()],
            ..Default::default()
        };
        let already: HashSet<String> = ["t5".to_string()].into();
        let p = plan(&lib(), &opts, &already, today());
        let ids: Vec<&str> = p.items.iter().map(|i| i.ext_id.as_str()).collect();
        assert_eq!(ids, ["t6"]);
        assert_eq!(p.preview.already, 1);
        assert!(!p.floors.iter().any(|(n, _)| n == "Kitchen"));
    }

    #[test]
    fn repeats() {
        for (s, r) in [
            ("every day", Some(Rule::Daily)),
            ("every! day at 9am", Some(Rule::Daily)),
            ("Every weekday", Some(Rule::Weekdays)),
            ("every monday", Some(Rule::Weekly)),
            ("every week starting jan 3", Some(Rule::Weekly)),
            ("every other friday", Some(Rule::Biweekly)),
            ("every 2 weeks", Some(Rule::Biweekly)),
            ("every month", Some(Rule::Monthly)),
            ("every 15th", Some(Rule::Monthly)),
            ("every last day", Some(Rule::Monthly)),
            ("every year", Some(Rule::Yearly)),
            ("every jan 31", Some(Rule::Yearly)),
            ("every 3 days", None),
            ("every mon, fri", None),
            ("every 3rd tuesday", None),
        ] {
            assert_eq!(repeat_rule(s), r, "{s}");
        }
    }

    #[test]
    fn dates_and_times() {
        let d = |date: &str, string: &str| {
            due_of(
                &Due {
                    date: date.into(),
                    string: string.into(),
                    ..Default::default()
                },
                today(),
            )
        };
        let day = |y, m, dd| NaiveDate::from_ymd_opt(y, m, dd).unwrap();
        assert_eq!(d("2026-10-30", ""), Some((day(2026, 10, 30), None)));
        assert_eq!(
            d("2026-10-30T17:05:00", ""),
            Some((day(2026, 10, 30), Some("17:05".into())))
        );
        // CSV: written-out dates.
        assert_eq!(d("", "Oct 30 2026"), Some((day(2026, 10, 30), None)));
        assert_eq!(
            d("", "30 Oct 2026 9:00 AM"),
            Some((day(2026, 10, 30), Some("09:00".into())))
        );
        assert_eq!(d("", "Mar 3"), Some((day(2027, 3, 3), None)));
        assert_eq!(
            d("", "every monday at 5pm"),
            Some((today(), Some("17:00".into())))
        );
        assert_eq!(d("", "tomorrow"), Some((day(2026, 10, 26), None)));
        assert_eq!(d("", "next sprint"), None);
        assert_eq!(parse_time("12am").as_deref(), Some("00:00"));
        assert_eq!(parse_time("12:30 pm").as_deref(), Some("12:30"));
        assert_eq!(
            rfc3339("2024-03-09T16:00:00.000000Z").as_deref(),
            Some("2024-03-09T16:00:00Z")
        );
    }

    #[test]
    fn reads_csv_exports() {
        let csv = "\u{feff}TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT,DEADLINE,DEADLINE_LANG\r\n\
task,Plan trip @travel,\"Hotels, \"\"cheap\"\" ones\",1,1,Sam (1),,Oct 30 2026,en,US/Pacific,,,,\r\n\
task,Book flights,,4,2,Sam (1),,,en,US/Pacific,,,,\r\n\
note,Check bags too,,,,Sam (1),,,,,,,,\r\n\
,,,,,,,,,,,,,\r\n\
section,Packing,,,,,,,,,,,,\r\n\
task,Buy adapter,,4,1,Sam (1),,every month,en,US/Pacific,,,2026-11-20,en\r\n";
        let lib = read_csv(&[
            ("Lisbon [2203306141].csv".into(), csv.into()),
            ("Inbox.csv".into(), "TYPE,CONTENT\ntask,Loose one\n".into()),
        ])
        .unwrap();
        let opts = Options {
            priority_tags: true,
            ..Default::default()
        };
        let p = plan(&lib, &opts, &HashSet::new(), today());
        let titles: Vec<&str> = p.items.iter().map(|i| i.task.title.as_str()).collect();
        assert_eq!(
            titles,
            ["Plan trip #travel #p1", "Buy adapter", "Loose one"]
        );
        let trip = &p.items[0].task;
        assert_eq!(trip.project.as_deref(), Some("Lisbon"));
        assert_eq!(trip.due_date.as_deref(), Some("2026-10-30"));
        assert_eq!(trip.notes.as_deref(), Some("Hotels, \"cheap\" ones"));
        assert_eq!(
            trip.checklist,
            vec![ChecklistItem {
                text: "Book flights".into(),
                done: false
            }]
        );
        let adapter = &p.items[1].task;
        assert_eq!(adapter.heading.as_deref(), Some("Packing"));
        assert_eq!(adapter.recurrence.as_deref(), Some("monthly"));
        assert_eq!(adapter.deadline.as_deref(), Some("2026-11-20"));
        assert!(p.items[2].task.project.is_none());
        // The note was on the sub-task: it goes with its family.
        assert!(lib.comments.values().any(|c| c[0] == "Check bags too"));
        assert!(matches!(
            read_csv(&[("x.csv".into(), "a,b\n1,2\n".into())]),
            Err(TodoistError::NoCsv)
        ));
    }

    #[test]
    fn imports_once() {
        let opts = Options {
            include_done: true,
            ..Default::default()
        };
        let store = crate::Store::open_in_memory().unwrap();
        let p = plan(&lib(), &opts, &store.imported_ids(SOURCE).unwrap(), today());
        let r = store.import(SOURCE, &p.floors, &p.items).unwrap();
        assert_eq!((r.added, r.done), (4, 1));
        assert_eq!(store.city_windows(10).unwrap().len(), 1);
        let p = plan(&lib(), &opts, &store.imported_ids(SOURCE).unwrap(), today());
        assert!(p.items.is_empty());
        assert_eq!(p.preview.already, 4);
    }

    /// A tiny stand-in for api.todoist.com.
    async fn serve() -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let line = req.lines().next().unwrap_or_default().to_string();
                    let authed = req.to_lowercase().contains("authorization: bearer good");
                    let (status, body) = if !authed {
                        ("401 Unauthorized", "{}".to_string())
                    } else if line.contains("/api/v1/sync") {
                        ("200 OK", r#"{"projects":[{"id":"1","name":"Home"}],"items":[{"id":"a","content":"Open one","project_id":"1"}],"sections":[],"notes":[]}"#.to_string())
                    } else if line.contains("/projects/archived") {
                        (
                            "200 OK",
                            r#"{"results":[{"id":"9","name":"Old"}],"next_cursor":null}"#
                                .to_string(),
                        )
                    } else if line.contains("/tasks/completed/by_completion_date") {
                        // Something done only in the first (newest) window, over two pages.
                        if line.contains("until=2026-10-25") {
                            if line.contains("cursor=p2") {
                                ("200 OK", r#"{"items":[{"id":"c2","content":"Done two","project_id":"9","completed_at":"2026-10-01T10:00:00Z"}],"next_cursor":null}"#.to_string())
                            } else {
                                ("200 OK", r#"{"items":[{"id":"c1","content":"Done one","project_id":"1","completed_at":"2026-10-02T10:00:00Z"}],"next_cursor":"p2"}"#.to_string())
                            }
                        } else {
                            ("200 OK", r#"{"items":[],"next_cursor":null}"#.to_string())
                        }
                    } else {
                        ("404 Not Found", "{}".to_string())
                    };
                    let res = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = sock.write_all(res.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn fetches_everything_over_the_api() {
        let base = serve().await;
        let client = reqwest::Client::new();
        let now = Utc.with_ymd_and_hms(2026, 10, 25, 12, 0, 0).unwrap();
        let lib = fetch(&client, &base, "good", now, |_| {}).await.unwrap();
        let ids: Vec<&str> = lib.tasks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["a", "c1", "c2"]);
        assert!(lib.tasks[1].checked);
        assert!(lib
            .projects
            .iter()
            .any(|p| p.name == "Old" && p.is_archived));

        let opts = Options {
            include_done: true,
            ..Default::default()
        };
        let p = plan(&lib, &opts, &HashSet::new(), today());
        let old = p
            .preview
            .buildings
            .iter()
            .find(|b| b.name == "Old")
            .unwrap();
        assert_eq!((old.done, old.area.as_deref()), (1, Some("archived")));

        assert!(matches!(
            fetch(&client, &base, "bad", now, |_| {}).await,
            Err(TodoistError::BadToken)
        ));
        assert!(matches!(
            fetch(&client, &base, "  ", now, |_| {}).await,
            Err(TodoistError::BadToken)
        ));
    }
}
