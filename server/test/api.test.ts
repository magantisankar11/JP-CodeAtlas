import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { before, describe, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { openDb, type DB } from '../src/db.js';
import { loadNdjson, searchTerms } from '../src/loader.js';
import type { GraphResult } from '../src/query.js';

const SAMPLE = resolve(import.meta.dirname, 'data/simple-rest.ndjson');
const FIXTURE_REPO = resolve(import.meta.dirname, '../../fixtures/simple-rest');
const M = 'method:com.example.shop.';

let db: DB;
let app: ReturnType<typeof buildApp>;

async function get<T = any>(url: string, status = 200): Promise<T> {
  const res = await app.inject({ method: 'GET', url });
  assert.equal(res.statusCode, status, `${url} -> ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}
const graph = async (q: string) => (await get<{ data: GraphResult }>(`/api/v1/graph?${q}`)).data;
const enc = encodeURIComponent;

before(async () => {
  db = openDb(':memory:');
  await loadNdjson(db, SAMPLE, { repoPath: FIXTURE_REPO });
  app = buildApp(db);
});

describe('loader', () => {
  test('reloading the same repo/commit/scope replaces the snapshot', async () => {
    const d = openDb(':memory:');
    const a = await loadNdjson(d, SAMPLE);
    const b = await loadNdjson(d, SAMPLE);
    assert.equal(b.replaced, true);
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number }).n, 1);
    assert.equal(a.nodes, b.nodes);
  });

  test('rejects unsupported schema major versions', async () => {
    const lines = readFileSync(SAMPLE, 'utf8').split('\n');
    const snap = JSON.parse(lines[0]!);
    snap.schemaVersion = '2.0.0';
    const file = join(mkdtempSync(join(tmpdir(), 'jci-')), 'v2.ndjson');
    writeFileSync(file, [JSON.stringify(snap), ...lines.slice(1)].join('\n'));
    await assert.rejects(loadNdjson(openDb(':memory:'), file), /not supported/);
  });

  test('rejects edges that point at unknown nodes', async () => {
    const lines = readFileSync(SAMPLE, 'utf8').trim().split('\n');
    const bad = { type: 'edge', id: 'e:x', kind: 'CALLS', src: 'method:a#b()', dst: 'method:c#d()', resolution: 'CONFIRMED', evidence: [{ filePath: 'x', line: 1, rule: 'BINDING' }] };
    const file = join(mkdtempSync(join(tmpdir(), 'jci-')), 'dangling.ndjson');
    writeFileSync(file, [...lines, JSON.stringify(bad)].join('\n'));
    await assert.rejects(loadNdjson(openDb(':memory:'), file), /unknown nodes/);
  });

  test('search terms split camelCase', () => {
    assert.match(searchTerms('SnippetsServiceImpl#loadSnippets'), /\bload\b.*|\bsnippets\b/);
    assert.ok(searchTerms('loadSnippetById').split(' ').includes('snippet'));
  });
});

describe('api', () => {
  test('snapshot envelope names repo and commit', async () => {
    const r = await get('/api/v1/endpoints');
    assert.equal(r.apiVersion, '1.0.0');
    assert.equal(r.snapshot.repoId, 'simple-rest');
    assert.match(r.snapshot.commitSha, /^nogit-/);
    assert.equal(r.data.length, 6);
    assert.equal((await get('/api/v1/endpoints?method=GET')).data.length, 3);
  });

  test('search ranks endpoints and controllers first', async () => {
    const hits = (await get('/api/v1/search?q=order%20controller')).data;
    assert.equal(hits[0].id, 'type:com.example.shop.controller.OrderController');
    const ep = (await get('/api/v1/search?q=orders%20search&kinds=API_ENDPOINT')).data;
    assert.ok(ep.length >= 2 && ep.every((h: { kind: string }) => h.kind === 'API_ENDPOINT'));
  });

  test('forward flow: endpoint -> controller -> service impl -> dao impl -> SQL -> table', async () => {
    const g = await graph(`root=${enc('endpoint:GET /api/orders/{orderId}')}&depth=6`);
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const id of [
      `${M}controller.OrderController#getOrder(java.lang.Long)`,
      `${M}service.impl.OrderServiceImpl#getOrder(java.lang.Long)`,
      `${M}dao.impl.OrderDaoImpl#findById(java.lang.Long)`,
      'table:t_order',
    ]) assert.ok(ids.has(id), `missing ${id}`);
    assert.ok(!ids.has(`${M}report.ReportService#getOrder(java.lang.Long)`), 'name collision must not be linked');
    assert.ok(!ids.has(`${M}entity.TOrder#getCustomerId()`), 'Lombok accessors hidden by default');
    const withAccessors = await graph(`root=${enc('endpoint:GET /api/orders/{orderId}')}&depth=6&includeAccessors=true`);
    assert.ok(withAccessors.nodes.some((n) => n.id === `${M}entity.TOrder#getCustomerId()`));
  });

  test('interface hops are collapsed when dispatch edges exist, unless asked for', async () => {
    const root = enc(`${M}controller.OrderController#getOrder(java.lang.Long)`);
    const iface = `${M}service.OrderService#getOrder(java.lang.Long)`;
    const collapsed = await graph(`root=${root}&depth=1`);
    assert.ok(!collapsed.nodes.some((n) => n.id === iface));
    assert.ok(collapsed.edges.some((e) => e.attrs.viaDispatch === iface), 'dispatch edge keeps the static target');
    const full = await graph(`root=${root}&depth=1&collapseDispatch=false`);
    assert.ok(full.nodes.some((n) => n.id === iface));
  });

  test('hand-written trivial getters are hidden with Lombok accessors', async () => {
    const root = enc(`${M}util.AuditHelper#record(java.lang.String,java.lang.Long)`);
    const getter = `${M}util.AuditHelper#getRecorded()`;
    assert.ok(!(await graph(`root=${root}&depth=1`)).nodes.some((n) => n.id === getter));
    assert.ok((await graph(`root=${root}&depth=1&includeAccessors=true`)).nodes.some((n) => n.id === getter));
  });

  test('reverse impact: table -> every endpoint that reaches it', async () => {
    const g = await graph(`root=table:t_order&direction=reverse&depth=8`);
    const eps = g.nodes.filter((n) => n.kind === 'API_ENDPOINT').map((n) => n.id).sort();
    assert.deepEqual(eps, [
      'endpoint:DELETE /api/orders/{orderId}',
      'endpoint:GET /api/orders/{orderId}',
      'endpoint:POST /api/orders',
    ]);
  });

  test('minResolution drops ambiguous dispatch', async () => {
    const root = enc(`${M}controller.OrderController#quote(com.example.shop.form.OrderForm)`);
    const all = await graph(`root=${root}&depth=1`);
    assert.ok(all.edges.some((e) => e.resolution === 'AMBIGUOUS'));
    const strict = await graph(`root=${root}&depth=1&minResolution=FRAMEWORK_DERIVED`);
    assert.ok(strict.edges.every((e) => e.resolution !== 'AMBIGUOUS'));
    assert.ok(strict.nodes.some((n) => n.id === `${M}service.PricingService#price(com.example.shop.form.OrderForm)`));
  });

  test('cycles are detected (recursion and mutual recursion)', async () => {
    const g = await graph(`root=${enc(`${M}report.ReportService#ping(int)`)}&depth=4`);
    assert.equal(g.cycleEdges.length, 1);
    const rec = await graph(`root=${enc(`${M}service.impl.OrderServiceImpl#recalculate(int)`)}&depth=2`);
    assert.equal(rec.cycleEdges.length, 1);
  });

  test('node limit truncates and marks expandable nodes', async () => {
    const g = await graph(`root=${enc('endpoint:POST /api/orders')}&depth=6&limit=3`);
    assert.equal(g.truncated, true);
    assert.ok(g.nodes.length <= 3);
    assert.ok(g.nodes.some((n) => n.hasMore));
  });

  test('source excerpt is served only for indexed files and is pinned to the snapshot', async () => {
    const ok = await get(`/api/v1/source?file=${enc('src/main/java/com/example/shop/controller/OrderController.java')}&from=31&context=0`);
    assert.equal(ok.data.lines[0].n, 31);
    assert.match(ok.data.lines[0].text, /orderService\.getOrder/);
    await get(`/api/v1/source?file=${enc('pom.xml')}&from=1`, 404);
    await get(`/api/v1/source?file=${enc('../../server/package.json')}&from=1`, 404);
  });

  test('node details include incoming and outgoing edges', async () => {
    const r = await get(`/api/v1/node?id=${enc(`${M}dao.OrderDao#findById(java.lang.Long)`)}`);
    assert.equal(r.data.node.kind, 'METHOD');
    assert.ok(r.data.incoming.some((e: { src: string }) => e.src === `${M}service.impl.OrderServiceImpl#getOrder(java.lang.Long)`));
  });

  test('type-impact: a nested DTO reaches the endpoints that accept its parent, flagged as via enclosing type', async () => {
    const g = await graph(`root=${enc('type:com.example.shop.form.OrderLineForm')}&direction=reverse&depth=6&preset=type-impact`);
    const eps = g.nodes.filter((n) => n.kind === 'API_ENDPOINT');
    const post = eps.find((n) => n.id === 'endpoint:POST /api/orders');
    assert.ok(post, `got ${eps.map((n) => n.id)}`);
    assert.equal(post.viaEnclosingType, true);
    assert.ok(eps.some((n) => n.id === 'endpoint:GET /api/orders/{orderId}'));
    const direct = await graph(`root=${enc('type:com.example.shop.form.OrderForm')}&direction=reverse&depth=1&preset=type-impact`);
    assert.equal(direct.nodes.find((n) => n.id === 'endpoint:POST /api/orders')?.viaEnclosingType, false);
  });

  test('pathResolution is the strongest chain of evidence, never stronger than its weakest edge', async () => {
    const g = await graph('root=table:t_order&direction=reverse&depth=8&preset=data');
    const ep = g.nodes.find((n) => n.id === 'endpoint:GET /api/orders/{orderId}');
    assert.equal(ep?.pathResolution, 'FRAMEWORK_DERIVED', 'EXPOSES and interface dispatch are framework-derived');
    const sql = g.nodes.find((n) => n.kind === 'SQL_STATEMENT' && n.id.includes('OrderDaoImpl#findById'));
    assert.equal(sql?.pathResolution, 'CONFIRMED');
    const viaVariants = g.nodes.find((n) => n.kind === 'SQL_STATEMENT' && n.id.includes('findByCustomer'));
    assert.equal(viaVariants?.pathResolution, 'FRAMEWORK_DERIVED');
  });

  test('flow preset follows external calls, scheduled jobs and events', async () => {
    const root = enc(`${M}checkout.CheckoutService#checkout(java.lang.Long,java.lang.String,java.math.BigDecimal)`);
    const g = await graph(`root=${root}&depth=2&preset=flow`);
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const id of [
      'external:http:GET https://status.example.com/health',
      'external:sdk:AWS S3#putObject',
      `${M}checkout.CheckoutService#reconcile(java.lang.Long)`,
      'event:com.example.shop.checkout.OrderPlacedEvent',
      `${M}checkout.OrderPlacedListener#onOrderPlaced(com.example.shop.checkout.OrderPlacedEvent)`,
    ]) assert.ok(ids.has(id), `missing ${id}`);
  });

  test('catalog lists tables with usage counts and non-HTTP entry points', async () => {
    const tables = (await get('/api/v1/catalog?kind=DATABASE_TABLE')).data as Array<{ id: string; incoming: Record<string, number>; attrs: any }>;
    const order = tables.find((t) => t.id === 'table:t_order');
    assert.equal(order?.incoming.MAPS_TO, 1);
    assert.ok((order?.incoming.READS ?? 0) >= 2 && (order?.incoming.WRITES ?? 0) >= 3);
    const eps = (await get('/api/v1/catalog?entryPoints=true')).data.map((n: { attrs: any }) => n.attrs.entryPoint).sort();
    assert.deepEqual(eps, ['EVENT_LISTENER', 'JOBRUNR_LAMBDA', 'SCHEDULED']);
    await get('/api/v1/catalog', 400);
  });

  test('reach lists every entry point independent of the render budget', async () => {
    const r = (await get(`/api/v1/reach?root=table:t_order&preset=data&depth=8`)).data;
    const ids = r.entryPoints.map((n: { id: string }) => n.id);
    for (const id of ['endpoint:GET /api/orders/{orderId}', 'endpoint:POST /api/orders', 'endpoint:DELETE /api/orders/{orderId}']) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
    assert.ok(ids.includes(`${M}checkout.CheckoutService#reconcile(java.lang.Long)`), 'JobRunr job that reads t_order');
    assert.equal(r.truncated, false);
  });

  test('bad parameters are 400, unknown nodes 404', async () => {
    await get('/api/v1/graph?root=x&depth=99', 400);
    await get('/api/v1/graph?root=missing', 404);
    await get('/api/v1/search?q=', 400);
  });
});
