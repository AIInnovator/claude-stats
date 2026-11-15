// Columnar, dictionary-encoded store of Claude Code usage, fed by tailing transcript JSONL files.
// Every row is keyed (message id, tool_use id, line uuid), so re-reading a line is an idempotent upsert.
import fs from 'node:fs';
import path from 'node:path';
import { costOf } from './pricing.mjs';
import { FILE_UNSEEN, fileStep } from './machines.mjs';
import { toolStep, hasCall, counterStep, COUNTER_EMPTY } from '../public/machines.js';

class Dict {
  constructor() { this.list = ['']; this.map = new Map([['', 0]]); this.sent = 1; }
  id(s) {
    if (s == null || s === '') return 0;
    let i = this.map.get(s);
    if (i === undefined) { i = this.list.length; this.list.push(s); this.map.set(s, i); }
    return i;
  }
}

class Table {
  constructor(cols) { this.cols = Object.fromEntries(cols.map(c => [c, []])); this.n = 0; this.keys = new Map(); this.dirty = new Set(); }
  /** fn(i, isNew) mutates columns; return false when nothing changed. */
  upsert(key, fn) {
    let i = this.keys.get(key);
    const isNew = i === undefined;
    if (isNew) { i = this.n++; this.keys.set(key, i); for (const c in this.cols) this.cols[c].push(0); }
    if (fn(this.cols, i, isNew) !== false || isNew) this.dirty.add(i);
    return i;
  }
}

// Columns the page receives: cp only ranks rows on the server (Store.wins), so it is never sent.
const sent = ({ cp, ...cols }) => cols;

const DIMS = ['session', 'project', 'model', 'agent', 'skill', 'plugin', 'mcp', 'effort', 'stop', 'version', 'branch', 'tool', 'perm', 'deny', 'src', 'kind'];
const TOK = ['in', 'out', 'cr', 'cw5', 'cw1', 'th', 'ws', 'wf'];

export class Store {
  constructor() {
    this.dicts = Object.fromEntries(DIMS.map(d => [d, new Dict()]));
    // ln = log lines that carried this response (Claude Code writes one per content block; /stats-style totals count each)
    // cp = rank of the row's line: 2 if copied from another session, +1 if a subagent line (see ingest() and wins())
    this.req = new Table(['t', 's', 'p', 'm', 'a', 'sk', 'pl', 'mc', 'ef', 'stop', 'v', 'b', 'adv', 'fast', ...TOK, 'tdm', 'cost', 'ln', 'cp']);
    // ts = ToolState (public/machines.js): r (the call's row) means something only when hasCall(ts)
    this.tool = new Table(['t', 's', 'p', 'a', 'n', 'r', 'sk', 'err', 'perm', 'deny', 'ts', 'cp']);
    this.turn = new Table(['t', 's', 'p', 'dur', 'msgs', 'cp']);
    this.prompt = new Table(['t', 's', 'p', 'src', 'len', 'cp']);
    this.evt = new Table(['t', 's', 'p', 'k', 'x', 'y', 'cp']);
    this.line = null; // rank of the line being ingested: { cp, t, sid }
    this.sessions = new Map(); // session dict idx -> meta
    this.dirtySessions = new Set();
    this.badLines = 0;
    this.lines = 0; // parsed lines (metadata lines skipped unparsed are not counted)
    this.recovered = 0; // records saved from a line a crashed writer left half-written
    this.seen = new Set(); // line uuids already counted
    this.seq = 0;
  }

  tables() { return { req: this.req, tool: this.tool, turn: this.turn, prompt: this.prompt, evt: this.evt }; }

  session(id) {
    const s = this.dicts.session.id(id);
    let m = this.sessions.get(s);
    if (!m) { m = { id, p: 0, t0: 0, t1: 0, title: '', branch: '', version: '', cs: null }; this.sessions.set(s, m); }
    return [s, m];
  }

