import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DB } from '../db.js';
import { SUPPORTED_SCHEMA_MAJOR } from '../contract.js';
import { safeRev, sha } from '../changes/git.js';
import { ensureGraph, findGraph, javaExecutable, lastLineComplete, readSnapshotLine, type GraphRef, type IndexOptions } from '../changes/index.js';
import { loadedSnapshot } from '../changes/run.js';
import { checkFreshness } from '../freshness.js';
import { summarizeFreshness } from '../impact/freshness.js';
import type { FreshnessSummary } from '../impact/types.js';
import { loadNdjson } from '../loader.js';
import { combineGraphs, VERSION as STITCH_VERSION } from '../multi/combine.js';
import { resolveSnapshot } from '../query.js';
import { currentSnapshotId, dropPending, isPending, pendingSnapshotIds, publishSnapshot } from '../snapshots.js';
import { detectRepos, SyncConfigError, type RepoKind, type SyncConfig } from './config.js';
import { acquireLock, SyncLockedError, type LockHandle } from './lock.js';
import { validateSnapshot, type Check } from './validate.js';

/**
 * `npm run sync`: bring the current snapshot up to date with the selected revisions (default HEAD) of the configured
 * repositories. Steps: detect repositories → resolve revisions → reuse graphs → re-index changed repositories →
 * recombine → load as PENDING → validate → publish atomically. On any failure the previously current snapshot stays
 * current and the PENDING snapshot is removed. Read-only against the repositories: never fetches, never checks out.
 */
export class SyncInputError extends Error {}

export type SyncOutcome = 'PUBLISHED' | 'UP_TO_DATE' | 'FAILED' | 'DRY_RUN';
export type RepoAction = 'UNCHANGED' | 'REUSED' | 'INDEXED' | 'WOULD_REUSE' | 'WOULD_INDEX';
export type SyncStep = 'lock' | 'detect' | 'resolve' | 'index' | 'combine' | 'load' | 'validate' | 'publish';

export interface RepoResult {
  repoId: string; kind: RepoKind; path: string; rev: string; commit: string | null; action: RepoAction | null;
  graphFile: string | null; analyzerVersion: string | null; expectedVersion: string | null; durationMs: number; reason: string;
}
export interface SyncReport {
  outcome: SyncOutcome;
  startedAt: string; finishedAt: string; durationMs: number;
  config: { source: SyncConfig['source']; file: string | null; publishId: string } | null;
  repos: RepoResult[];
  combine: { file: string; reused: boolean; durationMs: number; stitch: unknown } | null;
  load: { snapshotId: number; reused: boolean; nodes: number | null; edges: number | null; durationMs: number } | null;
  validation: Check[];
  publish: { previous: number | null; current: number } | null;
  current: number | null;
  freshness: FreshnessSummary | null;
  cleanedPending: number[];
  warnings: string[];
  error: { step: SyncStep; message: string } | null;
}

export interface SyncOptions {
  db: DB;
  jciRoot: string;
  graphDirs: string[];
  cacheDir: string;
  /** Lock and report files (workspace/sync). */
  stateDir: string;
  configFile: string;
  revs?: Record<string, string>;
  /** Repository ids to re-index even when a graph exists; 'all' for every repository. */
  reindex?: string[];
  dryRun?: boolean;
  maxShrink?: number;
  allowShrink?: boolean;
  log?: (m: string) => void;
  /** Injection points for tests. */
  indexer?: (kind: RepoKind, repoPath: string, repoId: string, commit: string, opts: IndexOptions) => GraphRef;
  versions?: Partial<Record<RepoKind, string | null>>;
  afterLoad?: (snapshotId: number) => void | Promise<void>;
  freshness?: boolean;
}

