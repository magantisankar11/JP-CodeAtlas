import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db.js';
import { analyzeImpact, type SnapshotInfo } from '../impact/engine.js';
import type { ChangeSummary, ImpactReport, Risk, Unknown } from '../impact/types.js';
import { loadNdjson } from '../loader.js';
import { combineGraphs } from '../multi/combine.js';
import { resolveSnapshot } from '../query.js';
import { redact, reposOf, type RepoRef } from '../source.js';
import {
  callChanges, endpointChanges, fieldChanges, mapChanges, uiLinkChanges, type ChangedNode, type RepoSide,
} from './changeset.js';
import { diffChange, resolveChange, type FileChange, type ResolvedChange } from './git.js';
import { ensureGraph, readSnapshotLine, type RepoKind } from './index.js';

/**
 * Change-based impact: what a branch, commit, range or the working tree changes, and who depends on it.
 *
 *  1. resolve each repository's change spec to base and head (git.ts), unchanged repositories stay at the commit of
 *     the current snapshot
 *  2. graphs of base and head per repository, reused from earlier runs when possible (index.ts)
 *  3. for system snapshots, base and head system graphs (UI → API links recomputed on each side)
 *  4. changed lines → nodes on both sides, contract differences, UI link differences (changeset.ts)
 *  5. impact of everything that existed before the change (its dependents are what can break), computed on the base
 *     graph; when the change only adds code, on the head graph
 * Repositories are only read (git diff / archive / cat-file / show); nothing is checked out.
 */
export interface ChangeRequest { core?: string; ui?: string; coreBase?: string; uiBase?: string; basePatterns?: string[] }
export interface ChangeRunOptions {
  jciRoot: string; graphDirs: string[]; cacheDir: string; db: DB; log: (m: string) => void;
  upstreamDepth?: number; downstreamDepth?: number; gatesFile?: string;
}
export interface ChangeRunResult {
  report: ImpactReport | null;
  change: ChangeSummary;
  snap: SnapshotInfo;
  patch: string;
  note?: string;
}

interface RepoPlan {
  ref: RepoRef; kind: RepoKind; side: 'core' | 'ui'; spec: string | null;
  resolved: ResolvedChange | null; baseSha: string; headSha: string; files: FileChange[]; outside: FileChange[]; patch: string;
}

const defaultRoots = (r: RepoRef, kind: RepoKind, scope: Record<string, unknown>) => {
  if (kind === 'ui') return r.sourceRoots?.length ? r.sourceRoots : ['src', 'test'];
  const schema = Array.isArray(scope.schemaDirs) ? (scope.schemaDirs as string[]) : [];
  return [...new Set([...(r.sourceRoots?.length ? r.sourceRoots : ['src/main/java']), ...schema, 'src/main/resources'])];
};

/** Id of the snapshot already loaded from this graph (same repo, commit, scope and mode), if any. */
export function loadedSnapshot(db: DB, file: string): number | null {
  const s = readSnapshotLine(file);
  if (!s || s.sourceMode === 'WORKTREE') return null;
  const row = db.prepare(`SELECT id FROM snapshots WHERE repo_id = ? AND commit_sha = ? AND scope_json = ? AND COALESCE(source_mode, '') = ?`)
    .get(s.repoId, s.commitSha, JSON.stringify(s.scope ?? {}), s.sourceMode ?? '') as { id: number } | undefined;
  return row?.id ?? null;
}

async function loadOnce(db: DB, file: string, log: (m: string) => void): Promise<number> {
  const id = loadedSnapshot(db, file);
  if (id !== null) return id;
  const t0 = Date.now();
  const r = await loadNdjson(db, file);
  log(`  loaded ${r.repoId}@${r.commitSha.slice(0, 10)} (${r.nodes} nodes) in ${Math.round((Date.now() - t0) / 1000)} s`);
  return r.snapshotId;
}

