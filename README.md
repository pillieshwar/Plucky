# Pluck

Select text anywhere, press **⌘⇧T** (macOS) or **Ctrl+Shift+T** (Windows), and get a private, dated task in a day-grouped side panel. Extraction runs on a small model on your own computer; nothing leaves the machine.

This is the Phase 2 MVP from the feasibility study ("Text-to-Task Desktop App — Research", 13 Oct 2026): a Tauri v2 tray app with a Rust backend, a React/TypeScript panel, Ollama for local inference and SQLite for storage.

## How a capture works

```
shortcut released ─▶ capture selection ─▶ show panel ─▶ extract (127.0.0.1) ─▶ resolve date ─▶ confirm ─▶ SQLite
                     AX / UIA first,                     JSON-schema-          deterministic,    ask when
                     guarded clipboard second            constrained, retry×1  real local date   unclear
```

1. **Capture** (`src-tauri/src/capture/`) — reads the selection through macOS Accessibility (`AXSelectedText`) or Windows UI Automation (`TextPattern`). If that fails, it synthesizes Copy, reads the text, and restores your clipboard only if its change counter proves nothing else wrote to it in between. It refuses to touch a clipboard holding images or files.
2. **Extract** (`crates/pluck-core/src/llm.rs`) — one request to Ollama on localhost with a 3-field JSON Schema (`task`, `date_text`, `date_confidence`), temperature 0. Output is validated in Rust; one repair retry, then the panel falls back to a manual edit state. The client refuses any non-loopback URL.
3. **Resolve the date** (`src/lib/dates.ts`) — the model only copies the phrase ("by Friday"); code turns it into a day against today's real date. Ambiguous phrases ("next Friday" on a Tuesday, `3/4`) offer both readings and ask.
4. **Store** (`crates/pluck-core/src/store.rs`) — SQLite in WAL mode in the app data folder. Due dates are calendar days; creation time is UTC plus your time zone.

Selected text is treated as untrusted: instructions stay in the system prompt, the selection is wrapped and sanitized as data, and the schema means an injection can at worst produce an odd task title.

## Layout

```
crates/pluck-core/   Platform-independent Rust: schema, prompt, Ollama client, clipboard guard, SQLite store (unit-tested)
src-tauri/           Tauri v2 shell: tray, global shortcut, docked panel, OS capture code, commands
src/                 React/TypeScript panel; src/lib holds date resolution and grouping (unit-tested)
```

## Running it

Prerequisites: Rust (stable), Node 20+, [Ollama](https://ollama.com), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
ollama pull llama3.2:3b          # or: qwen3:4b-instruct  (then set PLUCK_MODEL)
npm install
npm run tauri dev
```

On macOS, the first capture asks for **Accessibility** permission (System Settings → Privacy & Security → Accessibility). During `tauri dev` the permission is granted to your terminal app, not to Pluck.

Optional environment variables: `PLUCK_MODEL` (default `llama3.2:3b`), `PLUCK_OLLAMA_URL` (default `http://127.0.0.1:11434`, must be loopback).

### Tests

```bash
cargo test -p pluck-core   # schema, prompt sanitizing, retry loop, clipboard guard, store
npm test                   # date resolution and day grouping
```

CI (`.github/workflows/ci.yml`) runs both, then builds unsigned debug bundles on macOS and Windows.

## Choices that differ from the study

- **Date parsing** uses a small, purpose-built resolver instead of chrono-node. Deadline phrases need explicit ambiguity reporting (which chrono-node resolves silently), and keeping it dependency-free makes it easy to test across time zones. chrono-node can be added later as a fallback for long-tail phrases.
- **SQLite** is accessed from Rust with `rusqlite` rather than `tauri-plugin-sql`, so the webview never gets direct database access and the capability file stays minimal.

## Status

The initial code was written in a sandbox without access to crates.io or npm. The TypeScript date and grouping tests (27) were run there and pass in several time zones; the Rust code, including its unit tests, has **not been compiled yet** — the first CI run is its first build, so expect a round of small fixes. The Tauri shell and the macOS/Windows capture code then need the Phase 1 "capture spike" on real hardware (Slack, a browser, an editor, a terminal). Known gaps: rich-text clipboard contents are restored as plain text; the model isn't yet unloaded on battery; icons are placeholders (`npx tauri icon` regenerates them).

Out of scope for the MVP, per the privacy boundary: cloud-model fallback, telemetry, calendar sync, auto-update.
