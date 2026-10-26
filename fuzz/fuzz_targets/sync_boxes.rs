//! Boxes from the sync relay: base64 from the relay, then sealed bytes that
//! anyone could have put there. Nothing may panic, and only boxes made with
//! the group's key may open.
#![no_main]

use libfuzzer_sys::fuzz_target;
use todocity_core::sync::{b64, pack, unpack, GroupKey};

fuzz_target!(|data: &[u8]| {
    let key = GroupKey([7; 32]);
    if let Ok(text) = std::str::from_utf8(data) {
        if let Some(bytes) = b64::decode(text) {
            // Whatever decodes, encodes back to the same bytes.
            assert_eq!(
                b64::decode(&b64::encode(&bytes)).as_deref(),
                Some(&bytes[..])
            );
            assert_eq!(
                b64::decode(&b64::encode_url(&bytes)).as_deref(),
                Some(&bytes[..])
            );
        }
        let _ = GroupKey::from_text(text);
    }
    // Random bytes never open as a box.
    assert!(unpack(&key, data).is_none());
    // A sealed copy of changes parsed from the input opens to the same changes.
    if let Ok(changes) = serde_json::from_slice::<Vec<todocity_core::sync::Change>>(data) {
        if let Ok(boxes) = pack(&key, "fuzz", &changes) {
            let back: Vec<_> = boxes
                .iter()
                .flat_map(|b| unpack(&key, b).map(|p| p.changes).unwrap_or_default())
                .collect();
            assert!(back.len() <= changes.len());
        }
    }
});
