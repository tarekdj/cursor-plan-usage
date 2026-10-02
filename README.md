# cursor-plan-usage

Show **Cursor subscription / plan usage** in [pi](https://github.com/earendil-works/pi-coding-agent): included quota, auto vs API split, on-demand spend, and a compact TUI footer line. Works alongside [`pi-cursor-sdk`](https://www.npmjs.com/package/pi-cursor-sdk); it does not modify that package.

**Disclaimer:** This extension was written by [pi](https://github.com/earendil-works/pi-coding-agent) itself (the pi coding agent), not as an official Cursor or pi product release.

**Not affiliated with Cursor.** This extension calls Cursor usage APIs that may change without notice. Compare with [Cursor dashboard → Usage](https://cursor.com/dashboard?tab=usage).

## Requirements

- [pi](https://github.com/earendil-works/pi-coding-agent) (interactive TUI for the footer; `/cursor-usage` works in other pi modes too)
- A Cursor login usable for **plan** quota (see [Authentication](#authentication-first-match-wins)) — not the same as a `crsr_…` SDK API key alone
- **Optional:** Node’s built-in `sqlite` module (Node 22+) to read Cursor IDE `state.vscdb`; without it, CLI/env/OAuth paths still work

## Install

**From git:**

```bash
pi install git:github.com/tarekdj/cursor-plan-usage
```

**Clone and try once:**

```bash
git clone https://github.com/tarekdj/cursor-plan-usage.git
pi -e /path/to/cursor-plan-usage
```

**Local development:** copy or symlink the folder to `~/.pi/agent/extensions/cursor-plan-usage/` (pi loads any subdirectory with an `index.ts` entry). After edits, run `/reload` in pi.

## Commands

| Command | Description |
| --- | --- |
| `/cursor-usage` | Terminal dashboard (progress bars) |
| `/cursor-usage json` | Same data as JSON (no secrets) |
| `/cursor-usage source` | Which credential source was used (no tokens) |

Example dashboard output (values vary by account):

```text
Usage • Pro                                    Resets 2 Apr
Monthly plan and on-demand usage

Category        Current          Usage
Included        42% used         ████████░░░░░░░░░░░░
  Auto          30% used         ██████░░░░░░░░░░░░░░
  API           12% used         ██░░░░░░░░░░░░░░░░░░
On-Demand       Disabled
```

## Footer (TUI)

Plan quota appears on the **extension status row** in the footer (alongside token/context/model). Refreshes on session start and **after each completed agent run** (`agent_end`), not on every tool step — at most once every 2 minutes unless you run `/cursor-usage`.

Example status line: `Cursor plan 42% (auto 30% · api 12%) Pro resets Apr 2`

| Variable | Purpose |
| --- | --- |
| `CURSOR_PLAN_USAGE_FOOTER=0` | Disable footer line |
| `CURSOR_PLAN_USAGE_FOOTER_REFRESH_MS` | Min ms between API refreshes (default `120000`) |

## Authentication (first match wins)

1. `CURSOR_ACCESS_TOKEN` — valid JWT access token
2. Pi OAuth for provider `cursor` (`~/.pi/agent/auth.json`, type `oauth`)
3. macOS Keychain (`cursor-access-token` / `cursor-refresh-token`) when allowed
4. Cursor IDE `state.vscdb` (`cursorAuth/accessToken`)
5. Cursor CLI `~/.config/cursor/auth.json` (common on Linux after `cursor` CLI login)
6. Refresh tokens from the above via Cursor’s token exchange endpoint
7. Fallback: `CURSOR_USAGE_SESSION_TOKEN` or `CURSOR_PLAN_USAGE_SESSION_TOKEN` (`WorkosCursorSessionToken` cookie value) → `cursor.com/api/usage-summary`

**Note:** A Cursor **SDK API key** (`crsr_…` from `/login` with pi-cursor-sdk) is **not** enough for plan usage. You need an OAuth/session access token (Cursor CLI login, IDE, or session cookie).

Set `CURSOR_PLAN_USAGE_ALLOW_SYSTEM_CREDENTIALS=0` to disable reading IDE/CLI/keychain credentials.

Run `/cursor-usage source` to see which source pi picked (no token values printed).

## Privacy and network

- **Outbound:** HTTPS to `api2.cursor.sh` (period usage, token refresh) and/or `cursor.com/api/usage-summary` with your Bearer token or session cookie. Only usage/billing metadata is requested; prompts and code are not sent.
- **Local reads (when allowed):** `~/.pi/agent/auth.json`, `~/.config/cursor/auth.json`, Cursor IDE SQLite DB, macOS Keychain. Tokens stay on your machine except as sent to Cursor’s APIs above.
- **Local write:** `~/.pi/agent/cursor-plan-usage-refresh-failures.json` (hashed refresh-token keys + backoff timestamps) after failed token refresh.

## License

MIT — see [LICENSE](./LICENSE) in this repository.
