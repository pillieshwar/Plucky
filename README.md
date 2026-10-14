# Pluck

Select text anywhere, press **⇧⌘Z**, and get a private, dated task in a side panel. Pluck reads your selection with a small AI model that runs on your own Mac — nothing you select ever leaves your computer.

<a href="https://github.com/pillieshwar/pluck/releases/latest/download/Pluck-macOS.dmg"><img src="docs/download-mac.svg" alt="Download Pluck for Mac" width="248" height="52"></a>

macOS 11 Big Sur or later · Apple silicon and Intel · plus one model download (about 2 GB) from inside the app

## Install

1. **Download** — click the button above. `Pluck-macOS.dmg` lands in your Downloads folder.
2. **Install** — open the file and drag **Pluck** into **Applications**.
3. **Open it** — launch Pluck from Applications. If macOS says it can't verify the developer, open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**, then confirm. You only do this once.
4. **Get a model** — on first launch Pluck's panel opens on the **Models** tab. Click **Download** on *Llama 3.2 3B Instruct* (recommended). It downloads once (about 2 GB) and can be paused and resumed.
5. **Allow Accessibility** — select some text in any app and press **⇧⌘Z**. When asked, click **Grant access** and switch on **Pluck** in **System Settings → Privacy & Security → Accessibility**. This is how macOS lets an app read the text you've selected.

That's it. There's nothing else to install — the model runtime is built into the app.

## Using Pluck

- **Capture:** select text anywhere (Slack, Mail, a web page, a document) and press **⇧⌘Z**. The panel slides in on the right with a suggested task and due date.
- **Confirm:** edit the title if you like, pick or change the date, and press **Return**. **Esc** discards it.
- **Unclear dates** ("next Friday", "soon", or no date) — Pluck asks instead of guessing.
- **Today at a glance:** click the Pluck icon in the menu bar for a calendar and today's agenda (overdue first; the icon shows the count). Pick any day to see what's due, tick tasks off, or press **+** to add one. The arrow under the calendar expands it to the whole month. Right-click the icon for the menu.
- **Apple Reminders (optional):** **Settings → Apple Reminders** adds your tasks to a Reminders list and keeps them in sync both ways — titles, due dates and completion; check one off on your iPhone and it's done in Pluck. Off by default. **If the list syncs with iCloud, your tasks leave this Mac** (Pluck shows this warning and asks you to confirm); choose a list stored "On My Mac" to keep everything local. Deleting a task in Pluck deletes its reminder; deleting a reminder only unlinks it.
- **Your list:** menu bar icon → **Open Pluck**. Tick to complete, double-click to rename, hover to change the date or delete. **Esc** hides the panel.
- **Shortcuts:** the **Settings** tab lets you change the capture shortcut (default **⇧⌘Z**) and add one to show or hide Pluck. Note that ⇧⌘Z is Redo in most apps, so Redo by shortcut won't work while Pluck runs — pick another shortcut if you use it.
- **Models:** menu bar icon → **Models…** to download another model, switch models, or remove one to free space. Already have a GGUF model from Ollama, LM Studio or Hugging Face? Pluck lists the ones it finds, or paste the file's path under **Already have a model?** — no second download. The first capture after a pause takes a few seconds while the model loads; it unloads itself after 5 idle minutes to give the memory back.
- **Start at login (optional):** System Settings → General → Login Items → **+** → Pluck.

**Privacy:** your tasks are stored only on this Mac (`~/Library/Application Support/app.pluck.desktop/`). The only time Pluck uses the internet is when you press **Download** in the Models tab; model files come from Hugging Face and are checked against their published SHA-256 checksum.

### Updating

Download the latest version with the same button and drag it into Applications, replacing the old one. Your tasks and models are kept. If captures stop working afterwards, see the Accessibility tip below.

### Uninstalling

Quit Pluck from its menu-bar icon, drag it from Applications to the Bin, and remove it from **Privacy & Security → Accessibility**. To also delete your tasks and downloaded models:

```bash
rm -rf ~/Library/Application\ Support/app.pluck.desktop
```

### Troubleshooting

| What you see | What to do |
| --- | --- |
| "Pluck is damaged and can't be opened" | The download was interrupted or altered. Delete it and download again. |
| "Apple could not verify Pluck…" | Expected for this early build. Use **Privacy & Security → Open Anyway** (step 3 above). |
| ⇧⌘Z does nothing | Check the Pluck icon is in the menu bar. Another app may also use ⇧⌘Z — choose a different shortcut in Pluck's **Settings** tab. |
| "No selected text found" | Select the text again and press ⇧⌘Z. Password fields and some secure apps can't be read, by design. |
| Something else went wrong | **Settings → Show log file** opens Pluck's log (`~/Library/Logs/Pluck/pluck.log`). It stays on your Mac; attach it to a bug report. |
| Accessibility is asked for again after an update | In **Privacy & Security → Accessibility**, remove Pluck with **–**, then capture again and re-grant. |
| A model download failed | Click **Resume download** in the Models tab — it continues where it stopped. |
| "The model took too long to load" | Close some memory-heavy apps, or switch to *Llama 3.2 1B* in the Models tab. |

