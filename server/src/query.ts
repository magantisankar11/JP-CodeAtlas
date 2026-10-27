import type { DB } from './db.js';
import { currentSnapshotId, currentSnapshotIds, VISIBLE } from './snapshots.js';
import { resolutionRank, type EdgeDto, type NodeDto, type Resolution, type SnapshotDto } from './contract.js';

export interface NodeRow {
  id: string; kind: string; name: string; fqn: string | null; signature: string | null; package: string | null;
  file_path: string | null; line_start: number | null; line_end: number | null; in_scope: number; attrs_json: string;
}
export interface EdgeRow {
  id: string; kind: string; src: string; dst: string; resolution: string; evidence_json: string; attrs_json: string;
}
interface SnapshotRow {
  id: number; repo_id: string; commit_sha: string; repo_path: string | null; source_mode: string | null; analyzer_version: string | null;
  engine: string | null; finished_at: string | null; loaded_at: string; scope_json: string; stats_json: string;
}

export const FLOW_EDGE_KINDS = ['EXPOSES', 'CALLS', 'QUERIES', 'READS', 'WRITES'] as const;

/**
 * Edge-kind presets. Directions are the stored edge directions; "reverse" traversal walks them backwards.
 *  flow        execution: endpoint -> handler -> calls -> SQL/tables, external calls, scheduled jobs, events
 *  type-impact who depends on a type: ACCEPTS/RETURNS (endpoints), HAS_FIELD_TYPE (enclosing DTOs), USES_TYPE (methods), then callers
 *  data        tables and entities back to the code and endpoints that read/write them
 *  all         everything except structural DECLARES
 */
export const PRESETS: Record<string, string[]> = {
  flow: ['EXPOSES', 'CALLS', 'QUERIES', 'READS', 'WRITES', 'INVOKES_PROCEDURE', 'CALLS_EXTERNAL', 'SCHEDULES', 'PUBLISHES', 'TRIGGERS', 'MAKES_HTTP_CALL', 'CALLS_API'],
  'type-impact': ['ACCEPTS', 'RETURNS', 'HAS_FIELD_TYPE', 'USES_TYPE', 'MAPS_TO', 'CALLS', 'EXPOSES', 'SCHEDULES', 'TRIGGERS'],
  data: ['MAPS_TO', 'QUERIES', 'READS', 'WRITES', 'INVOKES_PROCEDURE', 'CALLS', 'EXPOSES', 'SCHEDULES', 'TRIGGERS'],
  all: ['EXPOSES', 'CALLS', 'QUERIES', 'READS', 'WRITES', 'INVOKES_PROCEDURE', 'CALLS_EXTERNAL', 'SCHEDULES', 'PUBLISHES', 'TRIGGERS',
    'ACCEPTS', 'RETURNS', 'HAS_FIELD_TYPE', 'USES_TYPE', 'MAPS_TO', 'INJECTS', 'IMPLEMENTS', 'EXTENDS', 'THROWS', 'HANDLES_EXCEPTION', 'READS_CONFIG',
    'MAKES_HTTP_CALL', 'CALLS_API', 'CONTAINS', 'RENDERS', 'ROUTES_TO', 'TESTS'],
  /** Frontend screens: route → component → function → HTTP call → Core endpoint. */
  ui: ['ROUTES_TO', 'RENDERS', 'CONTAINS', 'CALLS', 'MAKES_HTTP_CALL', 'CALLS_API', 'EXPOSES'],
};
const RESOLUTION_NAMES: Resolution[] = ['CONFIRMED', 'FRAMEWORK_DERIVED', 'AMBIGUOUS', 'UNRESOLVED'];
export const MAX_DEPTH = 10;
export const MAX_NODES = 500;

export const toNode = (r: NodeRow): NodeDto => ({
  id: r.id, kind: r.kind, name: r.name, fqn: r.fqn, signature: r.signature, package: r.package, filePath: r.file_path,
  lineStart: r.line_start, lineEnd: r.line_end, inScope: r.in_scope === 1, attrs: JSON.parse(r.attrs_json) as Record<string, unknown>,
});
export const toEdge = (r: EdgeRow): EdgeDto => ({
  id: r.id, kind: r.kind, src: r.src, dst: r.dst, resolution: r.resolution as Resolution,
  evidence: JSON.parse(r.evidence_json) as EdgeDto['evidence'], attrs: JSON.parse(r.attrs_json) as Record<string, unknown>,
});
export const toSnapshot = (r: SnapshotRow): SnapshotDto & { repoPath: string | null } => ({
  id: r.id, repoId: r.repo_id, commitSha: r.commit_sha, repoPath: r.repo_path, sourceMode: r.source_mode, analyzerVersion: r.analyzer_version,
  engine: r.engine, finishedAt: r.finished_at, loadedAt: r.loaded_at, scope: JSON.parse(r.scope_json) as Record<string, unknown>,
  stats: JSON.parse(r.stats_json) as Record<string, unknown>,
});

