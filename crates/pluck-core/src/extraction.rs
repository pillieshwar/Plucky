//! The extraction schema: deliberately tiny so a 3B–4B model can fill it
//! reliably, and validated in code rather than trusted.
//!
//! One selection can hold several action items (meeting notes, a checklist
//! in a message), so the model returns a short list of tasks.
//!
//! The model never resolves dates. It only copies the date phrase it saw
//! (`date_text`), and the app resolves that phrase deterministically against
//! the real local date.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Maximum length of an extracted task title, in characters.
pub const MAX_TASK_CHARS: usize = 200;
/// Maximum length of the copied date phrase, in characters.
pub const MAX_DATE_TEXT_CHARS: usize = 60;
/// Most tasks one selection can produce.
pub const MAX_TASKS: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DateConfidence {
    /// An explicit, unambiguous date phrase ("by Friday", "on Oct 20").
    High,
    /// A vague or ambiguous phrase ("soon", "next week", "end of month").
    Low,
    /// No date in the text.
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Extraction {
    /// Imperative, self-contained task title.
    pub task: String,
    /// The date phrase exactly as it appeared, or null.
    pub date_text: Option<String>,
    pub date_confidence: DateConfidence,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ExtractionError {
    #[error("model output was not valid JSON for the schema: {0}")]
    Malformed(String),
    #[error("task is empty")]
    EmptyTask,
    #[error("task is longer than {MAX_TASK_CHARS} characters")]
    TaskTooLong,
    #[error("date_text is longer than {MAX_DATE_TEXT_CHARS} characters")]
    DateTextTooLong,
    #[error("date_confidence is '{0:?}' but date_text is {1}")]
    InconsistentDate(DateConfidence, &'static str),
    #[error("no tasks in the answer")]
    NoTasks,
}

fn task_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "task": { "type": "string", "minLength": 1, "maxLength": MAX_TASK_CHARS },
            "date_text": { "type": ["string", "null"], "maxLength": MAX_DATE_TEXT_CHARS },
            "date_confidence": { "type": "string", "enum": ["high", "low", "none"] }
        },
        "required": ["task", "date_text", "date_confidence"],
        "additionalProperties": false
    })
}

/// JSON Schema handed to the runtime so decoding is constrained.
pub fn json_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "tasks": {
                "type": "array",
                "items": task_schema(),
                "minItems": 1,
                "maxItems": MAX_TASKS
            }
        },
        "required": ["tasks"],
        "additionalProperties": false
    })
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Answer {
    Many { tasks: Vec<Extraction> },
    One(Extraction),
}

/// Parse and validate the model's list of tasks. Identical titles are
/// merged and the list is capped at [`MAX_TASKS`].
pub fn parse_tasks(raw: &str) -> Result<Vec<Extraction>, ExtractionError> {
    let answer: Answer = serde_json::from_str(raw.trim())
        .map_err(|err| ExtractionError::Malformed(err.to_string()))?;
    let items = match answer {
        Answer::Many { tasks } => tasks,
        Answer::One(e) => vec![e],
    };
    let mut out: Vec<Extraction> = Vec::new();
    for e in items {
        let e = e.normalized();
        e.validate()?;
        if !out.iter().any(|o| o.task.eq_ignore_ascii_case(&e.task)) {
            out.push(e);
        }
    }
    out.truncate(MAX_TASKS);
    if out.is_empty() {
        return Err(ExtractionError::NoTasks);
    }
    Ok(out)
}

impl Extraction {
    /// Parse raw model output and validate it. Returns a normalized value:
    /// whitespace trimmed, empty `date_text` turned into `None`.
    pub fn parse(raw: &str) -> Result<Self, ExtractionError> {
        let e: Extraction = serde_json::from_str(raw.trim())
            .map_err(|err| ExtractionError::Malformed(err.to_string()))?;
        let e = e.normalized();
        e.validate()?;
        Ok(e)
    }

    fn normalized(mut self) -> Self {
        self.task = collapse_whitespace(&self.task);
        self.date_text = self
            .date_text
            .map(|d| collapse_whitespace(&d))
            .filter(|d| !d.is_empty());
        self
    }

