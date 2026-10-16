//! Slack connector: sign in with Slack (OAuth 2 + PKCE) and keep the token
//! fresh. No server and no client secret — Plucky is a public client.
//!
//! Flow:
//! 1. `connect` makes a random `code_verifier`, its S256 `code_challenge` and a
//!    random `state`, keeps them in memory, and opens Slack's sign-in page.
//! 2. Slack redirects to `plucky://slack/callback?code=…&state=…`; macOS hands
//!    that to Plucky (deep-link plugin) and `handle_callback` checks `state`.
//! 3. The code is exchanged at `oauth.v2.access` with the verifier. The user
//!    token pair goes to the macOS Keychain, never to SQLite or settings.
//! 4. Tokens rotate: refresh before the access token expires and save the new
//!    pair each time. Refresh tokens last 30 days; after that (or if refresh
//!    fails) the UI asks to reconnect.
//! 5. `disconnect` revokes the token at Slack and deletes it from the Keychain.
//!
//! Traffic goes only between this Mac and slack.com.

#![cfg_attr(not(target_os = "macos"), allow(dead_code, unused_imports))]

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

/// Plucky's Slack app (public client; there is no secret).
pub const CLIENT_ID: &str = "12331260967042.12331299544034";
pub const REDIRECT_URI: &str = "plucky://slack/callback";
/// Read 1:1 and group DMs, and member names. User scopes only — no bot.
pub const USER_SCOPES: &str = "im:read,im:history,mpim:read,mpim:history,users:read";

const AUTHORIZE: &str = "https://slack.com/oauth/v2/authorize";
const TOKEN: &str = "https://slack.com/api/oauth.v2.access";
const REVOKE: &str = "https://slack.com/api/auth.revoke";
/// Keychain item: service + account.
const KEYCHAIN_SERVICE: &str = "app.pluck.desktop.slack";
const KEYCHAIN_ACCOUNT: &str = "user-token";
/// A sign-in left open longer than this is abandoned.
const PENDING_TTL: Duration = Duration::from_secs(15 * 60);
/// Refresh this long before the access token expires.
const REFRESH_MARGIN: i64 = 20 * 60;
/// How often the background check runs.
const CHECK_EVERY: Duration = Duration::from_secs(10 * 60);

/// What's saved in the Keychain, as JSON.
#[derive(Clone, Serialize, Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    /// Unix seconds; `None` = doesn't expire.
    expires_at: Option<i64>,
    team_id: String,
    team_name: String,
    user_id: String,
    /// Refresh failed for good (e.g. the 30-day refresh token ran out).
    #[serde(default)]
    needs_reconnect: bool,
}

struct Pending {
    verifier: String,
    state: String,
    started: Instant,
}

#[derive(Default)]
pub struct Slack {
    pending: Mutex<Option<Pending>>,
    last_error: Mutex<Option<String>>,
}

/// For the Connectors tab. No secrets.
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub supported: bool,
    pub connected: bool,
    /// Waiting for the user to finish signing in in the browser.
    pub connecting: bool,
    pub needs_reconnect: bool,
    pub team: Option<String>,
    pub user_id: Option<String>,
    pub error: Option<String>,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Base64url without padding (RFC 7636 §4.1–4.2).
