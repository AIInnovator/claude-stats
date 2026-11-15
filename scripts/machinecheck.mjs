// Unit tests for every state machine (lib/machines.mjs, public/machines.js), plus one regression test per invalid
// transition the state-machine review found. The tailer tests use real files in scripts/.tmp-machinecheck/
// (deleted at the end); nothing here reads your Claude Code data.
// Run: node scripts/machinecheck.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { FILE_UNSEEN, fileStep, scanInit, scanStep, FIRST_DELAY_MS, MIN_GAP_MS, WATCH_UNARMED, watchStep } from '../lib/machines.mjs';
import {
  TOOL_NONE, TOOL_CALL, TOOL_RESULT, TOOL_COMPLETE, hasCall, toolStep, COUNTER_EMPTY, counterStep, intervalOf, attribution,
  CONN_START, connStep, RENDER_START, renderStep, DRAWER_CLOSED, drawerStep, HIST_IDLE, histStep, UI_DEFAULT, uiStep, selection,
  POP_CLOSED, popStep, billingClass, mergeAccounts, followAccount, verAtLeast, csvCell, viewFromQuery, viewToQuery,
} from '../public/machines.js';
import { Store, Tailer } from '../lib/store.mjs';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
/** Feed events in order; returns the final state and every step's effects. */
const run = (step, s, events) => { const fx = []; for (const e of events) { const r = step(s, e); s = r.state; fx.push(r.effects); } return { s, fx }; };

// ------------------------------------------------------------------------------------------------ FileState
ok('file: unseen + stat → tracked, reads only when there are bytes', () => {
  assert.deepEqual(fileStep(FILE_UNSEEN, { type: 'stat', size: 0, id: 'i' }).effects, []);
  const r = fileStep(FILE_UNSEEN, { type: 'stat', size: 9, id: 'i' });
  assert.equal(r.state.kind, 'tracked'); assert.equal(r.state.off, 0); assert.deepEqual(r.effects, ['read']);
});
ok('file: readOk moves the offset forward and keeps the first head', () => {
  let s = fileStep(FILE_UNSEEN, { type: 'stat', size: 9, id: 'i' }).state;
  s = fileStep(s, { type: 'readOk', end: 9, head: 'abc' }).state;
  assert.equal(s.off, 9); assert.equal(s.head, 'abc');
  s = fileStep(s, { type: 'readOk', end: 20, head: 'zzz' }).state;
  assert.equal(s.off, 20); assert.equal(s.head, 'abc');
  assert.deepEqual(fileStep(s, { type: 'stat', size: 20, id: 'i' }).effects, [], 'no new bytes: nothing to do');
  assert.deepEqual(fileStep(s, { type: 'stat', size: 30, id: 'i' }).effects, ['read']);
});
ok('file: invalid transitions are rejected and change nothing', () => {
  const t = fileStep(fileStep(FILE_UNSEEN, { type: 'stat', size: 9, id: 'i' }).state, { type: 'readOk', end: 9, head: 'h' }).state;
  for (const [s, e] of [[FILE_UNSEEN, { type: 'readOk', end: 5 }], [FILE_UNSEEN, { type: 'headChanged' }], [t, { type: 'readOk', end: 3 }], [{ kind: 'gone' }, { type: 'readFailed' }]]) {
    const r = fileStep(s, e);
    assert.deepEqual(r.effects, ['invalid'], `${s.kind} + ${e.type}`); assert.equal(r.state, s);
  }
});
ok('file: shrunk or replaced → restart, read again from 0', () => {
  const t = fileStep(fileStep(FILE_UNSEEN, { type: 'stat', size: 9, id: 'i' }).state, { type: 'readOk', end: 9, head: 'h' }).state;
  for (const e of [{ type: 'stat', size: 4, id: 'i' }, { type: 'stat', size: 30, id: 'other' }]) {
    const r = fileStep(t, e);
    assert.deepEqual(r.effects, ['restart', 'read']); assert.equal(r.state.off, 0); assert.equal(r.state.head, '');
  }
});
ok('REGRESSION deleted file → restart (its rows are dropped by a rebuild), recreated → read from 0', () => {
  const t = fileStep(fileStep(FILE_UNSEEN, { type: 'stat', size: 9, id: 'i' }).state, { type: 'readOk', end: 9, head: 'h' }).state;
  const gone = fileStep(t, { type: 'missing' });
  assert.equal(gone.state.kind, 'gone'); assert.deepEqual(gone.effects, ['restart']);
  assert.deepEqual(fileStep(gone.state, { type: 'missing' }).effects, []);
  const back = fileStep(gone.state, { type: 'stat', size: 5, id: 'j' });
  assert.equal(back.state.off, 0); assert.deepEqual(back.effects, ['read']);
});
ok('REGRESSION rewritten in place and grown → headChanged → restart from 0', () => {
  const t = fileStep(fileStep(FILE_UNSEEN, { type: 'stat', size: 9, id: 'i' }).state, { type: 'readOk', end: 9, head: 'h' }).state;
  const r = fileStep(t, { type: 'headChanged' });
  assert.deepEqual(r.effects, ['restart', 'read']); assert.equal(r.state.off, 0); assert.equal(r.state.head, '');
});
ok('REGRESSION read error → retry with the offset kept', () => {
  const t = fileStep(fileStep(FILE_UNSEEN, { type: 'stat', size: 9, id: 'i' }).state, { type: 'readOk', end: 9, head: 'h' }).state;
  const r = fileStep(t, { type: 'readFailed' });
  assert.deepEqual(r.effects, ['retry']); assert.equal(r.state, t);
});

