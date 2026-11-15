# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Ground rules

These keep the dashboard small, private and easy to trust:

- **Zero dependencies.** Node.js 22+ built-ins on the server, plain DOM in the page. No npm packages, no build step, no framework.
- **Local only.** The server listens on 127.0.0.1 and never calls out to the internet. The page loads nothing from other sites.
- **Read-only.** The dashboard never writes to, locks or moves Claude Code's files.
- **Private by default.** Login tokens are never read. Emails, organization names, prompts and paths stay hidden in Presenting mode.

## Set up

```sh
git clone https://github.com/AIInnovator/claude-stats.git
cd claude-stats
node server.mjs   # http://127.0.0.1:7420
```

Edit files in `public/` and reload the page. Restart the server after changing `server.mjs` or `lib/`.

## Checks

```sh
npm test
```

This runs six checks:

| Check | What it covers |
|---|---|
| `machinecheck` | Every state machine, plus regression tests |
| `accountcheck` | Account keys and logins, with made-up data |
| `selfcheck` | The data layer against your own Claude Code logs, read-only. A machine without Claude Code skips the real-log part and says so. |
| `pathcheck` | The real server with a fake home folder |
| `lockcheck` | Proves the reader never blocks Claude Code |
| `check-palette` | Chart colours for contrast and colour blindness, in both themes |

CI runs them on Windows, macOS and Linux, with Node 22 and the current LTS. It also installs the app with both one-line installers.

## Code style

- Follow the patterns of the file you're in. In the page, build DOM with `h()` and `fill()`. Text from logs goes in through `text:`, never `innerHTML`.
- No inline scripts or styles in `index.html`: the Content Security Policy blocks them.
- Comments say why, in one line. Name money with `costWord()`, so subscription usage is never called "spend".
- Every control needs an accessible name and must work from the keyboard.

## Pull requests

1. Keep each pull request to one change, and link its issue.
2. Run `npm test`, and look at the page in both themes. Also check a phone width if the layout changed.
3. Update `README.md`, and add a line to `CHANGELOG.md` under the next version, when behaviour changes.
4. Screenshots: turn Presenting mode on first (the eye, or `p`).

## Releases

Maintainers release in three steps:

1. Set `version` in `package.json`.
2. Add a matching `## x.y.z (date)` section to `CHANGELOG.md`.
3. Push the tag `vx.y.z`.

The Release workflow then runs the checks and publishes the GitHub release, using that changelog section as its notes.
