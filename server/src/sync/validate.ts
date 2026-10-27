import type { DB } from '../db.js';
import { endpoints, search, traverse } from '../query.js';

/**
 * Checks on a loaded (PENDING) snapshot before sync publishes it. The loader has already enforced the record contract,
 * the schema major version, dangling edges and unique ids; these checks cover what only the loaded result can show.
 */
export interface Check { check: string; ok: boolean; detail: string }

export interface ValidateInput {
  snapshotId: number;
  /** Planned commit per repository id. */
  commits: Record<string, string>;
  /** Repository roles, for the content check. */
  roles: Record<string, 'backend' | 'frontend'>;
  /** Counts reported by the loader; null when an already loaded snapshot is reused. */
  loaded: { nodes: number; edges: number; diagnostics: number } | null;
  /** Previously current snapshot of the same id, for the shrink guard. */
  previousId: number | null;
  maxShrink: number;
  allowShrink: boolean;
}

/** Node kinds with fewer nodes than this in the previous snapshot are too small for a meaningful shrink ratio. */
export const SHRINK_MIN_NODES = 10;

const n = (db: DB, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { c: number }).c;
const kindCounts = (db: DB, sid: number) =>
  new Map((db.prepare('SELECT kind, COUNT(*) AS c FROM nodes WHERE snapshot_id = ? GROUP BY kind').all(sid) as Array<{ kind: string; c: number }>).map((r) => [r.kind, r.c]));