/** Visible snapshots, newest first; `current` marks the published (or, unpublished, newest) snapshot of each repo. */
export function listSnapshots(db: DB) {
  const current = currentSnapshotIds(db);
  return (db.prepare(`SELECT * FROM snapshots s WHERE ${VISIBLE} ORDER BY id DESC`).all() as SnapshotRow[])
    .map((r) => ({ ...toSnapshot(r), current: current.has(r.id) }));
}

/**
 * Explicit id, else the current snapshot of one repo (published, else the most recently loaded), else the most recently
 * published snapshot of any repo (else the most recently loaded). PENDING snapshots resolve only with `includePending`.
 */
export function resolveSnapshot(db: DB, id?: number, repoId?: string, opts: { includePending?: boolean } = {}) {
  const vis = opts.includePending ? '1 = 1' : VISIBLE;
  let row: unknown;
  if (id !== undefined) row = db.prepare(`SELECT * FROM snapshots s WHERE id = ? AND ${vis}`).get(id);
  else if (repoId) {
    const cid = currentSnapshotId(db, repoId);
    row = cid === null ? undefined : db.prepare('SELECT * FROM snapshots WHERE id = ?').get(cid);
  } else {
    row = db.prepare('SELECT s.* FROM current_snapshots c JOIN snapshots s ON s.id = c.snapshot_id ORDER BY c.published_at DESC, s.id DESC LIMIT 1').get()
      ?? db.prepare(`SELECT * FROM snapshots s WHERE ${VISIBLE} ORDER BY id DESC LIMIT 1`).get();
  }
  return row ? toSnapshot(row as SnapshotRow) : undefined;
}

export function getNode(db: DB, sid: number, id: string): NodeDto | undefined {
  const r = db.prepare('SELECT * FROM nodes WHERE snapshot_id = ? AND id = ?').get(sid, id) as NodeRow | undefined;
  return r ? toNode(r) : undefined;
}

/** Edges touching one node, both directions, for the details panel. */
export function nodeEdges(db: DB, sid: number, id: string, limit = 200) {
  const out = (db.prepare('SELECT * FROM edges WHERE snapshot_id = ? AND src = ? LIMIT ?').all(sid, id, limit) as EdgeRow[]).map(toEdge);
  const inc = (db.prepare('SELECT * FROM edges WHERE snapshot_id = ? AND dst = ? LIMIT ?').all(sid, id, limit) as EdgeRow[]).map(toEdge);
  return { outgoing: out, incoming: inc };
}

export interface SearchHit { id: string; kind: string; name: string; filePath: string | null; score: number }

const KIND_BOOST: Record<string, number> = {
  API_ENDPOINT: 0, CONTROLLER: 1, SERVICE: 1, REPOSITORY: 1, INTERFACE: 2, COMPONENT: 2, CLASS: 3, ENTITY: 3, METHOD: 4, DATABASE_TABLE: 4,
};

export function search(db: DB, sid: number, q: string, kinds: string[] = [], limit = 30): SearchHit[] {
  const tokens = q.match(/[A-Za-z0-9_]+/g) ?? [];
  if (!tokens.length) return [];
  const match = tokens.map((t) => `"${t.toLowerCase()}"*`).join(' AND ');
  const kindFilter = kinds.length ? `AND kind IN (${kinds.map(() => '?').join(',')})` : '';
  const rows = db
    .prepare(
      `SELECT node_id AS id, kind, name, file_path AS filePath, bm25(nodes_fts, 0, 0, 0, 5.0, 1.0, 0.5) AS score
       FROM nodes_fts WHERE nodes_fts MATCH ? AND snapshot_id = ? ${kindFilter} ORDER BY score LIMIT ?`,
    )
    .all(match, sid, ...kinds, Math.min(limit * 4, 400)) as SearchHit[];
  // bm25 is negative (lower = better). Exact/contiguous name matches dominate; node kind only breaks near-ties.
  const joined = tokens.join('').toLowerCase();
  const rank = (h: SearchHit) => {
    const name = h.name.toLowerCase().replace(/[^a-z0-9_]/g, '');
    const nameBonus = name === joined ? 20 : name.includes(joined) ? 8 : 0;
    return h.score - nameBonus + (KIND_BOOST[h.kind] ?? 5) * 0.3;
  };
  return rows
    .map((r) => ({ ...r, filePath: r.filePath || null }))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, limit);
}

