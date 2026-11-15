// Server state machines. Each has ONE state type and ONE pure transition function:
//   step(state, event) -> { state, effects }
// Callers do the effects (file I/O, timers, logging); nothing else changes these states. An event the current
// state does not accept leaves the state as it is and returns the effect 'invalid'.

const result = (state, ...effects) => ({ state, effects });
const invalid = (state) => result(state, 'invalid');

// ---------------------------------------------------------------------------------------------------------------
/**
 * One transcript file.
 * @typedef {{ kind: 'unseen' }
 *   | { kind: 'tracked', off: number, id: string, head: string, ctx: { lastT?: number } }
 *   | { kind: 'gone' }} FileState
 *
 * Events:
 *   { type: 'stat', size, id }   the file exists with this size and identity (inode + birth time)
 *   { type: 'headChanged' }      its first bytes differ from when it was first read (rewritten in place)
 *   { type: 'readOk', end, head } complete lines up to byte `end` were ingested; `head` = its first bytes
 *   { type: 'readFailed' }       the read threw (antivirus, network drive, vanished mid-read)
 *   { type: 'missing' }          the file is no longer on disk
 * Effects:
 *   'read'     read complete lines from state.off
 *   'restart'  rows already taken from this file can no longer be trusted: the owner must rebuild
 *   'retry'    keep the offset and read the same bytes next scan
 */
export const FILE_UNSEEN = Object.freeze({ kind: 'unseen' });
const tracked = (off, id, head = '', ctx = {}) => ({ kind: 'tracked', off, id, head, ctx });

export function fileStep(s, e) {
  switch (s.kind) {
    case 'unseen':
      if (e.type === 'stat') return e.size > 0 ? result(tracked(0, e.id), 'read') : result(tracked(0, e.id));
      if (e.type === 'missing') return result(s);
      return invalid(s);
    case 'tracked':
      if (e.type === 'stat') {
        // shrank or replaced by another file: what was read is not this file any more
        if (e.size < s.off || e.id !== s.id) return e.size > 0 ? result(tracked(0, e.id), 'restart', 'read') : result(tracked(0, e.id), 'restart');
        return e.size > s.off ? result(s, 'read') : result(s);
      }
      if (e.type === 'headChanged') return result(tracked(0, s.id), 'restart', 'read');
      if (e.type === 'readOk') {
        if (e.end < s.off) return invalid(s); // offsets only move forward; going back is a restart
        return result(tracked(e.end, s.id, s.head || e.head || '', s.ctx));
      }
      if (e.type === 'readFailed') return result(s, 'retry');
      if (e.type === 'missing') return result({ kind: 'gone' }, 'restart');
      return invalid(s);
    case 'gone':
      if (e.type === 'stat') return e.size > 0 ? result(tracked(0, e.id), 'read') : result(tracked(0, e.id));
      if (e.type === 'missing') return result(s);
      return invalid(s);
    default:
      return invalid(s);
  }
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * The scan scheduler (one per server). Runs are synchronous, so 'running' never overlaps another run.
 * Cheapest possible updates: the watcher names the file that changed, so only that file is checked; a full
 * check of every file happens on the slow safety poll or when the watcher can't say which file it was.
 * @typedef {{ phase: 'idle' | 'scheduled' | 'running', target: null | 'all' | string[], lastRun: number,
 *             lastRebuild: number, rebuildPending: boolean, gapMs: number }} ScanState
 *
 * Events:
 *   { type: 'trigger', now, file? }        a watcher event (file = the transcript it named) or the safety poll
 *   { type: 'fire', now }                  the scheduled timer went off
 *   { type: 'scanned', now, structural }   the scan finished; structural = a file vanished, shrank or was rewritten
 *   { type: 'failed', now }                the scan threw
 * Effects:
 *   { kind: 'timer', ms }      call step({type:'fire'}) after ms
 *   { kind: 'wake', ms }       call step({type:'trigger'}) after ms (a pending rebuild is due then)
 *   { kind: 'scan', target }   'all' or the list of files to check
 *   'rebuild' | 'delta' | 'log'
 */
export const FIRST_DELAY_MS = 100; // batch a burst of writes into one update
export const MIN_GAP_MS = 500;     // and send at most two updates a second while Claude writes continuously
export const scanInit = (now, gapMs) => ({ phase: 'idle', target: null, lastRun: 0, lastRebuild: now, rebuildPending: false, gapMs });
const mergeTarget = (cur, file) => (cur === 'all' || !file ? 'all' : cur ? (cur.includes(file) ? cur : [...cur, file]) : [file]);

export function scanStep(s, e) {
  switch (s.phase) {
    case 'idle':
      if (e.type === 'trigger') return result({ ...s, phase: 'scheduled', target: mergeTarget(s.target, e.file) }, { kind: 'timer', ms: Math.max(FIRST_DELAY_MS, MIN_GAP_MS - (e.now - s.lastRun)) });
      return invalid(s); // a 'fire' while idle is a stale timer; never run twice for one schedule
    case 'scheduled':
      if (e.type === 'trigger') return result({ ...s, target: mergeTarget(s.target, e.file) }); // already coming; widen what it checks
      if (e.type === 'fire') return result({ ...s, phase: 'running', target: null, lastRun: e.now }, { kind: 'scan', target: s.target || 'all' });
      return invalid(s);
    case 'running': {
      if (e.type === 'failed') return result({ ...s, phase: 'idle' }, 'log');
      if (e.type !== 'scanned') return invalid(s); // runs are synchronous: nothing can arrive mid-run
      const pending = s.rebuildPending || !!e.structural;
      if (!pending) return result({ ...s, phase: 'idle' }, 'delta');
      const wait = s.gapMs - (e.now - s.lastRebuild);
      if (wait <= 0) return result({ ...s, phase: 'idle', rebuildPending: false, lastRebuild: e.now }, 'rebuild');
      // stream new rows meanwhile; Claude Code's cleanup deletes files in bursts, so rebuild at most every gapMs
      return result({ ...s, phase: 'idle', rebuildPending: true }, 'delta', { kind: 'wake', ms: wait + 50 });
    }
    default:
      return invalid(s);
  }
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * The watcher on one transcript folder.
 * @typedef {{ kind: 'unarmed', warned: boolean } | { kind: 'armed', warned: boolean } | { kind: 'failed', warned: boolean }} WatchState
 *
 * Events: { type: 'check', exists } (every scan) | { type: 'armOk' } | { type: 'armFailed' } | { type: 'error' }
 * Effects: 'arm' | 'close' | 'warn' (said once per folder)
 */
export const WATCH_UNARMED = Object.freeze({ kind: 'unarmed', warned: false });

export function watchStep(s, e) {
  const warnOnce = (next) => (s.warned ? result({ ...next, warned: true }) : result({ ...next, warned: true }, 'warn'));
  switch (s.kind) {
    case 'unarmed':
    case 'failed':
      if (e.type === 'check') return e.exists ? result(s, 'arm') : result(s);
      if (e.type === 'armOk') return result({ kind: 'armed', warned: s.warned });
      if (e.type === 'armFailed') return warnOnce({ kind: 'failed' });
      return invalid(s);
    case 'armed':
      // the folder vanished: the old watcher is dead even if it never said so (Windows); re-arm when it is back
      if (e.type === 'check') return e.exists ? result(s) : result({ kind: 'unarmed', warned: s.warned }, 'close');
      if (e.type === 'error') {
        const r = warnOnce({ kind: 'unarmed' });
        return result(r.state, 'close', ...r.effects);
      }
      return invalid(s);
    default:
      return invalid(s);
  }
}
