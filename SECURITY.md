# Security policy

## Supported versions

Only the latest release gets security fixes. To update, run the one-line installer again, or `git pull`.

## Reporting a vulnerability

Please report it privately, not in a public issue. Use the [Report a vulnerability](https://github.com/AIInnovator/claude-stats/security/advisories/new) form on this repository's Security tab.

Include:
- what an attacker could do
- the steps to reproduce it
- the version you tested

You'll get a reply within a few days. A fix will be published as a new release, with credit if you want it.

## How the dashboard is built to be safe

- **Local only.** The server listens on 127.0.0.1 only. It answers only requests whose `Host` is `127.0.0.1` or `localhost` on its port, which blocks DNS-rebinding attacks.
- **Strict Content Security Policy.** The page can load scripts, styles, fonts and data only from the dashboard itself. Inline scripts and styles are blocked, and the page can't be framed.
- **Read-only.** The server reads Claude Code's files. It never writes to them, locks them, or moves them.
- **Credentials are never read.** From `~/.claude.json`, the server reads only these fields:
  - the email
  - the organization name
  - the plan type and tier
  - whether extra usage is on
  - a one-way key per account

  It never opens `.credentials.json` or login tokens.
- **No network calls, no telemetry.** Nothing leaves your machine.
