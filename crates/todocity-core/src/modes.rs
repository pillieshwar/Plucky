//! Modes: which projects a Mac shows right now ("Work", "Personal", or any
//! the person makes). A mode only changes what's shown — Today, Upcoming,
//! the calendar, the menu bar and, if it says so, notifications. Tasks
//! themselves are untouched and still sync everywhere.

use serde::{Deserialize, Serialize};

use crate::store::Task;

/// The project every Mac starts with for personal things, and for work.
pub const HOME: &str = "Home";
pub const OFFICE: &str = "Office";

/// The most modes anyone needs, and the longest name.
pub const MAX_MODES: usize = 12;
const MAX_NAME: usize = 30;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ViewMode {
    /// Stable id: "work", "personal", or one made for a new mode.
    pub id: String,
    pub name: String,
    /// One emoji (or a short symbol) shown before the name.
    pub icon: String,
    /// With `new_projects` off: the projects shown. With it on: the
    /// projects hidden (so projects made later show up by themselves).
    pub projects: Vec<String>,
    pub new_projects: bool,
    /// Show tasks that belong to no project.
    pub no_project: bool,
    /// Calendars hidden in this mode (by `calendar::key`), on top of the
    /// ones hidden in the Calendar connector.
    pub hidden_calendars: Vec<String>,
    /// Only notify about tasks this mode shows.
    pub notify: bool,
    /// Tasks added with no project go here while this mode is on.
    pub new_task_project: Option<String>,
}

impl Default for ViewMode {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            icon: "◎".into(),
            projects: Vec::new(),
            new_projects: false,
            no_project: true,
            hidden_calendars: Vec::new(),
            notify: true,
            new_task_project: None,
        }
    }
}

impl ViewMode {
    /// Work: starts with the Office project (plus tasks with no project),
    /// and new tasks go to Office.
    pub fn work() -> Self {
        Self {
            id: "work".into(),
            name: "Work".into(),
            icon: "💼".into(),
            projects: vec![OFFICE.into()],
            new_task_project: Some(OFFICE.into()),
            ..Self::default()
        }
    }

    /// Personal: every project but Office, including ones made later, and
    /// new tasks go to Home.
    pub fn personal() -> Self {
        Self {
            id: "personal".into(),
            name: "Personal".into(),
            icon: "🏠".into(),
            new_projects: true,
            projects: vec![OFFICE.into()],
            new_task_project: Some(HOME.into()),
            ..Self::default()
        }
    }

    /// Give a Work or Personal mode made before 0.4.55 its default project
    /// (Office or Home), unless the person already picked one.
    pub fn adopt_defaults(&mut self) {
        let (project, hide) = match self.id.as_str() {
            "work" => (OFFICE, false),
            "personal" => (HOME, true),
            _ => return,
        };
        if self.new_task_project.is_none() {
            self.new_task_project = Some(project.into());
        }
        // Work shows Office; Personal (which lists what it hides) hides it.
        if self.new_projects == hide && !self.projects.iter().any(|p| p == OFFICE) {
            self.projects.push(OFFICE.into());
            self.projects.sort();
        }
    }

    pub fn defaults() -> Vec<Self> {
        vec![Self::work(), Self::personal()]
    }

    /// Whether a task in `project` (or none) is shown in this mode.
    pub fn shows_project(&self, project: Option<&str>) -> bool {
        match project {
            None => self.no_project,
            Some(p) => self.projects.iter().any(|x| x == p) != self.new_projects,
        }
    }

    pub fn shows(&self, task: &Task) -> bool {
        self.shows_project(task.project.as_deref())
    }
}

