import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { findGraph, readSnapshotLine, type GraphRef, type IndexOptions } from '../src/changes/index.js';
import { openDb, type DB } from '../src/db.js';
import { findMatchingSnapshot } from '../src/freshness.js';
import { loadNdjson } from '../src/loader.js';
import { listSnapshots, resolveSnapshot } from '../src/query.js';
import { currentSnapshotId, pendingSnapshotIds, publishSnapshot } from '../src/snapshots.js';
import { SyncConfigError } from '../src/sync/config.js';
import { acquireLock, SyncLockedError } from '../src/sync/lock.js';
import { syncGraphs, SyncInputError, type SyncOptions, type SyncReport } from '../src/sync/run.js';
import { validateSnapshot } from '../src/sync/validate.js';

/**
 * `npm run sync` over temporary git repositories ("core" and "ui"). The indexer is replaced by one that writes the
 * fixture graphs (test/data/simple-rest.ndjson, simple-ui.ndjson) at the requested commit, so each case runs in
 * seconds; C17 runs the real UI analyzer end to end.
 */
const JCI = resolve(import.meta.dirname, '../..');
const DATA = join(import.meta.dirname, 'data');
const VERSIONS = { java: 'java-test-1', ui: 'ui-test-1' };
const SYSTEM = 'test-system';
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const commit = (repo: string, file: string, text: string) => {
  write(join(repo, file), text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'change');
  return git(repo, 'rev-parse', 'HEAD');
};
const head = (repo: string) => git(repo, 'rev-parse', 'HEAD');

function makeTemplate(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'jci-sync-template-'));
  for (const name of ['core', 'ui']) {
    const repo = join(tmp, name);
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    commit(repo, name === 'core' ? 'src/main/java/a/A.java' : 'src/App.vue', name === 'core' ? 'package a;\nclass A {}\n' : '<template><div/></template>\n');
  }
  return tmp;
}
const TEMPLATE = makeTemplate();

interface Env { tmp: string; core: string; ui: string; db: DB; opts: SyncOptions; calls: string[]; mutate: Map<string, (recs: any[]) => any[]> }
/** A fresh copy of the template repositories, an in-memory database, and sync options with the fixture indexer. */
function env(over: Partial<SyncOptions> = {}): Env {
  const tmp = mkdtempSync(join(tmpdir(), 'jci-sync-'));
  cpSync(TEMPLATE, tmp, { recursive: true });
  const core = join(tmp, 'core');
  const ui = join(tmp, 'ui');
  const configFile = join(tmp, 'repos.yaml');
  writeFileSync(configFile, `system:\n  id: ${SYSTEM}\nrepos:\n  - id: core\n    kind: java\n    path: ${core.replace(/\\/g, '/')}\n  - id: ui\n    kind: ui\n    path: ${ui.replace(/\\/g, '/')}\n`);
  const db = openDb(':memory:');
  const calls: string[] = [];
  const mutate = new Map<string, (recs: any[]) => any[]>();
  const opts: SyncOptions = {
    db, jciRoot: JCI, graphDirs: [join(tmp, 'graphs')], cacheDir: join(tmp, 'graphs', 'cache'), stateDir: join(tmp, 'sync'), configFile,
    versions: VERSIONS, freshness: false, indexer: fixtureIndexer(calls, mutate), ...over,
  };
  return { tmp, core, ui, db, opts, calls, mutate };
}

