//! Changes from another Mac, as they'd arrive after unsealing: merging any of
//! them must never panic or break the database, and taking the same changes
//! twice must change nothing the second time.
#![no_main]

use std::collections::HashSet;

use libfuzzer_sys::fuzz_target;
use todocity_core::sync::Change;
use todocity_core::{NewTask, Store};

fuzz_target!(|data: &[u8]| {
    let Ok(changes) = serde_json::from_slice::<Vec<Change>>(data) else {
        return;
    };
    let store = Store::open_in_memory().expect("in-memory store");
    store
        .insert(NewTask {
            title: "Already here".into(),
            project: Some("Home".into()),
            ..Default::default()
        })
        .expect("insert");
    let none = HashSet::new();
    store.sync_collect("me", "Mac", &none).expect("collect");
    store.sync_apply("me", &changes).expect("apply");
    let again = store.sync_apply("me", &changes).expect("apply again");
    assert_eq!(again.fields, 0);
    // The store still reads, and comparing again still works.
    store.all().expect("read tasks");
    store
        .sync_collect("me", "Mac", &none)
        .expect("collect again");
    let _ = store.sync_devices().expect("devices");
});