// ------------------------------------------------------------------------------------------------ ScanState
ok('scan: a burst of watcher events becomes one scan of just the named files', () => {
  const { s, fx } = run(scanStep, scanInit(0, 10000), [
    { type: 'trigger', now: 1000, file: 'a' }, { type: 'trigger', now: 1010, file: 'b' }, { type: 'trigger', now: 1020, file: 'a' }, { type: 'fire', now: 1100 },
  ]);
  assert.deepEqual(fx[0], [{ kind: 'timer', ms: FIRST_DELAY_MS }]);
  assert.deepEqual(fx[1], []); assert.deepEqual(fx[2], []);
  assert.deepEqual(fx[3], [{ kind: 'scan', target: ['a', 'b'] }]);
  assert.equal(s.phase, 'running');
});
ok('scan: a trigger without a file name widens the scan to all files', () => {
  const { fx } = run(scanStep, scanInit(0, 10000), [{ type: 'trigger', now: 1000, file: 'a' }, { type: 'trigger', now: 1001 }, { type: 'fire', now: 1100 }]);
  assert.deepEqual(fx[2], [{ kind: 'scan', target: 'all' }]);
});
ok('scan: at most two updates a second', () => {
  const { fx } = run(scanStep, scanInit(0, 10000), [{ type: 'trigger', now: 1000 }, { type: 'fire', now: 1100 }, { type: 'scanned', now: 1100 }, { type: 'trigger', now: 1150 }]);
  assert.deepEqual(fx[2], ['delta']);
  assert.deepEqual(fx[3], [{ kind: 'timer', ms: MIN_GAP_MS - 50 }]);
});
ok('REGRESSION stale scheduler fire → invalid (never two runs for one schedule)', () => {
  const { s, fx } = run(scanStep, scanInit(0, 10000), [{ type: 'trigger', now: 1000 }, { type: 'fire', now: 1100 }, { type: 'fire', now: 1101 }, { type: 'scanned', now: 1102 }, { type: 'fire', now: 1103 }]);
  assert.deepEqual(fx[2], ['invalid'], 'fire while running');
  assert.deepEqual(fx[4], ['invalid'], 'fire while idle');
  assert.equal(s.phase, 'idle');
  assert.deepEqual(scanStep(scanInit(0, 1), { type: 'scanned', now: 1 }).effects, ['invalid'], 'scanned while idle');
});
ok('scan: a structural change rebuilds at most every gapMs and streams deltas meanwhile', () => {
  const { s, fx } = run(scanStep, scanInit(0, 10000), [
    { type: 'trigger', now: 1000 }, { type: 'fire', now: 1100 }, { type: 'scanned', now: 1200, structural: true },
    { type: 'trigger', now: 10100 }, { type: 'fire', now: 10200 }, { type: 'scanned', now: 10200 },
  ]);
  assert.deepEqual(fx[2], ['delta', { kind: 'wake', ms: 10000 - 1200 + 50 }]);
  assert.deepEqual(fx[5], ['rebuild'], 'the pending rebuild runs once the gap has passed');
  assert.equal(s.rebuildPending, false); assert.equal(s.lastRebuild, 10200);
  assert.deepEqual(run(scanStep, scanInit(0, 0), [{ type: 'trigger', now: 1 }, { type: 'fire', now: 2 }, { type: 'scanned', now: 2, structural: true }]).fx[2], ['rebuild'], 'gap 0: at once');
});
ok('scan: a failed run goes back to idle and logs', () => {
  const { s, fx } = run(scanStep, scanInit(0, 1), [{ type: 'trigger', now: 1 }, { type: 'fire', now: 2 }, { type: 'failed', now: 3 }]);
  assert.deepEqual(fx[2], ['log']); assert.equal(s.phase, 'idle');
});

