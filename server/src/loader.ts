import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { DB } from './db.js';
import { markPending, setCurrent } from './snapshots.js';
import {
  SUPPORTED_SCHEMA_MAJOR,
  diagnosticRecord,
  edgeRecord,
  nodeRecord,
  snapshotRecord,
  type EdgeRecord,
  type NodeRecord,
  type SnapshotRecord,
} from './contract.js';

export interface LoadResult {
  snapshotId: number;
  repoId: string;
  commitSha: string;
  nodes: number;
  edges: number;
  diagnostics: number;
  replaced: boolean;
}

/** Splits identifiers for search: "SnippetsServiceImpl#loadSnippets" -> "snippets service impl load snippets". */
export function searchTerms(...values: Array<string | null | undefined>): string {
  const words = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    for (const part of v.split(/[^A-Za-z0-9_]+/)) {
      if (!part) continue;
      words.add(part.toLowerCase());
      for (const w of part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|_/)) {
        if (w) words.add(w.toLowerCase());
      }
    }
  }
  return [...words].join(' ');
}

/**
 * Loads one analyzer NDJSON file as a snapshot. A file is accepted only if its first line is a snapshot
 * record with a supported schema major version and every following line validates. Re-loading the same
 * repo + commit + scope + source mode replaces the earlier snapshot (keeping it current if it was); other commits are
 * kept side by side. `publish` makes the new snapshot current; `state: 'PENDING'` hides it until sync publishes it.
 */
export async function loadNdjson(db: DB, file: string, opts: { repoPath?: string; publish?: boolean; state?: 'PENDING' } = {}): Promise<LoadResult> {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let snapshot: SnapshotRecord | undefined;
  const nodes: NodeRecord[] = [];
  const edges: EdgeRecord[] = [];
  const diags: Array<{ severity: string; code: string; message: string; filePath?: string; line?: number }> = [];
  let lineNo = 0;
  for await (const raw of rl) {
    lineNo++;
    if (!raw.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`${file}:${lineNo}: not JSON`);
    }
    const type = (json as { type?: string }).type;
    if (lineNo === 1 && type !== 'snapshot') throw new Error(`${file}: first line must be a snapshot record`);
    const parsed =
      type === 'snapshot' ? snapshotRecord.safeParse(json)
      : type === 'node' ? nodeRecord.safeParse(json)
      : type === 'edge' ? edgeRecord.safeParse(json)
      : type === 'diagnostic' ? diagnosticRecord.safeParse(json)
      : null;
    if (!parsed) throw new Error(`${file}:${lineNo}: unknown record type ${String(type)}`);
    if (!parsed.success) throw new Error(`${file}:${lineNo}: invalid ${type}: ${parsed.error.message}`);
    if (type === 'snapshot') snapshot = parsed.data as SnapshotRecord;
    else if (type === 'node') nodes.push(parsed.data as NodeRecord);
    else if (type === 'edge') edges.push(parsed.data as EdgeRecord);
    else diags.push(parsed.data as (typeof diags)[number]);
  }
  if (!snapshot) throw new Error(`${file}: empty file`);
  const major = Number(snapshot.schemaVersion.split('.')[0]);
  if (major !== SUPPORTED_SCHEMA_MAJOR) {
    throw new Error(`${file}: schema ${snapshot.schemaVersion} not supported (expected ${SUPPORTED_SCHEMA_MAJOR}.x)`);
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  const dangling = edges.filter((e) => !nodeIds.has(e.src) || !nodeIds.has(e.dst));
  if (dangling.length) throw new Error(`${file}: ${dangling.length} edge(s) reference unknown nodes, e.g. ${dangling[0]!.id}`);

  const snap = snapshot;
  const scopeJson = JSON.stringify(snap.scope ?? {});
  const tx = db.transaction(() => {
    const prev = db
      .prepare("SELECT id FROM snapshots WHERE repo_id = ? AND commit_sha = ? AND scope_json = ? AND COALESCE(source_mode, '') = ?")
      .get(snap.repoId, snap.commitSha, scopeJson, snap.sourceMode ?? '') as { id: number } | undefined;
    const wasCurrent = !!prev && !!db.prepare('SELECT 1 FROM current_snapshots WHERE snapshot_id = ?').get(prev.id);
    if (prev && opts.state === 'PENDING') throw new Error(`${file}: already loaded as snapshot ${prev.id}`);
    if (prev) {
      db.prepare('DELETE FROM current_snapshots WHERE snapshot_id = ?').run(prev.id);
      db.prepare('DELETE FROM nodes_fts WHERE snapshot_id = ?').run(prev.id);
      db.prepare('DELETE FROM snapshots WHERE id = ?').run(prev.id);
    }
    const info = db
      .prepare(
        `INSERT INTO snapshots (repo_id, commit_sha, repo_path, source_mode, schema_version, analyzer_version, engine,
           started_at, finished_at, loaded_at, scope_json, stats_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snap.repoId, snap.commitSha, opts.repoPath ?? snap.repoPath ?? null, snap.sourceMode ?? null, snap.schemaVersion,
        snap.analyzerVersion, snap.engine, snap.startedAt, snap.finishedAt, new Date().toISOString(), scopeJson,
        JSON.stringify(snap.stats ?? {}),
      );
    const sid = Number(info.lastInsertRowid);
    const insNode = db.prepare(
      `INSERT INTO nodes (snapshot_id, id, kind, name, fqn, signature, module, package, file_path, line_start, line_end, in_scope, attrs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insFts = db.prepare('INSERT INTO nodes_fts (snapshot_id, node_id, kind, name, terms, file_path) VALUES (?, ?, ?, ?, ?, ?)');
    for (const n of nodes) {
      insNode.run(sid, n.id, n.kind, n.name, n.fqn ?? null, n.signature ?? null, n.module ?? null, n.package ?? null,
        n.filePath ?? null, n.lineStart ?? null, n.lineEnd ?? null, n.inScope === false ? 0 : 1, JSON.stringify(n.attrs ?? {}));
      if (n.kind !== 'UNRESOLVED' && n.kind !== 'SQL_STATEMENT') {
        insFts.run(sid, n.id, n.kind, n.name, searchTerms(n.name, n.fqn, n.signature), n.filePath ?? '');
      }
    }
    const insEdge = db.prepare(
      `INSERT INTO edges (snapshot_id, id, kind, src, dst, resolution, evidence_json, attrs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of edges) {
      insEdge.run(sid, e.id, e.kind, e.src, e.dst, e.resolution, JSON.stringify(e.evidence), JSON.stringify(e.attrs ?? {}));
    }
    const insDiag = db.prepare('INSERT INTO diagnostics (snapshot_id, severity, code, message, file_path, line) VALUES (?, ?, ?, ?, ?, ?)');
    for (const d of diags) insDiag.run(sid, d.severity, d.code, d.message, d.filePath ?? null, d.line ?? null);
    if (opts.state === 'PENDING') markPending(db, sid);
    else if (opts.publish || wasCurrent) setCurrent(db, snap.repoId, sid, opts.publish ? 'load' : 'load (replaced)');
    return { sid, replaced: Boolean(prev) };
  });
  const { sid, replaced } = tx();
  return { snapshotId: sid, repoId: snap.repoId, commitSha: snap.commitSha, nodes: nodes.length, edges: edges.length, diagnostics: diags.length, replaced };
}
