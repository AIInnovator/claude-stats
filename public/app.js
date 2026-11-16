// Claude Code stats: client. Holds the columnar store from the server, aggregates in the browser, patches the DOM.
// Rule: every string that came from the logs (titles, paths, prompts, tool names) goes through textContent only.
import { PALETTES, MODEL_ORDER } from './palette.js';
import {
  hasCall, intervalOf, attribution, CONN_START, connStep, RENDER_START, renderStep, DRAWER_CLOSED, drawerStep,
  HIST_IDLE, histStep, UI_DEFAULT, uiStep, selection, POP_CLOSED, popStep, billingClass, mergeAccounts, planLabel, followAccount, verAtLeast,
  csvCell, viewFromQuery, viewToQuery,
} from './machines.js';

// Active palette (swapped on theme change; each theme's set is validated against its own surface).
let CATEGORICAL, OTHER, TOKEN_COLORS, SEQUENTIAL, STATUS, SURFACE, EFFORT_COLOR;
function usePalette(theme) {
  ({ CATEGORICAL, OTHER, TOKEN_COLORS, SEQUENTIAL, STATUS, SURFACE } = PALETTES[theme]);
  EFFORT_COLOR = { low: SEQUENTIAL[2], medium: SEQUENTIAL[3], high: SEQUENTIAL[4], xhigh: SEQUENTIAL[5], max: SEQUENTIAL[6] };
}
usePalette(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

// ---------------------------------------------------------------- DOM helpers
const $ = (id) => document.getElementById(id);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(3)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'text') el.textContent = v; else el.setAttribute(k, v);
  }
  for (const c of kids.flat(3)) if (c) el.append(c);
  return el;
}
const fill = (el, ...kids) => { el.replaceChildren(...kids.flat(3).filter(k => k != null && k !== false)); return el; };
const icon = (d) => s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, s('path', { d }));

// ---------------------------------------------------------------- formatting
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nfc = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const cur = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd = (v) => cur.format(v || 0);
const usdShort = (v) => (!v ? '$0' : v >= 1000 ? '$' + nfc.format(v) : v >= 100 ? '$' + nf0.format(v) : '$' + v.toFixed(v >= 10 ? 1 : 2));
const num = (v) => nfc.format(v || 0);
const int = (v) => nf0.format(v || 0);
const nCalls = (n) => `${int(n)} call${n === 1 ? '' : 's'}`;
const pct = (v, d = 0) => (isFinite(v) ? (v * 100).toFixed(d) + '%' : '–');
function dur(ms) {
  const sec = Math.round((ms || 0) / 1000);
  if (sec < 60) return sec + 's';
  const m = Math.round(sec / 60);
  if (m < 60) return m + 'm';
  const hh = Math.floor(m / 60);
  return hh >= 48 ? `${Math.floor(hh / 24)}d ${hh % 24}h` : `${hh}h ${String(m % 60).padStart(2, '0')}m`;
}
const fDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fWeekday = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const fDateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const ago = (t) => { const d = Date.now() - t; return d < 5e3 ? 'just now' : d < 6e4 ? Math.round(d / 1e3) + 's ago' : d < 36e5 ? Math.round(d / 6e4) + 'm ago' : dur(d) + ' ago'; };
const isoDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---------------------------------------------------------------- state
// Saved view settings change only through uiStep (public/machines.js), which also cleans old or hand-edited values.
let ui = UI_DEFAULT;
try { ui = uiStep(UI_DEFAULT, JSON.parse(localStorage.getItem('ccstats.ui') || '{}')); } catch { /* corrupt storage: defaults */ }
// Links to a view (public/machines.js): range and filters also live in the address, so a view can be bookmarked or
// two tabs can show two views.
function syncUrl() { const q = '?' + viewToQuery(ui); if (q !== location.search) history.replaceState(null, '', q); }
ui = uiStep(ui, viewFromQuery(location.search));
syncUrl();
const save = () => localStorage.setItem('ccstats.ui', JSON.stringify(ui));
const set = (patch) => {
  ui = uiStep(ui, patch); save(); syncUrl(); render();
  if ('range' in patch || 'from' in patch || 'projects' in patch || 'accounts' in patch || 'histRange' in patch) loadHistory(); // history follows its range, project and account
};

let D = null;           // { dicts, tables, sessions: Map, meta, version }
let lastPush = 0;
const expanded = new Set();

function applySnapshot(snap) {
  D = { dicts: snap.dicts, tables: snap.tables, meta: snap.meta, sessions: new Map(Object.entries(snap.sessions).map(([k, v]) => [+k, v])), version: (D ? D.version : 0) + 1 }; // keep counting so caches built before a reconnect are invalidated
  // the drawer follows its session by id; a fresh snapshot (server restart, rebuild) may no longer contain it
  if (dr.kind === 'open' || dr.kind === 'opening') drawerEvent({ type: 'dataChanged', exists: D.dicts.session.includes(dr.sid) });
  rememberAccounts();
}
function applyDelta(dl) {
  for (const [k, [start, vals]] of Object.entries(dl.dicts)) vals.forEach((v, i) => { D.dicts[k][start + i] = v; });
  for (const [name, tb] of Object.entries(dl.tables)) {
    const T = D.tables[name];
    for (const [c, vals] of Object.entries(tb.cols)) { const col = T.cols[c]; tb.idx.forEach((ix, j) => { col[ix] = vals[j]; }); }
    T.n = Math.max(T.n, tb.n);
  }
  for (const [k, v] of Object.entries(dl.sessions)) D.sessions.set(+k, v);
  D.meta = dl.meta;
  D.version++;
  rememberAccounts();
}

// ---------------------------------------------------------------- labels & colours
const modelColor = (name) => { const i = MODEL_ORDER.indexOf(name); return i >= 0 ? CATEGORICAL[i] : OTHER; };
const modelName = (m) => (m || '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1').replace(/^./, (c) => c.toUpperCase());
// Presenting mode (the Account row's eye): the user-folder name, often the person's own name, leaves every path the page
// shows, as text or tooltip. Paths stay whole in the data, so filters and search keep working.
const maskPath = (p) => (ui.hideAccount && p ? String(p).replace(/(^|[\\/])(Users|home)([\\/])[^\\/]+/i, '$1$2$3…') : p);
function projLabel(p) {
  const parts = (maskPath(p) || '').split(/[\\/]/).filter(Boolean);
  return { name: parts.at(-1) || p || '(unknown)', parent: parts.slice(-3, -1).join('\\') };
}
const AGENT = { main: 'Main thread', subagent: 'Subagent' };
const agentName = (a) => AGENT[a] || a || '–';
function toolLabel(n) {
  const m = /^mcp__(.+?)__(.+)$/.exec(n || '');
  return m ? { name: m[2], prefix: m[1] } : { name: n || 'Unknown tool (call not in logs)', prefix: '' }; // a result whose call no transcript holds
}
const PERM = {
  'accept:config': 'Auto-allowed (rules or mode)', 'accept:user_temporary': 'You allowed once', 'accept:user_permanent': 'You allowed always',
  'accept:hook': 'Allowed by a hook', 'reject:user_reject': 'You rejected', 'reject:config': 'Blocked by rules', 'reject:hook': 'Blocked by a hook',
  'cancelled:user_abort': 'Cancelled',
};
const DENY = { 'permission-rule': 'Blocked by a rule', 'automode-blocked': 'Blocked by auto mode', cancelled: 'Cancelled', 'user-rejected': 'You rejected', interrupted: 'Interrupted', 'automode-unavailable': 'Auto mode unavailable' };
const STOP = { tool_use: 'Called a tool', end_turn: 'Finished a turn', refusal: 'Refused', max_tokens: 'Hit max tokens', stop_sequence: 'Stop sequence' };
const KIND = { model_refusal_fallback: 'Refused, retried on a fallback model', model_refusal_no_fallback: 'Refused, no fallback', 'api_error:connection_failed': 'Connection failed', 'api_error:usage_limit_reached': 'Usage limit reached' };
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
const TOKEN_LABEL = { out: 'Output', in: 'Input', cw: 'Cache write', cr: 'Cache read' };
const RANGES = [{ v: 'today', label: 'Today' }, { v: '24h', label: '24h' }, { v: '7d', label: '7 days' }, { v: '30d', label: '30 days' }, { v: '90d', label: '90 days' }, { v: 'all', label: 'All' }];
const HOURS = { h1: 1, h3: 3, h6: 6, h12: 12 }; // rolling "last N hours" ranges from the Dates popover
const NARROW = matchMedia('(max-width: 1020px)'); // matches the CSS that moves the range buttons into the Dates menu
const ROLLING = new Set(['today', '24h', 'h1', 'h3', 'h6', 'h12']);
function liveEnd() { return ui.range === 'custom' && ui.to === 'now'; } // custom range whose end follows the clock
function isRolling() { return ROLLING.has(ui.range) || liveEnd(); }
const PREV = { today: 'same hours yesterday', '24h': 'prev 24h', '7d': 'prev 7 days', '30d': 'prev 30 days', '90d': 'prev 90 days', all: 'before', custom: 'prev period', h1: 'prev hour', h3: 'prev 3h', h6: 'prev 6h', h12: 'prev 12h' };
const UNIT = { m5: '5 min', m15: '15 min', hour: 'hour', day: 'day', week: 'week' };

