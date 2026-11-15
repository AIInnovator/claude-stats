// Shared and browser state machines. Each has ONE state type and ONE pure transition function:
//   step(state, event) -> { state, effects }
// The page (and the server's store, for the first two) only performs the effects; nothing else changes these
// states. An event the current state does not accept leaves it unchanged and returns the effect 'invalid'.
// Plain functions with no DOM access, so scripts/machinecheck.mjs can test every one in Node.

const result = (state, ...effects) => ({ state, effects });
const invalid = (state) => result(state, 'invalid');

// ---------------------------------------------------------------------------------------------------------------
/**
 * A tool call row, assembled from the assistant's tool_use and the user's tool_result (either can come first,
 * or alone). Stored as a number in the store's `ts` column.
 * @typedef {0 | 1 | 2 | 3} ToolState   NONE | CALL (call seen) | RESULT (only the result seen) | COMPLETE
 * Events: 'call' | 'result'.  A RESULT row has no call: its model, tool name and call row are unknown.
 */
export const TOOL_NONE = 0, TOOL_CALL = 1, TOOL_RESULT = 2, TOOL_COMPLETE = 3;
export const hasCall = (s) => s === TOOL_CALL || s === TOOL_COMPLETE;
export function toolStep(s, e) {
  if (e === 'call') return result(s === TOOL_RESULT || s === TOOL_COMPLETE ? TOOL_COMPLETE : TOOL_CALL);
  if (e === 'result') return result(s === TOOL_CALL || s === TOOL_COMPLETE ? TOOL_COMPLETE : TOOL_RESULT);
  return invalid(s);
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * Claude Code's own cost counter for one session, as the snapshots it saves in the transcript.
 * @typedef {{ kind: 'uncovered' }
 *   | { kind: 'covered', snaps: Array<{ at: number, cost: number, models: Record<string, number> }> }} CounterState
 * Event: { type: 'snapshot', at, cost, models }  (at = time of the last line before it in the same file)
 * Snapshots are only ever added, kept in time order; the same snapshot twice is one. So covered never goes back
 * to uncovered, and the spend attributed to a period never changes once a later snapshot closes it.
 */
export const COUNTER_EMPTY = Object.freeze({ kind: 'uncovered' });
export function counterStep(s, e) {
  if (e.type !== 'snapshot' || !Number.isFinite(e.at) || !Number.isFinite(e.cost)) return invalid(s);
  const snaps = s.kind === 'covered' ? s.snaps : [];
  if (snaps.some((x) => x.at === e.at && x.cost === e.cost)) return result(s);
  const next = [...snaps, { at: e.at, cost: e.cost, models: e.models || {} }].sort((x, y) => x.at - y.at || x.cost - y.cost);
  return result({ kind: 'covered', snaps: next });
}

/** First snapshot at or after t (the period that contains t), or -1 when t is after the last snapshot. */
export function intervalOf(ats, t) {
  let lo = 0, hi = ats.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (ats[mid] >= t) { k = mid; hi = mid - 1; } else lo = mid + 1; }
  return k;
}

/**
 * Background spend per period, derived from a CounterState and the session's logged calls [{ t, cost, model }].
 * Period k runs from snapshot k-1 to snapshot k. Its counter increase minus its logged cost is spend Claude Code
 * billed but never logged; it is spread over that period's calls in proportion to their cost (factor ≤ 3).
 * Calls after the last snapshot get nothing yet: their counter has not been saved. No clock is involved.
 */
