import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { openDb, type DB } from '../src/db.js';
import { checkFreshness, FreshnessInputError, JAVA_CONFIG_FILES, UI_EXTENSIONS, type Freshness, type FreshnessOptions } from '../src/freshness.js';
import { loadNdjson } from '../src/loader.js';
import { resolveSnapshot } from '../src/query.js';

/**
 * Freshness matrix over temporary repositories: a bare "origin", the indexed clone ("work") and a second clone that
 * pushes ("other"). Each dimension is tested over its values, then combinations check that no dimension changes another.
 */
const JCI = resolve(import.meta.dirname, '../..');
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const JAVA_SCOPE = { sourceRoots: ['src/main/java'], schemaDirs: ['src/main/resources/db/migration'] };

interface Env { tmp: string; origin: string; work: string; other: string }
/** A fresh copy of the template repositories (git process spawns are slow on Windows; file copies are not). */
function env(): Env {
  const tmp = mkdtempSync(join(tmpdir(), 'jci-fresh-'));
  cpSync(TEMPLATE.tmp, tmp, { recursive: true });
  // Clones store the origin path in .git/config (backslashes escaped): point them at this copy's origin.
  for (const repo of ['work', 'other']) {
    const cfg = join(tmp, repo, '.git', 'config');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^(\s*url = ).*$/m, `$1${join(tmp, 'origin.git').replace(/\\/g, '/')}`));
  }
  return { tmp, origin: join(tmp, 'origin.git'), work: join(tmp, 'work'), other: join(tmp, 'other') };
}
function makeTemplate(): Env {
  const tmp = mkdtempSync(join(tmpdir(), 'jci-fresh-template-'));
  const seed = join(tmp, 'seed');
  const origin = join(tmp, 'origin.git');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  write(join(seed, 'src/main/java/a/A.java'), 'package a;\nclass A {}\n');
  write(join(seed, 'src/main/resources/application.yml'), 'x: 1\n');
  write(join(seed, 'src/main/resources/db/migration/V1__init.sql'), 'create table t (id int);\n');
  write(join(seed, 'README.md'), 'readme\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'initial');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(seed, 'push', '-q', origin, 'main');
  const work = join(tmp, 'work');
  const other = join(tmp, 'other');
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
  execFileSync('git', ['clone', '-q', origin, other], { stdio: 'ignore' });
  return { tmp, origin, work, other };
}
const TEMPLATE = makeTemplate();
const commit = (repo: string, file: string, text: string, msg = 'change') => {
  write(join(repo, file), text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
  return git(repo, 'rev-parse', 'HEAD');
};
const pushFromOther = (e: Env, branch = 'main') => {
  commit(e.other, `src/main/java/a/B${Date.now()}.java`, 'package a;\nclass B {}\n', 'remote change');
  git(e.other, 'push', '-q', 'origin', `HEAD:${branch}`);
};
const head = (repo: string) => git(repo, 'rev-parse', 'HEAD');

let nextId = 1000;
const snapOf = (repo: string | null, commitSha: string, extra: Record<string, unknown> = {}) => ({
  id: nextId++, repoId: 'r', repoPath: repo, commitSha, sourceMode: 'HEAD', engine: 'spoon-11.5.0', finishedAt: '2026-10-27T00:00:00Z', scope: { ...JAVA_SCOPE }, ...extra,
});
const db = openDb(':memory:');
const check = (snap: ReturnType<typeof snapOf>, o: FreshnessOptions = {}, d: DB = db) => checkFreshness(d, snap, { refresh: true, ...o });
const one = async (snap: ReturnType<typeof snapOf>, o?: FreshnessOptions) => (await check(snap, o)).repos[0]!;
const codes = (rs: Array<{ code: string }>) => rs.map((r) => r.code);
/** Insert a snapshot row so it can be found as an exact match or served by the API. */
function insertSnapshot(d: DB, repoId: string, commitSha: string, repoPath: string | null, scope: Record<string, unknown> = JAVA_SCOPE, sourceMode = 'HEAD'): number {
  return Number(d.prepare(`INSERT INTO snapshots (repo_id, commit_sha, repo_path, source_mode, schema_version, engine, finished_at, loaded_at, scope_json, stats_json)
    VALUES (?, ?, ?, ?, '1.2.0', 'spoon-11.5.0', '2026-10-27T00:00:00Z', '2026-10-27T00:00:00Z', ?, '{}')`).run(repoId, commitSha, repoPath, sourceMode, JSON.stringify(scope)).lastInsertRowid);
}

// Every test has its own repositories and snapshot ids (cache keys never collide), so tests run concurrently.
const PAR = { concurrency: true };

describe('A — snapshot accuracy', PAR, () => {
  test('A1 indexed = HEAD, clean, just cloned: CURRENT / UP_TO_DATE / RECENT / CLEAN', async () => {
    const e = env();
    const r = await one(snapOf(e.work, head(e.work)));
    assert.equal(r.status, 'CURRENT');
    assert.deepEqual([r.accuracy.status, r.branch.status, r.remote.status, r.worktree.status], ['CURRENT', 'UP_TO_DATE', 'RECENT', 'CLEAN']);
    assert.equal(r.accuracy.selected.branch, 'main');
    assert.equal(r.branch.upstream, 'origin/main');
    assert.equal(r.branch.default.branch, 'origin/main');
    assert.equal(r.branch.default.relation, 'SAME');
  });

  test('A2 local commit after indexing: STALE with counts; branch AHEAD', async () => {
    const e = env();
    const indexed = head(e.work);
    commit(e.work, 'src/main/java/a/C.java', 'package a;\nclass C {}\n');
    const r = await one(snapOf(e.work, indexed));
    assert.equal(r.accuracy.status, 'STALE');
    assert.deepEqual(codes(r.accuracy.reasons), ['INDEXED_COMMIT_DIFFERS']);
    assert.deepEqual([r.accuracy.indexedAheadOfSelected, r.accuracy.indexedBehindSelected], [0, 1]);
    assert.deepEqual([r.branch.status, r.branch.ahead, r.branch.behind], ['AHEAD', 1, 0]);
    assert.equal(r.worktree.status, 'CLEAN');
  });

  test('A3 selected revision is another branch: STALE for that revision', async () => {
    const e = env();
    const indexed = head(e.work);
    git(e.work, 'checkout', '-q', '-b', 'feature');
    const feat = commit(e.work, 'src/main/java/a/F.java', 'package a;\nclass F {}\n');
    git(e.work, 'checkout', '-q', 'main');
    const cur = await one(snapOf(e.work, indexed));
    assert.equal(cur.accuracy.status, 'CURRENT', 'HEAD (main) still matches');
    const r = await one(snapOf(e.work, indexed), { revs: { r: 'feature' } });
    assert.equal(r.accuracy.status, 'STALE');
    assert.equal(r.accuracy.selected.commit, feat);
    assert.equal(r.accuracy.selected.branch, 'feature');
    assert.equal(r.branch.status, 'NO_UPSTREAM', 'feature was never pushed');
  });

  test('A4 another loaded snapshot matches the selected commit: matchingSnapshotId', async () => {
    const e = env();
    const d = openDb(':memory:');
    const indexed = head(e.work);
    git(e.work, 'checkout', '-q', '-b', 'feature');
    const feat = commit(e.work, 'src/main/java/a/F.java', 'x');
    git(e.work, 'checkout', '-q', 'main');
    const served = insertSnapshot(d, 'r', indexed, e.work);
    const match = insertSnapshot(d, 'r', feat, e.work);
    insertSnapshot(d, 'r', feat, e.work, { ...JAVA_SCOPE, w: 1 }, 'WORKTREE'); // working-tree snapshots never count as exact
    const f = await check(resolveSnapshot(d, served)! as never, { revs: { r: 'feature' } }, d);
    assert.equal(f.status, 'STALE');
    assert.equal(f.matchingSnapshotId, match);
    assert.ok(codes(f.repos[0]!.accuracy.reasons).includes('MATCHING_SNAPSHOT_AVAILABLE'));
  });

  test('A5 unresolvable revision is UNKNOWN; option-like or range input is rejected', async () => {
    const e = env();
    const r = await one(snapOf(e.work, head(e.work)), { revs: { r: 'does-not-exist' } });
    assert.equal(r.accuracy.status, 'UNKNOWN');
    assert.deepEqual(codes(r.accuracy.reasons), ['SELECTED_REVISION_UNRESOLVED']);
    for (const bad of ['--upload-pack=x', '-n', 'a..b', 'HEAD@{1}', 'a b', 'x;rm', '']) {
      if (!bad) continue;
      await assert.rejects(() => check(snapOf(e.work, head(e.work)), { revs: { r: bad } }), FreshnessInputError, bad);
    }
    await assert.rejects(() => check(snapOf(e.work, head(e.work)), { revs: { nope: 'main' } }), FreshnessInputError);
  });

  test('A6 cannot check: no path, missing folder, nogit snapshot, not a repo, WORKTREE snapshot', async () => {
    const e = env();
    const plain = mkdtempSync(join(tmpdir(), 'jci-plain-'));
    const cases: Array<[ReturnType<typeof snapOf>, string]> = [
      [snapOf(null, 'abc'), 'NO_REPO_PATH'],
      [snapOf(join(e.tmp, 'missing'), 'abc'), 'REPO_MISSING'],
      [snapOf(e.work, 'nogit-123456'), 'NOT_A_GIT_REPO'],
      [snapOf(plain, 'abc'), 'NOT_A_GIT_REPO'],
    ];
    for (const [s, code] of cases) {
      const r = await one(s);
      assert.deepEqual([r.accuracy.status, r.branch.status, r.remote.status, r.worktree.status], ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'], code);
      assert.deepEqual(codes(r.accuracy.reasons), [code]);
    }
    const w = await one(snapOf(e.work, head(e.work), { sourceMode: 'WORKTREE' }));
    assert.equal(w.accuracy.status, 'UNKNOWN');
    assert.deepEqual(codes(w.accuracy.reasons), ['WORKTREE_SNAPSHOT']);
    assert.equal(w.worktree.status, 'UNKNOWN');
    assert.equal(w.branch.status, 'UP_TO_DATE', 'branch currency is still reported');
  });
});

describe('B — branch currency (independent of accuracy)', PAR, () => {
  test('B1 remote moved and was fetched: snapshot CURRENT, branch BEHIND 1, default BEHIND', async () => {
    const e = env();
    pushFromOther(e);
    git(e.work, 'fetch', '-q');
    const r = await one(snapOf(e.work, head(e.work)));
    assert.equal(r.accuracy.status, 'CURRENT');
    assert.deepEqual([r.branch.status, r.branch.ahead, r.branch.behind], ['BEHIND', 0, 1]);
    assert.deepEqual([r.branch.default.relation, r.branch.default.behind], ['BEHIND', 1]);
    assert.equal(r.remote.status, 'RECENT');
  });

  test('B2 feature branch ahead of default with its upstream pushed: not stale, default AHEAD (info)', async () => {
    const e = env();
    git(e.work, 'checkout', '-q', '-b', 'feat');
    commit(e.work, 'src/main/java/a/F.java', 'x');
    git(e.work, 'push', '-q', '-u', 'origin', 'feat');
    const r = await one(snapOf(e.work, head(e.work)));
    assert.deepEqual([r.accuracy.status, r.branch.status, r.branch.upstream], ['CURRENT', 'UP_TO_DATE', 'origin/feat']);
    assert.deepEqual([r.branch.default.relation, r.branch.default.ahead, r.branch.default.behind], ['AHEAD', 1, 0]);
  });

  test('B3 branch diverged from default: reported, never STALE', async () => {
    const e = env();
    git(e.work, 'checkout', '-q', '-b', 'feat');
    commit(e.work, 'src/main/java/a/F.java', 'x');
    git(e.work, 'push', '-q', '-u', 'origin', 'feat');
    pushFromOther(e);
    git(e.work, 'fetch', '-q');
    const r = await one(snapOf(e.work, head(e.work)));
    assert.equal(r.accuracy.status, 'CURRENT');
    assert.equal(r.branch.status, 'UP_TO_DATE');
    assert.deepEqual([r.branch.default.relation, r.branch.default.ahead, r.branch.default.behind], ['DIVERGED', 1, 1]);
  });

  test('B4 local branch without upstream: NO_UPSTREAM', async () => {
    const e = env();
    git(e.work, 'checkout', '-q', '-b', 'local-only');
    const r = await one(snapOf(e.work, head(e.work)));
    assert.deepEqual([r.accuracy.status, r.branch.status], ['CURRENT', 'NO_UPSTREAM']);
    assert.equal(r.branch.default.relation, 'SAME');
  });

  test('B5 live: remote moved, not fetched: BEHIND with unknown count, remote VERIFIED', async () => {
    const e = env();
    pushFromOther(e);
    const r = await one(snapOf(e.work, head(e.work)), { remote: 'live' });
    assert.equal(r.accuracy.status, 'CURRENT');
    assert.equal(r.remote.status, 'VERIFIED');
    assert.equal(r.branch.source, 'ls-remote');
    assert.deepEqual([r.branch.status, r.branch.behind], ['BEHIND', null]);
    assert.ok(codes(r.branch.reasons).includes('REMOTE_MOVED_NOT_FETCHED'));
    assert.equal(r.branch.upstreamCommit, head(e.other));
    // ls-remote --symref prints "ref: refs/heads/x<TAB>HEAD" before HEAD's sha: the sha must be used, not the symref.
    assert.equal(r.remote.lastVerified?.defaultCommit, head(e.other));
    assert.equal(r.branch.default.commit, head(e.other));
    assert.equal(r.branch.default.relation, 'BEHIND');
    assert.equal(existsSync(join(e.work, '.git', 'FETCH_HEAD')), false, 'live check must not fetch');
  });
});

describe('R — remote currency (never changes local results)', PAR, () => {
  test('R1 tracking refs older than the max age: remote UNKNOWN, snapshot stays CURRENT', async () => {
    const e = env();
    const r = await one(snapOf(e.work, head(e.work)), { now: () => Date.now() + 25 * 3_600_000 });
    assert.equal(r.accuracy.status, 'CURRENT');
    assert.equal(r.remote.status, 'UNKNOWN');
    assert.deepEqual(codes(r.remote.reasons), ['REMOTE_INFO_OUTDATED']);
    assert.equal(r.branch.status, 'UP_TO_DATE', 'counts still shown, labelled with their as-of time');
    assert.ok(r.branch.asOf);
    const custom = await one(snapOf(e.work, head(e.work)), { now: () => Date.now() + 2 * 3_600_000, maxRemoteAgeHours: 1 });
    assert.equal(custom.remote.status, 'UNKNOWN', 'max age is configurable');
  });

  test('R2 remote never fetched: REMOTE_NEVER_FETCHED', async () => {
    const e = env();
    const repo = join(e.tmp, 'fresh');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    commit(repo, 'src/main/java/a/A.java', 'x');
    git(repo, 'remote', 'add', 'origin', e.origin);
    const r = await one(snapOf(repo, head(repo)));
    assert.equal(r.accuracy.status, 'CURRENT');
    assert.deepEqual([r.remote.status, codes(r.remote.reasons)], ['UNKNOWN', ['REMOTE_NEVER_FETCHED']]);
    assert.equal(r.branch.status, 'NO_UPSTREAM');
  });

  test('R3 live check fails (no such remote; timeout): remote UNKNOWN, local results kept', async () => {
    for (const mode of ['missing', 'timeout'] as const) {
      const e = env();
      if (mode === 'missing') git(e.work, 'remote', 'set-url', 'origin', join(e.tmp, 'gone.git'));
      const r = await one(snapOf(e.work, head(e.work)), { remote: 'live', liveTimeoutMs: mode === 'timeout' ? 1 : 8000 });
      assert.equal(r.accuracy.status, 'CURRENT', mode);
      assert.equal(r.worktree.status, 'CLEAN', mode);
      assert.equal(r.remote.status, 'UNKNOWN', mode);
      assert.deepEqual(codes(r.remote.reasons), ['REMOTE_UNAVAILABLE'], mode);
      assert.equal(r.branch.status, 'UP_TO_DATE', `${mode}: cached tracking-ref counts kept`);
      assert.equal(r.branch.source, 'tracking-ref');
      if (mode === 'timeout') assert.match(r.remote.reasons[0]!.message, /timed out/);
    }
  });

  test('R4 live success then failure keeps lastVerified', async () => {
    const e = env();
    const s = snapOf(e.work, head(e.work));
    const ok = await one(s, { remote: 'live' });
    assert.equal(ok.remote.status, 'VERIFIED');
    git(e.work, 'remote', 'set-url', 'origin', join(e.tmp, 'gone.git'));
    const bad = await one(s, { remote: 'live' });
    assert.equal(bad.remote.status, 'UNKNOWN');
    assert.equal(bad.remote.lastVerified?.checkedAt, ok.remote.lastVerified?.checkedAt);
    assert.equal(bad.remote.lastVerified?.upstreamCommit, head(e.work));
  });

  test('R5 no remote: NOT_APPLICABLE and NO_UPSTREAM, snapshot CURRENT', async () => {
    const e = env();
    const repo = join(e.tmp, 'solo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    commit(repo, 'src/main/java/a/A.java', 'x');
    const r = await one(snapOf(repo, head(repo)));
    assert.deepEqual([r.accuracy.status, r.branch.status, r.remote.status, r.worktree.status], ['CURRENT', 'NO_UPSTREAM', 'NOT_APPLICABLE', 'CLEAN']);
    assert.deepEqual(codes(r.remote.reasons), ['NO_REMOTE']);
  });
});

describe('W — working tree (analyzer scope only; never changes accuracy)', PAR, () => {
  test('W1 edited .java under the source root: MODIFIED with warning, snapshot CURRENT', async () => {
    const e = env();
    write(join(e.work, 'src/main/java/a/A.java'), 'package a;\nclass A { int x; }\n');
    const r = await one(snapOf(e.work, head(e.work)));
    assert.equal(r.accuracy.status, 'CURRENT');
    assert.deepEqual([r.worktree.status, r.worktree.changedInScope, r.worktree.sample], ['MODIFIED', 1, ['src/main/java/a/A.java']]);
    assert.match(r.worktree.warning!, /does not include 1 uncommitted source change/);
  });

  test('W2 new migration .sql in schemaDirs and edited application.yml are in scope', async () => {
    const e = env();
    write(join(e.work, 'src/main/resources/db/migration/V2__x.sql'), 'alter table t add c int;\n');
    write(join(e.work, 'src/main/resources/application.yml'), 'x: 2\n');
    const r = await one(snapOf(e.work, head(e.work)));
    assert.deepEqual([r.worktree.status, r.worktree.changedInScope], ['MODIFIED', 2]);
  });

  test('W3 unrelated and generated files are out of scope: CLEAN', async () => {
    const e = env();
    write(join(e.work, '.claude/skills/x.md'), 'x');
    write(join(e.work, 'target/classes/a/A.class'), 'x');
    write(join(e.work, 'README.md'), 'changed\n');
    write(join(e.work, 'src/main/java/a/notes.txt'), 'x');
    write(join(e.work, 'src/main/resources/other.properties'), 'y=1');
    const r = await one(snapOf(e.work, head(e.work)));
    assert.equal(r.worktree.status, 'CLEAN');
    assert.equal(r.worktree.changedInScope, 0);
    assert.ok(r.worktree.changedOutsideScope >= 4, String(r.worktree.changedOutsideScope));
    assert.equal(r.worktree.warning, null);
  });

  test('W4 UI repository: .vue under src is in scope; node_modules and other roots are not', async () => {
    const e = env();
    const repo = join(e.tmp, 'ui');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    commit(repo, 'src/App.vue', '<template/>');
    const ui = (extra = {}) => snapOf(repo, head(repo), { engine: 'typescript-5.9+vue-compiler-sfc-3.5', scope: { sourceRoots: ['src', 'test'] }, ...extra });
    write(join(repo, 'src/node_modules/x/index.js'), 'x');
    write(join(repo, 'dist/app.js'), 'x');
    write(join(repo, 'src/styles.css'), 'x');
    assert.equal((await one(ui())).worktree.status, 'CLEAN');
    write(join(repo, 'src/App.vue'), '<template><div/></template>');
    write(join(repo, 'test/unit/a.spec.js'), 'x');
    const r = await one(ui());
    assert.deepEqual([r.worktree.status, r.worktree.changedInScope], ['MODIFIED', 2]);
  });

  test('W5 git status fails: working tree UNKNOWN, accuracy unaffected', async () => {
    const e = env();
    writeFileSync(join(e.work, '.git', 'index'), 'not an index');
    const r = await one(snapOf(e.work, head(e.work)));
    assert.equal(r.accuracy.status, 'CURRENT');
    assert.equal(r.worktree.status, 'UNKNOWN');
    assert.deepEqual(codes(r.worktree.reasons), ['GIT_ERROR']);
  });
});

describe('X — combinations', PAR, () => {
  test('X1 system snapshot: one CURRENT and one STALE repository → snapshot STALE, repositories separate', async () => {
    const a = env();
    const b = env();
    const indexedB = head(b.work);
    commit(b.work, 'src/App.vue', 'x');
    const f = await check(snapOf(a.work, head(a.work), {
      repoId: 'sys', scope: { ...JAVA_SCOPE, repos: [
        { repoId: 'core', role: 'backend', repoPath: a.work, commitSha: head(a.work), sourceMode: 'HEAD', sourceRoots: ['src/main/java'], pathPrefix: '', finishedAt: '2026-10-27T01:00:00Z' },
        { repoId: 'ui', role: 'frontend', repoPath: b.work, commitSha: indexedB, sourceMode: 'HEAD', sourceRoots: ['src'], pathPrefix: '@ui/' },
      ] },
    }));
    assert.equal(f.status, 'STALE');
    assert.deepEqual(f.repos.map((r) => [r.repoId, r.status]), [['core', 'CURRENT'], ['ui', 'STALE']]);
    assert.deepEqual(f.repos.map((r) => r.timestampSource), ['repo', 'snapshot']);
  });

  test('X2 STALE + MODIFIED + remote failure at once: each reported on its own', async () => {
    const e = env();
    const indexed = head(e.work);
    commit(e.work, 'src/main/java/a/C.java', 'x');
    write(join(e.work, 'src/main/java/a/A.java'), 'changed');
    git(e.work, 'remote', 'set-url', 'origin', join(e.tmp, 'gone.git'));
    const r = await one(snapOf(e.work, indexed), { remote: 'live' });
    assert.deepEqual([r.accuracy.status, r.branch.status, r.remote.status, r.worktree.status], ['STALE', 'AHEAD', 'UNKNOWN', 'MODIFIED']);
  });

  test('worst-of: STALE beats UNKNOWN beats CURRENT', async () => {
    const e = env();
    const scope = (commits: string[]) => ({ ...JAVA_SCOPE, repos: commits.map((c, i) => ({ repoId: `r${i}`, role: 'backend', repoPath: c === 'none' ? null : e.work, commitSha: c, sourceMode: 'HEAD', pathPrefix: i ? `@r${i}/` : '' })) });
    const h = head(e.work);
    assert.equal((await check(snapOf(e.work, h, { scope: scope([h, 'none']) }))).status, 'UNKNOWN');
    assert.equal((await check(snapOf(e.work, h, { scope: scope([h, 'none', 'f'.repeat(40)]) }))).status, 'STALE');
    assert.equal((await check(snapOf(e.work, h, { scope: scope([h, h]) }))).status, 'CURRENT');
  });
});

describe('S — safety', PAR, () => {
  test('S1 credentials never appear in the response', async () => {
    const e = env();
    git(e.work, 'remote', 'set-url', 'origin', 'https://someuser:s3cr3t-tok@127.0.0.1:9/x.git');
    const f = await check(snapOf(e.work, head(e.work)), { remote: 'live', liveTimeoutMs: 5000 });
    const text = JSON.stringify(f);
    assert.doesNotMatch(text, /s3cr3t-tok|someuser/);
    assert.equal(f.repos[0]!.remote.url, 'https://127.0.0.1:9/x.git');
    assert.equal(f.repos[0]!.remote.status, 'UNKNOWN');
  });

  test('S2 read-only: index, refs, status and FETCH_HEAD unchanged by cached and live checks', async () => {
    const e = env();
    write(join(e.work, 'src/main/java/a/A.java'), 'dirty');
    const before = { index: statSync(join(e.work, '.git', 'index')).mtimeMs, refs: git(e.work, 'for-each-ref'), status: git(e.work, '--no-optional-locks', 'status', '--porcelain'), fetch: existsSync(join(e.work, '.git', 'FETCH_HEAD')) };
    pushFromOther(e);
    await check(snapOf(e.work, head(e.work)));
    await check(snapOf(e.work, head(e.work)), { remote: 'live' });
    await check(snapOf(e.work, head(e.work)), { revs: { r: 'origin/main' } });
    const after = { index: statSync(join(e.work, '.git', 'index')).mtimeMs, refs: git(e.work, 'for-each-ref'), status: git(e.work, '--no-optional-locks', 'status', '--porcelain'), fetch: existsSync(join(e.work, '.git', 'FETCH_HEAD')) };
    assert.deepEqual(after, before);
  });

  test('I5 drift guard: scope constants mirror the analyzers', () => {
    const uiSrc = readFileSync(join(JCI, 'analyzer-ui/src/source.ts'), 'utf8');
    const m = /export const EXTENSIONS = \[([^\]]*)\]/.exec(uiSrc);
    assert.ok(m, 'EXTENSIONS not found in analyzer-ui/src/source.ts');
    assert.deepEqual(m[1]!.split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean), UI_EXTENSIONS);
    const javaCfg = readFileSync(join(JCI, 'analyzer-java/src/main/java/com/jci/analyzer/source/AnalyzerConfig.java'), 'utf8');
    const props = /DEFAULT_PROPERTY_FILES = List\.of\(([^)]*)\)/.exec(javaCfg);
    assert.ok(props, 'DEFAULT_PROPERTY_FILES not found in AnalyzerConfig.java');
    assert.deepEqual(props[1]!.split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean), JAVA_CONFIG_FILES);
  });
});