let priceCache = { v: -1, byModel: [] };
function priceOf(mIdx) {
  if (priceCache.v !== D.version) {
    const P = D.meta.prices, keys = Object.keys(P).sort((a, b) => b.length - a.length);
    priceCache = { v: D.version, byModel: D.dicts.model.map((m) => { const id = (m || '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, ''); return P[id] || P[keys.find((k) => id.startsWith(k))] || null; }) };
  }
  return priceCache.byModel[mIdx];
}

// ---------------------------------------------------------------- time range & buckets
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return +d; };
const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return +d; };
// key: the page range by default; the heatmap and prompt history can pass their own ('page' = follow the page)
function rangeBounds(key = ui.range) {
  if (key === 'page') key = ui.range;
  const now = Date.now(), d0 = dayStart(now);
  if (HOURS[key]) return [now - HOURS[key] * 36e5, now];
  switch (key) {
    case '7d': return [addDays(d0, -6), now];
    case 'today': return [d0, now];
    case '24h': return [now - 864e5, now];
    case '30d': return [addDays(d0, -29), now];
    case '90d': return [addDays(d0, -89), now];
    case 'all': { const t = D.tables.req.cols.t; let min = now; for (let i = 0; i < D.tables.req.n; i++) if (t[i] && t[i] < min) min = t[i]; return [dayStart(min), now]; }
    case 'custom': {
      // 'YYYY-MM-DDTHH:MM' (date + time) or legacy 'YYYY-MM-DD' (whole days; the end day is inclusive)
      const parse = (v, end) => (!v ? NaN : v.length === 10 ? (end ? addDays(+new Date(v + 'T00:00'), 1) : +new Date(v + 'T00:00')) : +new Date(v));
      let f = parse(ui.from, false), e = ui.to === 'now' ? now : parse(ui.to, true); // 'now' = live end that keeps moving
      if (!isFinite(f)) f = addDays(d0, -6);
      if (!isFinite(e)) e = now;
      if (e < f) [f, e] = [e, f];
      return [f, Math.max(f + 5 * 6e4, e)];
    }
    default: return [addDays(d0, -6), now];
  }
}
function buckets(from, to) {
  const span = to - from;
  const unit = span <= 3.05 * 36e5 ? 'm5' : span <= 12.1 * 36e5 ? 'm15' : span <= 2.1 * 864e5 ? 'hour' : span <= 120 * 864e5 ? 'day' : 'week';
  const step = unit === 'm5' ? 5 : unit === 'm15' ? 15 : 0;
  const d = new Date(from);
  if (step) { d.setSeconds(0, 0); d.setMinutes(Math.floor(d.getMinutes() / step) * step); }
  else if (unit === 'hour') d.setMinutes(0, 0, 0);
  else { d.setHours(0, 0, 0, 0); if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); }
  const edges = [];
  while (+d < to) {
    edges.push(+d);
    if (step) d.setMinutes(d.getMinutes() + step); else if (unit === 'hour') d.setHours(d.getHours() + 1); else d.setDate(d.getDate() + (unit === 'week' ? 7 : 1));
  }
  edges.push(+d);
  return { unit, edges, n: edges.length - 1 };
}
const toLocalInput = (t) => { const d = new Date(t); return `${isoDay(t)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function rangeText(from, to) {
  if (dayStart(from) === from && dayStart(to) === to) return to - from <= 864e5 ? fWeekday.format(from) : `${fDay.format(from)} – ${fDay.format(to - 1)}`; // whole days
  if (to - from >= 2 * 864e5 && dayStart(from) === from) return `${fDay.format(from)} – ${fDay.format(to - 1)}`;
  return dayStart(from) === dayStart(to - 1) ? `${fDateTime.format(from)} – ${fTime.format(to)}` : `${fDateTime.format(from)} – ${fDateTime.format(to)}`;
}
function bucketOf(edges, t) {
  let lo = 0, hi = edges.length - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (edges[mid] <= t) lo = mid; else hi = mid - 1; }
  return lo;
}
function bucketLabel(B, b, long) {
  const t = B.edges[b];
  if (B.unit === 'hour' || B.unit[0] === 'm') return long ? `${fWeekday.format(t)} · ${fTime.format(t)}–${fTime.format(B.edges[b + 1])}` : fTime.format(t);
  if (B.unit === 'week') return (long ? 'Week of ' : '') + fDay.format(t);
  return long ? fWeekday.format(t) : fDay.format(t);
}

// ---------------------------------------------------------------- accounts: which account ran a session, and how it is billed
// The server sends a one-way key per session (from Claude Code's session-owner lines) and the plan of every login it
// finds; the browser remembers plans by key, so an account's plan stays known after you log out of it.
const ACCT_STORE = 'ccstats.accounts';
let acctMem = {};
try { acctMem = JSON.parse(localStorage.getItem(ACCT_STORE) || '{}') || {}; } catch { /* corrupt storage: start empty */ }
function rememberAccounts() {
  const r = mergeAccounts(acctMem, [D.meta.account, ...(D.meta.accounts || [])], isoDay(Date.now()));
  if (r.changed) { acctMem = r.memory; try { localStorage.setItem(ACCT_STORE, JSON.stringify(acctMem)); } catch { /* full or blocked */ } }
}
const acctOf = (s) => D.sessions.get(s)?.acct || 'none';
const planName = (type, tier) => planLabel(type, tier).short;
// per data version, settings and memory: each session's billing class, and account numbers in order of first use
let acctCache = { v: '' };
function acctInfo() {
  const v = `${D.version}|${ui.apiProjects.join('\n')}|${JSON.stringify(acctMem)}|${ui.hideAccount}`;
  if (acctCache.v === v) return acctCache;
  const api = new Set(ui.apiProjects), cls = new Map(), first = new Map();
  for (const [s, m] of D.sessions) {
    cls.set(s, billingClass(acctMem[m.acct], !!m.acct, api.has(D.dicts.project[m.p])));
    if (m.acct && (!first.has(m.acct) || m.t0 < first.get(m.acct))) first.set(m.acct, m.t0 || 0);
  }
  const num = new Map([...first].sort((a, b) => a[1] - b[1]).map(([k], i) => [k, i + 1]));
  const raw = (k) => { const rec = acctMem[k]; if (!rec?.type) return `Account ${num.get(k) || '?'} · plan not known yet`; return !ui.hideAccount && rec.org ? `${planName(rec.type, rec.tier)} · ${rec.org}` : `${planName(rec.type, rec.tier)} · account ${num.get(k) || '?'}`; };
  const labels = new Map([...num.keys()].map((k) => [k, raw(k)]));
  // two accounts reading the same (same plan and org) get their number too
  const seen = new Map(); for (const l of labels.values()) seen.set(l, (seen.get(l) || 0) + 1);
  for (const [k, l] of labels) if (seen.get(l) > 1) labels.set(k, `${l} (account ${num.get(k)})`);
  acctCache = { v, cls, num, labels };
  return acctCache;
}
const accountLabel = (k) => (k === 'none' ? 'No account recorded' : acctInfo().labels.get(k) || `Account · plan not known yet`);

// ---------------------------------------------------------------- aggregation (one pass per table)
const bump = (map, k, init) => { let v = map.get(k); if (!v) { v = init(); map.set(k, v); } return v; };
// The view's filters, shared by every panel. A chosen name with no data matches nothing (the Filters menu lists it to untick).
function filters() {
  const { dicts } = D, mainAgent = dicts.agent.indexOf('main');
  const projSel = selection(ui.projects, dicts.project), modelSel = selection(ui.models, dicts.model);
  const acctSel = ui.accounts.length ? new Set(ui.accounts) : null;
  return {
    projSel, modelSel,
    // every row carries its session; the account filter rides on the project check, so every panel gets both
    okP: (p, s) => (!projSel || projSel.idx.has(p)) && (!acctSel || acctSel.has(acctOf(s))),
    okA: (a) => ui.subagents || a === mainAgent,
    okM: (m) => !modelSel || modelSel.idx.has(m),
    // a tool result whose call is in no file has no model: under a model filter it matches nothing
    okToolModel: (T, i, R) => !modelSel || (hasCall(T.ts[i]) && modelSel.idx.has(R.m[T.r[i]])),
    // background spend belongs to a session as a whole: add it only when no model or agent filter narrows the view
    useBg: ui.background && !modelSel && ui.subagents && ui.advisor,
  };
}
function compute() {
  const [from, to] = rangeBounds();
  // "Today" compares with the same hours yesterday; every other range with the equal span right before it
  const pTo = ui.range === 'today' ? to - 864e5 : from, pFrom = ui.range === 'today' ? from - 864e5 : from - (to - from);
  const { dicts, tables } = D;
  const B = buckets(from, to);
  const R = tables.req.cols, nR = tables.req.n;
  const { okP, okA, okM, okToolModel, useBg } = filters();
  const EST = sessionEstimates(), acct = acctInfo(); // looked up once per pass, not per call

  // stable colours for project / agent splits: top 7 by all-time spend
  const allCost = { p: new Map(), a: new Map() };
  for (let i = 0; i < nR; i++) { const c = Math.max(0, R.cost[i]); allCost.p.set(R.p[i], (allCost.p.get(R.p[i]) || 0) + c); allCost.a.set(R.a[i], (allCost.a.get(R.a[i]) || 0) + c); }
  const top = (m) => new Map([...m].sort((x, y) => y[1] - x[1]).slice(0, 7).map(([k], i) => [k, i]));
  const topP = top(allCost.p), topA = top(allCost.a);

  const A = {
    from, to, B, cost: 0, in: 0, out: 0, cr: 0, cw: 0, calls: 0, adv: 0, th: 0, tdm: 0, ws: 0, wf: 0, saved: 0, unpriced: 0, fast: 0,
    prev: { cost: 0, tok: 0, calls: 0, sess: new Set(), prompts: 0, active: 0, cr: 0, inAll: 0 },
    series: new Map(), spark: new Float64Array(B.n), heat: new Float64Array(7 * 24), heatCalls: new Float64Array(7 * 24),
    models: new Map(), projects: new Map(), sessions: new Map(), agent: new Map(), skill: new Map(), plugin: new Map(), mcp: new Map(),
    effort: new Map(), stop: new Map(), tools: new Map(), perm: new Map(), deny: new Map(), kinds: new Map(),
    toolCalls: 0, toolErr: 0, toolDeny: 0, prevTools: 0, active: 0, turns: 0, longest: 0, prompts: 0, compactPre: 0, compactPost: 0,
    cc: { cost: 0, n: 0, add: 0, del: 0 }, branch: new Map(), days: new Map(), rawTok: 0, promptSrc: new Map(), bill: new Map(), bgModels: new Map(),
    hookRuns: 0, hookMs: 0, hookCount: 0, mtd: 0, check: { est: 0, cc: 0, n: 0 }, bg: 0, logged: 0,
    // by billing class (subscription, per-token, unknown): the big number shows each for what it is
    cls: Object.fromEntries(['sub', 'api', 'unknown'].map((k) => [k, { cost: 0, prev: 0, calls: 0, logged: 0, bg: 0, spark: new Float64Array(B.n) }])),
    unk: { noKey: 0, noPlan: 0 }, // why unknown: no account recorded, or the account's plan not learned yet
  };
  const seriesAdd = (key, b, v) => { if (!v) return; let arr = A.series.get(key); if (!arr) { arr = new Float64Array(B.n); A.series.set(key, arr); } arr[b] += v; };
  const metric = ui.metric, split = metric === 'calls' && ui.split === 'tokens' ? 'model' : ui.split;

  for (let i = 0; i < nR; i++) {
    const t = R.t[i];
    if (t < pFrom || t >= to || !okP(R.p[i], R.s[i]) || !okA(R.a[i]) || !okM(R.m[i]) || (!ui.advisor && R.adv[i])) continue;
    const cost = R.cost[i] > 0 ? R.cost[i] : 0, cw = R.cw5[i] + R.cw1[i], tok = R.in[i] + R.out[i] + R.cr[i] + cw;
    const bg = useBg ? bgShare(EST, R.s[i], t) : null; // this call's period of Claude Code's saved counter
    const extra = bg ? cost * (bg.factor - 1) : 0, full = cost + extra; // extra = this call's share of unlogged background spend
    if (extra && t >= from) for (const [name, f] of bg.frac) A.bgModels.set(name, (A.bgModels.get(name) || 0) + extra * f);
    const kc = acct.cls.get(R.s[i]) || 'unknown', cl = A.cls[kc];
    if (t < from) { if (t >= pTo) continue; const P = A.prev; P.cost += full; P.tok += tok; P.calls++; P.sess.add(R.s[i]); P.cr += R.cr[i]; P.inAll += R.in[i] + R.cr[i] + cw; cl.prev += full; continue; }
    cl.cost += full; cl.calls++; cl.logged += cost; cl.bg += extra;
    if (kc === 'unknown') A.unk[acctOf(R.s[i]) === 'none' ? 'noKey' : 'noPlan'] += full;
    A.cost += full; A.logged += cost; A.bg += extra; A.in += R.in[i]; A.out += R.out[i]; A.cr += R.cr[i]; A.cw += cw; A.calls++; A.adv += R.adv[i];
    A.th += R.th[i]; A.tdm += R.tdm[i]; A.ws += R.ws[i]; A.wf += R.wf[i]; A.fast += R.fast[i];
    if (!R.adv[i]) A.rawTok += tok * R.ln[i]; // what a count of every log line (Claude Code's /stats) would show
    if (R.cost[i] < 0) A.unpriced++;
    const pr = priceOf(R.m[i]);
    if (pr) A.saved += R.cr[i] * (pr[0] - pr[2]) / 1e6 * (R.fast[i] ? 2 : 1);
    // API billing breakdown: the same arithmetic as lib/pricing.mjs costOf, split by token type
    const bl = bump(A.bill, R.m[i], () => ({ calls: 0, in: 0, cw5: 0, cw1: 0, cr: 0, out: 0, ws: 0, cIn: 0, cCw5: 0, cCw1: 0, cCr: 0, cOut: 0, cWs: 0, fast: 0, tier: 0, priced: !!pr }));
    bl.calls++; bl.in += R.in[i]; bl.cw5 += R.cw5[i]; bl.cw1 += R.cw1[i]; bl.cr += R.cr[i]; bl.out += R.out[i]; bl.ws += R.ws[i];
    if (pr) {
      const tier = dicts.model[R.m[i]].startsWith('claude-haiku-5-5') && R.in[i] + R.cr[i] + R.cw5[i] + R.cw1[i] > 100_000;
      const mult = (R.fast[i] ? 2 : 1) * (tier ? 5 : 1);
      bl.fast += R.fast[i]; bl.tier += tier ? 1 : 0;
      bl.cIn += R.in[i] * pr[0] * mult / 1e6; bl.cCw5 += R.cw5[i] * pr[0] * 1.25 * mult / 1e6; bl.cCw1 += R.cw1[i] * pr[0] * 2 * mult / 1e6;
      bl.cCr += R.cr[i] * pr[2] * mult / 1e6; bl.cOut += R.out[i] * pr[1] * mult / 1e6; bl.cWs += R.ws[i] * 0.01;
    }
    const b = bucketOf(B.edges, t);
    A.spark[b] += full; cl.spark[b] += full;
    const v = metric === 'cost' ? cost : metric === 'tokens' ? tok : 1;
    if (split === 'tokens') {
      if (metric === 'tokens') { seriesAdd('in', b, R.in[i]); seriesAdd('out', b, R.out[i]); seriesAdd('cw', b, cw); seriesAdd('cr', b, R.cr[i]); }
      else if (pr) {
        const parts = { in: R.in[i] * pr[0], out: R.out[i] * pr[1], cw: R.cw5[i] * pr[0] * 1.25 + R.cw1[i] * pr[0] * 2, cr: R.cr[i] * pr[2] };
        const sum = parts.in + parts.out + parts.cw + parts.cr || 1;
        for (const k in parts) seriesAdd(k, b, (parts[k] / sum) * cost);
      }
    } else if (split === 'project') seriesAdd(topP.has(R.p[i]) ? 'p' + R.p[i] : 'other', b, v);
    else if (split === 'agent') seriesAdd(topA.has(R.a[i]) ? 'a' + R.a[i] : 'other', b, v);
    else seriesAdd('m' + R.m[i], b, v);
    if (metric === 'cost' && extra) seriesAdd(split === 'project' ? (topP.has(R.p[i]) ? 'p' + R.p[i] : 'other') : 'bg', b, extra);
    const d = new Date(t), cell = ((d.getDay() + 6) % 7) * 24 + d.getHours();
    A.heat[cell] += ui.heat === 'cost' ? full : ui.heat === 'tokens' ? tok : 1;
    A.heatCalls[cell]++;
    const dd = bump(A.days, dayStart(t), () => ({ cost: 0, calls: 0 })); dd.cost += full; dd.calls++;
    const mm = bump(A.models, R.m[i], () => ({ cost: 0, tok: 0, calls: 0, out: 0 })); mm.cost += cost; mm.tok += tok; mm.calls++; mm.out += R.out[i];
    const pp = bump(A.projects, R.p[i], () => ({ cost: 0, tok: 0, calls: 0, sess: new Set() })); pp.cost += full; pp.tok += tok; pp.calls++; pp.sess.add(R.s[i]);
    const ss = bump(A.sessions, R.s[i], () => ({ cost: 0, bg: 0, tok: 0, calls: 0, tools: 0, active: 0, prompts: 0, models: new Set(), projects: new Set(), first: t, last: t }));
    ss.cost += full; ss.bg += extra; ss.tok += tok; ss.calls++; ss.models.add(R.m[i]); ss.projects.add(R.p[i]); if (t < ss.first) ss.first = t; if (t > ss.last) ss.last = t;
    for (const [map, k] of [[A.agent, R.a[i]], [A.skill, R.sk[i]], [A.plugin, R.pl[i]], [A.mcp, R.mc[i]], [A.branch, R.b[i]]]) { const x = bump(map, k, () => ({ cost: 0, calls: 0 })); x.cost += cost; x.calls++; }
    bump(A.effort, R.ef[i], () => ({ calls: 0 })).calls++;
    if (R.stop[i]) bump(A.stop, R.stop[i], () => ({ calls: 0 })).calls++;
  }

  const T = tables.tool.cols;
  for (let i = 0; i < tables.tool.n; i++) {
    const t = T.t[i];
    if (t < pFrom || t >= to || !okP(T.p[i], T.s[i]) || !okA(T.a[i]) || !okToolModel(T, i, R)) continue;
    if (t < from) { if (t < pTo) A.prevTools++; continue; }
    const x = bump(A.tools, T.n[i], () => ({ calls: 0, err: 0, deny: 0 }));
    x.calls++; A.toolCalls++;
    if (T.deny[i]) { x.deny++; A.toolDeny++; bump(A.deny, T.deny[i], () => ({ calls: 0 })).calls++; } else if (T.err[i]) { x.err++; A.toolErr++; }
    if (T.perm[i]) bump(A.perm, T.perm[i], () => ({ calls: 0 })).calls++;
    const ss = A.sessions.get(T.s[i]); if (ss) ss.tools++;
  }
  const U = tables.turn.cols;
  for (let i = 0; i < tables.turn.n; i++) {
    const t = U.t[i];
    if (t < pFrom || t >= to || !okP(U.p[i], U.s[i])) continue;
    if (t < from) { if (t < pTo) A.prev.active += U.dur[i]; continue; }
    A.active += U.dur[i]; A.turns++; if (U.dur[i] > A.longest) A.longest = U.dur[i];
    (A.turnIv ||= []).push([t - U.dur[i], t]);
    const ss = A.sessions.get(U.s[i]); if (ss) ss.active += U.dur[i];
  }
  const Pm = tables.prompt.cols;
  for (let i = 0; i < tables.prompt.n; i++) {
    const t = Pm.t[i];
    if (t < pFrom || t >= to || !okP(Pm.p[i], Pm.s[i])) continue;
    if (t < from) { if (t < pTo) A.prev.prompts++; continue; }
    A.prompts++;
    bump(A.promptSrc, dicts.src[Pm.src[i]] || 'typed', () => ({ n: 0 })).n++;
    const ss = A.sessions.get(Pm.s[i]); if (ss) ss.prompts++;
  }
  const E = tables.evt.cols;
  for (let i = 0; i < tables.evt.n; i++) {
    const t = E.t[i];
    if (t < from || t >= to || !okP(E.p[i], E.s[i])) continue;
    const k = dicts.kind[E.k[i]];
    bump(A.kinds, k, () => ({ n: 0 })).n++;
    if (k.startsWith('compact:')) { A.compactPre += E.x[i]; A.compactPost += E.y[i]; }
    else if (k === 'hooks') { A.hookRuns++; A.hookMs += E.x[i]; A.hookCount += E.y[i]; }
  }
  for (const [sIdx, m] of D.sessions) {
    if (!m.cs || m.t0 < from || m.t0 >= to || !okP(m.p, sIdx)) continue;
    A.cc.cost += m.cs.cost; A.cc.n++; A.cc.add += m.cs.add || 0; A.cc.del += m.cs.del || 0;
    // accuracy check: logged cost up to the session's last saved counter vs that counter (no clock involved)
    const at = EST.attr.get(sIdx);
    if (at && at.counterCost > 0) { A.check.est += at.loggedCovered; A.check.cc += at.counterCost; A.check.n++; }
  }
  // month to date: same filters, calendar month, independent of the selected range
  const ms = new Date(); ms.setDate(1); ms.setHours(0, 0, 0, 0);
  for (let i = 0; i < nR; i++) if (R.t[i] >= +ms && okP(R.p[i], R.s[i]) && okA(R.a[i]) && okM(R.m[i]) && (ui.advisor || !R.adv[i]) && R.cost[i] > 0) A.mtd += R.cost[i] * (useBg ? bgShare(EST, R.s[i], R.t[i])?.factor || 1 : 1);
  A.monthStart = +ms;
  A.tok = A.in + A.out + A.cr + A.cw;
  A.hit = A.cr / (A.in + A.cr + A.cw || 1);
  A.prev.hit = A.prev.cr / (A.prev.inAll || 1);
  A.split = split; A.topP = topP; A.topA = topA; A.pFrom = pFrom; A.pTo = pTo;
  // how the usage in view is billed, for wording outside the big number: one kind only, or a mix
  const c = A.cls;
  A.totalMode = c.api.cost > 0 ? (c.sub.cost + c.unknown.cost > 0 ? 'mixed' : 'api') : c.sub.cost > 0 ? 'sub' : 'unknown';
  return A;
}
// The noun for a cost figure outside the big number (README "Accounts and billing"): never "spend" on usage that is or
// might be covered by a plan. full: headings and notes; short: column headers, tiles and labels.
const costWord = (A) => ({
  sub: { full: 'API-equivalent cost', short: 'API-eq. cost' }, api: { full: 'API spend (estimated)', short: 'API spend' },
  mixed: { full: 'Cost at API prices', short: 'Cost' }, unknown: { full: 'Cost at API prices', short: 'Cost' },
}[A.totalMode]);

// Background spend: Claude Code's saved counter snapshots per session (a CounterState from the server) turned into
// per-period factors by attribution() (public/machines.js). A period's share never changes once a later snapshot
// closes it, and calls after the last snapshot get none until the counter is saved again: no clock is involved.
let estCache = { v: -1, attr: null };
function sessionEstimates() {
  if (estCache.v === D.version) return estCache;
  const R = D.tables.req.cols, calls = new Map(), attr = new Map();
  for (let i = 0; i < D.tables.req.n; i++) if (R.cost[i] > 0) bump(calls, R.s[i], () => []).push({ t: R.t[i], cost: R.cost[i], model: D.dicts.model[R.m[i]] });
  for (const [sIdx, m] of D.sessions) { const a = m.counter ? attribution(m.counter, calls.get(sIdx) || []) : null; if (a) attr.set(sIdx, a); }
  estCache = { v: D.version, attr };
  return estCache;
}
/** The background factor and model split for one logged call, or null (no counter covers it yet). */
function bgShare(EST, sIdx, t) {
  const a = EST.attr.get(sIdx);
  const k = a ? intervalOf(a.ats, t) : -1;
  return k < 0 ? null : { factor: a.factors[k], frac: a.fracs[k] };
}

// ---------------------------------------------------------------- 5-hour windows (one account at a time: limits are per account)
// Other filters are ignored, as a limit counts everything that account did. Sessions that recorded no account (older
// Claude Code) are added, marked, since they may belong to it; their limit hits are drawn but never move a reset.
// With no account to follow (none recorded anywhere), every call counts, as before accounts existed.
let winCache = { v: '' };
function windows(follow) {
  const v = `${D.version}|${follow || ''}`;
  if (winCache.v === v) return winCache;
  const R = D.tables.req.cols, n = D.tables.req.n, E = D.tables.evt.cols, kinds = D.dicts.kind;
  const keep = (s) => !follow || acctOf(s) === follow || acctOf(s) === 'none';
  const unrec = (s) => !!follow && acctOf(s) === 'none';
  const order = Array.from({ length: n }, (_, i) => i).filter((i) => keep(R.s[i])).sort((a, b) => R.t[a] - R.t[b]);
  const hits = [], anchorSet = new Set();
  for (let i = 0; i < D.tables.evt.n; i++) {
    const k = kinds[E.k[i]];
    if (!k.startsWith('limit:') || !keep(E.s[i])) continue;
    hits.push({ t: E.t[i], kind: k.slice(6), reset: E.x[i], unrec: unrec(E.s[i]) });
    if (k === 'limit:five_hour' && E.x[i] && !unrec(E.s[i])) anchorSet.add(E.x[i]);
  }
  const anchors = [...anchorSet].sort((a, b) => a - b), H5 = 5 * 36e5;
  const blocks = []; let cb = null, ai = 0;
  for (const i of order) {
    const t = R.t[i];
    while (ai < anchors.length && anchors[ai] <= t) ai++;
    const a = anchors[ai];
    if (a !== undefined && t >= a - H5) {
      if (!cb || cb.end !== a) { cb = { start: a - H5, end: a, real: true, cost: 0, tok: 0, calls: 0, unrec: 0, first: t, last: t }; blocks.push(cb); }
    } else if (!cb || t >= cb.end) {
      const st = Math.floor(t / 6e5) * 6e5; // windows start on 10-minute marks (matches the real resets)
      cb = { start: st, end: Math.min(st + H5, a !== undefined ? a - H5 : Infinity), real: false, cost: 0, tok: 0, calls: 0, unrec: 0, first: t, last: t };
      blocks.push(cb);
    }
    cb.cost += Math.max(0, R.cost[i]); cb.tok += R.in[i] + R.out[i] + R.cr[i] + R.cw5[i] + R.cw1[i]; cb.calls++; cb.last = t;
    if (unrec(R.s[i])) cb.unrec++;
  }
  winCache = { v, blocks, hits, anchors };
  return winCache;
}

// ---------------------------------------------------------------- tooltip
const tip = $('tip');
function showTip(e, title, rows, total) {
  fill(tip, h('div', { class: 't', text: title }),
    rows.map((r) => h('div', { class: 'row' }, h('span', null, r.color ? h('i', { class: 'sw', style: { background: r.color } }) : null, r.label), h('b', { text: r.value }))),
    total != null ? h('div', { class: 'row tot' }, h('span', { text: 'Total' }), h('b', { text: total })) : null);
  tip.setAttribute('data-show', '');
  moveTip(e);
}
function moveTip(e) {
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 16, y = e.clientY + 16;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 16;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 16;
  tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
}
const hideTip = () => tip.removeAttribute('data-show');
// Keyboard reading for charts whose values otherwise show only on hover: the chart is one tab stop; arrow keys walk its
// points (Up/Down by a row when it has rows), each shown in the tooltip and announced to screen readers.
// show(i) draws the highlight and returns { x, y, title, rows } in screen pixels; show(-1) clears it.
function keyNav(host, n, show, cols = 0, start = n - 1) { // start: the point the first focus lands on
  host.tabIndex = n ? 0 : -1;
  const pick = (i) => {
    host.kIdx = i;
    const t = show(i); if (!t) return;
    showTip({ clientX: t.x, clientY: t.y }, t.title, t.rows);
    $('chart-sr').textContent = `${t.title}: ${t.rows.map((r) => `${r.label} ${r.value}`).join(', ')}`;
  };
  host.onkeydown = (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); pick(e.key === 'Home' ? 0 : n - 1); return; }
    if (!step || !n) return;
    e.preventDefault();
    pick(Math.max(0, Math.min(n - 1, (host.kIdx ?? start) + step)));
  };
  host.onfocus = () => { if (n) pick(Math.min(host.kIdx ?? start, n - 1)); };
  host.onblur = () => { hideTip(); show(-1); };
}
// screen position of an SVG point, from the SVG's own size and its box on screen
const svgPoint = (svg, W, H, x, y) => { const r = svg.getBoundingClientRect(); return { x: r.left + (x / W) * r.width, y: r.top + (y / H) * r.height }; };

// ---------------------------------------------------------------- element sizes
// Reading a size right after a DOM write forces a full page layout. Sizes only change when the layout does (page
// width, fonts), so each element's size is cached until the ResizeObserver or a font load bumps layoutEpoch.
let layoutEpoch = 0;
const sizeCache = new WeakMap();
function sizeOf(el, w0, h0) {
  const c = sizeCache.get(el);
  if (c && c.epoch === layoutEpoch) return c;
  const w = el.clientWidth, r = { w: w || w0, h: el.clientHeight || h0, epoch: layoutEpoch };
  if (w) sizeCache.set(el, r); // a hidden element measures 0: measure it again next time
  return r;
}

// ---------------------------------------------------------------- segmented control (clip-path active layer)
const segs = new Map();
function seg(id, options, value, onChange) {
  const host = $(id);
  let st = segs.get(id);
  const key = options.map((o) => o.v + (o.disabled ? '!' : '')).join('|');
  if (!st || st.key !== key) {
    const mk = (active) => h('div', { class: active ? 'seg-active' : 'seg-list', 'aria-hidden': active ? 'true' : null },
      options.map((o) => h('button', { type: 'button', role: active ? null : 'radio', tabindex: '-1', disabled: o.disabled || null, 'data-v': o.v, text: o.label })));
    const list = mk(false), act = mk(true);
    list.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) st.onChange(b.dataset.v); });
    list.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const btns = [...list.querySelectorAll('button:not(:disabled)')], i = btns.findIndex((b) => b.dataset.v === st.value);
      const nb = btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length];
      // keyboard changes jump: an action repeated key after key must not animate
      if (nb) { st.act.style.transition = 'none'; st.onChange(nb.dataset.v); requestAnimationFrame(() => { list.querySelector(`[data-v="${nb.dataset.v}"]`)?.focus(); requestAnimationFrame(() => { st.act.style.transition = ''; }); }); }
      e.preventDefault();
    });
    fill(host, list, act);
    act.style.transition = 'none';
    st = { key, list, act, value: null, onChange };
    segs.set(id, st);
    requestAnimationFrame(() => requestAnimationFrame(() => { act.style.transition = ''; }));
  }
  st.onChange = onChange;
  if (st.value === value && st.epoch === layoutEpoch) return; // same choice, same layout: nothing to write or measure
  st.value = value;
  st.epoch = layoutEpoch;
  for (const b of st.list.children) { const on = b.dataset.v === value; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
  const btn = st.list.querySelector(`[data-v="${CSS.escape(value)}"]`);
  if (!btn) { st.act.style.clipPath = 'inset(0 100% 0 0 round 999px)'; if (!st.list.querySelector('[tabindex="0"]') && st.list.firstChild) st.list.firstChild.tabIndex = 0; return; }
  // measure inside the list (the overlay starts where the list starts, inside the 3px padding)
  const l = btn.offsetLeft - st.list.offsetLeft, r = st.act.offsetWidth - (l + btn.offsetWidth);
  st.act.style.clipPath = `inset(0 ${r}px 0 ${l}px round 999px)`;
  if (!btn.offsetWidth) st.epoch = -1; // measured while hidden: measure again on the next draw
}

// ---------------------------------------------------------------- charts
function niceMax(v) {
  if (!(v > 0)) return { max: 1, step: 0.25 };
  const raw = v / 4, mag = 10 ** Math.floor(Math.log10(raw)), n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(v / step) * step, step };
}
const roundTop = (x, y, w, hgt, r) => { r = Math.min(r, w / 2, hgt); return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`; };

function stackedBars(host, B, series, fmt, label) {
  const { w: W, h: H } = sizeOf(host, 600, 290), m = { l: 50, r: 4, t: 8, b: 24 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b, n = B.n;
  const totals = new Float64Array(n);
  for (const se of series) for (let b = 0; b < n; b++) totals[b] += se.values[b];
  const { max, step } = niceMax(Math.max(0, ...totals));
  const root = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });
  const g = s('g');
  for (let v = 0; v <= max + step / 2; v += step) {
    const y = m.t + ih - (v / max) * ih;
    g.append(s('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: v ? 'gl' : 'gl0' }), s('text', { x: m.l - 10, y: y + 3.5, 'text-anchor': 'end', text: fmt(v) }));
  }
  const stepX = iw / n, bw = Math.max(1, Math.min(30, stepX * 0.68)), hover = s('rect', { class: 'col-hover', x: 0, y: m.t, width: stepX, height: ih, rx: 6, opacity: 0 });
  g.append(hover);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 70))));
  for (let b = 0; b < n; b++) {
    const x = m.l + b * stepX + (stepX - bw) / 2;
    let y = m.t + ih;
    const topIdx = series.findLastIndex((se) => se.values[b] > 0);
    series.forEach((se, k) => {
      const v = se.values[b]; if (v <= 0) return;
      const hh = (v / max) * ih; y -= hh;
      const visible = Math.max(k === topIdx ? 1 : 0.5, hh - (k === topIdx ? 0 : 2)); // 2px surface gap between stacked fills
      g.append(k === topIdx ? s('path', { d: roundTop(x, y, bw, visible, 4), fill: se.color }) : s('rect', { x, y: y + (hh - visible), width: bw, height: visible, fill: se.color }));
    });
    // minute buckets label on round clock times (every 15/30/60 min), not every Nth bucket from an odd start
    const mstep = B.unit === 'm5' ? 5 : B.unit === 'm15' ? 15 : 0, dt = new Date(B.edges[b]);
    const nice = [15, 30, 60, 120, 180, 240].find((x) => x >= every * mstep) || 240;
    const labelHere = mstep ? (dt.getHours() * 60 + dt.getMinutes()) % nice === 0 : b % every === 0;
    if (labelHere) g.append(s('text', { x: m.l + b * stepX + stepX / 2, y: H - 6, 'text-anchor': 'middle', text: bucketLabel(B, b, false) }));
  }
  for (let b = 0; b < n; b++) {
    g.append(s('rect', {
      class: 'hit', x: m.l + b * stepX, y: m.t, width: stepX, height: ih,
      onpointerenter: (e) => {
        hover.setAttribute('x', m.l + b * stepX); hover.setAttribute('opacity', 1);
        const rows = series.filter((se) => se.values[b] > 0).reverse().map((se) => ({ label: se.label, color: se.color, value: fmt(se.values[b], true) }));
        showTip(e, bucketLabel(B, b, true), rows.length ? rows : [{ label: 'No activity', value: '' }], rows.length > 1 ? fmt(totals[b], true) : null);
      },
      onpointermove: moveTip, onpointerleave: () => { hover.setAttribute('opacity', 0); hideTip(); },
    }));
  }
  root.append(g);
  fill(host, root);
}