  /** Ingest a buffer of complete lines (must end on a line boundary). ctx (per file) remembers the last time seen. */
  ingestBuffer(buf, ctx = null) {
    let start = 0;
    while (start < buf.length) {
      let nl = buf.indexOf(10, start);
      if (nl === -1) nl = buf.length;
      // Metadata lines start with {"type":"…"; only cost-state and ai-title matter, skip the rest undecoded (api-request-blob is huge).
      if (buf[start + 2] === 116 /* t */ && buf.toString('latin1', start, start + 9) === '{"type":"') {
        const head = buf.toString('latin1', start + 9, start + 20);
        if (!/^(cost-state|ai-title|user"|assistant"|system")/.test(head)) { start = nl + 1; continue; }
      }
      if (nl > start) {
        let j;
        const text = buf.toString('utf8', start, nl);
        try { j = JSON.parse(text); } catch {
          // A writer that died mid-line leaves a fragment; the next record then lands on the same line.
          // Keep that next record instead of losing it with the fragment.
          j = recoverGlued(text);
          if (j) this.recovered++; else this.badLines++;
        }
        if (j) {
          // count each log line once, even if a truncated or replaced file is read again
          const fresh = !j.uuid || !this.seen.has(j.uuid);
          if (fresh) { this.lines++; if (j.uuid) this.seen.add(j.uuid); }
          // one valid-JSON line with an odd shape must never stop the server
          try { this.ingest(j, fresh, ctx); } catch { this.badLines++; }
        }
      }
      start = nl + 1;
    }
  }

  ingest(j, fresh = true, ctx = null) {
    if (!j.sessionId) return;
    const [s, sm] = this.session(j.sessionId);
    const D = this.dicts;
    if (j.type === 'cost-state') {
      const cost = Number(j.totalCostUSD) || 0;
      const models = Object.fromEntries(Object.entries(j.modelUsage && typeof j.modelUsage === 'object' ? j.modelUsage : {}).map(([m, u]) => [m, Number(u?.costUSD) || 0]));
      // Every snapshot, with the time of the last line before it in the same file (the line itself has no time),
      // goes through counterStep (public/machines.js); the page turns them into per-period background spend.
      const before = sm.counter || COUNTER_EMPTY;
      sm.counter = counterStep(before, { type: 'snapshot', at: ctx?.lastT || sm.t1 || 0, cost, models }).state;
      if (sm.counter !== before) this.dirtySessions.add(s);
      // Keep the largest snapshot for display. The counter is persisted so a resumed session can restore it, so
      // summing snapshots across process starts could double-count; the max can only under-count, never inflate.
      if (sm.cs && sm.cs.cost >= cost) return;
      sm.cs = { cost, api: j.totalAPIDuration || 0, tool: j.totalToolDuration || 0, total: j.totalDuration || 0, add: j.totalLinesAdded || 0, del: j.totalLinesRemoved || 0, models };
      this.dirtySessions.add(s);
      return;
    }
    if (j.type === 'ai-title') { if (sm.title !== j.aiTitle) { sm.title = j.aiTitle; this.dirtySessions.add(s); } return; }
    const t = Date.parse(j.timestamp);
    if (!t) return;
    if (ctx && t > (ctx.lastT || 0)) ctx.lastT = t;
    // Rank of the line, lowest kept (wins()); only breaks ties between rows, never skips a line.
    // +2: a background or resumed session copies its parent's lines into its own file under its own sessionId, but
    //     keeps session_id = the parent: those are copies.
    // +1: a subagent line. A subagent's transcript can start with a copy of the main thread's Agent call that launched
    //     it (same message id, tool_use id, time and sessionId, but isSidechain): without this rank the first file read
    //     decided whether that call counted as main or subagent.
    this.line = { cp: (j.session_id !== undefined && j.session_id !== j.sessionId ? 2 : 0) + (j.isSidechain ? 1 : 0), t, sid: j.sessionId };
    const p = D.project.id(j.cwd);
    // session meta: span, project (main thread wins), latest branch / version
    if (!sm.t0 || t < sm.t0) { sm.t0 = t; this.dirtySessions.add(s); }
    if (t > sm.t1) { sm.t1 = t; if (j.gitBranch) sm.branch = j.gitBranch; if (j.version) sm.version = j.version; this.dirtySessions.add(s); }
    if (!sm.p || (!j.isSidechain && sm.pSide)) { sm.p = p; sm.pSide = !!j.isSidechain; this.dirtySessions.add(s); }
    const a = D.agent.id(j.attributionAgent || (j.isSidechain ? 'subagent' : 'main'));

    if (j.type === 'assistant') this.assistant(j, t, s, p, a, fresh);
    else if (j.type === 'user') this.user(j, t, s, p, a);
    else if (j.type === 'system') this.system(j, t, s, p);
  }

  /**
   * Does the line being ingested (re)write row i? A row several sessions share keeps its best line: the original
   * before a copy, the main thread before a subagent line, then the earliest, then the lowest session id. A minimum doesn't depend on read order, so a
   * rebuild or a live tail gives every row the same session. Sets the row's cp when it does.
   */
  wins(C, i, isNew) {
    const o = this.line;
    if (!isNew) {
      if (o.cp !== C.cp[i]) { if (o.cp > C.cp[i]) return false; }
      else if (o.t !== C.t[i]) { if (o.t > C.t[i]) return false; }
      else if (!(o.sid < this.dicts.session.list[C.s[i]])) return false;
    }
    C.cp[i] = o.cp;
    return true;
  }

  assistant(j, t, s, p, a, fresh = true) {
    const D = this.dicts, msg = j.message || {};
    if (j.apiError || j.isApiErrorMessage) {
      const q = j.quotaLimits;
      this.evt.upsert(j.uuid, (C, i, isNew) => { if (!this.wins(C, i, isNew)) return false; C.t[i] = t; C.s[i] = s; C.p[i] = p; C.k[i] = D.kind.id(q ? 'limit:' + q.rateLimitType : 'api_error:' + (j.apiError || 'unknown')); C.x[i] = q?.resetsAt ? q.resetsAt * 1000 : 0; });
    }
    const u = msg.usage;
    if (!u || !msg.id || msg.model === '<synthetic>') return;
    const dims = {
      t, s, p, a, m: D.model.id(msg.model), sk: D.skill.id(j.attributionSkill), pl: D.plugin.id(j.attributionPlugin), mc: D.mcp.id(j.attributionMcpServer),
      ef: D.effort.id(j.effort), v: D.version.id(j.version), b: D.branch.id(j.gitBranch), fast: u.speed === 'fast' ? 1 : 0,
    };
    const r = this.upsertCall(msg.id, dims, msg.model, u, 0, j, fresh);
    (u.iterations || []).forEach((it, k) => {
      if (it.type !== 'advisor_message') return;
      this.upsertCall(msg.id + '#a' + k, { ...dims, m: D.model.id(it.model) }, it.model, it, 1, null);
    });
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b?.type !== 'tool_use' && b?.type !== 'server_tool_use') continue;
      this.tool.upsert(b.id, (C, i, isNew) => {
        // a call always fills a row that has none yet; between calls, the best-ranked line keeps it
        if (hasCall(C.ts[i])) { if (!this.wins(C, i, isNew)) return false; } else C.cp[i] = this.line.cp;
        C.ts[i] = toolStep(C.ts[i], 'call').state;
        C.t[i] = t; C.s[i] = s; C.p[i] = p; C.a[i] = a; C.n[i] = D.tool.id(b.name); C.r[i] = r; C.sk[i] = dims.sk;
      });
    }
  }

