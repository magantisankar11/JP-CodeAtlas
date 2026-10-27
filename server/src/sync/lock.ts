import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * One sync at a time per workspace: an exclusively created lock file holding the owner's pid. A lock whose pid is no
 * longer running (crash, killed terminal) is taken over and reported.
 */
export class SyncLockedError extends Error {}

export interface LockHandle { file: string; tookOverFrom: { pid: number; startedAt: string } | null; release: () => void }

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export function acquireLock(file: string, pid = process.pid): LockHandle {
  mkdirSync(dirname(file), { recursive: true });
  let tookOverFrom: LockHandle['tookOverFrom'] = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, JSON.stringify({ pid, startedAt: new Date().toISOString() }));
      closeSync(fd);
      return { file, tookOverFrom, release: () => rmSync(file, { force: true }) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let owner: { pid: number; startedAt: string } | null = null;
      try {
        owner = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        // Unreadable or half-written lock: treat as stale.
      }
      if (owner && Number.isInteger(owner.pid) && alive(owner.pid)) {
        throw new SyncLockedError(`another sync is running (pid ${owner.pid}, since ${owner.startedAt}); lock ${file}`);
      }
      tookOverFrom = owner ?? { pid: -1, startedAt: 'unknown' };
      rmSync(file, { force: true });
    }
  }
  throw new SyncLockedError(`could not acquire ${file}`);
}
