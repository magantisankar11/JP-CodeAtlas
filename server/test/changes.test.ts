import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { before, describe, test } from 'node:test';
import { analyzeChanges, type ChangeRunOptions } from '../src/changes/run.js';
import { parseUnifiedDiff, resolveChange } from '../src/changes/git.js';
import { openDb, type DB } from '../src/db.js';
import type { SnapshotInfo } from '../src/impact/engine.js';
import { renderImpactMarkdown } from '../src/impact/render.js';
import { loadNdjson } from '../src/loader.js';
import { combineGraphs } from '../src/multi/combine.js';
import { resolveSnapshot } from '../src/query.js';

const JCI = resolve(import.meta.dirname, '../..');
const CORE = resolve(import.meta.dirname, 'data/simple-rest.ndjson');
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const status = (repo: string) => git(repo, 'status', '--porcelain=v1');

describe('unified diff parsing', () => {
  test('ranges on both sides, insertions, deletions, new files and renames', () => {
    const files = parseUnifiedDiff([
      'diff --git a/A.java b/A.java', '--- a/A.java', '+++ b/A.java', '@@ -178 +178 @@ x', '@@ -179,0 +180 @@ y', '@@ -10,3 +11,0 @@ z',
      'diff --git a/n.js b/n.js', 'new file mode 100644', '--- /dev/null', '+++ b/n.js', '@@ -0,0 +1,4 @@',
      'diff --git a/o.js b/p.js', 'similarity index 90%', 'rename from o.js', 'rename to p.js', '--- a/o.js', '+++ b/p.js', '@@ -2 +2 @@',
    ].join('\n'));
    assert.deepEqual(files.map((f) => [f.status, f.oldPath, f.newPath, f.oldRanges, f.newRanges]), [
      ['M', 'A.java', 'A.java', [[178, 178], [10, 12]], [[178, 178], [180, 180]]],
      ['A', null, 'n.js', [], [[1, 4]]],
      ['R', 'o.js', 'p.js', [[2, 2]], [[2, 2]]],
    ]);
  });
});

