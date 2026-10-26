//! What the local model writes back is untrusted text: parsing and checking
//! it must never panic, whatever it says.
#![no_main]

use libfuzzer_sys::fuzz_target;
use todocity_core::extraction::{parse_actions, Extraction};

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    if let Ok(e) = Extraction::parse(text) {
        let _ = e.validate();
    }
    let _ = parse_actions(text);
});