// ------------------------------------------------------------------------------------------------ WatchState
ok('REGRESSION watcher on a vanished folder → close → re-armed when it is back', () => {
  const { s, fx } = run(watchStep, WATCH_UNARMED, [
    { type: 'check', exists: false }, { type: 'check', exists: true }, { type: 'armOk' },
    { type: 'check', exists: true }, { type: 'check', exists: false }, { type: 'check', exists: true }, { type: 'armOk' },
  ]);
  assert.deepEqual(fx, [[], ['arm'], [], [], ['close'], ['arm'], []]);
  assert.equal(s.kind, 'armed');
});
ok('watch: an error closes and re-arms; the warning is said once per folder', () => {
  const { s, fx } = run(watchStep, WATCH_UNARMED, [
    { type: 'check', exists: true }, { type: 'armOk' }, { type: 'error' }, { type: 'check', exists: true }, { type: 'armFailed' }, { type: 'check', exists: true }, { type: 'armFailed' },
  ]);
  assert.deepEqual(fx, [['arm'], [], ['close', 'warn'], ['arm'], [], ['arm'], []]);
  assert.equal(s.kind, 'failed');
  assert.deepEqual(watchStep({ kind: 'armed', warned: false }, { type: 'armOk' }).effects, ['invalid']);
  assert.deepEqual(watchStep(WATCH_UNARMED, { type: 'error' }).effects, ['invalid']);
});

// ------------------------------------------------------------------------------------------------ ToolState
ok('tool: call and result in either order end COMPLETE; hasCall only with a call', () => {
  const s1 = toolStep(toolStep(TOOL_NONE, 'call').state, 'result').state, s2 = toolStep(toolStep(TOOL_NONE, 'result').state, 'call').state;
  assert.equal(s1, TOOL_COMPLETE); assert.equal(s2, TOOL_COMPLETE);
  assert.equal(toolStep(TOOL_COMPLETE, 'call').state, TOOL_COMPLETE, 'a repeated line changes nothing');
  assert.deepEqual([TOOL_NONE, TOOL_CALL, TOOL_RESULT, TOOL_COMPLETE].map(hasCall), [false, true, false, true]);
  assert.deepEqual(toolStep(TOOL_CALL, 'other').effects, ['invalid']);
});

// ------------------------------------------------------------------------------------------------ CounterState
const snap = (at, cost, models = { A: cost }) => ({ type: 'snapshot', at, cost, models });
const counterOf = (...events) => run(counterStep, COUNTER_EMPTY, events).s;
ok('counter: snapshots are kept in time order, the same one twice is one, bad ones are rejected', () => {
  const c = counterOf(snap(20, 5), snap(10, 2), snap(20, 5));
  assert.deepEqual(c.snaps.map((x) => x.at), [10, 20]);
  assert.equal(counterStep(c, snap(10, 2)).state, c);
  assert.deepEqual(counterStep(c, snap(NaN, 1)).effects, ['invalid']);
  assert.deepEqual(counterStep(c, { type: 'other' }).effects, ['invalid']);
  assert.equal(attribution(COUNTER_EMPTY, []), null, 'no counter: no background estimate');
});
ok('counter: intervalOf finds the period that contains a time', () => {
  assert.deepEqual([5, 10, 11, 20, 21].map((t) => intervalOf([10, 20], t)), [0, 0, 1, 1, -1]);
  assert.equal(intervalOf([], 5), -1);
});
ok('REGRESSION background spend: a session resumed later and a later snapshot do not change earlier periods', () => {
  const calls = [{ t: 5, cost: 1, model: 'A' }, { t: 15, cost: 1, model: 'A' }];
  const before = attribution(counterOf(snap(10, 2), snap(20, 5)), calls);
  assert.deepEqual(before.factors, [2, 3], 'period 1: counter +3 over 1 logged, capped at 3');
  assert.deepEqual(before.fracs[0], [['A', 1]]);
  assert.equal(before.counterCost, 5); assert.equal(before.loggedCovered, 2);
  const resumed = attribution(counterOf(snap(10, 2), snap(20, 5)), [...calls, { t: 25, cost: 4, model: 'A' }]);
  assert.deepEqual(resumed.factors, before.factors, 'a call after the last snapshot gets nothing yet');
  assert.equal(resumed.loggedCovered, 2);
  const later = attribution(counterOf(snap(10, 2), snap(20, 5), snap(30, 6)), [...calls, { t: 25, cost: 1, model: 'A' }]);
  assert.deepEqual(later.factors.slice(0, 2), before.factors, 'earlier periods are closed');
  assert.deepEqual(later.factors[2], 1);
  const restarted = attribution(counterOf(snap(10, 2), snap(20, 5), snap(30, 0.5)), calls);
  assert.deepEqual(restarted.factors.slice(0, 2), before.factors, 'a process that restarted at 0 adds nothing');
  assert.equal(restarted.counterCost, 5);
});