  /** One API call row. Lines repeating a message id carry the same or growing usage: keep per-field max, earliest time. */
  upsertCall(key, dims, model, u, adv, j, fresh = true) {
    const cc = u.cache_creation;
    const tok = {
      in: u.input_tokens || 0, out: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0,
      cw5: cc ? cc.ephemeral_5m_input_tokens || 0 : u.cache_creation_input_tokens || 0, cw1: cc ? cc.ephemeral_1h_input_tokens || 0 : 0,
      th: u.output_tokens_details?.thinking_tokens || 0, ws: u.server_tool_use?.web_search_requests || 0, wf: u.server_tool_use?.web_fetch_requests || 0,
    };
    return this.req.upsert(key, (C, i, isNew) => {
      let changed = isNew;
      if (this.wins(C, i, isNew)) { for (const k in dims) C[k][i] = dims[k]; C.adv[i] = adv; changed = true; }
      for (const k of TOK) if (tok[k] > C[k][i]) { C[k][i] = tok[k]; changed = true; }
      if (j) {
        if (fresh) { C.ln[i]++; changed = true; }
        if (j.thinkingDurationMs > C.tdm[i]) { C.tdm[i] = j.thinkingDurationMs; changed = true; }
        const st = this.dicts.stop.id(j.message.stop_reason);
        if (st && st !== C.stop[i]) { C.stop[i] = st; changed = true; }
      }
      if (!changed) return false;
      C.cost[i] = costOf(model, { in: C.in[i], out: C.out[i], cr: C.cr[i], cw5: C.cw5[i], cw1: C.cw1[i], ws: C.ws[i], fast: C.fast[i] });
    });
  }

