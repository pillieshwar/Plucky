//! Sync between one person's Macs, end-to-end encrypted, through a relay
//! that only ever holds sealed boxes.
//!
//! * [`engine`] — finding changes here and merging changes from elsewhere.
//! * [`crypto`] — the group key, sealed boxes and pairing math.
//! * [`relay`] — the relay's HTTP API.
//! * [`pair`] — the pairing conversation, as pure state machines.
//!
//! [`cycle`] does one round: send what changed here, take in what changed
//! elsewhere, and tell the relay what this Mac has.

pub mod b64;
pub mod crypto;
pub mod engine;
pub mod pair;
pub mod relay;

use std::collections::HashSet;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

pub use crypto::GroupKey;
pub use engine::{Applied, Change, Device};
pub use relay::{Relay, RelayError};

use crate::store::{Store, StoreError};

/// The plaintext inside a box.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Payload {
    pub v: u8,
    pub from: String,
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<Change>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Field changes (also how a full copy is sent).
    Changes,
    /// "I missed boxes; someone send me everything."
    Resync,
}

/// The most a sealed box may be (the relay takes up to 256 KB).
pub const BOX_MAX: usize = 250_000;
/// How much JSON goes into one box before compressing.
const BATCH_RAW: usize = 1024 * 1024;
/// The most a box may unpack to.
const UNPACK_MAX: usize = 16 * 1024 * 1024;

/// Compress and seal one payload; split the batch in two if it won't fit.
fn seal_batch(
    key: &GroupKey,
    from: &str,
    kind: Kind,
    batch: &[Change],
    out: &mut Vec<Vec<u8>>,
) -> Result<(), crypto::CryptoError> {
    let p = Payload {
        v: 1,
        from: from.to_string(),
        kind,
        changes: batch.to_vec(),
    };
    let z = miniz_oxide::deflate::compress_to_vec(&serde_json::to_vec(&p).unwrap_or_default(), 6);
    if z.len() + 64 > BOX_MAX {
        if batch.len() > 1 {
            let (a, b) = batch.split_at(batch.len() / 2);
            seal_batch(key, from, kind, a, out)?;
            return seal_batch(key, from, kind, b, out);
        }
        log::warn!(
            "sync: skipping one field too big to send ({} KB)",
            z.len() / 1024
        );
        return Ok(());
    }
    out.push(key.seal(&z)?);
    Ok(())
}

/// Seal `changes` into as many boxes as they need.
pub fn pack(
    key: &GroupKey,
    from: &str,
    changes: &[Change],
) -> Result<Vec<Vec<u8>>, crypto::CryptoError> {
    let mut boxes = Vec::new();
    let mut start = 0;
    let mut size = 0;
    for (i, c) in changes.iter().enumerate() {
        let n = serde_json::to_vec(c).map(|v| v.len()).unwrap_or(0) + 1;
        if size + n > BATCH_RAW && i > start {
            seal_batch(key, from, Kind::Changes, &changes[start..i], &mut boxes)?;
            start = i;
            size = 0;
        }
        size += n;
    }
    if start < changes.len() {
        seal_batch(key, from, Kind::Changes, &changes[start..], &mut boxes)?;
    }
    Ok(boxes)
}

/// A box asking the others for a full copy.
pub fn resync_box(key: &GroupKey, from: &str) -> Result<Vec<u8>, crypto::CryptoError> {
    let mut out = Vec::new();
    seal_batch(key, from, Kind::Resync, &[], &mut out)?;
    out.pop().ok_or(crypto::CryptoError::Random)
}

pub fn unpack(key: &GroupKey, data: &[u8]) -> Option<Payload> {
    let z = key.open(data).ok()?;
    let plain = miniz_oxide::inflate::decompress_to_vec_with_limit(&z, UNPACK_MAX).ok()?;
    serde_json::from_slice(&plain).ok()
}

/// Ask the others for a full copy (after restoring a backup, say).
pub async fn ask_resync(relay: &Relay, me: &Membership) -> Result<(), SyncError> {
    relay
        .put(
            &me.key.mailbox_id(),
            &me.key.mailbox_token(),
            resync_box(&me.key, &me.device)?,
        )
        .await?;
    Ok(())
}

/// This Mac's place in a group.
#[derive(Debug, Clone)]
pub struct Membership {
    pub key: GroupKey,
    pub device: String,
    pub name: String,
    /// Projects that stay on this Mac.
    pub local_only: HashSet<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error(transparent)]
    Relay(#[from] RelayError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Crypto(#[from] crypto::CryptoError),
    #[error("the task database is busy")]
    Lock,
}

/// What one round did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub sent: usize,
    pub received: usize,
    /// Tasks, projects or headings that changed here.
    pub changed: usize,
    /// Asked the others for a full copy (this Mac had missed boxes).
    pub asked_resync: bool,
    /// Sent a full copy to a Mac that asked.
    pub sent_snapshot: bool,
    /// Another Mac removed this one from the group.
    pub removed: bool,
    /// Macs heard from in this round.
    pub heard: Vec<String>,
    /// When each Mac last checked in with the relay (Unix milliseconds).
    pub seen: Vec<(String, i64)>,
}

fn locked(store: &Mutex<Store>) -> Result<std::sync::MutexGuard<'_, Store>, SyncError> {
    store.lock().map_err(|_| SyncError::Lock)
}

