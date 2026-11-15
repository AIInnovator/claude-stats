// Data-layer self-check. Run: node scripts/selfcheck.mjs   (reads Claude Code's transcripts read-only)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Store, Tailer, isTranscript } from '../lib/store.mjs';
import { costOf, priceFor } from '../lib/pricing.mjs';
import { claudePaths, configCandidates } from '../lib/paths.mjs';

const ok = (msg) => console.log('  ok  ' + msg);

// 0. folder discovery works for any user on any OS (pure path logic with a fake home; nothing is read)
{
  const none = { dir: () => true, file: () => true };
  const lin = configCandidates({}, '/home/ana', path.posix);
  assert.deepEqual(lin, ['/home/ana/.config/claude', '/home/ana/.claude'], 'linux defaults');
  assert.deepEqual(configCandidates({ XDG_CONFIG_HOME: '/home/ana/xdg' }, '/home/ana', path.posix), ['/home/ana/xdg/claude', '/home/ana/.claude'], 'XDG_CONFIG_HOME');
  assert.deepEqual(configCandidates({}, '/Users/bo', path.posix), ['/Users/bo/.config/claude', '/Users/bo/.claude'], 'macOS defaults');
  assert.deepEqual(configCandidates({}, 'C:\\Users\\Zoë Ng', path.win32), ['C:\\Users\\Zoë Ng\\.config\\claude', 'C:\\Users\\Zoë Ng\\.claude'], 'windows defaults, name with space and accent');
  assert.deepEqual(configCandidates({ CLAUDE_CONFIG_DIR: '~/work-claude, /srv/claude' }, '/home/ana', path.posix), ['/home/ana/work-claude', '/srv/claude'], 'CLAUDE_CONFIG_DIR list and ~ expansion');
  const only = claudePaths({}, '/home/ana', { dir: (d) => d === '/home/ana/.claude/projects', file: () => false }, path.posix);
  assert.deepEqual(only.projects, ['/home/ana/.claude/projects'], 'only existing folders are read');
  assert.deepEqual(claudePaths({ CLAUDE_PROJECTS_DIR: '/tmp/p' }, '/home/ana', none, path.posix).projects, ['/tmp/p'], 'CLAUDE_PROJECTS_DIR override');
  const all = { dir: () => false, file: () => true };
  assert.deepEqual(claudePaths({}, 'C:\\Users\\Zoë Ng', all, path.win32).account, ['C:\\Users\\Zoë Ng\\.claude.json'], 'account file: home folder by default');
  assert.deepEqual(claudePaths({ CLAUDE_CONFIG_DIR: '/home/ana/.claude' }, '/home/ana', all, path.posix).account, ['/home/ana/.claude/.claude.json', '/home/ana/.claude.json'], 'account file: inside CLAUDE_CONFIG_DIR, then beside it');
  assert.deepEqual(claudePaths({ CLAUDE_CONFIG_DIR: '/srv/work-claude' }, '/home/ana', all, path.posix).account, ['/srv/work-claude/.claude.json'], 'account file: a custom folder never falls back to another login');
  ok('folder discovery: Linux, macOS, Windows, XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR list, any username, account file');
}

const roots = claudePaths().projects;
const files = roots.flatMap((root) => fs.readdirSync(root, { recursive: true }).filter(isTranscript).map(f => path.join(root, f)));
assert.ok(isTranscript('p/s.jsonl') && isTranscript('p/s.orphaned-1-a.jsonl') && isTranscript('p/s.jsonl.superseded-20261113') && !isTranscript('p/s.json') && !isTranscript('p/s.jsonl.superseded-1/x.txt'), 'transcript names');
assert.equal(costOf('claude-opus-5-5', { in: 1e6, out: 1e6, cr: 1e6, cw5: 1e6, cw1: 1e6 }), 4 + 20 + 0.2 + 5 + 8);
assert.equal(costOf('claude-unknown-9', { in: 1, out: 1, cr: 0, cw5: 0, cw1: 0 }), -1);
ok('costOf arithmetic + unpriced sentinel');