export function validateSnapshot(db: DB, v: ValidateInput): Check[] {
  const out: Check[] = [];
  const add = (check: string, ok: boolean, detail: string) => out.push({ check, ok, detail });
  const sid = v.snapshotId;
  const row = db.prepare('SELECT repo_id, commit_sha, source_mode, scope_json FROM snapshots WHERE id = ?').get(sid) as
    { repo_id: string; commit_sha: string; source_mode: string | null; scope_json: string } | undefined;
  if (!row) return [{ check: 'snapshot', ok: false, detail: `snapshot ${sid} not found` }];
  const scope = JSON.parse(row.scope_json) as { repos?: Array<{ repoId: string; commitSha: string; pathPrefix?: string; sourceMode?: string }> };

  // Commits: the snapshot is built from exactly the planned commits, read from git (not a working tree).
  const recorded = scope.repos?.length ? scope.repos.map((r) => [r.repoId, r.commitSha, r.sourceMode ?? row.source_mode] as const)
    : [[row.repo_id, row.commit_sha, row.source_mode] as const];
  const wrong = Object.entries(v.commits).filter(([id, c]) => !recorded.some(([rid, rc, mode]) => rid === id && rc === c && mode === 'HEAD'));
  const extra = recorded.filter(([rid]) => !(rid in v.commits));
  add('commits', !wrong.length && !extra.length && recorded.length === Object.keys(v.commits).length,
    wrong.length || extra.length ? `expected ${JSON.stringify(v.commits)}, snapshot has ${JSON.stringify(recorded)}`
      : recorded.map(([id, c]) => `${id}@${c.slice(0, 10)}`).join(', '));

  // Counts: what was written equals what the loader parsed.
  const nodes = n(db, 'SELECT COUNT(*) AS c FROM nodes WHERE snapshot_id = ?', sid);
  const edges = n(db, 'SELECT COUNT(*) AS c FROM edges WHERE snapshot_id = ?', sid);
  const diags = n(db, 'SELECT COUNT(*) AS c FROM diagnostics WHERE snapshot_id = ?', sid);
  if (v.loaded) {
    const same = nodes === v.loaded.nodes && edges === v.loaded.edges && diags === v.loaded.diagnostics;
    add('counts', same, `${nodes} nodes, ${edges} edges, ${diags} diagnostics${same ? '' : ` (loader parsed ${v.loaded.nodes}/${v.loaded.edges}/${v.loaded.diagnostics})`}`);
  } else add('counts', nodes > 0, `${nodes} nodes, ${edges} edges, ${diags} diagnostics (already loaded snapshot reused)`);

  // Search index: one row per searchable node.
  const searchable = n(db, "SELECT COUNT(*) AS c FROM nodes WHERE snapshot_id = ? AND kind NOT IN ('UNRESOLVED', 'SQL_STATEMENT')", sid);
  const fts = n(db, 'SELECT COUNT(*) AS c FROM nodes_fts WHERE snapshot_id = ?', sid);
  add('search-index', fts === searchable, `${fts} search rows for ${searchable} searchable nodes`);

  // References: every edge ends at a node of the same snapshot.
  const dangling = n(db, `SELECT COUNT(*) AS c FROM edges e WHERE e.snapshot_id = ?
      AND (NOT EXISTS (SELECT 1 FROM nodes x WHERE x.snapshot_id = e.snapshot_id AND x.id = e.src)
        OR NOT EXISTS (SELECT 1 FROM nodes x WHERE x.snapshot_id = e.snapshot_id AND x.id = e.dst))`, sid);
  add('references', dangling === 0, dangling ? `${dangling} edge(s) reference missing nodes` : 'all edges resolve');

  // Path prefixes: files of secondary repositories carry their declared prefix, so source reads go to the right repo.
  const prefixed = (scope.repos ?? []).filter((r) => r.pathPrefix);
  if (prefixed.length) {
    const bad = prefixed.reduce((sum, r) => sum + n(db, `SELECT COUNT(*) AS c FROM nodes WHERE snapshot_id = ? AND file_path IS NOT NULL
        AND json_extract(attrs_json, '$.repoId') = ? AND substr(file_path, 1, ?) != ?`, sid, r.repoId, r.pathPrefix!.length, r.pathPrefix), 0);
    const known = prefixed.map((r) => r.pathPrefix!);
    const stray = (db.prepare("SELECT DISTINCT file_path FROM nodes WHERE snapshot_id = ? AND file_path LIKE '@%'").all(sid) as Array<{ file_path: string }>)
      .filter((r) => !known.some((p) => r.file_path.startsWith(p))).length;
    add('path-prefixes', bad === 0 && stray === 0, bad || stray ? `${bad} unprefixed file(s), ${stray} unknown prefix(es)` : `prefixes ${known.join(', ')}`);
  }

  // Content: each repository contributed what its analyzer must find.
  const kinds = kindCounts(db, sid);
  for (const [id, role] of Object.entries(v.roles)) {
    const c = role === 'backend' ? kinds.get('API_ENDPOINT') ?? 0 : (kinds.get('UI_ROUTE') ?? 0) + (kinds.get('UI_COMPONENT') ?? 0);
    add(`content:${id}`, c > 0, `${c} ${role === 'backend' ? 'API endpoints' : 'UI routes and components'}`);
  }

  // Shrink guard against an analyzer that silently produced an almost empty graph.
  if (v.previousId !== null && v.previousId !== sid) {
    const prev = kindCounts(db, v.previousId);
    const drops = [...prev].filter(([k, c]) => c >= SHRINK_MIN_NODES && (kinds.get(k) ?? 0) < c * (1 - v.maxShrink))
      .map(([k, c]) => `${k} ${c} → ${kinds.get(k) ?? 0}`);
    const links = (s: number) => n(db, "SELECT COUNT(*) AS c FROM edges WHERE snapshot_id = ? AND kind = 'CALLS_API'", s);
    const prevLinks = links(v.previousId);
    const nowLinks = links(sid);
    if (prevLinks > 0 && nowLinks === 0) drops.push(`CALLS_API ${prevLinks} → 0`);
    const detail = drops.length ? `vs snapshot ${v.previousId}: ${drops.join(', ')}` : `no node kind dropped more than ${Math.round(v.maxShrink * 100)}% vs snapshot ${v.previousId}`;
    add('shrink', !drops.length || v.allowShrink, drops.length && v.allowShrink ? `${detail} (allowed by --allow-shrink)` : detail);
  }

  // Query smoke test: the published snapshot must answer the UI's first questions.
  const first = endpoints(db, sid, { limit: 1 })[0] ?? (db.prepare("SELECT id, name FROM nodes WHERE snapshot_id = ? AND kind NOT IN ('UNRESOLVED', 'SQL_STATEMENT') LIMIT 1").get(sid) as { id: string; name: string } | undefined);
  if (!first) add('query', false, 'no searchable node');
  else {
    const hits = search(db, sid, first.name, [], 5).length;
    const g = traverse(db, sid, { root: first.id, direction: 'forward', depth: 2 });
    add('query', hits > 0 && !!g && g.nodes.length > 0, `search "${first.name}": ${hits} hit(s); traversal from ${first.id}: ${g?.nodes.length ?? 0} node(s)`);
  }
  return out;
}