// ------------------------------------------------------------------------------------------------ ConnState
ok('REGRESSION closed EventSource → close, back-off retry, open, live again', () => {
  const { s, fx } = run(connStep, CONN_START, [
    { type: 'snapshot' }, { type: 'error', closed: true }, { type: 'retry' }, { type: 'error', closed: true }, { type: 'retry' }, { type: 'snapshot' },
  ]);
  assert.deepEqual(fx, [['applySnapshot'], ['close', { kind: 'retry', ms: 2000 }], ['open'], ['close', { kind: 'retry', ms: 4000 }], ['open'], ['applySnapshot']]);
  assert.equal(s.kind, 'live');
  let w = CONN_START;
  for (let i = 0; i < 8; i++) w = connStep(w, { type: 'error', closed: true }).state;
  assert.deepEqual(connStep(w, { type: 'error', closed: true }).effects[1], { kind: 'retry', ms: 30000 }, 'back-off caps at 30 s');
});
ok('conn: a stream the browser retries itself only shows "reconnecting"; stray events are invalid', () => {
  const r = connStep({ kind: 'live' }, { type: 'error', closed: false });
  assert.equal(r.state.kind, 'reconnecting'); assert.deepEqual(r.effects, []);
  assert.deepEqual(connStep(CONN_START, { type: 'delta' }).effects, ['invalid'], 'a delta needs its snapshot');
  assert.deepEqual(connStep({ kind: 'live' }, { type: 'retry' }).effects, ['invalid'], 'a stale retry timer');
  assert.deepEqual(connStep({ kind: 'live' }, { type: 'delta' }).effects, ['applyDelta']);
});

// ------------------------------------------------------------------------------------------------ RenderState
ok('REGRESSION a panel error still reaches ready ("drawn" always comes; the page leaves loading once)', () => {
  const { s, fx } = run(renderStep, RENDER_START, [{ type: 'request' }, { type: 'request' }, { type: 'frame' }, { type: 'drawn' }, { type: 'request' }, { type: 'frame' }, { type: 'drawn' }]);
  assert.deepEqual(fx, [['requestFrame'], [], ['draw'], ['firstReady'], ['requestFrame'], ['draw'], []]);
  assert.equal(s.phase, 'ready');
  assert.deepEqual(renderStep(RENDER_START, { type: 'frame' }).effects, ['invalid'], 'a frame nobody asked for');
});

// ------------------------------------------------------------------------------------------------ DrawerState
ok('REGRESSION stale drawer frame or hide timer after a close/reopen → invalid', () => {
  const { s, fx } = run(drawerStep, DRAWER_CLOSED, [
    { type: 'open', sid: 'A' }, { type: 'close' }, { type: 'frame', token: 1 }, { type: 'open', sid: 'B' }, { type: 'hidden', token: 2 }, { type: 'frame', token: 3 },
  ]);
  assert.deepEqual(fx[0], ['show', { kind: 'frame', token: 1 }]);
  assert.deepEqual(fx[1], ['slideOut', 'restoreFocus', { kind: 'hideAfter', ms: 330, token: 2 }]);
  assert.deepEqual(fx[2], ['invalid'], 'the first open\'s frame must not slide a closed drawer in');
  assert.deepEqual(fx[4], ['invalid'], 'the close\'s timer must not hide the reopened drawer');
  assert.deepEqual(fx[5], ['slideIn']);
  assert.deepEqual(s, { kind: 'open', sid: 'B', token: 3 });
});
ok('drawer: closes when its session leaves the data; close twice is harmless', () => {
  const open = { kind: 'open', sid: 'A', token: 1 };
  assert.equal(drawerStep(open, { type: 'dataChanged', exists: true }).state, open);
  assert.equal(drawerStep(open, { type: 'dataChanged', exists: false }).state.kind, 'closing');
  const closing = drawerStep(open, { type: 'close' }).state;
  assert.deepEqual(drawerStep(closing, { type: 'close' }).effects, []);
  assert.deepEqual(drawerStep(closing, { type: 'hidden', token: closing.token }).effects, ['hide']);
});

// ------------------------------------------------------------------------------------------------ HistState
ok('REGRESSION stale history debounce or fetch → invalid; a failed fetch shows an error and retries', () => {
  const { s, fx } = run(histStep, HIST_IDLE, [
    { type: 'change' }, { type: 'change' }, { type: 'debounced', seq: 1 }, { type: 'debounced', seq: 2 }, { type: 'loaded', seq: 1 },
    { type: 'failed', seq: 2 }, { type: 'retry', seq: 2 }, { type: 'loaded', seq: 2 }, { type: 'retry', seq: 2 },
  ]);
  assert.deepEqual(fx[2], ['invalid'], 'an older query\'s debounce');
  assert.deepEqual(fx[3], [{ kind: 'fetch', seq: 2 }]);
  assert.deepEqual(fx[4], ['invalid'], 'an older query\'s answer');
  assert.deepEqual(fx[5], ['showError', { kind: 'retry', ms: 3000, seq: 2 }]);
  assert.deepEqual(fx[6], [{ kind: 'fetch', seq: 2 }]);
  assert.deepEqual(fx[7], ['render']);
  assert.deepEqual(fx[8], ['invalid'], 'a retry timer after success');
  assert.equal(s.kind, 'shown');
  const failedThenTyped = run(histStep, HIST_IDLE, [{ type: 'change' }, { type: 'debounced', seq: 1 }, { type: 'failed', seq: 1 }, { type: 'change' }, { type: 'retry', seq: 1 }]);
  assert.deepEqual(failedThenTyped.fx[4], ['invalid'], 'the old retry must not fetch the old query');
});