fn b64url(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let chars = chunk.len() + 1;
        for i in 0..chars {
            out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

/// `code_challenge` for a verifier: base64url(SHA-256(verifier)).
pub fn challenge_for(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

fn emit(app: &AppHandle) {
    let _ = app.emit("slack-changed", ());
}

impl Slack {
    fn set_error(&self, e: Option<String>) {
        if let Ok(mut x) = self.last_error.lock() {
            *x = e;
        }
    }

    pub fn status(&self) -> Status {
        let tokens = keychain::load().ok().flatten();
        let connecting = self
            .pending
            .lock()
            .ok()
            .and_then(|p| p.as_ref().map(|p| p.started.elapsed() < PENDING_TTL))
            .unwrap_or(false);
        Status {
            supported: cfg!(target_os = "macos"),
            connected: tokens.as_ref().is_some_and(|t| !t.needs_reconnect),
            connecting,
            needs_reconnect: tokens.as_ref().is_some_and(|t| t.needs_reconnect),
            team: tokens.as_ref().map(|t| t.team_name.clone()),
            user_id: tokens.as_ref().map(|t| t.user_id.clone()),
            error: self.last_error.lock().ok().and_then(|e| e.clone()),
        }
    }

    /// Start signing in: remember the PKCE secrets and open Slack's page.
    pub fn connect(&self, app: &AppHandle) -> Result<(), String> {
        if !cfg!(target_os = "macos") {
            return Err("Slack is available on macOS.".into());
        }
        let verifier = b64url(&random_bytes::<32>()?);
        let state = b64url(&random_bytes::<16>()?);
        let mut url = url::Url::parse(AUTHORIZE).map_err(|e| e.to_string())?;
        url.query_pairs_mut()
            .append_pair("client_id", CLIENT_ID)
            .append_pair("scope", "")
            .append_pair("user_scope", USER_SCOPES)
            .append_pair("redirect_uri", REDIRECT_URI)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge_for(&verifier))
            .append_pair("code_challenge_method", "S256");
        if let Ok(mut p) = self.pending.lock() {
            *p = Some(Pending {
                verifier,
                state,
                started: Instant::now(),
            });
        }
        self.set_error(None);
        crate::open_in_browser(url.as_str())?;
        emit(app);
        Ok(())
    }

    pub fn cancel(&self, app: &AppHandle) {
        if let Ok(mut p) = self.pending.lock() {
            *p = None;
        }
        emit(app);
    }

    /// A `plucky://slack/callback?…` URL arrived from macOS.
    pub fn handle_callback(&self, app: &AppHandle, url: &url::Url) {
        let mut code = None;
        let mut state = None;
        let mut error = None;
        for (k, v) in url.query_pairs() {
            match k.as_ref() {
                "code" => code = Some(v.into_owned()),
                "state" => state = Some(v.into_owned()),
                "error" => error = Some(v.into_owned()),
                _ => {}
            }
        }
        let pending = self.pending.lock().ok().and_then(|mut p| p.take());
        let Some(pending) = pending.filter(|p| p.started.elapsed() < PENDING_TTL) else {
            log::warn!("Slack callback without a sign-in in progress; ignored");
            return;
        };
        if state.as_deref() != Some(pending.state.as_str()) {
            log::warn!("Slack callback with the wrong state; ignored");
            self.set_error(Some("Slack sign-in didn't match. Please try again.".into()));
            emit(app);
            return;
        }
        if let Some(e) = error {
            self.set_error(Some(if e == "access_denied" {
                "Slack sign-in was cancelled.".into()
            } else {
                format!("Slack said: {e}")
            }));
            emit(app);
            return;
        }
        let Some(code) = code else {
            self.set_error(Some("Slack didn't send a sign-in code.".into()));
            emit(app);
            return;
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let result = exchange(&code, &pending.verifier).await;
            let slack = app.state::<Slack>();
            match result.and_then(|t| keychain::save(&t).map(|_| t)) {
                Ok(t) => {
                    log::info!("connected to Slack workspace {}", t.team_id);
                    slack.set_error(None);
                }
                Err(e) => {
                    log::warn!("Slack sign-in failed: {e}");
                    slack.set_error(Some(e));
                }
            }
            emit(&app);
        });
    }

    /// Revoke the token at Slack (best effort) and delete it from the Keychain.
    pub async fn disconnect(&self, app: &AppHandle) -> Result<(), String> {
        if let Some(t) = keychain::load()? {
            let revoked = reqwest::Client::new()
                .post(REVOKE)
                .bearer_auth(&t.access_token)
                .send()
                .await;
            if let Err(e) = revoked {
                log::warn!("could not revoke the Slack token: {e}");
            }
        }
        keychain::delete()?;
        self.set_error(None);
        emit(app);
        Ok(())
    }

    /// Refresh the token pair if it's about to expire. Returns a usable
    /// access token, or an error when Slack needs to be reconnected.
    pub async fn fresh_token(&self, app: &AppHandle) -> Result<String, String> {
        let Some(mut t) = keychain::load()? else {
            return Err("Slack isn't connected.".into());
        };
        if t.needs_reconnect {
            return Err("Reconnect Slack.".into());
        }
        let due = t.expires_at.is_some_and(|at| at - now() < REFRESH_MARGIN);
        if !due {
            return Ok(t.access_token);
        }
        let Some(refresh) = t.refresh_token.clone() else {
            return Ok(t.access_token);
        };
        match refresh_tokens(&refresh).await {
            Ok(Refreshed::New(new)) => {
                t.access_token = new.access_token;
                t.refresh_token = new.refresh_token.or(t.refresh_token);
                t.expires_at = new.expires_at;
                keychain::save(&t)?;
                emit(app);
                Ok(t.access_token)
            }
            Ok(Refreshed::Expired(why)) => {
                log::info!("Slack refresh token no longer valid ({why}); needs reconnect");
                t.needs_reconnect = true;
                keychain::save(&t)?;
                emit(app);
                Err("Reconnect Slack.".into())
            }
            // Network trouble: keep the tokens and try again later.
            Err(e) => Err(e),
        }
    }

    /// Keep the token fresh in the background, so it doesn't lapse while
    /// Plucky is open.
    pub fn start(app: &AppHandle) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let slack = app.state::<Slack>();
                if let Err(e) = slack.fresh_token(&app).await {
                    if e != "Slack isn't connected." {
                        log::debug!("Slack token check: {e}");
                    }
                }
                tokio::time::sleep(CHECK_EVERY).await;
            }
        });
    }
}