export function attribution(counter, calls) {
  if (counter.kind !== 'covered') return null;
  const ats = [], incs = [], incModels = [];
  let prev = 0;
  const prevM = {};
  for (const sn of counter.snaps) {
    const cost = Math.max(prev, sn.cost); // a counter never goes down: a process that restarted at 0 adds nothing until it passes the old max
    const im = {};
    for (const [m, c] of Object.entries(sn.models)) { const cur = Math.max(prevM[m] || 0, c); im[m] = cur - (prevM[m] || 0); prevM[m] = cur; }
    ats.push(sn.at); incs.push(cost - prev); incModels.push(im); prev = cost;
  }
  const logged = ats.map(() => 0), loggedM = ats.map(() => ({}));
  for (const c of calls) {
    const k = intervalOf(ats, c.t);
    if (k < 0) continue;
    logged[k] += c.cost; loggedM[k][c.model] = (loggedM[k][c.model] || 0) + c.cost;
  }
  const factors = [], fracs = [];
  for (let k = 0; k < ats.length; k++) {
    factors.push(logged[k] > 0 && incs[k] > logged[k] ? Math.min(3, incs[k] / logged[k]) : 1);
    const parts = Object.entries(incModels[k]).map(([m, c]) => [m, Math.max(0, c - (loggedM[k][m] || 0))]).filter(([, g]) => g > 0);
    const g = parts.reduce((x, [, v]) => x + v, 0);
    fracs.push(g > 0 ? parts.map(([m, v]) => [m, v / g]) : []);
  }
  return { ats, factors, fracs, counterCost: prev, loggedCovered: logged.reduce((x, y) => x + y, 0) };
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * The live connection to the server (Server-Sent Events).
 * @typedef {{ kind: 'connecting', attempt: number } | { kind: 'live' } | { kind: 'reconnecting', attempt: number }
 *   | { kind: 'waiting', attempt: number }} ConnState
 * Events: { type: 'snapshot' } | { type: 'delta' } | { type: 'error', closed } | { type: 'retry' }
 *   closed = the browser gave up on this stream (EventSource CLOSED) and will not retry by itself.
 * Effects: 'applySnapshot' | 'applyDelta' | 'close' | 'open' | { kind: 'retry', ms }
 */
export const CONN_START = Object.freeze({ kind: 'connecting', attempt: 0 });
export function connStep(s, e) {
  switch (e.type) {
    case 'snapshot': return result({ kind: 'live' }, 'applySnapshot');
    case 'delta': return s.kind === 'live' ? result(s, 'applyDelta') : invalid(s); // a delta needs the snapshot it builds on
    case 'error': {
      const attempt = s.attempt || 0;
      if (e.closed) return result({ kind: 'waiting', attempt: attempt + 1 }, 'close', { kind: 'retry', ms: Math.min(30000, 1000 * 2 ** (attempt + 1)) });
      return s.kind === 'waiting' ? invalid(s) : result({ kind: 'reconnecting', attempt }); // the browser retries this one itself
    }
    case 'retry': return s.kind === 'waiting' ? result({ kind: 'connecting', attempt: s.attempt }, 'open') : invalid(s);
    default: return invalid(s);
  }
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * Redraw scheduling and the first-load latch.
 * @typedef {{ phase: 'loading' | 'ready', frame: 'idle' | 'pending' }} RenderState
 * Events: { type: 'request' } | { type: 'frame' } | { type: 'drawn' }   ('drawn' comes even when a panel failed)
 * Effects: 'requestFrame' | 'draw' | 'firstReady'
 */
export const RENDER_START = Object.freeze({ phase: 'loading', frame: 'idle' });
export function renderStep(s, e) {
  switch (e.type) {
    case 'request': return s.frame === 'pending' ? result(s) : result({ ...s, frame: 'pending' }, 'requestFrame');
    case 'frame': return s.frame === 'pending' ? result({ ...s, frame: 'idle' }, 'draw') : invalid(s);
    case 'drawn': return s.phase === 'loading' ? result({ ...s, phase: 'ready' }, 'firstReady') : result(s);
    default: return invalid(s);
  }
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * The session drawer. Tokens tie each animation frame and hide timer to the open/close that asked for it, so a
 * late frame or timer from an earlier action is rejected instead of re-opening or hiding the drawer.
 * sid is the session id string, not a row index, so it survives a fresh snapshot.
 * @typedef {{ kind: 'closed', token: number } | { kind: 'opening', sid: string, token: number }
 *   | { kind: 'open', sid: string, token: number } | { kind: 'closing', token: number }} DrawerState
 * Events: { type: 'open', sid } | { type: 'frame', token } | { type: 'close' } | { type: 'hidden', token }
 *   | { type: 'dataChanged', exists }   (exists = the open session is still in the data)
 * Effects: 'show' | { kind: 'frame', token } | 'slideIn' | 'slideOut' | 'restoreFocus' | { kind: 'hideAfter', ms, token } | 'hide'
 */
export const DRAWER_CLOSED = Object.freeze({ kind: 'closed', token: 0 });
export function drawerStep(s, e) {
  switch (e.type) {
    case 'open': {
      const token = s.token + 1;
      return result({ kind: 'opening', sid: e.sid, token }, 'show', { kind: 'frame', token });
    }
    case 'frame': return s.kind === 'opening' && e.token === s.token ? result({ kind: 'open', sid: s.sid, token: s.token }, 'slideIn') : invalid(s);
    case 'close': {
      if (s.kind === 'closed' || s.kind === 'closing') return result(s);
      const token = s.token + 1;
      return result({ kind: 'closing', token }, 'slideOut', 'restoreFocus', { kind: 'hideAfter', ms: 330, token });
    }
    case 'hidden': return s.kind === 'closing' && e.token === s.token ? result({ kind: 'closed', token: s.token }, 'hide') : invalid(s);
    case 'dataChanged': return (s.kind === 'open' || s.kind === 'opening') && !e.exists ? drawerStep(s, { type: 'close' }) : result(s);
    default: return invalid(s);
  }
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * Prompt-history search. seq ties each debounce, fetch and retry to the query that started it.
 * @typedef {{ kind: 'idle' | 'debouncing' | 'loading' | 'shown' | 'failed', seq: number }} HistState
 * Events: { type: 'change' } | { type: 'debounced', seq } | { type: 'loaded', seq } | { type: 'failed', seq } | { type: 'retry', seq }
 * Effects: { kind: 'debounce', ms, seq } | { kind: 'fetch', seq } | 'render' | 'showError' | { kind: 'retry', ms, seq }
 */
export const HIST_IDLE = Object.freeze({ kind: 'idle', seq: 0 });
export function histStep(s, e) {
  const mine = e.seq === s.seq;
  switch (e.type) {
    case 'change': { const seq = s.seq + 1; return result({ kind: 'debouncing', seq }, { kind: 'debounce', ms: 180, seq }); }
    case 'debounced': return s.kind === 'debouncing' && mine ? result({ kind: 'loading', seq: s.seq }, { kind: 'fetch', seq: s.seq }) : invalid(s);
    case 'loaded': return s.kind === 'loading' && mine ? result({ kind: 'shown', seq: s.seq }, 'render') : invalid(s);
    case 'failed': return s.kind === 'loading' && mine ? result({ kind: 'failed', seq: s.seq }, 'showError', { kind: 'retry', ms: 3000, seq: s.seq }) : invalid(s);
    case 'retry': return s.kind === 'failed' && mine ? result({ kind: 'loading', seq: s.seq }, { kind: 'fetch', seq: s.seq }) : invalid(s);
    default: return invalid(s);
  }
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * Saved view settings (localStorage 'ccstats.ui'). uiStep is the only way they change; it also cleans what was
 * saved by an older version or edited by hand, so the page never shows data for a choice no control displays.
 * @typedef {typeof UI_DEFAULT} UiState
 */
export const UI_DEFAULT = Object.freeze({ range: '7d', from: '', to: '', projects: [], models: [], subagents: true, advisor: true, metric: 'cost', split: 'model', heat: 'cost', toolSort: 'calls', attr: 'agent', sort: 't0', dir: -1, sessQ: '', sessLimit: 25, usageTable: false, theme: 'system', background: true, heatRange: 'page', histRange: 'page', hideAccount: false, accounts: [], apiProjects: [] });
const ENUMS = {
  range: ['today', '24h', '7d', '30d', '90d', 'all', 'custom', 'h1', 'h3', 'h6', 'h12'], metric: ['cost', 'tokens', 'calls'],
  split: ['model', 'tokens', 'project', 'agent'], heat: ['cost', 'calls', 'turn', 'speed', 'fail', 'reply', 'plen'],
  heatRange: ['page', '7d', '30d', '90d', 'all'], histRange: ['page', '24h', '7d', '30d', 'all'], toolSort: ['calls', 'errors'],
  attr: ['agent', 'skill', 'plugin', 'mcp', 'branch'], sort: ['t0', 'title', 'span', 'active', 'prompts', 'calls', 'tools', 'tok', 'cost', 'cc'],
  dir: [1, -1], theme: ['system', 'light', 'dark'],
};
const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
export function uiStep(ui, patch) {
  const next = { ...UI_DEFAULT, ...ui, ...patch };
  for (const [k, allowed] of Object.entries(ENUMS)) if (!allowed.includes(next[k])) next[k] = UI_DEFAULT[k];
  for (const k of ['subagents', 'advisor', 'background', 'usageTable', 'hideAccount']) if (typeof next[k] !== 'boolean') next[k] = UI_DEFAULT[k];
  for (const k of ['projects', 'models', 'accounts', 'apiProjects']) next[k] = Array.isArray(next[k]) ? [...new Set(next[k].filter((x) => typeof x === 'string' && x))] : [];
  if (typeof next.sessQ !== 'string') next.sessQ = '';
  next.sessLimit = Number.isInteger(next.sessLimit) ? Math.min(10000, Math.max(25, next.sessLimit)) : 25;
  if (!DATE.test(next.from)) next.from = '';
  if (next.to !== 'now' && !DATE.test(next.to)) next.to = '';
  if (next.range === 'custom' && !next.from) next.range = UI_DEFAULT.range; // a custom range needs a start
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// Accounts and billing: pure rules, tested in scripts/machinecheck.mjs.

/**
 * How a session's usage is billed: 'sub' (a subscription covers it), 'api' (per-token) or 'unknown'. Never guesses
 * 'api': an owner line names a Claude account, so it is classed by that account's plan (unknown until learned);
 * only a session with no account recorded can be per-token by the owner's own label on its project.
 */
export function billingClass(rec, hasKey, projectMarkedApi) {
  if (!hasKey) return projectMarkedApi ? 'api' : 'unknown';
  const type = rec?.type || '';
  return !type ? 'unknown' : type.startsWith('claude_') ? 'sub' : 'api';
}

/** Remembered plans by account key. A record changes only when its plan, tier, org or day does; no email is kept. */
export function mergeAccounts(memory, entries, today) {
  let next = null;
  for (const e of entries || []) {
    if (!e || typeof e.key !== 'string' || !e.key) continue;
    const old = (next || memory)[e.key] || {};
    // an empty field never erases what an earlier login taught
    const rec = { type: e.type || old.type || '', tier: e.tier || old.tier || '', org: e.org || old.org || '', seen: today };
    if (old.type === rec.type && old.tier === rec.tier && old.org === rec.org && old.seen === rec.seen) continue;
    next = { ...(next || memory), [e.key]: rec };
  }
  return { memory: next || memory, changed: !!next };
}

/** The account the 5-hour windows follow: the one picked in the filter, else the current login, else the most used. */
export function followAccount(picked, currentKey, usageByKey) {
  const real = (picked || []).filter((k) => k !== 'none');
  if (real.length === 1) return real[0];
  if (currentKey) return currentKey;
  let best, max = -Infinity;
  for (const [k, v] of usageByKey || []) if (k !== 'none' && v > max) { best = k; max = v; }
  return best;
}

/** Dotted version compare: '2.10.0' is at least '2.1.317'. Anything unparsable is not. */
export function verAtLeast(v, min) {
  const a = String(v || '').split('.').map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < b.length; i++) { const x = a[i] || 0; if (Number.isNaN(x)) return false; if (x !== b[i]) return x > b[i]; }
  return true;
}

/** One CSV cell. Text that starts with = + - @ gets a leading ' so a spreadsheet never runs it as a formula
 * (session titles come from the logs); numbers stay numbers. */
export function csvCell(v) {
  let t = String(v ?? '');
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

// Links to a view: range and filters in the page address. An address that names a view wins for its tab (filters it
// doesn't list mean none). In presenting mode project paths stay out of it; 'ph=1' keeps the saved project filter.
const VIEW_FLAGS = [['sub', 'subagents'], ['adv', 'advisor'], ['bg', 'background']];
export function viewFromQuery(search) {
  const q = new URLSearchParams(search);
  if (!q.has('range')) return {};
  const v = { range: q.get('range'), from: q.get('from') || '', to: q.get('to') || '', models: q.getAll('m'), accounts: q.getAll('a') };
  if (!q.has('ph')) v.projects = q.getAll('p');
  for (const [k, key] of VIEW_FLAGS) v[key] = q.get(k) !== '0';
  return v;
}
export function viewToQuery(ui) {
  const q = new URLSearchParams({ range: ui.range });
  if (ui.range === 'custom') { q.set('from', ui.from); q.set('to', ui.to); }
  if (ui.hideAccount) { if (ui.projects.length) q.set('ph', '1'); } else for (const p of ui.projects) q.append('p', p);
  for (const m of ui.models) q.append('m', m);
  for (const a of ui.accounts) q.append('a', a);
  for (const [k, key] of VIEW_FLAGS) if (!ui[key]) q.set(k, '0');
  return q.toString();
}

/** A filter's chosen names against the names present in the data. Names with no data match nothing and are listed. */
export function selection(names, dictList) {
  if (!names.length) return null;
  const idx = new Set(), unavailable = [];
  for (const n of names) { const i = dictList.indexOf(n); if (i > 0) idx.add(i); else unavailable.push(n); }
  return { idx, unavailable };
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * Popovers (Dates, Filters): at most one open.
 * @typedef {{ kind: 'closed' } | { kind: 'open', id: string }} PopState
 * Events: { type: 'toggle', id } | { type: 'close', id?, refocus? } | { type: 'dataChanged', focusInside }
 * Effects: { kind: 'open' | 'close' | 'refresh', id, refocus? }
 */
export const POP_CLOSED = Object.freeze({ kind: 'closed' });
export function popStep(s, e) {
  switch (e.type) {
    case 'toggle':
      if (s.kind === 'open' && s.id === e.id) return result(POP_CLOSED, { kind: 'close', id: e.id, refocus: false });
      return result({ kind: 'open', id: e.id }, ...(s.kind === 'open' ? [{ kind: 'close', id: s.id, refocus: false }] : []), { kind: 'open', id: e.id });
    case 'close':
      return s.kind === 'open' && (!e.id || e.id === s.id) ? result(POP_CLOSED, { kind: 'close', id: s.id, refocus: !!e.refocus }) : result(s);
    case 'dataChanged': // refresh an open popover's contents, but never under the user's focus
      return s.kind === 'open' && !e.focusInside ? result(s, { kind: 'refresh', id: s.id }) : result(s);
    default: return invalid(s);
  }
}