// ------------------------------------------------------------------------------------------------ settings + filters
ok('REGRESSION unknown saved settings → defaults', () => {
  const u = uiStep({ range: 'fortnight', metric: 7, theme: 'neon', dir: '1', subagents: 'yes', projects: 'p', models: ['a', 'a', '', 3], sessLimit: 2.5, from: 'yesterday', to: 'later', sessQ: null, heatRange: 'x', histRange: 'y', hideAccount: 'yes' }, {});
  for (const k of ['range', 'metric', 'theme', 'dir', 'subagents', 'heatRange', 'histRange', 'sessLimit', 'from', 'to', 'sessQ', 'projects', 'hideAccount']) assert.deepEqual(u[k], UI_DEFAULT[k], k);
  assert.equal(uiStep({}, { hideAccount: true }).hideAccount, true, 'hiding the account is kept');
  assert.deepEqual(u.models, ['a'], 'deduped, non-strings and empty names dropped');
  assert.equal(uiStep({}, { range: 'custom', from: '' }).range, UI_DEFAULT.range, 'a custom range needs a start');
  assert.equal(uiStep({}, { range: 'custom', from: '2026-11-01T08:00', to: 'now' }).to, 'now');
  assert.equal(uiStep({}, { sessLimit: 1e9 }).sessLimit, 10000);
  assert.deepEqual(uiStep(null, {}), { ...UI_DEFAULT }, 'nothing saved');
  const acc =uiStep({ accounts: ['k1', 'k1', '', 3, 'none'], apiProjects: 'C:/p' }, {});
  assert.deepEqual(acc.accounts, ['k1', 'none'], 'accounts deduped, junk dropped, the none sentinel kept');
  assert.deepEqual(acc.apiProjects, [], 'apiProjects must be a list');
});
ok('billing class: subscription, per-token or unknown, never guessed as per-token', () => {
  assert.equal(billingClass({ type: 'claude_team' }, true, false), 'sub');
  assert.equal(billingClass({ type: 'claude_max' }, true, true), 'sub', 'an owner line beats a project marked API key');
  assert.equal(billingClass({ type: 'api_console' }, true, false), 'api', 'an unseen non-claude_ type is per-token');
  assert.equal(billingClass({ type: '' }, true, false), 'unknown', 'a login file without a plan type');
  assert.equal(billingClass(undefined, true, true), 'unknown', 'key seen, plan not learned yet: unknown even in an API-key project');
  assert.equal(billingClass(undefined, false, true), 'api', 'no account recorded, project marked API key');
  assert.equal(billingClass(undefined, false, false), 'unknown', 'no account recorded, not marked');
});
ok('account memory: changes only when the plan, tier, org or day change; never stores an email', () => {
  const a = mergeAccounts({}, [{ key: 'k1', type: 'claude_team', tier: 't5', org: 'Org', email: 'x@example.com' }], '2026-11-15');
  assert.equal(a.changed, true);
  assert.deepEqual(a.memory, { k1: { type: 'claude_team', tier: 't5', org: 'Org', seen: '2026-11-15' } });
  const b = mergeAccounts(a.memory, [{ key: 'k1', type: 'claude_team', tier: 't5', org: 'Org' }], '2026-11-15');
  assert.equal(b.changed, false); assert.equal(b.memory, a.memory, 'unchanged memory is the same object (nothing to save)');
  const c = mergeAccounts(a.memory, [{ key: 'k1', type: '', tier: '', org: '' }], '2026-11-16');
  assert.deepEqual(c.memory.k1, { type: 'claude_team', tier: 't5', org: 'Org', seen: '2026-11-16' }, 'an empty field never erases what was learned');
  assert.equal(mergeAccounts(a.memory, [null, { key: '' }, { type: 'x' }], '2026-11-15').changed, false, 'junk entries are ignored');
});
ok('5-hour windows follow one account: the picked one, else the current login, else the most used', () => {
  const use = new Map([['k1', 5], ['k2', 9], ['none', 50]]);
  assert.equal(followAccount(['k1'], 'k2', use), 'k1');
  assert.equal(followAccount(['k1', 'none'], 'k2', use), 'k1', 'none is not an account');
  assert.equal(followAccount(['k1', 'k2'], 'k1', use), 'k1', 'two picked: the current login');
  assert.equal(followAccount(['none'], 'k1', use), 'k1');
  assert.equal(followAccount([], undefined, use), 'k2', 'logged out: the most used account, never none');
  assert.equal(followAccount([], undefined, new Map()), undefined);
  assert.equal(verAtLeast('2.1.317', '2.1.317'), true); assert.equal(verAtLeast('2.1.316', '2.1.317'), false);
  assert.equal(verAtLeast('2.10.0', '2.1.317'), true); assert.equal(verAtLeast('', '2.1.317'), false); assert.equal(verAtLeast('abc', '2.1.317'), false);
});
ok('CSV cells: text that could run as a spreadsheet formula is defused; quotes, commas and line breaks are quoted', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  for (const t of ['+1', '-cmd', '@SUM(A1)']) assert.equal(csvCell(t), "'" + t);
  assert.equal(csvCell(-5), '-5', 'a number stays a number');
  assert.equal(csvCell('a,b'), '"a,b"'); assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell(null), ''); assert.equal(csvCell('plain'), 'plain');
});
ok('links to a view: the address round-trips range and filters; presenting keeps paths out of it', () => {
  const view = { ...UI_DEFAULT, range: 'custom', from: '2026-11-01T08:00', to: 'now', projects: ['C:/p one'], models: ['m1'], accounts: ['k1', 'none'], subagents: false };
  const q = viewToQuery(view);
  assert.deepEqual(uiStep(UI_DEFAULT, viewFromQuery('?' + q)), uiStep(UI_DEFAULT, { range: 'custom', from: '2026-11-01T08:00', to: 'now', projects: ['C:/p one'], models: ['m1'], accounts: ['k1', 'none'], subagents: false }));
  const hidden = viewToQuery({ ...view, hideAccount: true });
  assert.ok(!hidden.includes('p+one') && !hidden.includes('p%20one') && hidden.includes('ph=1'), 'no project path while presenting');
  assert.equal('projects' in viewFromQuery('?' + hidden), false, 'ph=1 keeps the saved project filter');
  assert.deepEqual(viewFromQuery(''), {}, 'no view in the address: the saved settings decide');
  assert.deepEqual(viewFromQuery('?range=7d').projects, [], 'an address naming a view means no filters it does not list');
});
ok('REGRESSION a filter on a name with no data matches nothing and is listed', () => {
  assert.equal(selection([], ['', 'a']), null, 'no filter');
  const only = selection(['gone'], ['', 'a', 'b']);
  assert.equal(only.idx.size, 0); assert.deepEqual(only.unavailable, ['gone']);
  const mixed = selection(['b', 'gone'], ['', 'a', 'b']);
  assert.deepEqual([...mixed.idx], [2]); assert.deepEqual(mixed.unavailable, ['gone']);
});