// 1-5 compare the store with your own logs; a machine without Claude Code (such as CI) has none, so they are skipped
if (!files.length) ok(`no Claude Code transcripts found${roots.length ? ' in ' + roots.join(', ') : ''}: real-log checks 1-5 skipped (set CLAUDE_CONFIG_DIR to run them)`);
else {
  // Freeze contents once (live sessions keep appending) and cut each at its last newline.
  const bufs = files.map(f => { const b = fs.readFileSync(f); return b.subarray(0, b.lastIndexOf(10) + 1); });
  ok(`reading ${roots.join(', ')}`);

  // 1. one pass
  let t0 = performance.now();
  const A = new Store();
  for (const b of bufs) A.ingestBuffer(b);
  const ms = performance.now() - t0;
  ok(`ingested ${files.length} files, ${(bufs.reduce((s, b) => s + b.length, 0) / 1e6).toFixed(0)} MB in ${ms.toFixed(0)} ms; ${A.req.n} calls, ${A.tool.n} tools, ${A.turn.n} turns, ${A.prompt.n} prompts, ${A.evt.n} events, ${A.sessions.size} sessions, ${A.badLines} bad lines`);

  // 2. independent oracle: naive full parse
  const ids = new Set(), toolIds = new Set(), turnIds = new Set(), lineIds = new Set();
  let perLine = 0;
  for (const b of bufs) for (const line of b.toString('utf8').split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'assistant' && j.message?.usage && j.message.id && j.message.model !== '<synthetic>') {
      const u = j.message.usage;
      // a line copied into another file (resumed or forked session: same uuid) is one line, as the store counts it
      if (!j.uuid || !lineIds.has(j.uuid)) perLine += u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
      if (j.uuid) lineIds.add(j.uuid);
      ids.add(j.message.id);
      for (const c of j.message.content || []) if (c.type === 'tool_use' || c.type === 'server_tool_use') toolIds.add(c.id);
    }
    if (j.type === 'system' && j.subtype === 'turn_duration') turnIds.add(j.uuid);
  }
  const mainRows = A.req.cols.adv.filter(x => !x).length;
  assert.equal(mainRows, ids.size, 'unique message ids'); ok(`unique API calls = ${ids.size} (matches naive parse)`);
  assert.equal(A.req.n - mainRows, A.req.cols.adv.reduce((s, x) => s + x, 0)); ok(`advisor calls as own rows: ${A.req.n - mainRows}`);
  for (const id of toolIds) assert.ok(A.tool.keys.has(id), 'tool ' + id); ok(`all ${toolIds.size} tool_use ids present`);
  assert.equal(A.turn.n, turnIds.size); ok(`turn_duration rows = ${turnIds.size}`);
  {
    const C = A.req.cols; let dedup = 0, raw = 0;
    for (let i = 0; i < A.req.n; i++) if (!C.adv[i]) { const t = C.in[i] + C.out[i] + C.cr[i] + C.cw5[i] + C.cw1[i]; dedup += t; raw += t * C.ln[i]; }
    // per-line usage can grow within one response (18 cases), so raw-from-max may exceed the naive sum by a hair
    assert.ok(Math.abs(raw - perLine) / perLine < 0.002, `per-line total ${raw} vs naive ${perLine}`);
    ok(`tokens: ${(dedup / 1e9).toFixed(2)}B counted once per response; ${(perLine / 1e9).toFixed(2)}B if every log line is counted (${(perLine / dedup).toFixed(2)}x, the every-line count)`);
  }

  // 3. split ingest (first halves in order, second halves reversed) must equal one pass
  const B = new Store();
  const cuts = bufs.map(b => { const mid = b.indexOf(10, b.length >> 1); return mid === -1 ? b.length : mid + 1; });
  bufs.forEach((b, i) => B.ingestBuffer(b.subarray(0, cuts[i])));
  for (let i = bufs.length - 1; i >= 0; i--) B.ingestBuffer(bufs[i].subarray(cuts[i]));
  for (const name of ['req', 'tool', 'turn', 'prompt', 'evt']) {
    const ta = A[name], tb = B[name];
    assert.equal(tb.n, ta.n, name + ' count');
    for (const [key, ia] of ta.keys) {
      const ib = tb.keys.get(key);
      for (const c of Object.keys(ta.cols)) {
        const va = ta.cols[c][ia], vb = tb.cols[c][ib];
        // dictionary ids differ between stores; compare the decoded strings
        const dict = { s: 'session', p: 'project', m: 'model', a: 'agent', sk: 'skill', pl: 'plugin', mc: 'mcp', ef: 'effort', stop: 'stop', v: 'version', b: 'branch', n: 'tool', perm: 'perm', deny: 'deny', src: 'src', k: 'kind' }[c];
        if (c === 'r') continue;
        if (dict) assert.equal(B.dicts[dict].list[vb], A.dicts[dict].list[va], `${name}.${c} ${key}`);
        else if (c === 'cost') assert.ok(Math.abs(va - vb) < 1e-9, `${name}.cost ${key}`);
        else assert.equal(vb, va, `${name}.${c} ${key}`);
      }
    }
  }
  for (const [sIdx, sa] of A.sessions) {
    const sb = B.sessions.get(B.dicts.session.map.get(sa.id));
    assert.ok(Math.abs((sa.cs?.cost || 0) - (sb.cs?.cost || 0)) < 1e-9, 'session cost-state ' + sa.id);
    assert.equal(sb.title, sa.title, 'title ' + sa.id);
    assert.equal(sb.acct, sa.acct, 'account key ' + sa.id);
  }
  ok(`split + reordered ingest == single pass (all tables, all columns, session counters, account keys on ${[...A.sessions.values()].filter((m) => m.acct).length} sessions)`);

  // 4. pinned historical session (probe values, 2026-11-12)
  const sIdx = A.dicts.session.list.findIndex(s => s.startsWith('fea856be'));
  if (sIdx > 0) {
    const C = A.req.cols, m = A.dicts.model.map.get('claude-opus-5-5'); const sum = [0, 0, 0, 0];
    for (let i = 0; i < A.req.n; i++) if (C.s[i] === sIdx && C.m[i] === m && !C.adv[i]) { sum[0] += C.in[i]; sum[1] += C.out[i]; sum[2] += C.cr[i]; sum[3] += C.cw5[i] + C.cw1[i]; }
    assert.deepEqual(sum, [138, 99757, 10744003, 367459]); ok('session fea856be opus-5-5 tokens = 138 / 99,757 / 10,744,003 / 367,459');
  }

  // 5. price table vs Claude Code's own per-model cost (cost-state carries its own token counts)
  let rows = 0, close = 0; const misses = new Map();
  for (const b of bufs) for (const line of b.toString('utf8').split('\n')) {
    if (!line.startsWith('{"type":"cost-state"')) continue;
    const j = JSON.parse(line);
    for (const [m, u] of Object.entries(j.modelUsage)) {
      const p = priceFor(m);
      if (!p || u.costUSD < 0.05) continue;
      const split = u.cacheCreationEphemeral1hInputTokens !== undefined;
      // base rates only: cost-state sums many calls, so per-call rules (Haiku's >100K tier) can't apply here
      const cw5 = split ? u.cacheCreationEphemeral5mInputTokens : u.cacheCreationInputTokens, cw1 = split ? u.cacheCreationEphemeral1hInputTokens : 0;
      const c = (u.inputTokens * p[0] + u.outputTokens * p[1] + u.cacheReadInputTokens * p[2] + cw5 * p[0] * 1.25 + cw1 * p[0] * 2) / 1e6 + (u.webSearchRequests || 0) * 0.01;
      const hit = Math.abs(c / u.costUSD - 1) < 0.01; close += hit; rows++;
      if (!hit) { const k = `${m} ${split ? 'split' : 'nosplit'} ratio~${(u.costUSD / c).toFixed(2)}`; misses.set(k, (misses.get(k) || 0) + 1); }
    }
  }
  if (process.env.VERBOSE) console.log(misses);
  assert.ok(close / rows > 0.9, `price table within 1% on ${close}/${rows}`); ok(`price table within 1% of Claude Code's own cost on ${close}/${rows} snapshots`);
}