export function endpoints(db: DB, sid: number, opts: { method?: string; q?: string; limit?: number } = {}) {
  const rows = db
    .prepare(`SELECT * FROM nodes WHERE snapshot_id = ? AND kind = 'API_ENDPOINT' ORDER BY json_extract(attrs_json, '$.path'), name`)
    .all(sid) as NodeRow[];
  const q = opts.q?.toLowerCase();
  return rows
    .map(toNode)
    .filter((n) => !opts.method || n.attrs.httpMethod === opts.method.toUpperCase())
    .filter((n) => !q || n.name.toLowerCase().includes(q) || String(n.attrs.handler ?? '').toLowerCase().includes(q))
    .slice(0, opts.limit ?? 2000);
}

export interface GraphRequest {
  root: string;
  direction: 'forward' | 'reverse';
  depth: number;
  edgeKinds?: string[];
  minResolution?: Resolution;
  includeAccessors?: boolean;
  /** Hide the statically bound hop to an abstract/interface method when the same call site has dispatch edges. */
  collapseDispatch?: boolean;
  limit?: number;
}

export interface GraphResult {
  root: string;
  direction: 'forward' | 'reverse';
  /**
   * pathResolution: the strongest chain of evidence from the root to this node within the returned subgraph, i.e. the
   * best achievable "weakest link". CONFIRMED means every edge on some path is a compiler-confirmed fact.
   */
  nodes: Array<NodeDto & { depth: number; hasMore: boolean; pathResolution: Resolution; viaEnclosingType: boolean }>;
  edges: EdgeDto[];
  /** Edge ids whose target is an ancestor in the traversal (recursion / circular calls). */
  cycleEdges: string[];
  truncated: boolean;
  limits: { depth: number; nodes: number };
}

/**
 * Bounded breadth-first traversal. Returns at most `limit` nodes; nodes whose neighbours were not expanded
 * (depth or node limit) are flagged `hasMore` so the UI can expand them progressively.
 */
