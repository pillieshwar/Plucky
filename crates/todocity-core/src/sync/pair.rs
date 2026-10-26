//! Pairing two Macs, as two pure state machines that read and write the
//! messages of a relay room. The relay only passes messages along; it never
//! learns the group key, and can't swap keys unnoticed:
//!
//! 1. **Host** (the Mac already syncing, or starting) shows a code and
//!    posts a commitment to its key: `commit`.
//! 2. **Joiner** types the code and posts its key: `join`.
//! 3. Host reveals its key: `reveal`. Joiner checks it matches the
//!    commitment, so the host couldn't have picked it after seeing the
//!    joiner's.
//! 4. Both show six digits from the shared secret. The person checks they
//!    match, on both Macs.
//! 5. Host, once confirmed, posts the group key sealed with the shared
//!    secret: `invite`. Joiner opens it only once confirmed there too.

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::b64;
use super::crypto::{commitment, CryptoError, PairKey, Paired};

/// What the host gives a joining Mac.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invite {
    /// The group key, as text.
    pub key: String,
    /// Where the relay is.
    pub relay: String,
    /// Start reading the mailbox after this box.
    pub cursor: i64,
    pub host: String,
    pub host_name: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PairError {
    #[error("the other Mac's key didn't match what it promised; try again")]
    Mismatch,
    #[error("the other Mac cancelled")]
    Cancelled,
    #[error(transparent)]
    Crypto(#[from] CryptoError),
}

#[derive(Deserialize)]
struct Msg {
    t: String,
    #[serde(default)]
    h: String,
    #[serde(default)]
    pk: String,
    #[serde(default)]
    device: String,
    #[serde(rename = "box", default)]
    sealed: String,
}

fn parse(msg: &str) -> Option<Msg> {
    serde_json::from_str(msg).ok()
}

pub fn cancel_msg() -> String {
    json!({ "t": "no" }).to_string()
}

/// The Mac showing the code.
pub struct Host {
    code: String,
    key: Option<PairKey>,
    public: [u8; 32],
    paired: Option<Paired>,
    /// The joining Mac's device id, once it's here. (Names travel only
    /// inside sealed boxes, never in the clear through the room.)
    pub peer: Option<String>,
}

impl Host {
    /// Returns the host and the first message to open the room with.
    pub fn new(code: &str) -> Result<(Self, String), PairError> {
        let key = PairKey::generate()?;
        let public = key.public;
        let first = json!({ "t": "commit", "h": commitment(&public) }).to_string();
        Ok((
            Self {
                code: code.to_string(),
                key: Some(key),
                public,
                paired: None,
                peer: None,
            },
            first,
        ))
    }

    /// Take in one message; maybe a reply to post.
    pub fn hear(&mut self, msg: &str) -> Result<Option<String>, PairError> {
        let Some(m) = parse(msg) else { return Ok(None) };
        match m.t.as_str() {
            "join" if self.paired.is_none() => {
                let Some(peer) = b64::decode(&m.pk).filter(|k| k.len() == 32) else {
                    return Ok(None);
                };
                let Some(key) = self.key.take() else {
                    return Ok(None);
                };
                self.paired = Some(key.agree(&peer, &self.code, &self.public, &peer)?);
                self.peer = Some(m.device);
                Ok(Some(
                    json!({ "t": "reveal", "pk": b64::encode_url(&self.public) }).to_string(),
                ))
            }
            "no" => Err(PairError::Cancelled),
            _ => Ok(None),
        }
    }

    /// The six digits to compare, once the other Mac is here.
    pub fn sas(&self) -> Option<&str> {
        self.paired.as_ref().map(|p| p.sas.as_str())
    }

    /// The invite message. Only call once the person confirmed the digits.
    pub fn invite(&self, invite: &Invite) -> Result<Option<String>, PairError> {
        let Some(p) = &self.paired else {
            return Ok(None);
        };
        let sealed = p.seal(&serde_json::to_vec(invite).unwrap_or_default())?;
        Ok(Some(
            json!({ "t": "invite", "box": b64::encode_url(&sealed) }).to_string(),
        ))
    }
}

/// The Mac that typed the code.
pub struct Joiner {
    code: String,
    key: Option<PairKey>,
    public: [u8; 32],
    device: String,
    commit: Option<String>,
    paired: Option<Paired>,
    sealed: Option<Vec<u8>>,
}

impl Joiner {
    pub fn new(code: &str, device: &str) -> Result<Self, PairError> {
        let key = PairKey::generate()?;
        Ok(Self {
            code: code.to_string(),
            public: key.public,
            key: Some(key),
            device: device.to_string(),
            commit: None,
            paired: None,
            sealed: None,
        })
    }

    pub fn hear(&mut self, msg: &str) -> Result<Option<String>, PairError> {
        let Some(m) = parse(msg) else { return Ok(None) };
        match m.t.as_str() {
            "commit" if self.commit.is_none() => {
                self.commit = Some(m.h);
                Ok(Some(
                    json!({ "t": "join", "pk": b64::encode_url(&self.public), "device": self.device })
                        .to_string(),
                ))
            }
            "reveal" if self.paired.is_none() && self.commit.is_some() => {
                let peer = b64::decode(&m.pk)
                    .filter(|k| k.len() == 32)
                    .ok_or(PairError::Mismatch)?;
                if Some(commitment(&peer)) != self.commit {
                    return Err(PairError::Mismatch);
                }
                let Some(key) = self.key.take() else {
                    return Ok(None);
                };
                self.paired = Some(key.agree(&peer, &self.code, &peer, &self.public)?);
                Ok(None)
            }
            "invite" if self.paired.is_some() => {
                self.sealed = b64::decode(&m.sealed);
                Ok(None)
            }
            "no" => Err(PairError::Cancelled),
            _ => Ok(None),
        }
    }

    pub fn sas(&self) -> Option<&str> {
        self.paired.as_ref().map(|p| p.sas.as_str())
    }

    /// The invite, if it has arrived. Only call once the person confirmed.
    pub fn invite(&self) -> Result<Option<Invite>, PairError> {
        let (Some(p), Some(sealed)) = (&self.paired, &self.sealed) else {
            return Ok(None);
        };
        let plain = p.open(sealed)?;
        Ok(serde_json::from_slice(&plain).ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::crypto::room_code;

    fn invite() -> Invite {
        Invite {
            key: "k".into(),
            relay: "https://relay.example".into(),
            cursor: 7,
            host: "H".into(),
            host_name: "Home Mac".into(),
        }
    }

    #[test]
    fn a_whole_pairing() {
        let code = room_code().unwrap();
        let (mut host, commit) = Host::new(&code).unwrap();
        let mut join = Joiner::new(&code, "J").unwrap();
        let hello = join.hear(&commit).unwrap().unwrap();
        let reveal = host.hear(&hello).unwrap().unwrap();
        assert_eq!(host.peer.as_deref(), Some("J"));
        assert!(join.hear(&reveal).unwrap().is_none());
        assert_eq!(host.sas(), join.sas());
        assert!(host.sas().is_some());
        // Nothing personal goes through the room in the clear.
        assert!(!hello.contains("Mac") && !reveal.contains("Mac"));

        let msg = host.invite(&invite()).unwrap().unwrap();
        assert_eq!(join.invite().unwrap(), None);
        join.hear(&msg).unwrap();
        assert_eq!(join.invite().unwrap(), Some(invite()));
    }

    #[test]
    fn a_swapped_key_is_caught() {
        let code = room_code().unwrap();
        let (mut host, commit) = Host::new(&code).unwrap();
        let mut join = Joiner::new(&code, "J").unwrap();
        let hello = join.hear(&commit).unwrap().unwrap();
        host.hear(&hello).unwrap();
        // Someone in the middle answers with a key of their own.
        let (mut fake, _) = Host::new(&code).unwrap();
        let fake_reveal = fake.hear(&hello).unwrap().unwrap();
        assert_eq!(join.hear(&fake_reveal), Err(PairError::Mismatch));
    }

    #[test]
    fn a_second_joiner_is_ignored_and_cancel_ends_it() {
        let code = room_code().unwrap();
        let (mut host, commit) = Host::new(&code).unwrap();
        let mut a = Joiner::new(&code, "A").unwrap();
        let mut b = Joiner::new(&code, "B").unwrap();
        let ha = a.hear(&commit).unwrap().unwrap();
        let hb = b.hear(&commit).unwrap().unwrap();
        assert!(host.hear(&ha).unwrap().is_some());
        assert!(host.hear(&hb).unwrap().is_none());
        assert_eq!(host.peer.as_deref(), Some("A"));
        assert_eq!(host.hear(&cancel_msg()), Err(PairError::Cancelled));
        assert!(host.hear("not json").unwrap().is_none());
    }
}
