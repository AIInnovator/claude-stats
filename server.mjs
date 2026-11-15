// Claude Code stats viewer: local-only HTTP server. Reads Claude Code's transcripts (read-only) and streams them live.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, Tailer, isTranscript } from './lib/store.mjs';
import { scanInit, scanStep, WATCH_UNARMED, watchStep } from './lib/machines.mjs';
import { PRICES } from './lib/pricing.mjs';
import { claudePaths } from './lib/paths.mjs';
import { readLogin } from './lib/accounts.mjs';

const PORT = Number(process.env.PORT) || 7420;
const HOST = '127.0.0.1';
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
// After files vanish or change under us, everything is re-read, at most this often: Claude Code's cleanup can
// delete many transcripts in a burst. Tests set REBUILD_GAP_MS=0.
const REBUILD_GAP_MS = Number(process.env.REBUILD_GAP_MS ?? 10000);
const MAX_BUFFERED = 8 << 20; // a tab that stops reading is dropped past this; it reconnects and gets a fresh snapshot
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// every Claude Code data folder on this machine, for this user (lib/paths.mjs)
function currentRoots() {
  const paths = claudePaths();
  return { paths, roots: paths.projects.length ? paths.projects : [path.join(paths.configs.at(-1), 'projects')] };
}

// ---- the data: one Store fed by one Tailer per transcript folder; rebuilt whole when files change under it
let PATHS, ROOTS, store, tailers, rebuilds = 0;
const started = Date.now();
let scannedAt = Date.now();
const fileCount = () => tailers.reduce((n, t) => n + t.files.size, 0);
const sum = (f) => tailers.reduce((n, t) => n + f(t), 0);
function build() {
  const t0 = performance.now();
  ({ paths: PATHS, roots: ROOTS } = currentRoots());
  store = new Store();
  tailers = ROOTS.map((root) => new Tailer(store, root));
  for (const t of tailers) { t.scan('all'); t.structural = false; } // a fresh read is the truth
  store.clearDirty();
  scannedAt = Date.now();
  return performance.now() - t0;
}
const firstMs = build();
if (!PATHS.projects.length) console.warn(`No Claude Code transcripts found. Looked in: ${PATHS.configs.map((d) => path.join(d, 'projects')).join(', ')}. Set CLAUDE_CONFIG_DIR if yours are elsewhere; the dashboard will start empty and pick them up once they appear.`);
// Terminal output is kept to one start-up line plus problems, each said once (the page shows the folders read).
let lastWarning = '';
const warnOnce = (msg) => { if (msg !== lastWarning) { lastWarning = msg; console.warn(msg); } };

// ---- the Claude logins saved in every .claude.json (lib/paths.mjs finds them), each re-read only when its file
// changes. The current login is the first file's, as before; every login teaches the page its plan. Only the fields
// readLogin keeps leave (a hashed key, never the ids); the login tokens live in another file this never opens.
const loginCache = new Map(); // file -> { stat, value }
function logins() {
  const all = claudePaths().account.map((f) => {
    let stat = '';
    try { const st = fs.statSync(f); stat = `${st.size}:${st.mtimeMs}`; } catch { /* gone since listed */ }
    const c = loginCache.get(f);
    if (c?.stat === stat) return c.value;
    let value = null;
    try { if (stat) value = readLogin(f); } catch { return c?.value ?? null; } // caught mid-write by Claude Code: keep the last value, read it again next time
    loginCache.set(f, { stat, value });
    return value;
  });
  const accounts = [];
  // one entry per account: a .claude folder can have a .claude.json inside and beside it naming the same login
  for (const l of all) if (l?.key && !accounts.some((a) => a.key === l.key)) accounts.push({ key: l.key, type: l.type, tier: l.tier, org: l.org });
  return { account: all[0] || null, accounts };
}

const meta = () => ({
  ...logins(), root: ROOTS.join(', '), files: fileCount(), bytes: sum((t) => [...t.files.values()].reduce((n, f) => n + f.off, 0)), scannedAt, started,
  prices: PRICES, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lines: store.lines, badLines: store.badLines,
  recovered: store.recovered, readErrors: sum((t) => t.readErrors), rebuilds, lastRebuild: scan.lastRebuild,
});