/** Writes the fixture graph for the repository kind at `commit`, honouring reuse like ensureGraph. */
function fixtureIndexer(calls: string[], mutate: Map<string, (recs: any[]) => any[]>) {
  return (kind: 'java' | 'ui', repoPath: string, repoId: string, commitSha: string, o: IndexOptions): GraphRef => {
    if (o.reuse !== false) {
      const hit = findGraph([...o.graphDirs, o.cacheDir], repoId, commitSha, { accept: o.accept, requireComplete: o.requireComplete });
      if (hit) return { file: hit, repoId, commitSha, sourceMode: 'HEAD', reused: true };
    }
    calls.push(`${repoId}@${commitSha.slice(0, 7)}`);
    let recs = readFileSync(join(DATA, kind === 'java' ? 'simple-rest.ndjson' : 'simple-ui.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    recs[0] = { ...recs[0], repoId, repoPath: repoPath.replace(/\\/g, '/'), commitSha, sourceMode: 'HEAD', analyzerVersion: VERSIONS[kind], finishedAt: new Date().toISOString() };
    const m = mutate.get(repoId);
    if (m) recs = m(recs);
    mkdirSync(o.cacheDir, { recursive: true });
    const file = join(o.cacheDir, `${repoId}-${commitSha.slice(0, 12)}.ndjson`);
    writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return { file, repoId, commitSha, sourceMode: 'HEAD', reused: false };
  };
}

const rows = (db: DB) => (db.prepare('SELECT COUNT(*) AS c FROM snapshots').get() as { c: number }).c;
const action = (r: SyncReport, id: string) => r.repos.find((x) => x.repoId === id)!.action;
const failedChecks = (r: SyncReport) => r.validation.filter((c) => !c.ok).map((c) => c.check);
const PAR = { concurrency: true };

describe('C — sync workflow', PAR, () => {
  test('C1 dry run plans without writing anything', async () => {
    const e = env();
    const r = await syncGraphs({ ...e.opts, dryRun: true });
    assert.equal(r.outcome, 'DRY_RUN');
    assert.deepEqual([action(r, 'core'), action(r, 'ui')], ['WOULD_INDEX', 'WOULD_INDEX']);
    assert.equal(r.repos[0]!.commit, head(e.core));
    assert.equal(rows(e.db), 0);
    assert.deepEqual(e.calls, []);
    assert.equal(existsSync(e.opts.cacheDir), false);
    assert.equal(existsSync(e.opts.stateDir), false, 'no report or lock files');
  });

  test('C2 first sync indexes, combines, validates and publishes', async () => {
    const e = env({ freshness: true });
    const r = await syncGraphs(e.opts);
    assert.equal(r.outcome, 'PUBLISHED', JSON.stringify(r.error));
    assert.deepEqual([action(r, 'core'), action(r, 'ui')], ['INDEXED', 'INDEXED']);
    assert.equal(r.combine?.reused, false);
    assert.deepEqual(failedChecks(r), []);
    assert.ok(['commits', 'counts', 'search-index', 'references', 'path-prefixes', 'content:core', 'content:ui', 'query'].every((c) => r.validation.some((v) => v.check === c)));
    const sid = r.publish!.current;
    assert.equal(r.publish!.previous, null);
    assert.equal(currentSnapshotId(e.db, SYSTEM), sid);
    assert.equal(resolveSnapshot(e.db, undefined, SYSTEM)?.id, sid);
    assert.equal(resolveSnapshot(e.db)?.id, sid);
    assert.equal(listSnapshots(e.db).find((s) => s.id === sid)?.current, true);
    assert.deepEqual(pendingSnapshotIds(e.db), []);
    assert.equal(r.freshness?.status, 'CURRENT');
    assert.deepEqual(r.freshness?.repos.map((x) => x.indexedCommit), [head(e.core), head(e.ui)]);
  });

  test('C3 second sync without changes is UP_TO_DATE and writes nothing', async () => {
    const e = env();
    const first = await syncGraphs(e.opts);
    const n = rows(e.db);
    e.calls.length = 0;
    const r = await syncGraphs(e.opts);
    assert.equal(r.outcome, 'UP_TO_DATE');
    assert.deepEqual([action(r, 'core'), action(r, 'ui')], ['UNCHANGED', 'UNCHANGED']);
    assert.deepEqual(e.calls, []);
    assert.equal(rows(e.db), n);
    assert.equal(r.current, first.publish!.current);
  });

  test('C4 only the UI moved: Core graph reused, UI indexed, new snapshot published, old one kept', async () => {
    const e = env();
    const first = await syncGraphs(e.opts);
    const uiSha = commit(e.ui, 'src/B.vue', '<template><b/></template>\n');
    e.calls.length = 0;
    const r = await syncGraphs(e.opts);
    assert.equal(r.outcome, 'PUBLISHED', JSON.stringify(r.error));
    assert.deepEqual([action(r, 'core'), action(r, 'ui')], ['REUSED', 'INDEXED']);
    assert.deepEqual(e.calls, [`ui@${uiSha.slice(0, 7)}`]);
    assert.equal(r.publish!.previous, first.publish!.current);
    assert.ok(resolveSnapshot(e.db, first.publish!.current), 'previous snapshot stays loaded');
    const repos = resolveSnapshot(e.db, undefined, SYSTEM)!.scope.repos as Array<{ repoId: string; commitSha: string }>;
    assert.equal(repos.find((x) => x.repoId === 'ui')!.commitSha, uiSha);
  });

  test('C5 reuse is refused for another analyzer version, a truncated file, includePackages or a WORKTREE graph', async () => {
    const e = env();
    const sha = head(e.core);
    const base = readFileSync(join(DATA, 'simple-rest.ndjson'), 'utf8').split('\n').filter(Boolean);
    const snap = JSON.parse(base[0]!);
    const put = (name: string, s: object, body = base.slice(1).join('\n') + '\n') =>
      write(join(e.tmp, 'graphs', name), JSON.stringify({ ...snap, repoId: 'core', commitSha: sha, sourceMode: 'HEAD', analyzerVersion: VERSIONS.java, ...s }) + '\n' + body);
    put('old-version.ndjson', { analyzerVersion: 'java-old' });
    put('truncated.ndjson', {}, base.slice(1).join('\n').slice(0, -40));
    put('subset.ndjson', { scope: { ...snap.scope, includePackages: ['a'] } });
    put('worktree.ndjson', { sourceMode: 'WORKTREE' });
    const accept = (s: any) => s.analyzerVersion === VERSIONS.java;
    assert.equal(findGraph([join(e.tmp, 'graphs')], 'core', sha, { accept, requireComplete: true }), null);
    // Without the extra checks (change analysis) the old-version and truncated files are still found.
    assert.ok(findGraph([join(e.tmp, 'graphs')], 'core', sha));
    const r = await syncGraphs(e.opts);
    assert.equal(r.outcome, 'PUBLISHED', JSON.stringify(r.error));
    assert.equal(action(r, 'core'), 'INDEXED');
    // A complete graph by the expected analyzer is reused.
    const e2 = env();
    write(join(e2.tmp, 'graphs', 'good.ndjson'), JSON.stringify({ ...snap, repoId: 'core', commitSha: head(e2.core), sourceMode: 'HEAD', analyzerVersion: VERSIONS.java }) + '\n' + base.slice(1).join('\n') + '\n');
    const r2 = await syncGraphs(e2.opts);
    assert.equal(action(r2, 'core'), 'REUSED');
    assert.ok(r2.repos[0]!.graphFile!.endsWith('good.ndjson'));
  });

  test('C14 --rev selects a commit; bad, unknown or unresolvable revisions fail before anything is written', async () => {
    const e = env();
    const old = head(e.ui);
    commit(e.ui, 'src/B.vue', '<template><b/></template>\n');
    const r = await syncGraphs({ ...e.opts, revs: { ui: old } });
    assert.equal(r.outcome, 'PUBLISHED', JSON.stringify(r.error));
    assert.equal((resolveSnapshot(e.db, r.publish!.current)!.scope.repos as Array<{ repoId: string; commitSha: string }>).find((x) => x.repoId === 'ui')!.commitSha, old);
    const n = rows(e.db);
    const bad: Array<Record<string, string>> = [{ ui: 'a..b' }, { ui: '--output=x' }, { nope: 'HEAD' }, { ui: 'no-such-branch' }];
    for (const revs of bad) {
      await assert.rejects(syncGraphs({ ...e.opts, revs }), SyncInputError, JSON.stringify(revs));
    }
    await assert.rejects(syncGraphs({ ...e.opts, reindex: ['nope'] }), SyncInputError);
    assert.equal(rows(e.db), n);
    assert.equal(existsSync(join(e.opts.stateDir, 'sync.lock')), false, 'lock released after an input error');
  });

  test('C16 report files: last-sync.json complete, history appended per run', async () => {
    const e = env();
    await syncGraphs(e.opts);
    await syncGraphs(e.opts);
    const last = JSON.parse(readFileSync(join(e.opts.stateDir, 'last-sync.json'), 'utf8')) as SyncReport;
    for (const k of ['outcome', 'startedAt', 'finishedAt', 'durationMs', 'config', 'repos', 'combine', 'load', 'validation', 'publish', 'current', 'freshness', 'cleanedPending', 'warnings', 'error']) {
      assert.ok(k in last, k);
    }
    assert.equal(last.outcome, 'UP_TO_DATE');
    const history = readFileSync(join(e.opts.stateDir, 'history.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).outcome);
    assert.deepEqual(history, ['PUBLISHED', 'UP_TO_DATE']);
  });
});

describe('C — failures keep the previous snapshot current', PAR, () => {
  test('C6 indexer failure: FAILED at index, pointer and visible snapshots unchanged', async () => {
    const e = env();
    const first = await syncGraphs(e.opts);
    commit(e.core, 'src/main/java/a/B.java', 'package a;\nclass B {}\n');
    const before = listSnapshots(e.db).map((s) => s.id);
    const r = await syncGraphs({ ...e.opts, indexer: () => { throw new Error('analyzer crashed'); } });
    assert.equal(r.outcome, 'FAILED');
    assert.deepEqual(r.error, { step: 'index', message: 'analyzer crashed' });
    assert.equal(r.current, first.publish!.current);
    assert.equal(currentSnapshotId(e.db, SYSTEM), first.publish!.current);
    assert.deepEqual(listSnapshots(e.db).map((s) => s.id), before);
  });

  test('C7a schema or reference error while loading: FAILED at validate, nothing loaded', async () => {
    const e = env();
    const first = await syncGraphs(e.opts);
    commit(e.ui, 'src/B.vue', '<template><b/></template>\n');
    e.mutate.set('ui', (recs) => [...recs, { ...recs.find((r) => r.type === 'edge'), id: 'e:dangling', dst: 'missing' }]);
    const r = await syncGraphs(e.opts);
    assert.equal(r.outcome, 'FAILED');
    assert.equal(r.error?.step, 'validate');
    assert.match(r.error!.message, /reference unknown nodes/);
    assert.equal(currentSnapshotId(e.db, SYSTEM), first.publish!.current);
    assert.deepEqual(pendingSnapshotIds(e.db), []);
    assert.equal(rows(e.db), 1);
  });

  test('C7b shrink guard: a graph that lost most of a node kind is not published unless allowed', async () => {
    const e = env();
    const first = await syncGraphs(e.opts);
    commit(e.ui, 'src/B.vue', '<template><b/></template>\n');
    e.mutate.set('ui', (recs) => {
      const gone = new Set(recs.filter((r) => r.type === 'node' && r.kind === 'UI_FUNCTION').map((r) => r.id));
      return recs.filter((r) => !(r.type === 'node' && gone.has(r.id)) && !(r.type === 'edge' && (gone.has(r.src) || gone.has(r.dst))));
    });
    const r = await syncGraphs(e.opts);
    assert.equal(r.outcome, 'FAILED');
    assert.equal(r.error?.step, 'validate');
    assert.deepEqual(failedChecks(r), ['shrink']);
    assert.match(r.validation.find((c) => c.check === 'shrink')!.detail, /UI_FUNCTION 20 → 0/);
    assert.equal(currentSnapshotId(e.db, SYSTEM), first.publish!.current);
    assert.deepEqual(pendingSnapshotIds(e.db), []);
    const allowed = await syncGraphs({ ...e.opts, allowShrink: true });
    assert.equal(allowed.outcome, 'PUBLISHED', JSON.stringify(allowed.error));
    assert.match(allowed.validation.find((c) => c.check === 'shrink')!.detail, /allowed by --allow-shrink/);
  });

  test('C7c validator: commit mismatch and missing content fail their checks', async () => {
    const e = env();
    const r = await syncGraphs(e.opts);
    const sid = r.publish!.current;
    const checks = validateSnapshot(e.db, {
      snapshotId: sid, commits: { core: head(e.core), ui: 'f'.repeat(40) }, roles: { core: 'backend', ui: 'frontend' }, loaded: null,
      previousId: null, maxShrink: 0.5, allowShrink: false,
    });
    assert.deepEqual(checks.filter((c) => !c.ok).map((c) => c.check), ['commits']);
    e.db.prepare("DELETE FROM nodes WHERE snapshot_id = ? AND kind = 'API_ENDPOINT'").run(sid);
    const after = validateSnapshot(e.db, { snapshotId: sid, commits: { core: head(e.core), ui: head(e.ui) }, roles: { core: 'backend', ui: 'frontend' },
      loaded: null, previousId: null, maxShrink: 0.5, allowShrink: false });
    assert.ok(after.filter((c) => !c.ok).map((c) => c.check).includes('content:core'));
  });

  test('C8 interrupted run: PENDING snapshot invisible everywhere, removed by the next sync', async () => {
    const e = env();
    const first = await syncGraphs(e.opts);
    const sys = resolveSnapshot(e.db, first.publish!.current)!;
    commit(e.ui, 'src/B.vue', '<template><b/></template>\n');
    // Simulate a crash between load and publish: the next combined graph loaded PENDING, nothing else.
    const dry = await syncGraphs({ ...e.opts, dryRun: true });
    assert.equal(action(dry, 'ui'), 'WOULD_INDEX');
    const uiGraph = e.opts.indexer!('ui', e.ui, 'ui', head(e.ui), { jciRoot: JCI, graphDirs: e.opts.graphDirs, cacheDir: e.opts.cacheDir, log: () => {} });
    const { combineGraphs } = await import('../src/multi/combine.js');
    const coreGraph = findGraph([e.opts.cacheDir], 'core', head(e.core))!;
    const sysFile = join(e.tmp, 'crash.ndjson');
    await combineGraphs(coreGraph, uiGraph.file, sysFile, { systemId: SYSTEM });
    const pending = (await loadNdjson(e.db, sysFile, { state: 'PENDING' })).snapshotId;
    assert.equal(listSnapshots(e.db).some((s) => s.id === pending), false);
    assert.equal(resolveSnapshot(e.db, pending), undefined);
    assert.equal(resolveSnapshot(e.db, undefined, SYSTEM)?.id, first.publish!.current);
    assert.equal(resolveSnapshot(e.db, pending, undefined, { includePending: true })?.id, pending);
    const commits = new Map([['core', head(e.core)], ['ui', head(e.ui)]]);
    assert.equal(findMatchingSnapshot(e.db, sys, commits), null);
    const r = await syncGraphs(e.opts);
    assert.deepEqual(r.cleanedPending, [pending]);
    assert.ok(r.warnings.some((w) => w.includes('interrupted')));
    assert.equal(r.outcome, 'PUBLISHED', JSON.stringify(r.error));
    assert.deepEqual(pendingSnapshotIds(e.db), []);
  });

  test('C9 lock: a live owner blocks (exit 3 path), a dead owner is taken over', async () => {
    const e = env();
    const lockFile = join(e.opts.stateDir, 'sync.lock');
    const held = acquireLock(lockFile);
    await assert.rejects(syncGraphs(e.opts), SyncLockedError);
    assert.equal(rows(e.db), 0);
    held.release();
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    write(lockFile, JSON.stringify({ pid: dead, startedAt: '2026-01-01T00:00:00Z' }));
    const r = await syncGraphs(e.opts);
    assert.equal(r.outcome, 'PUBLISHED', JSON.stringify(r.error));
    assert.ok(r.warnings.some((w) => w.includes(`stale lock from pid ${dead}`)));
    assert.equal(existsSync(lockFile), false);
  });

  test('C10 publish is atomic: readers see the previous snapshot until publish, then the new one', async () => {
    const e = env();
    const first = await syncGraphs(e.opts);
    commit(e.ui, 'src/B.vue', '<template><b/></template>\n');
    let seen: { current?: number; listed: boolean; pending: number } | null = null;
    const r = await syncGraphs({
      ...e.opts,
      afterLoad: (sid) => {
        seen = { current: resolveSnapshot(e.db, undefined, SYSTEM)?.id, listed: listSnapshots(e.db).some((s) => s.id === sid), pending: sid };
      },
    });
    assert.deepEqual(seen, { current: first.publish!.current, listed: false, pending: r.publish!.current });
    assert.equal(resolveSnapshot(e.db, undefined, SYSTEM)?.id, r.publish!.current);
  });
});

describe('C — compatibility and configuration', PAR, () => {
  const graph = (repoId: string, commitSha: string, dir: string) => {
    const lines = readFileSync(join(DATA, 'simple-rest.ndjson'), 'utf8').split('\n').filter(Boolean);
    const file = join(dir, `${repoId}-${commitSha}.ndjson`);
    write(file, [JSON.stringify({ ...JSON.parse(lines[0]!), repoId, commitSha, sourceMode: 'HEAD' }), ...lines.slice(1)].join('\n') + '\n');
    return file;
  };

  test('C11 without pointers the newest snapshot is current; load --publish keeps "just loaded is current"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jci-sync-compat-'));
    const db = openDb(':memory:');
    const a = (await loadNdjson(db, graph('r', 'a'.repeat(40), dir))).snapshotId;
    const b = (await loadNdjson(db, graph('r', 'b'.repeat(40), dir))).snapshotId;
    assert.equal(resolveSnapshot(db, undefined, 'r')?.id, b, 'no pointer: newest');
    assert.equal(resolveSnapshot(db)?.id, b);
    assert.deepEqual(listSnapshots(db).map((s) => [s.id, s.current]), [[b, true], [a, false]]);
    publishSnapshot(db, a, 'test');
    assert.equal(resolveSnapshot(db, undefined, 'r')?.id, a, 'pointer wins over newer snapshots');
    const c = (await loadNdjson(db, graph('r', 'c'.repeat(40), dir))).snapshotId;
    assert.equal(resolveSnapshot(db, undefined, 'r')?.id, a, 'loading without publish does not change current');
    const d = (await loadNdjson(db, graph('r', 'd'.repeat(40), dir), { publish: true })).snapshotId;
    assert.equal(resolveSnapshot(db, undefined, 'r')?.id, d, 'npm run load publishes');
    assert.ok(c < d);
    // The list keeps its shape; `current` is additive.
    const keys = Object.keys(listSnapshots(db)[0]!).sort();
    assert.deepEqual(keys, ['analyzerVersion', 'commitSha', 'current', 'engine', 'finishedAt', 'id', 'loadedAt', 'repoId', 'repoPath', 'scope', 'sourceMode', 'stats']);
  });

  test('C12 reloading the published graph keeps it published under its new id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jci-sync-compat-'));
    const db = openDb(':memory:');
    const file = graph('r', 'a'.repeat(40), dir);
    const first = await loadNdjson(db, file, { publish: true });
    await loadNdjson(db, graph('r', 'b'.repeat(40), dir));
    const again = await loadNdjson(db, file);
    assert.equal(again.replaced, true);
    assert.equal(currentSnapshotId(db, 'r'), again.snapshotId);
    assert.notEqual(again.snapshotId, first.snapshotId);
    await assert.rejects(loadNdjson(db, file, { state: 'PENDING' }), /already loaded/);
  });

  test('C13 read-only: repositories keep their status, index and have no FETCH_HEAD', async () => {
    const e = env({ freshness: true });
    write(join(e.core, 'src/main/java/a/Dirty.java'), 'package a;\nclass Dirty {}\n');
    const state = (repo: string) => [git(repo, '--no-optional-locks', 'status', '--porcelain'), statSync(join(repo, '.git', 'index')).mtimeMs, existsSync(join(repo, '.git', 'FETCH_HEAD'))];
    const before = [state(e.core), state(e.ui)];
    const r = await syncGraphs(e.opts);
    assert.equal(r.outcome, 'PUBLISHED', JSON.stringify(r.error));
    assert.deepEqual([state(e.core), state(e.ui)], before);
    assert.ok(r.warnings.some((w) => w.startsWith('core: 1 uncommitted source change')), r.warnings.join('|'));
  });

  test('C15 configuration: file, detection from the current system snapshot, neither, invalid', async () => {
    const e = env();
    const first = await syncGraphs(e.opts);
    assert.equal(first.config?.source, 'config');
    rmSync(e.opts.configFile);
    const detected = await syncGraphs(e.opts);
    assert.equal(detected.config?.source, 'snapshot');
    assert.equal(detected.outcome, 'UP_TO_DATE');
    await assert.rejects(syncGraphs({ ...e.opts, db: openDb(':memory:') }), SyncConfigError);
    writeFileSync(e.opts.configFile, `repos:\n  - id: a\n    kind: java\n    path: ${e.core.replace(/\\/g, '/')}\n  - id: b\n    kind: java\n    path: ${e.ui.replace(/\\/g, '/')}\n`);
    await assert.rejects(syncGraphs(e.opts), /one java .* and one ui/);
    writeFileSync(e.opts.configFile, `repos:\n  - id: a\n    kind: java\n    path: ${join(e.tmp, 'missing').replace(/\\/g, '/')}\n`);
    await assert.rejects(syncGraphs(e.opts), /does not exist/);
  });

  test('C15b single-repository config publishes under the repository id without combining', async () => {
    const e = env();
    writeFileSync(e.opts.configFile, `repos:\n  - id: core\n    kind: java\n    path: ${e.core.replace(/\\/g, '/')}\n`);
    const r = await syncGraphs(e.opts);
    assert.equal(r.outcome, 'PUBLISHED', JSON.stringify(r.error));
    assert.equal(r.combine, null);
    assert.equal(resolveSnapshot(e.db, undefined, 'core')?.id, r.publish!.current);
    assert.equal((await syncGraphs(e.opts)).outcome, 'UP_TO_DATE');
  });
});

