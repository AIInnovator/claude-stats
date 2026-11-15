// End-to-end: start the real server as a different user whose Claude Code data lives in BOTH default
// folders (~/.claude and ~/.config/claude), with one reply present in both. The server must find both
// folders, count that reply once, merge both prompt-history files, and drop a transcript's rows when it is
// deleted while the server runs. Then the same with CLAUDE_CONFIG_DIR, and two logins in two config folders whose
// sessions get their account's key (never its ids), live too.
// Run: node scripts/pathcheck.mjs   (uses only scripts/.tmp-home/, deleted at the end; never your real data)
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { accountKey } from '../lib/accounts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), server = path.join(here, '..', 'server.mjs');
const base = path.join(here, '.tmp-home'), home = path.join(base, 'Zoë Ng'); // a username with a space and an accent
fs.rmSync(base, { recursive: true, force: true });

const reply = (id, n, sid = 'S1') => JSON.stringify({ type: 'assistant', uuid: 'u-' + id, sessionId: sid, timestamp: `2026-11-13T00:0${n}:00Z`, cwd: home, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } }) + '\n';
const prompt = (t, text, sid = 'S1') => JSON.stringify({ display: text, timestamp: t, project: home, sessionId: sid }) + '\n';
const put = (dir, file, text) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const dotClaude = path.join(home, '.claude'), dotConfig = path.join(home, '.config', 'claude');
put(path.join(dotClaude, 'projects', 'proj'), 's1.jsonl', reply('m1', 1) + reply('m1', 1) + reply('m2', 2)); // m1 written twice, as Claude Code does
put(path.join(dotConfig, 'projects', 'proj'), 's1.jsonl', reply('m2', 2) + reply('m3', 3));               // m2 also lives here
put(path.join(dotClaude, 'projects', 'proj'), 's1.jsonl.superseded-20261113', reply('m1', 1) + reply('m4', 4)); // a copy Claude Code set aside: m4 exists only here
put(dotClaude, 'history.jsonl', prompt(1, 'first'));
put(dotConfig, 'history.jsonl', prompt(1, 'first') + prompt(2, 'second'));                                // "first" in both
// the logged-in account, in ~/.claude.json (or dir/.claude.json); fields marked SECRET must never reach the page
const login = (email, org, type, tier, { dir = home, n = '', extra } = {}) => put(dir, '.claude.json', JSON.stringify({ numStartups: 3, userID: 'SECRET-user', oauthAccount: { accountUuid: 'SECRET-acct' + n, organizationUuid: 'SECRET-org' + n, emailAddress: email, organizationName: org, organizationType: type, userRateLimitTier: tier, hasExtraUsageEnabled: extra } }));
login('zoe@example.com', 'Zoë personal', 'claude_max', 'default_claude_max_20x', { extra: false });

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const get = (port, p) => new Promise((ok, bad) => {
  const req = http.get({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => ok(body));
  });
  req.on('error', bad);
});
/** Keeps /api/stream open, the way the page does. next(type) resolves with the data of the next event of that type. */
function stream(port) {
  const events = [], waiting = [];
  let buf = '';
  const flush = () => {
    for (let i = 0; i < waiting.length;) {
      const j = events.findIndex((e) => e.type === waiting[i].type);
      if (j < 0) { i++; continue; }
      waiting[i].ok(events.splice(j, 1)[0].data); waiting.splice(i, 1);
    }
  };
  const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      for (let k; (k = buf.indexOf('\n\n')) >= 0;) {
        const block = buf.slice(0, k).split('\n'); buf = buf.slice(k + 2);
        const type = block.find((l) => l.startsWith('event: '))?.slice(7), data = block.find((l) => l.startsWith('data: '))?.slice(6);
        if (type && data) events.push({ type, data: JSON.parse(data) }); // ': ping' comments carry neither
      }
      flush();
    });
  });
  req.on('error', () => {}); // close() destroys it on purpose
  return {
    next: (type, ms) => new Promise((ok, bad) => {
      const t = setTimeout(() => bad(new Error(`no "${type}" event within ${ms / 1000} s`)), ms);
      waiting.push({ type, ok: (d) => { clearTimeout(t); ok(d); } });
      flush();
    }),
    close: () => req.destroy(),
  };
}

// a failed assertion or Ctrl+C must not leave a server running in the background
const children = new Set();
process.on('exit', () => { for (const c of children) c.kill(); });
process.on('SIGINT', () => process.exit(130));