function sparkline(host, B, values, word) {
  const { w: W, h: H } = sizeOf(host, 600, 132), n = B.n, pad = 4, bot = H - 16; // the time labels sit below bot
  const max = Math.max(...values, 0) || 1;
  const x = (b) => (n === 1 ? W / 2 : pad + (b / (n - 1)) * (W - pad * 2)), y = (v) => bot - 6 - (v / max) * (bot - 18);
  const pts = Array.from(values, (v, b) => [x(b), y(v)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
  const root = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${word} per ${UNIT[B.unit]}` },
    s('defs', null, s('linearGradient', { id: 'sg', x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: '0%', 'stop-color': CATEGORICAL[0], 'stop-opacity': 0.28 }), s('stop', { offset: '100%', 'stop-color': CATEGORICAL[0], 'stop-opacity': 0 }))),
    s('path', { d: `${line}L${pts.at(-1)[0]},${bot}L${pts[0][0]},${bot}Z`, fill: 'url(#sg)' }),
    s('path', { d: line, fill: 'none', stroke: CATEGORICAL[0], 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  // 2–4 time labels: first, last, and evenly spaced ones while each keeps twice its width (mono: ~6.4px a character)
  const lw = 6.4 * Math.max(bucketLabel(B, 0, false).length, bucketLabel(B, n - 1, false).length);
  const k = Math.min(n, Math.max(2, Math.min(4, 1 + Math.floor((W - pad * 2) / (2 * lw)))));
  for (let i = 0; i < k; i++) {
    const b = k === 1 ? 0 : Math.round((i * (n - 1)) / (k - 1));
    root.append(s('text', { x: x(b), y: H - 3, 'text-anchor': k === 1 || (i && i < k - 1) ? 'middle' : i ? 'end' : 'start', text: bucketLabel(B, b, false) }));
  }
  const cross = s('line', { y1: 0, y2: bot, class: 'xh', opacity: 0 });
  const dot = s('circle', { r: 4.5, fill: CATEGORICAL[0], stroke: SURFACE, 'stroke-width': 2, opacity: 0 });
  root.append(cross, dot, s('rect', {
    class: 'hit', x: 0, y: 0, width: W, height: H,
    onpointermove: (e) => {
      const r = root.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
      const b = Math.max(0, Math.min(n - 1, Math.round(n === 1 ? 0 : ((px - pad) / (W - pad * 2)) * (n - 1))));
      cross.setAttribute('x1', pts[b][0]); cross.setAttribute('x2', pts[b][0]); cross.setAttribute('opacity', 1);
      dot.setAttribute('cx', pts[b][0]); dot.setAttribute('cy', pts[b][1]); dot.setAttribute('opacity', 1);
      showTip(e, bucketLabel(B, b, true), [{ label: word, color: CATEGORICAL[0], value: usd(values[b]) }]);
    },
    onpointerleave: () => { cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); hideTip(); },
  }));
  fill(host, root);
  keyNav(host, n, (b) => {
    const on = b >= 0 ? 1 : 0;
    cross.setAttribute('opacity', on); dot.setAttribute('opacity', on);
    if (!on) return null;
    cross.setAttribute('x1', pts[b][0]); cross.setAttribute('x2', pts[b][0]); dot.setAttribute('cx', pts[b][0]); dot.setAttribute('cy', pts[b][1]);
    return { ...svgPoint(root, W, H, pts[b][0], pts[b][1]), title: bucketLabel(B, b, true), rows: [{ label: word, color: CATEGORICAL[0], value: usd(values[b]) }] };
  });
}

// bar list: items {key, label, small, color, value, sub, share, meta, title, pressed, noClick}
function barList(host, id, items, { onClick, limit = 8, fillColor = null } = {}) {
  if (!items.length) { fill(host, h('p', { class: 'empty', text: 'Nothing in this range.' })); return; }
  const open = expanded.has(id), shown = open ? items : items.slice(0, limit);
  fill(host, shown.map((it) => { const btn = onClick && !it.noClick; return h(btn ? 'button' : 'div', { // noClick: a row that filters nothing is no button
    class: 'bar', type: btn ? 'button' : null, title: it.title || null, 'aria-pressed': btn ? String(!!it.pressed) : null, onclick: btn ? () => onClick(it) : null,
    'data-fk': btn ? `${id}:${maskPath(String(it.key))}` : null, // a project key is a path: masked while presenting
  },
  h('div', { class: 'name' }, it.color ? h('i', { class: 'sw', style: { background: it.color } }) : null, h('span', { text: it.label }), it.small ? h('small', { text: it.small }) : null),
  h('div', { class: 'v' }, it.value, it.sub ? h('small', { text: it.sub }) : null),
  h('div', { class: 'track' }, h('i', { style: { width: Math.max(0.5, Math.min(100, it.share * 100)) + '%', ...((it.color || it.fillColor || fillColor) ? { background: it.color || it.fillColor || fillColor } : {}) } })),
  it.meta ? h('div', { class: 'meta' }, it.meta) : null); }),
  items.length > limit ? h('button', { class: 'btn btn-ghost btn-sm more', type: 'button', onclick: () => { open ? expanded.delete(id) : expanded.add(id); render(); }, text: open ? 'Show fewer' : `Show all ${items.length}` }) : null);
}

// ---------------------------------------------------------------- panels
const delta = (curV, prevV) => {
  if (!prevV) return null;
  const d = (curV - prevV) / prevV;
  if (d >= 9.5) return { d, text: `${Math.round(curV / prevV)}×` }; // +2,107% reads worse than 22×
  return { d, text: `${d >= 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0)}%` };
};

function renderHero(A) {
  // The big number shows each kind of usage for what it is: per-token spend when there is any, otherwise what the
  // (subscription or unknown) usage would cost at API prices. Never "spend" on usage that is or might be covered.
  const C = A.cls, api = C.api.cost, sub = C.sub.cost, unk = C.unknown.cost;
  const mode = api > 0 ? 'api' : sub > 0 ? 'sub' : 'unknown';
  const big = mode === 'api' ? C.api : { cost: A.cost, prev: A.prev.cost - C.api.prev, calls: A.calls, logged: A.logged, bg: A.bg, spark: A.spark };
  $('spend-h').textContent = { api: 'API spend (estimated)', sub: 'API-equivalent cost', unknown: 'Estimated cost at API prices' }[mode];
  const [dollars, cents] = usd(big.cost).split('.');
  fill($('spend-num'), dollars, h('span', { class: 'cents', text: '.' + cents }));
  $('spend-range').textContent = `${liveEnd() ? `${fDateTime.format(A.from)} → now (live)` : rangeText(A.from, A.to)} · by ${UNIT[A.B.unit]}${filterChips().length ? ' · filtered' : ''}`;
  // the same kinds of usage in the previous period; the base is shown, since "13×" alone reads as alarming
  const dl = delta(big.cost, big.prev), el = $('spend-delta');
  if (dl) fill(el, icon(dl.d >= 0 ? 'M7 17 17 7M9 7h8v8' : 'M7 7l10 10M17 9v8H9'), `${dl.text} vs ${PREV[ui.range]} (${usd(big.prev)})`); else fill(el, 'No earlier data to compare');
  const unkWhy = [A.unk.noKey ? 'No account was recorded for some sessions (Claude Code before 2.1.317, or an API key: mark API-key projects in Filters → Billing).' : '', A.unk.noPlan ? 'Plan not known yet for an account: open the dashboard once while logged into it.' : ''].filter(Boolean).join(' ');
  const what = {
    sub: ['What this usage would cost at API list prices. Your plan covers it up to its limits.', unk ? ` ${usd(unk)} of it is from sessions whose billing isn't known.` : ''],
    api: ['At API list prices; your invoice may differ.', sub || unk ? ` Plus ${[sub ? `${usd(sub)} of subscription usage` : '', unk ? `${usd(unk)} unknown` : ''].filter(Boolean).join(' and ')}; total at API prices ${usd(A.cost)}.` : ''],
    unknown: [A.cost ? unkWhy : ''],
  }[mode];
  fill($('spend-sub'), what, ' ',
    what.join('') ? 'From ' : 'API list prices for ', h('b', { text: int(big.calls) }), ' logged calls', big.bg ? [' (', h('b', { text: usd(big.logged) }), '), plus ', h('b', { text: usd(big.bg) }), ' of background calls that Claude Code counted but never logged, taken from the cost counters it saves in each session.'] : '.',
    !A.bg && ui.background && (ui.models.length || !ui.subagents || !ui.advisor) ? ' Background calls are left out while a model or agent filter is on.' : null,
    A.unpriced ? ` ${int(A.unpriced)} calls use a model with no known price and count as $0.` : null);
  sparkline($('spark'), A.B, big.spark, { api: 'API spend', sub: 'API-eq. cost', unknown: 'Cost at API prices' }[mode]);
}

function renderKpis(A) {
  const P = A.prev, word = costWord(A).short;
  // turns and prompts aren't per model or agent: those filters can't narrow two of the tiles, so they say so
  const allM = ui.models.length || !ui.subagents || !ui.advisor, scope = () => (allM ? h('div', { class: 'kpi-scope', text: 'all models & agents' }) : null);
  const tile = (label, val, sub, dl, extra) => h('div', { class: 'kpi' },
    h('div', { class: 'label' }, h('span', { text: label }), dl ? h('span', { class: 'd', text: dl.text }) : null),
    h('div', { class: 'val', text: val }), sub ? h('div', { class: 'sub', text: sub, title: sub }) : null, extra || null); // title: the line is cut off on narrow tiles
  const tokParts = [['out', A.out], ['in', A.in], ['cw', A.cw], ['cr', A.cr]];
  fill($('kpi-grid'),
    tile('Tokens', num(A.tok), `${num(A.out)} out · ${num(A.in + A.cw)} in · ${num(A.cr)} cached`, delta(A.tok, P.tok), [
      h('div', { class: 'mini-stack', title: 'Output · input · cache write · cache read' }, tokParts.map(([k, v]) => h('i', { style: { flex: String(Math.max(v, A.tok * 0.004)), background: TOKEN_COLORS[k] } }))),
      // a live refresh rebuilds the tiles: the note keeps its open state and keyboard focus
      A.rawTok > A.tok * 1.05 ? h('details', { class: 'explain', open: expanded.has('kpi:why') || null, ontoggle: (e) => { e.target.open ? expanded.add('kpi:why') : expanded.delete('kpi:why'); } },
        h('summary', { 'data-fk': 'kpi:why', text: `every-line count: ${num(A.rawTok)} (${(A.rawTok / A.tok).toFixed(1)}× lines)` }),
        h('p', { class: 'foot-note', text: 'Claude Code writes one API reply as several log lines that repeat the same usage. Counting every line inflates the total (close to what Claude Code’s /stats showed). This dashboard counts each reply once, which agrees with Claude Code’s own cost counter.' })) : null]),
    tile('API calls', int(A.calls), A.adv ? `${int(A.adv)} advisor calls` : `${int(A.toolCalls)} tool calls`, delta(A.calls, P.calls)),
    tile('Sessions', int(A.sessions.size), A.sessions.size ? `${word} ${usd(A.cost / A.sessions.size)} per session` : '–', delta(A.sessions.size, P.sess.size)),
    tile('Claude working', dur(A.active), A.turns ? `${dur(unionMs(A.turnIv || []))} on the clock · ${int(A.turns)} turns · longest ${dur(A.longest)}` : 'No completed turns', delta(A.active, P.active), scope()),
    // under those filters both ratios would divide filtered cost and calls by unfiltered prompts
    tile('Your prompts', int(A.prompts), allM ? null : A.prompts ? `${word} ${usd(A.cost / A.prompts)} and ${(A.calls / A.prompts).toFixed(1)} calls each` : '–', delta(A.prompts, P.prompts), scope()),
    tile('Cache hit rate', pct(A.hit, 1), `caching saved ≈ ${usd(A.saved)} at API prices`, P.inAll ? { text: `${A.hit >= P.hit ? '+' : '−'}${Math.abs((A.hit - P.hit) * 100).toFixed(1)} pt` } : null),
    monthTile(A));
}
// this calendar month, whatever the range: one full-width line under the tiles (same filters as everything else)
function monthTile(A) {
  const now = new Date(), elapsed = (now - A.monthStart) / 864e5, inMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return h('div', { class: 'kpi month' }, h('div', { class: 'label' }, h('span', { text: 'This month · at API prices' })), h('div', { class: 'val', text: usd(A.mtd) }),
    h('div', { class: 'sub', text: elapsed > 0.25 ? `since ${fDay.format(A.monthStart)} · heading for ${usd((A.mtd / elapsed) * inMonth)}` : `since ${fDay.format(A.monthStart)}` }));
}

function usageSeries(A) {
  const d = D.dicts;
  if (A.split === 'tokens') return ['out', 'in', 'cw', 'cr'].filter((k) => A.series.has(k)).map((k) => ({ key: k, label: TOKEN_LABEL[k], color: TOKEN_COLORS[k], values: A.series.get(k) })).reverse()
    .concat(A.series.has('bg') ? [{ key: 'bg', label: 'Background (not in logs)', color: OTHER, values: A.series.get('bg') }] : []);
  const list = [...A.series.entries()].map(([k, values]) => {
    if (k === 'other') return { key: k, label: 'Other', color: OTHER, values, order: 99 };
    if (k === 'bg') return { key: k, label: 'Background (not in logs)', color: OTHER, values, order: 98 };
    const idx = +k.slice(1);
    if (k[0] === 'p') { const r = A.topP.get(idx); return { key: k, label: projLabel(d.project[idx]).name, color: CATEGORICAL[r], values, order: r }; }
    if (k[0] === 'a') { const r = A.topA.get(idx); return { key: k, label: agentName(d.agent[idx]), color: CATEGORICAL[r], values, order: r }; }
    const name = d.model[idx], o = MODEL_ORDER.indexOf(name);
    return { key: k, label: modelName(name), color: modelColor(name), values, order: o < 0 ? 50 : o };
  });
  return list.sort((a, b) => a.order - b.order);
}

function renderUsage(A) {
  seg('metric', [{ v: 'cost', label: 'Cost' }, { v: 'tokens', label: 'Tokens' }, { v: 'calls', label: 'Calls' }], ui.metric, (v) => set({ metric: v }));
  seg('split', [{ v: 'model', label: 'Model' }, { v: 'tokens', label: 'Token type', disabled: ui.metric === 'calls' }, { v: 'project', label: 'Project' }, { v: 'agent', label: 'Agent' }], A.split, (v) => set({ split: v }));
  const series = usageSeries(A);
  const fmt = ui.metric === 'cost' ? (v, long) => (long ? usd(v) : usdShort(v)) : (v, long) => (long ? int(v) : num(v));
  const totals = series.map((se) => se.values.reduce((x, y) => x + y, 0));
  // legend reads left -> right in the same order the stack reads bottom -> top
  fill($('usage-legend'), series.length > 1 ? series.map((se, i) => h('span', null, h('i', { style: { background: se.color } }), se.label, h('b', { text: fmt(totals[i], true) }))) : null);
  const tableOn = !!ui.usageTable;
  $('usage-table-btn').setAttribute('aria-pressed', String(tableOn));
  $('usage-chart').hidden = tableOn; $('usage-table').hidden = !tableOn;
  if (tableOn) {
    const cols = series.slice().reverse();
    fill($('usage-table'), h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', { text: 'Period' }), cols.map((c) => h('th', { class: 'r', text: c.label })), h('th', { class: 'r', text: 'Total' }))),
      h('tbody', null, Array.from({ length: A.B.n }, (_, b) => b).reverse().map((b) => h('tr', null, h('td', { text: bucketLabel(A.B, b, true) }),
        cols.map((c) => h('td', { class: 'r', text: fmt(c.values[b], true) })), h('td', { class: 'r', text: fmt(cols.reduce((x, c) => x + c.values[b], 0), true) }))))));
  } else stackedBars($('usage-chart'), A.B, series, fmt, `Usage over time by ${A.split}`);
}

function toggleIn(list, v) { return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]; }

function renderModels(A) {
  const d = D.dicts, total = A.cost || 1;
  const items = [...A.models.entries()].sort((a, b) => b[1].cost - a[1].cost).map(([m, x]) => ({
    key: d.model[m], label: modelName(d.model[m]), color: modelColor(d.model[m]), value: usd(x.cost), sub: pct(x.cost / total), share: x.cost / total,
    meta: [h('span', { text: nCalls(x.calls) }), h('span', { text: `${num(x.tok)} tokens` }), h('span', { text: `${num(x.out)} out` })],
    pressed: ui.models.includes(d.model[m]), title: d.model[m],
  }));
  // unlogged background spend: shown as its own row, never folded into a model it may not belong to
  if (A.bg > 0) {
    // split by model from Claude Code's own per-model counter (exact per session; spread over time like the rest)
    const parts = [...A.bgModels].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([name, c]) => h('span', { text: `${modelName(name)} ${usd(c)}` }));
    items.push({ key: '', noClick: true, label: 'Background (not in logs)', color: OTHER, value: usd(A.bg), sub: pct(A.bg / total), share: A.bg / total,
      meta: parts.length ? parts : [h('span', { text: 'counted by Claude Code, never written to the transcript' })] });
  }
  const host = $('model-bars'), noteOpen = host.querySelector('.explain')?.open; // a live update must not fold the note while it is read
  barList(host, 'models', items, { onClick: (it) => { if (it.key) set({ models: toggleIn(ui.models, it.key) }); } });
  // the background row's explanation, reachable by keyboard and touch (a tooltip is neither)
  if (A.bg > 0) host.append(h('details', { class: 'explain', open: noteOpen || null }, h('summary', { 'data-fk': 'models:bg-note', text: 'What “Background (not in logs)” is' }),
    h('p', { class: 'foot-note', text: 'Cost in Claude Code’s own counter that its transcripts do not contain. Measured on your logs: about one short extra call per turn on your main model that re-reads the whole cached conversation (likely an after-turn helper such as prompt suggestions), small Haiku helper calls on uncached input, and requests whose reply was never written. See Data & accuracy.' })));
}

// Time axis under the 5-hour timeline: round clock times (the date at midnight) or whole days, from the range's own
// buckets; at most 3 to 5 by width, one step finer when fewer than 3 land, and a label that would touch the one before it
// is left out.
function wTicks(B, from, to, width, X) {
  const unitMin = { m5: 5, m15: 15, hour: 60 }[B.unit], most = Math.max(3, Math.min(5, Math.floor(width / 110)));
  const edges = B.edges.filter((t) => t >= from && t < to);
  if (!edges.length) return [];
  // minute and hour buckets: a clock step in minutes; day and week buckets: every Nth one
  const steps = unitMin ? [5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440].filter((x) => x % unitMin === 0) : edges.map((_, i) => i + 1);
  const at = (step) => {
    const out = []; let right = -Infinity;
    edges.forEach((t, i) => {
      const d = new Date(t);
      if (unitMin ? (d.getHours() * 60 + d.getMinutes()) % step : i % step) return;
      // past 24 hours a clock time can repeat, so it carries its date; 10.5px mono is 0.6em a character
      const text = !unitMin || t === dayStart(t) ? fDay.format(t) : (to - from > 864e5 ? fDateTime : fTime).format(t), w = text.length * 6.4, x = X(t);
      const anchor = x - w / 2 < 0 ? 'start' : x + w / 2 > width ? 'end' : 'middle', left = { start: x, middle: x - w / 2, end: x - w }[anchor];
      if (left < right + 8) return;
      right = left + w;
      out.push({ x, text, anchor });
    });
    return out;
  };
  const fit = steps.findIndex((x) => (unitMin ? x * 6e4 * most >= to - from : x * most >= edges.length)), i = fit < 0 ? steps.length - 1 : fit;
  const out = at(steps[i]), finer = out.length < 3 && i > 0 && at(steps[i - 1]);
  return finer && finer.length > out.length && finer.length <= 5 ? finer : out;
}

