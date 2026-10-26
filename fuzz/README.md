# Fuzz tests

[cargo-fuzz](https://github.com/rust-fuzz/cargo-fuzz) targets for everything in `todocity-core` that reads input Todo City doesn't control:

| Target | What it feeds |
|---|---|
| `model_output` | Text from the local model, parsed into tasks |
| `todoist_csv` | Todoist CSV exports and repeat phrases |
| `sync_boxes` | Base64 and sealed boxes from the sync relay |
| `sync_merge` | Changes from another Mac, merged into the task database |
| `pairing` | Messages in a pairing room |

They run for a few minutes on every pull request that touches the core, and longer every week (`.github/workflows/fuzz.yml`). To run one yourself:

```bash
cargo install cargo-fuzz
cargo +nightly fuzz run sync_merge
```