describe('C — real UI analyzer', () => {
  test('C17 sync runs the UI analyzer read-only at the commit and publishes the graph', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'jci-sync-ui-'));
    const repo = join(tmp, 'simple-ui');
    cpSync(join(JCI, 'fixtures', 'simple-ui'), repo, { recursive: true, filter: (p) => !p.includes('node_modules') });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fixture');
    const configFile = join(tmp, 'repos.yaml');
    writeFileSync(configFile, `repos:\n  - id: simple-ui\n    kind: ui\n    path: ${repo.replace(/\\/g, '/')}\n`);
    const db = openDb(':memory:');
    const opts: SyncOptions = { db, jciRoot: JCI, graphDirs: [join(tmp, 'graphs')], cacheDir: join(tmp, 'graphs', 'cache'), stateDir: join(tmp, 'sync'), configFile, freshness: false };
    const status = git(repo, '--no-optional-locks', 'status', '--porcelain');
    const r = await syncGraphs(opts);
    assert.equal(r.outcome, 'PUBLISHED', JSON.stringify(r.error));
    assert.equal(action(r, 'simple-ui'), 'INDEXED');
    assert.match(r.repos[0]!.analyzerVersion ?? '', /^ui-/);
    assert.equal(r.repos[0]!.analyzerVersion, r.repos[0]!.expectedVersion);
    assert.equal(readSnapshotLine(r.repos[0]!.graphFile!).sourceMode, 'HEAD');
    assert.equal(git(repo, '--no-optional-locks', 'status', '--porcelain'), status);
    const again = await syncGraphs(opts);
    assert.equal(again.outcome, 'UP_TO_DATE');
    assert.deepEqual(readdirSync(join(tmp, 'graphs', 'cache')).filter((f) => f.endsWith('.ndjson')).length, 1);
  });
});