function renderWindows(A) {
  // limits are per account: follow the one picked in Filters, else the current login, else the most used in range
  const use = new Map(); for (const [s, x] of A.sessions) use.set(acctOf(s), (use.get(acctOf(s)) || 0) + x.cost);
  const follow = followAccount(ui.accounts, D.meta.account?.key, use);
  const followNote = follow ? `Following ${accountLabel(follow)} (${ui.accounts.filter((k) => k !== 'none').length === 1 ? 'picked in Filters' : follow === D.meta.account?.key ? 'current login' : 'most used in this range'}). ` : '';
  const state = $('window-state'), fcls = follow ? billingClass(acctMem[follow], true, false) : null;
  $('window-filtered').hidden = !filterChips().length || fcls === 'api'; // a limit counts everything the account did
  if (fcls === 'api') {
    delete state.dataset.tone; fill(state, 'No limit');
    fill($('window-now'), h('p', { class: 'empty', text: 'No 5-hour limit on per-token billing.' }));
    fill($('window-chart')); keyNav($('window-chart'), 0, () => null); fill($('window-note'), followNote);
    return;
  }
  // a plan meets limits, not bills: lead with the limit, its dollars as API-equivalent context. The money is the followed
  // account's (no filters), so its class names it; the view's mix only when no account is followed.
  const plan = fcls === 'sub' || A.totalMode === 'sub', cw = costWord({ totalMode: plan ? 'sub' : fcls || A.totalMode });
  const W = windows(follow), now = Date.now(), H5 = 5 * 36e5;
  // hits from sessions with no account recorded may be another account's: counted apart
  const hits = W.hits.filter((x) => x.t >= A.from && x.t < A.to), count = (k, unrec) => hits.filter((x) => x.kind === k && x.unrec === unrec).length;
  const h5 = count('five_hour', false), h7 = count('seven_day', false), u5 = count('five_hour', true), uh = hits.filter((x) => x.unrec).length;
  const stat = (k, v, sub) => h('div', null, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v }), h('span', { class: 's', text: sub }));
  const hitStat = plan && stat('5-hour limit hits', int(h5), ['in this range', h7 && `${int(h7)} seven-day`, u5 && `${int(u5)} more, account not recorded`].filter(Boolean).join(' · '));
  const curB = W.blocks.at(-1), active = curB && now < curB.end && now >= curB.start;
  if (active) {
    state.dataset.tone = 'good'; fill(state, `Active · resets ${fTime.format(curB.end)}`);
    const elapsed = now - curB.start, left = curB.end - now, rate = curB.cost / Math.max(elapsed, 6e5) * 36e5, byReset = usd(curB.cost + rate * left / 36e5);
    const work = `${nCalls(curB.calls)} · ${num(curB.tok)} tokens`;
    fill($('window-now'), h('div', { class: 'win' }, plan
      ? [stat('Resets in', dur(left), `${work} so far`), hitStat, stat(`${cw.short} this window`, usd(curB.cost), `${usd(rate)}/h, ${byReset} by reset at this rate`)]
      : [stat(`${cw.short} this window`, usd(curB.cost), work), stat(`${cw.short} rate`, usd(rate) + '/h', `${dur(left)} left`), stat(`${cw.short} by reset`, byReset, 'at this rate')]),
    h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Window elapsed', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(elapsed / H5 * 100)) }, h('i', { style: { transform: `scaleX(${Math.min(1, elapsed / (curB.end - curB.start))})` } })),
    h('p', { class: 'foot-note', text: `${fTime.format(curB.start)} → ${fTime.format(curB.end)} · ${curB.real ? 'window from a real reset' : 'estimated window'}` }));
  } else {
    delete state.dataset.tone; fill(state, 'Idle');
    const ended = curB && `ended ${ago(Math.min(curB.end, now))}`, next = stat('Next window', 'on first call', 'starts a fresh 5 hours');
    fill($('window-now'), !curB ? h('p', { class: 'empty', text: 'No windows yet.' }) : h('div', { class: 'win' }, plan
      ? [hitStat, next, stat(`${cw.short} last window`, usd(curB.cost), `${nCalls(curB.calls)} · ${ended}`)]
      : [stat(`${cw.short} last window`, usd(curB.cost), ended), stat('Calls', int(curB.calls), `${num(curB.tok)} tokens`), next]));
  }
  // timeline of windows in range; under its baseline, the limit-hit markers, then the time axis
  const host = $('window-chart'), { w: Wd, h: Hd } = sizeOf(host, 400, 128), m = { l: 2, r: 2, t: 6, b: 30 }, y0 = Hd - m.b;
  const inR = W.blocks.filter((b) => b.end > A.from && b.start < A.to);
  const max = Math.max(...inR.map((b) => b.cost), 0.01);
  const X = (t) => m.l + ((t - A.from) / (A.to - A.from)) * (Wd - m.l - m.r);
  const root = s('svg', { viewBox: `0 0 ${Wd} ${Hd}`, role: 'img', 'aria-label': 'Five-hour windows in range' },
    s('line', { x1: m.l, x2: Wd - m.r, y1: y0, y2: y0, class: 'gl0' }),
    wTicks(A.B, A.from, A.to, Wd, X).map((k) => [s('line', { x1: k.x, x2: k.x, y1: y0, y2: y0 + 4, class: 'gl0' }), s('text', { x: k.x, y: Hd - 3, 'text-anchor': k.anchor, text: k.text })]));
  const marks = [];
  for (const b of inR) {
    const x0 = Math.max(m.l, X(b.start)), x1 = Math.min(Wd - m.r, X(b.end)), w = Math.max(2, x1 - x0 - 2), hh = Math.max(2, (b.cost / max) * (y0 - m.t));
    const allUnrec = b.unrec === b.calls; // only sessions with no account recorded: may not be this account's at all
    const title = `${fDateTime.format(b.start)} → ${fTime.format(b.end)}`, rows = [{ label: cw.short, value: usd(b.cost) }, { label: 'Calls', value: int(b.calls) }, { label: 'Tokens', value: num(b.tok) }, { label: 'Window', value: b.real ? 'real reset' : 'estimated' },
      ...(b.unrec ? [{ label: 'Account', value: allUnrec ? 'not recorded' : `${int(b.unrec)} calls not recorded` }] : [])];
    const el = s('path', { d: roundTop(x0 + 1, y0 - hh, w, hh, 3), fill: CATEGORICAL[0], 'fill-opacity': allUnrec ? 0.22 : b.real ? 0.95 : 0.55,
      onpointerenter: (e) => showTip(e, title, rows), onpointermove: moveTip, onpointerleave: hideTip });
    root.append(el);
    marks.push({ el, cx: x0 + 1 + w / 2, top: y0 - hh, title, rows });
  }
  for (const x of hits) {
    const cx = X(x.t);
    root.append(s('path', {
      d: `M${cx - 5},${y0 + 14}L${cx + 5},${y0 + 14}L${cx},${y0 + 6}Z`, fill: STATUS.critical, 'fill-opacity': x.unrec ? 0.4 : 1,
      onpointerenter: (e) => showTip(e, `Hit the ${x.kind.replace('_', '-')} limit`, [{ label: 'At', value: fDateTime.format(x.t) }, { label: 'Resets', value: x.reset ? fDateTime.format(x.reset) : '–' }, ...(x.unrec ? [{ label: 'Account', value: 'not recorded' }] : [])]),
      onpointermove: moveTip, onpointerleave: hideTip,
    }));
  }
  fill(host, root);
  keyNav(host, marks.length, (i) => {
    for (const k of marks) k.el.removeAttribute('stroke');
    if (i < 0) return null;
    const k = marks[i]; k.el.setAttribute('stroke', 'currentColor'); k.el.setAttribute('stroke-width', '2');
    return { ...svgPoint(root, Wd, Hd, k.cx, k.top), title: k.title, rows: k.rows };
  });
  fill($('window-note'), followNote, `${inR.length} window${inR.length === 1 ? '' : 's'} in range`, h5 || h7 || uh ? ` · limit hits: ${h5} five-hour, ${h7} seven-day${uh ? `, ${uh} from sessions with no account recorded` : ''} (red markers)` : ' · no limit hits',
    `. Windows come from CLI activity and snap to ${W.anchors.length} real resets; claude.ai chats share the same limit but aren’t in these logs, so solid bars are exact and faded ones are estimates`,
    inR.some((b) => b.unrec) ? '; the lightest bars are sessions with no account recorded (Claude Code before 2.1.317).' : '.');
}

// ---------------------------------------------------------------- API billing breakdown
function renderBilling(A) {
  const d = D.dicts;
  const ALL = [['in', 'cIn', 'Input', (p) => p[0]], ['cw5', 'cCw5', 'Cache write 5 min', (p) => p[0] * 1.25], ['cw1', 'cCw1', 'Cache write 1 h', (p) => p[0] * 2], ['cr', 'cCr', 'Cache read', (p) => p[2]], ['out', 'cOut', 'Output', (p) => p[1]]];
  const total = (b) => b.cIn + b.cCw5 + b.cCw1 + b.cCr + b.cOut + b.cWs;
  const rows = [...A.bill.entries()].sort((x, y) => total(y[1]) - total(x[1]));
  billRows = rows; // for the CSV
  // a token type nobody used in this range is a column of zeros: leave it out (the totals don't change)
  const COLS = ALL.filter(([k]) => rows.some(([, b]) => b[k] > 0)), hasWs = rows.some(([, b]) => b.ws > 0);
  const sum = { calls: 0, ws: 0, cWs: 0 }; for (const [k] of COLS) { sum[k] = 0; }
  const rate = (v) => '$' + (v >= 1 ? v.toFixed(2).replace(/\.00$/, '') : v.toFixed(3).replace(/0$/, '')) + '/MTok';
  const cell = (tokens, cost, title) => h('td', { class: 'r', title }, h('b', { text: int(tokens) }), h('small', { text: cost == null ? 'no price' : usd(cost) }));
  const body = rows.map(([m, b]) => {
    const pr = priceOf(m), name = d.model[m];
    sum.calls += b.calls; sum.ws += b.ws; sum.cWs += b.cWs;
    for (const [k, c] of COLS) { sum[k] += b[k]; sum[c] = (sum[c] || 0) + b[c]; }
    return h('tr', null,
      h('td', null, h('div', { class: 'mname' }, h('i', { class: 'sw', style: { background: modelColor(name) } }), modelName(name)),
        h('div', { class: 'sub', text: pr ? `${rate(pr[0])} in · ${rate(pr[1])} out · ${rate(pr[2])} read` : 'model has no known price' })),
      h('td', { class: 'r', text: int(b.calls) }),
      COLS.map(([k, c, label, r]) => cell(b[k], pr ? b[c] : null, pr ? `${label}: ${int(b[k])} tokens × ${rate(r(pr))}${b.fast ? ' (fast-mode calls ×2)' : ''}` : '')),
      hasWs ? cell(b.ws, pr ? b.cWs : null, 'Web searches × $0.01') : null,
      h('td', { class: 'r' }, h('b', { text: pr ? usd(total(b)) : '–' }), h('small', { text: b.fast ? `${int(b.fast)} fast-mode calls` : b.tier ? `${int(b.tier)} over 100K` : '' })));
  });
  const grand = COLS.reduce((x, [, c]) => x + (sum[c] || 0), 0) + sum.cWs;
  fill($('bill-table'),
    h('thead', null, h('tr', null, h('th', { text: 'Model' }), h('th', { class: 'r', text: 'Calls' }), COLS.map(([, , label]) => h('th', { class: 'r', text: label })), hasWs ? h('th', { class: 'r', text: 'Web search' }) : null, h('th', { class: 'r', text: 'Cost' }))),
    h('tbody', null, body.length ? body : h('tr', null, h('td', { colspan: String(COLS.length + (hasWs ? 4 : 3)), class: 'dim', text: 'No API calls in this range.' }))),
    body.length > 1 ? h('tfoot', null, h('tr', null, h('td', { text: 'Total' }), h('td', { class: 'r', text: int(sum.calls) }),
      COLS.map(([k, c]) => cell(sum[k], sum[c] || 0)), hasWs ? cell(sum.ws, sum.cWs) : null, h('td', { class: 'r' }, h('b', { text: usd(grand) })))) : null);
  // the split must add back up to the logged spend shown everywhere else
  const diff = Math.abs(grand - A.logged), tag = $('billing-check');
  tag.dataset.tone = diff < 0.005 ? 'good' : 'warn';
  fill(tag, icon(diff < 0.005 ? 'M5 12.5l4.5 4.5L19 7.5' : 'M12 8v5m0 3.5v.01'), diff < 0.005 ? `adds up to logged cost, ${usd(A.logged)}` : `differs from logged cost by ${usd(diff)}`);
  fill($('bill-note'), 'Rates are Anthropic API list prices per million tokens. Input is uncached input; cache writes bill at 1.25× the input rate (5-minute) or 2× (1-hour); cache reads at the model’s read rate; output includes thinking tokens. Fast-mode calls bill at 2×, Claude Haiku 5.5 prompts over 100K tokens at 5×, web search at $10 per 1,000. Each reply is counted once.',
    A.bg ? ` Background cost (${usd(A.bg)}) is not split here: those calls never appear in the logs, so their token types are unknown.` : '');
}

// ---------------------------------------------------------------- performance: how fast and how cleanly Claude worked
// Samples: turns (wall time from Claude Code's turn_duration lines), API calls (output tokens, thinking time) and
// tool results. A turn counts where it ended. Below the sample floors a value is noise, so it shows as blank.
const MIN_TURNS = 3, MIN_CALLS = 5, MIN_TOOLS = 5;
const median = (arr) => { if (!arr.length) return NaN; const a = arr.slice().sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const PERF = [
  { key: 'turn', label: 'Median turn time', sub: 'wall time from your prompt to Claude’s finished reply', fmt: (v) => dur(v), n: (S, i) => S.turns[i].length, unit: 'turns',
    val: (S, i) => (S.turns[i].length >= MIN_TURNS ? median(S.turns[i]) : NaN), hi: 'Slowest', lo: 'Quickest' },
  { key: 'speed', label: 'Speed', sub: 'output tokens per minute Claude spent working', fmt: (v) => `${num(v)}/min`, n: (S, i) => S.turns[i].length, unit: 'turns',
    val: (S, i) => (S.turns[i].length >= MIN_TURNS && S.work[i] >= 6e4 ? S.out[i] / (S.work[i] / 6e4) : NaN), hi: 'Fastest', lo: 'Slowest' },
  { key: 'think', label: 'Thinking per call', sub: 'average time spent thinking before each reply', fmt: (v) => (v >= 6e4 ? dur(v) : (v / 1000).toFixed(1) + 's'), n: (S, i) => S.calls[i], unit: 'calls',
    val: (S, i) => (S.calls[i] >= MIN_CALLS ? S.tdm[i] / S.calls[i] : NaN), hi: 'Most thought', lo: 'Least thought' },
  { key: 'fail', label: 'Tool error rate', sub: 'tool calls that returned an error (your denials excluded)', fmt: (v) => pct(v, 1), n: (S, i) => S.toolN[i], unit: 'tool calls',
    val: (S, i) => (S.toolN[i] >= MIN_TOOLS ? S.toolBad[i] / S.toolN[i] : NaN), hi: 'Most errors', lo: 'Cleanest' },
];
// Your side of the work: mood and focus signals, each measured from the logs (no guessing from prompt text).
const RHYTHM = [
  { key: 'reply', label: 'Your reply time', sub: 'Claude finished → your next prompt, same session, gaps under 2h', fmt: (v) => dur(v), n: (S, i) => S.replies[i].length, unit: 'replies',
    val: (S, i) => (S.replies[i].length >= MIN_TURNS ? median(S.replies[i]) : NaN), hi: 'Slowest replies', lo: 'Quickest replies' },
  { key: 'plen', label: 'Prompt length', sub: 'median characters you typed per prompt', fmt: (v) => `${int(v)} chars`, n: (S, i) => S.plen[i].length, unit: 'prompts',
    val: (S, i) => (S.plen[i].length >= MIN_TURNS ? median(S.plen[i]) : NaN), hi: 'Longest prompts', lo: 'Shortest prompts' },
  { key: 'intr', label: 'You stopped Claude', sub: 'interruptions (Esc or send-now) per prompt', fmt: (v) => pct(v, 1), n: (S, i) => S.plen[i].length, unit: 'prompts',
    val: (S, i) => (S.plen[i].length >= MIN_CALLS ? S.intr[i] / S.plen[i].length : NaN), hi: 'Most stops', lo: 'Fewest stops' },
  { key: 'rej', label: 'Tools you rejected', sub: 'tool calls you said no to', fmt: (v) => pct(v, 1), n: (S, i) => S.toolN[i], unit: 'tool calls',
    val: (S, i) => (S.toolN[i] >= MIN_TOOLS ? S.rej[i] / S.toolN[i] : NaN), hi: 'Most rejections', lo: 'Fewest rejections' },
];
const METRICS = [...PERF, ...RHYTHM];

// Your reply gaps: for each prompt you typed (not queued while Claude was busy), the time since Claude last
// finished a turn in the same session. Gaps over 2h mean you stepped away, so they are not reply times.
const REPLY_MAX = 2 * 36e5;
let replyCache = { v: -1, list: [] };
function replySamples() {
  if (replyCache.v === D.version) return replyCache.list;
  const U = D.tables.turn.cols, Pm = D.tables.prompt.cols, src = D.dicts.src, ends = new Map(), list = [];
  for (let i = 0; i < D.tables.turn.n; i++) bump(ends, U.s[i], () => []).push(U.t[i]);
  for (const arr of ends.values()) arr.sort((a, b) => a - b);
  for (let i = 0; i < D.tables.prompt.n; i++) {
    if (src[Pm.src[i]] === 'queued') continue;
    const arr = ends.get(Pm.s[i]), t = Pm.t[i];
    if (!arr) continue;
    let lo = 0, hi = arr.length - 1, prev = -1; // latest turn end before this prompt
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] < t) { prev = mid; lo = mid + 1; } else hi = mid - 1; }
    if (prev < 0) continue;
    const gap = t - arr[prev];
    if (gap >= 0 && gap <= REPLY_MAX) list.push({ t, gap, end: arr[prev], s: Pm.s[i], p: Pm.p[i] });
  }
  replyCache = { v: D.version, list };
  return list;
}
function perfCompute(A) {
  const { dicts, tables } = D, B = A.B, from = A.from, to = A.to, pFrom = A.pFrom, pTo = A.pTo;
  const { okP, okA, okM, okToolModel } = filters();
  const lists = (n) => Array.from({ length: n }, () => []);
  const mk = (n) => ({ turns: lists(n), replies: lists(n), plen: lists(n), work: new Float64Array(n), out: new Float64Array(n), tdm: new Float64Array(n), calls: new Float64Array(n), toolN: new Float64Array(n), toolBad: new Float64Array(n), rej: new Float64Array(n), intr: new Float64Array(n) });
  const P = { B, T: mk(B.n), H: mk(168), cur: mk(1), prev: mk(1) };
  const cellOf = (t) => { const d = new Date(t); return ((d.getDay() + 6) % 7) * 24 + d.getHours(); };
  const each = (t, fn) => { if (t < from) { if (t < pTo) fn(P.prev, 0); return; } fn(P.cur, 0); fn(P.T, bucketOf(B.edges, t)); fn(P.H, cellOf(t)); };
  const U = tables.turn.cols;
  for (let i = 0; i < tables.turn.n; i++) {
    const t = U.t[i];
    if (t < pFrom || t >= to || !okP(U.p[i], U.s[i]) || !(U.dur[i] > 0)) continue;
    each(t, (S, k) => { S.turns[k].push(U.dur[i]); S.work[k] += U.dur[i]; });
  }
  const R = tables.req.cols;
  for (let i = 0; i < tables.req.n; i++) {
    const t = R.t[i];
    if (t < pFrom || t >= to || !okP(R.p[i], R.s[i]) || !okA(R.a[i]) || !okM(R.m[i]) || (!ui.advisor && R.adv[i])) continue;
    const main = !R.adv[i]; // advisor rows carry no thinking time; keep them out of the per-call average
    each(t, (S, k) => { S.out[k] += R.out[i]; if (main) { S.tdm[k] += R.tdm[i]; S.calls[k]++; } });
  }
  const T = tables.tool.cols;
  for (let i = 0; i < tables.tool.n; i++) {
    const t = T.t[i];
    if (t < pFrom || t >= to || !okP(T.p[i], T.s[i]) || !okA(T.a[i]) || !okToolModel(T, i, R)) continue;
    const bad = T.err[i] && !T.deny[i] ? 1 : 0;
    const no = rejectedByYou(T, i) ? 1 : 0;
    each(t, (S, k) => { S.toolN[k]++; S.toolBad[k] += bad; S.rej[k] += no; });
  }
  for (const r of replySamples()) {
    if (r.t < pFrom || r.t >= to || !okP(r.p, r.s)) continue;
    each(r.t, (S, k) => { S.replies[k].push(r.gap); });
  }
  const Pm = tables.prompt.cols;
  for (let i = 0; i < tables.prompt.n; i++) {
    const t = Pm.t[i];
    if (t < pFrom || t >= to || !okP(Pm.p[i], Pm.s[i])) continue;
    each(t, (S, k) => { S.plen[k].push(Pm.len[i] || 0); });
  }
  const E = tables.evt.cols, kIntr = dicts.kind.indexOf('interrupt');
  for (let i = 0; i < tables.evt.n; i++) {
    const t = E.t[i];
    if (E.k[i] !== kIntr || t < pFrom || t >= to || !okP(E.p[i], E.s[i])) continue;
    each(t, (S, k) => { S.intr[k]++; });
  }
  // by hour of day across all weekdays, for the "quickest / slowest hour" lines
  P.hour = mk(24);
  for (let c = 0; c < 168; c++) {
    const hr = c % 24, S = P.H, Hh = P.hour;
    for (const x of S.turns[c]) Hh.turns[hr].push(x);
    for (const x of S.replies[c]) Hh.replies[hr].push(x);
    for (const x of S.plen[c]) Hh.plen[hr].push(x);
    Hh.work[hr] += S.work[c]; Hh.out[hr] += S.out[c]; Hh.tdm[hr] += S.tdm[c]; Hh.calls[hr] += S.calls[c]; Hh.toolN[hr] += S.toolN[c]; Hh.toolBad[hr] += S.toolBad[c];
    Hh.rej[hr] += S.rej[c]; Hh.intr[hr] += S.intr[c];
  }
  return P;
}
// a tool call you personally refused (not one blocked by a rule, a hook or auto mode)
let rejKeys = { v: -1 };
function rejectedByYou(T, i) {
  if (rejKeys.v !== D.version) rejKeys = { v: D.version, deny: D.dicts.deny.indexOf('user-rejected'), perm: D.dicts.perm.indexOf('reject:user_reject') };
  return (rejKeys.deny > 0 && T.deny[i] === rejKeys.deny) || (rejKeys.perm > 0 && T.perm[i] === rejKeys.perm);
}

