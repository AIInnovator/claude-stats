# Claude Code Stats

[![CI](https://github.com/AIInnovator/claude-stats/actions/workflows/ci.yml/badge.svg)](https://github.com/AIInnovator/claude-stats/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/AIInnovator/claude-stats)](https://github.com/AIInnovator/claude-stats/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Node.js 22+](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![Windows | macOS | Linux](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

A local, live dashboard for your Claude Code usage. It reads the logs Claude Code writes on your
machine and shows cost at API prices, tokens, models, tools, sessions and 5-hour windows, per account.

**Install in one line**, then open http://127.0.0.1:7420:

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/AIInnovator/claude-stats/main/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/AIInnovator/claude-stats/main/install.ps1 | iex
```

## What it is

- One small Node.js server and one web page.
- Zero dependencies. Node 22+ built-ins only. No `npm install` needed.
- Reads `~/.claude/projects/**/*.jsonl` (transcripts), `~/.claude/history.jsonl` (prompt history) and `~/.claude.json` (only the logged-in account's email, plan and organization, and the plan and organization of every login it finds), read-only.
- Works for anyone who clones it: each person sees their own usage and their own account, from their own machine.
- Geist and Geist Mono fonts are vendored in `public/fonts`, with their OFL license (`public/fonts/LICENSE.txt`).
- Updates live while you work. Nothing leaves your computer.

## Install

### One line (recommended)

| System | Command |
|---|---|
| macOS, Linux | `curl -fsSL https://raw.githubusercontent.com/AIInnovator/claude-stats/main/install.sh \| sh` |
| Windows (PowerShell) | `irm https://raw.githubusercontent.com/AIInnovator/claude-stats/main/install.ps1 \| iex` |

The installer:
1. Installs the current Node.js LTS if Node 22 or newer is missing:
   - Windows: winget
   - macOS: Homebrew when present, otherwise nvm
   - Linux: nvm, in your home folder, without `sudo`
2. Downloads the [latest release](https://github.com/AIInnovator/claude-stats/releases/latest) into `~/.claude-stats` (Windows: `%USERPROFILE%\.claude-stats`).
3. Starts the dashboard. Ctrl+C stops it. Start it again with `node ~/.claude-stats/server.mjs`, or on Windows `node $HOME\.claude-stats\server.mjs`.

- **Update:** run the same line again. It replaces only that folder, and never a folder that isn't a claude-stats install.
- **Uninstall:** delete the folder. The dashboard keeps no other files; your saved view lives in the browser.
- **Options:** `CLAUDE_STATS_DIR=<folder>` installs somewhere else; `CLAUDE_STATS_NO_START=1` installs without starting.
- **Read before you run:** [`install.sh`](install.sh) and [`install.ps1`](install.ps1). CI runs both installers on Windows, macOS and Linux on every change.

### Manual

**1. Install Node.js 22 or newer.** Skip this if `node --version` already prints `v22` or higher.

```sh
# Windows (PowerShell)
winget install OpenJS.NodeJS.LTS

# macOS (Homebrew)
brew install node

# Linux, any distro (nvm). apt/dnf's "nodejs" package is often older than 22.
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# open a new terminal, then:
nvm install --lts
```

No package manager? Use the installer from https://nodejs.org/en/download. Then open a new terminal
(so `node` is found) and check with `node --version`.

**Get the code.** With git: copy the repository URL from the green **Code** button on GitHub, run
`git clone <that URL>`, then `cd claude-stats`. Without git: Code → Download ZIP, unzip it, and open a terminal in
that folder.

**2. Start the dashboard** from the `claude-stats` folder. Same command on Windows, macOS and Linux:

```sh
node server.mjs    # or: npm start
```

Then open http://127.0.0.1:7420 (http://localhost:7420 works too). It keeps running and updating live
until you press Ctrl+C in that terminal.

The server reads every log once before it starts listening, then prints one line: the URL, how many
calls and files it read, and how long that took. After that it prints only problems, each one once. The
folders it reads are listed in the page footer.

**Where it looks:** no paths are hard-coded; it starts from the current user's home folder, whatever the
username or OS. It reads `$CLAUDE_CONFIG_DIR` if you set it (Claude Code's docs: every `~/.claude` path
moves there), otherwise `~/.claude`, the documented location on Windows (`%USERPROFILE%\.claude`), macOS
and Linux. It also checks `~/.config/claude` (or `$XDG_CONFIG_HOME/claude`), which is not in Claude Code's
docs, and reads it only if it exists. Transcripts are every `projects/**/*.jsonl`, including the
`*.orphaned-*.jsonl` and `*.jsonl.superseded-*` copies Claude Code sets aside; a reply in two files counts
once. If nothing is found it says where it looked, starts empty, and picks transcripts up once they
appear. Claude Code running inside WSL keeps its data in the Linux home: run the dashboard inside WSL too,
or point `CLAUDE_CONFIG_DIR` at `\\wsl$\<distro>\home\<you>\.claude`. With `CLAUDE_CODE_SKIP_PROMPT_HISTORY`
set, Claude Code writes no transcripts, so there is nothing to show. The account comes from `~/.claude.json`
(Windows `%USERPROFILE%\.claude.json`), the same on every OS; with `CLAUDE_CONFIG_DIR` set, from `.claude.json` inside
that folder, or beside it when the folder is a `.claude` folder (the WSL case above). With a comma-separated list,
the current login is the first folder's, and every folder's login teaches the page its plan.

## What you see

Top bar:

- **Sections:** Cost, Activity, Records: jump to a zone; the one in view is marked (wide screens).
- **Time range:** Today, 24h, 7 days, 30 days, 90 days, All. The Dates menu adds the last 1, 3, 6 or 12 hours and a custom date and time range. "Live to now" makes the custom end follow the clock, so the range keeps moving. On a phone or narrow window the range buttons move into the Dates menu and the Dates button shows the range in short ("7d", "Today"), so the bar stays one row; on a phone the live badge shortens too.
- **Filters:** accounts, models, projects, subagents, advisor calls, background calls. Projects with no calls in the range are folded under "N idle in this range" (the project search looks inside it). Active filters also show as removable chips under the bar; **Clear filters** shows once one is on. A **Billing** group, above Projects, lets you mark projects that use an API key (see Accounts below).
- **Theme:** light, dark or system.
- **Live badge:** shows when the last update arrived.
- **Keyboard:** `?` lists the shortcuts: `/` search sessions, `1`–`6` pick the range, `f` Filters, `p` Presenting mode, `j` / `k` next or previous session in its details, Esc closes.

The page has three zones.

**Cost**

1. **The big number:** cost for the range, its change vs the previous period of the same length (with that period's amount), sparkline. Its heading follows how the usage is billed (see Accounts below): **API-equivalent cost** for subscription usage ("your plan covers it up to its limits"), **API spend (estimated)** for per-token usage (with any subscription usage named beside it), or **Estimated cost at API prices** when that isn't known.
2. **Key numbers:** tokens, API calls, sessions, time Claude spent working, your prompts, cache hit rate, each with its change vs the previous period; and **this month** so far at API prices, with where it is heading. Tiles that model and agent filters can't narrow (time working, prompts) say "all models & agents" while such a filter is on.
3. **Account:** who Claude Code is logged in as right now: plan with its usage-limit tier (e.g. Team 5x, Max 20x), whether paid extra usage is on, email and organization, so a work and a personal login are easy to tell apart. It changes within about 4 s of Claude Code saving a new login, without a reload; a plan change on the same account shows once Claude Code refreshes its saved profile (about once a day on the developer's machine). The hint says how many accounts the range covers. The **Extra usage** pill opens a one-line explanation. **API-key projects (N)** (shown when some sessions recorded no account) opens Filters at the Billing group. The **eye** (or `p`) turns on Presenting mode (see Privacy).
4. **5-hour windows:** for one account at a time (limits are per account): the one picked in Filters, else the current login, else the most used. On a plan it leads with the limit: time until reset and limit hits in the range, then the window's API-equivalent cost, its rate per hour and where that rate ends by reset. Other accounts show the window's cost first. Below: a timeline of windows and limit hits with a time axis. Filters never narrow this panel (limits count everything the account did); it says so while a filter is on. A per-token account shows "No 5-hour limit". Sessions from before Claude Code recorded accounts are drawn faded, marked "account not recorded".
5. **Usage over time:** cost, tokens or calls, split by model, token type, project or agent. The Table button shows the same data as a table.
6. **Models:** cost per model, plus a "Background (not in logs)" row split by model. Click a bar to filter.
7. **Projects:** cost per project. Click a bar to filter.
8. **Where the cost goes:** by agent, skill, plugin, MCP server or git branch.
9. **Cost breakdown at API prices:** per model, the calls and the input, 5-minute cache write, 1-hour cache write, cache read, output and web-search tokens (columns with nothing in the range are left out), each with its rate and cost. A tag confirms the rows add up exactly to the logged cost. **Download CSV** saves it.

**Activity**

10. **When you work:** hour x weekday heatmap of cost, calls, turn time, speed, tool errors, your reply time or your prompt length. It has its own range (page range, 7, 30, 90 days or all). Striped cells had too few samples to trust.
11. **Claude's performance:** four small charts over the range, each with its change vs the previous period and the best and worst hour of the day:
   - median turn time (Claude Code's own turn timer, prompt to finished reply),
   - speed (output tokens per minute Claude was working),
   - thinking time per call,
   - tool error rate (your permission denials excluded).
12. **Your rhythm:** the same kind of charts for your side, as mood and focus signals:
   - your reply time (Claude finished → your next prompt in the same session; gaps over 2 h and prompts queued while Claude was busy are skipped),
   - prompt length (characters only; prompt text is never analysed),
   - how often you stopped Claude (Esc, or a prompt sent with "send now"),
   - how often you rejected a tool call.
13. **Day by day:** one row per day with a midnight-to-midnight strip: Claude working (blue), Claude waiting for you (gold), your prompts (ticks). Columns: first–last activity, Claude's clock time (parallel sessions merged, not added), your median reply time, prompts, stops (interruptions plus rejections), cost.
14. **Tools:** most used or most errors, with error and denial rates.
15. **How Claude worked:** effort level, thinking, permission checks, tool failures, how replies ended, context compactions, lines changed, limits and errors, web searches, daily pace, sessions, prompts and hooks.

**Records**

16. **Sessions:** a searchable table with model names. A session's cost is its logged calls plus its share of background calls; Claude Code's own counter is shown beside it for comparison. Click a row (or Enter) to open a drawer with that session's details; its arrows (or `j` / `k`) step to the next or previous session, and it says where you are ("3 of 46"). The drawer's first figure follows the range and filters like the table; the rest covers the whole session, and a note says so when they differ. **Download CSV** saves every session in the range and filters.
17. **Prompt history:** search what you typed (/commands and ! lines included), with its own range (page range, 24h, 7 or 30 days, all). Shows the newest 60; **Show 60 more** or **Show all** load the rest. Prompts expand with a click, Enter or Space.
18. **Data & accuracy:** log coverage, the dedupe result, cost vs Claude Code's own counter, price coverage, parse errors.

Long "How this is measured" notes are folded under the panels they explain. The sparkline, the 5-hour windows and the heatmap can be read from the keyboard: Tab to the chart, then the arrow keys (each value is also announced to screen readers).

Your range, filters, theme and Presenting mode are saved in the browser's localStorage (key `ccstats.ui`), and the range and filters also in the page address, so a view can be bookmarked or two tabs can show two views. Remembered account plans are in `ccstats.accounts`.

### Accounts and billing

Claude Code 2.1.317 and later records which account ran each session. The dashboard turns that into a one-way
12-character key (the account and organization ids never reach the page) and classes each session:

| Session | Shown as |
| --- | --- |
| Account on a Claude plan (Pro, Max, Team, Enterprise) | subscription: API-equivalent cost |
| Account on any other plan (an Anthropic Console, per-token login) | per-token: API spend |
| Account seen, but its plan not learned yet | unknown |
| No account recorded, in a project you marked "uses an API key" (Filters → Billing) | per-token |
| No account recorded otherwise (older Claude Code, API key, Bedrock or Vertex) | unknown |

A plan is learned when the dashboard sees that login (open it once while logged into each account) and is then
remembered in the browser. Unknown usage is never shown as spend. Filters → Billing lists only projects with sessions
that recorded no account; "likely" marks those whose sessions ran a Claude Code that would have recorded a logged-in
account, i.e. probably an API key. Nothing is switched on for you.

## How the numbers are made (accuracy)

1. **Each API reply is counted once.** Claude Code writes one reply as about 2.9 log lines, and each
   line repeats the same usage. The dashboard keys every reply by `message.id` across all files. When
   the lines differ, it keeps the largest value of each field. On the developer's logs (12 Nov 2026)
   that gives 4.23B tokens counted once vs 12.11B if every line is counted (2.86x). These figures
   grow with use. The higher figure lands close to the ~12B that Claude Code's `/stats` showed on
   the same machine. Claude Code's own cost counters agree with the lower one (4.02B).
2. **Advisor calls are their own rows.** Advisor-model calls hide inside `usage.iterations` of the
   main reply. They are pulled out and counted with their own model and tokens. A filter can hide them.
3. **Prices are API list rates** per model and token type (`lib/pricing.mjs`): input, output, cache
   read, 5-minute cache write at 1.25x input, 1-hour cache write at 2x input. Fast mode is 2x, web
   search is $10 per 1,000. Checked against Claude Code's own per-model cost: within 1% on 447 of 463
   snapshots. A model with no known price counts as $0 and is flagged in Data & accuracy.
4. **Background (not in logs).** Claude Code's own saved cost counter is higher than what its
   transcripts contain: it bills calls that are never written there. Measured on 80 finished sessions
   (13 Nov 2026), the gap was $202, made of:
   - **About one short extra call per turn on your main model** ($128 on Opus 5.5): 330M extra
     cache-read tokens but only 0.3M extra output, i.e. ~300K cache-read tokens per turn (the size of
     the whole cached conversation) and ~200 output tokens back. It tracks the number of turns
     (correlation 0.88). The logs don't name the feature; an after-turn helper that re-reads the
     conversation (such as prompt suggestions) fits the shape.
   - The same pattern on sessions using Fable 5.x, Opus 4.8 and Sonnet (~$65).
   - **Haiku 5.5 helper calls** ($4.48): 8.8M uncached input tokens; they track auto-mode permission
     checks (correlation 0.45).
   - About 300 main-thread requests whose reply was never written (interrupted or failed).

   Claude Code saves its counter many times per session. Between two saved counters, the counter's
   increase minus the logged cost of the calls in between is background spend. It is spread over those
   calls in proportion to their cost (capped at 3x), and split by model using Claude Code's per-model
   counters. A period is closed once a later counter is saved, so its share never changes afterwards,
   even when the session is resumed days later. Calls after a session's last saved counter get no
   background yet. A counter that restarted at 0 adds nothing until it passes its old maximum. Data &
   accuracy shows how much of Claude Code's counter the logged calls cover. Switch it off in Filters.
   It is also left out while a model filter is on or subagent or advisor calls are hidden.
5. **5-hour windows are estimates.** They are built from CLI activity, start on 10-minute marks, and
   snap to the real reset times found in rate-limit errors. Solid bars are real resets, faded bars are
   estimates. claude.ai chat usage shares the same limit but is not in these logs. Windows follow one
   account (limits are per account) and ignore every other filter. Sessions from before Claude Code
   recorded accounts (2.1.317) may belong to any account: they are added to the followed account's
   windows, faded and marked "account not recorded", and their limit hits never move a reset. They
   are also counted apart from the followed account's own limit hits ("N more, account not recorded").
6. **Only transcripts still on disk count.** Claude Code can delete old transcripts (the
   `cleanupPeriodDays` setting); whatever it removed can't be counted. Data & accuracy shows the
   first day still on disk.
7. **"Today" compares with the same hours yesterday.** Every other range compares with the equal span
   right before it.
8. **Turn times and reply times** come from Claude Code's own `turn_duration` lines. "Claude working"
   clock time merges parallel sessions instead of adding them up. A reply gap counts only within one
   session, under 2 hours, and skips prompts you queued while Claude was busy.
9. **Which account ran a session** comes from Claude Code's own `session-owner` lines (2.1.317 and
   later); older sessions have none, so their cost can't be split by account. How each kind of usage
   is shown is in "Accounts and billing" above.

## Privacy & security

- Binds to 127.0.0.1 only. Other machines cannot connect.
- DNS-rebinding guard: a request whose Host header is not `127.0.0.1:<port>` or `localhost:<port>` gets `403 forbidden host`.
- GET only. Other methods get 405. The server never writes to your logs or anywhere else.
- **Read-only and lock-free.** It only lists, stats, reads and watches. Each file is opened read-only for one read and closed straight away, with Windows share-read/write/delete, so a running Claude Code session can append to, rewrite, rename or delete a transcript (or its whole project folder) at any moment and never sees "file is busy". `scripts/lockcheck.mjs` proves this with a separate process.
- **Light on the machine.** After the first read it checks only the file the watcher named and reads only its new bytes, at most twice a second. A full check (one folder listing plus one `stat` per file) runs every 30 s, or every 4 s while a folder can't be watched.
- Strict Content-Security-Policy: same-origin scripts, styles, fonts and connections only, no inline script or style, no framing. Also `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- No CORS headers, so other web pages cannot read the API.
- Static files come only from `public/`, and only with known file types.
- Every string that comes from the logs is rendered with `textContent`, never as HTML.
- No network calls. Fonts are local.
- What reaches the browser: per-call numbers, session titles, project paths, branch names, Claude Code versions, the logged-in account's email, and for every login found its organization name, plan type, limit tier, whether extra usage is on (current login) and a one-way account key. Prompt text only through Prompt history search (up to 4,000 characters per prompt). No message bodies, no tool output, no raw account or organization ids, no tokens.
- **Accounts:** from `.claude.json` only those fields are kept. The account key is the first 12 hex characters of a SHA-256 of the account and organization ids: stable, not reversible (someone who already knows your ids could confirm a match). Account and organization ids and every other setting stay in the server. Login tokens are in a different file (`.credentials.json`, or the macOS Keychain), which the dashboard never opens. The browser remembers each account's plan, tier and organization (never the email) in localStorage `ccstats.accounts`, per browser and per address (`localhost` and `127.0.0.1` keep separate memories).
- **Presenting mode** (the eye in the Account row): email, organization names and your user-folder name in every path (text, tooltips and hidden attributes) are left out of the page, not blurred, and prompt history is folded behind "Show prompts". Every panel redraws when you switch it, so off-screen panels hold no old text. Project paths also stay out of the page address. Session titles show as "Session" plus the first 8 characters of its id, and branch names are left out ("Branch 1 (name hidden)"). Project folder names still show, and the local server still sends the data to the tab.

## Live updates

Each part runs as a small state machine with one transition function (`lib/machines.mjs`, `public/machines.js`); `scripts/machinecheck.mjs` tests every one.

- `fs.watch` (recursive) on each transcript folder. It names the file that changed, so only that file is checked. A full check runs every 30 s as a safety net, or every 4 s while a folder isn't watched (no watcher support, or the folder doesn't exist yet). A watcher that fails, or whose folder vanishes, is closed and re-armed.
- Every account file is checked every 4 s (one `stat` each; parsed only when it changed). A login switch writes no transcript line, so a changed account is sent on its own; a file caught mid-write keeps the last account until the next check.
- Each file is tailed by byte offset. Only complete lines are read; a half-written last line waits for the next scan. A record glued onto a fragment that a crashed write left behind is recovered. A read that fails (antivirus, network drive) keeps its offset and is retried on the next scan.
- A transcript that is deleted, shrinks, is replaced, or is rewritten in place (its first 128 bytes change) can't be patched row by row. The server re-reads everything, at most every 10 s (`REBUILD_GAP_MS`), and every open tab gets a fresh snapshot, so a deleted transcript's rows disappear. New rows keep streaming meanwhile.
- Changes reach the browser over Server-Sent Events (`/api/stream`): writes are batched for 100 ms, and at most two updates go out a second. A new connection gets a full snapshot, then deltas. A tab that stops reading is dropped once 8 MB is queued for it; it reconnects and gets a fresh snapshot.
- Every row has a key (message id, tool_use id or line uuid). Reading a line twice updates the row; it never counts twice. A line that a background or resumed session copied from its parent always lands in the same session, whatever order the files are read in: the original one when Claude Code marks the copy (its `session_id` field), otherwise the earliest line, then the lowest session id. A subagent's transcript can start with a copy of the main thread's Agent call that launched it (same message and tool ids, same time, but marked as a subagent line); that call stays with the main thread, whatever file is read first.
- The page redraws only the panels on or near the screen. The others are brought up to date as you scroll to them, and all of them before printing or when Presenting mode is switched. Until then, the browser's find-in-page (Ctrl+F) can still match an off-screen panel's older numbers.
- If the connection drops, the badge shows "Reconnecting…" while the browser retries on its own. If the browser gives up (the server answered with an error), the badge shows "Disconnected · retrying" and the page reconnects after 2, 4, 8 … up to 30 s.

## Project layout

```
server.mjs                 HTTP server, file watching, SSE stream, prompt-history search, logged-in account
lib/store.mjs              Parses log lines into keyed tables; Tailer follows files by byte offset
lib/accounts.mjs           One-way account keys and the logins read from .claude.json
lib/pricing.mjs            Price table and per-call cost
lib/paths.mjs              Finds Claude Code's data folders and account file for any user on any OS
lib/machines.mjs           Server state machines: each file, the scan scheduler, each folder watcher
public/index.html          Page structure
public/app.js              Filters, aggregation and all charts (plain DOM, no framework)
public/machines.js         Page state machines (connection, redraw, drawer, history, popovers, settings) and the tool-row and cost-counter ones the store shares
public/styles.css          Layout and both themes
public/theme.js            Applies the saved theme before first paint (own file because of the CSP)
public/palette.js          Chart colors for each theme
public/favicon.svg         Icon
public/fonts/              Geist and Geist Mono (woff2) and their OFL license
scripts/machinecheck.mjs   Tests every state machine, with one regression test per invalid transition found
scripts/accountcheck.mjs   Account keys, session owners and login files
scripts/selfcheck.mjs      Data-layer checks against your real logs
scripts/pathcheck.mjs      Starts the real server as another user with data in several folders
scripts/lockcheck.mjs      Proves reading never blocks another program editing the logs
scripts/check-palette.mjs  Contrast and colorblind checks for the chart colors
install.sh                 One-line installer for macOS and Linux
install.ps1                One-line installer for Windows
.github/workflows/         CI (checks and both installers on Windows, macOS, Linux) and releases from tags
package.json               npm start and npm test; no dependencies
CHANGELOG.md               What changed in each version
CONTRIBUTING.md            How to set up, check and send a change
SECURITY.md                How to report a vulnerability, and how the dashboard stays local
LICENSE                    MIT license for the code (the fonts keep their own OFL license)
```

## Checks

```sh
npm test    # same as npm run check
```

It runs six scripts. `selfcheck.mjs` compares the store with the real logs on the machine and only reads them; on a
machine without Claude Code logs (such as CI) it skips that part and says so. `machinecheck.mjs`,
`accountcheck.mjs`, `pathcheck.mjs`, `lockcheck.mjs` and `check-palette.mjs` need no logs. CI runs all six on
Windows, macOS and Linux with Node 22 and the current LTS.

`scripts/accountcheck.mjs`: the account key formula; session owners read in either order (a live tail and a full
re-read agree); the lowest key when a session names two; ~110 repeated owner lines marking a session changed once;
no raw ids in a snapshot; and login files with and without an account, or half written.

`scripts/machinecheck.mjs`: every state machine, event by event, plus a sample of events each one must reject
without changing state. One regression test per bug found: a deleted file, a file rewritten in
place, a failed read, a glued line, a tool result with no call, background spend that must not change for past
periods, a stale scheduler timer, a vanished watched folder, a stream the browser closed, a panel that fails to
draw, a stale drawer animation, a stale or failed history fetch, a bad saved setting, a filter on a name with no
data, lines a background session copied from its parent, and a subagent transcript's copy of the Agent call that
launched it (found on real logs, 14 Nov 2026: the first file read decided whether that call counted as main or
subagent). The tailer tests use real files in
`scripts/.tmp-machinecheck/`, deleted afterwards.

`scripts/pathcheck.mjs`: builds a fake user `Zoë Ng` (space and accent in the name) under
`scripts/.tmp-home/` with transcripts in both `~/.claude` and `~/.config/claude`, a `.superseded-` copy, and
overlapping replies and prompts, then starts the real server as that user. It must read every folder, count
each reply once, merge the prompt histories, obey `CLAUDE_CONFIG_DIR`, and still start with no data at all.
While the server runs it deletes a transcript, and the next snapshot must no longer contain its rows. The fake
user's `~/.claude.json` must show up as the account without its ids, a switch to another account must reach the
open page with no new log line, `CLAUDE_CONFIG_DIR` pointed at `.claude` must find the file beside it, and no file
must mean no account. A second run lists two config folders with two logins (a Team plan, and an invented
per-token plan type): both plans must reach the page, each session must carry its own account key (also one whose
owner line comes after its calls), a session with no owner line none, prompt history must filter by account, and
no raw id may appear in a snapshot or a live update. It never touches your real data, deletes the fake home
afterwards, and stops its server even on Ctrl+C.

`scripts/lockcheck.mjs`: while this process holds a test transcript open mid-read and watches its folder
(what the server does), a separate process must be able to append, rewrite, rename, recreate and delete
the file, then delete the folder. It uses only `scripts/.tmp-lockcheck/` and deletes it. A reader that
opens with an exclusive lock makes the same steps fail with `EBUSY`; that control was run once to show
the test can catch it.

`scripts/selfcheck.mjs`:

- Independent oracle: a naive full parse must find the same replies, tool calls and turns as the store. A log line copied into another session's file (same uuid) counts once in both.
- Split ingest: each file fed in two halves, second halves in reverse order, must equal one pass, for every table and column.
- Pinned token numbers for one known session (skipped once that transcript is gone).
- Price table vs Claude Code's own per-model cost: over 90% of snapshots within 1%.
- Tailer test: a half-written line waits, a repeated line is an upsert, a truncated file is re-read. This test writes and then deletes `scripts/.tmp-selfcheck/`.

`scripts/check-palette.mjs`, for both themes:

- Every chart color has at least 3:1 contrast against the background.
- Neighboring colors differ by at least 15 (OKLab x100) in normal vision and at least 8 under simulated protan, deutan and tritan vision.
- The sequential ramp moves steadily away from the background.

Output on the developer's machine, 12 Nov 2026 (pinned-session line and palette details removed):

```
  ok  ingested 164 files, 825 MB in 1683 ms; 12505 calls, 17653 tools, 1458 turns, 1250 prompts, 1456 events, 84 sessions, 0 bad lines
  ok  unique API calls = 12416 (matches naive parse)
  ok  advisor calls as own rows: 89
  ok  all 17653 tool_use ids present
  ok  turn_duration rows = 1458
  ok  tokens: 4.23B counted once per response; 12.11B if every log line is counted (2.86x, the every-line count)
  ok  split + reordered ingest == single pass (all tables, all columns, session counters)
  ok  price table within 1% of Claude Code's own cost on 447/463 snapshots
  ok  costOf arithmetic + unpriced sentinel
  ok  tailer: partial line waits, duplicate is an upsert, truncation re-reads

selfcheck PASS

palette PASS
```

## Configuration

| Variable | Default | What it sets |
| --- | --- | --- |
| `PORT` | `7420` | HTTP port |
| `CLAUDE_CONFIG_DIR` | `~/.claude` (plus `~/.config/claude` if it exists) | Claude Code data folder(s); a comma-separated list is allowed. `projects/` and `history.jsonl` are read from each, and `.claude.json` (inside it or, for a folder named `.claude`, beside it): the first is the current login, every one teaches its plan |
| `XDG_CONFIG_HOME` | `~/.config` | Only for the undocumented `~/.config/claude` fallback |
| `CLAUDE_PROJECTS_DIR` | `<each data folder>/projects` | Transcript folder(s) only; overrides the above for transcripts |
| `REBUILD_GAP_MS` | `10000` | Shortest time between two full re-reads after transcripts were deleted or rewritten (Claude Code's cleanup deletes in bursts). The checks set `0` |

- PowerShell: `$env:PORT=7421; node server.mjs`
- bash or zsh (macOS, Linux): `PORT=7421 node server.mjs`
- `npm run check` finds the transcripts the same way as the server, and also tests the folder discovery itself for Linux, macOS and Windows home folders.
- New model: add it to `PRICES` in `lib/pricing.mjs` as `[input, output, cache read]` in $ per million tokens, then run `npm run check`. Ids with a date suffix or a `[...]` tag match their base entry.

## Possible next steps

Not built:

- Export of the charts (Sessions and the cost breakdown already download as CSV).
- Keyboard reading for the small performance charts, the day strips and the session drawer's chart (the sparkline, 5-hour windows and heatmap have it).
- An on-disk index cache for instant start-up.
- Budget alerts and desktop notifications.
- Comparing two time ranges side by side.
- A GitHub-style year calendar.
- Cost per git commit.
- Exporting a shareable image of the dashboard.
- Splitting usage by account before Claude Code 2.1.317 (those sessions recorded no account).
- `billingType` from `.claude.json` (its values haven't been checked yet).

## Troubleshooting

- **`node` is not recognized / command not found, or the server fails with a syntax error.** Node.js is missing or older than 22. Install it (Quick start, step 1), open a new terminal, and check `node --version`.
- **Port already in use.** The server stops with an `EADDRINUSE` error. Stop the other process, or start on another port (see Configuration) and open that port.
- **Blank page, connection refused, or "Connecting" that never changes.** The server is not running. Start it with `npm start` and wait for the URL line; the first start reads every log before it accepts connections.
- **`403 forbidden host`.** The request arrived under another host name or port, for example through a hosts-file alias, a proxy, a tunnel or a forwarded port. Open http://127.0.0.1:7420 or http://localhost:7420 directly.
- **Numbers differ from `/stats`.** Expected. `/stats` showed a token total close to the every-log-line count, about 2.9x higher. This dashboard counts each reply once, which agrees with Claude Code's own cost counter. The Tokens tile shows both. See accuracy point 1.
- **Cost is below Claude Code's own counter.** Background cost is added per saved counter: a session's calls after its last saved counter get none until Claude Code saves the counter again. It is also left out while a model filter is on or subagent or advisor calls are hidden.
- **Badge says "Disconnected · retrying".** The server stopped or answered with an error. The page retries after 2, 4, 8 … up to 30 s and reconnects by itself once the server is back.
- **Some calls cost $0.** Their model has no price in `lib/pricing.mjs`. Add it (see Configuration).
- **The big number says "Estimated cost at API prices", or an account shows "plan not known yet".** The dashboard hasn't seen that account's login yet: open it once while Claude Code is logged into that account, and its plan is remembered from then on. Sessions from before Claude Code 2.1.317 recorded no account and stay unknown. A project that uses an API key: mark it in Filters → Billing.
- **Account panel says "No Claude login found".** Claude Code is logged out, uses an API key (no Claude account), or has not saved the account yet: run `/login` in Claude Code. If you set `CLAUDE_CONFIG_DIR` for the dashboard only, point it at the same folder Claude Code uses.
- **Older days are empty.** Those transcripts are no longer on disk; Claude Code can delete old ones (the `cleanupPeriodDays` setting).
- **Terminal says `fs.watch unavailable`.** Updates still arrive through the 4 s rescan, just a little later.

## Contributing

Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Found a security problem? Please
report it privately, as [SECURITY.md](SECURITY.md) explains. Everyone taking part follows the
[code of conduct](CODE_OF_CONDUCT.md). Changes per version are in [CHANGELOG.md](CHANGELOG.md).

## License

MIT, see [`LICENSE`](LICENSE). The Geist and Geist Mono fonts in `public/fonts` keep their own license, the SIL Open
Font License ([`public/fonts/LICENSE.txt`](public/fonts/LICENSE.txt)).
