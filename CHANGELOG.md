# Changelog

## 0.2.0 (15 Nov 2026)

- Account panel at the top: the email, plan (with its usage-limit tier, e.g. Team 5x or Max 20x) and organization of the account Claude Code is logged in with. It updates live, without a reload, when Claude Code saves a new login. Reads only `~/.claude.json`; login tokens are never opened.
- "Hide email & org" button on the Account panel, for screenshots and screen sharing. Hidden values are left out of the page, not blurred. The choice is saved in the browser.
- Fix: when a subagent's transcript repeated the main thread's Agent call that launched it, that call counted as main or subagent depending on which file was read first. It now always counts as main. Totals don't change; only the by-agent split does.
- MIT license.

## 0.1.0

- First version: live local dashboard of Claude Code spend, tokens, models, tools, sessions and 5-hour windows.