function miniLine(host, P, m) {
  const B = P.B, n = B.n, values = Array.from({ length: n }, (_, b) => m.val(P.T, b));
  const fin = values.filter(Number.isFinite);
  if (!fin.length) { fill(host, h('p', { class: 'empty', text: 'Not enough samples in this range.' })); return; }
  const { w: W, h: H } = sizeOf(host, 260, 92), pad = { l: 2, r: 2, t: 14, b: 14 };
  const max = Math.max(...fin) || 1;
  const X = (b) => pad.l + (n === 1 ? (W - pad.l - pad.r) / 2 : (b / (n - 1)) * (W - pad.l - pad.r)), Y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  let d = '', open = false;
  values.forEach((v, b) => { if (Number.isFinite(v)) { d += (open ? 'L' : 'M') + X(b).toFixed(1) + ',' + Y(v).toFixed(1); open = true; } else open = false; });
  const color = CATEGORICAL[1];
  const root = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${m.label} over time` },
    s('line', { x1: pad.l, x2: W - pad.r, y1: Y(0), y2: Y(0), class: 'gl0' }),
    s('text', { x: pad.l, y: 9, text: m.fmt(max) }),
    s('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
    // isolated points have no line segment: give them a dot
    values.map((v, b) => (Number.isFinite(v) && !Number.isFinite(values[b - 1]) && !Number.isFinite(values[b + 1]) ? s('circle', { cx: X(b), cy: Y(v), r: 3, fill: color }) : null)),
    s('text', { x: pad.l, y: H - 2, text: bucketLabel(B, 0, false) }), s('text', { x: W - pad.r, y: H - 2, 'text-anchor': 'end', text: bucketLabel(B, n - 1, false) }));
  const cross = s('line', { y1: pad.t, y2: H - pad.b, class: 'xh', opacity: 0 }), dot = s('circle', { r: 4, fill: color, stroke: SURFACE, 'stroke-width': 2, opacity: 0 });
  root.append(cross, dot, s('rect', {
    class: 'hit', x: 0, y: 0, width: W, height: H,
    onpointermove: (e) => {
      const r = root.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
      const b = Math.max(0, Math.min(n - 1, Math.round(n === 1 ? 0 : ((px - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
      const v = values[b], ok = Number.isFinite(v);
      cross.setAttribute('x1', X(b)); cross.setAttribute('x2', X(b)); cross.setAttribute('opacity', 1);
      dot.setAttribute('opacity', ok ? 1 : 0); if (ok) { dot.setAttribute('cx', X(b)); dot.setAttribute('cy', Y(v)); }
      showTip(e, bucketLabel(B, b, true), [{ label: m.label, color, value: ok ? m.fmt(v) : 'too few samples' }, { label: 'Samples', value: `${int(m.n(P.T, b))} ${m.unit}` }]);
    },
    onpointerleave: () => { cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); hideTip(); },
  }));
  fill(host, root);
}

function renderPerf(A, P) {
  metricGrid('perf-grid', PERF, P);
  fill($('perf-note'), `Hours are local (${D.meta.tz}) and need at least ${MIN_TURNS} turns, ${MIN_CALLS} calls or ${MIN_TOOLS} tool calls to show a value. Turn times come from Claude Code’s own turn timer; speed divides all output (subagents included) by that time. The heatmap can show these by weekday and hour.`);
  metricGrid('rhythm-grid', RHYTHM, P);
  fill($('rhythm-note'), 'Signals, not a diagnosis: slow replies, short prompts, more stops and more rejections often line up with tired or rushed stretches. Prompt length counts characters only; no prompt text is analysed. Pair this with Day by day to see when it happened.');
}
function metricGrid(gridId, metrics, P) {
  const hh = (x) => String(x).padStart(2, '0') + ':00';
  const cards = metrics.map((m) => {
    const curV = m.val(P.cur, 0), prevV = m.val(P.prev, 0);
    const dl = Number.isFinite(curV) && Number.isFinite(prevV) && prevV ? delta(curV, prevV) : null;
    const hours = Array.from({ length: 24 }, (_, hr) => [hr, m.val(P.hour, hr)]).filter(([, v]) => Number.isFinite(v)).sort((a, b) => b[1] - a[1]);
    const host = h('div', { class: 'mini' });
    const el = h('div', { class: 'pm' },
      h('div', { class: 'k' }, h('span', { text: m.label }), dl ? h('span', { class: 'd', title: `vs ${PREV[ui.range]}`, text: dl.text }) : null),
      h('div', { class: 'v', text: Number.isFinite(curV) ? m.fmt(curV) : '–' }),
      h('div', { class: 's', text: Number.isFinite(curV) ? `${m.sub} · ${int(m.n(P.cur, 0))} ${m.unit}` : `not enough ${m.unit} in this range` }),
      host,
      hours.length >= 2 ? h('ul', null, h('li', null, h('span', { text: `${m.hi} hour` }), h('b', { text: `${hh(hours[0][0])} · ${m.fmt(hours[0][1])}` })), h('li', null, h('span', { text: `${m.lo} hour` }), h('b', { text: `${hh(hours.at(-1)[0])} · ${m.fmt(hours.at(-1)[1])}` }))) : null);
    return { el, host, m };
  });
  fill($(gridId), cards.map((c) => c.el));
  cards.forEach((c) => sizeOf(c.host, 260, 92)); // measure every chart before drawing any: one layout, not one each
  cards.forEach((c) => miniLine(c.host, P, c.m));
}

// ---------------------------------------------------------------- day by day: a 24-hour strip per day
function dayView(A) {
  const { dicts, tables } = D;
  const { okP } = filters();
  const days = new Map();
  for (let d = dayStart(A.from); d < A.to; d = addDays(d, 1)) days.set(d, { t0: d, t1: addDays(d, 1), work: [], waits: [], prompts: [], replies: [], workMs: 0, first: Infinity, last: 0, longest: 0 });
  const dayOf = (t) => days.get(dayStart(t));
  const span = (day, a, b) => { if (a < day.first) day.first = a; if (b > day.last) day.last = b; };
  // a segment that crosses midnight is split so each day shows its own part
  const place = (a, b, fn) => { for (let d = dayStart(a); d < b; d = addDays(d, 1)) { const day = days.get(d); if (day) fn(day, Math.max(a, d), Math.min(b, addDays(d, 1))); } };
  const U = tables.turn.cols;
  for (let i = 0; i < tables.turn.n; i++) {
    const end = U.t[i], start = end - (U.dur[i] || 0);
    if (end < A.from || start >= A.to || !okP(U.p[i], U.s[i])) continue;
    place(start, end, (day, a, b) => { day.work.push([a, b, U.dur[i]]); day.workMs += b - a; span(day, a, b); });
    const day = dayOf(end); if (day && U.dur[i] > day.longest) day.longest = U.dur[i];
  }
  const Pm = tables.prompt.cols;
  for (let i = 0; i < tables.prompt.n; i++) {
    const t = Pm.t[i], day = dayOf(t);
    if (!day || t < A.from || t >= A.to || !okP(Pm.p[i], Pm.s[i])) continue;
    day.prompts.push(t); span(day, t, t);
  }
  for (const r of replySamples()) {
    if (r.t < A.from || r.t >= A.to || !okP(r.p, r.s)) continue;
    const day = dayOf(r.t); if (day) day.replies.push(r.gap);
    place(r.end, r.t, (d2, a, b) => d2.waits.push([a, b, r.gap]));
  }
  // stops: times you interrupted Claude or rejected one of its tool calls
  const E = tables.evt.cols, kIntr = dicts.kind.indexOf('interrupt'), T = tables.tool.cols;
  for (let i = 0; i < tables.evt.n; i++) if (E.k[i] === kIntr && okP(E.p[i], E.s[i])) { const day = dayOf(E.t[i]); if (day && E.t[i] >= A.from && E.t[i] < A.to) day.stops = (day.stops || 0) + 1; }
  for (let i = 0; i < tables.tool.n; i++) if (okP(T.p[i], T.s[i]) && rejectedByYou(T, i)) { const day = dayOf(T.t[i]); if (day && T.t[i] >= A.from && T.t[i] < A.to) day.stops = (day.stops || 0) + 1; }
  for (const day of days.values()) day.wallMs = unionMs(day.work);
  return [...days.values()].reverse(); // newest first
}
// Wall-clock time covered by possibly overlapping [start, end] intervals (parallel sessions overlap).
function unionMs(iv) {
  const a = iv.map((x) => [x[0], x[1]]).sort((p, q) => p[0] - q[0]);
  let total = 0, cs = -Infinity, ce = -Infinity;
  for (const [s0, e0] of a) { if (s0 > ce) { if (ce > cs) total += ce - cs; cs = s0; ce = e0; } else if (e0 > ce) ce = e0; }
  if (ce > cs) total += ce - cs;
  return total;
}

function dayStrip(host, day) {
  const W = sizeOf(host, 600, 26).w, H = 26, X = (t) => ((t - day.t0) / (day.t1 - day.t0)) * W;
  // One path per layer instead of one element per turn (a busy week is thousands), and one listener that finds
  // what is under the pointer. Later items are on top, as the separate rects were.
  const box = (x, y, w, hh, r) => { r = Math.min(r, w / 2, hh / 2); return `M${x + r},${y}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${hh - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${2 * r - w}a${r},${r} 0 0 1 ${-r},${-r}v${2 * r - hh}a${r},${r} 0 0 1 ${r},${-r}z`; };
  const span = ([a, b]) => [X(a), Math.max(1.5, X(b) - X(a))];
  const waits = day.waits.map(span), work = day.work.map(span), ticks = day.prompts.map((t) => X(t) - 0.75);
  const root = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${fWeekday.format(day.t0)}: Claude worked ${dur(day.workMs)}, ${day.prompts.length} prompts` },
    s('g', { 'pointer-events': 'none' }, // the svg itself takes the pointer
      s('rect', { class: 'bg', x: 0, y: 7, width: W, height: 12, rx: 3 }),
      [6, 12, 18].map((hr) => s('line', { class: 'hr', x1: (W * hr) / 24, x2: (W * hr) / 24, y1: 4, y2: 22 })),
      s('path', { d: waits.map(([x, w]) => box(x, 9, w, 8, 2)).join(''), fill: CATEGORICAL[2], 'fill-opacity': 0.55 }),
      s('path', { d: work.map(([x, w]) => box(x, 7, w, 12, 2)).join(''), fill: CATEGORICAL[1] }),
      s('path', { class: 'tick', d: ticks.map((x) => box(x, 0, 1.5, 5, 0.75)).join(''), 'fill-opacity': 0.8 })));
  const under = (e) => {
    const r = root.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W, py = ((e.clientY - r.top) / r.height) * H;
    const last = (list, y0, y1, w) => (py >= y0 && py <= y1 ? list.findLastIndex((it) => px >= (w ? it : it[0]) && px <= (w ? it + w : it[0] + it[1])) : -1);
    let i;
    if ((i = last(ticks, 0, 5, 1.5)) >= 0) return ['p', i];
    if ((i = last(work, 7, 19)) >= 0) return ['w', i];
    if ((i = last(waits, 9, 17)) >= 0) return ['q', i];
    return null;
  };
  let shown = null;
  const hover = (e) => {
    const k = under(e), id = k && k.join();
    if (id === shown) { if (k) moveTip(e); return; }
    shown = id;
    if (!k) return hideTip();
    const [kind, i] = k;
    if (kind === 'p') showTip(e, 'You sent a prompt', [{ label: 'At', value: fTime.format(day.prompts[i]) }]);
    else if (kind === 'w') { const [a, b, d0] = day.work[i]; showTip(e, 'Claude working', [{ label: 'Turn', value: `${fTime.format(a)} – ${fTime.format(b)}` }, { label: 'Turn time', value: dur(d0) }]); }
    else { const [a, , gap] = day.waits[i]; showTip(e, 'Claude waited for you', [{ label: 'From', value: fTime.format(a) }, { label: 'Your reply after', value: dur(gap) }]); }
  };
  root.addEventListener('pointermove', hover);
  root.addEventListener('pointerenter', hover); // also the re-hover draw() sends after a live update
  root.addEventListener('pointerleave', () => { shown = null; hideTip(); });
  fill(host, root);
}

function renderDays(A) {
  const list = dayView(A), key = `${ui.range}|${ui.from}|${ui.to}`, limit = expanded.has('days:' + key) ? list.length : 14;
  fill($('days-legend'),
    h('span', null, h('i', { style: { background: CATEGORICAL[1] } }), 'Claude working'),
    h('span', null, h('i', { style: { background: CATEGORICAL[2], opacity: '0.55' } }), 'Waiting for you'),
    h('span', null, h('i', { class: 'tick-key' }), 'Your prompt'));
  const hosts = [];
  const rows = list.slice(0, limit).map((day) => {
    const host = h('div', { class: 'strip' }), active = day.last > 0, cost = A.days.get(day.t0)?.cost || 0;
    hosts.push([host, day]);
    return h('div', { class: 'day' + (active ? '' : ' quiet') },
      h('div', { class: 'dl' }, fWeekday.format(day.t0), day.longest ? h('small', { text: `longest turn ${dur(day.longest)}` }) : h('small', { text: active ? '' : 'no activity' })),
      host,
      h('div', { class: 'r dim', text: active ? `${fTime.format(day.first)}–${fTime.format(Math.min(day.last, day.t1 - 6e4))}` : '–' }), // work running past midnight ends this row at 23:59
      h('div', { class: 'r', text: day.wallMs ? dur(day.wallMs) : '–', title: day.workMs > day.wallMs * 1.05 ? `clock time; ${dur(day.workMs)} if parallel sessions are added up` : 'clock time Claude was working' }),
      h('div', { class: 'r', text: day.replies.length ? dur(median(day.replies)) : '–', title: day.replies.length ? `median of ${day.replies.length} replies` : null }),
      h('div', { class: 'r', text: day.prompts.length ? int(day.prompts.length) : '–' }),
      h('div', { class: 'r', text: day.stops ? int(day.stops) : '–', title: 'times you stopped Claude (Esc or send-now) or rejected a tool call' }),
      h('div', { class: 'r', text: cost ? usd(cost) : '–' }));
  });
  const head = h('div', { class: 'day head', 'aria-hidden': 'true' }, h('span', { text: 'Day' }), h('span', { text: 'Midnight → midnight · lines at 06, 12, 18' }),
    h('span', { class: 'r', text: 'First – last' }), h('span', { class: 'r', text: 'Claude' }), h('span', { class: 'r', text: 'Your reply' }), h('span', { class: 'r', text: 'Prompts' }), h('span', { class: 'r', text: 'Stops' }), h('span', { class: 'r', text: 'Cost' }));
  fill($('days-list'), head, rows);
  hosts.forEach(([host]) => sizeOf(host, 600, 26)); // measure every strip before drawing any: one layout, not one each
  hosts.forEach(([host, day]) => dayStrip(host, day));
  fill($('days-foot'), h('span', { text: `Newest first, local time. “Your reply” is the median wait between Claude finishing and your next prompt.` }),
    list.length > 14 ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { const k = 'days:' + key; expanded.has(k) ? expanded.delete(k) : expanded.add(k); render(); }, text: limit < list.length ? `Show all ${list.length} days` : 'Show fewer' }) : null);
}

// The heatmap can use its own range. 'page' reuses the page's numbers; otherwise recompute with the same filters.
function heatData(A, P) {
  const key = ui.heatRange || 'page';
  if (key === 'page') return { heat: A.heat, calls: A.heatCalls, P, from: A.from, to: A.to, own: false };
  const [from, to] = rangeBounds(key);
  const P2 = perfCompute({ from, to, B: buckets(from, to), pFrom: from, pTo: from });
  const R = D.tables.req.cols, EST = sessionEstimates();
  const { okP, okA, okM, useBg } = filters();
  const heat = new Float64Array(168), calls = new Float64Array(168);
  for (let i = 0; i < D.tables.req.n; i++) {
    const t = R.t[i];
    if (t < from || t >= to || !okP(R.p[i], R.s[i]) || !okM(R.m[i]) || !okA(R.a[i]) || (!ui.advisor && R.adv[i])) continue;
    const cost = Math.max(0, R.cost[i]) * (useBg ? bgShare(EST, R.s[i], t)?.factor || 1 : 1);
    const d = new Date(t), cell = ((d.getDay() + 6) % 7) * 24 + d.getHours();
    heat[cell] += ui.heat === 'cost' ? cost : ui.heat === 'tokens' ? R.in[i] + R.out[i] + R.cr[i] + R.cw5[i] + R.cw1[i] : 1;
    calls[cell]++;
  }
  return { heat, calls, P: P2, from, to, own: true };
}

const HEAT_BASE = { cost: { label: 'Cost', fmt: usd }, tokens: { label: 'Tokens', fmt: num }, calls: { label: 'Calls', fmt: int } };
function renderHeat(A, P) {
  seg('heat-metric', [{ v: 'cost', label: 'Cost' }, { v: 'calls', label: 'Calls' }, { v: 'turn', label: 'Turn time' }, { v: 'speed', label: 'Speed' }, { v: 'fail', label: 'Errors' }, { v: 'reply', label: 'Your replies' }, { v: 'plen', label: 'Prompt length' }], ui.heat, (v) => set({ heat: v }));
  seg('heat-range', [{ v: 'page', label: 'Page range' }, { v: '7d', label: '7 days' }, { v: '30d', label: '30 days' }, { v: '90d', label: '90 days' }, { v: 'all', label: 'All' }], ui.heatRange || 'page', (v) => set({ heatRange: v }));
  const HD = heatData(A, P);
  const pm = METRICS.find((x) => x.key === ui.heat), base = HEAT_BASE[ui.heat] || HEAT_BASE.cost;
  const label = pm ? pm.label : base.label, fmt = pm ? pm.fmt : base.fmt;
  const vals = pm ? Array.from({ length: 168 }, (_, c) => pm.val(HD.P.H, c)) : Array.from(HD.heat);
  const fin = vals.filter((v) => Number.isFinite(v) && v > 0), max = Math.max(...fin, 0) || 1, min = pm ? Math.min(...fin) : 0;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const stepOf = (v) => {
    if (!(v > 0)) return -1;
    // magnitudes use a sqrt scale; rates and times spread between their own min and max
    const r = pm ? (max > min ? (v - min) / (max - min) : 1) : Math.sqrt(v / max);
    return Math.min(SEQUENTIAL.length - 1, 1 + Math.floor(r * (SEQUENTIAL.length - 2) + 0.5));
  };
  const cells = [h('span', { class: 'lab' })], dataCells = [];
  for (let hr = 0; hr < 24; hr++) cells.push(h('span', { class: 'lab hl', text: hr % 3 === 0 ? String(hr).padStart(2, '0') : '' }));
  days.forEach((dn, dIdx) => {
    cells.push(h('span', { class: 'lab', text: dn }));
    for (let hr = 0; hr < 24; hr++) {
      const c = dIdx * 24 + hr, v = vals[c], step = stepOf(v), thin = pm && !Number.isFinite(v) && pm.n(HD.P.H, c) > 0;
      const title = `${dn} · ${String(hr).padStart(2, '0')}:00–${String((hr + 1) % 24).padStart(2, '0')}:00`;
      const has = Number.isFinite(v) && (pm || v > 0), few = pm && pm.n(HD.P.H, c) > 0;
      const extra = pm ? { label: 'Samples', value: `${int(pm.n(HD.P.H, c))} ${pm.unit}` } : { label: 'API calls', value: int(HD.calls[c]) };
      // an hour with no value reads "No activity" (or, when it had calls, what it lacks), never a bare dash
      const rows = has || few ? [{ label, value: has ? fmt(v) : 'too few samples' }, extra]
        : HD.calls[c] ? [{ label, value: pm ? `no ${pm.unit}` : fmt(0) }, extra] : [{ label: 'No activity', value: '' }];
      const el = h('span', {
        class: 'c', style: step >= 0 ? { background: SEQUENTIAL[step] } : null, 'data-thin': thin || null, role: 'img',
        'aria-label': `${dn} ${hr}:00, ${rows[0].value || rows[0].label}`,
        onpointerenter: (e) => showTip(e, title, rows), onpointermove: moveTip, onpointerleave: hideTip,
      });
      cells.push(el); dataCells.push({ el, title, rows });
    }
  });
  fill($('heatmap'), cells);
  let best = -1, low = -1;
  vals.forEach((v, i) => { if (Number.isFinite(v) && v > 0) { if (best < 0 || v > vals[best]) best = i; if (low < 0 || v < vals[low]) low = i; } });
  // first focus lands on the busiest hour (same pick as the note), not Sunday 23:00, often an empty future hour
  keyNav($('heatmap'), dataCells.length, (i) => {
    for (const d of dataCells) d.el.classList.remove('kf');
    if (i < 0) return null;
    const d = dataCells[i], r = d.el.getBoundingClientRect(); d.el.classList.add('kf');
    return { x: r.left + r.width / 2, y: r.top, title: d.title, rows: d.rows };
  }, 24, best < 0 ? undefined : best);
  const at = (i) => `${days[Math.floor(i / 24)]} ${String(i % 24).padStart(2, '0')}:00 (${fmt(vals[i])})`;
  const text = (HD.own ? `${rangeText(HD.from, HD.to)}. ` : '') + (best < 0 ? 'No activity in this range.' : pm ? `${pm.hi}: ${at(best)}. ${pm.lo}: ${at(low)}. Striped cells had too few samples.` : (() => {
    const byDay = days.map((_, d) => vals.slice(d * 24, d * 24 + 24).reduce((x, y) => x + y, 0));
    return `Busiest hour: ${at(best)}. Busiest day: ${days[byDay.indexOf(Math.max(...byDay))]}.`;
  })());
  fill($('heat-note'), `${text} Times are local (${D.meta.tz}).`, ' ',
    h('span', { class: 'heat-scale', 'aria-hidden': 'true', style: { display: 'inline-flex', verticalAlign: 'middle', marginLeft: '6px' } }, SEQUENTIAL.slice(1).map((c) => h('i', { style: { background: c } }))));
}

function renderProjects(A) {
  const d = D.dicts, total = A.cost || 1;
  const items = [...A.projects.entries()].sort((a, b) => b[1].cost - a[1].cost).map(([p, x]) => {
    const l = projLabel(d.project[p]), r = A.topP.get(p); // the colour this project has in the Usage chart's project split; the rest are Other there
    return { key: d.project[p], label: l.name, small: l.parent, color: r !== undefined ? CATEGORICAL[r] : OTHER, value: usd(x.cost), sub: pct(x.cost / total), share: x.cost / total, title: maskPath(d.project[p]), pressed: ui.projects.includes(d.project[p]),
      meta: [h('span', { text: `${int(x.sess.size)} session${x.sess.size === 1 ? '' : 's'}` }), h('span', { text: nCalls(x.calls) }), h('span', { text: `${num(x.tok)} tokens` })] };
  });
  barList($('project-bars'), 'projects', items, { onClick: (it) => set({ projects: toggleIn(ui.projects, it.key) }) });
}

function renderTools(A) {
  seg('tool-sort', [{ v: 'calls', label: 'Most used' }, { v: 'errors', label: 'Most errors' }], ui.toolSort, (v) => set({ toolSort: v }));
  const d = D.dicts, max = Math.max(1, ...[...A.tools.values()].map((x) => (ui.toolSort === 'errors' ? x.err + x.deny : x.calls)));
  const items = [...A.tools.entries()].filter(([, x]) => ui.toolSort !== 'errors' || x.err + x.deny)
    .sort((a, b) => (ui.toolSort === 'errors' ? b[1].err + b[1].deny - (a[1].err + a[1].deny) : b[1].calls - a[1].calls))
    .map(([n, x]) => {
      const l = toolLabel(d.tool[n]), rate = (x.err + x.deny) / x.calls;
      return { key: d.tool[n], label: l.name, small: l.prefix ? 'MCP · ' + l.prefix : '', value: int(x.calls), sub: x.err + x.deny ? pct(rate, 1) + ' failed' : '', share: (ui.toolSort === 'errors' ? x.err + x.deny : x.calls) / max, title: d.tool[n],
        meta: x.err || x.deny ? [x.err ? h('span', { class: 'bad', text: `${int(x.err)} error${x.err === 1 ? "" : "s"}` }) : null, x.deny ? h('span', { class: 'meh', text: `${int(x.deny)} denied` }) : null] : null };
    });
  barList($('tool-bars'), 'tools', items, { limit: 9 });
}

function renderAttr(A) {
  seg('attr-tab', [{ v: 'agent', label: 'Agents' }, { v: 'skill', label: 'Skills' }, { v: 'plugin', label: 'Plugins' }, { v: 'mcp', label: 'MCP' }, { v: 'branch', label: 'Branches' }], ui.attr, (v) => set({ attr: v }));
  const d = D.dicts, map = A[ui.attr], names = d[ui.attr], total = A.logged || 1; // logged calls only: background spend has no agent/skill
  let none = 0;
  const items = [];
  for (const [k, x] of map) {
    if (!k) { none = x.cost; continue; }
    const r = ui.attr === 'agent' ? A.topA.get(k) : undefined;
    items.push({ key: names[k], label: ui.attr === 'agent' ? agentName(names[k]) : names[k], color: r !== undefined ? CATEGORICAL[r] : null, value: usd(x.cost), sub: pct(x.cost / total), share: x.cost / total, meta: [h('span', { text: nCalls(x.calls) })] });
  }
  items.sort((a, b) => b.share - a.share);
  // Presenting mode leaves branch names out (they can name clients or tickets); ranked placeholders keep the split readable
  if (ui.attr === 'branch' && ui.hideAccount) items.forEach((it, i) => { it.label = `Branch ${i + 1} (name hidden)`; });
  if (ui.attr !== 'agent' && none) items.push({ key: '', label: ui.attr === 'branch' ? 'No git branch' : `Not from a ${ui.attr === 'mcp' ? 'MCP server' : ui.attr}`, value: usd(none), sub: pct(none / total), share: none / total, fillColor: 'var(--bar-dim)' });
  barList($('attr-bars'), 'attr-' + ui.attr, items, { limit: 8 });
}