describe('change-based impact (UI branch against an unchanged Core)', () => {
  let tmp: string;
  let repo: string;
  let current: SnapshotInfo;
  let opts: ChangeRunOptions;
  let mainDb: DB;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'jci-changes-'));
    repo = join(tmp, 'ui');
    cpSync(resolve(JCI, 'fixtures/simple-ui'), repo, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'initial');
    git(repo, 'checkout', '-q', '-b', 'bug/JP-1');
    const svc = join(repo, 'src/services/shop-service.js');
    writeFileSync(svc, readFileSync(svc, 'utf8').replace("const url = 'api/orders/' + orderId", "const url = 'api/order/' + orderId"));
    const page = join(repo, 'src/pages/OrderPage.vue');
    writeFileSync(page, readFileSync(page, 'utf8').replace('<button @click="remove">Delete</button>', '<button @click="remove">Remove</button>'));
    git(repo, 'commit', '-q', '-am', 'fix(JP-1): rename order URL');
    git(repo, 'checkout', '-q', 'main');

    // Current system snapshot: simple-rest (Core) + the UI at main.
    const graphs = join(tmp, 'graphs');
    mkdirSync(graphs);
    cpSync(CORE, join(graphs, 'simple-rest.ndjson'));
    execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--repo', repo, '--repo-id', 'simple-ui', '--out', join(graphs, 'ui-main.ndjson')],
      { cwd: join(JCI, 'analyzer-ui'), stdio: ['ignore', 'pipe', 'pipe'] });
    await combineGraphs(join(graphs, 'simple-rest.ndjson'), join(graphs, 'ui-main.ndjson'), join(graphs, 'system.ndjson'), { systemId: 'shop-system' });
    mainDb = openDb(':memory:');
    await loadNdjson(mainDb, join(graphs, 'system.ndjson'));
    current = resolveSnapshot(mainDb)!;
    opts = { jciRoot: JCI, graphDirs: [graphs], cacheDir: join(tmp, 'cache'), db: openDb(join(tmp, 'changes.db')), log: () => {} };
  });

  test('branch base is the merge-base with the default branch', () => {
    const r = resolveChange(repo, 'bug/JP-1');
    assert.equal(r.baseSha, git(repo, 'rev-parse', 'main').trim());
    assert.deepEqual(r.commits.map((c) => c.subject), ['fix(JP-1): rename order URL']);
    assert.equal(resolveChange(repo, 'main..bug/JP-1').baseSha, r.baseSha);
    assert.throws(() => resolveChange(repo, 'bug/NOPE'), /not a branch or commit/);
  });

  test('changed declarations, lost UI link, impact on the base graph; repository untouched', async () => {
    const before = status(repo);
    const head = git(repo, 'rev-parse', 'HEAD');
    const { report, change } = await analyzeChanges(current, { ui: 'bug/JP-1' }, opts);
    assert.equal(status(repo), before, 'git status unchanged');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'nothing checked out');

    assert.deepEqual(change.repos.map((r) => [r.repoId, r.mode, r.commits.length, r.files.length]), [['simple-rest', 'unchanged', 0, 0], ['simple-ui', 'commits', 1, 2]]);
    const nodes = Object.fromEntries(change.nodes.map((n) => [n.id, n.change]));
    assert.equal(nodes['ui:fn:src/services/shop-service.js#ShopService.getOrder'], 'MODIFIED');
    assert.equal(nodes['ui:file:src/pages/OrderPage.vue'], 'MODIFIED', 'template edit maps to the component');
    const lost = change.uiLinks.filter((u) => u.change === 'LINK_LOST');
    assert.deepEqual(lost.map((u) => [u.before, u.urlBefore]), [[['endpoint:GET /api/orders/{orderId}'], '{base}api/orders/${?}']]);

    assert.ok(report);
    assert.equal(change.analysedOn, 'base');
    assert.ok(report.risks.some((k) => k.id === 'R-CHANGE-UI-LINK-LOST' && k.classification === 'CONFIRMED_DEPENDENCY'));
    assert.ok(report.ui?.routes.some((r) => r.name === '/orders/:id'), 'routed screen of the changed code');
    assert.match(renderImpactMarkdown(report, 'JP-1'), /## Change set[\s\S]*LINK_LOST/);
  });

  test('uncommitted changes ("working")', async () => {
    git(repo, 'checkout', '-q', 'bug/JP-1');
    const svc = join(repo, 'src/services/shop-service.js');
    const original = readFileSync(svc, 'utf8');
    writeFileSync(svc, original.replace("return axios.post(`${apiBase()}api/orders`, order)", "return axios.post(`${apiBase()}api/orders`, { ...order })"));
    try {
      const { change, report } = await analyzeChanges(current, { ui: 'working' }, opts);
      assert.equal(change.repos[1]!.mode, 'worktree');
      assert.deepEqual(change.nodes.map((n) => [n.id, n.change]), [['ui:fn:src/services/shop-service.js#ShopService.createOrder', 'MODIFIED']]);
      assert.ok(report!.unknowns.some((u) => u.kind === 'CHANGE_WORKTREE'));
    } finally {
      writeFileSync(svc, original);
      git(repo, 'checkout', '-q', 'main');
    }
  });

  test('a change that touches no declaration yields no impact, never invented targets', async () => {
    git(repo, 'checkout', '-q', '-b', 'docs-only', 'main');
    writeFileSync(join(repo, 'README.md'), 'notes\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'docs');
    git(repo, 'checkout', '-q', 'main');
    const { report, change, note } = await analyzeChanges(current, { ui: 'docs-only' }, opts);
    assert.equal(report, null);
    assert.match(note!, /no indexed declaration/);
    assert.deepEqual(change.repos[1]!.outsideRoots, ['README.md']);
  });
});