// ------------------------------------------------------------------------------------------------ PopState
ok('pop: at most one open; toggling another closes the first; refresh never under focus', () => {
  const { s, fx } = run(popStep, POP_CLOSED, [{ type: 'toggle', id: 'filter' }, { type: 'toggle', id: 'custom' }, { type: 'dataChanged', focusInside: true }, { type: 'dataChanged', focusInside: false }, { type: 'close', id: 'filter' }, { type: 'close', refocus: true }]);
  assert.deepEqual(fx, [
    [{ kind: 'open', id: 'filter' }], [{ kind: 'close', id: 'filter', refocus: false }, { kind: 'open', id: 'custom' }], [], [{ kind: 'refresh', id: 'custom' }],
    [], [{ kind: 'close', id: 'custom', refocus: true }],
  ]);
  assert.equal(s, POP_CLOSED);
  assert.deepEqual(popStep(POP_CLOSED, { type: 'other' }).effects, ['invalid']);
});

// ------------------------------------------------------------------------------------------------ the store and tailer
const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp-machinecheck');
const reply = (id, min, content = []) => JSON.stringify({ parentUuid: null, type: 'assistant', uuid: 'u-' + id, sessionId: 'S1', timestamp: `2026-11-13T00:${String(min).padStart(2, '0')}:00Z`, cwd: 'C:/proj', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 20 }, content } }) + '\n';
const result = (toolId, min) => JSON.stringify({ parentUuid: null, type: 'user', uuid: 'r-' + toolId, sessionId: 'S1', timestamp: `2026-11-13T00:${String(min).padStart(2, '0')}:00Z`, cwd: 'C:/proj', message: { content: [{ type: 'tool_result', tool_use_id: toolId, is_error: false }] } }) + '\n';

