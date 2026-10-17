//! Score a model on watch mode: does it find the real to-dos in new
//! messages, and stay quiet on everything else?
//!
//!   cargo run -p pluck-core --example watch_eval -- \
//!       http://127.0.0.1:8080 <api-key> scripts/eval/watch-cases.json "Model name"
//!
//! Prints one line per case and a JSON summary as the last line. Run by
//! .github/workflows/model-eval.yml against llama-server.

use std::time::{Duration, Instant};

use pluck_core::{find_actions, LlamaServerClient};
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    app: String,
    text: String,
    /// How many to-dos a careful person would add (0 = none).
    expect: usize,
    /// A word the main to-do should mention.
    #[serde(default)]
    keyword: Option<String>,
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        eprintln!("usage: watch_eval <url> <api-key> <cases.json> <model name>");
        std::process::exit(2);
    }
    let client = LlamaServerClient::new(&args[1], args[2].clone(), Duration::from_secs(180))
        .expect("loopback URL");
    let cases: Vec<Case> =
        serde_json::from_slice(&std::fs::read(&args[3]).expect("read cases")).expect("parse cases");
    let model = &args[4];

    let (mut right, mut false_alarms, mut missed, mut wrong_task, mut errors) = (0, 0, 0, 0, 0);
    let mut total_ms = 0u128;
    for (i, c) in cases.iter().enumerate() {
        let start = Instant::now();
        let result = find_actions(&client, &c.app, &c.text).await;
        let ms = start.elapsed().as_millis();
        total_ms += ms;
        let verdict = match &result {
            Err(e) => {
                errors += 1;
                format!("ERROR {e}")
            }
            Ok(found) if c.expect == 0 && found.is_empty() => {
                right += 1;
                "ok (none)".into()
            }
            Ok(found) if c.expect == 0 => {
                false_alarms += 1;
                format!("FALSE ALARM: {}", found[0].task)
            }
            Ok(found) if found.is_empty() => {
                missed += 1;
                "MISSED".into()
            }
            Ok(found) => {
                let hit = c.keyword.as_deref().map_or(true, |k| {
                    found
                        .iter()
                        .any(|f| f.task.to_lowercase().contains(&k.to_lowercase()))
                });
                if hit {
                    right += 1;
                    format!("ok: {}", found[0].task)
                } else {
                    wrong_task += 1;
                    format!("WRONG TASK: {}", found[0].task)
                }
            }
        };
        println!("{:>3} {:>6}ms  {}", i + 1, ms, verdict);
    }
    let n = cases.len().max(1);
    println!(
        "{}",
        serde_json::json!({
            "model": model,
            "cases": cases.len(),
            "accuracy": (right as f64) / (n as f64),
            "false_alarms": false_alarms,
            "missed": missed,
            "wrong_task": wrong_task,
            "errors": errors,
            "avg_ms": total_ms / n as u128,
        })
    );
}
