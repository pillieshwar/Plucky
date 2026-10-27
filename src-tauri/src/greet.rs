//! Keep the task panel in sight: open it when TodoCity starts (at login too)
//! and the first time the Mac wakes up each day.
//!
//! Waking is noticed without any OS hooks: a background thread ticks every
//! few seconds, and a tick that arrives far later on the wall clock than it
//! should means the computer was asleep in between.

use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager};

use crate::settings::Settings;

const TICK: Duration = Duration::from_secs(10);
/// A gap this much longer than a tick is a sleep, not a busy moment.
const SLEPT: Duration = Duration::from_secs(90);

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// At launch: show the panel unless the user turned this off. First runs
/// (nothing set up yet) always show it, for the tour.
pub fn on_launch(app: &AppHandle, first_run: bool) {
    let settings = app.state::<Settings>();
    if first_run || settings.get().show_on_start {
        settings.update(|s| s.last_greeted = Some(today()));
        // The first-run tour lives in the panel; after that, TodoCity
        // opens in full screen unless the person chose the panel.
        if first_run {
            crate::panel::show(app);
        } else {
            crate::panel::open_main_window(app);
        }
    }
}

/// Watch for the Mac waking up, and show the panel on the first wake of a
/// new day.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    std::thread::Builder::new()
        .name("todocity-wake".into())
        .spawn(move || {
            let mut last = SystemTime::now();
            loop {
                std::thread::sleep(TICK);
                let now = SystemTime::now();
                let gap = now.duration_since(last).unwrap_or_default();
                last = now;
                if gap > TICK + SLEPT {
                    on_wake(&app);
                }
            }
        })
        .map(|_| ())
        .unwrap_or_else(|e| log::warn!("could not watch for wake: {e}"));
}

fn on_wake(app: &AppHandle) {
    let settings = app.state::<Settings>();
    let s = settings.get();
    let day = today();
    if !s.show_on_start || s.last_greeted.as_deref() == Some(day.as_str()) {
        return;
    }
    settings.update(|s| s.last_greeted = Some(day));
    log::info!("first wake today; showing the panel");
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || crate::panel::show(&handle));
}
