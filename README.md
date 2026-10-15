# Pluck

Select text anywhere, press **⇧⌘Z**, and get a private, dated task in a side panel — or press **⇧⌘Space** and just type one. Pluck reads your selection with a small AI model that runs on your own Mac, reminds you when things are due, and links each task back to where it came from. Nothing you select ever leaves your computer.

<a href="https://github.com/pillieshwar/pluck/releases/latest/download/Pluck-macOS.dmg"><img src="docs/download-mac.svg" alt="Download Pluck for Mac" width="248" height="52"></a>

macOS 11 Big Sur or later · Apple silicon and Intel · plus one model download (about 2 GB) from inside the app

## Install

1. **Download** — click the button above. `Pluck-macOS.dmg` lands in your Downloads folder.
2. **Install** — open the file and drag **Pluck** into **Applications**.
3. **Open it** — launch Pluck from Applications. If macOS says it can't verify the developer, open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**, then confirm. You only do this once.
4. **Follow the short setup** — on first launch Pluck walks you through it: allow **Accessibility** (how macOS lets an app read the text you've selected), download the recommended model (*Llama 3.2 3B Instruct*, about 2 GB, once), turn on reminders, and try a capture on sample text.

That's it. There's nothing else to install — the model runtime is built into the app, Pluck opens at login, and it updates itself.

## Using Pluck

- **Capture:** select text anywhere (Slack, Mail, a web page, a document) and press **⇧⌘Z**. The panel slides in with a suggested task and due date — including the time ("by Friday 3pm") and repeats ("every Monday").
- **Or use the Services menu:** right-click selected text → **Services → Add to Pluck**. This never touches your clipboard.
- **Quick add:** press **⇧⌘Space** anywhere and type, e.g. `pay rent friday 5pm #home`, `water plants every monday`, `call mom tomorrow 6pm`. Pluck shows how it read the date as you type; **Return** saves.
- **Confirm:** edit the title if you like, pick or change the date, and press **Return**. **Esc** discards. Unclear dates ("next Friday", "soon", or none) — Pluck asks instead of guessing.
- **Today focus:** the **Today** button next to search (or **F**) hides everything except overdue and today's tasks.
- **At a glance:** each task shows a small time chip — red when overdue, amber when due within two hours or snoozed, muted when done.
- **Snooze inline:** hover a task and click the clock (or press **S**) for 15 min · 1 hour · Tonight · Tomorrow · Next week. When a reminder fires, a **Due now** card at the top of the panel and the menu-bar popover has Done and snooze buttons right there.
- **Reminders:** at a task's time (or 9:00 for tasks with only a day — your choice) you get a notification with **Done**, **Snooze 15 min**, **Snooze 1 hour** and **Tomorrow**. Prefer one morning summary? Turn it on in **Settings → Notifications**.
- **Back to the source:** each task remembers the app it came from and, in browsers, Slack and documents, the page or file. Click **Slack ↗** (or the site name) under a task to jump back. Turn this off in **Settings → General**.
- **Today at a glance:** click the Pluck icon in the menu bar for a calendar and today's agenda (overdue first; the icon shows the count). Drag a task onto another day to move it, tick tasks off, or press **+** and type ("dentist fri 3pm"). Right-click the icon for the menu.
- **Your list:** search with **/** or **⌘F**, filter by `#tags`, and click the calendar icon on a task to type a new date in plain words, pick a time with one tap (9 AM, Noon, 3 PM, 6 PM, In 1 hour, or any half hour), or make it repeat. Overdue tasks have a **Move all to today** button. Every change can be undone from the toast or with **⌘Z**.
- **Keyboard:** **↑ ↓** move, **Space** completes, **E** edits, **D** opens the date editor, **T / M / W** move to today / tomorrow / next week, **S** snoozes, **F** toggles Today focus, **O** opens the source, **⌫** deletes. Press **?** for the list.
- **Repeating tasks:** completing one schedules the next. Undo (or untick) removes that next one again.
- **Apple Reminders (optional):** **Settings → Apple Reminders** adds your tasks to a Reminders list and keeps them in sync both ways — titles, due dates and completion; check one off on your iPhone and it's done in Pluck. Off by default. **If the list syncs with iCloud, your tasks leave this Mac** (Pluck shows this warning and asks you to confirm); choose a list stored "On My Mac" to keep everything local. Deleting a task in Pluck deletes its reminder; deleting a reminder only unlinks it.
- **Shortcuts:** the **Settings** tab lets you change the capture shortcut (default **⇧⌘Z**), quick add (**⇧⌘Space**) and add one to show or hide Pluck. Note that ⇧⌘Z is Redo in most apps, so Redo by shortcut won't work while Pluck runs — pick another shortcut if you use it.
- **Models:** menu bar icon → **Models…** to download another model, switch models, or remove one to free space. Already have a GGUF model from Ollama, LM Studio or Hugging Face? Pluck lists the ones it finds, or paste the file's path under **Already have a model?** — no second download. The first capture after a pause takes a few seconds while the model loads; it unloads itself after 5 idle minutes to give the memory back.
- **Your data:** **Settings → Your data** exports everything as CSV or JSON, and lists the daily backups (the last 7 days) with a one-click restore.

**Privacy:** your tasks are stored only on this Mac (`~/Library/Application Support/app.pluck.desktop/`, with daily backups in `backups/`). Pluck uses the internet for two things only: model downloads you start (from Hugging Face, checked against their SHA-256), and checking GitHub for a new version of Pluck (turn this off in **Settings → General**). Notifications are shown by your Mac; nothing is scheduled on a server.

### Updating

From 0.2 on, Pluck updates itself: it downloads new versions in the background, checks their signature, and shows **Restart to update** in the panel, the menu-bar popover and the menu. Your tasks and models are kept. Coming from 0.1.x? Download 0.2 once with the button above and drag it into Applications, replacing the old one.

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
| No reminders appear | **Settings → Notifications** shows whether notifications are allowed; **Open Notification settings** fixes it. **Send a test notification** checks it end to end. |
| "Add to Pluck" isn't in the Services menu | Open Pluck from **Applications** once (macOS registers services for apps there), then log out and in. You can also turn it on in **System Settings → Keyboard → Keyboard Shortcuts → Services → Text**. |
| No "↗" link under captured tasks | Turn on **Settings → General → Remember where tasks came from**. Chrome-based apps expose the page link from their second capture on. |
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
3. **Resolve the date** (`src/lib/dates.ts`, `src/lib/schedule.ts`) — the model only copies the phrase ("by Friday 3pm", "every Monday"); code turns it into a day, time and repeat rule against today's real date. Ambiguous phrases ("next Friday" on a Tuesday, `3/4`) offer both readings and ask. Quick add uses the same reader directly, without the model.
4. **Store** (`crates/pluck-core/src/store.rs`) — SQLite in WAL mode in the app data folder. Due dates are calendar days with an optional local time; creation time is UTC plus your time zone. Completing a repeating task creates the next one (`recurrence.rs`).
5. **Remind** (`src-tauri/src/notifications/`, `crates/pluck-core/src/notify.rs`) — a 15-second scheduler shows a UserNotifications banner when a task is due, with Done / Snooze / Tomorrow actions.

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

Bump `version` in `src-tauri/tauri.conf.json`, `package.json` and `Cargo.toml` and commit. Then either open **Actions → Release → Run workflow** on GitHub (it tags the commit for you), or tag and push yourself:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` builds a universal (Apple silicon + Intel) `.dmg` with the runtime inside and publishes it as a GitHub Release. The Download button always points at the newest release's `Pluck-macOS.dmg`. Add the Apple signing secrets listed in that workflow to ship a notarized app that opens without the Gatekeeper prompt, and `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` so the release also carries the signed `Pluck.app.tar.gz` and `latest.json` that installed copies update from. The matching public key is in `tauri.conf.json → plugins.updater.pubkey`.

### Tests

```bash
cargo test -p pluck-core   # schema, prompt, retry loop, downloads (resume/checksum), clipboard guard, store
npm test                   # date, time and repeat parsing, quick-add parsing, grouping, search and tags
```

CI (`.github/workflows/ci.yml`) runs both, builds the runtime and debug app bundles on macOS and Windows, and checks every model in the catalog still exists on Hugging Face.

## Choices that differ from the study

- **Date parsing** uses a small, purpose-built resolver instead of chrono-node. Deadline phrases need explicit ambiguity reporting (which chrono-node resolves silently), and keeping it dependency-free makes it easy to test across time zones. chrono-node can be added later as a fallback for long-tail phrases.
- **Runtime:** the study planned Ollama for the MVP and a bundled llama-server later; Pluck now ships the bundled runtime directly so users install one app and download models from inside it.
- **SQLite** is accessed from Rust with `rusqlite` rather than `tauri-plugin-sql`, so the webview never gets direct database access and the capability file stays minimal.

## Status

The Rust core and frontend pass CI; the macOS and Windows app bundles build in CI, and releases are signed and notarized. Known gaps: rich-text clipboard contents are restored as plain text; the model isn't unloaded early on battery; reminder times aren't synced to Apple Reminders (days are).

Out of scope, per the privacy boundary: cloud-model fallback and telemetry.

## License

MIT — see [LICENSE](LICENSE).
