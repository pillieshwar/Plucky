//! Messages in a pairing room can come from anyone who knows (or guesses)
//! the code. Neither side may panic on any of them.
#![no_main]

use libfuzzer_sys::fuzz_target;
use todocity_core::sync::crypto::clean_code;
use todocity_core::sync::pair::{Host, Joiner};

fuzz_target!(|data: &[u8]| {
    let text = String::from_utf8_lossy(data);
    let _ = clean_code(&text);
    let (mut host, commit) = Host::new("K7MX4QRB").expect("host");
    let mut join = Joiner::new("K7MX4QRB", "fuzz").expect("joiner");
    let _ = join.hear(&commit);
    for msg in text.split('\n') {
        let _ = host.hear(msg);
        let _ = join.hear(msg);
    }
    let _ = join.invite();
    let _ = host.sas();
});