## How a capture works

```
shortcut released ─▶ capture selection ─▶ show panel ─▶ extract (127.0.0.1) ─▶ resolve date ─▶ confirm ─▶ SQLite
                     AX / UIA first,                     JSON-schema-          deterministic,    ask when
                     guarded clipboard second            constrained, retry×1  real local date   unclear
```

1. **Capture** (`src-tauri/src/capture/`) — reads the selection through macOS Accessibility (`AXSelectedText`) or Windows UI Automation (`TextPattern`). If that fails, it synthesizes Copy, reads the text, and restores your clipboard only if its change counter proves nothing else wrote to it in between. It refuses to touch a clipboard holding images or files.
2. **Extract** (`src-tauri/src/engine.rs`, `crates/pluck-core/src/llm.rs`) — the bundled llama.cpp `llama-server` is started on demand on a random 127.0.0.1 port with a random API key, and gets one request with a 3-field JSON Schema (`task`, `date_text`, `date_confidence`), temperature 0. Output is validated in Rust; one repair retry, then the panel falls back to a manual edit state. Clients refuse any non-loopback URL. The server stops after 5 idle minutes.
3. **Resolve the date** (`src/lib/dates.ts`) — the model only copies the phrase ("by Friday"); code turns it into a day against today's real date. Ambiguous phrases ("next Friday" on a Tuesday, `3/4`) offer both readings and ask.
4. **Store** (`crates/pluck-core/src/store.rs`) — SQLite in WAL mode in the app data folder. Due dates are calendar days; creation time is UTC plus your time zone.

Selected text is treated as untrusted: instructions stay in the system prompt, the selection is wrapped and sanitized as data, and the schema means an injection can at worst produce an odd task title.

## Layout

```
crates/pluck-core/   Platform-independent Rust: schema, prompt, model clients, model catalog + verified downloads,
                     clipboard guard, SQLite store (unit-tested)
src-tauri/           Tauri v2 shell: tray, shortcut, docked panel, OS capture, llama-server engine, model manager
src/                 React/TypeScript panel (Tasks and Models tabs); src/lib holds date logic and grouping (unit-tested)
scripts/             build-llama-server.sh builds the bundled runtime from llama.cpp source
```

## Building from source

Prerequisites: Rust (stable), Node 20+, CMake, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS (on macOS: `xcode-select --install`).

```bash
npm install
scripts/build-llama-server.sh      # builds the bundled runtime once (a few minutes)
npm run tauri dev                  # run in development
npm run tauri build                # produce Pluck.app and a .dmg in target/release/bundle/
```

During `tauri dev`, macOS grants Accessibility permission to your terminal app, not to Pluck. Models downloaded in the Models tab go to the same app-data folder as the installed app.

Developer option: set `PLUCK_OLLAMA_URL=http://127.0.0.1:11434` (and optionally `PLUCK_MODEL`) to use an existing Ollama instead of the bundled runtime.

### Releasing

Bump `version` in `src-tauri/tauri.conf.json` and commit. Then either open **Actions → Release → Run workflow** on GitHub (it tags the commit for you), or tag and push yourself:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` builds a universal (Apple silicon + Intel) `.dmg` with the runtime inside and publishes it as a GitHub Release. The Download button always points at the newest release's `Pluck-macOS.dmg`. Add the Apple signing secrets listed in that workflow to ship a notarized app that opens without the Gatekeeper prompt.

### Tests

```bash
cargo test -p pluck-core   # schema, prompt, retry loop, downloads (resume/checksum), clipboard guard, store
npm test                   # date resolution, day grouping, formatting
```

CI (`.github/workflows/ci.yml`) runs both, builds the runtime and debug app bundles on macOS and Windows, and checks every model in the catalog still exists on Hugging Face.

## Choices that differ from the study

- **Date parsing** uses a small, purpose-built resolver instead of chrono-node. Deadline phrases need explicit ambiguity reporting (which chrono-node resolves silently), and keeping it dependency-free makes it easy to test across time zones. chrono-node can be added later as a fallback for long-tail phrases.
- **Runtime:** the study planned Ollama for the MVP and a bundled llama-server later; Pluck now ships the bundled runtime directly so users install one app and download models from inside it.
- **SQLite** is accessed from Rust with `rusqlite` rather than `tauri-plugin-sql`, so the webview never gets direct database access and the capability file stays minimal.

## Status

Early build. The Rust core and frontend pass CI; the macOS app builds in CI. The bundled runtime was tested end to end with the app's exact launch flags and request format. Still to do: the Phase 1 "capture spike" on real hardware (Slack, a browser, an editor, a terminal), Developer ID signing so the app opens without the Gatekeeper prompt, and real icons (`npx tauri icon` regenerates them). Known gaps: rich-text clipboard contents are restored as plain text; the model isn't unloaded early on battery.

Out of scope for the MVP, per the privacy boundary: cloud-model fallback, telemetry, calendar sync, auto-update.

## License

MIT — see [LICENSE](LICENSE).