ok('REGRESSION a line glued onto a crashed writer\'s fragment is recovered', () => {
  const st = new Store();
  st.ingestBuffer(Buffer.from('{"parentUuid":"x","isSide' + reply('g1', 1) + 'not json at all\n'));
  assert.equal(st.req.n, 1); assert.equal(st.recovered, 1); assert.equal(st.badLines, 1);
});
ok('REGRESSION a tool result with no call → RESULT, r = -1, no model; its call arriving later completes it', () => {
  const st = new Store();
  st.ingestBuffer(Buffer.from(result('tu1', 2)));
  const T = st.tool.cols;
  assert.equal(st.tool.n, 1); assert.equal(T.ts[0], TOOL_RESULT); assert.equal(T.r[0], -1); assert.equal(hasCall(T.ts[0]), false);
  st.ingestBuffer(Buffer.from(reply('m1', 1, [{ type: 'tool_use', id: 'tu1', name: 'Bash' }])));
  assert.equal(st.tool.n, 1); assert.equal(T.ts[0], TOOL_COMPLETE); assert.equal(T.r[0], 0); assert.equal(st.dicts.tool.list[T.n[0]], 'Bash');
  const fwd = new Store();
  fwd.ingestBuffer(Buffer.from(reply('m1', 1, [{ type: 'tool_use', id: 'tu1', name: 'Bash' }]) + result('tu1', 2)));
  for (const c of ['t', 's', 'p', 'n', 'r', 'err', 'ts']) assert.equal(fwd.tool.cols[c][0], T[c][0], `column ${c} is the same in either order`);
});

ok('REGRESSION lines a background session copied from its parent stay in the parent, whatever the read order', () => {
  const at = (s) => `2026-11-13T01:00:${s}Z`;
  // one parent line of each kind; the copy has the same uuids and times under its own sessionId, session_id = parent
  const parent = (sid, extra) => [
    { uuid: 'a1', type: 'assistant', timestamp: at('00'), message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: 'tool_use', id: 'tu1', name: 'Bash' }] } },
    { uuid: 'r1', type: 'user', timestamp: at('01'), message: { content: [{ type: 'tool_result', tool_use_id: 'tu1' }] } },
    { uuid: 'r9', type: 'user', timestamp: at('02'), message: { content: [{ type: 'tool_result', tool_use_id: 'tu9' }] } }, // its call is in neither file
    { uuid: 'p1', type: 'user', timestamp: at('03'), turnOrigin: 'human', message: { content: 'hi' } },
    { uuid: 'd1', type: 'system', subtype: 'turn_duration', timestamp: at('04'), durationMs: 5 },
    { uuid: 'c1', type: 'system', subtype: 'compact_boundary', timestamp: at('05'), compactMetadata: { trigger: 'auto' } },
  ].map((l) => ({ ...l, sessionId: sid, cwd: 'C:/proj', ...extra }));
  const P = parent('P-parent', { session_id: 'P-parent' }), B = parent('B-bg', { session_id: 'P-parent', sessionKind: 'bg' });
  // the background session's own new reply: session_id also names the parent, but nothing competes for its row
  B.push({ uuid: 'a2', type: 'assistant', timestamp: at('09'), sessionId: 'B-bg', session_id: 'P-parent', cwd: 'C:/proj', message: { id: 'm2', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 2 }, content: [] } });
  // older Claude Code: no session_id anywhere, so the lowest session id wins a tie
  const old = (sid) => ({ uuid: 'o1', type: 'system', subtype: 'turn_duration', timestamp: at('07'), sessionId: sid, cwd: 'C:/proj', durationMs: 1 });
  const load = (...groups) => { const st = new Store(); for (const g of groups) st.ingestBuffer(Buffer.from(g.map((l) => JSON.stringify(l)).join('\n') + '\n')); return st; };
  const sessionOf = (st, table, key) => st.dicts.session.list[st[table].cols.s[st[table].keys.get(key)]];
  for (const st of [load(P, B, [old('Y')], [old('X')]), load(B, P, [old('X')], [old('Y')])]) {
    for (const [table, key] of [['req', 'm1'], ['tool', 'tu1'], ['tool', 'tu9'], ['prompt', 'p1'], ['turn', 'd1'], ['evt', 'c1']]) assert.equal(sessionOf(st, table, key), 'P-parent', `${table} ${key}`);
    assert.equal(sessionOf(st, 'req', 'm2'), 'B-bg', 'a line of its own stays in its own session');
    assert.equal(sessionOf(st, 'turn', 'o1'), 'X');
    assert.equal(st.req.cols.ln[st.req.keys.get('m1')], 1, 'the copied line is one line');
  }
});
ok('REGRESSION a subagent transcript\'s copy of the Agent call that launched it stays with the main thread, whatever the read order', () => {
  // the subagent's transcript starts with the main thread's Agent call: same message id, tool_use id, time and
  // sessionId, but isSidechain and no session_id (found on real logs, 14 Nov 2026; the old rank failed this)
  const msg = { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: 'tool_use', id: 'tu1', name: 'Agent' }] };
  const line = { type: 'assistant', timestamp: '2026-11-14T12:48:36.216Z', sessionId: 'S', cwd: 'C:/proj', message: msg };
  const main = { ...line, uuid: 'u-main', session_id: 'S', isSidechain: false }, fork = { ...line, uuid: 'u-fork', isSidechain: true, agentId: 'a1' };
  for (const order of [[main, fork], [fork, main]]) {
    const st = new Store();
    for (const l of order) st.ingestBuffer(Buffer.from(JSON.stringify(l) + '\n'));
    const agent = (table, key) => st.dicts.agent.list[st[table].cols.a[st[table].keys.get(key)]];
    assert.equal(agent('tool', 'tu1'), 'main', 'tool call'); assert.equal(agent('req', 'm1'), 'main', 'API call');
  }
});

fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(path.join(base, 'proj'), { recursive: true });
const realReadSync = fs.readSync;
try {
  const f = path.join(base, 'proj', 'a.jsonl'), store = new Store(), tail = new Tailer(store, base);
  fs.writeFileSync(f, reply('m1', 1) + reply('m2', 2));
  ok('tailer: reads complete lines and keeps an unfinished last line for later', () => {
    fs.appendFileSync(f, reply('m3', 3).slice(0, 40));
    tail.scan();
    assert.equal(store.req.n, 2); assert.equal(tail.files.get(f).off, Buffer.byteLength(reply('m1', 1) + reply('m2', 2)));
    fs.appendFileSync(f, reply('m3', 3).slice(40));
    tail.scan([f]);
    assert.equal(store.req.n, 3); assert.equal(tail.files.get(f).off, fs.statSync(f).size); assert.equal(tail.structural, false);
  });
  ok('REGRESSION read error on a real file → counted, offset kept, the same bytes read next scan', () => {
    const off = tail.files.get(f).off;
    fs.appendFileSync(f, reply('m4', 4));
    fs.readSync = () => { const e = new Error('i/o error'); e.code = 'EIO'; throw e; };
    tail.scan([f]);
    fs.readSync = realReadSync;
    assert.equal(tail.readErrors, 1); assert.match(tail.lastError, /EIO/); assert.equal(tail.files.get(f).off, off); assert.equal(store.req.n, 3);
    tail.scan([f]);
    assert.equal(store.req.n, 4); assert.equal(tail.files.get(f).off, fs.statSync(f).size); assert.equal(tail.structural, false);
  });
  ok('REGRESSION a real file rewritten in place (same file id) and grown → restart, new rows read', () => {
    const idOf = () => { const s = fs.statSync(f); return `${s.ino}:${s.birthtimeMs}`; }, id = idOf();
    const fd = fs.openSync(f, 'r+');
    fs.writeSync(fd, reply('m9', 9) + reply('m1', 1) + reply('m2', 2) + reply('m3', 3) + reply('m4', 4) + reply('m5', 5), 0);
    fs.closeSync(fd);
    assert.equal(idOf(), id, 'same file: only the head check can see the rewrite');
    tail.scan([f]);
    assert.equal(tail.structural, true); assert.equal(store.req.n, 6); assert.equal(tail.files.get(f).off, fs.statSync(f).size);
    tail.structural = false;
  });
  ok('tailer: a file over the 8 MB read chunk, with a line across the boundary and a line longer than a chunk', () => {
    const big = path.join(base, 'proj', 'big.jsonl');
    const pad = (n) => [{ type: 'text', text: 'x'.repeat(n) }];
    const lines = [];
    for (let k = 0; k < 9; k++) lines.push(reply('b' + k, k, pad(1 << 20))); // ~9 MB: one line crosses 8 MB
    lines.push(reply('huge', 20, pad(9 << 20)));                              // one line longer than a whole chunk
    lines.push(reply('tail', 21));
    fs.writeFileSync(big, lines.join(''));
    const viaTailer = new Store(), t2 = new Tailer(viaTailer, path.join(base, 'proj'));
    t2.scan([big]);
    const whole = new Store();
    whole.ingestBuffer(fs.readFileSync(big));
    assert.equal(t2.files.get(big).off, fs.statSync(big).size, 'every byte consumed');
    assert.equal(viaTailer.req.n, 11);
    for (const id of ['b0', 'b8', 'huge', 'tail']) assert.ok(viaTailer.req.keys.has(id), id);
    for (const [key, i] of whole.req.keys) for (const c of Object.keys(whole.req.cols)) assert.equal(viaTailer.req.cols[c][viaTailer.req.keys.get(key)], whole.req.cols[c][i], `${key}.${c}`);
    fs.unlinkSync(big);
  });
  ok('REGRESSION a real file deleted → restart, no longer tracked', () => {
    fs.unlinkSync(f);
    tail.scan();
    assert.equal(tail.structural, true); assert.equal(tail.files.has(f), false);
  });
} finally {
  fs.readSync = realReadSync;
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(`\nmachinecheck PASS (${passed} tests)`);
