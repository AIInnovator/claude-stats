// Accounts: the hashed key per session (session-owner lines) and the logins read from .claude.json.
// Uses only made-up ids and files in scripts/.tmp-accountcheck/ (deleted at the end); never your real data.
// Run: node scripts/accountcheck.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { accountKey, readLogin } from '../lib/accounts.mjs';
import { Store } from '../lib/store.mjs';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

// raw ids with non-hex characters, so a leak check can't match inside a key by chance
const A1 = 'ACCT-one', O1 = 'ORG-one', A2 = 'ACCT-two', O2 = 'ORG-two';
const owner = (acct, org, sid = 'S') => JSON.stringify({ type: 'session-owner', accountUuid: acct, organizationUuid: org, sessionId: sid });
const reply = (id, sid = 'S') => JSON.stringify({ type: 'assistant', uuid: 'u-' + id, sessionId: sid, timestamp: '2026-11-15T00:00:00Z', cwd: 'C:/p', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } });
/** A store fed these lines through ingestBuffer, the way the tailer feeds it (so the fast-path filter is covered). */
const feed = (store, lines) => { store.ingestBuffer(Buffer.from(lines.join('\n') + '\n')); return store; };
const metaOf = (store, sid = 'S') => store.sessions.get(store.dicts.session.map.get(sid));

// ------------------------------------------------------------------------------------------------ accountKey
ok('accountKey: 12 lowercase hex, stable, sha256 of "account:org", differs per organization', () => {
  const k = accountKey(A1, O1);
  assert.match(k, /^[0-9a-f]{12}$/);
  assert.equal(accountKey(A1, O1), k);
  assert.equal(k, createHash('sha256').update(`${A1}:${O1}`).digest('hex').slice(0, 12));
  assert.notEqual(accountKey(A1, O2), k, 'one login in two organizations is two accounts');
});

// ------------------------------------------------------------------------------------------------ session acct
ok('session-owner: the session gets the key, whether the owner line comes before or after its calls', () => {
  assert.equal(metaOf(feed(new Store(), [owner(A1, O1), reply('m1')])).acct, accountKey(A1, O1));
  assert.equal(metaOf(feed(new Store(), [reply('m1'), owner(A1, O1)])).acct, accountKey(A1, O1));
});
ok('session-owner arriving after a delta was sent (live tail): the next delta carries the key', () => {
  const s = feed(new Store(), [reply('m1')]);
  assert.equal(Object.values(s.takeDelta().sessions)[0].acct, undefined, 'no owner line yet: no acct');
  feed(s, [owner(A1, O1)]);
  assert.equal(Object.values(s.takeDelta().sessions)[0].acct, accountKey(A1, O1));
});
ok('two accounts in one session: the lower key, in either read order', () => {
  const low = [accountKey(A1, O1), accountKey(A2, O2)].sort()[0];
  assert.equal(metaOf(feed(new Store(), [owner(A1, O1), owner(A2, O2), reply('m1')])).acct, low);
  assert.equal(metaOf(feed(new Store(), [owner(A2, O2), reply('m1'), owner(A1, O1)])).acct, low);
});
ok('110 repeats of the same owner line mark the session dirty once', () => {
  const s = feed(new Store(), [reply('m1'), owner(A1, O1)]);
  assert.ok(s.takeDelta(), 'first delta carries the session');
  feed(s, Array(109).fill(owner(A1, O1)));
  assert.equal(s.takeDelta(), null, 'repeats change nothing, so no delta');
});
ok('an owner line without usable ids is ignored, never hashed as "undefined"', () => {
  const s = feed(new Store(), [reply('m1'), JSON.stringify({ type: 'session-owner', sessionId: 'S' }), JSON.stringify({ type: 'session-owner', accountUuid: 7, organizationUuid: O1, sessionId: 'S' })]);
  assert.equal('acct' in metaOf(s), false);
  assert.equal(s.badLines, 0);
});
ok('a session without an owner line has no acct property', () => {
  assert.equal('acct' in metaOf(feed(new Store(), [reply('m1')])), false);
});
ok('raw account and organization ids never leave the store (snapshot or delta)', () => {
  const s = feed(new Store(), [owner(A1, O1), reply('m1'), owner(A2, O2, 'T'), reply('m2', 'T')]);
  const delta = JSON.stringify(s.takeDelta()), snap = JSON.stringify(s.snapshot({}));
  assert.ok(delta.includes(accountKey(A1, O1)) && snap.includes(accountKey(A2, O2)), 'the keys are sent');
  for (const raw of [A1, O1, A2, O2]) assert.ok(!delta.includes(raw) && !snap.includes(raw), raw);
});

// ------------------------------------------------------------------------------------------------ readLogin
const tmp = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp-accountcheck');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const file = (name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text); return f; };
const config = (oauth) => JSON.stringify({ numStartups: 3, userID: 'SECRET-user', oauthAccount: { accountUuid: A1, organizationUuid: O1, emailAddress: 'zoe@example.com', organizationName: 'Zoë Ltd', organizationType: 'claude_team', userRateLimitTier: 'default_claude_max_5x', ...oauth } });
try {
  ok('readLogin: key from the login ids, plan, organization and email; no ids', () => {
    const l = readLogin(file('a.json', config({})));
    assert.deepEqual(l, { email: 'zoe@example.com', org: 'Zoë Ltd', type: 'claude_team', tier: 'default_claude_max_5x', key: accountKey(A1, O1) });
    for (const raw of [A1, O1, 'SECRET']) assert.ok(!JSON.stringify(l).includes(raw), raw);
  });
  ok('readLogin: extra from hasExtraUsageEnabled only when it is a boolean', () => {
    assert.equal(readLogin(file('t.json', config({ hasExtraUsageEnabled: true }))).extra, true);
    assert.equal(readLogin(file('f.json', config({ hasExtraUsageEnabled: false }))).extra, false);
    assert.equal('extra' in readLogin(file('s.json', config({ hasExtraUsageEnabled: 'yes' }))), false);
  });
  ok('readLogin: no oauthAccount (logged out, API key) → null', () => {
    assert.equal(readLogin(file('none.json', JSON.stringify({ numStartups: 1 }))), null);
  });
  ok('readLogin: a file caught mid-write throws, so the caller keeps its last value', () => {
    assert.throws(() => readLogin(file('half.json', config({}).slice(0, 40))));
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\naccountcheck PASS (${passed} tests)`);