export async function analyzeChanges(current: SnapshotInfo, req: ChangeRequest, opts: ChangeRunOptions): Promise<ChangeRunResult> {
  const repos = reposOf(current);
  const system = repos.length > 1;
  const coreRef = repos.find((r) => !r.pathPrefix)!;
  const uiRef = repos.find((r) => r.pathPrefix && (r.role === 'frontend' || r.repoId.includes('ui')));
  const primaryKind: RepoKind = String(current.analyzerVersion ?? '').startsWith('ui-') ? 'ui' : 'java';
  if (!req.core && !req.ui) throw new Error('Nothing to analyse: pass --core and/or --ui with a branch, commit, range or "working"');
  if (req.ui && !uiRef && primaryKind !== 'ui') throw new Error(`Snapshot ${current.repoId} has no UI repository; load a system snapshot (npm run combine) to analyse UI changes`);

  const plans: RepoPlan[] = [];
  const plan = (ref: RepoRef, kind: RepoKind, side: 'core' | 'ui', spec: string | undefined, baseOverride: string | undefined) => {
    if (!ref.repoPath) throw new Error(`Repository ${ref.repoId} has no path in the snapshot`);
    if (!spec) {
      plans.push({ ref, kind, side, spec: null, resolved: null, baseSha: ref.commitSha, headSha: ref.commitSha, files: [], outside: [], patch: '' });
      return;
    }
    opts.log(`${ref.repoId}: resolving ${spec}`);
    const resolved = resolveChange(ref.repoPath, spec, { baseOverride, basePatterns: req.basePatterns });
    opts.log(`  base ${resolved.baseSha.slice(0, 10)} (${resolved.base.how}), head ${resolved.headSha?.slice(0, 10) ?? 'working tree'}, ${resolved.commits.length} commit(s)`);
    const d = diffChange(ref.repoPath, resolved, defaultRoots(ref, kind, current.scope));
    plans.push({ ref, kind, side, spec, resolved, baseSha: resolved.baseSha, headSha: resolved.headSha ?? 'WORKTREE', ...d });
  };
  if (primaryKind === 'ui') plan(coreRef, 'ui', 'ui', req.ui ?? req.core, req.uiBase ?? req.coreBase);
  else {
    plan(coreRef, 'java', 'core', req.core, req.coreBase);
    if (uiRef) plan(uiRef, 'ui', 'ui', req.ui, req.uiBase);
  }

  // Graphs of each side.
  const idx = { jciRoot: opts.jciRoot, graphDirs: opts.graphDirs, cacheDir: opts.cacheDir, log: opts.log };
  opts.log('graphs:');
  const graphs = plans.map((p) => {
    const base = ensureGraph(p.kind, p.ref.repoPath!, p.ref.repoId, p.baseSha, idx);
    const head = p.headSha === p.baseSha ? base : ensureGraph(p.kind, p.ref.repoPath!, p.ref.repoId, p.headSha, idx);
    return { p, base, head };
  });
  let baseFile = graphs[0]!.base.file;
  let headFile = graphs[0]!.head.file;
  if (system && graphs.length === 2) {
    const [c, u] = graphs as [typeof graphs[0], typeof graphs[0]];
    const sys = async (cf: string, uf: string, key: string, reusable: boolean) => {
      const out = join(opts.cacheDir, `system-${key}.ndjson`);
      if (!(reusable && existsSync(out))) {
        mkdirSync(opts.cacheDir, { recursive: true });
        await combineGraphs(cf, uf, out, { systemId: current.repoId });
      }
      return out;
    };
    baseFile = await sys(c.base.file, u.base.file, `${c.p.baseSha.slice(0, 12)}-${u.p.baseSha.slice(0, 12)}`, true);
    const headWt = c.p.headSha === 'WORKTREE' || u.p.headSha === 'WORKTREE';
    headFile = await sys(c.head.file, u.head.file, `${c.p.headSha.slice(0, 12)}-${u.p.headSha.slice(0, 12)}`, !headWt);
  }
  const baseSid = await loadOnce(opts.db, baseFile, opts.log);
  const headSid = headFile === baseFile ? baseSid : await loadOnce(opts.db, headFile, opts.log);
  const baseSnap = resolveSnapshot(opts.db, baseSid)!;
  const headSnap = resolveSnapshot(opts.db, headSid)!;
  const nodeCount = (sid: number) => (opts.db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE snapshot_id = ?').get(sid) as { n: number }).n;
  opts.log(`  base snapshot ${baseSid} (${nodeCount(baseSid)} nodes), head snapshot ${headSid} (${nodeCount(headSid)} nodes)`);

  // What changed.
  const prefixOf = (p: RepoPlan) => (system && p.side === 'ui' ? (uiRef?.pathPrefix ?? '') : '');
  const sides: RepoSide[] = plans.filter((p) => p.spec).map((p) => ({ repoId: p.ref.repoId, pathPrefix: prefixOf(p), isUi: p.kind === 'ui', files: p.files }));
  const mapped = mapChanges(opts.db, baseSid, headSid, sides);
  const changedFiles = [...new Set(plans.flatMap((p) => p.files.flatMap((f) => [f.oldPath, f.newPath]).filter(Boolean).map((x) => prefixOf(p) + x!)))];
  const endpoints = endpointChanges(opts.db, baseSid, headSid);
  const { types, tables } = fieldChanges(opts.db, baseSid, headSid, changedFiles);
  const calls = callChanges(opts.db, baseSid, headSid, mapped.nodes);
  const uiLinks = system ? uiLinkChanges(opts.db, baseSid, headSid) : [];

  const change: ChangeSummary = {
    analysedOn: 'base',
    repos: plans.map((p) => ({
      repoId: p.ref.repoId, role: p.ref.role, spec: p.spec, mode: p.resolved ? p.resolved.mode : 'unchanged',
      baseSha: p.baseSha, headSha: p.headSha === 'WORKTREE' ? null : p.headSha,
      base: p.resolved?.base ?? { ref: 'current snapshot', how: 'unchanged' }, alternatives: p.resolved?.alternatives ?? [], commits: p.resolved?.commits ?? [],
      files: p.files.map((f) => ({ path: f.newPath ?? f.oldPath!, status: f.status, added: f.added, removed: f.removed,
        mappedNodes: mapped.mappedPerFile.get(prefixOf(p) + (f.newPath ?? f.oldPath)) ?? 0 })),
      outsideRoots: p.outside.map((f) => f.newPath ?? f.oldPath!),
    })),
    nodes: mapped.nodes, endpoints, types, tables, calls, uiLinks, unmappedHunks: mapped.unmapped.slice(0, 200),
  };
  const patch = plans.filter((p) => p.patch).map((p) => `# ${p.ref.repoId}: ${p.spec} (${p.baseSha.slice(0, 12)}..${p.headSha.slice(0, 12)})\n${redact(p.patch)}`).join('\n');

  // Impact targets: whatever existed before the change.
  const inBase = (id: string) => Boolean(opts.db.prepare('SELECT 1 FROM nodes WHERE snapshot_id = ? AND id = ?').get(baseSid, id));
  const baseTargets = [...new Set([
    ...mapped.nodes.filter((n) => n.change !== 'ADDED').map((n) => n.id),
    ...endpoints.filter((e) => e.change !== 'ADDED').map((e) => e.id),
    ...types.map((t) => t.id), ...tables.map((t) => t.id),
  ])].filter(inBase);
  const headTargets = [...new Set([...mapped.nodes.filter((n) => n.change !== 'REMOVED').map((n) => n.id), ...endpoints.filter((e) => e.change === 'ADDED').map((e) => e.id)])];
  let snap: SnapshotInfo = baseSnap;
  let targets = baseTargets;
  if (!targets.length && headTargets.length) {
    snap = headSnap;
    targets = headTargets;
    change.analysedOn = 'head';
  }
  if (!targets.length) {
    return { report: null, change, snap, patch, note: 'The change touches no indexed declaration (only imports, comments, or files outside the analysed roots).' };
  }
  opts.log(`impact of ${targets.length} changed item(s) on the ${change.analysedOn} graph…`);
  const report = analyzeImpact(opts.db, snap, { targets, upstreamDepth: opts.upstreamDepth, downstreamDepth: opts.downstreamDepth }, opts.gatesFile);
  report.change = change;
  report.risks.unshift(...changeRisks(change));
  report.unknowns.push(...changeUnknowns(change, plans));
  return { report, change, snap, patch };
}

function changeRisks(c: ChangeSummary): Risk[] {
  const risks: Risk[] = [];
  const at = (x: { id?: string; file: string | null; line: number | null }) => ({ nodeId: x.id, file: x.file, line: x.line });
  const lost = c.uiLinks.filter((u) => u.change === 'LINK_LOST');
  if (lost.length) {
    risks.push({ id: 'R-CHANGE-UI-LINK-LOST', category: 'CHANGE', classification: 'CONFIRMED_DEPENDENCY',
      title: `${lost.length} UI call(s) no longer match any Core endpoint after the change`,
      detail: lost.slice(0, 15).map((u) => `${u.name} (was ${u.before.map((e) => e.replace('endpoint:', '')).join(', ')})`).join('; '),
      evidence: lost.slice(0, 20).map((u) => ({ nodeId: u.call, file: u.file, line: u.line })) });
  }
  const gone = c.endpoints.filter((e) => e.change === 'REMOVED' || e.change === 'MOVED');
  if (gone.length) {
    risks.push({ id: 'R-CHANGE-ENDPOINTS', category: 'CHANGE', classification: 'CONFIRMED_DEPENDENCY',
      title: `${gone.length} endpoint(s) removed or moved`,
      detail: gone.map((e) => (e.change === 'MOVED' ? `${e.name} → ${e.to}` : `${e.name} removed`)).join('; ') + '. Every client of the old path (UI, add-ins, integrations) must change with it.',
      evidence: gone.map(at) });
  }
  const contract = c.endpoints.filter((e) => e.change === 'CONTRACT_CHANGED');
  if (contract.length) {
    risks.push({ id: 'R-CHANGE-ENDPOINT-CONTRACT', category: 'CHANGE', classification: 'CONFIRMED_DEPENDENCY',
      title: `${contract.length} endpoint(s) changed their request/response contract or security rule`,
      detail: contract.map((e) => `${e.name}: ${e.fields?.join(', ')}`).join('; '), evidence: contract.map(at) });
  }
  const fields = c.types.filter((t) => t.removed.length || t.retyped.length);
  if (fields.length) {
    risks.push({ id: 'R-CHANGE-FIELDS', category: 'CHANGE', classification: 'CONFIRMED_DEPENDENCY',
      title: `${fields.length} type(s) removed or retyped fields`,
      detail: fields.map((t) => `${t.name}: ${[...t.removed.map((f) => `-${f}`), ...t.retyped].join(', ')}`).join('; ') + '. Serialized payloads and mappers using these fields change.',
      evidence: fields.map(at) });
  }
  const schema = c.tables.filter((t) => t.removed.length || t.retyped.length);
  if (schema.length) {
    risks.push({ id: 'R-CHANGE-SCHEMA', category: 'CHANGE', classification: 'CONFIRMED_DEPENDENCY',
      title: `${schema.length} table(s) lost or retyped columns`,
      detail: schema.map((t) => `${t.name}: ${[...t.removed.map((f) => `-${f}`), ...t.retyped].join(', ')}`).join('; ') + '. Native SQL and entities reading these columns must change in the same release.',
      evidence: schema.map(at) });
  }
  const sig = c.nodes.filter((n) => n.change === 'SIGNATURE_CHANGED' && n.pairedWith);
  if (sig.length) {
    risks.push({ id: 'R-CHANGE-SIGNATURES', category: 'CHANGE', classification: 'CONFIRMED_DEPENDENCY',
      title: `${sig.length / 2} method signature(s) changed`,
      detail: 'Callers of the old signatures are listed under upstream callers; each must be updated.', evidence: sig.filter((n) => n.id < n.pairedWith!).map((n) => ({ nodeId: n.id, file: n.file, line: n.line })) });
  }
  return risks;
}

function changeUnknowns(c: ChangeSummary, plans: RepoPlan[]): Unknown[] {
  const out: Unknown[] = [];
  const unmapped = c.unmappedHunks.filter((h) => !/\.(md|txt)$/i.test(h.file));
  if (unmapped.length) {
    out.push({ kind: 'CHANGE_UNMAPPED_LINES', detail: `${unmapped.length} changed line range(s) lie outside every indexed declaration (imports, comments, resources); e.g. ${unmapped.slice(0, 3).map((h) => `${h.file}:${h.from}`).join(', ')}`, file: unmapped[0]!.file, line: unmapped[0]!.from });
  }
  for (const r of c.repos) {
    if (r.outsideRoots.length) out.push({ kind: 'CHANGE_OUTSIDE_ROOTS', detail: `${r.repoId}: ${r.outsideRoots.length} changed file(s) outside the analysed source roots were not mapped (${r.outsideRoots.slice(0, 5).join(', ')})`, file: null, line: null });
    if (r.mode === 'worktree') out.push({ kind: 'CHANGE_WORKTREE', detail: `${r.repoId}: uncommitted changes; head line numbers refer to the working tree at analysis time`, file: null, line: null });
    // A branch with several commits may have been compared against the wrong integration branch: say which was used.
    if (r.alternatives.length && r.commits.length > 1) {
      out.push({ kind: 'CHANGE_BASE_CHOICE', detail: `${r.repoId}: base chosen as ${r.base.ref} (${r.commits.length} commits); pass --${r.role === 'frontend' ? 'ui' : 'core'}-base to compare against another branch`, file: null, line: null });
    }
  }
  const keys = new Set(plans.flatMap((p) => (p.resolved?.commits ?? []).flatMap((m) => m.subject.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [])));
  if (keys.size > 1) out.push({ kind: 'CHANGE_MIXED_TICKETS', detail: `The compared commits mention several tickets (${[...keys].slice(0, 8).join(', ')}); check that the base is right`, file: null, line: null });
  return out;
}

export type { ChangedNode };
