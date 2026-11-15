# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org).

## 1.0.0 (15 Nov 2026)

Install and project
- One-line installers: `install.sh` for macOS and Linux, `install.ps1` for Windows. Each one:
  - installs the current Node.js LTS when Node 22+ is missing
  - downloads the latest release into `~/.claude-stats`
  - starts the dashboard

  Re-run to update. An installer never replaces a folder that isn't a claude-stats install.
- CI runs every check and both installers on Windows, macOS and Linux, with Node 22 and the current LTS. Tags publish GitHub releases with these notes.
- The self-check runs on machines without Claude Code logs: it skips only the real-log comparisons and says so.
- `npm test`, contributing guide, security policy, code of conduct, issue and pull request templates, `.editorconfig`, and LF line endings everywhere.

Accounts and billing
- Each session is tied to the account that ran it (Claude Code 2.1.317+ records it), through a one-way key; raw ids never reach the page.
- The big number follows how usage is billed: "API-equivalent cost" for subscription usage, "API spend (estimated)" for per-token usage, "Estimated cost at API prices" when unknown. Unknown usage is never shown as spend.
- Accounts filter; 5-hour windows follow one account; Filters → Billing lets you mark projects that use an API key ("likely" ones are suggested, never switched on for you).
- Plans of every login found are learned and remembered in the browser (never the email). "Extra usage on/off" in the Account row.
- Neutral wording: "Spend" is "Cost" (at API prices) everywhere else.

Layout and look
- Three zones (Cost, Activity, Records) with a jump menu; the 5-hour windows sit right under the key numbers, which gain "This month … heading for".
- The Account panel is one slim row with an eye button.
- On phones the top bar is one row: the range buttons move into the Dates menu.
- Methodology notes fold into "How this is measured"; the cost breakdown hides columns with nothing in them; the Usage chart grows with the Models card beside it (never past most of a screen, and it shrinks back); the heatmap is shorter.

Privacy
- The eye is Presenting mode: email, organization names and your user-folder name in paths (text, tooltips and attributes) leave the page, and prompts fold behind "Show prompts".

Power-user
- Keyboard shortcuts (`?` lists them); links to a view (range and filters in the address); next / previous session in its details; CSV export of Sessions and the cost breakdown; prompt history can load every prompt.

Accessibility
- Screen readers hear the live status only when it changes; buttons keep their names on phones; light-theme status colours pass contrast; a page heading; keyboard-expandable prompts; chart values readable with the arrow keys; motion respects "reduce motion" without losing fades.

Fixes
- Filters amounts use the page range, like the panels; active filters show as removable chips.
- A panel that fails to draw says so in its card.

Second design review (25 fixes)
- Money labels follow the billing everywhere (tiles, 5-hour windows, sessions, drawer, sparkline): "API-eq. cost", "API spend" or "Cost", never a bare "Cost" on subscription usage. The month tile and cache savings say "at API prices".
- 5-hour windows lead with the limit on a plan (time to reset, limit hits), have a time axis, and say when filters don't apply. Limit hits from sessions with no account recorded are counted apart.
- Sessions and the drawer use one wording: cost = logged calls + background share, beside "Claude Code's counter". The drawer says "3 of 46" and notes when the range or filters cut the session.
- Presenting mode also hides session titles and branch names; `p` toggles it.
- Filters: idle projects fold away, Billing sits above Projects, "Clear filters" only when something is filtered; removing a chip keeps keyboard focus nearby. The Account row gains "API-key projects (N)", and "Extra usage" explains itself on click.
- Tiles that model or agent filters can't narrow say "all models & agents"; "How Claude worked" is a full grid of 12 facts (web searches got their own).
- Phone top bar: short range label ("7d"), short live state, logo-only brand; one row down to 390 px. Touch targets 44 px (jump menu, folds, table rows).
- Keyboard: heatmap starts on the busiest hour and reads "No activity" for empty hours; the zone marker follows jump-menu clicks; quick ranges are radio groups.
- New colours for Haiku 5.5, Opus 4.8 and Sonnet 4.6, so no two models look alike (also for colour-blind viewers).
- A clear message when the dashboard server can't be reached; the Background row in Models is no longer a button that does nothing; "1 call" / "1 window" read correctly.

## 0.2.0 (15 Nov 2026)

- Account panel at the top: the email, plan (with its usage-limit tier, e.g. Team 5x or Max 20x) and organization of the account Claude Code is logged in with. It updates live, without a reload, when Claude Code saves a new login. Reads only `~/.claude.json`; login tokens are never opened.
- "Hide email & org" button on the Account panel, for screenshots and screen sharing. Hidden values are left out of the page, not blurred. The choice is saved in the browser.
- Fix: when a subagent's transcript repeated the main thread's Agent call that launched it, that call counted as main or subagent depending on which file was read first. It now always counts as main. Totals don't change; only the by-agent split does.
- MIT license.

## 0.1.0

- First version: live local dashboard of Claude Code spend, tokens, models, tools, sessions and 5-hour windows.