describe('I — API and CLI integration', PAR, () => {
  const H = { host: '127.0.0.1:4317' };

  test('I1 GET /api/v1/freshness: envelope, validation, guard, cache and refresh', async () => {
    const e = env();
    const d = openDb(':memory:');
    const id = insertSnapshot(d, 'r', head(e.work), e.work);
    const app = buildApp(d);
    const get = (url: string, headers = H) => app.inject({ method: 'GET', url, headers });
    const ok = await get(`/api/v1/freshness?snapshot=${id}`);
    assert.equal(ok.statusCode, 200, ok.body);
    const body = ok.json() as { apiVersion: string; snapshot: { id: number }; data: Freshness };
    assert.equal(body.snapshot.id, id);
    assert.equal(body.data.status, 'CURRENT');
    assert.equal(body.data.repos[0]!.accuracy.status, 'CURRENT');
    for (const bad of ['remote=bogus', 'refresh=maybe', 'rev.r=--upload-pack%3Dx', 'rev.nope=main', 'rev.r=a&rev.r=b']) {
      assert.equal((await get(`/api/v1/freshness?snapshot=${id}&${bad}`)).statusCode, 400, bad);
    }
    assert.equal((await get(`/api/v1/freshness?snapshot=${id}`, { host: 'attacker.example' })).statusCode, 403);
    const again = (await get(`/api/v1/freshness?snapshot=${id}`)).json() as typeof body;
    assert.equal(again.data.checkedAt, body.data.checkedAt, 'served from cache');
    await new Promise((r) => setTimeout(r, 5));
    const fresh = (await get(`/api/v1/freshness?snapshot=${id}&refresh=true`)).json() as typeof body;
    assert.notEqual(fresh.data.checkedAt, body.data.checkedAt, 'refresh=true bypasses the cache');
    const sel = (await get(`/api/v1/freshness?snapshot=${id}&rev.r=does-not-exist`)).json() as typeof body;
    assert.equal(sel.data.repos[0]!.accuracy.status, 'UNKNOWN');
    await app.close();
  });

  test('I2 X-JCI-Snapshot-Status: UNKNOWN before any check, then the cached accuracy', async () => {
    const e = env();
    const d = openDb(':memory:');
    const indexed = head(e.work);
    commit(e.work, 'src/main/java/a/C.java', 'x');
    const id = insertSnapshot(d, 'r', indexed, e.work);
    const app = buildApp(d);
    const first = await app.inject({ method: 'GET', url: `/api/v1/endpoints?snapshot=${id}`, headers: H });
    assert.equal(first.headers['x-jci-snapshot-status'], 'UNKNOWN');
    await app.inject({ method: 'GET', url: `/api/v1/freshness?snapshot=${id}&refresh=true`, headers: H });
    const later = await app.inject({ method: 'GET', url: `/api/v1/search?snapshot=${id}&q=x`, headers: H });
    assert.equal(later.headers['x-jci-snapshot-status'], 'STALE');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/health', headers: H })).headers['x-jci-snapshot-status'], undefined, 'only snapshot-scoped routes');
    await app.close();
  });

  test('I3 impact on a modified working tree records freshness and LOCAL_MODIFICATIONS_NOT_INDEXED', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'jci-fresh-impact-'));
    const repo = join(tmp, 'simple-rest');
    cpSync(join(JCI, 'fixtures/simple-rest'), repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fixture');
    const d = openDb(':memory:');
    await loadNdjson(d, join(JCI, 'server/test/data/simple-rest.ndjson'), { repoPath: repo });
    d.prepare(`UPDATE snapshots SET commit_sha = ?, source_mode = 'HEAD'`).run(head(repo));
    const dao = join(repo, 'src/main/java/com/example/shop/dao/impl/OrderDaoImpl.java');
    writeFileSync(dao, readFileSync(dao, 'utf8') + '\n// local edit\n');
    const app = buildApp(d);
    const res = await app.inject({ method: 'POST', url: '/api/v1/impact', headers: H,
      payload: { targets: ['method:com.example.shop.dao.impl.OrderDaoImpl#findById(java.lang.Long)'] } });
    assert.equal(res.statusCode, 200, res.body);
    const report = (res.json() as { data: any }).data;
    assert.equal(report.freshness.status, 'CURRENT');
    assert.equal(report.freshness.repos[0].worktree, 'MODIFIED');
    assert.ok(report.unknowns.some((u: any) => u.kind === 'LOCAL_MODIFICATIONS_NOT_INDEXED' && /OrderDaoImpl\.java/.test(u.detail)));
    assert.equal(report.gates.find((g: any) => g.id === 'TRACEABILITY' || /trace/i.test(g.id + g.title))?.status, 'NEEDS_HUMAN');
    assert.ok(report.upstream.entryPoints.length > 0, 'impact results unchanged');
    const bundle = await app.inject({ method: 'POST', url: '/api/v1/export/context', headers: H,
      payload: { targets: ['method:com.example.shop.dao.impl.OrderDaoImpl#findById(java.lang.Long)'] } });
    assert.match((bundle.json() as { data: { files: Record<string, string> } }).data.files['impact-analysis.md']!, /## Source freshness[\s\S]*MODIFIED/);
    await app.close();
  });

  test('I4 CLI --status keeps current/repoHead and adds the four dimensions; --rev and --remote', () => {
    const e = env();
    const dbFile = join(e.tmp, 'cli.db');
    const d = openDb(dbFile);
    const indexed = head(e.work);
    insertSnapshot(d, 'r', indexed, e.work);
    d.close();
    git(e.work, 'branch', 'other-branch');
    commit(e.work, 'src/main/java/a/C.java', 'x');
    const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/impact.ts', '--db', dbFile, '--repo', 'r', '--status', ...args],
      { cwd: join(JCI, 'server'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const j = run();
    assert.equal(j.current, false);
    assert.equal(j.repoHead, head(e.work));
    assert.equal(j.status, 'STALE');
    assert.equal(j.accuracy.status, 'STALE');
    assert.ok(j.branch && j.remote && j.worktree);
    const k = run('--rev', 'r=other-branch', '--remote', 'live');
    assert.equal(k.status, 'CURRENT', 'other-branch is the indexed commit');
    assert.equal(k.current, false, 'current keeps its HEAD meaning');
    assert.equal(k.remoteMode, 'live');
    assert.throws(() => run('--rev', 'r=--evil'));
  });
});
