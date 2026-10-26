//! Todoist CSV exports come from a file the person picks: any bytes at all.
#![no_main]

use libfuzzer_sys::fuzz_target;
use todocity_core::todoist::{read_csv, repeat_rule};

fuzz_target!(|data: &[u8]| {
    let text = String::from_utf8_lossy(data).into_owned();
    // A repeat phrase from the first line, and the whole thing as a file.
    let _ = repeat_rule(text.lines().next().unwrap_or(""));
    let _ = read_csv(&[("Project.csv".to_string(), text)]);
});
