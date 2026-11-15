// Where Claude Code keeps its data, on any OS and for any user. Read-only: nothing here creates folders.
//
// 1. CLAUDE_CONFIG_DIR, if set, is authoritative: Claude Code's docs say every ~/.claude path moves under it.
//    A comma-separated list is accepted too, for people who keep several config folders.
// 2. Otherwise: ~/.claude, the documented location on every OS (on Windows %USERPROFILE%\.claude, which
//    os.homedir() returns). Also $XDG_CONFIG_HOME/claude (~/.config/claude): NOT in Claude Code's docs,
//    checked only because some community tools look there; it is read only if it exists.
//    The same reply found in two folders is still counted once (rows are keyed by id).
// 3. CLAUDE_PROJECTS_DIR, if set, replaces the transcript folders only (handy for tests).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Candidate config folders, in priority order, de-duplicated. `home` and `env` are injectable for tests. */
export function configCandidates(env = process.env, home = os.homedir(), p = path) {
  const out = [];
  const add = (d) => { if (!d) return; const r = p.resolve(d.replace(/^~(?=$|[\\/])/, home)); if (!out.includes(r)) out.push(r); };
  if (env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR.split(',').map((s) => s.trim()).filter(Boolean).forEach(add);
  else { add(p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'claude')); add(p.join(home, '.claude')); }
  return out;
}

/** The folders actually present on this machine: transcript roots and prompt-history files. */
export function claudePaths(env = process.env, home = os.homedir(), exists = { dir: isDir, file: isFile }, p = path) {
  const configs = configCandidates(env, home, p);
  const projects = env.CLAUDE_PROJECTS_DIR
    ? env.CLAUDE_PROJECTS_DIR.split(',').map((s) => p.resolve(s.trim())).filter(Boolean)
    : configs.map((d) => p.join(d, 'projects')).filter((d) => exists.dir(d));
  const history = configs.map((d) => p.join(d, 'history.jsonl')).filter((f) => exists.file(f));
  // The logged-in account (email, plan) is in .claude.json: in the home folder by default, inside CLAUDE_CONFIG_DIR when
  // that is set, or beside it when it points at a .claude folder laid out the default way (e.g. a WSL home). Only a
  // folder named .claude looks beside itself: a custom folder must not pick up the home folder's (other) login.
  const account = (env.CLAUDE_CONFIG_DIR
    ? configs.flatMap((d) => [p.join(d, '.claude.json'), ...(p.basename(d) === '.claude' ? [p.join(d, '..', '.claude.json')] : [])])
    : [p.join(home, '.claude.json')]).filter((f) => exists.file(f));
  return { configs, projects, history, account };
}