  user(j, t, s, p, a = 0) {
    const D = this.dicts, c = j.message?.content;
    const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text) : [];
    // you stopped Claude: Esc (Claude Code writes a fixed marker) or a prompt sent with "send now"
    if (!j.isSidechain && (j.interruptedBySendNow || texts.some(x => x.startsWith('[Request interrupted by user')))) {
      this.evt.upsert(j.uuid, (C, i, isNew) => { if (!this.wins(C, i, isNew)) return false; C.t[i] = t; C.s[i] = s; C.p[i] = p; C.k[i] = D.kind.id('interrupt'); });
    }
    const results = Array.isArray(c) ? c.filter(b => b?.type === 'tool_result') : [];
    if (results.length) {
      const pd = j.permissionDecision;
      const perm = pd ? `${pd.decision}:${pd.source}` : '';
      // One tool_use_id can have several result lines (forks, resumed sessions): merge order-independently.
      const pick = (dict, cur, next) => (next && (!cur || next > dict.list[cur]) ? dict.id(next) : cur);
      for (const b of results) {
        this.tool.upsert(b.tool_use_id, (C, i, isNew) => {
          // Result seen before (or without) its call: state RESULT, and r = -1 rather than 0 (row 0 is a real call,
          // so 0 would credit this result to whatever model that call used). The call, if it arrives, fills the rest.
          // Until its call is seen, the best-ranked result line places the row (results copied into two sessions).
          const moved = !hasCall(C.ts[i]) && this.wins(C, i, isNew);
          if (moved) { C.t[i] = t; C.s[i] = s; C.p[i] = p; C.a[i] = a; C.r[i] = -1; }
          const ts = toolStep(C.ts[i], 'result').state;
          const err = Math.max(C.err[i], b.is_error ? 1 : 0), pm = pick(D.perm, C.perm[i], perm), dn = pick(D.deny, C.deny[i], j.toolDenialKind);
          if (!moved && C.err[i] === err && C.perm[i] === pm && C.deny[i] === dn && C.ts[i] === ts) return false;
          C.err[i] = err; C.perm[i] = pm; C.deny[i] = dn; C.ts[i] = ts;
        });
      }
      return;
    }
    if (j.isSidechain || j.isCompactSummary) return;
    const legacy = j.turnOrigin === undefined && j.promptSource === undefined && !j.isMeta && typeof c === 'string' && !c.startsWith('<');
    if (j.turnOrigin !== 'human' && !legacy) return;
    this.prompt.upsert(j.uuid, (C, i, isNew) => {
      if (!this.wins(C, i, isNew)) return false;
      // len: characters you typed (a number only; prompt text never leaves the server through this table)
      C.t[i] = t; C.s[i] = s; C.p[i] = p; C.src[i] = D.src.id(j.promptSource || 'typed'); C.len[i] = texts.reduce((n, x) => n + x.length, 0);
    });
  }

  system(j, t, s, p) {
    const D = this.dicts;
    if (j.subtype === 'turn_duration') {
      this.turn.upsert(j.uuid, (C, i, isNew) => { if (!this.wins(C, i, isNew)) return false; C.t[i] = t; C.s[i] = s; C.p[i] = p; C.dur[i] = j.durationMs || 0; C.msgs[i] = j.messageCount || 0; });
    } else if (j.subtype === 'compact_boundary') {
      const m = j.compactMetadata || {};
      this.evt.upsert(j.uuid, (C, i, isNew) => { if (!this.wins(C, i, isNew)) return false; C.t[i] = t; C.s[i] = s; C.p[i] = p; C.k[i] = D.kind.id('compact:' + (m.trigger || 'auto')); C.x[i] = m.preTokens || 0; C.y[i] = m.postTokens || 0; });
    } else if (j.subtype === 'stop_hook_summary') {
      const ms = (Array.isArray(j.hookInfos) ? j.hookInfos : []).reduce((sum, x) => sum + (x?.durationMs || 0), 0);
      this.evt.upsert(j.uuid, (C, i, isNew) => { if (!this.wins(C, i, isNew)) return false; C.t[i] = t; C.s[i] = s; C.p[i] = p; C.k[i] = D.kind.id('hooks'); C.x[i] = ms; C.y[i] = j.hookCount || 0; });
    } else if (j.subtype === 'model_refusal_fallback' || j.subtype === 'model_refusal_no_fallback') {
      this.evt.upsert(j.uuid, (C, i, isNew) => { if (!this.wins(C, i, isNew)) return false; C.t[i] = t; C.s[i] = s; C.p[i] = p; C.k[i] = D.kind.id(j.subtype); });
    }
  }

  snapshot(meta) {
    const tables = {};
    for (const [name, tb] of Object.entries(this.tables())) { tables[name] = { n: tb.n, cols: sent(tb.cols) }; }
    return { seq: this.seq, meta, dicts: Object.fromEntries(Object.entries(this.dicts).map(([k, d]) => [k, d.list])), tables, sessions: Object.fromEntries(this.sessions) };
  }

  /** Changes since the last delta, or null. Rows are sent whole, so applying a delta twice is harmless. */
  takeDelta() {
    const out = { seq: ++this.seq, dicts: {}, tables: {}, sessions: {} };
    let any = false;
    for (const [k, d] of Object.entries(this.dicts)) if (d.list.length > d.sent) { out.dicts[k] = [d.sent, d.list.slice(d.sent)]; d.sent = d.list.length; any = true; }
    for (const [name, tb] of Object.entries(this.tables())) {
      if (!tb.dirty.size) continue;
      const idx = [...tb.dirty]; tb.dirty.clear();
      out.tables[name] = { n: tb.n, idx, cols: Object.fromEntries(Object.entries(sent(tb.cols)).map(([c, arr]) => [c, idx.map(i => arr[i])])) };
      any = true;
    }
    for (const s of this.dirtySessions) { out.sessions[s] = this.sessions.get(s); any = true; }
    this.dirtySessions.clear();
    if (!any) { this.seq--; return null; }
    return out;
  }

  clearDirty() {
    for (const tb of Object.values(this.tables())) tb.dirty.clear();
    this.dirtySessions.clear();
    for (const d of Object.values(this.dicts)) d.sent = d.list.length;
  }
}