function renderFacts(A) {
  const d = D.dicts;
  const fact = (k, v, s2, extra) => h('div', { class: 'fact' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v }), s2 ? h('span', { class: 's', text: s2 }) : null, extra || null);
  const list = (rows) => h('ul', null, rows.map(([label, value, cls]) => h('li', { class: cls || null }, h('span', { text: label }), h('b', { text: value }))));
  const effTotal = [...A.effort.values()].reduce((x, y) => x + y.calls, 0) || 1;
  const eff = EFFORT.map((e) => [e, A.effort.get(d.effort.indexOf(e))?.calls || 0]).filter(([, n]) => n);
  const permRows = [...A.perm.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 4).map(([k, x]) => [PERM[d.perm[k]] || d.perm[k], int(x.calls)]);
  const permTotal = [...A.perm.values()].reduce((x, y) => x + y.calls, 0);
  const auto = A.perm.get(d.perm.indexOf('accept:config'))?.calls || 0;
  const stops = [...A.stop.entries()].sort((a, b) => b[1].calls - a[1].calls).map(([k, x]) => [STOP[d.stop[k]] || d.stop[k], int(x.calls), d.stop[k] === 'refusal' ? 'bad' : null]);
  const refusals = A.stop.get(d.stop.indexOf('refusal'))?.calls || 0;
  const kinds = [...A.kinds.entries()];
  const compacts = kinds.filter(([k]) => k.startsWith('compact:')).reduce((x, [, v]) => x + v.n, 0);
  const limits = kinds.filter(([k]) => k.startsWith('limit:')).reduce((x, [, v]) => x + v.n, 0);
  const apiErr = kinds.filter(([k]) => k.startsWith('api_error:') || k.startsWith('model_refusal'));
  fill($('facts'),
    fact('Effort level', eff.length ? eff.sort((a, b) => b[1] - a[1])[0][0] : '–', 'most used, share of API calls',
      [h('div', { class: 'seg-bar', role: 'img', 'aria-label': eff.map(([e, n]) => `${e} ${pct(n / effTotal)}`).join(', ') }, EFFORT.map((e) => { const n = A.effort.get(d.effort.indexOf(e))?.calls || 0; return n ? h('i', { style: { flex: String(n), background: EFFORT_COLOR[e] }, title: `${e}: ${pct(n / effTotal)}` }) : null; })),
        list(EFFORT.map((e) => [e, A.effort.get(d.effort.indexOf(e))?.calls || 0]).filter(([, n]) => n).map(([e, n]) => [e, pct(n / effTotal, n / effTotal < 0.01 ? 1 : 0)]))]),
    fact('Thinking', pct(A.th / (A.out || 1)), `of output tokens · ${dur(A.tdm)} spent thinking`),
    fact('Permission checks', permTotal ? pct(auto / permTotal) : '–', 'approved automatically', list(permRows)),
    fact('Tool failures', int(A.toolErr + A.toolDeny), A.toolCalls ? `${pct((A.toolErr + A.toolDeny) / A.toolCalls, 1)} of ${int(A.toolCalls)} tool calls` : 'no tool calls',
      list([...A.deny.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 3).map(([k, x]) => [DENY[d.deny[k]] || d.deny[k], int(x.calls), 'meh']).concat(A.toolErr ? [['Returned an error', int(A.toolErr), 'bad']] : []))),
    fact('How replies ended', refusals ? `${int(refusals)} refusals` : 'No refusals', null, list(stops.slice(0, 4))),
    fact('Context compactions', int(compacts), compacts ? `avg ${num(A.compactPre / compacts)} → ${num(A.compactPost / compacts)} tokens` : 'context never filled up'),
    fact('Code changed', A.cc.n ? `+${int(A.cc.add)} / −${int(A.cc.del)}` : '–', A.cc.n ? `lines, from ${int(A.cc.n)} session counters` : 'no session counters in range'),
    fact('Limits & errors', int(limits), 'usage-limit hits', apiErr.length ? list(apiErr.map(([k, v]) => [KIND[k] || k.replace('api_error:', 'API error: ').replace(/_/g, ' '), int(v.n), 'meh'])) : null),
    fact('Web searches', int(A.ws), `${int(A.wf)} page${A.wf === 1 ? '' : 's'} fetched`),
    // 12 facts in all: the grid is 4, 2 or 1 columns wide, and a short last row would show the grey ground
    ...paceFacts(A, fact, list));
}

function paceFacts(A, fact, list) {
  const days = [...A.days.entries()], peak = days.sort((a, b) => b[1].cost - a[1].cost)[0], cw = costWord(A).short;
  const sess = [...A.sessions.entries()].map(([sIdx, x]) => ({ x, m: D.sessions.get(sIdx) || {} }));
  const spans = sess.map((r) => (r.m.t1 || 0) - (r.m.t0 || 0)).filter((v) => v > 0);
  const costs = sess.map((r) => r.x.cost).sort((a, b) => a - b);
  const median = costs.length ? (costs.length % 2 ? costs[costs.length >> 1] : (costs[costs.length / 2 - 1] + costs[costs.length / 2]) / 2) : 0;
  const longest = sess.sort((a, b) => ((b.m.t1 || 0) - (b.m.t0 || 0)) - ((a.m.t1 || 0) - (a.m.t0 || 0)))[0];
  const src = [...A.promptSrc.entries()].sort((a, b) => b[1].n - a[1].n);
  const SRC = { typed: 'Typed', queued: 'Queued while busy', suggestion_accepted: 'Accepted a suggestion', system: 'System' };
  return [
    fact('Daily pace', A.days.size ? usd(A.cost / A.days.size) : '–', A.days.size ? `${cw} per active day · ${int(A.days.size)} active day${A.days.size === 1 ? '' : 's'}` : 'no activity in range',
      peak ? list([[`Busiest: ${fWeekday.format(peak[0])}`, usd(peak[1].cost)]]) : null),
    fact('Sessions', spans.length ? dur(spans.reduce((x, y) => x + y, 0) / spans.length) : '–', costs.length ? `average length · ${cw} median ${usd(median)}` : 'no sessions in range',
      longest ? list([[`Longest: ${!ui.hideAccount && longest.m.title || `Session ${(longest.m.id || '').slice(0, 8)}`}`, dur((longest.m.t1 || 0) - (longest.m.t0 || 0))]]) : null),
    fact('Prompts & hooks', A.hookRuns ? `${int(A.hookRuns)} hook runs` : 'No hook runs', A.hookRuns ? `${dur(A.hookMs)} spent in stop hooks · ${int(A.hookMs / A.hookRuns)} ms average` : 'none logged in this range',
      list(src.map(([k, v]) => [SRC[k] || k, `${int(v.n)} prompts`]))),
  ];
}

function renderAccuracy(A) {
  const m = D.meta, R = D.tables.req.cols;
  let first = Infinity;
  for (let i = 0; i < D.tables.req.n; i++) if (R.t[i] && R.t[i] < first) first = R.t[i];
  const days = Math.max(1, Math.round((Date.now() - first) / 864e5));
  const ratio = A.check.cc ? A.check.est / A.check.cc : NaN, close = ratio > 0.85 && ratio < 1.02;
  const OK = 'M5 12.5l4.5 4.5L19 7.5', WARN = 'M12 8v5m0 3.5v.01M10.3 3.9 2.6 17.3A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.7L13.7 3.9a2 2 0 0 0-3.4 0z';
  const item = (k, v, sub, tone) => h('div', { 'data-tone': tone || null }, h('span', { class: 'k' }, tone ? icon(tone === 'good' ? OK : WARN) : null, k), h('span', { class: 'v', text: v }), h('span', { class: 's', text: sub }));
  fill($('acc'),
    item('Coverage', isFinite(first) ? `${fDay.format(first)} → now` : '–', `${int(days)} days of transcripts on disk; every number here covers only those. Claude Code can delete old transcripts (the cleanupPeriodDays setting), and what it removed can’t be counted.`),
    item('Each reply counted once', `${num(A.tok)} tokens`, `Claude Code logs one reply as ~${(A.rawTok / (A.tok || 1)).toFixed(1)} lines with the same usage. Counting every line instead gives ${num(A.rawTok)}, close to the figure /stats showed.`, 'good'),
    item('Cost vs Claude Code', isFinite(ratio) ? pct(ratio, 1) : '–', A.check.n ? `of Claude Code’s own saved counters on ${int(A.check.n)} session${A.check.n === 1 ? '' : 's'} (logged calls up to each one’s last counter). The gap is mostly one short extra call per turn on your main model that re-reads the whole cached conversation, plus small Haiku helper calls; it is added as “Background”.` : 'No session in this range has a saved counter yet.', isFinite(ratio) ? (close ? 'good' : 'warn') : null),
    item('Prices', A.unpriced ? `${int(A.unpriced)} unpriced calls` : 'Every call priced', 'API list rates per model and cache type. npm run check re-verifies them against Claude Code’s own per-model cost.', A.unpriced ? 'warn' : 'good'),
    item('Parsing', `${int(m.badLines)} bad lines`, `${num(m.lines)} lines read from ${int(m.files)} files (${(m.bytes / 1e6).toFixed(0)} MB), read-only, updated live.`, m.badLines ? 'warn' : 'good'));
}

// Presenting mode hides session titles (they can name private work) and the short id stands in; rows keep the real title for search and sort
function tSessTitle(r) { return ui.hideAccount ? `Session ${(r.meta.id || '').slice(0, 8)}` : r.title || 'Untitled session'; }
function renderSessions(A) {
  const d = D.dicts, q = ui.sessQ.trim().toLowerCase(), hide = ui.hideAccount, cw = costWord(A).short;
  let rows = [...A.sessions.entries()].map(([sIdx, x]) => {
    const m = D.sessions.get(sIdx) || {};
    // every folder its calls ran in: a session moved with /cd has more than one
    const projs = [...new Set([m.p, ...x.projects].filter(Boolean))].map((p) => d.project[p]);
    return { sIdx, ...x, meta: m, title: m.title || '', t0: m.t0 || x.first, span: (m.t1 || x.last) - (m.t0 || x.first), cc: m.cs ? m.cs.cost : -1, proj: projs.join(' '), projNames: projs.map((p) => projLabel(p).name).join(' → ') };
  });
  if (q) rows = rows.filter((r) => r.title.toLowerCase().includes(q) || r.proj.toLowerCase().includes(q) || (r.meta.id || '').includes(q));
  const k = ui.sort, dir = ui.dir;
  rows.sort((a, b) => ((a[k] ?? 0) > (b[k] ?? 0) ? 1 : (a[k] ?? 0) < (b[k] ?? 0) ? -1 : 0) * dir);
  const cols = [['t0', 'Started'], ['title', 'Session'], ['models', 'Models', true], ['span', 'Length', false, true], ['active', 'Working', false, true], ['prompts', 'Prompts', false, true], ['calls', 'Calls', false, true], ['tools', 'Tools', false, true], ['tok', 'Tokens', false, true], ['cost', cw, false, true], ['cc', 'CC’s counter', false, true]];
  const shown = rows.slice(0, ui.sessLimit);
  sessRows = rows; sessOrder = rows.map((r) => r.sIdx); // for the CSV and the drawer's next / previous
  fill($('sess-table'),
    h('thead', null, h('tr', null, cols.map(([key, label, nosort, right]) => h('th', { class: right ? 'r' : null, 'aria-sort': key === k ? (dir > 0 ? 'ascending' : 'descending') : null, scope: 'col' },
      nosort ? label : h('button', { type: 'button', onclick: () => set({ sort: key, dir: key === k ? -dir : -1 }) }, label, key === k ? (dir > 0 ? ' ↑' : ' ↓') : ''))))),
    h('tbody', null, shown.map((r) => h('tr', {
      tabindex: '0', 'aria-describedby': 'sess-hint', 'data-s': String(r.sIdx), 'data-fk': 's:' + r.sIdx, onclick: () => openDrawer(r.sIdx), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(r.sIdx); } },
    },
    h('td', { class: 'dim', text: fDateTime.format(r.t0) }),
    // a session Claude Code never titled says so; its short id moves to the second line (search still finds it)
    h('td', null, h('div', { class: 'title', text: tSessTitle(r) }), h('div', { class: 'sub', text: r.projNames + (hide ? '' : (r.meta.branch ? ' · ' + r.meta.branch : '') + (r.title ? '' : ' · ' + (r.meta.id || '').slice(0, 8))) })),
    // model names, not colour alone; two shown, the rest counted
    h('td', null, h('span', { class: 'dots', title: [...r.models].map((m) => modelName(d.model[m])).join(', ') }, [...r.models].slice(0, 2).map((m) => h('span', null, h('i', { class: 'sw', style: { background: modelColor(d.model[m]) } }), modelName(d.model[m]))), r.models.size > 2 ? h('span', { text: `+${r.models.size - 2}` }) : null)),
    h('td', { class: 'r', text: dur(r.span) }), h('td', { class: 'r', text: dur(r.active) }), h('td', { class: 'r', text: int(r.prompts) }),
    h('td', { class: 'r', text: int(r.calls) }), h('td', { class: 'r', text: int(r.tools) }), h('td', { class: 'r', text: num(r.tok) }),
    h('td', { class: 'r', text: usd(r.cost) }), h('td', { class: 'r dim', text: r.cc >= 0 ? usd(r.cc) : '–' })))));
  if (!rows.length) $('sess-table').append(h('tbody', null, h('tr', null, h('td', { colspan: String(cols.length), class: 'dim', text: q ? 'No session matches that filter.' : 'No sessions in this range.' }))));
  const more = rows.length - shown.length, btn = (text, sessLimit) => h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => set({ sessLimit }), text });
  fill($('sess-foot'), h('span', { text: `${int(shown.length)} of ${int(rows.length)} sessions · ${cw}: logged calls in this range${filters().useBg ? ' plus each session’s share of background calls' : ', background calls left out'} · CC’s counter: Claude Code’s counter, its own total for the whole session, for comparison.` }),
    // the row limit is saved, so a table opened in full can go back to 25
    h('span', { class: 'sess-more' }, more > 25 ? btn('Show 25 more', ui.sessLimit + 25) : null, more ? btn(`Show all ${int(rows.length)}`, rows.length) : shown.length > 25 ? btn('Show fewer', 25) : null));
}

// ---------------------------------------------------------------- session drawer: a DrawerState (public/machines.js)
let dr = DRAWER_CLOSED, lastFocus = null;
const drawerIsOpen = () => dr.kind === 'open' || dr.kind === 'opening';
const drawerIdx = () => (drawerIsOpen() ? D.dicts.session.indexOf(dr.sid) : -1); // the drawer follows a session id, not a row
function drawerEvent(ev) {
  const closingSid = dr.sid;
  const { state, effects } = drawerStep(dr, ev);
  dr = state;
  const dEl = $('drawer'), scrim = $('scrim');
  for (const fx of effects) {
    // focus moves into the drawer when it opens; stepping to the next session keeps it where it is (on next / previous)
    if (fx === 'show') { dEl.hidden = false; scrim.hidden = false; renderDrawer(); if (!dEl.contains(document.activeElement)) $('drawer-close').focus({ preventScroll: true }); }
    else if (fx === 'slideIn') { dEl.setAttribute('data-open', ''); scrim.setAttribute('data-open', ''); }
    else if (fx === 'slideOut') { dEl.removeAttribute('data-open'); scrim.removeAttribute('data-open'); }
    else if (fx === 'hide') { dEl.hidden = true; scrim.hidden = true; }
    else if (fx === 'restoreFocus') {
      // live updates rebuild the table, so the row that opened the drawer may be a new element by now
      const back = lastFocus?.isConnected ? lastFocus : document.querySelector(`#sess-table tr[data-s="${D.dicts.session.indexOf(closingSid)}"]`);
      back?.focus?.({ preventScroll: true });
    } else if (fx.kind === 'frame') requestAnimationFrame(() => drawerEvent({ type: 'frame', token: fx.token }));
    else if (fx.kind === 'hideAfter') setTimeout(() => drawerEvent({ type: 'hidden', token: fx.token }), fx.ms);
  }
}
function openDrawer(sIdx) { lastFocus = document.activeElement; drawerEvent({ type: 'open', sid: D.dicts.session[sIdx] }); }
function closeDrawer() { drawerEvent({ type: 'close' }); }
// keep Tab inside the open drawer (it is aria-modal)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !drawerIsOpen()) return;
  const items = [...$('drawer').querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
  if (!items.length) return;
  const firstEl = items[0], lastEl = items.at(-1);
  if (e.shiftKey && (document.activeElement === firstEl || !$('drawer').contains(document.activeElement))) { e.preventDefault(); lastEl.focus(); }
  else if (!e.shiftKey && (document.activeElement === lastEl || !$('drawer').contains(document.activeElement))) { e.preventDefault(); firstEl.focus(); }
});
let sessRows = [], sessOrder = [], billRows = []; // the Sessions table's rows in its order, the billing rows: for CSV and next / previous
function stepDrawer(d) {
  const i = sessOrder.indexOf(drawerIdx()), next = sessOrder[i + d];
  if (i < 0 || next === undefined) return;
  lastFocus = null; // closing then returns to the row of the session shown last
  drawerEvent({ type: 'open', sid: D.dicts.session[next] });
  // the content changes under the focused next / previous button: say which session shows now (first open moves focus instead)
  $('drawer-live').textContent = `${$('drawer-title').textContent}, ${$('drawer-pos').textContent}`;
}
function renderDrawer() {
  const sIdx = drawerIdx();
  if (sIdx < 1) return;
  const at = sessOrder.indexOf(sIdx);
  $('drawer-prev').disabled = at <= 0; $('drawer-next').disabled = at < 0 || at >= sessOrder.length - 1;
  $('drawer-pos').textContent = at < 0 ? '' : `${int(at + 1)} of ${int(sessOrder.length)}`;
  if (dr.kind === 'opening') $('drawer-live').textContent = ''; // an open or a step empties it (a step then fills it); live updates leave it alone
  const d = D.dicts, m = D.sessions.get(sIdx) || {}, R = D.tables.req.cols, T = D.tables.tool.cols;
  const calls = []; const byModel = new Map(), byAgent = new Map(), byTool = new Map(), toolsOf = new Map();
  let cost = 0, tok = 0, active = 0, turns = 0, longest = 0, prompts = 0;
  for (let i = 0; i < D.tables.req.n; i++) {
    if (R.s[i] !== sIdx) continue;
    const c = Math.max(0, R.cost[i]), tk = R.in[i] + R.out[i] + R.cr[i] + R.cw5[i] + R.cw1[i];
    calls.push(i); cost += c; tok += tk;
    const bm = bump(byModel, R.m[i], () => ({ cost: 0, calls: 0 })); bm.cost += c; bm.calls++;
    const ba = bump(byAgent, R.a[i], () => ({ cost: 0, calls: 0 })); ba.cost += c; ba.calls++;
  }
  for (let i = 0; i < D.tables.tool.n; i++) {
    if (T.s[i] !== sIdx) continue;
    const x = bump(byTool, T.n[i], () => ({ calls: 0, err: 0, deny: 0 })); x.calls++; if (T.deny[i]) x.deny++; else if (T.err[i]) x.err++;
    if (hasCall(T.ts[i])) bump(toolsOf, T.r[i], () => []).push(d.tool[T.n[i]]); // a result-only row belongs to no call
  }
  const U = D.tables.turn.cols;
  for (let i = 0; i < D.tables.turn.n; i++) if (U.s[i] === sIdx) { active += U.dur[i]; turns++; if (U.dur[i] > longest) longest = U.dur[i]; }
  const Pm = D.tables.prompt.cols;
  for (let i = 0; i < D.tables.prompt.n; i++) if (Pm.s[i] === sIdx) prompts++;
  const E = D.tables.evt.cols, marks = [];
  for (let i = 0; i < D.tables.evt.n; i++) if (E.s[i] === sIdx && d.kind[E.k[i]] !== 'hooks') marks.push({ t: E.t[i], k: d.kind[E.k[i]] }); // hooks run every turn: not markers
  calls.sort((a, b) => R.t[a] - R.t[b]);
  const toolTotal = [...byTool.values()].reduce((x, y) => x + y.calls, 0), toolBad = [...byTool.values()].reduce((x, y) => x + y.err + y.deny, 0);

  // Presenting mode hides session titles and branch names; the project folder stays
  $('drawer-title').textContent = ui.hideAccount ? `Session ${(m.id || '').slice(0, 8)}` : m.title || 'Untitled session';
  $('drawer-sub').textContent = `${maskPath(d.project[m.p]) || ''}${m.branch && !ui.hideAccount ? ' · ' + m.branch : ''}${m.version ? ' · v' + m.version : ''}`;
  const stat = (k, v, sub) => h('div', null, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v }), sub ? h('span', { class: 's', text: sub }) : null);
  const ss = lastA?.sessions.get(sIdx); // the Sessions table's figure: activity in the range, background share included
  // cut: the range or filters hold only part of the session, so the first figure can't be held against the counter
  const cut = ss && Math.abs(ss.cost - ss.bg - cost) > Math.max(0.01, cost * 0.01), whole = ss && !cut;
  const host = h('div', { class: 'chart', style: { height: '170px' } });
  fill($('drawer-body'),
    h('div', { class: 'dstats' },
      stat(lastA ? costWord(lastA).short : 'Cost', ss ? usd(ss.cost) : '–', ss ? `Logged calls ${usd(ss.cost - ss.bg)} · background share ${usd(ss.bg)}` : null),
      stat('Claude Code’s counter', m.cs ? usd(m.cs.cost) : '–', m.cs ? 'its own total for the whole session' : 'not saved yet'), stat('Length', dur((m.t1 || 0) - (m.t0 || 0))),
      stat('Claude working', dur(active)), stat('Prompts', int(prompts)), stat('API calls', int(calls.length)),
      stat('Tool calls', `${int(toolTotal)}${toolBad ? ' · ' + int(toolBad) + ' failed' : ''}`), stat('Tokens', num(tok)), stat('Lines', m.cs ? `+${int(m.cs.add)} / −${int(m.cs.del)}` : '–')),
    whole && m.cs && m.cs.cost > ss.cost * 1.02 ? h('p', { class: 'foot-note', text: `Claude Code’s counter is ${usd(m.cs.cost - ss.cost)} higher: it covers the whole session, including calls that were never written to the transcript.` }) : null,
    whole && m.cs && m.cs.cost < ss.cost * 0.98 ? h('p', { class: 'foot-note', text: 'Claude Code only saves its counter now and then, so for a session that is still running (or ended abruptly) it trails the total above.' }) : null,
    // the first figure follows the range and filters (it is the table's); everything else here is the whole session
    cut ? h('p', { class: 'foot-note', text: `The range and filters hold ${usd(ss.cost - ss.bg)} of this session’s ${usd(cost)} in logged calls. Everything else here covers the whole session.` }) : null,
    h('section', { class: 'dsec' }, h('h3', { class: 'eyebrow', text: 'Each API call over time' }), host,
      h('p', { class: 'foot-note', text: `${calls.length ? fDateTime.format(R.t[calls[0]]) : ''} → ${calls.length ? fDateTime.format(R.t[calls.at(-1)]) : ''} · ${turns} turn${turns === 1 ? '' : 's'}, longest ${dur(longest)}` })),
    h('section', { class: 'dsec' }, h('h3', { class: 'eyebrow', text: 'Models' }), h('div', { class: 'bars', id: 'd-models' })),
    h('section', { class: 'dsec' }, h('h3', { class: 'eyebrow', text: 'Agents' }), h('div', { class: 'bars', id: 'd-agents' })),
    h('section', { class: 'dsec' }, h('h3', { class: 'eyebrow', text: 'Tools' }), h('div', { class: 'bars', id: 'd-tools' })),
    h('p', { class: 'foot-note mono', text: `Session ${m.id || ''}` }));
  const share = (x) => x.cost / (cost || 1);
  barList($('d-models'), 'd-models', [...byModel].sort((a, b) => b[1].cost - a[1].cost).map(([k, x]) => ({ label: modelName(d.model[k]), color: modelColor(d.model[k]), value: usd(x.cost), sub: nCalls(x.calls), share: share(x) })));
  barList($('d-agents'), 'd-agents', [...byAgent].sort((a, b) => b[1].cost - a[1].cost).map(([k, x]) => ({ label: agentName(d.agent[k]), value: usd(x.cost), sub: nCalls(x.calls), share: share(x) })));
  const tmax = Math.max(1, ...[...byTool.values()].map((x) => x.calls));
  barList($('d-tools'), 'd-tools', [...byTool].sort((a, b) => b[1].calls - a[1].calls).map(([k, x]) => { const l = toolLabel(d.tool[k]); return { label: l.name, small: l.prefix ? 'MCP · ' + l.prefix : '', value: int(x.calls), sub: x.err + x.deny ? `${x.err + x.deny} failed` : '', share: x.calls / tmax }; }), { limit: 10 });

  // per-call bars: x = time, height = cost
  requestAnimationFrame(() => {
    if (!calls.length) return;
    const Wd = sizeOf(host, 560, 170).w, Hd = 170, mg = { l: 44, r: 4, t: 6, b: 22 };
    const t0 = R.t[calls[0]], t1 = Math.max(R.t[calls.at(-1)], t0 + 6e4), maxC = niceMax(Math.max(...calls.map((i) => Math.max(0, R.cost[i]))));
    const X = (t) => mg.l + ((t - t0) / (t1 - t0)) * (Wd - mg.l - mg.r), Y = (v) => mg.t + (Hd - mg.t - mg.b) * (1 - v / maxC.max);
    const root = s('svg', { viewBox: `0 0 ${Wd} ${Hd}`, role: 'img', 'aria-label': 'Cost of each API call over the session' });
    for (let v = 0; v <= maxC.max + maxC.step / 2; v += maxC.step) root.append(s('line', { x1: mg.l, x2: Wd - mg.r, y1: Y(v), y2: Y(v), class: v ? 'gl' : 'gl0' }), s('text', { x: mg.l - 8, y: Y(v) + 3.5, 'text-anchor': 'end', text: usdShort(v) }));
    for (const mk of marks) {
      const x = X(mk.t), bad = mk.k.startsWith('limit') || mk.k.startsWith('api');
      if (x < mg.l || x > Wd) continue;
      root.append(s('line', bad ? { x1: x, x2: x, y1: mg.t, y2: Hd - mg.b, stroke: STATUS.critical, 'stroke-dasharray': '3 3' } : { x1: x, x2: x, y1: mg.t, y2: Hd - mg.b, class: 'mk' }));
    }
    for (const i of calls) {
      const x = X(R.t[i]), y = Y(Math.max(0, R.cost[i]));
      root.append(s('rect', {
        x: x - 1.5, y, width: 3, height: Math.max(1, Hd - mg.b - y), rx: 1.5, fill: modelColor(d.model[R.m[i]]),
        onpointerenter: (e) => showTip(e, fDateTime.format(R.t[i]) + (R.adv[i] ? ' · advisor' : ''), [
          { label: modelName(d.model[R.m[i]]), color: modelColor(d.model[R.m[i]]), value: usd(Math.max(0, R.cost[i])) },
          { label: 'Output · input', value: `${num(R.out[i])} · ${num(R.in[i] + R.cw5[i] + R.cw1[i])}` }, { label: 'Cache read', value: num(R.cr[i]) },
          { label: 'Agent', value: agentName(d.agent[R.a[i]]) }, ...(toolsOf.get(i) || []).slice(0, 4).map((n) => ({ label: 'Tool', value: toolLabel(n).name }))]),
        onpointermove: moveTip, onpointerleave: hideTip,
      }));
    }
    root.append(s('text', { x: mg.l, y: Hd - 4, text: fTime.format(t0) }), s('text', { x: Wd - mg.r, y: Hd - 4, 'text-anchor': 'end', text: fTime.format(t1) }));
    fill(host, root);
  });
}

