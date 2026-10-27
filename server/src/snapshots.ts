import type { DB } from './db.js';

/**
 * Published ("current") snapshot per repoId and the PENDING state of snapshots loaded by `npm run sync` but not yet
 * validated. PENDING snapshots are invisible to every reader (API, CLI, web, freshness matching). Without a published
 * pointer for a repoId, the newest visible snapshot is current, which is the behaviour before pointers existed.
 */

/** SQL condition on an alias `s` of snapshots: hides PENDING rows. */
export const VISIBLE = 's.id NOT IN (SELECT snapshot_id FROM snapshot_state)';

export function currentSnapshotId(db: DB, repoId: string): number | null {
  const p = db.prepare('SELECT snapshot_id FROM current_snapshots WHERE repo_id = ?').get(repoId) as { snapshot_id: number } | undefined;
  if (p) return p.snapshot_id;
  const r = db.prepare(`SELECT id FROM snapshots s WHERE repo_id = ? AND ${VISIBLE} ORDER BY id DESC LIMIT 1`).get(repoId) as { id: number } | undefined;
  return r?.id ?? null;
}

/** Ids that are current for their repoId (published, or newest visible where nothing is published). */
export function currentSnapshotIds(db: DB): Set<number> {
  const rows = db.prepare(
    `SELECT COALESCE(c.snapshot_id, (SELECT MAX(s.id) FROM snapshots s WHERE s.repo_id = r.repo_id AND ${VISIBLE})) AS id
       FROM (SELECT DISTINCT repo_id FROM snapshots) r LEFT JOIN current_snapshots c ON c.repo_id = r.repo_id`,
  ).all() as Array<{ id: number | null }>;
  return new Set(rows.map((r) => r.id).filter((id): id is number => id !== null));
}

export function isPending(db: DB, id: number): boolean {
  return !!db.prepare('SELECT 1 FROM snapshot_state WHERE snapshot_id = ?').get(id);
}

export function markPending(db: DB, id: number): void {
  db.prepare("INSERT OR REPLACE INTO snapshot_state (snapshot_id, state, created_at) VALUES (?, 'PENDING', ?)").run(id, new Date().toISOString());
}

/** Makes `id` current for its repoId and clears its PENDING state, in one transaction. Returns the previous current id. */
export function publishSnapshot(db: DB, id: number, by: string): number | null {
  return db.transaction(() => {
    const row = db.prepare('SELECT repo_id FROM snapshots WHERE id = ?').get(id) as { repo_id: string } | undefined;
    if (!row) throw new Error(`snapshot ${id} does not exist`);
    const prev = currentSnapshotId(db, row.repo_id);
    db.prepare('DELETE FROM snapshot_state WHERE snapshot_id = ?').run(id);
    setCurrent(db, row.repo_id, id, by);
    return prev === id ? null : prev;
  })();
}

/** Upserts the pointer; callers run it inside their own transaction. */
export function setCurrent(db: DB, repoId: string, id: number, by: string): void {
  db.prepare(
    `INSERT INTO current_snapshots (repo_id, snapshot_id, published_at, published_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (repo_id) DO UPDATE SET snapshot_id = excluded.snapshot_id, published_at = excluded.published_at, published_by = excluded.published_by`,
  ).run(repoId, id, new Date().toISOString(), by);
}

/** Deletes a PENDING snapshot (and its nodes, edges, diagnostics, search rows). Refuses anything that is not PENDING. */
export function dropPending(db: DB, id: number): void {
  db.transaction(() => {
    if (!isPending(db, id)) throw new Error(`snapshot ${id} is not PENDING; refusing to delete it`);
    db.prepare('DELETE FROM nodes_fts WHERE snapshot_id = ?').run(id);
    db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
  })();
}

export function pendingSnapshotIds(db: DB): number[] {
  return (db.prepare('SELECT snapshot_id FROM snapshot_state ORDER BY snapshot_id').all() as Array<{ snapshot_id: number }>).map((r) => r.snapshot_id);
}
