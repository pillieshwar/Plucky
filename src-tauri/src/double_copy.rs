//! Press ⌘C twice to capture (see `pluck_core::double_copy`). The clipboard
//! is only looked at, never intercepted, so ⌘C still copies everywhere.

#[cfg(target_os = "macos")]
pub fn start(app: &tauri::AppHandle) {
    use std::time::{Duration, Instant};

    use pluck_core::double_copy::DoubleCopy;
    use tauri::Manager;

    use crate::settings::Settings;

    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("double-copy".into())
        .spawn(move || {
            let mut detector = DoubleCopy::new(Duration::from_millis(700));
            let mut enabled = true;
            let mut checked: Option<Instant> = None;
            loop {
                std::thread::sleep(Duration::from_millis(70));
                if checked.map_or(true, |c| c.elapsed() > Duration::from_secs(1)) {
                    enabled = app.state::<Settings>().get().double_copy;
                    checked = Some(Instant::now());
                }
                // Off, Plucky's own clipboard use, or copying inside Plucky.
                if !enabled || crate::capture::clipboard_busy() || plucky_focused(&app) {
                    detector.reset();
                    continue;
                }
                let Some((count, text)) = crate::capture::clipboard_snapshot(&app) else {
                    continue;
                };
                if let Some(text) = detector.observe(Instant::now(), count, text.as_deref()) {
                    log::info!("double ⌘C: capturing {} chars", text.chars().count());
                    crate::on_copied_text(app.clone(), text);
                    detector.reset();
                }
            }
        });
    if let Err(e) = spawned {
        log::warn!("could not start the double-copy watcher: {e}");
    }
}

#[cfg(target_os = "macos")]
fn plucky_focused(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    app.webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false))
}

#[cfg(not(target_os = "macos"))]
pub fn start(_app: &tauri::AppHandle) {}