// ---------------------------------------------------------------- prompt history (server-side search): a HistState
let hs = HIST_IDLE, histTimer = 0;
const loadHistory = () => histEvent({ type: 'change' });
function histEvent(ev, res) {
  const { state, effects } = histStep(hs, ev);
  hs = state;
  for (const fx of effects) {
    if (fx === 'render') renderHistory(res);
    else if (fx === 'showError') { $('hist-meta').textContent = 'Could not reach the dashboard server; trying again in 3 s.'; fill($('hist-list')); } // never leave the old query's results up
    else if (fx.kind === 'debounce' || fx.kind === 'retry') { clearTimeout(histTimer); histTimer = setTimeout(() => histEvent({ type: fx.kind === 'debounce' ? 'debounced' : 'retry', seq: fx.seq }), fx.ms); }
    else if (fx.kind === 'fetch') fetchHistory(fx.seq);
  }
}
async function fetchHistory(seq) {
  // its own range picker; 'all' reaches back past the transcripts, since history.jsonl is kept separately
  const hr = ui.histRange || 'page', [from, to] = hr === 'all' ? [0, Date.now()] : rangeBounds(hr);
  const params = new URLSearchParams({ q: $('hist-q').value, from: String(from), to: String(to), limit: String(histLimit) });
  if (ui.projects.length === 1) params.set('project', ui.projects[0]);
  if (ui.accounts.length === 1) params.set('account', ui.accounts[0]); // the server maps each prompt's session to its account
  let res;
  try { const r = await fetch('/api/history?' + params); if (!r.ok) throw new Error(String(r.status)); res = await r.json(); } catch { histEvent({ type: 'failed', seq }); return; }
  histEvent({ type: 'loaded', seq }, res); // the machine drops it if a newer query started meanwhile
}
let histLimit = 60, lastHist = null, histReveal = false; // shown count; last answer (to redraw without a fetch); prompts shown while presenting
function renderHistory(res) {
    lastHist = res;
    const q = $('hist-q').value, words = q.toLowerCase().split(/\s+/).filter(Boolean);
    // history.jsonl holds everything typed, /commands and ! lines too, so it can count more than the Prompts tile
    $('hist-meta').textContent = res.total ? `${int(res.total)} prompt${res.total === 1 ? '' : 's'}${q ? ' match' : ' in this range'}, counting /commands and ! lines${res.total > res.items.length ? ` · newest ${res.items.length} shown` : ''}${ui.projects.length === 1 ? ' · current project only' : ''}` : (q ? 'No prompt matches.' : 'No prompts in this range.');
    // presenting: prompt text stays off screen until asked for, one click away
    if (ui.hideAccount && !histReveal && res.total) {
      fill($('hist-list'), h('li', null, h('span', { class: 'hint', text: 'Prompts are hidden while personal details are hidden.' }),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { histReveal = true; renderHistory(lastHist); }, text: 'Show prompts' })));
      fill($('hist-more'));
      return;
    }
    // every prompt is reachable: 60 more at a time, or all at once
    const more = res.total - res.items.length;
    fill($('hist-more'), more > 0 ? [
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { histLimit += 60; loadHistory(); }, text: `Show ${int(Math.min(60, more))} more` }),
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { histLimit = res.total; loadHistory(); }, text: `Show all ${int(res.total)}` })] : null);
    // a live refresh keeps what you expanded and where you scrolled
    const list = $('hist-list'), top = list.scrollTop;
    // each prompt is a button, so the keyboard can expand it too (Enter or Space)
    const toggle = (el, t) => { const open = el.parentElement.toggleAttribute('data-open'); el.setAttribute('aria-expanded', String(open)); open ? histOpen.add(t) : histOpen.delete(t); };
    fill(list, res.items.map((it) => h('li', { 'data-open': histOpen.has(it.t) || null },
      h('time', { datetime: new Date(it.t).toISOString(), text: fDateTime.format(it.t) }, h('span', { class: 'proj', text: projLabel(it.project).name, title: maskPath(it.project) })),
      h('p', { class: 'text', role: 'button', tabindex: '0', 'aria-expanded': String(histOpen.has(it.t)), title: 'Click to expand',
        onclick: (e) => toggle(e.currentTarget, it.t), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e.currentTarget, it.t); } } }, highlight(it.text, words)))));
    list.scrollTop = top;
}
const histOpen = new Set(); // expanded prompts, by timestamp
let histPrompts = -1;       // prompt count at the last history fetch: refetch only when you have typed something new
function maybeReloadHistory() {
  if (D.tables.prompt.n !== histPrompts) { histPrompts = D.tables.prompt.n; loadHistory(); }
}
function highlight(text, words) {
  if (!words.length) return [text];
  const lc = text.toLowerCase(), out = []; let i = 0;
  while (i < text.length) {
    let best = -1, len = 0;
    for (const w of words) { const j = lc.indexOf(w, i); if (j >= 0 && (best < 0 || j < best)) { best = j; len = w.length; } }
    if (best < 0) { out.push(text.slice(i)); break; }
    if (best > i) out.push(text.slice(i, best));
    out.push(h('mark', { text: text.slice(best, best + len) }));
    i = best + len;
  }
  return out;
}

// ---------------------------------------------------------------- top bar: range, custom dates, filters, live
function renderTop() {
  // the same words as the page range above: "7 days", "All"
  seg('hist-range', [{ v: 'page', label: 'Page range' }, { v: '24h', label: '24h' }, { v: '7d', label: '7 days' }, { v: '30d', label: '30 days' }, { v: 'all', label: 'All' }], ui.histRange || 'page', (v) => set({ histRange: v }));
  seg('range', RANGES, ui.range, (v) => set({ range: v }));
  const [f, t] = rangeBounds();
  // narrow screens hide the range buttons (they move into this menu), so the button names the range instead; phones
  // (820px and under, by CSS) show only the short form ("7d", "3h", a start date); the accessible name keeps it whole
  const rangeName = HOURS[ui.range] ? `Last ${HOURS[ui.range]}h` : ui.range === 'custom' ? (liveEnd() ? `${fDateTime.format(f)} → now` : rangeText(f, t))
    : RANGES.find((r) => r.v === ui.range)?.label || 'Dates';
  $('custom-label').textContent = NARROW.matches || HOURS[ui.range] || ui.range === 'custom' ? rangeName : 'Dates';
  $('custom-short').textContent = ui.range === 'custom' ? fDay.format(f) : rangeName.replace('Last ', '').replace(' days', 'd');
  $('custom-btn').setAttribute('aria-label', `Dates, ${rangeName}`);
  const chips = filterChips();
  const c = $('filter-count'); c.hidden = !chips.length; c.textContent = String(chips.length);
  $('p-clear')?.toggleAttribute('hidden', !chips.length); // the Filters popover's Clear, in step as you tick (it isn't rebuilt under your focus)
  // every active filter on view, each one click from gone: a saved filter otherwise hides in a count badge across reloads
  const box = $('filter-chips'); box.hidden = !chips.length;
  // a removed chip hands focus to the next chip (else the one before, else Filters) instead of dropping it on the page;
  // draw() finds that chip again after the rebuild by its data-fk
  const unchip = (e, patch) => { const b = e.currentTarget, n = b.nextElementSibling?.classList.contains('chip') ? b.nextElementSibling : b.previousElementSibling; (n || $('filter-btn')).focus({ preventScroll: true }); set(patch); };
  fill(box, chips.map(([label, patch]) => h('button', { class: 'btn btn-ghost btn-sm chip', type: 'button', 'data-fk': 'chip:' + label, 'aria-label': `Remove filter: ${label}`, onclick: (e) => unchip(e, patch) }, label, h('span', { 'aria-hidden': 'true', text: '×' }))),
    chips.length > 1 ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-fk': 'chip:clear', onclick: () => { $('filter-btn').focus({ preventScroll: true }); set(NO_FILTERS); }, text: 'Clear all' }) : null);
}
const NO_FILTERS = { projects: [], models: [], accounts: [], subagents: true, advisor: true, background: true }; // apiProjects is a setting, not a filter
const filterChips = () => [
  ...ui.accounts.map((k) => [`Account: ${accountLabel(k)}`, { accounts: ui.accounts.filter((x) => x !== k) }]),
  ...ui.projects.map((p) => [`Project: ${projLabel(p).name}`, { projects: ui.projects.filter((x) => x !== p) }]),
  ...ui.models.map((m) => [`Model: ${modelName(m)}`, { models: ui.models.filter((x) => x !== m) }]),
  ...(ui.subagents ? [] : [['Subagents hidden', { subagents: true }]]),
  ...(ui.advisor ? [] : [['Advisor calls hidden', { advisor: true }]]),
  ...(ui.background ? [] : [['Background calls hidden', { background: true }]]),
];
// popovers (Dates, Filters): a PopState (public/machines.js), at most one open
const POPS = { filter: ['filter-btn', 'filter-pop'], custom: ['custom-btn', 'custom-pop'] };
let pop = POP_CLOSED;
function popEvent(ev) {
  const { state, effects } = popStep(pop, ev);
  pop = state;
  for (const fx of effects) {
    if (fx === 'invalid') continue;
    const [btnId, popId] = POPS[fx.id];
    if (fx.kind === 'open') { (fx.id === 'filter' ? buildFilters : openCustom)(); $(popId).setAttribute('data-open', ''); $(btnId).setAttribute('aria-expanded', 'true'); }
    else if (fx.kind === 'close') { $(popId).removeAttribute('data-open'); $(btnId).setAttribute('aria-expanded', 'false'); if (fx.refocus) $(btnId).focus({ preventScroll: true }); }
    else if (fx.kind === 'refresh' && fx.id === 'filter') buildFilters(); // the Dates inputs keep what you typed
  }
}
let projFind = ''; // the project search survives the popover being rebuilt by a live update
function buildFilters() {
  const d = D.dicts, R = D.tables.req.cols, [from, to] = rangeBounds();
  // amounts are spend in the page range, like every panel; a project or model idle in the range stays listed (at –)
  // so a filter chosen under another range can still be unticked
  const pc = new Map(), mc = new Map(), ac = new Map(), used = new Set(); // used: projects with a call in the range
  for (const s of D.sessions.keys()) ac.set(acctOf(s), 0); // every account in the data, even if idle in the range
  for (let i = 0; i < D.tables.req.n; i++) {
    const on = R.t[i] >= from && R.t[i] < to, c = on ? Math.max(0, R.cost[i]) : 0;
    if (on) used.add(R.p[i]);
    pc.set(R.p[i], (pc.get(R.p[i]) || 0) + c); mc.set(R.m[i], (mc.get(R.m[i]) || 0) + c);
    const k = acctOf(R.s[i]); ac.set(k, (ac.get(k) || 0) + c);
  }
  const amt = (c) => (c > 0 ? usdShort(c) : '–');
  const check = (label, meta, checked, onChange, color, title) => h('label', { class: 'check', title },
    h('input', { type: 'checkbox', checked: checked || null, onchange: (e) => onChange(e.target.checked) }),
    h('span', { class: 'name' }, color ? h('i', { style: { background: color } }) : null, label), h('span', { class: 'meta', text: meta }));
  const sw = (label, small, checked, onChange) => h('label', { class: 'toggle-row' }, h('span', null, label, h('small', { text: small })), h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: checked || null, onchange: (e) => onChange(e.target.checked) }));
  // chosen names the data no longer has (cleaned-up transcripts): still filtering (to nothing), so list them to untick
  const { projSel, modelSel } = filters();
  const gone = (sel, key, label) => (sel?.unavailable || []).map((name) => check(label(name), 'no data', true, () => set({ [key]: toggleIn(ui[key], name) }), null, maskPath(name)));
  // projects idle in the range (most of a long history) fold away; a ticked one stays in view, to be unticked
  const projs = [...pc].sort((a, b) => b[1] - a[1]).filter(([p]) => p), idle = ([p]) => !used.has(p) && !ui.projects.includes(d.project[p]);
  const projCheck = ([p, c]) => check(projLabel(d.project[p]).name, amt(c), ui.projects.includes(d.project[p]), () => set({ projects: toggleIn(ui.projects, d.project[p]) }), null, maskPath(d.project[p]));
  const projChecks = projs.filter((x) => !idle(x)).map(projCheck), idleChecks = projs.filter(idle).map(projCheck);
  // the fold's own open state is kept only from your clicks, not from a search opening it
  const idleFold = idleChecks.length ? h('details', { class: 'explain', open: pIdleOpen || null, ontoggle: (e) => { if (!projFind) pIdleOpen = e.target.open; } },
    h('summary', { text: `${idleChecks.length} idle in this range` }), h('div', { class: 'checks' }, idleChecks)) : null;
  const findProj = () => {
    const q = projFind.toLowerCase();
    for (const el of [...projChecks, ...idleChecks]) el.hidden = !!q && !el.textContent.toLowerCase().includes(q);
    // a search reaches into the fold: open while it holds a match, hidden while it holds none
    if (idleFold) { const hit = idleChecks.some((el) => !el.hidden); idleFold.hidden = !!q && !hit; idleFold.open = pIdleOpen || (!!q && hit); }
  };
  findProj();
  // accounts: real ones first (by cost), "No account recorded" last; a picked account the data no longer has stays listed
  const acctChecks = [...ac].sort((a, b) => (a[0] === 'none') - (b[0] === 'none') || b[1] - a[1]).map(([k, c]) => check(accountLabel(k), amt(c), ui.accounts.includes(k), () => set({ accounts: toggleIn(ui.accounts, k) })));
  const acctGone = ui.accounts.filter((k) => !ac.has(k)).map((k) => check(accountLabel(k), 'no data', true, () => set({ accounts: toggleIn(ui.accounts, k) })));
  // Billing: projects whose sessions recorded no Claude account can be marked "API key" by you; never switched on by
  // itself. "Likely" = those sessions ran a Claude Code that always records the account when one is logged in.
  const noAcct = new Map();
  for (const m of D.sessions.values()) if (!m.acct && m.p) { const path = d.project[m.p], v = noAcct.get(path) || ''; noAcct.set(path, verAtLeast(m.version, '2.1.317') ? '2.1.317' : v); }
  const billSw = ([path, recent]) => sw(`${projLabel(path).name} uses an API key`, recent ? 'Likely: no Claude account recorded on a recent Claude Code' : 'No Claude account recorded (older Claude Code)', ui.apiProjects.includes(path), () => set({ apiProjects: toggleIn(ui.apiProjects, path) }));
  const likely = [...noAcct].filter(([, r]) => r), older = [...noAcct].filter(([, r]) => !r);
  // short controls first (switches, Clear), then accounts, models and billing labels (a setting, easy to miss at the
  // bottom), then the long project list with its idle projects folded
  fill($('filter-body'),
    sw('Include subagents', 'Explore, general-purpose, forks…', ui.subagents, (v) => set({ subagents: v })),
    sw('Include advisor calls', 'Second-opinion model calls', ui.advisor, (v) => set({ advisor: v })),
    sw('Include unlogged background calls', 'Counted by Claude Code but not in transcripts; from the cost counters it saves', ui.background, (v) => set({ background: v })),
    // only while a filter is on (renderTop keeps it in step); once used it hides, so focus moves to the first switch
    h('div', { class: 'pop-actions', id: 'p-clear', hidden: !filterChips().length || null }, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { set(NO_FILTERS); buildFilters(); $('filter-body').querySelector('input').focus(); }, text: 'Clear filters' })),
    acctChecks.length > 1 || acctGone.length ? [h('p', { class: 'pop-title', text: 'Accounts · cost in this range' }), h('div', { class: 'checks' }, acctChecks, acctGone)] : null,
    h('p', { class: 'pop-title', text: 'Models · cost in this range' }),
    h('div', { class: 'checks' }, [...mc].sort((a, b) => b[1] - a[1]).filter(([m]) => m).map(([m, c]) => check(modelName(d.model[m]), amt(c), ui.models.includes(d.model[m]), () => set({ models: toggleIn(ui.models, d.model[m]) }), modelColor(d.model[m]), d.model[m])),
      gone(modelSel, 'models', modelName)),
    noAcct.size ? [h('p', { class: 'pop-title', id: 'p-billing', text: 'Billing · projects with no account recorded' }), likely.map(billSw),
      older.length ? h('details', { open: billOlderOpen || null, ontoggle: (e) => { billOlderOpen = e.target.open; } }, h('summary', { class: 'hint', text: `${older.length} project${older.length === 1 ? '' : 's'} with only older sessions` }), older.map(billSw)) : null] : null,
    h('p', { class: 'pop-title', text: 'Projects · cost in this range' }),
    projs.length > 8 ? h('label', { class: 'search' }, h('input', { type: 'search', value: projFind, placeholder: 'Find a project', 'aria-label': 'Find a project', oninput: (e) => { projFind = e.target.value; findProj(); } })) : null,
    h('div', { class: 'checks' }, projChecks, gone(projSel, 'projects', (n) => projLabel(n).name)),
    idleFold);
}
let billOlderOpen = false; // the fold stays open across the popover's rebuilds (a live update, a switch flipped)
let pIdleOpen = false; // the same for the fold of projects idle in the range
// the Account row's "API-key projects": opens Filters at its Billing group and puts focus on its first control
function pShowBilling() {
  if (pop.kind !== 'open' || pop.id !== 'filter') popEvent({ type: 'toggle', id: 'filter' });
  const g = $('p-billing'), body = $('filter-body');
  // not scrollIntoView: it would also scroll the page under the sticky bar. offsetTop is read unscrolled (some
  // browsers count the list's own scroll in it); 16 is .pop-core's padding, so the title isn't cut
  body.scrollTop = 0;
  body.scrollTop = g.offsetTop - body.offsetTop - 16;
  g.nextElementSibling.querySelector('input, summary').focus({ preventScroll: true });
}