// ---- live updates: a ScanState (lib/machines.mjs) decides; this code only performs its effects. Events are
// queued, so an effect that produces the next event (a scan → 'scanned') never re-enters a transition.
const clients = new Set();
let scan = scanInit(Date.now(), REBUILD_GAP_MS), readErrorsSeen = 0, lastScanError = '';
const scanQueue = [];
let draining = false;
function scanEvent(ev) {
  scanQueue.push(ev);
  if (draining) return;
  draining = true;
  try {
    while (scanQueue.length) {
      const { state, effects } = scanStep(scan, scanQueue.shift());
      scan = state;
      for (const fx of effects) {
        if (fx === 'invalid') continue; // e.g. a stale timer: rejected by the machine, nothing to do
        if (fx.kind === 'timer') setTimeout(() => scanEvent({ type: 'fire', now: Date.now() }), fx.ms);
        else if (fx.kind === 'wake') setTimeout(() => scanEvent({ type: 'trigger', now: Date.now() }), fx.ms);
        else if (fx.kind === 'scan') runScan(fx.target);
        else if (fx === 'delta') { scannedAt = Date.now(); const d = store.takeDelta(); if (d) { d.meta = meta(); broadcast('delta', d); } }
        else if (fx === 'rebuild') {
          build(); rebuilds++; // normal after Claude Code deletes or rewrites a transcript: nothing to print
          broadcast('snapshot', store.snapshot(meta()));
        } else if (fx === 'log') warnOnce(`scan failed, retrying on the next change: ${lastScanError}`);
      }
    }
  } finally { draining = false; }
}
function runScan(target) {
  let structural;
  try {
    // only the files the watcher named, unless a full check was asked for (safety poll, unnamed event)
    for (const t of tailers) t.scan(target === 'all' ? 'all' : target.filter((f) => f.startsWith(t.root + path.sep)));
    watchAll();
    structural = tailers.some((t) => t.structural) || currentRoots().roots.join('|') !== ROOTS.join('|');
    const errs = sum((t) => t.readErrors);
    if (errs > readErrorsSeen) { readErrorsSeen = errs; warnOnce(`could not read a transcript (${tailers.map((t) => t.lastError).filter(Boolean).at(-1)}); retrying on the next scan`); }
  } catch (e) {
    lastScanError = e.message; // a timer callback that throws would end the process
    scanEvent({ type: 'failed', now: Date.now() });
    return;
  }
  scanEvent({ type: 'scanned', now: Date.now(), structural });
}
function send(res, msg) {
  // a tab that stopped reading (sleeping laptop, frozen tab) would make unsent updates pile up in memory
  if (!res.write(msg) && res.writableLength > MAX_BUFFERED) { clients.delete(res); res.destroy(); }
}
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) send(res, msg);
}

// ---- folder watchers: one WatchState (lib/machines.mjs) per transcript folder. Recursive fs.watch works on
// Windows, macOS and (Node 20+) Linux. It names the changed file, so a live update checks only that file.
const watch = new Map(); // root -> { state, w }
function watchEvent(root, ev) {
  const cur = watch.get(root) || { state: WATCH_UNARMED, w: null };
  watch.set(root, cur);
  const { state, effects } = watchStep(cur.state, ev);
  cur.state = state;
  for (const fx of effects) {
    if (fx === 'close') { cur.w?.close(); cur.w = null; }
    else if (fx === 'warn') console.warn(ev.type === 'armFailed' ? `fs.watch unavailable for ${root}; checking every 4 s instead` : `watcher for ${root} stopped; checking every 4 s and re-arming`);
    else if (fx === 'arm') {
      let w;
      try { w = fs.watch(root, { recursive: true }, (type, name) => onWatch(root, name)); } catch { watchEvent(root, { type: 'armFailed' }); continue; }
      w.on('error', () => watchEvent(root, { type: 'error' }));
      cur.w = w;
      watchEvent(root, { type: 'armOk' });
    }
  }
}
function watchAll() {
  for (const [root, cur] of watch) if (!ROOTS.includes(root)) { cur.w?.close(); watch.delete(root); } // folder list changed (rebuild)
  for (const root of ROOTS) watchEvent(root, { type: 'check', exists: isDir(root) });
}
function onWatch(root, name) {
  const f = name ? path.join(root, String(name)) : null;
  scanEvent({ type: 'trigger', now: Date.now(), file: f && isTranscript(f) ? f : undefined }); // anything else: check all
}
watchAll();
// Safety poll: a full check every 30 s while every folder is watched, every 4 s while one is not (no watcher,
// or its folder doesn't exist yet). Idle cost while you work with Claude: one directory listing every 30 s.
let lastPoll = Date.now(), sentAccount = JSON.stringify(logins());
setInterval(() => {
  // a login switch writes no transcript line, so no delta would carry it: send the new account(s) on their own
  const a = JSON.stringify(logins());
  if (a !== sentAccount) { sentAccount = a; broadcast('delta', { dicts: {}, tables: {}, sessions: {}, meta: meta() }); }
  const watched = ROOTS.every((r) => watch.get(r)?.state.kind === 'armed');
  if (watched && Date.now() - lastPoll < 30000) return;
  lastPoll = Date.now();
  scanEvent({ type: 'trigger', now: lastPoll });
}, 4000);
setInterval(() => { for (const res of clients) send(res, ': ping\n\n'); }, 20000);