// Transcripts: <session>.jsonl, set-aside copies <session>.orphaned-<t>-<s>.jsonl, and <session>.jsonl.superseded-<t>
// (Claude Code docs, "Explore the .claude directory"). Set-aside copies can hold billed calls the current file lacks;
// whatever they share with it is counted once, because every row is keyed by id.
export const isTranscript = (f) => f.endsWith('.jsonl') || /\.jsonl\.superseded-[^\\/]*$/.test(f);

/** A record glued onto a fragment a crashed writer left behind: try each '{"' start, left to right. */
function recoverGlued(text) {
  for (let k = text.indexOf('{"', 1), tries = 0; k > 0 && tries < 50; k = text.indexOf('{"', k + 1), tries++) {
    try { const j = JSON.parse(text.slice(k)); if (j && typeof j === 'object' && (j.type || j.sessionId)) return j; } catch { /* not a record start */ }
  }
  return null;
}

const HEAD = 128; // bytes kept per file to notice a file rewritten in place (same name, same id, new contents)

/**
 * Follows transcripts by byte offset; only complete lines are consumed. Each file's state is a FileState
 * (lib/machines.mjs) and changes only through fileStep; this class just performs its effects (stat, read).
 * The 'restart' effect (a file vanished, shrank, was replaced or rewritten in place) sets `structural`: rows
 * already taken from that file can't be trusted, so the owner (the server) rebuilds from scratch.
 */
export class Tailer {
  constructor(store, root) { this.store = store; this.root = root; this.files = new Map(); this.bytes = 0; this.structural = false; this.readErrors = 0; this.lastError = ''; }

