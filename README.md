# gmail-cli

[![publish](https://img.shields.io/github/actions/workflow/status/harteWired/gmail-cli/publish.yml?style=flat&labelColor=15151e&color=e6a562&label=publish)](https://github.com/harteWired/gmail-cli/actions/workflows/publish.yml)
[![npm](https://img.shields.io/npm/v/@hartewired/gmail-cli?style=flat&labelColor=15151e&color=e6a562)](https://www.npmjs.com/package/@hartewired/gmail-cli)
[![node](https://img.shields.io/node/v/@hartewired/gmail-cli?style=flat&labelColor=15151e&color=e6a562)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-e6a562?style=flat&labelColor=15151e)](./LICENSE)
[![by — harteWired](https://img.shields.io/badge/by-harteWired-e6a562?style=flat&labelColor=15151e)](https://github.com/harteWired)

A stateless, zero-dependency, **agent-friendly** Gmail CLI. Read, send, reply, forward, label, and organize mail straight from the shell — with JSON output on every command.

```bash
gmail list "is:unread newer_than:3d" --max 10
gmail send --to a@b.com --subject "Q2 report" --html --body-file note.html --attach report.pdf
gmail reply <id> --all --body "Thanks — got it."
gmail markread --query "is:unread older_than:30d"
```

<p align="center">
  <img src="https://raw.githubusercontent.com/harteWired/gmail-cli/main/docs/architecture.svg" width="820" alt="Stateless architecture: a caller shells out to gmail, which resolves credentials, mints or reuses a cached access token, calls the Gmail REST API, prints JSON, and exits. No daemon runs when idle.">
</p>

## Why another Gmail CLI

Most Gmail tools are built for a human sitting at a terminal. This one is built to be **driven by a program** — an LLM agent, a cron job, a shell script:

1. **Stateless.** No daemon, no background auth server, no long-running process to crash or reconnect. Each command mints (or reuses a cached) access token and exits. Nothing runs when idle.
2. **Zero dependencies.** Pure Node (>= 20, uses the built-in `fetch`). Nothing to audit, nothing to break on an upstream release.
3. **Machine-readable.** `--json` (and JSON-by-default on write/organize commands) means the output parses cleanly. Search-query batch ops (`--query`) let one command act on many messages.

If you want a rich human TUI, use [himalaya](https://github.com/pimalaya/himalaya). If you want something an agent can shell out to and parse, that's this.

## Install

```bash
npm install -g @hartewired/gmail-cli
# or run without installing:
npx @hartewired/gmail-cli help
```

## Setup — create a Google OAuth client

gmail-cli talks to your own Google Cloud OAuth client (the client secret for a
Desktop app is not treated as confidential by Google). One-time:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create (or pick) a project.
2. **APIs & Services → Library →** enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen:** configure it (External is fine), and add your Google account under **Test users** so you can authorize while the app is unverified.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Application type: Desktop app.** Copy the **Client ID** and **Client secret**.

Provide the client to gmail-cli either way:

```bash
# via env vars
export GMAIL_CLI_CLIENT_ID="…apps.googleusercontent.com"
export GMAIL_CLI_CLIENT_SECRET="…"

# or persist to the config file (~/.config/gmail-cli/config.json)
gmail auth --client-id "…apps.googleusercontent.com" --client-secret "…"
```

## Authentication

Run the one-time sign-in. Two modes:

```bash
gmail auth            # loopback: opens a browser, captures the redirect automatically
gmail auth --manual   # headless: prints a URL, you paste back the `code`
```

Use `--manual` on a remote/SSH box with no local browser. It stores a refresh
token in `~/.config/gmail-cli/config.json` (mode 600). From then on every command
just works — the CLI refreshes short-lived access tokens on its own.

**Prefer bringing your own token?** Any refresh token minted for your OAuth client
with the Gmail scopes works — obtain one however you like (e.g. the
[OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)) and set
`GMAIL_CLI_REFRESH_TOKEN`, or drop `refresh_token` into the config file. `gmail auth`
is just a convenience wrapper around this.

Scopes requested: `gmail.modify`, `gmail.compose`, `gmail.send`.

## Multiple accounts

Every command takes `--account NAME` to target a specific inbox. Authorize each one once:

```bash
gmail auth --account personal
gmail auth --account work
```

Then target them per command:

```bash
gmail list --account work "is:unread"
gmail send --account personal --to a@b.com --subject Hi --body "hey"
gmail accounts                 # list configured accounts + the default
```

The first account you authorize becomes the default (used whenever `--account`
is omitted). Each account's credentials and token cache are stored separately.
A single-account setup never needs `--account` at all.

## Commands

Read:

| Command | Purpose |
|---|---|
| `profile` / `labels` | account info / list labels |
| `list [query] [--max N] [--label L] [--json]` | list messages (Gmail search syntax) |
| `search <query>` | alias for `list` |
| `threads [query] [--max N] [--json]` | list threads |
| `read <id> [--html] [--json] [--raw]` | full message; `--raw` streams the `.eml` |
| `thread <id> [--json]` | full thread |
| `attachments <id>` | list a message's attachments |
| `download <id> [--attachment ID] [--out DIR]` | save attachment(s) to disk |

Write — body from `--body TEXT`, `--body-file PATH`, or a pipe (`--body -`);
`--html` sends `multipart/alternative` (HTML + auto plaintext); `--attach` repeatable:

| Command | Purpose |
|---|---|
| `send --to A --subject S <body> [--html] [--attach F]... [--cc] [--bcc]` | send a message |
| `reply <id> <body> [--html] [--all] [--attach F]...` | reply in-thread; `--all` = reply-all |
| `forward <id> --to A [--body intro] [--html] [--no-attachments]` | forward (re-attaches originals) |
| `draft …` / `drafts` / `draft-send <id>` / `draft-delete <id>` | draft lifecycle |

Organize — every verb accepts one or more `<id>` **and/or** `--query Q` for batch:

| Command | Purpose |
|---|---|
| `modify <id...> [--add L]... [--remove L]...` | add/remove labels (name or id) |
| `trash` / `untrash` / `markread` / `markunread` / `star` / `unstar` | common actions |
| `archive` / `unarchive` / `spam` / `unspam` | move mail around |
| `label-create <name>` / `label-delete <name>` / `label-rename <name> --to <new>` | label admin |

Run `gmail help` for the full list.

## Configuration reference

The config file (`$GMAIL_CLI_CONFIG`, default `~/.config/gmail-cli/config.json`)
holds named accounts:

```json
{
  "default": "personal",
  "accounts": {
    "personal": { "client_id": "…", "client_secret": "…", "refresh_token": "…" },
    "work":     { "client_id": "…", "client_secret": "…", "refresh_token": "…" }
  }
}
```

Env vars override the active account per-field (handy for single-account CI):
`GMAIL_CLI_CLIENT_ID`, `GMAIL_CLI_CLIENT_SECRET`, `GMAIL_CLI_REFRESH_TOKEN`.

A legacy flat file (`{ "client_id", "client_secret", "refresh_token" }`) is still
read as the account named `default`. Per-account token caches live at
`~/.config/gmail-cli/token-<account>.json`.

## Development

```bash
npm test    # node --test (unit tests for MIME, arg parsing, config resolution)
```

## License

MIT — see [LICENSE](./LICENSE).