// 6. tailer: a half-written line is not consumed until it is complete
const tmp = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp-selfcheck');
fs.mkdirSync(tmp, { recursive: true });
const f = path.join(tmp, 'x.jsonl');
const line = JSON.stringify({ type: 'system', subtype: 'turn_duration', uuid: 'u1', sessionId: 'S', timestamp: '2026-11-12T00:00:00Z', cwd: 'C:/x', durationMs: 5 });
fs.writeFileSync(f, line.slice(0, 40));
const T = new Store(), tail = new Tailer(T, tmp);
tail.scan(); assert.equal(T.turn.n, 0);
fs.appendFileSync(f, line.slice(40) + '\n'); tail.scan(); assert.equal(T.turn.n, 1);
fs.appendFileSync(f, line + '\n'); tail.scan(); assert.equal(T.turn.n, 1, 'same uuid twice = one row');
fs.writeFileSync(f, line + '\n'); tail.scan(); assert.equal(T.turn.n, 1, 'truncate + rewrite');
assert.equal(T.lines, 1, 'a re-read line is counted once');
const call = JSON.stringify({ type: 'assistant', uuid: 'a1', sessionId: 'S', timestamp: '2026-11-12T00:00:01Z', cwd: 'C:/x', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [null] } });
fs.appendFileSync(f, call + '\n'); tail.scan();
fs.writeFileSync(f, call + '\n'); tail.scan(); // shrink: re-read the same response line
assert.equal(T.req.cols.ln[T.req.keys.get('m1')], 1, 'lines-per-response survives a re-read');
assert.equal(T.req.n, 1, 'odd content ([null]) is skipped, not fatal');
fs.rmSync(f); fs.rmdirSync(tmp);
ok('tailer: partial line waits, duplicate is an upsert, truncation re-reads');
console.log('\nselfcheck PASS');
