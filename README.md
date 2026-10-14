# Pluck

Select text anywhere, press **⌘⇧T** (macOS) or **Ctrl+Shift+T** (Windows), and get a private, dated task in a day-grouped side panel. Extraction runs on a small model on your own computer; nothing leaves the machine.

This is the Phase 2 MVP from the feasibility study ("Text-to-Task Desktop App — Research", 13 Oct 2026): a Tauri v2 tray app with a Rust backend, a React/TypeScript panel, Ollama for local inference and SQLite for storage.

## Install on a Mac

> **Early build.** There's no signed download yet, so for now you build Pluck once on your Mac (about 10 minutes, mostly waiting). Requires macOS 11 Big Sur or later; Apple silicon or Intel.

### 1. Install the local model (Ollama)

Pluck reads your selections with a small AI model that runs on your Mac. [Ollama](https://ollama.com) runs that model.

1. Download Ollama from [ollama.com/download](https://ollama.com/download), open it, and drag it to **Applications**. Open it once; a llama icon appears in your menu bar.
2. Open **Terminal** (⌘Space, type "Terminal") and download the model Pluck uses (about 2 GB, one time):

   ```bash
   ollama pull llama3.2:3b
   ```

Keep Ollama running in the menu bar whenever you use Pluck. It only loads the model when you capture something and unloads it after 5 idle minutes.

### 2. Install the build tools (one time)

Paste each line into Terminal:

```bash
# Apple's command-line developer tools (a dialog opens — click Install)
xcode-select --install

# Rust (press Enter to accept the defaults), then load it into this Terminal window
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

Then install **Node.js 20 or newer** with the macOS installer from [nodejs.org](https://nodejs.org) (choose the LTS version). If you use Homebrew, `brew install node` works too.

Check everything is in place — each command should print a version number:

```bash
cargo --version && node --version && ollama --version
```

### 3. Build Pluck

```bash
git clone https://github.com/pillieshwar/pluck.git
cd pluck
npm install
npm run tauri build
```

The first build downloads and compiles a lot of code; 5–10 minutes is normal. When it finishes, it prints the path of a disk image, something like `target/release/bundle/dmg/Pluck_0.1.0_aarch64.dmg`. Open it:

```bash
open target/release/bundle/dmg/*.dmg
```

Drag **Pluck** into **Applications**, then eject the disk image.

### 4. First launch

1. Open **Pluck** from Applications. Because this build isn't signed by an Apple developer account, macOS will block it the first time ("Apple could not verify…"). Click **Done** (or **Cancel**), then go to **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to the Pluck message. Confirm with your password. You only do this once.
2. Pluck has no Dock icon. Look for its icon in the **menu bar** (top right of the screen).
3. **Grant Accessibility access.** Select some text in any app and press **⌘⇧T**. Pluck will ask for Accessibility permission — this is how macOS lets an app read the text you've selected. Click **Grant access**, then in **System Settings → Privacy & Security → Accessibility**, turn on **Pluck**. Press ⌘⇧T again.

### 5. Using it

- **Capture:** select text anywhere (Slack, Mail, a web page, a document) and press **⌘⇧T**. The panel slides in on the right with a suggested task and due date.
- **Confirm:** edit the title if you like, pick or change the date, and press **Return** to add it. **Esc** discards it.
- **If the date is unclear** ("next Friday", "soon", or no date at all), Pluck asks you to choose instead of guessing.
- **Open the list any time:** click the menu-bar icon → **Show tasks**. Tick a task to complete it; double-click a title to rename it; hover a task to change its date or delete it. Press **Esc** to hide the panel.
- **Start at login (optional):** System Settings → General → Login Items → click **+** and choose Pluck.

Your tasks are stored only on this Mac, in `~/Library/Application Support/app.pluck.desktop/tasks.db`.

### Updating

```bash
cd pluck
git pull
npm install
npm run tauri build
```

Then drag the new Pluck from the disk image into Applications, replacing the old one. Your tasks are kept. macOS may ask for Accessibility permission again (see troubleshooting below).

### Uninstalling

Quit Pluck from its menu-bar icon, delete it from Applications, and remove it from System Settings → Privacy & Security → Accessibility. To delete your tasks too:

```bash
rm -rf ~/Library/Application\ Support/app.pluck.desktop
```

### Troubleshooting

| What you see | What to do |
| --- | --- |
| "Local model isn't reachable" banner | Make sure Ollama is running (llama icon in the menu bar) and that you ran `ollama pull llama3.2:3b`. Then click **Retry**. |
| ⌘⇧T does nothing | Check Pluck's icon is in the menu bar. Another app may already use ⌘⇧T (some browsers reopen closed tabs with it) — quit that app or try in a different one. |
| "No selected text found" | Select the text again and press ⌘⇧T. Password fields and some secure apps can't be read by design. |
| Permission keeps being requested after an update | Unsigned rebuilds look like a new app to macOS. In **Privacy & Security → Accessibility**, select Pluck, remove it with **–**, then add it back with **+** (or capture again and re-grant). |
| The first capture after a while is slow | The model is loading into memory (a few seconds). Captures right after are fast. |
| Build fails with "xcrun: error" | Run `xcode-select --install` again and retry the build. |

Pluck uses the `llama3.2:3b` model. To try a different one (for example `qwen3:4b-instruct`), pull it with Ollama and launch Pluck from Terminal with `open --env PLUCK_MODEL=qwen3:4b-instruct -a Pluck` (quit Pluck first). Apps opened from Finder or at login don't get this setting, so they use the default model.

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

## License

MIT — see [LICENSE](LICENSE).