  list() {
    try { return fs.readdirSync(this.root, { recursive: true }).filter(isTranscript).map(f => path.join(this.root, f)); }
    catch { return []; }
  }

  /** Check every transcript ('all') or only the files a watcher named (the cheap path for live updates). */
  scan(target = 'all') {
    let changed = 0;
    if (target === 'all') {
      const present = new Set(this.list());
      for (const f of present) changed += this.check(f);
      for (const f of [...this.files.keys()]) if (!present.has(f)) changed += this.check(f); // gone: cleanup, claude purge
    } else for (const f of target) changed += this.check(f);
    return changed;
  }

  check(f) {
    let stat = null;
    try { stat = fs.statSync(f); } catch { /* missing */ }
    const ev = stat?.isFile() ? { type: 'stat', size: stat.size, id: `${stat.ino}:${stat.birthtimeMs}` } : { type: 'missing' };
    return this.drive(f, ev, stat?.size || 0);
  }

  /** Feed one event to the file's machine and carry out its effects until it settles. */
  drive(f, ev, size) {
    let st = this.files.get(f) || FILE_UNSEEN, changed = 0;
    for (let step = 0; ev && step < 4; step++) {
      const { state, effects } = fileStep(st, ev);
      st = state; ev = null;
      if (effects.includes('restart')) this.structural = true;
      if (effects.includes('read')) { ev = this.read(f, st, size); if (ev.type === 'readOk') changed = 1; }
    }
    if (st.kind === 'tracked') this.files.set(f, st); else this.files.delete(f);
    return changed;
  }

  /** Returns the next event for fileStep: readOk { end, head } | headChanged | readFailed (offset kept). */
  read(f, st, size) {
    let fd;
    // Read-only, held only for this read. Node opens files on Windows with share-read/write/delete, so a
    // Claude Code session can append, rewrite, rename or delete the file meanwhile (scripts/lockcheck.mjs proves it).
    // Never add an exclusive flag here: that is what makes other programs report "file is busy".
    try { fd = fs.openSync(f, 'r'); } catch (e) {
      if (e.code !== 'ENOENT') { this.readErrors++; this.lastError = `${path.basename(f)}: ${e.code || e.message}`; }
      return { type: 'readFailed' };
    }
    try {
      if (st.off > 0 && st.head) {
        const h = Buffer.alloc(st.head.length); // the same bytes that were saved, never more (the file may have been short)
        fs.readSync(fd, h, 0, h.length, 0);
        if (h.toString('latin1') !== st.head) return { type: 'headChanged' };
      }
      const CHUNK = 8 << 20;
      let pos = st.off, carry = null;
      while (pos < size) {
        // read straight in after the unfinished line the last chunk ended with: only that line is copied, not the chunk
        const want = Math.min(CHUNK, size - pos), keep = carry ? carry.length : 0;
        const buf = Buffer.allocUnsafe(keep + want);
        if (keep) carry.copy(buf, 0);
        const got = fs.readSync(fd, buf, keep, want, pos);
        if (!got) break;
        pos += got;
        const data = buf.subarray(0, keep + got);
        carry = null;
        const last = data.lastIndexOf(10);
        if (last === -1) { carry = data; continue; }
        this.store.ingestBuffer(data.subarray(0, last), st.ctx);
        if (last + 1 < data.length) carry = data.subarray(last + 1);
      }
      const end = pos - (carry ? carry.length : 0); // an unfinished last line is re-read next scan
      let head = st.head;
      if (!head && end > 0) {
        const h = Buffer.alloc(Math.min(HEAD, end));
        fs.readSync(fd, h, 0, h.length, 0);
        head = h.toString('latin1');
      }
      this.bytes += end - st.off;
      return { type: 'readOk', end, head };
    } catch (e) {
      // A failed read (antivirus, network drive, a file vanishing mid-read) must not stop the server. The offset
      // is kept, so the next scan reads the same bytes again; rows are upserts, so nothing is counted twice.
      this.readErrors++; this.lastError = `${path.basename(f)}: ${e.code || e.message}`;
      return { type: 'readFailed' };
    } finally { fs.closeSync(fd); }
  }
}
