//! The Slack connector was removed in 0.4.20 (watching the screen covers
//! Slack without a sign-in). If it was ever connected, revoke that sign-in at
//! Slack (best effort) and delete it from the Keychain, once, at launch.

use tauri::AppHandle;

#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "app.pluck.desktop.slack";
#[cfg(target_os = "macos")]
const KEYCHAIN_ACCOUNT: &str = "user-token";
#[cfg(target_os = "macos")]
const REVOKE: &str = "https://slack.com/api/auth.revoke";

pub fn start(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        tauri::async_runtime::spawn(async {
            let entry = match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
                Ok(e) => e,
                Err(_) => return,
            };
            let Ok(json) = entry.get_password() else {
                return; // Never connected (or already cleaned up).
            };
            let token = serde_json::from_str::<serde_json::Value>(&json)
                .ok()
                .and_then(|v| v["access_token"].as_str().map(str::to_string));
            if let Some(token) = token {
                let revoked = reqwest::Client::new()
                    .post(REVOKE)
                    .bearer_auth(token)
                    .send()
                    .await;
                if let Err(e) = revoked {
                    log::warn!("could not revoke the old Slack sign-in: {e}");
                }
            }
            match entry.delete_credential() {
                Ok(()) => log::info!("removed the old Slack sign-in from the Keychain"),
                Err(e) => log::warn!("could not remove the old Slack sign-in: {e}"),
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}