// ---- prompt history (optional panel): parsed lazily, re-read when the file changes
let hist = { key: '', rows: [] };
function history() {
  // every history.jsonl found (one per config folder); re-read only when one of them changed
  const files = claudePaths().history;
  const stats = files.map((f) => { try { const st = fs.statSync(f); return `${f}:${st.size}:${st.mtimeMs}`; } catch { return ''; } });
  const key = stats.join('|');
  if (hist.key !== key) {
    const rows = [], seen = new Set();
    for (const f of files) {
      let text;
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const j = JSON.parse(line);
          if (!j.display || !Number.isFinite(j.timestamp)) continue;
          const id = `${j.timestamp}|${j.display.length}|${j.sessionId || ''}`; // the same prompt in two folders shows once
          if (seen.has(id)) continue;
          seen.add(id);
          rows.push({ t: j.timestamp, project: j.project || '', sessionId: j.sessionId || '', text: j.display, lc: j.display.toLowerCase() });
        } catch { /* partial line */ }
      }
    }
    rows.sort((a, b) => b.t - a.t);
    hist = { key, rows };
  }
  return hist.rows;
}
function searchHistory(q) {
  const words = (q.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
  const from = Number(q.get('from')) || 0, to = Number(q.get('to')) || Infinity, project = q.get('project') || '', account = q.get('account') || '';
  // the page pages through 60 at a time or asks for all; the cap only stops a runaway request
  const limit = Math.min(Number(q.get('limit')) || 80, 20000);
  // 'none': no owner line, or a session no transcript has (any more); a lookup only, so a GET never adds a session
  const acctOf = (sid) => store.sessions.get(store.dicts.session.map.get(sid))?.acct || 'none';
  const items = []; let total = 0;
  for (const r of history()) {
    if (r.t < from || r.t >= to || (project && r.project !== project) || (account && acctOf(r.sessionId) !== account) || !words.every(w => r.lc.includes(w))) continue;
    if (total++ < limit) items.push({ t: r.t, project: r.project, sessionId: r.sessionId, text: r.text.length > 4000 ? r.text.slice(0, 4000) + '…' : r.text });
  }
  return { total, items };
}

// ---- HTTP
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const server = http.createServer((req, res) => {
  // DNS-rebinding guard: only answer requests addressed to this machine by name.
  if (!ALLOWED_HOSTS.has(req.headers.host)) { res.writeHead(403).end('forbidden host'); return; }
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  // A malformed path ('//', '/%', '/%E0') must answer 400, never throw: any web page can send one to 127.0.0.1.
  let url, rel;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
    rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch { res.writeHead(400).end('bad request'); return; }

  if (url.pathname === '/api/stream') {
    res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`retry: 2000\nevent: snapshot\ndata: ${JSON.stringify(store.snapshot(meta()))}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/api/history') {
    res.writeHead(200, { ...SECURITY, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(searchHistory(url.searchParams)));
    return;
  }
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !TYPES[path.extname(file)]) { res.writeHead(404).end('not found'); return; }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { ...SECURITY, 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': rel.startsWith('fonts/') ? 'max-age=31536000' : 'no-cache' });
    res.end(body);
  });
});
server.listen(PORT, HOST, () => console.log(`Claude stats → http://127.0.0.1:${PORT}  (${store.req.n} calls from ${fileCount()} files, read in ${(firstMs / 1000).toFixed(1)} s; Ctrl+C to stop)`));