/// One round of sync. The store is locked only for local work, never across
/// a network call.
pub async fn cycle(
    relay: &Relay,
    me: &Membership,
    store: &Mutex<Store>,
) -> Result<Report, SyncError> {
    let mailbox = me.key.mailbox_id();
    let token = me.key.mailbox_token();
    let mut report = Report::default();

    // 1. Send what changed here.
    loop {
        let pending = {
            let s = locked(store)?;
            s.sync_collect(&me.device, &me.name, &me.local_only)?;
            s.sync_pending(4000)?
        };
        if pending.is_empty() {
            break;
        }
        for b in pack(&me.key, &me.device, &pending)? {
            relay.put(&mailbox, &token, b).await?;
        }
        locked(store)?.sync_mark_sent(&pending)?;
        report.sent += pending.len();
        if pending.len() < 4000 {
            break;
        }
    }

    // 2. Take in what changed elsewhere.
    let mut cursor = locked(store)?.sync_cursor()?;
    let start = cursor;
    let mut someone_asked = false;
    for _ in 0..50 {
        let page = relay.list(&mailbox, &token, cursor).await?;
        report.seen.clone_from(&page.devices);
        if page.gap && !report.asked_resync {
            relay
                .put(&mailbox, &token, resync_box(&me.key, &me.device)?)
                .await?;
            report.asked_resync = true;
        }
        for b in &page.boxes {
            cursor = cursor.max(b.n);
            if b.from == me.device {
                continue;
            }
            let Some(p) = unpack(&me.key, &b.data) else {
                log::warn!("sync: a box couldn't be opened; skipping it");
                continue;
            };
            if p.from == me.device {
                continue;
            }
            if !report.heard.contains(&p.from) {
                report.heard.push(p.from.clone());
            }
            match p.kind {
                Kind::Resync => someone_asked = true,
                Kind::Changes => {
                    let s = locked(store)?;
                    // Record edits made here first, so writing the incoming
                    // ones can't overwrite them.
                    s.sync_collect(&me.device, &me.name, &me.local_only)?;
                    let a = s.sync_apply(&me.device, &p.changes)?;
                    report.received += a.fields;
                    report.changed += a.things;
                    report.removed |= a.removed_here;
                }
            }
        }
        if page.boxes.is_empty() && page.latest > cursor && page.gap {
            // Everything we hadn't read is gone: start from the newest.
            cursor = page.latest;
        }
        locked(store)?.set_sync_cursor(cursor)?;
        if !page.more {
            break;
        }
    }
    if cursor > start {
        relay.ack(&mailbox, &token, cursor).await?;
    }

    // 3. Someone missed boxes: send them everything we know.
    if someone_asked {
        let all = locked(store)?.sync_snapshot()?;
        for b in pack(&me.key, &me.device, &all)? {
            relay.put(&mailbox, &token, b).await?;
        }
        report.sent_snapshot = true;
    }
    // Changes we just made by applying are already in the shadow; anything
    // pending now is new local work and goes next round.
    Ok(report)
}

/// Send everything this Mac knows, for a Mac that's joining.
pub async fn send_snapshot(
    relay: &Relay,
    me: &Membership,
    store: &Mutex<Store>,
) -> Result<(), SyncError> {
    let all = {
        let s = locked(store)?;
        s.sync_collect(&me.device, &me.name, &me.local_only)?;
        s.sync_snapshot()?
    };
    let (mailbox, token) = (me.key.mailbox_id(), me.key.mailbox_token());
    for b in pack(&me.key, &me.device, &all)? {
        relay.put(&mailbox, &token, b).await?;
    }
    // A snapshot carries everything pending too.
    locked(store)?.sync_mark_sent(&all)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Text that barely compresses, like real notes in bulk.
    fn noise(n: usize, seed: u64) -> String {
        let mut x = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (0..n)
            .map(|_| {
                x = x
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
                    [(x >> 58) as usize] as char
            })
            .collect()
    }

    fn change(i: usize, text: String) -> Change {
        Change {
            entity: format!("t:{i}"),
            field: "notes".into(),
            value: serde_json::Value::from(text),
            hlc: format!("{:013}-000000-A", i),
        }
    }

    #[test]
    fn pack_compresses_splits_and_unpacks() {
        let key = GroupKey::generate().unwrap();
        // Repetitive text shrinks a lot: many fields in one box.
        let plain: Vec<Change> = (0..300)
            .map(|i| change(i, "Call Maya about the offsite ".repeat(20)))
            .collect();
        assert_eq!(pack(&key, "A", &plain).unwrap().len(), 1);

        let changes: Vec<Change> = (0..40)
            .map(|i| change(i, noise(20_000, i as u64)))
            .collect();
        let boxes = pack(&key, "A", &changes).unwrap();
        assert!(boxes.len() >= 3, "{}", boxes.len());
        assert!(boxes.iter().all(|b| b.len() <= BOX_MAX));
        let back: Vec<Change> = boxes
            .iter()
            .flat_map(|b| unpack(&key, b).unwrap().changes)
            .collect();
        assert_eq!(back, changes);
        // Another group's key can't read them.
        assert!(unpack(&GroupKey::generate().unwrap(), &boxes[0]).is_none());
        // Far too big for one box: left out rather than stopping everything.
        let huge = pack(
            &key,
            "A",
            &[change(1, noise(400_000, 9)), change(2, "x".into())],
        )
        .unwrap();
        assert_eq!(huge.len(), 1);
        assert_eq!(unpack(&key, &huge[0]).unwrap().changes.len(), 1);
    }

    #[test]
    fn resync_requests_round_trip() {
        let key = GroupKey::generate().unwrap();
        let p = unpack(&key, &resync_box(&key, "B").unwrap()).unwrap();
        assert_eq!((p.kind, p.from.as_str()), (Kind::Resync, "B"));
    }
}
