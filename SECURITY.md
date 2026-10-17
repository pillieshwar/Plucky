# Security policy

Plucky reads the text you select and keeps your tasks on your Mac, so we take
security reports seriously and answer them quickly.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately instead:

1. Go to the repository's **Security** tab → **[Report a vulnerability](https://github.com/pillieshwar/Plucky/security/advisories/new)**.
2. Describe the problem, the version of Plucky (Settings → General), your macOS version, and how to reproduce it.

You can expect:

- an acknowledgement within **3 days**,
- an assessment and a plan within **10 days**,
- a fix released as soon as it's ready, usually within **30 days** for serious issues,
- credit in the release notes and the advisory, if you'd like it.

## Supported versions

Only the **latest release** gets security fixes. Plucky updates itself, so
staying current is automatic unless you've turned off **Update automatically**.

## What's in scope

- The Plucky app and its update mechanism
- The bundled model runtime as Plucky configures it
- The release workflow and the files it publishes

Bugs in third-party dependencies are welcome too; we'll coordinate with the
upstream project.

## How Plucky protects you

- **Local only.** Selections and tasks never leave the Mac. The optional Slack
  connector talks to slack.com directly (OAuth with PKCE, no client secret),
  and keeps its token in the macOS Keychain.
- **Write-only AI agents.** `Pluck --mcp` offers AI apps one tool,
  `add_task`, and nothing to read. It reaches the app over a Unix socket that
  only the user can open (mode 0600, no network). Every accepted task gets the
  same reply — no ids, counts or duplicate checks — and lands in an inbox the
  user reviews before anything joins the task list. Off by default; rate- and
  size-limited. Plucky only edits another app's MCP settings when the user
  clicks Connect, changes only its own `plucky` entry, and keeps a
  `.plucky-backup` of the original file.
- **Scheduled email checks** (off by default) run Claude Code with only two
  kinds of tools allowed: the user's chosen mail server and Plucky's
  `add_task`. The `/email-tasks` prompt treats email as untrusted and never
  sends, moves or deletes mail. Plucky never reads the mail itself.
- **Local model.** The model runtime
  listens on `127.0.0.1` only, on a random port with a random key.
- **Signed updates.** Every in-app update is verified against the project's
  public key before it's installed.
- **Verified downloads.** Models are checked against published SHA-256 sums;
  every release publishes `SHA256SUMS.txt` and a signed build-provenance
  attestation (see the README for how to verify a download).
- **Dependency checks.** Locked dependencies, weekly Dependabot updates, and
  cargo-deny, npm audit, OSV-Scanner and zizmor on every pull request.