const live = $('live'), liveSr = $('live-sr');
function tickLive() {
  live.dataset.state = conn.kind === 'live' ? 'live' : conn.kind === 'connecting' && !conn.attempt ? '' : 'warn';
  const state = conn.kind === 'live' ? 'Live' : conn.kind === 'waiting' ? 'Disconnected · retrying' : conn.kind === 'reconnecting' || conn.attempt ? 'Reconnecting…' : 'Connecting';
  live.lastElementChild.textContent = conn.kind === 'live' ? `Live · ${lastPush ? 'updated ' + ago(lastPush) : 'watching'}` : state;
  live.querySelector('b').textContent = conn.kind === 'live' ? 'Live' : live.dataset.state === 'warn' ? 'Retrying' : 'Connecting'; // what phones show
  if (liveSr.textContent !== state) liveSr.textContent = state; // announced on change only, never each second
}
// at most one ping per 10 s: while Claude works, updates arrive up to twice a second and a pulse each time is noise
let lastPing = 0;
function ping() { if (Date.now() - lastPing < 1e4) return; lastPing = Date.now(); live.classList.remove('ping'); void live.offsetWidth; live.classList.add('ping'); }

// ---------------------------------------------------------------- account: who Claude Code is logged in as right now
const EYE = 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z';
const EYE_OFF = 'M3 3l18 18M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7c1.7 0 3.2-.4 4.5-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2';
const CHEVRON = 'M6 9l6 6 6-6';
let pExtraOpen = false; // the extra-usage explanation stays open across the panel's rebuilds
// The row's groups (plan, identity, explanation, API-key button) sit in #account-facts, which is display: contents, so
// the CSS can order them per width; the eye works with or without a login, since Presenting covers the whole page.
function renderAccount(A) {
  const a = D.meta.account, box = $('account-facts'), btn = $('account-hide'), hid = ui.hideAccount;
  // how many accounts the numbers below cover ("none" is not an account)
  const keys = new Set([...A.sessions.keys()].map(acctOf).filter((k) => k !== 'none'));
  $('account-hint').textContent = (a ? 'Current login' : 'No login') + (keys.size > 1 ? ` · ${keys.size} accounts in this range` : '');
  btn.setAttribute('aria-pressed', String(hid)); // the name stays "Presenting mode"; pressed = on
  fill(btn, icon(hid ? EYE_OFF : EYE));
  // the way to Filters → Billing, where a project that recorded no account can be marked as using an API key
  const n = ui.apiProjects.length;
  const bill = [...D.sessions.values()].some((m) => !m.acct && m.p) ? h('button', { class: 'btn btn-ghost btn-sm account-bill', type: 'button', 'data-fk': 'acct:bill', onclick: pShowBilling, text: n ? `API-key projects: ${n}` : 'Mark API-key projects' }) : null;
  if (!a) { fill(box, h('span', { class: 'account-id' }, h('span', { class: 'em', text: 'No Claude login found' }), h('span', { class: 'org', text: 'Run /login in Claude Code. With an API key there is no login to show.' })), bill); return; }
  // hidden = the real values are not in the page at all (not blurred), so screenshots, screen shares and Ctrl+F show
  // nothing; "Account 2" (the number the 5-hour panel and Filters use) still tells a work login from a personal one
  const num = acctInfo().num.get(a.key);
  const who = hid ? [h('span', { class: 'em', text: num ? `Account ${num}` : 'Account' }), h('span', { class: 'hint', text: 'Presenting mode: details hidden' })]
    : [h('span', { class: 'em', text: a.email || '—' }), a.org ? h('span', { class: 'org', text: a.org }) : null];
  // extra usage: whether going past the plan's limits costs extra money (shown only when Claude Code says); the pill
  // opens its explanation on its own line, so a keyboard or a tap reaches it and nothing beside it moves
  const known = typeof a.extra === 'boolean';
  const why = h('span', { class: 'hint account-why', id: 'acct-extra-why', hidden: !pExtraOpen || null, text: a.extra ? 'Usage past your plan’s limits is billed as extra usage' : 'Usage stops at your plan’s limits; nothing extra is billed' });
  const extra = h('button', { class: 'tag account-extra', type: 'button', 'data-tone': a.extra ? 'warn' : null, 'data-fk': 'acct:extra', 'aria-expanded': String(pExtraOpen), 'aria-controls': 'acct-extra-why',
    onclick: () => { pExtraOpen = !pExtraOpen; why.hidden = !pExtraOpen; extra.setAttribute('aria-expanded', String(pExtraOpen)); } }, a.extra ? 'Extra usage on' : 'Extra usage off', icon(CHEVRON));
  fill(box, h('span', { class: 'account-plan' }, h('span', { class: 'tag', text: planLabel(a.type, a.tier).full }), known ? extra : null),
    h('span', { class: 'account-id' }, who), known ? why : null, bill);
}

function renderFoot() {
  const m = D.meta;
  fill($('foot'),
    h('span', { class: 'tag' }, icon('M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z'), 'Local only · nothing leaves this machine'),
    h('span', { text: 'Press ? for keyboard shortcuts' }),
    h('span', { text: `Reading ${m.root.split(', ').map(maskPath).join(', ')}` }), h('span', { text: `${int(m.files)} files · ${(m.bytes / 1e6).toFixed(0)} MB` }),
    h('span', { text: 'Cost = API list prices × tokens of each reply, counted once. See “Data & accuracy” for the checks.' }),
    h('span', { text: `Times in ${m.tz}` }));
}

// ---------------------------------------------------------------- render loop: a RenderState (public/machines.js)
let rs = RENDER_START, lastPtr = null;
addEventListener('pointermove', (e) => { lastPtr = { x: e.clientX, y: e.clientY }; }, { passive: true });
function renderEvent(ev) {
  const { state, effects } = renderStep(rs, ev);
  rs = state;
  for (const fx of effects) {
    if (fx === 'requestFrame') requestAnimationFrame(() => renderEvent({ type: 'frame' }));
    else if (fx === 'draw') draw();
    else if (fx === 'firstReady') {
      document.querySelectorAll('.card').forEach((c, i) => { c.style.setProperty('--i', String(i)); if (c.getBoundingClientRect().top > innerHeight) c.classList.add('below'); });
      document.body.classList.remove('is-loading'); document.body.classList.add('is-entering');
      setTimeout(() => document.body.classList.remove('is-entering'), 1400);
      loadHistory();
    }
  }
}
// Every panel and the card(s) it draws into. A panel off screen is not redrawn on each update: it is marked stale
// and drawn once it comes near the screen. Most of the page is off screen, so most of each update is skipped.
const PANELS = [
  ['top bar', renderTop, ['island']], ['spend panel', renderHero, ['spend']], ['tiles', renderKpis, ['kpis']], ['account panel', renderAccount, ['account']], ['usage panel', renderUsage, ['usage']],
  ['models panel', renderModels, ['models']], ['billing panel', renderBilling, ['billing']], ['5-hour windows', renderWindows, ['windows']],
  ['heatmap', renderHeat, ['heat']], ['performance panel', renderPerf, ['perf', 'rhythm']], ['day-by-day panel', renderDays, ['days']],
  ['projects panel', renderProjects, ['projects']], ['tools panel', renderTools, ['tools']], ['attribution panel', renderAttr, ['attr']],
  ['facts panel', renderFacts, ['behaviour']], ['accuracy panel', renderAccuracy, ['accuracy']], ['sessions table', renderSessions, ['sessions']], ['footer', renderFoot, ['foot']],
].map(([name, fn, ids]) => ({ name, fn, boxes: ids.map((id) => $(id)) }));
const onScreen = new Set(), stale = new Set(PANELS);
const near = (p) => p.boxes.some((b) => onScreen.has(b));
let lastA = null, lastP = null, fresh = false, everything = true; // fresh: lastA/P fit the data and settings; everything: draw off-screen panels too
const watcher = new IntersectionObserver((entries) => {
  for (const e of entries) { if (e.isIntersecting) onScreen.add(e.target); else onScreen.delete(e.target); }
  if ([...stale].some(near)) renderEvent({ type: 'request' }); // a stale panel came near: draw it, without recomputing
}, { rootMargin: '400px 0px' }); // ahead of the scroll, so it is up to date by the time you see it
for (const p of PANELS) for (const b of p.boxes) watcher.observe(b);
addEventListener('beforeprint', () => { everything = true; draw(); }); // a printout shows every panel: none may be stale

function render() { fresh = false; renderEvent({ type: 'request' }); } // the data, settings, size or clock changed
function draw() {
  if (!D) return; // nothing to draw before the first snapshot; it asks again
  // each panel draws on its own: one failing must not leave the others stale or the page stuck dimmed
  // a failed panel says so in its own card (a silent stale panel looks like real numbers); the next good draw clears it
  const safely = (name, fn, boxes = []) => {
    try { fn(); for (const b of boxes) b.querySelector('.draw-error')?.remove(); }
    catch (e) {
      console.error(`dashboard: the ${name} failed to draw`, e);
      for (const b of boxes) if (!b.querySelector('.draw-error')) b.querySelector('.core')?.append(h('p', { class: 'foot-note draw-error', role: 'alert', text: `This panel couldn’t be drawn (${e.message}). The rest of the page is fine; reloading usually fixes it.` }));
    }
  };
  try {
    // panels are rebuilt on every update: remember which rebuilt control had keyboard focus, and drop a tooltip
    // whose numbers are about to change (it returns on the next pointer move)
    const fk = document.activeElement?.dataset?.fk, tipOn = tip.hasAttribute('data-show');
    hideTip();
    const recompute = !fresh;
    if (recompute) {
      lastA = lastP = null;
      safely('data', () => { lastA = compute(); lastP = perfCompute(lastA); });
      fresh = !!(lastA && lastP);
      for (const p of PANELS) stale.add(p);
    }
    const A = lastA, P = lastP;
    if (A && P) {
      for (const p of PANELS) if (stale.has(p) && (everything || near(p))) { stale.delete(p); safely(p.name, () => p.fn(A, P), p.boxes); }
      everything = false;
      if (recompute && drawerIsOpen()) safely('session drawer', renderDrawer);
      if (recompute && pop.kind === 'open') safely('open menu', () => popEvent({ type: 'dataChanged', focusInside: $(POPS[pop.id][1]).contains(document.activeElement) }));
    }
    if (fk && document.activeElement === document.body) document.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
    // re-hover whatever is under the pointer, so an open tooltip shows the fresh numbers instead of vanishing
    if (tipOn && lastPtr) document.elementFromPoint(lastPtr.x, lastPtr.y)?.dispatchEvent(new PointerEvent('pointerenter', { clientX: lastPtr.x, clientY: lastPtr.y }));
    tickLive();
  } finally {
    renderEvent({ type: 'drawn' }); // always: the first one ends the loading state even if something above threw
  }
}

// ---------------------------------------------------------------- live connection: a ConnState (public/machines.js)
let conn = CONN_START, es = null, retryTimer = 0;
function connEvent(ev, data) {
  const { state, effects } = connStep(conn, ev);
  conn = state;
  for (const fx of effects) {
    if (fx === 'applySnapshot') { applySnapshot(data); render(); }
    else if (fx === 'applyDelta') { applyDelta(data); lastPush = Date.now(); ping(); render(); maybeReloadHistory(); }
    else if (fx === 'close') es.close();
    else if (fx === 'open') connect();
    else if (fx.kind === 'retry') { clearTimeout(retryTimer); retryTimer = setTimeout(() => connEvent({ type: 'retry' }), fx.ms); }
  }
  // the stream failed before the first snapshot: say so plainly instead of leaving the page dimmed as if still loading;
  // made once (a rebuilt alert is announced again on every retry), gone with the first data
  const note = $('l-load-error');
  if (D) note?.remove();
  else if (ev.type === 'error' && !note) {
    document.body.classList.remove('is-loading');
    fill($('spend-num'), '–'); // the page's placeholder "$0" would read as a real total; the first data fills it in
    $('filter-chips').after(h('div', { class: 'card', id: 'l-load-error', role: 'alert', style: { marginBottom: 'var(--gap)' } }, h('div', { class: 'core' },
      h('p', { class: 'draw-error', style: { margin: '0', fontSize: '15px', fontWeight: '500' }, text: 'Can’t reach the dashboard server. Is it running? Retrying…' }),
      h('p', { class: 'foot-note', text: 'Start it with npm start in the dashboard’s folder. Its first start reads every log before it answers; this page fills in by itself once it does.' }))));
  }
  tickLive();
}
function connect() {
  es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (e) => connEvent({ type: 'snapshot' }, JSON.parse(e.data)));
  es.addEventListener('delta', (e) => connEvent({ type: 'delta' }, JSON.parse(e.data)));
  // closed = the browser gave up on this stream (an HTTP error) and will not retry by itself
  es.onerror = () => connEvent({ type: 'error', closed: es.readyState === EventSource.CLOSED });
}

$('usage-table-btn').addEventListener('click', () => set({ usageTable: !ui.usageTable }));
NARROW.addEventListener('change', render); // the Dates button's text depends on the width
$('drawer-prev').addEventListener('click', () => stepDrawer(-1));
$('drawer-next').addEventListener('click', () => stepDrawer(1));

// keyboard shortcuts: never while typing in a field, never with Ctrl, Cmd or Alt
const SHORTCUTS = [['/', 'Search sessions'], ['1 – 6', 'Range: Today, 24h, 7 days, 30 days, 90 days, All'], ['f', 'Open or close Filters'],
  ['p', 'Presenting mode: hide or show personal details'],
  ['j / k', 'Next / previous session, in session details'], ['Esc', 'Close a menu or the session details'], ['?', 'This list']];
fill($('keys-list'), SHORTCUTS.map(([k, d]) => [h('dt', null, h('kbd', { text: k })), h('dd', { text: d })]));
addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || e.isComposing) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable], dialog')) return;
  // Presenting mode works everywhere, also inside the session details, where titles and branch names show
  if (e.key === 'p') { e.preventDefault(); togglePresenting(); return; }
  if (drawerIsOpen()) { if (e.key === 'j' || e.key === 'k') { e.preventDefault(); stepDrawer(e.key === 'j' ? 1 : -1); } return; }
  if (e.key === '/') $('sess-q').focus();
  else if (/^[1-6]$/.test(e.key)) set({ range: RANGES[+e.key - 1].v });
  else if (e.key === 'f') $('filter-btn').click();
  else if (e.key === '?') $('keys').showModal();
  else return;
  e.preventDefault();
});

// CSV of what a table holds for the current range and filters. Text that starts with = + - @ gets a leading ' so a
// spreadsheet never runs a session title from the logs as a formula; numbers stay numbers.
function downloadCsv(name, rows) {
  const url = URL.createObjectURL(new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1e4);
}
const csvRange = () => `${isoDay(lastA.from)}_${isoDay(lastA.to - 1)}`;
const money = (v) => Math.round(v * 1e4) / 1e4;
$('sess-csv').addEventListener('click', () => { if (!lastA) return; const d = D.dicts; downloadCsv(`claude-sessions-${csvRange()}.csv`, [
  ['Started', 'Session', 'Session id', 'Projects', 'Models', 'Length (min)', 'Claude working (min)', 'Prompts', 'API calls', 'Tools', 'Tokens', `${costWord(lastA).short} (USD)`, 'Claude Code’s counter (USD)'],
  ...sessRows.map((r) => [toLocalInput(r.t0).replace('T', ' '), tSessTitle(r), r.meta.id || '', r.projNames, [...r.models].map((m) => modelName(d.model[m])).join('; '),
    Math.round(r.span / 6e4), Math.round(r.active / 6e4), r.prompts, r.calls, r.tools, r.tok, money(r.cost), r.cc >= 0 ? money(r.cc) : ''])]); });
$('bill-csv').addEventListener('click', () => { if (!lastA) return; downloadCsv(`claude-cost-breakdown-${csvRange()}.csv`, [
  ['Model', 'Calls', 'Input tokens', 'Input (USD)', 'Cache write 5 min tokens', 'Cache write 5 min (USD)', 'Cache write 1 h tokens', 'Cache write 1 h (USD)', 'Cache read tokens', 'Cache read (USD)', 'Output tokens', 'Output (USD)', 'Web searches', 'Web search (USD)', 'Total (USD)'],
  ...billRows.map(([m, b]) => { const p = b.priced, c = (v) => (p ? money(v) : ''); return [D.dicts.model[m], b.calls, b.in, c(b.cIn), b.cw5, c(b.cCw5), b.cw1, c(b.cCw1), b.cr, c(b.cCr), b.out, c(b.cOut), b.ws, c(b.cWs), c(b.cIn + b.cCw5 + b.cCw1 + b.cCr + b.cOut + b.cWs)]; })]); });
// jump menu: the zone whose heading has passed the top 40% of the screen is "current"; checked only when a heading
// crosses that line (an IntersectionObserver), never on every scroll event
const zones = ['cost', 'activity', 'records'].map((k) => $('zone-' + k));
const markZone = () => {
  const cur = zones.filter((z) => z.getBoundingClientRect().top < innerHeight * 0.4).at(-1) || zones[0];
  for (const a of $('jump').children) a.setAttribute('aria-current', String(a.getAttribute('href') === '#' + cur.id));
};
const zoneWatch = new IntersectionObserver(markZone, { rootMargin: '0px 0px -60% 0px' });
zones.forEach((z) => zoneWatch.observe(z));
markZone();
// a big jump (End, Home, a jump link) can carry a heading past the line between two frames, unseen by the observer
addEventListener('scrollend', markZone);
$('jump').addEventListener('click', () => requestAnimationFrame(markZone)); // a frame later: the browser has scrolled by then
// the eye is Presenting mode: every panel redraws through set(); the prompt list redraws from its last answer
// Off-screen panels are normally redrawn only when scrolled near; here all of them redraw at once (like printing), or a
// full-page screenshot or Ctrl+F would still find the old text.
// the eye and the p key; the eye's name stays "Presenting mode", so screen readers hear the new state here instead
function togglePresenting() {
  everything = true; set({ hideAccount: !ui.hideAccount }); histReveal = false; if (lastHist) renderHistory(lastHist);
  $('account-sr').textContent = ui.hideAccount ? 'Presenting mode on: personal details hidden' : 'Presenting mode off';
}
$('account-hide').addEventListener('click', togglePresenting);
$('sess-q').value = ui.sessQ;
$('sess-q').addEventListener('input', (e) => set({ sessQ: e.target.value }));
$('hist-q').addEventListener('input', loadHistory);
$('drawer-close').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);
for (const [id, [btnId]] of Object.entries(POPS)) $(btnId).addEventListener('click', () => popEvent({ type: 'toggle', id }));
// a press outside the open popover (and outside its button, which toggles) closes it
document.addEventListener('pointerdown', (e) => {
  if (pop.kind !== 'open') return;
  const [btnId, popId] = POPS[pop.id];
  if (!$(popId).contains(e.target) && !$(btnId).contains(e.target)) popEvent({ type: 'close' });
});
// Esc closes the innermost layer: an open popover first, else the drawer
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (pop.kind === 'open') popEvent({ type: 'close', refocus: true });
  else if (drawerIsOpen()) closeDrawer();
});
// custom range: date + time, plus "last N hours" shortcuts
const customErr = (msg) => { const e = $('custom-error'); e.hidden = !msg; e.textContent = msg || ''; };
// "Live to now": the end isn't a fixed time but the current moment, so the range keeps moving
let customLive = false;
function setCustomLive(on) {
  customLive = on;
  const to = $('custom-to'), b = $('custom-now');
  to.disabled = on;
  if (on) to.value = toLocalInput(Date.now());
  to.previousElementSibling.textContent = on ? 'To: now, keeps moving' : 'To';
  b.setAttribute('aria-pressed', String(on));
}
function openCustom() {
  const [f, t] = rangeBounds();
  $('custom-from').value = toLocalInput(f);
  $('custom-to').value = toLocalInput(t);
  setCustomLive(liveEnd());
  customErr('');
  for (const b of [...$('quick-range').children, ...$('quick-hours').children]) b.setAttribute('aria-checked', String(b.dataset.range === ui.range));
}
const closeCustom = (refocus) => popEvent({ type: 'close', id: 'custom', refocus });
for (const id of ['quick-range', 'quick-hours']) $(id).addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { set({ range: b.dataset.range }); closeCustom(true); } });
$('custom-now').addEventListener('click', () => setCustomLive(!customLive));
$('custom-apply').addEventListener('click', () => {
  const f = $('custom-from').value, t = customLive ? 'now' : $('custom-to').value;
  if (!f || !t) return customErr('Pick both a start and an end.');
  if ((t === 'now' ? Date.now() : +new Date(t)) - +new Date(f) < 5 * 6e4) return customErr('The end must be at least 5 minutes after the start.');
  customErr('');
  set({ range: 'custom', from: f, to: t });
  closeCustom(true);
});

// theme: system -> light -> dark; the palette swaps with it (each validated for its own background)
const THEMES = ['system', 'light', 'dark'];
const THEME_ICON = {
  system: 'M4 5h16v11H4zM9 20h6M12 16v4',
  light: 'M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  dark: 'M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z',
};
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = THEMES.includes(ui.theme) ? ui.theme : 'system';
  const resolved = t === 'system' ? (darkQuery.matches ? 'dark' : 'light') : t;
  document.documentElement.dataset.theme = resolved;
  usePalette(resolved);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', resolved === 'dark' ? '#060607' : '#f3f2ee');
  const btn = $('theme-btn');
  btn.setAttribute('aria-label', `Theme: ${t}. Switch theme`); btn.title = `Theme: ${t}`;
  fill($('theme-icon'), s('path', { d: THEME_ICON[t] }));
  render();
}
$('theme-btn').addEventListener('click', () => { ui = uiStep(ui, { theme: THEMES[(THEMES.indexOf(ui.theme) + 1) % THEMES.length] }); save(); applyTheme(); });
darkQuery.addEventListener('change', () => { if (ui.theme === 'system') applyTheme(); });
applyTheme();

let lastW = 0; // re-draw charts on width changes only (height changes come from our own renders)
new ResizeObserver(([e]) => { const w = Math.round(e.contentRect.width); if (w !== lastW) { lastW = w; layoutEpoch++; render(); } }).observe(document.querySelector('.bento'));
// the usage chart's height follows the Models card beside it, not the width: when it changes, redraw that chart alone
let lastUH = 0;
new ResizeObserver(([e]) => {
  const hh = Math.round(e.contentRect.height);
  if (hh && hh !== lastUH) { lastUH = hh; sizeCache.delete(e.target); stale.add(PANELS.find((p) => p.fn === renderUsage)); renderEvent({ type: 'request' }); }
}).observe($('usage-chart'));
document.fonts?.ready.then(() => { layoutEpoch++; render(); }); // pills and charts are measured: again once Geist has loaded
// a rolling range moves with the clock even without new data; so does a history list that follows it
setInterval(() => {
  if (!D) return;
  if (isRolling()) render();
  if (ui.histRange === '24h' || (ui.histRange === 'page' && isRolling())) loadHistory();
}, 15000);
setInterval(() => { if (D && !isRolling()) render(); }, 60000); // clock-based labels ("2 h ago") and the current 5-hour window
setInterval(tickLive, 1000);
connect();