/** Version the installed Java analyzer writes into graphs (`java -jar … version`); null when unknown. */
export function javaAnalyzerVersion(jciRoot: string, warnings: string[]): string | null {
  const jar = join(jciRoot, 'analyzer-java', 'target', 'jci-analyzer.jar');
  if (!existsSync(jar)) {
    warnings.push(`${jar} not found; build it with npm run build:analyzer`);
    return null;
  }
  const newest = newestMtime(join(jciRoot, 'analyzer-java', 'src', 'main'));
  if (newest > statSync(jar).mtimeMs) warnings.push('the Java analyzer jar is older than its sources; rebuild it with npm run build:analyzer');
  const r = spawnSync(javaExecutable(), ['-jar', jar, 'version'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const v = r.status === 0 ? r.stdout.trim() : '';
  if (!/^[\w.+-]{1,40}$/.test(v)) {
    warnings.push('the Java analyzer jar does not report its version (built before Phase C?); rebuild it with npm run build:analyzer');
    return null;
  }
  return v;
}

export function uiAnalyzerVersion(jciRoot: string): string | null {
  const f = join(jciRoot, 'analyzer-ui', 'src', 'version.ts');
  return existsSync(f) ? /VERSION\s*=\s*'([^']+)'/.exec(readFileSync(f, 'utf8'))?.[1] ?? null : null;
}