async function run(extraEnv, during) {
  const port = await freePort();
  const env = { ...process.env, USERPROFILE: home, HOME: home, PORT: String(port), ...extraEnv }; // USERPROFILE: Windows home, HOME: macOS/Linux
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECTS_DIR', 'XDG_CONFIG_HOME', 'REBUILD_GAP_MS']) if (!(k in extraEnv)) delete env[k];
  const child = spawn(process.execPath, [server], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let log = '', live = null;
  try {
    await new Promise((ok, bad) => {
      const t = setTimeout(() => bad(new Error('server did not start:\n' + log)), 15000);
      child.stdout.on('data', (c) => { log += c; if (log.includes('Claude stats →')) { clearTimeout(t); ok(); } });
      child.stderr.on('data', (c) => { log += c; });
      child.on('exit', (code) => bad(new Error(`server exited ${code}:\n${log}`)));
    });
    live = stream(port);
    const snap = await live.next('snapshot', 15000);
    const hist = JSON.parse(await get(port, '/api/history?q=&limit=10'));
    const after = during ? await during(live, port) : undefined;
    return { log, snap, calls: snap.tables.req.n, root: snap.meta.root, history: hist.total, account: snap.meta.account, leak: JSON.stringify(snap).includes('SECRET'), after };
  } finally { live?.close(); child.kill(); children.delete(child); }
}

try {
  // while it runs, a transcript is deleted (Claude Code's cleanup, `claude project purge`): its rows must go
  const both = await run({ REBUILD_GAP_MS: '0' }, async (live) => {
    // a /login to another account rewrites ~/.claude.json but no transcript: the open page must still get it
    const s0 = Date.now();
    login('zoe@work.example', 'Zoë Ng Work Ltd', 'claude_team', 'default_claude_max_5x', { n: '-team' });
    let d;
    do d = await live.next('delta', 10000); while (d.meta.account?.type !== 'claude_team');
    const switched = { account: d.meta.account, empty: !Object.keys(d.tables).length, ms: Date.now() - s0 };
    const t0 = Date.now();
    fs.unlinkSync(path.join(dotConfig, 'projects', 'proj', 's1.jsonl')); // m2 and m3; m2 is also in ~/.claude
    const snap = await live.next('snapshot', 40000); // the watcher names the file; the 30 s safety poll is the fallback
    return { calls: snap.tables.req.n, rebuilds: snap.meta.rebuilds, ms: Date.now() - t0, switched };
  });
  assert.ok(both.root.includes(path.join('.config', 'claude', 'projects')) && both.root.includes(path.join('.claude', 'projects')), 'both folders read: ' + both.root);
  assert.equal(both.calls, 4, 'm1..m4 counted once each across both folders and the set-aside copy');
  assert.equal(both.history, 2, 'prompt present in both history files shows once');
  console.log('  ok  user "Zoë Ng", data in ~/.claude AND ~/.config/claude plus a .superseded- copy: all read, 4 replies counted once, 2 prompts merged');
  assert.equal(both.after.calls, 3, 'm3 lived only in the deleted file; m2 is still in ~/.claude');
  assert.equal(both.after.rebuilds, 1);
  console.log(`  ok  a transcript deleted while the server runs: a fresh snapshot without its rows reached the page in ${both.after.ms} ms`);
  assert.deepEqual(both.account, { email: 'zoe@example.com', org: 'Zoë personal', type: 'claude_max', tier: 'default_claude_max_20x', key: accountKey('SECRET-acct', 'SECRET-org'), extra: false });
  assert.equal(both.leak, false, 'only email, org, plan type, tier, the hashed key and the extra-usage flag leave ~/.claude.json');
  assert.deepEqual(both.after.switched.account, { email: 'zoe@work.example', org: 'Zoë Ng Work Ltd', type: 'claude_team', tier: 'default_claude_max_5x', key: accountKey('SECRET-acct-team', 'SECRET-org-team') });
  assert.ok(both.after.switched.empty, 'the account update carries no rows');
  console.log(`  ok  account from ~/.claude.json (no ids or tokens sent); a login switch reached the open page in ${both.after.switched.ms} ms with no new log line`);

  const one = await run({ CLAUDE_CONFIG_DIR: dotClaude });
  assert.ok(!one.root.includes(path.join('.config', 'claude')), 'CLAUDE_CONFIG_DIR is authoritative');
  assert.equal(one.calls, 3, 'only ~/.claude: m1, m2, and m4 from its set-aside copy');
  assert.equal(one.account?.email, 'zoe@work.example', 'CLAUDE_CONFIG_DIR at a .claude folder: account file found beside it');
  console.log('  ok  CLAUDE_CONFIG_DIR set: only that folder is read (3 replies), account found beside it');

  // Two logins in two config folders: a Team login and a per-token one. 'api_console' is invented: no per-token
  // organizationType has been seen in real logs yet. Sessions S2 (Team, owner line first) and S3 (per-token, owner
  // line after its call); S5 is from before Claude Code recorded the account. Neither folder is a default one, so
  // the runs above don't read them.
  const teamDir = path.join(home, 'team-claude'), apiDir = path.join(home, 'api-claude');
  const kTeam = accountKey('SECRET-acct-team', 'SECRET-org-team'), kApi = accountKey('SECRET-acct-api', 'SECRET-org-api');
  const owner = (n, sid) => JSON.stringify({ type: 'session-owner', accountUuid: 'SECRET-acct' + n, organizationUuid: 'SECRET-org' + n, sessionId: sid }) + '\n';
  login('zoe@work.example', 'Zoë Ng Work Ltd', 'claude_team', 'default_claude_max_5x', { dir: teamDir, n: '-team', extra: true });
  login('zoe@dev.example', 'Zoë Ng Dev', 'api_console', undefined, { dir: apiDir, n: '-api' });
  put(path.join(teamDir, 'projects', 'p'), 's2.jsonl', owner('-team', 'S2') + reply('m5', 5, 'S2'));
  put(path.join(teamDir, 'projects', 'p'), 's5.jsonl', reply('m7', 7, 'S5'));
  put(path.join(apiDir, 'projects', 'p'), 's3.jsonl', reply('m6', 6, 'S3') + owner('-api', 'S3'));
  put(teamDir, 'history.jsonl', prompt(5, 'team prompt', 'S2') + prompt(6, 'api prompt', 'S3') + prompt(7, 'old prompt', 'S5'));
  const two = await run({ CLAUDE_CONFIG_DIR: `${teamDir},${apiDir}` }, async (live, port) => {
    const hist = async (a) => JSON.parse(await get(port, `/api/history?q=&limit=10&account=${a}`)).items.map((i) => i.sessionId);
    const byAccount = { team: await hist(kTeam), api: await hist(kApi), none: await hist('none') };
    // a session starting while the page is open: its key arrives in a delta, its ids don't
    fs.writeFileSync(path.join(apiDir, 'projects', 'p', 's4.jsonl'), owner('-api', 'S4') + reply('m8', 8, 'S4'));
    let d, s4;
    do { d = await live.next('delta', 40000); s4 = Object.values(d.sessions).find((m) => m.id === 'S4'); } while (!s4);
    return { byAccount, s4, leak: JSON.stringify(d).includes('SECRET') };
  });
  assert.equal(two.calls, 3);
  assert.deepEqual(two.account, { email: 'zoe@work.example', org: 'Zoë Ng Work Ltd', type: 'claude_team', tier: 'default_claude_max_5x', key: kTeam, extra: true }, "current login: the first folder's");
  assert.deepEqual(two.snap.meta.accounts, [{ key: kTeam, type: 'claude_team', tier: 'default_claude_max_5x', org: 'Zoë Ng Work Ltd' }, { key: kApi, type: 'api_console', tier: '', org: 'Zoë Ng Dev' }], 'every login, no email');
  const sess = Object.fromEntries(Object.values(two.snap.sessions).map((m) => [m.id, m]));
  assert.equal(sess.S2.acct, kTeam);
  assert.equal(sess.S3.acct, kApi, 'owner line after its call');
  assert.equal('acct' in sess.S5, false, 'no owner line: no key');
  assert.equal(two.leak, false, 'no account or organization id in the snapshot');
  console.log('  ok  two logins in two config folders: both plans sent, each session carries its account key, an old session none, no ids');
  assert.deepEqual(two.after.byAccount, { team: ['S2'], api: ['S3'], none: ['S5'] });
  console.log(`  ok  prompt history by account: each key returns only its sessions' prompts, "none" the unrecorded one`);
  assert.equal(two.after.s4.acct, kApi);
  assert.equal(two.after.leak, false, 'no account or organization id in a delta');
  console.log('  ok  a new session while streaming: its key arrives in a delta, no ids');

  fs.rmSync(path.join(dotConfig), { recursive: true });
  fs.rmSync(path.join(dotClaude, 'projects'), { recursive: true });
  fs.rmSync(path.join(home, '.claude.json'));
  const none = await run({});
  assert.equal(none.calls, 0);
  assert.equal(none.account, null, 'never logged in: no account');
  assert.deepEqual(none.snap.meta.accounts, [], 'never logged in: no plans to teach');
  assert.match(none.log, /No Claude Code transcripts found\. Looked in:/);
  console.log('  ok  no data at all: server still starts, says where it looked, shows 0 and no account');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
console.log('\npathcheck PASS');