/// `oauth.v2.access` response, only the parts Plucky uses.
#[derive(Deserialize)]
struct TokenResponse {
    ok: bool,
    error: Option<String>,
    team: Option<Team>,
    authed_user: Option<AuthedUser>,
    // Refresh responses put the user token at the top level.
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(Deserialize)]
struct Team {
    id: String,
    name: Option<String>,
}

#[derive(Deserialize)]
struct AuthedUser {
    id: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

async fn post_token(form: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let res = reqwest::Client::new()
        .post(TOKEN)
        .form(form)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Slack ({e})."))?;
    res.json::<TokenResponse>()
        .await
        .map_err(|e| format!("Slack sent an unexpected answer ({e})."))
}

async fn exchange(code: &str, verifier: &str) -> Result<Tokens, String> {
    let r = post_token(&[
        ("client_id", CLIENT_ID),
        ("code", code),
        ("code_verifier", verifier),
        ("redirect_uri", REDIRECT_URI),
        ("grant_type", "authorization_code"),
    ])
    .await?;
    if !r.ok {
        return Err(format!(
            "Slack refused the sign-in ({}).",
            r.error.unwrap_or_else(|| "unknown error".into())
        ));
    }
    let user = r.authed_user.ok_or("Slack didn't return a user.")?;
    let access_token = user
        .access_token
        .ok_or("Slack didn't return a user token. Check the app's user scopes.")?;
    let team = r.team.ok_or("Slack didn't say which workspace.")?;
    Ok(Tokens {
        access_token,
        refresh_token: user.refresh_token,
        expires_at: user.expires_in.map(|s| now() + s),
        team_name: team.name.unwrap_or_else(|| team.id.clone()),
        team_id: team.id,
        user_id: user.id,
        needs_reconnect: false,
    })
}

struct NewTokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<i64>,
}

enum Refreshed {
    New(NewTokens),
    /// The refresh token is no longer accepted; the user has to reconnect.
    Expired(String),
}

async fn refresh_tokens(refresh_token: &str) -> Result<Refreshed, String> {
    let r = post_token(&[
        ("client_id", CLIENT_ID),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
    ])
    .await?;
    if !r.ok {
        let e = r.error.unwrap_or_else(|| "unknown error".into());
        return match e.as_str() {
            "invalid_refresh_token"
            | "token_expired"
            | "token_revoked"
            | "invalid_auth"
            | "invalid_grant"
            | "account_inactive" => Ok(Refreshed::Expired(e)),
            _ => Err(format!("Slack refresh failed ({e}).")),
        };
    }
    // User-token refreshes may come back at the top level or under
    // authed_user; accept either.
    let (access, refresh, expires) = match r.authed_user {
        Some(u) if u.access_token.is_some() => (u.access_token, u.refresh_token, u.expires_in),
        _ => (r.access_token, r.refresh_token, r.expires_in),
    };
    let access_token = access.ok_or("Slack didn't return a new token.")?;
    Ok(Refreshed::New(NewTokens {
        access_token,
        refresh_token: refresh,
        expires_at: expires.map(|s| now() + s),
    }))
}

/// The token pair lives in the login Keychain, as one generic password.
mod keychain {
    use super::{Tokens, KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE};

    #[cfg(target_os = "macos")]
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
    }

    pub fn load() -> Result<Option<Tokens>, String> {
        #[cfg(target_os = "macos")]
        {
            match entry()?.get_password() {
                Ok(json) => serde_json::from_str(&json)
                    .map(Some)
                    .map_err(|e| format!("Slack sign-in data is unreadable ({e}).")),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(format!("Couldn't read the Keychain ({e}).")),
            }
        }
        #[cfg(not(target_os = "macos"))]
        Ok(None)
    }

    pub fn save(t: &Tokens) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let json = serde_json::to_string(t).map_err(|e| e.to_string())?;
            entry()?
                .set_password(&json)
                .map_err(|e| format!("Couldn't save to the Keychain ({e})."))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = t;
            Err("Slack is available on macOS.".into())
        }
    }

    pub fn delete() -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            match entry()?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(format!("Couldn't remove it from the Keychain ({e}).")),
            }
        }
        #[cfg(not(target_os = "macos"))]
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_base64url_sha256() {
        // Expected value computed independently with Python's hashlib/base64.
        let verifier = "dBjftJeZ4CVP-mJ92ZAyKUOJUNa6x5I8bVVqp3cVgnjYKuOnyT9h5Shn4PGHn5nK";
        assert_eq!(
            challenge_for(verifier),
            "6Y_VhXvREYuOPzOpXOWBOfwrT4Cpxdijr1Ch-eDP0-c"
        );
    }

    #[test]
    fn base64url_has_no_padding() {
        assert_eq!(b64url(b"f"), "Zg");
        assert_eq!(b64url(b"fo"), "Zm8");
        assert_eq!(b64url(b"foo"), "Zm9v");
        assert_eq!(b64url(&[0xfb, 0xff]), "-_8");
    }
}
