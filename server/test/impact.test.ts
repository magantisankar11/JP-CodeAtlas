import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { before, describe, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { openDb, type DB } from '../src/db.js';
import { buildContextBundle } from '../src/impact/bundle.js';
import { matchDefect, rootCauseCandidates } from '../src/impact/defect.js';
import { analyzeImpact, type SnapshotInfo } from '../src/impact/engine.js';
import { loadNdjson } from '../src/loader.js';
import { resolveSnapshot } from '../src/query.js';

const SAMPLE = resolve(import.meta.dirname, 'data/simple-rest.ndjson');
const FIXTURE_REPO = resolve(import.meta.dirname, '../../fixtures/simple-rest');
const M = 'method:com.example.shop.';
const DEFECT = [
  'GET /shop/api/orders/42 returns 500 instead of 404.',
  'Log: "Order not found: 42"',
  'java.lang.IllegalStateException',
  '  at com.example.shop.service.impl.OrderServiceImpl.getOrder(OrderServiceImpl.java:36)',
].join('\n');

let db: DB;
let snap: SnapshotInfo;

before(async () => {
  db = openDb(':memory:');
  await loadNdjson(db, SAMPLE, { repoPath: FIXTURE_REPO });
  snap = resolveSnapshot(db)!;
});

describe('impact engine', () => {
  test('DAO method: entry points, callers, table, classification', () => {
    const r = analyzeImpact(db, snap, { targets: [`${M}dao.impl.OrderDaoImpl#findById(java.lang.Long)`] });
    const eps = r.upstream.entryPoints.map((e) => [e.id, e.classification]);
    assert.deepEqual(eps.sort(), [
      [`${M}checkout.CheckoutService#reconcile(java.lang.Long)`, 'CONFIRMED_DEPENDENCY'],
      ['endpoint:GET /api/orders/{orderId}', 'CONFIRMED_DEPENDENCY'],
    ].sort());
    assert.ok(r.directlyAffected.some((d) => d.id === `${M}dao.OrderDao#findById(java.lang.Long)`), 'interface counterpart is directly affected');
    const order = r.database.find((t) => t.table === 't_order');
    assert.equal(order?.reads, 1);
    assert.equal(order?.writersOutsideImpact, 3, 'insert, softDelete, hardDelete write the same table elsewhere');
    assert.deepEqual(order?.entities, ['TOrder']);
    const err = r.errorHandling.find((e) => e.exception.endsWith('OrderNotFoundException'));
    assert.equal(err?.handled, 'YES');
    assert.equal(r.tests.existing.length, 0);
    assert.match(r.tests.note, /No test sources are indexed/);
  });

  test('ambiguous dispatch makes impact potential, never confirmed', () => {
    const r = analyzeImpact(db, snap, { targets: [`${M}audit.FileAuditSink#write(java.lang.String)`] });
    const caller = r.upstream.callers.find((c) => c.id === `${M}checkout.CheckoutService#checkout(java.lang.Long,java.lang.String,java.math.BigDecimal)`);
    assert.equal(caller?.classification, 'POTENTIAL_IMPACT');
    assert.equal(caller?.basis, 'AMBIGUOUS');
    assert.ok(r.unknowns.some((u) => u.kind === 'AMBIGUOUS_DISPATCH'));
  });

  test('DTO target: contract risk with direct vs enclosing endpoints, contract regression candidates', () => {
    const r = analyzeImpact(db, snap, { targets: ['type:com.example.shop.form.OrderLineForm'] });
    const post = r.upstream.entryPoints.find((e) => e.id === 'endpoint:POST /api/orders');
    assert.equal(post?.classification, 'POTENTIAL_IMPACT', 'reached only through OrderForm.lines');
    assert.ok(r.risks.some((k) => k.id === 'R-API-CONTRACT'));
    const parent = analyzeImpact(db, snap, { targets: ['type:com.example.shop.form.OrderForm'] });
    assert.equal(parent.upstream.entryPoints.find((e) => e.id === 'endpoint:POST /api/orders')?.classification, 'CONFIRMED_DEPENDENCY');
    assert.ok(parent.regressionCandidates.some((c) => c.level === 'CONTRACT' && c.target === 'endpoint:POST /api/orders'));
  });

  test('outbound calls, unknown URLs, jobs and events surface as risks and unknowns', () => {
    const r = analyzeImpact(db, snap, { targets: [`${M}checkout.CheckoutService#checkout(java.lang.Long,java.lang.String,java.math.BigDecimal)`] });
    assert.ok(r.downstream.externals.some((e) => e.id === 'external:sdk:AWS S3#putObject'));
    assert.ok(r.risks.some((k) => k.id === 'R-INTEGRATION' && k.classification === 'UNKNOWN'), 'runtime-built URL makes integration risk unknown');
    assert.ok(r.unknowns.some((u) => u.kind === 'UNRESOLVED_CALLS_EXTERNAL'));
    assert.ok(r.configuration.some((c) => c.key === 'notify.sms.enabled'));
    assert.ok(r.downstream.events.some((e) => e.id === 'event:com.example.shop.checkout.OrderPlacedEvent'));
  });

  test('table target: every SQL statement and entry point that touches it', () => {
    const r = analyzeImpact(db, snap, { targets: ['table:t_order'] });
    const t = r.database.find((x) => x.table === 't_order')!;
    assert.equal(t.writes, 3, 'insert, softDelete, hardDelete');
    assert.equal(t.reads, 2, 'findById, findByCustomer (variants)');
    assert.ok(r.upstream.entryPoints.some((e) => e.id === 'endpoint:DELETE /api/orders/{orderId}'));
    assert.ok(r.regressionCandidates.some((c) => c.level === 'DATA'));
  });

  test('gates never claim a human gate is satisfied', () => {
    const r = analyzeImpact(db, snap, { targets: [`${M}dao.impl.OrderDaoImpl#findById(java.lang.Long)`] });
    const by = Object.fromEntries(r.gates.map((g) => [g.id, g.status]));
    assert.equal(by.G1, 'NEEDS_HUMAN');
    assert.equal(by.G2, 'NEEDS_HUMAN');
    assert.equal(by.G7, 'NEEDS_HUMAN');
    assert.equal(by.G3, 'EVIDENCE_PRESENT');
    assert.equal(by.G8, 'EVIDENCE_PRESENT');
  });

  test('shared helpers called by the target are context, not a risk; a shared target is', () => {
    const r = analyzeImpact(db, snap, { targets: [`${M}util.TextUtil#mask(java.lang.String)`] });
    assert.ok(!r.risks.some((k) => k.id === 'R-SHARED'), 'mask has callers in fewer than 5 types in the fixture');
    assert.ok(r.upstream.callers.some((c) => c.id === `${M}util.AuditHelper#record(java.lang.String,java.lang.Long)`));
  });

  test('unknown targets are rejected', () => {
    assert.throws(() => analyzeImpact(db, snap, { targets: ['method:nope#x()'] }), /None of the targets exist/);
  });
});

describe('defect matching', () => {
  test('stack frame, URL and message map to code; shared names stay weak', () => {
    const m = matchDefect(db, snap, DEFECT);
    const by = new Map(m.candidates.map((c) => [c.nodeId, c]));
    assert.equal(by.get(`${M}service.impl.OrderServiceImpl#getOrder(java.lang.Long)`)?.strength, 'EXACT');
    assert.equal(by.get('endpoint:GET /api/orders/{orderId}')?.strength, 'EXACT', 'context path /shop stripped');
    assert.equal(by.get(`${M}service.OrderNotFoundException#<init>(java.lang.Long)`)?.strength, 'TEXT', 'logged message located at its literal prefix');
    assert.equal(by.get(`${M}report.ReportService#getOrder(java.lang.Long)`)?.strength, 'WEAK');
    const rc = rootCauseCandidates(m);
    assert.equal(rc[0]?.nodeId, `${M}service.impl.OrderServiceImpl#getOrder(java.lang.Long)`);
    assert.ok(rc.every((c) => c.strength !== 'WEAK'));
  });

  test('UI wording maps to camelCase identifiers (TEXT strength)', () => {
    const m = matchDefect(db, snap, 'Audit is missing when "order placed" events fire');
    const c = m.candidates.find((x) => x.nodeId === `${M}checkout.OrderPlacedListener#onOrderPlaced(com.example.shop.checkout.OrderPlacedEvent)`);
    assert.equal(c?.strength, 'TEXT');
    assert.match(c!.reasons[0]!, /OrderPlaced/);
  });

  test('Class.method references are scoped by the class name', () => {
    const m = matchDefect(db, snap, 'ReportService.getOrder returns stale data');
    const by = new Map(m.candidates.map((c) => [c.nodeId, c]));
    assert.equal(by.get(`${M}report.ReportService#getOrder(java.lang.Long)`)?.strength, 'EXACT');
    assert.notEqual(by.get(`${M}service.impl.OrderServiceImpl#getOrder(java.lang.Long)`)?.strength, 'EXACT');
  });
});

describe('context bundle', () => {
  test('six files, excerpts exact at the commit, bounded, secrets absent', () => {
    const m = matchDefect(db, snap, DEFECT);
    const r = analyzeImpact(db, snap, { targets: [`${M}service.impl.OrderServiceImpl#getOrder(java.lang.Long)`], rootCauses: rootCauseCandidates(m) });
    const files = buildContextBundle(db, snap, r, { title: 'T-1', defectText: DEFECT + '\npassword=hunter2', match: m, maxExcerptLines: 120 });
    assert.deepEqual(Object.keys(files).sort(), ['context.json', 'dependencies.json', 'flow.md', 'impact-analysis.md', 'jira-draft.md', 'relevant-tests.md']);
    const ctx = JSON.parse(files['context.json']!);
    assert.equal(ctx.schema, 'jci-context/1.0');
    assert.equal(ctx.snapshot.commitSha, snap.commitSha);
    assert.ok(ctx.excerptBudget.usedLines <= 120);
    for (const x of ctx.excerpts as Array<{ file: string; from: number; to: number; text: string }>) {
      const src = readFileSync(resolve(FIXTURE_REPO, x.file), 'utf8').split(/\r?\n/).slice(x.from - 1, x.to).join('\n');
      assert.equal(x.text, src, `excerpt ${x.file}:${x.from} must match the source exactly`);
    }
    assert.ok(ctx.verifiedExecutionPath.every((e: { resolution: string }) => e.resolution === 'CONFIRMED' || e.resolution === 'FRAMEWORK_DERIVED'));
    assert.ok(!JSON.stringify(files).includes('hunter2'), 'defect text is redacted');
    assert.match(files['flow.md']!, /OrderServiceImpl\.getOrder\(\)/);
    assert.match(files['jira-draft.md']!, /Nothing was written to Jira/);
  });
});

describe('impact API', () => {
  test('match, impact and export endpoints', async () => {
    const app = buildApp(db);
    const match = await app.inject({ method: 'POST', url: '/api/v1/defect/match', payload: { text: DEFECT } });
    assert.equal(match.statusCode, 200);
    assert.ok(match.json().data.candidates.length > 3);
    const imp = await app.inject({ method: 'POST', url: '/api/v1/impact', payload: { targets: ['table:t_order'] } });
    assert.equal(imp.statusCode, 200);
    assert.equal(imp.json().data.schema, 'jci-impact/1.0');
    const exp = await app.inject({ method: 'POST', url: '/api/v1/export/context', payload: { targets: ['table:t_order'], title: 'x' } });
    assert.equal(exp.statusCode, 200);
    assert.ok(exp.json().data.files['impact-analysis.md'].startsWith('# Impact analysis: x'));
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/impact', payload: { targets: [] } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/impact', payload: { targets: ['nope'] } })).statusCode, 404);
  });
});