/// Tidy modes from the settings file or the UI: names trimmed and present,
/// ids unique, at most [`MAX_MODES`]. An empty list gets the defaults back.
pub fn clean(modes: Vec<ViewMode>) -> Vec<ViewMode> {
    let mut out: Vec<ViewMode> = Vec::new();
    for mut m in modes.into_iter().take(MAX_MODES) {
        m.name = m
            .name
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_NAME)
            .collect::<String>()
            .trim()
            .to_string();
        if m.name.is_empty() {
            continue;
        }
        m.icon = m.icon.trim().chars().take(4).collect();
        if m.icon.is_empty() {
            m.icon = "◎".into();
        }
        let mut id: String =
            m.id.chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .take(40)
                .collect();
        if id.is_empty() {
            id = "mode".into();
        }
        let base = id.clone();
        let mut n = 2;
        while out.iter().any(|o| o.id == id) {
            id = format!("{base}-{n}");
            n += 1;
        }
        m.id = id;
        m.projects.sort();
        m.projects.dedup();
        m.hidden_calendars.sort();
        m.hidden_calendars.dedup();
        m.new_task_project = m.new_task_project.filter(|p| !p.trim().is_empty());
        out.push(m);
    }
    if out.is_empty() {
        ViewMode::defaults()
    } else {
        out
    }
}

/// The mode this Mac is in, if any (none means everything is shown).
pub fn active<'a>(modes: &'a [ViewMode], id: Option<&str>) -> Option<&'a ViewMode> {
    let id = id?;
    modes.iter().find(|m| m.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(project: Option<&str>) -> Task {
        Task {
            title: "x".into(),
            project: project.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn work_shows_its_projects_and_loose_tasks() {
        let mut work = ViewMode::work();
        work.projects = vec!["Q4 launch".into()];
        assert!(work.shows(&task(Some("Q4 launch"))));
        assert!(!work.shows(&task(Some("Home"))));
        assert!(work.shows(&task(None)));
        work.no_project = false;
        assert!(!work.shows(&task(None)));
    }

    #[test]
    fn work_and_personal_start_with_office_and_home() {
        let (work, personal) = (ViewMode::work(), ViewMode::personal());
        assert!(work.shows(&task(Some(OFFICE))) && !work.shows(&task(Some(HOME))));
        assert!(personal.shows(&task(Some(HOME))) && !personal.shows(&task(Some(OFFICE))));
        assert_eq!(work.new_task_project.as_deref(), Some(OFFICE));
        assert_eq!(personal.new_task_project.as_deref(), Some(HOME));
        // Older modes adopt them; a choice already made stays.
        let mut old = ViewMode {
            id: "personal".into(),
            name: "Personal".into(),
            new_projects: true,
            ..ViewMode::default()
        };
        old.adopt_defaults();
        assert_eq!(
            old,
            ViewMode {
                icon: "◎".into(),
                ..ViewMode::personal()
            }
        );
        let mut chosen = ViewMode {
            new_task_project: Some("Q4 launch".into()),
            projects: vec!["Q4 launch".into()],
            ..ViewMode::work()
        };
        chosen.adopt_defaults();
        assert_eq!(chosen.new_task_project.as_deref(), Some("Q4 launch"));
        assert_eq!(
            chosen.projects,
            vec!["Office".to_string(), "Q4 launch".to_string()]
        );
    }

    #[test]
    fn personal_shows_everything_but_what_it_hides() {
        let mut personal = ViewMode::personal();
        assert!(personal.shows(&task(Some("Brand new project"))));
        personal.projects = vec!["Q4 launch".into()];
        assert!(!personal.shows(&task(Some("Q4 launch"))));
        assert!(personal.shows(&task(Some("Home"))));
    }

    #[test]
    fn cleaning_keeps_modes_sensible() {
        let modes = clean(vec![
            ViewMode::work(),
            ViewMode {
                id: "work".into(),
                name: "  Study  ".into(),
                icon: "".into(),
                ..ViewMode::default()
            },
            ViewMode {
                id: "x".into(),
                name: "   ".into(),
                ..ViewMode::default()
            },
        ]);
        assert_eq!(modes.len(), 2);
        assert_eq!(modes[1].id, "work-2");
        assert_eq!(modes[1].name, "Study");
        assert_eq!(modes[1].icon, "◎");
        assert_eq!(clean(vec![]), ViewMode::defaults());
        assert_eq!(
            active(&modes, Some("work-2")).map(|m| m.name.as_str()),
            Some("Study")
        );
        assert!(active(&modes, None).is_none());
        assert!(active(&modes, Some("gone")).is_none());
    }
}