    pub fn validate(&self) -> Result<(), ExtractionError> {
        if self.task.is_empty() {
            return Err(ExtractionError::EmptyTask);
        }
        if self.task.chars().count() > MAX_TASK_CHARS {
            return Err(ExtractionError::TaskTooLong);
        }
        if let Some(d) = &self.date_text {
            if d.chars().count() > MAX_DATE_TEXT_CHARS {
                return Err(ExtractionError::DateTextTooLong);
            }
        }
        match (self.date_confidence, &self.date_text) {
            (DateConfidence::None, Some(_)) => Err(ExtractionError::InconsistentDate(
                DateConfidence::None,
                "present",
            )),
            (c @ (DateConfidence::High | DateConfidence::Low), None) => {
                Err(ExtractionError::InconsistentDate(c, "missing"))
            }
            _ => Ok(()),
        }
    }
}

fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_output() {
        let e = Extraction::parse(
            r#"{"task":"Review rollout checklist and send comments","date_text":"by Friday","date_confidence":"high"}"#,
        )
        .unwrap();
        assert_eq!(e.task, "Review rollout checklist and send comments");
        assert_eq!(e.date_text.as_deref(), Some("by Friday"));
        assert_eq!(e.date_confidence, DateConfidence::High);
    }

    #[test]
    fn normalizes_whitespace_and_empty_date() {
        let e = Extraction::parse(
            r#"  {"task":"  Call   Sam ","date_text":"  ","date_confidence":"none"} "#,
        )
        .unwrap();
        assert_eq!(e.task, "Call Sam");
        assert_eq!(e.date_text, None);
    }

    #[test]
    fn rejects_malformed_and_extra_fields() {
        assert!(matches!(
            Extraction::parse("{\"task\":\"x\""),
            Err(ExtractionError::Malformed(_))
        ));
        assert!(matches!(
            Extraction::parse(r#"{"task":"x","date_text":null,"date_confidence":"maybe"}"#),
            Err(ExtractionError::Malformed(_))
        ));
    }

    #[test]
    fn rejects_inconsistent_dates() {
        assert_eq!(
            Extraction::parse(r#"{"task":"x","date_text":"Friday","date_confidence":"none"}"#),
            Err(ExtractionError::InconsistentDate(
                DateConfidence::None,
                "present"
            ))
        );
        assert_eq!(
            Extraction::parse(r#"{"task":"x","date_text":null,"date_confidence":"high"}"#),
            Err(ExtractionError::InconsistentDate(
                DateConfidence::High,
                "missing"
            ))
        );
    }

    #[test]
    fn rejects_empty_and_long_tasks() {
        assert_eq!(
            Extraction::parse(r#"{"task":"   ","date_text":null,"date_confidence":"none"}"#),
            Err(ExtractionError::EmptyTask)
        );
        let long = "a".repeat(MAX_TASK_CHARS + 1);
        let raw = format!(r#"{{"task":"{long}","date_text":null,"date_confidence":"none"}}"#);
        assert_eq!(Extraction::parse(&raw), Err(ExtractionError::TaskTooLong));
    }

    #[test]
    fn schema_lists_all_required_fields() {
        let s = json_schema();
        assert_eq!(s["required"][0], "tasks");
        assert_eq!(s["properties"]["tasks"]["maxItems"], MAX_TASKS);
        let req: Vec<&str> = s["properties"]["tasks"]["items"]["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(req, ["task", "date_text", "date_confidence"]);
    }

    #[test]
    fn parses_several_tasks_and_merges_repeats() {
        let raw = r#"{"tasks":[
            {"task":"Send deck to Priya","date_text":"by Friday 3pm","date_confidence":"high"},
            {"task":"Book  the room","date_text":null,"date_confidence":"none"},
            {"task":"send deck to priya","date_text":null,"date_confidence":"none"}
        ]}"#;
        let tasks = parse_tasks(raw).unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].date_text.as_deref(), Some("by Friday 3pm"));
        assert_eq!(tasks[1].task, "Book the room");
    }

    #[test]
    fn accepts_a_single_object_and_rejects_empty_or_bad_lists() {
        let one = parse_tasks(r#"{"task":"Call Sam","date_text":null,"date_confidence":"none"}"#)
            .unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(
            parse_tasks(r#"{"tasks":[]}"#),
            Err(ExtractionError::NoTasks)
        );
        assert!(matches!(
            parse_tasks(r#"{"tasks":[{"task":"","date_text":null,"date_confidence":"none"}]}"#),
            Err(ExtractionError::EmptyTask)
        ));
    }

    #[test]
    fn caps_the_number_of_tasks() {
        let items: Vec<String> = (0..9)
            .map(|i| format!(r#"{{"task":"Task {i}","date_text":null,"date_confidence":"none"}}"#))
            .collect();
        let raw = format!(r#"{{"tasks":[{}]}}"#, items.join(","));
        assert_eq!(parse_tasks(&raw).unwrap().len(), MAX_TASKS);
    }
}
