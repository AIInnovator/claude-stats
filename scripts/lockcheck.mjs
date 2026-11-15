// Proves the reader never gets in the way of Claude Code: while this process holds a transcript open mid-read
// and watches its folder (exactly what the server does), a SEPARATE process must be able to append to it,
// rewrite it, rename it, delete it, and delete its whole project folder. On Windows a reader that opened the
// file without share-write/share-delete would make those fail with EBUSY/EPERM ("file is busy").
// Run: node scripts/lockcheck.mjs   (touches only scripts/.tmp-lockcheck/, deleted at the end)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, Tailer } from '../lib/store.mjs';

const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp-lockcheck');
const proj = path.join(base, 'project-a'), file = path.join(proj, 'session.jsonl');
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(proj, { recursive: true });
const line = (n) => JSON.stringify({ type: 'system', subtype: 'turn_duration', uuid: 'u' + n, sessionId: 'S', timestamp: '2026-11-13T00:00:00Z', cwd: 'C:/x', durationMs: 5 }) + '\n';
fs.writeFileSync(file, line(1));

// 1. do what the server does: watch the folder, read the file, and keep a handle open as if mid-read
const store = new Store(), tail = new Tailer(store, base);
const watcher = fs.watch(base, { recursive: true }, () => {});
tail.scan();
const held = fs.openSync(file, 'r');
fs.readSync(held, Buffer.alloc(16), 0, 16, 0);

// 2. another program (a separate process, like a Claude Code session) edits the same files meanwhile
const other = `
  const fs = require('node:fs'), path = require('node:path');
  const [file, proj] = process.argv.slice(1), done = [];
  const step = (name, fn) => { try { fn(); done.push(name); } catch (e) { console.error(name + ' FAILED: ' + e.code + ' ' + e.message); process.exit(1); } };
  step('append', () => fs.appendFileSync(file, '{"x":1}\\n'));
  step('rewrite', () => fs.writeFileSync(file, '{"x":2}\\n'));
  step('rename', () => fs.renameSync(file, file + '.old'));
  step('create again', () => fs.writeFileSync(file, '{"x":3}\\n'));
  step('delete', () => fs.unlinkSync(file + '.old'));
  step('delete project folder', () => fs.rmSync(proj, { recursive: true }));
  console.log(done.join(', '));
`;
let out;
try {
  out = execFileSync(process.execPath, ['-e', other, file, proj], { encoding: 'utf8' }).trim();
} finally {
  fs.closeSync(held);
  watcher.close();
}
assert.equal(out, 'append, rewrite, rename, create again, delete, delete project folder');
console.log(`  ok  while the reader held the file open and watched the folder, another process could: ${out}`);

// 3. and the reader copes: the next scan simply finds the folder gone, no crash
tail.scan();
console.log('  ok  reader rescans after the files vanished without error');
fs.rmSync(base, { recursive: true, force: true });
console.log('\nlockcheck PASS');
