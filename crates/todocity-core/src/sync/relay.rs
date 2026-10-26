//! Talking to the relay: a mailbox for the group's sealed boxes, and
//! short-lived rooms for pairing. See `relay/src/index.ts` for the other end.

use std::time::Duration;

use serde::Deserialize;

use super::b64;

#[derive(Debug, thiserror::Error)]
pub enum RelayError {
    #[error("can't reach the sync relay: {0}")]
    Network(String),
    #[error("the sync relay turned this Mac away (wrong pass)")]
    Unauthorized,
    #[error("that code isn't open (it may have expired)")]
    NoRoom,
    #[error("the sync relay is busy; trying again shortly")]
    Busy,
    #[error("the sync relay said: {0}")]
    Other(String),
}

impl From<reqwest::Error> for RelayError {
    fn from(e: reqwest::Error) -> Self {
        RelayError::Network(e.without_url().to_string())
    }
}

/// One box waiting in the mailbox.
#[derive(Debug, Clone)]
pub struct Boxed {
    pub n: i64,
    pub from: String,
    pub data: Vec<u8>,
}

/// A page of boxes.
#[derive(Debug, Clone, Default)]
pub struct Page {
    pub boxes: Vec<Boxed>,
    /// More are waiting after these.
    pub more: bool,
    /// Boxes this Mac never read were removed (it was away too long):
    /// it needs a fresh copy from the others.
    pub gap: bool,
    /// The newest box number in the mailbox.
    pub latest: i64,
}

#[derive(Deserialize)]
struct RawBox {
    #[serde(rename = "box")]
    n: i64,
    #[serde(default)]
    from: String,
    data: String,
}

#[derive(Deserialize)]
struct RawPage {
    boxes: Vec<RawBox>,
    #[serde(default)]
    more: bool,
    #[serde(default)]
    gap: bool,
    #[serde(default)]
    latest: i64,
}

#[derive(Deserialize)]
struct RawMsgs {
    msgs: Vec<String>,
}

/// The relay, as seen by one Mac of one group.
#[derive(Clone)]
pub struct Relay {
    http: reqwest::Client,
    base: String,
    device: String,
}

