import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { before, describe, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { openDb, type DB } from '../src/db.js';
import { renderImpactMarkdown } from '../src/impact/render.js';
import { analyzeImpact, type SnapshotInfo } from '../src/impact/engine.js';
import { loadNdjson } from '../src/loader.js';
import { stitch, type Endpoint, type Part } from '../src/multi/stitch.js';
import { resolveSnapshot } from '../src/query.js';

const CORE = resolve(import.meta.dirname, 'data/simple-rest.ndjson');
const UI = resolve(import.meta.dirname, 'data/simple-ui.ndjson');
const CORE_REPO = resolve(import.meta.dirname, '../../fixtures/simple-rest');
const OPTS = { coreBases: ['process.env.JP_API'], contextPath: '/shop' };
const lit = (v: string): Part => ({ t: 'lit', v });
const base: Part = { t: 'base', v: 'process.env.JP_API' };
const dyn = (v: string): Part => ({ t: 'dyn', v });
const call = (id: string, httpMethod: string | null, parts: Part[], variants?: Part[][]) => ({ id, httpMethod, parts, variants, filePath: 'x.js', line: 1, endLine: 1, column: 1 });

const EPS: Endpoint[] = [
  { id: 'e:get-one', httpMethod: 'GET', path: '/api/orders/{orderId}' },
  { id: 'e:search', httpMethod: 'GET', path: '/api/orders/search' },
  { id: 'e:search2', httpMethod: 'GET', path: '/api/orders/search/v2' },
  { id: 'e:quote', httpMethod: 'POST', path: '/api/orders/quote' },
  { id: 'e:a', httpMethod: 'GET', path: '/api/x/{a}' },
  { id: 'e:b', httpMethod: 'GET', path: '/api/x/{b}' },
];

describe('stitch (UI URL → endpoint)', () => {
  const run = (...calls: ReturnType<typeof call>[]) => stitch(EPS, calls, OPTS);

  test('a dynamic segment binds to a URI variable: framework-derived', () => {
    const r = run(call('c', 'GET', [base, lit('api/orders/'), dyn('id')]));
    assert.deepEqual(r.links.map((l) => [l.endpoint, l.resolution, l.rule]), [['e:get-one', 'FRAMEWORK_DERIVED', 'UI_HTTP_PATH_PARAM_MATCH']]);
  });

  test('Spring specificity: a literal path beats {var}; context path and query string are stripped', () => {
    const r = run(call('c', 'GET', [base, lit('/shop/api/orders/search?page=2')]));
    assert.deepEqual(r.links.map((l) => [l.endpoint, l.resolution]), [['e:search', 'FRAMEWORK_DERIVED']]);
  });

  test('conditional URL variants each link, marked conditional', () => {
    const r = run(call('c', 'GET', [base, lit('api/orders/search')], [[base, lit('api/orders/search')], [base, lit('api/orders/search/v2')]]));
    assert.deepEqual(r.links.map((l) => [l.endpoint, l.conditional]).sort(), [['e:search', true], ['e:search2', true]]);
  });

  test('equally specific patterns tie: ambiguous, never a guess', () => {
    const r = run(call('c', 'GET', [base, lit('api/x/'), dyn('id')]));
    assert.deepEqual(r.links.map((l) => [l.endpoint, l.resolution]).sort(), [['e:a', 'AMBIGUOUS'], ['e:b', 'AMBIGUOUS']]);
  });

  test('a dynamic part inside a literal segment is only a partial (ambiguous) match', () => {
    const r = run(call('c', 'GET', [base, lit('api/orders/sea'), dyn('suffix')]));
    assert.ok(r.links.some((l) => l.endpoint === 'e:search' && l.resolution === 'AMBIGUOUS' && l.rule === 'UI_HTTP_PATH_PARTIAL'));
  });

  test('no edge is invented: mismatch, missing, other service and runtime URLs become diagnostics', () => {
    const r = run(
      call('put', 'PUT', [base, lit('api/orders/quote')]),
      call('missing', 'GET', [base, lit('api/invoices')]),
      call('ai', 'POST', [{ t: 'base', v: 'process.env.AI_API' }, lit('summary')]),
      call('rt', 'GET', [base, dyn('path')]),
    );
    assert.equal(r.links.length, 0);
    assert.deepEqual(Object.fromEntries(r.diagnostics.map((d) => [d.call, d.code])), {
      put: 'UI_HTTP_METHOD_MISMATCH', missing: 'UI_HTTP_NO_ENDPOINT', ai: 'UI_HTTP_OTHER_SERVICE', rt: 'UI_HTTP_URL_UNKNOWN',
    });
  });
});

describe('system snapshot (simple-rest + simple-ui)', () => {
  let db: DB;
  let snap: SnapshotInfo;
  let systemFile: string;

  before(async () => {
    systemFile = join(mkdtempSync(join(tmpdir(), 'jci-')), 'system.ndjson');
    execFileSync(process.execPath, ['--import', 'tsx', resolve(import.meta.dirname, '../src/cli/combine.ts'), '--core', CORE, '--ui', UI, '--out', systemFile, '--system-id', 'shop-system'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    db = openDb(':memory:');
    await loadNdjson(db, systemFile, { repoPath: CORE_REPO });
    snap = resolveSnapshot(db)!;
  });

  test('core records pass through unchanged; UI paths are prefixed', () => {
    // Line endings are normalised to \n; record text is otherwise identical.
    const core = readFileSync(CORE, 'utf8').trim().split(/\r?\n/).slice(1);
    const sys = new Set(readFileSync(systemFile, 'utf8').trim().split(/\r?\n/));
    assert.ok(core.every((l) => sys.has(l)), 'every core line is present byte-for-byte');
    const ui = db.prepare(`SELECT DISTINCT file_path AS f FROM nodes WHERE snapshot_id = ? AND id LIKE 'ui:%'`).all(snap.id) as Array<{ f: string }>;
    assert.ok(ui.length > 0 && ui.every((r) => r.f.startsWith('@simple-ui/')));
    assert.deepEqual((snap.scope.repos as Array<{ repoId: string; pathPrefix: string }>).map((r) => [r.repoId, r.pathPrefix]), [['simple-rest', ''], ['simple-ui', '@simple-ui/']]);
  });

  test('CALLS_API edges and diagnostics', () => {
    const links = db.prepare(`SELECT src, dst, resolution FROM edges WHERE snapshot_id = ? AND kind = 'CALLS_API' ORDER BY src, dst`).all(snap.id) as Array<{ src: string; dst: string; resolution: string }>;
    assert.deepEqual(links.map((l) => [l.src.replace('ui:http:src/services/shop-service.js#', ''), l.dst, l.resolution]), [
      ['L16C12', 'endpoint:GET /api/orders/search', 'FRAMEWORK_DERIVED'],
      ['L16C12', 'endpoint:GET /api/orders/search/v2', 'FRAMEWORK_DERIVED'],
      ['L20C12', 'endpoint:POST /api/orders', 'FRAMEWORK_DERIVED'],
      ['L24C12', 'endpoint:DELETE /api/orders/{orderId}', 'FRAMEWORK_DERIVED'],
      ['L8C12', 'endpoint:GET /api/orders/{orderId}', 'FRAMEWORK_DERIVED'],
    ]);
    const codes = (db.prepare(`SELECT code FROM diagnostics WHERE snapshot_id = ? AND code LIKE 'UI_HTTP_%' ORDER BY code`).all(snap.id) as Array<{ code: string }>).map((d) => d.code);
    assert.deepEqual(codes, ['UI_HTTP_METHOD_MISMATCH', 'UI_HTTP_NO_ENDPOINT', 'UI_HTTP_OTHER_SERVICE', 'UI_HTTP_URL_UNKNOWN']);
  });

  test('impact of a Core endpoint reaches UI routes, components and specs', () => {
    const r = analyzeImpact(db, snap, { targets: ['endpoint:GET /api/orders/{orderId}'] });
    assert.ok(r.ui, 'ui section present');
    assert.deepEqual(r.ui.routes.map((x) => [x.name, x.classification]), [['/orders/:id', 'CONFIRMED_DEPENDENCY']]);
    assert.ok(r.upstream.entryPoints.some((e) => e.id === 'ui:route:/orders/:id'), 'route is an entry point');
    assert.deepEqual(r.ui.httpCalls.map((c) => c.id), ['ui:http:src/services/shop-service.js#L8C12']);
    assert.ok(r.ui.components.some((c) => c.id === 'ui:file:src/pages/OrderPage.vue'));
    assert.deepEqual(r.tests.existing.map((t) => [t.id, t.classification]), [['ui:test:test/unit/OrderPage.spec.js', 'POTENTIAL_IMPACT']]);
    assert.ok(r.risks.some((k) => k.id === 'R-UI-CONSUMERS'));
    assert.ok(r.regressionCandidates.some((c) => c.level === 'UI_E2E' && c.target === 'ui:route:/orders/:id'));
    assert.ok(r.unknowns.some((u) => u.kind === 'UI_UNLINKED_HTTP'), 'runtime-built URLs are reported');
    assert.deepEqual(r.snapshot.repos?.map((x) => x.repoId), ['simple-rest', 'simple-ui']);
    assert.match(renderImpactMarkdown(r, 't'), /## Frontend consumers/);
  });

  test('a dynamically rendered component only gives potential impact', () => {
    const r = analyzeImpact(db, snap, { targets: ['endpoint:GET /api/orders/search'] });
    const routes = Object.fromEntries(r.ui!.routes.map((x) => [x.name, x.classification]));
    assert.deepEqual(routes, { '/orders/:id': 'CONFIRMED_DEPENDENCY', '/tabs': 'POTENTIAL_IMPACT' });
  });

  test('source endpoint reads UI files from the UI repository', async () => {
    const app = buildApp(db);
    const res = await app.inject({ method: 'GET', url: `/api/v1/source?file=${encodeURIComponent('@simple-ui/src/services/shop-service.js')}&from=7&to=8&context=0` });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.data.repoId, 'simple-ui');
    assert.match(body.data.lines.map((l: { text: string }) => l.text).join('\n'), /api\/orders\//);
    const bad = await app.inject({ method: 'GET', url: `/api/v1/source?file=${encodeURIComponent('@simple-ui/../secret.txt')}&from=1` });
    assert.equal(bad.statusCode, 404);
  });
});
