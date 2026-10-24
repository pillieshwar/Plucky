//! Platform-independent core of Plucky.
//!
//! Everything here is pure Rust with no UI or OS hooks, so it can be unit
//! tested on any machine:
//!
//! * [`extraction`] — the tiny output schema and its validation.
//! * [`prompt`] — the system prompt and how untrusted selected text is
//!   delimited before it reaches the model.
//! * [`llm`] — a localhost-only Ollama client plus the
//!   "constrain → validate → retry once" extraction loop.
//! * [`store`] — SQLite (WAL) task storage.
//! * [`models`] — the downloadable model catalog and Hugging Face metadata.
//! * [`download`] — resumable, checksum-verified model downloads.
//! * [`local_models`] — using GGUF files the user already has.
//! * [`recurrence`] — repeating tasks.
//! * [`notify`] — when to show due-time notifications.
//! * [`reminders_sync`] — merge rules for two-way Apple Reminders sync.
//! * [`clipboard_guard`] — the decision logic for the clipboard fallback.

pub mod clipboard_guard;
pub mod double_copy;
pub mod download;
pub mod extraction;
pub mod llm;
pub mod local_models;
pub mod models;
pub mod notify;
pub mod prompt;
pub mod recurrence;
pub mod reminders_sync;
pub mod store;
pub mod transcript;

pub use extraction::{DateConfidence, Extraction, ExtractionError};
pub use llm::{
    extract_task, find_actions, LlamaServerClient, LlmBackend, LlmError, OllamaClient, OllamaConfig,
};
pub use store::{
    ChecklistItem, CityWindow, NewTask, ProjectSummary, ReminderLink, Store, StoreError, Task,
    TaskPatch, UpdateEffects,
};
