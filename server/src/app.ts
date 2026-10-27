import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import type { DB } from './db.js';
import { API_VERSION, RESOLUTIONS } from './contract.js';
import {
  catalog, diagnostics, endpoints, getNode, isIndexedFile, listSnapshots, nodeEdges, reach, resolveSnapshot, search, traverse, MAX_DEPTH, MAX_NODES,
  PRESETS,
} from './query.js';
import { excerpt, locate } from './source.js';
import { installRequestGuard, type GuardOptions } from './security.js';
import { buildContextBundle } from './impact/bundle.js';
import { matchDefect, rootCauseCandidates } from './impact/defect.js';
import { analyzeImpact } from './impact/engine.js';
import { attachFreshness } from './impact/freshness.js';
import { cachedSnapshotStatus, checkFreshness, FreshnessInputError } from './freshness.js';

const snapshotParams = z.object({
  snapshot: z.coerce.number().int().positive().optional(),
  repo: z.string().optional(),
});
const csv = z.string().optional().transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []));

/** Read-only API, schema version {@link API_VERSION}. Every response names the snapshot (repo + commit) it came from. */
export function buildApp(db: DB, opts: { logger?: boolean; security?: GuardOptions } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  // Always on: options only widen the allowed Origin list.
  installRequestGuard(app, opts.security);

  const withSnapshot = (query: unknown, reply: FastifyReply) => {
    const p = snapshotParams.safeParse(query);
    if (!p.success) {
      void reply.code(400).send({ error: p.error.message });
      return undefined;
    }
    const snap = resolveSnapshot(db, p.data.snapshot, p.data.repo);
    if (!snap) {
      void reply.code(404).send({ error: 'No snapshot loaded. Run the analyzer and `npm run load`.' });
      return undefined;
    }
    // Advisory freshness of the served snapshot against HEAD, from the cache only (never runs git on this request).
    void reply.header('x-jci-snapshot-status', cachedSnapshotStatus(db, snap));
    return snap;
  };
  const envelope = (snap: { id: number; repoId: string; commitSha: string }, data: unknown) => ({
    apiVersion: API_VERSION,
    snapshot: { id: snap.id, repoId: snap.repoId, commitSha: snap.commitSha },
    data,
  });

  app.get('/api/v1/health', async () => ({ ok: true, apiVersion: API_VERSION }));

  // repoPath is included for "open in editor" links; the API only listens on loopback and rejects foreign Host/Origin (security.ts).
  app.get('/api/v1/snapshots', async () => ({ apiVersion: API_VERSION, data: listSnapshots(db) }));

  app.get('/api/v1/search', async (req, reply) => {
    const snap = withSnapshot(req.query, reply);
    if (!snap) return reply;
    const q = z.object({ q: z.string().min(1).max(200), kinds: csv, limit: z.coerce.number().int().min(1).max(100).default(30) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    return envelope(snap, search(db, snap.id, q.data.q, q.data.kinds, q.data.limit));
  });

  app.get('/api/v1/endpoints', async (req, reply) => {
    const snap = withSnapshot(req.query, reply);
    if (!snap) return reply;
    const q = z.object({ method: z.string().optional(), q: z.string().optional() }).parse(req.query);
    return envelope(snap, endpoints(db, snap.id, q));
  });

  app.get('/api/v1/node', async (req, reply) => {
    const snap = withSnapshot(req.query, reply);
    if (!snap) return reply;
    const q = z.object({ id: z.string().min(1) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    const node = getNode(db, snap.id, q.data.id);
    if (!node) return reply.code(404).send({ error: `Unknown node ${q.data.id}` });
    return envelope(snap, { node, ...nodeEdges(db, snap.id, q.data.id) });
  });

  app.get('/api/v1/graph', async (req, reply) => {
    const snap = withSnapshot(req.query, reply);
    if (!snap) return reply;
    const q = z.object({
      root: z.string().min(1),
      direction: z.enum(['forward', 'reverse']).default('forward'),
      depth: z.coerce.number().int().min(0).max(MAX_DEPTH).default(3),
      preset: z.enum(Object.keys(PRESETS) as [string, ...string[]]).optional(),
      edgeKinds: csv,
      minResolution: z.enum(RESOLUTIONS).default('UNRESOLVED'),
      includeAccessors: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
      collapseDispatch: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
      limit: z.coerce.number().int().min(1).max(MAX_NODES).default(150),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    const edgeKinds = q.data.edgeKinds.length ? q.data.edgeKinds : q.data.preset ? PRESETS[q.data.preset] : undefined;
    const result = traverse(db, snap.id, { ...q.data, edgeKinds });
    if (!result) return reply.code(404).send({ error: `Unknown node ${q.data.root}` });
    return envelope(snap, result);
  });

  app.get('/api/v1/source', async (req, reply) => {
    const snap = withSnapshot(req.query, reply);
    if (!snap) return reply;
    const q = z.object({
      file: z.string().min(1),
      from: z.coerce.number().int().min(1),
      to: z.coerce.number().int().min(1).optional(),
      context: z.coerce.number().int().min(0).max(50).default(3),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    if (!isIndexedFile(db, snap.id, q.data.file)) return reply.code(404).send({ error: 'File is not part of this snapshot' });
    const { repo, path } = locate(snap, q.data.file);
    if (!repo.repoPath) return reply.code(409).send({ error: `Repository ${repo.repoId} has no path; reload with --repo-path` });
    try {
      const ex = excerpt(repo.repoPath, repo.commitSha, path, q.data.from, q.data.to ?? q.data.from, q.data.context, repo.sourceMode === 'WORKTREE');
      return envelope(snap, { ...ex, filePath: q.data.file, repoId: repo.repoId });
    } catch (e) {
      return reply.code(500).send({ error: `Could not read ${q.data.file} at ${repo.commitSha}: ${(e as Error).message}` });
    }
  });

  app.get('/api/v1/catalog', async (req, reply) => {
    const snap = withSnapshot(req.query, reply);
    if (!snap) return reply;
    const q = z.object({
      kind: z.string().optional(),
      entryPoints: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
      q: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(5000).default(500),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    if (!q.data.kind && !q.data.entryPoints) return reply.code(400).send({ error: 'kind or entryPoints=true required' });
    return envelope(snap, catalog(db, snap.id, q.data));
  });

  app.get('/api/v1/presets', async () => ({ apiVersion: API_VERSION, data: PRESETS }));

  // Snapshot accuracy, branch currency, remote currency and working tree per repository (freshness.ts).
  app.get('/api/v1/freshness', async (req, reply) => {
    const snap = withSnapshot(req.query, reply);
    if (!snap) return reply;
    const raw = req.query as Record<string, unknown>;
    const q = z.object({
      remote: z.enum(['cached', 'live']).default('cached'),
      refresh: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    }).safeParse(raw);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    const revs: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith('rev.')) continue;
      if (typeof v !== 'string') return reply.code(400).send({ error: `${k} must be given once` });
      revs[k.slice(4)] = v;
    }
    try {
      return envelope(snap, await checkFreshness(db, snap, { revs, remote: q.data.remote, refresh: q.data.refresh }));
    } catch (e) {
      if (e instanceof FreshnessInputError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  // ---------------------------------------------------------------- Phase 3: defect matching, impact, context bundle
  const impactBody = z.object({
    targets: z.array(z.string().min(1)).max(20).default([]),
    defectText: z.string().max(200_000).optional(),
    upstreamDepth: z.number().int().min(1).max(MAX_DEPTH).optional(),
    downstreamDepth: z.number().int().min(1).max(MAX_DEPTH).optional(),
    title: z.string().max(200).optional(),
  });
  const runImpact = (snap: NonNullable<ReturnType<typeof resolveSnapshot>>, b: z.infer<typeof impactBody>) => {
    const match = b.defectText ? matchDefect(db, snap, b.defectText) : undefined;
    const report = analyzeImpact(db, snap, {
      targets: b.targets, upstreamDepth: b.upstreamDepth, downstreamDepth: b.downstreamDepth, rootCauses: match ? rootCauseCandidates(match) : undefined,
    });
    return { match, report };
  };

  app.post('/api/v1/defect/match', async (req, reply) => {
    const snap = withSnapshot(req.query, reply);
    if (!snap) return reply;
    const b = z.object({ text: z.string().min(1).max(200_000) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.message });
    return envelope(snap, matchDefect(db, snap, b.data.text));
  });

  app.post('/api/v1/impact', async (req, reply) => {
    const snap = withSnapshot(req.query, reply);
    if (!snap) return reply;
    const b = impactBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.message });
    if (!b.data.targets.length) return reply.code(400).send({ error: 'targets required' });
    let result;
    try {
      result = runImpact(snap, b.data);
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
    attachFreshness(result.report, await checkFreshness(db, snap));
    return envelope(snap, result.report);
  });

  app.post('/api/v1/export/context', async (req, reply) => {
    const snap = withSnapshot(req.query, reply);
    if (!snap) return reply;
    const b = impactBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.message });
    if (!b.data.targets.length) return reply.code(400).send({ error: 'targets required' });
    let result;
    try {
      result = runImpact(snap, b.data);
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
    const { match, report } = result;
    attachFreshness(report, await checkFreshness(db, snap));
    const title = b.data.title ?? report.targets.map((t) => t.name).join(', ');
    return envelope(snap, { files: buildContextBundle(db, snap, report, { title, defectText: b.data.defectText, match }) });
  });

  app.get('/api/v1/reach', async (req, reply) => {
    const snap = withSnapshot(req.query, reply);
    if (!snap) return reply;
    const q = z.object({
      root: z.string().min(1),
      depth: z.coerce.number().int().min(1).max(MAX_DEPTH).default(8),
      preset: z.enum(Object.keys(PRESETS) as [string, ...string[]]).default('flow'),
      minResolution: z.enum(RESOLUTIONS).default('UNRESOLVED'),
      includeAccessors: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    const result = reach(db, snap.id, { ...q.data, edgeKinds: PRESETS[q.data.preset], collapseDispatch: false });
    if (!result) return reply.code(404).send({ error: `Unknown node ${q.data.root}` });
    return envelope(snap, result);
  });

  app.get('/api/v1/diagnostics', async (req, reply) => {
    const snap = withSnapshot(req.query, reply);
    if (!snap) return reply;
    const q = z.object({ code: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
    return envelope(snap, diagnostics(db, snap.id, q.code, q.limit));
  });

  return app;
}