/// Room codes are 8 letters; mailbox names are URL-safe base64.
fn safe(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Relay {
    pub fn new(base: &str, device: &str) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .user_agent(concat!("TodoCity/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default();
        Self {
            http,
            base: base.trim_end_matches('/').to_string(),
            device: device.to_string(),
        }
    }

    fn mailbox(&self, id: &str, rest: &str) -> Result<String, RelayError> {
        if !safe(id) {
            return Err(RelayError::Other("bad mailbox name".into()));
        }
        Ok(format!("{}/v1/m/{id}{rest}", self.base))
    }

    fn req(&self, method: reqwest::Method, url: String, token: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, url)
            .bearer_auth(token)
            .header("x-device", &self.device)
    }

    async fn check(resp: reqwest::Response) -> Result<reqwest::Response, RelayError> {
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        Err(match status.as_u16() {
            401 | 403 => RelayError::Unauthorized,
            404 | 410 => RelayError::NoRoom,
            429 | 503 => RelayError::Busy,
            _ => RelayError::Other(format!(
                "{status}: {}",
                resp.text()
                    .await
                    .unwrap_or_default()
                    .chars()
                    .take(200)
                    .collect::<String>()
            )),
        })
    }

    /// Put one sealed box in the mailbox; its number.
    pub async fn put(&self, mailbox: &str, token: &str, data: Vec<u8>) -> Result<i64, RelayError> {
        #[derive(Deserialize)]
        struct R {
            #[serde(rename = "box")]
            n: i64,
        }
        let resp = self
            .req(
                reqwest::Method::POST,
                self.mailbox(mailbox, "/boxes")?,
                token,
            )
            .header("content-type", "application/octet-stream")
            .body(data)
            .send()
            .await?;
        Ok(Self::check(resp).await?.json::<R>().await?.n)
    }

    /// Boxes after `after`.
    pub async fn list(&self, mailbox: &str, token: &str, after: i64) -> Result<Page, RelayError> {
        let url = format!("{}?after={after}", self.mailbox(mailbox, "/boxes")?);
        let resp = self.req(reqwest::Method::GET, url, token).send().await?;
        let raw: RawPage = Self::check(resp).await?.json().await?;
        Ok(Page {
            boxes: raw
                .boxes
                .into_iter()
                .filter_map(|b| {
                    Some(Boxed {
                        n: b.n,
                        from: b.from,
                        data: b64::decode(&b.data)?,
                    })
                })
                .collect(),
            more: raw.more,
            gap: raw.gap,
            latest: raw.latest,
        })
    }

    /// This Mac has everything up to `upto`: once every Mac has, the relay
    /// deletes those boxes.
    pub async fn ack(&self, mailbox: &str, token: &str, upto: i64) -> Result<(), RelayError> {
        let resp = self
            .req(reqwest::Method::POST, self.mailbox(mailbox, "/ack")?, token)
            .json(&serde_json::json!({ "upto": upto }))
            .send()
            .await?;
        Self::check(resp).await.map(drop)
    }

    /// Tell the relay about a Mac joining, so boxes after `acked` wait for it.
    pub async fn add_device(
        &self,
        mailbox: &str,
        token: &str,
        device: &str,
        acked: i64,
    ) -> Result<(), RelayError> {
        if !safe(device) {
            return Err(RelayError::Other("bad device id".into()));
        }
        let resp = self
            .req(
                reqwest::Method::PUT,
                self.mailbox(mailbox, &format!("/devices/{device}"))?,
                token,
            )
            .json(&serde_json::json!({ "acked": acked }))
            .send()
            .await?;
        Self::check(resp).await.map(drop)
    }

    /// Stop keeping boxes for a Mac that left.
    pub async fn remove_device(
        &self,
        mailbox: &str,
        token: &str,
        device: &str,
    ) -> Result<(), RelayError> {
        if !safe(device) {
            return Err(RelayError::Other("bad device id".into()));
        }
        let resp = self
            .req(
                reqwest::Method::DELETE,
                self.mailbox(mailbox, &format!("/devices/{device}"))?,
                token,
            )
            .send()
            .await?;
        Self::check(resp).await.map(drop)
    }

    /// Delete the whole mailbox (the last Mac turned sync off).
    pub async fn delete_mailbox(&self, mailbox: &str, token: &str) -> Result<(), RelayError> {
        let resp = self
            .req(reqwest::Method::DELETE, self.mailbox(mailbox, "")?, token)
            .send()
            .await?;
        Self::check(resp).await.map(drop)
    }

    // ── Pairing rooms ──────────────────────────────────────────────────────

    fn room(&self, code: &str) -> Result<String, RelayError> {
        if !safe(code) {
            return Err(RelayError::NoRoom);
        }
        Ok(format!("{}/v1/pair/{code}", self.base))
    }

    /// Open a room (the Mac showing the code does this) with its first message.
    pub async fn open_room(&self, code: &str, first: &str) -> Result<(), RelayError> {
        let resp = self
            .http
            .post(format!("{}?new=1", self.room(code)?))
            .header("content-type", "text/plain")
            .body(first.to_string())
            .send()
            .await?;
        Self::check(resp).await.map(drop)
    }

    pub async fn say(&self, code: &str, msg: &str) -> Result<(), RelayError> {
        let resp = self
            .http
            .post(self.room(code)?)
            .header("content-type", "text/plain")
            .body(msg.to_string())
            .send()
            .await?;
        Self::check(resp).await.map(drop)
    }

    /// Messages in the room, from the `after`-th on.
    pub async fn hear(&self, code: &str, after: usize) -> Result<Vec<String>, RelayError> {
        let resp = self
            .http
            .get(format!("{}?after={after}", self.room(code)?))
            .send()
            .await?;
        Ok(Self::check(resp).await?.json::<RawMsgs>().await?.msgs)
    }

    pub async fn close_room(&self, code: &str) {
        if let Ok(url) = self.room(code) {
            let _ = self.http.delete(url).send().await;
        }
    }
}