export function traverse(db: DB, sid: number, req: GraphRequest, maxNodes = MAX_NODES): GraphResult | undefined {
  const rootRow = db.prepare('SELECT * FROM nodes WHERE snapshot_id = ? AND id = ?').get(sid, req.root) as NodeRow | undefined;
  if (!rootRow) return undefined;
  const depthLimit = Math.max(0, Math.min(req.depth, MAX_DEPTH));
  const nodeLimit = Math.max(1, Math.min(req.limit ?? 150, maxNodes));
  const kinds = req.edgeKinds?.length ? req.edgeKinds : [...FLOW_EDGE_KINDS];
  const minRank = resolutionRank(req.minResolution ?? 'UNRESOLVED');
  const forward = req.direction !== 'reverse';
  const [near, far] = forward ? ['src', 'dst'] : ['dst', 'src'];

  const depthOf = new Map<string, number>([[req.root, 0]]);
  const parent = new Map<string, string | null>([[req.root, null]]);
  const edges = new Map<string, EdgeDto>();
  const cycleEdges = new Set<string>();
  const unexpanded = new Set<string>();
  let truncated = false;
  let frontier = [req.root];

  const keep = (e: EdgeDto) =>
    resolutionRank(e.resolution) <= minRank
    && (req.includeAccessors || (e.attrs.accessor !== true && e.attrs.lombokAccessor !== true));
  const collapse = req.collapseDispatch !== false;
  const isAncestor = (candidate: string, of: string) => {
    for (let cur: string | null | undefined = of; cur; cur = parent.get(cur)) if (cur === candidate) return true;
    return false;
  };

  for (let depth = 0; depth < depthLimit && frontier.length; depth++) {
    const next: string[] = [];
    for (let i = 0; i < frontier.length; i += 300) {
      const batch = frontier.slice(i, i + 300);
      const rows = db
        .prepare(
          `SELECT * FROM edges WHERE snapshot_id = ? AND ${near} IN (${batch.map(() => '?').join(',')})
           AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY ${near}, kind, ${far}`,
        )
        .all(sid, ...batch, ...kinds) as EdgeRow[];
      const batchEdges = rows.map(toEdge).filter(keep);
      // Static hops that are already represented by dispatch edges from the same caller.
      const dispatched = new Set(
        collapse ? batchEdges.filter((e) => typeof e.attrs.viaDispatch === 'string').map((e) => `${e.src}|${e.attrs.viaDispatch}`) : [],
      );
      for (const e of batchEdges) {
        if (dispatched.has(`${e.src}|${e.dst}`)) continue;
        const from = forward ? e.src : e.dst;
        const to = forward ? e.dst : e.src;
        if (depthOf.has(to)) {
          edges.set(e.id, e);
          if (isAncestor(to, from)) cycleEdges.add(e.id);
          continue;
        }
        if (depthOf.size >= nodeLimit) {
          truncated = true;
          unexpanded.add(from);
          continue;
        }
        depthOf.set(to, depth + 1);
        parent.set(to, from);
        edges.set(e.id, e);
        next.push(to);
      }
    }
    frontier = next;
  }

  const ids = [...depthOf.keys()];
  const rows: NodeRow[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const batch = ids.slice(i, i + 400);
    rows.push(...(db.prepare(`SELECT * FROM nodes WHERE snapshot_id = ? AND id IN (${batch.map(() => '?').join(',')})`).all(sid, ...batch) as NodeRow[]));
  }
  // Leaves at the depth limit: do they have further edges?
  const leaves = ids.filter((id) => (depthOf.get(id) ?? 0) >= depthLimit);
  for (let i = 0; i < leaves.length; i += 400) {
    const batch = leaves.slice(i, i + 400);
    const counts = db
      .prepare(
        `SELECT ${near} AS id, COUNT(*) AS n FROM edges WHERE snapshot_id = ? AND ${near} IN (${batch.map(() => '?').join(',')})
         AND kind IN (${kinds.map(() => '?').join(',')}) GROUP BY ${near}`,
      )
      .all(sid, ...batch, ...kinds) as Array<{ id: string; n: number }>;
    for (const c of counts) if (c.n > 0) unexpanded.add(c.id);
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Max-min relaxation over the returned edges: best[v] = min over paths of the weakest edge rank on that path,
  // tie-broken towards paths that do not go through a field of an enclosing type (HAS_FIELD_TYPE): key = rank*2 + via.
  const best = new Map<string, number>([[req.root, 0]]);
  for (let changed = true, rounds = 0; changed && rounds < 50; rounds++) {
    changed = false;
    for (const e of edges.values()) {
      const from = forward ? e.src : e.dst;
      const to = forward ? e.dst : e.src;
      const bf = best.get(from);
      if (bf === undefined) continue;
      const rank = Math.max(bf >> 1, resolutionRank(e.resolution));
      const via = (bf & 1) | (e.kind === 'HAS_FIELD_TYPE' ? 1 : 0);
      const cand = rank * 2 + via;
      if (cand < (best.get(to) ?? Infinity)) {
        best.set(to, cand);
        changed = true;
      }
    }
  }
  return {
    root: req.root,
    direction: forward ? 'forward' : 'reverse',
    nodes: ids
      .map((id) => byId.get(id))
      .filter((r): r is NodeRow => Boolean(r))
      .map((r) => {
        const b = best.get(r.id);
        return {
          ...toNode(r), depth: depthOf.get(r.id) ?? 0, hasMore: unexpanded.has(r.id),
          pathResolution: RESOLUTION_NAMES[b === undefined ? 3 : b >> 1] ?? 'UNRESOLVED',
          viaEnclosingType: b !== undefined && (b & 1) === 1,
        };
      }),
    edges: [...edges.values()],
    cycleEdges: [...cycleEdges],
    truncated,
    limits: { depth: depthLimit, nodes: nodeLimit },
  };
}

export function diagnostics(db: DB, sid: number, code?: string, limit = 200) {
  const rows = code
    ? db.prepare('SELECT severity, code, message, file_path AS filePath, line FROM diagnostics WHERE snapshot_id = ? AND code = ? LIMIT ?').all(sid, code, limit)
    : db.prepare('SELECT severity, code, message, file_path AS filePath, line FROM diagnostics WHERE snapshot_id = ? LIMIT ?').all(sid, limit);
  const summary = db.prepare('SELECT code, severity, COUNT(*) AS count FROM diagnostics WHERE snapshot_id = ? GROUP BY code, severity ORDER BY count DESC').all(sid);
  return { summary, items: rows };
}

export const REACH_BUDGET = 20000;

export interface ReachResult {
  root: string;
  /** viaEnclosingType: only reachable through a field of another type (potential impact: the field may be unused). */
  entryPoints: Array<NodeDto & { depth: number; pathResolution: Resolution; viaEnclosingType: boolean }>;
  visited: number;
  truncated: boolean;
  depth: number;
}

/**
 * Entry points (endpoints, jobs, listeners, startup hooks) that reach the root in reverse, with a large node budget
 * because nothing is rendered. Answers "which APIs might be affected" independently of the drawn subgraph.
 */
export function reach(db: DB, sid: number, req: Omit<GraphRequest, 'direction' | 'limit'>): ReachResult | undefined {
  const g = traverse(db, sid, { ...req, direction: 'reverse', limit: REACH_BUDGET }, REACH_BUDGET);
  if (!g) return undefined;
  const entryPoints = g.nodes
    .filter((n) => n.id !== req.root && (n.kind === 'API_ENDPOINT' || (n.attrs.entryPoint && n.attrs.entryPoint !== 'HTTP')))
    .map(({ hasMore: _h, ...n }) => n)
    .sort((a, b) => resolutionRank(a.pathResolution) - resolutionRank(b.pathResolution)
      || Number(a.viaEnclosingType) - Number(b.viaEnclosingType) || a.name.localeCompare(b.name));
  return { root: req.root, entryPoints, visited: g.nodes.length, truncated: g.truncated, depth: g.limits.depth };
}

export interface CatalogEntry extends NodeDto {
  incoming: Record<string, number>;
  outgoing: Record<string, number>;
}

/**
 * Nodes of one kind with per-kind edge counts, for list views (tables, integrations, DTOs, config, entry points).
 * entryPoints=true lists METHOD nodes carrying attrs.entryPoint other than HTTP.
 */
export function catalog(db: DB, sid: number, opts: { kind?: string; entryPoints?: boolean; q?: string; limit?: number }): CatalogEntry[] {
  const limit = Math.min(opts.limit ?? 500, 5000);
  const where = opts.entryPoints
    ? `kind = 'METHOD' AND json_extract(attrs_json, '$.entryPoint') IS NOT NULL AND json_extract(attrs_json, '$.entryPoint') != 'HTTP'`
    : 'kind = ?';
  const params: unknown[] = opts.entryPoints ? [sid] : [sid, opts.kind ?? ''];
  let rows = db.prepare(`SELECT * FROM nodes WHERE snapshot_id = ? AND ${where} ORDER BY name LIMIT 20000`).all(...params) as NodeRow[];
  const q = opts.q?.toLowerCase();
  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || (r.fqn ?? '').toLowerCase().includes(q));
  rows = rows.slice(0, limit);
  const counts = (col: 'src' | 'dst', ids: string[]) => {
    const out = new Map<string, Record<string, number>>();
    for (let i = 0; i < ids.length; i += 400) {
      const batch = ids.slice(i, i + 400);
      const rs = db
        .prepare(`SELECT ${col} AS id, kind, COUNT(*) AS n FROM edges WHERE snapshot_id = ? AND ${col} IN (${batch.map(() => '?').join(',')})
                  AND kind != 'DECLARES' GROUP BY ${col}, kind`)
        .all(sid, ...batch) as Array<{ id: string; kind: string; n: number }>;
      for (const r of rs) {
        const m = out.get(r.id) ?? {};
        m[r.kind] = r.n;
        out.set(r.id, m);
      }
    }
    return out;
  };
  const ids = rows.map((r) => r.id);
  const inc = counts('dst', ids);
  const out = counts('src', ids);
  return rows.map((r) => ({ ...toNode(r), incoming: inc.get(r.id) ?? {}, outgoing: out.get(r.id) ?? {} }));
}

/** Only files the graph itself references may be read through the source endpoint. */
export function isIndexedFile(db: DB, sid: number, filePath: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM nodes WHERE snapshot_id = ? AND file_path = ? LIMIT 1').get(sid, filePath));
}
