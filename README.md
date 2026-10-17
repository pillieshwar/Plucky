<div align="center">

<img src="docs/logo.svg" alt="" width="88" height="88">

# Plucky

**Turn any text you select into a dated task — privately, on your Mac.**

Select a message, an email or a web page, press <kbd>⇧⌘S</kbd>, and Plucky writes the to-do, finds the due date and reminds you on time.<br>
A small AI model runs entirely on your own computer, so nothing you select ever leaves it.

[![Latest release](https://img.shields.io/github/v/release/pillieshwar/Plucky?label=release&color=0f7168)](https://github.com/pillieshwar/Plucky/releases/latest)
[![CI](https://github.com/pillieshwar/Plucky/actions/workflows/ci.yml/badge.svg)](https://github.com/pillieshwar/Plucky/actions/workflows/ci.yml)
[![Security](https://github.com/pillieshwar/Plucky/actions/workflows/security.yml/badge.svg)](https://github.com/pillieshwar/Plucky/actions/workflows/security.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/pillieshwar/Plucky/badge)](https://scorecard.dev/viewer/?uri=github.com/pillieshwar/Plucky)
[![macOS 11+](https://img.shields.io/badge/macOS-11%2B-171b1a?logo=apple)](#install)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<a href="https://github.com/pillieshwar/Plucky/releases/latest/download/Plucky-macOS.dmg"><img src="docs/download-mac.svg" alt="Download Plucky for Mac" width="248" height="52"></a>

<sub>Free and open source · Apple silicon and Intel · one model download (about 2 GB) from inside the app</sub>

<br><br>

<img src="docs/screenshots/panel.png" alt="Plucky's task panel with a captured task, due-time chips and today's list" width="380">&nbsp;&nbsp;<img src="docs/screenshots/popover.png" alt="The menu-bar popover with a calendar and today's agenda" width="300">

</div>

---

## Why Plucky

Most to-dos start as text someone sent you — "can you send the deck by Friday 3pm?". Copying that into a task app, retyping the title and picking a date is just enough friction that it doesn't happen. Plucky removes the friction:

- **One shortcut from text to task.** Select, press <kbd>⇧⌘S</kbd>, press <kbd>Return</kbd>. Or right-click the selection and choose **Add to Plucky**.
- **Dates done right.** "by Friday 3pm", "every Monday", "tomorrow evening" become a real day, time and repeat. When a phrase is ambiguous, Plucky asks instead of guessing.
- **Private by design.** The model runs locally through a bundled [llama.cpp](https://github.com/ggml-org/llama.cpp) runtime. No account, no cloud, no telemetry.
- **Native and out of the way.** Lives in the menu bar, works over full-screen apps, opens at login and updates itself.

## Features

| | |
| --- | --- |
| **Capture from anywhere** | Select text in any app and press <kbd>⇧⌘S</kbd>, or right-click → **Add to Plucky**. A card drops down from the Plucky icon in the menu bar with a suggested title, date and time. |
| **Quick add** | Press <kbd>⇧⌘Space</kbd> anywhere and type `pay rent friday 5pm #home` — Plucky shows how it reads the date as you type. |
| **Reminders that respect you** | Notifications with **Done**, **Snooze** and **Tomorrow** buttons, or one morning summary instead. A **Due now** card keeps fired reminders one click away. |
| **Check-ins in the menu bar** | When a task's time comes, the menu-bar dropdown opens on just that task — everything else blurred — with **Done** and **Snooze**. Once a day (4:00 PM by default) it asks you to plan tasks that have no date, one tap each. Neither takes your keyboard. |
| **AI agents, write-only** | Let Claude Code, Claude Desktop, Cursor, VS Code, Windsurf and LM Studio add tasks — "add a Plucky task to send the deck Friday 3pm", or on their own when you mention a deadline. Plucky finds them and connects each in one click. They can never read your list, and you approve every task. |
| **Watch Slack & Outlook** | Optional: while Slack or Outlook is in front, Plucky reads the new messages on screen (through Accessibility — no screenshots, never what you type) and suggests the ones that ask something of you — or that you promised ("I'll send it Monday") — with the date. Tell it your name in each app so it knows which messages are yours; it reads the earlier messages for context, so "set up time with everyone" becomes a to-do that names who. The on-device model decides; nothing is stored or leaves the Mac, and every suggestion waits for your approval. Pause it from the menu bar. |
| **Email to tasks** | With an Outlook or Exchange connection in Claude Code, Plucky has Claude Code check your new email every 30 minutes from 9 to 5 (you pick) and send the action items to Plucky for review. Plucky never reads your mail, and a task you've already reviewed isn't suggested again. |
| **Light, dark or system** | Pick the look in **Preferences → Appearance**. |
| **See what matters** | Due-time chips are red when overdue, amber when due soon, muted when done. **Today focus** (<kbd>F</kbd>) hides everything but today. |
| **Menu-bar calendar** | Click the icon for a month view and today's agenda. Drag a task onto another day to move it. With the Calendar connector on, holidays show as a purple dot. |
| **Back to the source** | Each task remembers where it came from — the Slack thread, web page or file — and opens it in one click. |
| **Descriptions** | Add links and details to a task with **+ Add description**; links become clickable. |
| **Repeating tasks** | Completing "water plants every Monday" schedules the next one. |
| **Search and tags** | <kbd>/</kbd> to search, `#tags` to filter, undo everything with <kbd>⌘Z</kbd>. |
| **Connectors** | **Calendar** shows your meetings next to your tasks in the menu bar (read-only; includes Google, Outlook and iCloud calendars added to the Mac). **Apple Reminders** syncs tasks both ways — off by default, with a clear warning if the list syncs through iCloud. |
| **Your data, your files** | Tasks live in one SQLite file on your Mac with daily backups, and export to CSV or JSON. |

## Install

1. **Download** [`Plucky-macOS.dmg`](https://github.com/pillieshwar/Plucky/releases/latest/download/Plucky-macOS.dmg).
2. **Open it** and drag **Plucky** into **Applications**.
3. **Launch Plucky.** If macOS says it can't verify the developer, open **System Settings → Privacy & Security**, click **Open Anyway** and confirm. You do this once.
4. **Follow the short setup.** Plucky asks for **Accessibility** access (how macOS lets an app read selected text), downloads the recommended model (*Qwen3.5 4B*, about 3 GB, once — chosen by Plucky's model tests), turns on reminders and lets you try a capture.

There's nothing else to install. Plucky opens at login and updates itself — look for **Restart to update** when a new version is ready.

> **Coming from Pluck?** Pluck is now called Plucky. It updates itself as usual, renames itself to Plucky in Applications on first launch, and keeps your tasks, models, settings and login item.

**Verify your download (optional).** Every release is built by this repository's public release workflow and carries a signed build-provenance attestation. With the [GitHub CLI](https://cli.github.com):

```bash
gh attestation verify ~/Downloads/Plucky-macOS.dmg --repo pillieshwar/Plucky
```

Each release also lists SHA-256 checksums in `SHA256SUMS.txt`.

## Keyboard shortcuts

**Anywhere on your Mac** — change them in **Preferences → Keyboard shortcuts**:

| Shortcut | Action |
| --- | --- |
| <kbd>⇧⌘S</kbd> | Capture the selected text as a task |
| <kbd>⇧⌘Space</kbd> | Quick add — type a task |
| <kbd>⇧⌘H</kbd> | Show or hide Plucky (handy over full-screen apps, where the menu bar is hidden) |

**In the task list** — press <kbd>?</kbd> to see them in the app:

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move between tasks | <kbd>T</kbd> / <kbd>M</kbd> / <kbd>W</kbd> | Move to today / tomorrow / next week |
| <kbd>Space</kbd> | Complete | <kbd>S</kbd> | Snooze |
| <kbd>E</kbd> | Edit title | <kbd>N</kbd> | Edit description |
| <kbd>D</kbd> | Change date and time | <kbd>O</kbd> | Open the source |
| <kbd>F</kbd> | Today focus | <kbd>⌫</kbd> | Delete |
| <kbd>/</kbd> or <kbd>⌘F</kbd> | Search | <kbd>⌘Z</kbd> | Undo |

## Privacy

- **Your selections never leave your Mac.** Text is read through macOS Accessibility and sent only to the model runtime listening on `127.0.0.1`, with a random port and key for each session.
- **Tasks are stored locally** in `~/Library/Application Support/app.pluck.desktop/`, with seven days of backups in `backups/`.
- **Plucky uses the internet only for:** model downloads you start (from Hugging Face, verified against their SHA-256), checking GitHub for updates (you can turn this off in **Preferences → General**), and — only if you connect it — talking to Slack directly from your Mac. The Slack sign-in is stored in your macOS Keychain; there is no Plucky server.
- **AI agents can write, never read.** If you turn on **Connectors → AI agents**, apps on your Mac like Claude Desktop and Claude Code can send tasks to Plucky over MCP. They can't see, change or delete anything; each task waits in the menu bar until you add it. It works only on this Mac, through a private local connection — no network.
- **No accounts, analytics or telemetry.** Notifications are scheduled by your Mac, not a server.
- **The one exception you control:** if you turn on Apple Reminders sync with a list stored in iCloud, those tasks sync through iCloud. Plucky warns you and asks first; pick an "On My Mac" list to stay fully local.

## How it works

```
select text ─▶ read selection ─▶ local model ─▶ resolve the date ─▶ you confirm ─▶ SQLite ─▶ reminder
               Accessibility,     JSON-schema     in code, against     Return to save
               clipboard fallback constrained     today's real date
```

1. **Capture** ([`src-tauri/src/capture/`](src-tauri/src/capture)) reads the selection with macOS Accessibility (`AXSelectedText`). If an app doesn't expose it, Plucky sends Copy and restores your clipboard afterwards — only if nothing else wrote to it in the meantime, and never when it holds images or files. **Add to Plucky** in the right-click menu receives the text directly from macOS and doesn't touch the clipboard at all.
2. **Extract** ([`src-tauri/src/engine.rs`](src-tauri/src/engine.rs), [`crates/pluck-core/src/llm.rs`](crates/pluck-core/src/llm.rs)) starts the bundled `llama-server` on demand and asks for exactly three fields — `task`, `date_text` and `date_confidence` — under a JSON Schema at temperature 0. Output is validated in Rust, with one repair retry. The runtime stops after five idle minutes to give the memory back.
3. **Resolve the date** ([`src/lib/dates.ts`](src/lib/dates.ts), [`src/lib/schedule.ts`](src/lib/schedule.ts)): the model only copies the phrase; deterministic code turns it into a day, time and repeat rule. Ambiguous phrases ("next Friday" on a Tuesday, `3/4`) offer both readings.
4. **Store and remind** ([`crates/pluck-core/src/store.rs`](crates/pluck-core/src/store.rs), [`src-tauri/src/notifications/`](src-tauri/src/notifications)) keeps tasks in SQLite and shows native notifications with actions when they're due.

Selected text is treated as untrusted input: it's wrapped and sanitized as data, instructions live only in the system prompt, and the strict schema means an injection can at worst produce an odd task title.

## Build from source

**Prerequisites:** Rust (stable), Node 20+, CMake and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (`xcode-select --install` on macOS).

```bash
git clone https://github.com/pillieshwar/Plucky.git && cd Plucky
npm install
scripts/build-llama-server.sh   # build the bundled model runtime once (a few minutes)
npm run tauri dev               # run in development
npm run tauri build             # Plucky.app and a .dmg in target/release/bundle/
```

During `tauri dev`, macOS grants Accessibility permission to your terminal, not to Plucky. To use an existing Ollama instead of the bundled runtime, set `PLUCK_OLLAMA_URL=http://127.0.0.1:11434` (and optionally `PLUCK_MODEL`).

**Tests**

```bash
cargo test --workspace   # schema, prompt, retries, downloads, clipboard guard, store, sync, shortcuts
npm test                 # date, time and repeat parsing, quick add, due chips, search and tags
```

### Project layout

```
crates/pluck-core/   Platform-independent Rust: prompt and schema, model clients, verified downloads,
                     clipboard guard, SQLite store, recurrence, Reminders sync logic
src-tauri/           Tauri v2 shell: menu bar, shortcuts, windows, capture, notifications, updates
src/                 React + TypeScript UI: task panel, menu-bar popover, quick add; src/lib holds the logic
scripts/             llama-server build, icon rendering, UI preview screenshots
```

Built with [Tauri 2](https://tauri.app), Rust, React and TypeScript, [llama.cpp](https://github.com/ggml-org/llama.cpp) and SQLite.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Apple could not verify Plucky…" | Expected for this build. **System Settings → Privacy & Security → Open Anyway**. |
| <kbd>⇧⌘S</kbd> does nothing | Check that the Plucky icon is in the menu bar and Accessibility is allowed. If another app uses the same shortcut, pick a new one in **Preferences → Keyboard shortcuts**. |
| "No selected text found" | Select the text again. Password fields and some secure apps can't be read, by design. |
| **Add to Plucky** isn't in the right-click menu | Open Plucky from **Applications** once, then log out and back in. You can also enable it in **System Settings → Keyboard → Keyboard Shortcuts → Services → Text**. Some apps list it under **Services**. |
| No reminders appear | **Preferences → Notifications** shows whether they're allowed and can send a test notification. |
| Accessibility is asked for again after an update | In **Privacy & Security → Accessibility**, remove Plucky with **–**, then capture again and re-allow it. |
| The menu-bar icon is somewhere you don't want it | Hold **⌘** and drag it. macOS remembers the spot, including across updates. Plucky starts next to the battery, but never moves the icon again after that. |
| Something else | **Preferences → Show log file** opens Plucky's log. It stays on your Mac — attach it to an [issue](https://github.com/pillieshwar/Plucky/issues). |

## Uninstall

Quit Plucky from its menu-bar icon, move it from Applications to the Bin and remove it from **Privacy & Security → Accessibility**. To delete your tasks and models too:

```bash
rm -rf ~/Library/Application\ Support/app.pluck.desktop
```

## Contributing

Bug reports, ideas and pull requests are welcome.

1. Open an [issue](https://github.com/pillieshwar/Plucky/issues) describing the bug or idea — for bugs, attach the log from **Preferences → Show log file**.
2. Fork the repository and create a branch.
3. Run `cargo test --workspace` and `npm test` before opening a pull request. CI builds the app on macOS and Windows and runs the security checks. Commit `Cargo.lock` and `package-lock.json` changes along with the dependency change that caused them.

Maintainers: releases are cut from **Actions → Release → Run workflow** after bumping `version` in `package.json`, `src-tauri/tauri.conf.json` and `Cargo.toml`. The workflow builds a universal `.dmg`, signs the update archive and publishes `latest.json` for in-app updates.

## Security

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md). Dependencies are locked (`Cargo.lock`, `package-lock.json`), updated weekly by Dependabot, and checked on every pull request by cargo-deny, npm audit, OSV-Scanner and zizmor.

## License

[MIT](LICENSE) © 2026 Eshwar Pilli