function newestMtime(dir: string): number {
  let max = 0;
  if (!existsSync(dir)) return max;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    max = Math.max(max, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return max;
}

const schemaOk = (s: any) => Number(String(s?.schemaVersion ?? '').split('.')[0]) === SUPPORTED_SCHEMA_MAJOR;

class StepError extends Error {
  constructor(readonly step: SyncStep, message: string) {
    super(message);
  }
}

export async function syncGraphs(o: SyncOptions): Promise<SyncReport> {
  const t0 = Date.now();
  const log = o.log ?? (() => {});
  const report: SyncReport = {
    outcome: 'FAILED', startedAt: new Date(t0).toISOString(), finishedAt: '', durationMs: 0, config: null, repos: [], combine: null, load: null,
    validation: [], publish: null, current: null, freshness: null, cleanedPending: [], warnings: [], error: null,
  };
  const { db } = o;
  let lock: LockHandle | null = null;
  let pendingId: number | null = null;
  let step: SyncStep = 'lock';
  try {
    // ---- 0. one sync at a time; remove what an interrupted sync left PENDING (never published, never visible)
    if (!o.dryRun) {
      lock = acquireLock(join(o.stateDir, 'sync.lock'));
      if (lock.tookOverFrom) report.warnings.push(`took over a stale lock from pid ${lock.tookOverFrom.pid} (started ${lock.tookOverFrom.startedAt})`);
      for (const id of pendingSnapshotIds(db)) {
        dropPending(db, id);
        report.cleanedPending.push(id);
      }
      if (report.cleanedPending.length) report.warnings.push(`removed PENDING snapshot(s) ${report.cleanedPending.join(', ')} left by an interrupted sync`);
    }

    // ---- 1. repositories
    step = 'detect';
    const cfg = detectRepos(db, o.configFile);
    report.config = { source: cfg.source, file: cfg.file, publishId: cfg.publishId };
    log(`repositories (${cfg.source === 'config' ? cfg.file : 'detected from the current snapshot'}): ${cfg.repos.map((r) => r.id).join(', ')}`);

    // ---- 2. revisions (resolved locally; never fetched)
    step = 'resolve';
    const revs = o.revs ?? {};
    for (const id of Object.keys(revs)) if (!cfg.repos.some((r) => r.id === id)) throw new SyncInputError(`--rev: unknown repository ${id}`);
    const reindex = new Set(o.reindex ?? []);
    for (const id of reindex) if (id !== 'all' && !cfg.repos.some((r) => r.id === id)) throw new SyncInputError(`--reindex: unknown repository ${id}`);
    const versions: Record<RepoKind, string | null> = {
      java: o.versions && 'java' in o.versions ? o.versions.java ?? null : cfg.repos.some((r) => r.kind === 'java') ? javaAnalyzerVersion(o.jciRoot, report.warnings) : null,
      ui: o.versions && 'ui' in o.versions ? o.versions.ui ?? null : uiAnalyzerVersion(o.jciRoot),
    };
    for (const r of cfg.repos) {
      const rev = revs[r.id] ?? 'HEAD';
      if (!safeRev(rev)) throw new SyncInputError(`--rev ${r.id}=${rev}: not a plain branch, tag or commit`);
      const commit = sha(r.path, rev);
      if (!commit) throw new SyncInputError(`${r.id}: revision ${rev} does not resolve in ${r.path}`);
      report.repos.push({ repoId: r.id, kind: r.kind, path: r.path, rev, commit, action: null, graphFile: null, analyzerVersion: null,
        expectedVersion: versions[r.kind], durationMs: 0, reason: '' });
    }
    const commits = Object.fromEntries(report.repos.map((r) => [r.repoId, r.commit!]));

    // ---- 3. reuse: is the current snapshot already built from these commits and analyzers?
    const prevId = currentSnapshotId(db, cfg.publishId);
    const prev = prevId === null ? undefined : resolveSnapshot(db, prevId);
    report.current = prevId;
    const upToDate = !!prev && !reindex.size && prev.sourceMode === 'HEAD' && upToDateWith(prev, cfg, commits, versions);
    if (upToDate) {
      for (const r of report.repos) Object.assign(r, { action: 'UNCHANGED', reason: `snapshot ${prev!.id} is indexed at this commit` });
      report.outcome = o.dryRun ? 'DRY_RUN' : 'UP_TO_DATE';
      log(`snapshot ${prev!.id} is up to date`);
      await finish(report, o, prev!.id);
      return report;
    }
    const accept = (kind: RepoKind) => (s: any) => schemaOk(s) && (!versions[kind] || s.analyzerVersion === versions[kind]);
    for (const r of report.repos) {
      const force = reindex.has('all') || reindex.has(r.repoId);
      const hit = force ? null : findGraph([...o.graphDirs, o.cacheDir], r.repoId, r.commit!, { accept: accept(r.kind), requireComplete: true });
      r.reason = force ? 're-index requested' : hit ? `graph for ${r.commit!.slice(0, 10)}${versions[r.kind] ? ` by analyzer ${versions[r.kind]}` : ''} exists`
        : `no complete graph for ${r.commit!.slice(0, 10)}${versions[r.kind] ? ` by analyzer ${versions[r.kind]}` : ''}`;
      if (o.dryRun) Object.assign(r, { action: hit ? 'WOULD_REUSE' : 'WOULD_INDEX', graphFile: hit });
    }
    if (o.dryRun) {
      report.outcome = 'DRY_RUN';
      await finish(report, o, prevId);
      return report;
    }

    // ---- 4. index what has no reusable graph (read-only: git archive / cat-file at the commit)
    step = 'index';
    const indexer = o.indexer ?? ensureGraph;
    const graphs = new Map<string, GraphRef>();
    for (const r of report.repos) {
      const repo = cfg.repos.find((x) => x.id === r.repoId)!;
      const t = Date.now();
      const force = reindex.has('all') || reindex.has(r.repoId);
      const g = indexer(repo.kind, repo.path, repo.id, r.commit!, {
        jciRoot: o.jciRoot, graphDirs: o.graphDirs, cacheDir: o.cacheDir, log, accept: accept(repo.kind), requireComplete: true, reuse: !force,
      });
      const s = readSnapshotLine(g.file);
      if (!s || s.repoId !== repo.id || s.commitSha !== r.commit || s.sourceMode !== 'HEAD') {
        throw new StepError('index', `${repo.id}: graph ${g.file} is not a HEAD-mode graph of ${r.commit}`);
      }
      if (!g.reused && versions[repo.kind] && s.analyzerVersion !== versions[repo.kind]) {
        report.warnings.push(`${repo.id}: indexed graph reports analyzer ${s.analyzerVersion}, expected ${versions[repo.kind]}`);
      }
      Object.assign(r, { action: g.reused ? 'REUSED' : 'INDEXED', graphFile: g.file, analyzerVersion: s.analyzerVersion ?? null, durationMs: Date.now() - t });
      graphs.set(repo.id, g);
    }

    // ---- 5. combine Core + UI (cached by component commits)
    step = 'combine';
    let loadFile: string;
    if (cfg.system) {
      const java = cfg.repos.find((r) => r.kind === 'java')!;
      const ui = cfg.repos.find((r) => r.kind === 'ui')!;
      const t = Date.now();
      const { file, reused, stitch } = await combined(o, cfg.system, graphs.get(java.id)!.file, graphs.get(ui.id)!.file, log);
      report.combine = { file, reused, durationMs: Date.now() - t, stitch };
      loadFile = file;
    } else loadFile = graphs.get(cfg.repos[0]!.id)!.file;

    // ---- 6/7. load as PENDING (invisible) unless this exact graph is already loaded
    step = 'load';
    const t = Date.now();
    const existing = loadedSnapshot(db, loadFile);
    let loaded: { nodes: number; edges: number; diagnostics: number } | null = null;
    let sid: number;
    if (existing !== null && !isPending(db, existing)) {
      sid = existing;
      report.load = { snapshotId: sid, reused: true, nodes: null, edges: null, durationMs: Date.now() - t };
      log(`graph already loaded as snapshot ${sid}`);
    } else {
      log(`loading ${basename(loadFile)} …`);
      let r;
      try {
        r = await loadNdjson(db, loadFile, { state: 'PENDING' });
      } catch (e) {
        // Contract, schema version, dangling edges and duplicate ids are enforced while parsing: a validation failure.
        throw new StepError('validate', (e as Error).message);
      }
      sid = pendingId = r.snapshotId;
      loaded = { nodes: r.nodes, edges: r.edges, diagnostics: r.diagnostics };
      report.load = { snapshotId: sid, reused: false, nodes: r.nodes, edges: r.edges, durationMs: Date.now() - t };
      log(`loaded snapshot ${sid} (PENDING): ${r.nodes} nodes, ${r.edges} edges in ${Math.round((Date.now() - t) / 1000)} s`);
    }
    if (o.afterLoad) await o.afterLoad(sid);

    step = 'validate';
    report.validation = validateSnapshot(db, {
      snapshotId: sid, commits, roles: Object.fromEntries(cfg.repos.map((r) => [r.id, r.role])), loaded,
      previousId: prevId, maxShrink: o.maxShrink ?? 0.5, allowShrink: !!o.allowShrink,
    });
    const failed = report.validation.filter((c) => !c.ok);
    if (failed.length) throw new StepError('validate', failed.map((c) => `${c.check}: ${c.detail}`).join('; '));

    // ---- 8. publish: one transaction moves the pointer and clears PENDING
    step = 'publish';
    publishSnapshot(db, sid, 'sync');
    pendingId = null;
    report.publish = { previous: prevId === sid ? null : prevId, current: sid };
    report.current = sid;
    report.outcome = sid === prevId ? 'UP_TO_DATE' : 'PUBLISHED';
    log(sid === prevId ? `snapshot ${sid} was already current` : `published snapshot ${sid}${prevId !== null ? ` (was ${prevId})` : ''}`);
    await finish(report, o, sid);
    return report;
  } catch (e) {
    // ---- 9. failure: keep the previous snapshot current, remove what this run loaded
    if (pendingId !== null) {
      try {
        dropPending(db, pendingId);
      } catch (cleanup) {
        report.warnings.push(`could not remove PENDING snapshot ${pendingId}: ${(cleanup as Error).message}; the next sync removes it`);
      }
    }
    report.outcome = 'FAILED';
    report.error = { step: e instanceof StepError ? e.step : step, message: (e as Error).message };
    report.current = report.config ? currentSnapshotId(db, report.config.publishId) : null;
    if (e instanceof SyncInputError || e instanceof SyncConfigError || e instanceof SyncLockedError) {
      // Usage, configuration and lock errors are rethrown for their exit codes after the report is complete.
      await finish(report, o, null, true);
      throw Object.assign(e as Error, { report });
    }
    await finish(report, o, null, !!o.dryRun);
    return report;
  } finally {
    lock?.release();
  }
}

/** The current snapshot covers exactly these commits, analyzer versions and stitch version. */
function upToDateWith(prev: NonNullable<ReturnType<typeof resolveSnapshot>>, cfg: SyncConfig, commits: Record<string, string>, versions: Record<RepoKind, string | null>): boolean {
  const kindOf = (id: string) => cfg.repos.find((r) => r.id === id)!.kind;
  if (cfg.system) {
    if (!String(prev.analyzerVersion ?? '').startsWith(`${STITCH_VERSION} `)) return false;
    const coreBases = (prev.stats.stitchOptions as { coreBases?: string[] } | undefined)?.coreBases ?? ['process.env.JP_API'];
    if (JSON.stringify(coreBases) !== JSON.stringify(cfg.system.coreBases)) return false;
    const repos = (prev.scope.repos ?? []) as Array<{ repoId: string; commitSha: string; sourceMode?: string; analyzerVersion?: string }>;
    return repos.length === cfg.repos.length && repos.every((r) => r.repoId in commits && r.commitSha === commits[r.repoId] && (r.sourceMode ?? 'HEAD') === 'HEAD'
      && (!versions[kindOf(r.repoId)] || r.analyzerVersion === versions[kindOf(r.repoId)]));
  }
  const only = cfg.repos[0]!;
  return prev.commitSha === commits[only.id] && (!versions[only.kind] || prev.analyzerVersion === versions[only.kind]);
}

/** System graph for these component graphs: reused from the cache when built from the same files, else combined atomically. */
async function combined(o: SyncOptions, system: NonNullable<SyncConfig['system']>, coreFile: string, uiFile: string, log: (m: string) => void) {
  const core = readSnapshotLine(coreFile);
  const ui = readSnapshotLine(uiFile);
  const out = join(o.cacheDir, `system-${String(core.commitSha).slice(0, 12)}-${String(ui.commitSha).slice(0, 12)}.ndjson`);
  if (existsSync(out)) {
    const s = readSnapshotLine(out);
    const repos = (s?.scope?.repos ?? []) as Array<{ repoId: string; commitSha: string; finishedAt?: string }>;
    const same = (c: any) => repos.some((r) => r.repoId === c.repoId && r.commitSha === c.commitSha && r.finishedAt === c.finishedAt);
    if (s && s.repoId === system.id && String(s.analyzerVersion).startsWith(`${STITCH_VERSION} `) && repos.length === 2 && same(core) && same(ui)
      && JSON.stringify(s.stats?.stitchOptions?.coreBases ?? null) === JSON.stringify(system.coreBases) && lastLineComplete(out)) {
      log(`reusing combined graph ${out}`);
      return { file: out, reused: true, stitch: s.stats?.stitch ?? null };
    }
  }
  const tmpDir = join(o.cacheDir, '.partial');
  mkdirSync(tmpDir, { recursive: true });
  const tmp = join(tmpDir, basename(out));
  log('combining Core and UI graphs …');
  try {
    const r = await combineGraphs(coreFile, uiFile, tmp, { systemId: system.id, coreBases: system.coreBases });
    renameSync(tmp, out);
    return { file: out, reused: false, stitch: r.stitch };
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new StepError('combine', (e as Error).message);
  }
}

/** Freshness of the resulting current snapshot, warnings from it, report files (not for dry runs). */
async function finish(report: SyncReport, o: SyncOptions, currentId: number | null, skipFiles = false): Promise<void> {
  if (currentId !== null && o.freshness !== false) {
    const snap = resolveSnapshot(o.db, currentId);
    if (snap) {
      try {
        const f = await checkFreshness(o.db, snap, { refresh: true });
        report.freshness = summarizeFreshness(f);
        for (const r of f.repos) {
          if (r.worktree.status === 'MODIFIED') report.warnings.push(`${r.repoId}: ${r.worktree.changedInScope} uncommitted source change(s) are not in the graph (sync indexes commits only)`);
          if (r.branch.status === 'BEHIND' || r.branch.status === 'DIVERGED') {
            report.warnings.push(`${r.repoId}: branch ${r.branch.status.toLowerCase()} ${r.branch.upstream} (behind ${r.branch.behind ?? '?'}); sync never fetches or pulls`);
          }
        }
      } catch (e) {
        report.warnings.push(`freshness check failed: ${(e as Error).message}`);
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
  if (!o.dryRun && !skipFiles) writeReportFiles(o.stateDir, report);
}

/** last-sync.json (replaced atomically) and one line per run in history.ndjson (failed checks only). */
export function writeReportFiles(stateDir: string, report: SyncReport): void {
  mkdirSync(stateDir, { recursive: true });
  const tmp = join(stateDir, 'last-sync.json.tmp');
  writeFileSync(tmp, JSON.stringify(report, null, 2));
  renameSync(tmp, join(stateDir, 'last-sync.json'));
  appendFileSync(join(stateDir, 'history.ndjson'), JSON.stringify({ ...report, validation: report.validation.filter((c) => !c.ok) }) + '\n');
}
