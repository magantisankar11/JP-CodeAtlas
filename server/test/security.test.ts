import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { loadNdjson } from '../src/loader.js';
import { allowedOrigins, assertLoopbackBind, parseHostHeader } from '../src/security.js';

const SAMPLE = resolve(import.meta.dirname, 'data/simple-rest.ndjson');
const FIXTURE_REPO = resolve(import.meta.dirname, '../../fixtures/simple-rest');
const SOURCE = `/api/v1/source?file=${encodeURIComponent('src/main/java/com/example/shop/controller/OrderController.java')}&from=31&context=0`;
const OK_HOST = '127.0.0.1:4317';

let app: ReturnType<typeof buildApp>;
const req = (method: 'GET' | 'POST' | 'OPTIONS', url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  app.inject({ method, url, headers: { host: OK_HOST, ...headers }, ...(payload === undefined ? {} : { payload: payload as string }) });
const noCors = (h: Record<string, unknown>) => assert.deepEqual(Object.keys(h).filter((k) => k.startsWith('access-control-')), []);

before(async () => {
  const db = openDb(':memory:');
  await loadNdjson(db, SAMPLE, { repoPath: FIXTURE_REPO });
  app = buildApp(db, { security: { port: 4317, allowedOrigins: ['http://localhost:4000'] } });
  await app.ready();
});
after(() => app.close());

describe('Host header (DNS rebinding)', () => {
  test('forged Host is rejected on GET, source read, POST and unknown routes', async () => {
    const evil = { host: 'attacker.example:4317' };
    assert.equal((await req('GET', '/api/v1/health', evil)).statusCode, 403);
    const src = await req('GET', SOURCE, evil);
    assert.equal(src.statusCode, 403);
    assert.doesNotMatch(src.body, /class|OrderController/);
    assert.equal((await req('POST', '/api/v1/impact', { ...evil, 'content-type': 'application/json' }, { targets: ['x'] })).statusCode, 403);
    assert.equal((await req('GET', '/api/v1/nope', evil)).statusCode, 403, 'guard runs before routing');
  });

  test('loopback hosts are accepted, any port, any case', async () => {
    for (const host of ['127.0.0.1:4317', 'localhost:4317', '[::1]:4317', 'localhost', 'LOCALHOST:4317', '127.0.0.1:5173']) {
      assert.equal((await req('GET', '/api/v1/health', { host })).statusCode, 200, host);
    }
    const src = await req('GET', SOURCE);
    assert.equal(src.statusCode, 200);
  });

  test('lookalike hosts are rejected', async () => {
    for (const host of ['127.0.0.1.attacker.example', 'localhost.attacker.example', '127.0.0.2:4317', '0.0.0.0:4317', 'attacker.example', '[::1].evil', 'localhost:4317:1']) {
      assert.equal((await req('GET', '/api/v1/health', { host })).statusCode, 403, JSON.stringify(host));
    }
  });

  // inject() substitutes its own default Host, so missing and empty Host are tested on a real socket.
  test('a missing or empty Host on a real socket is rejected', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    for (const head of ['GET /api/v1/health HTTP/1.0\r\n\r\n', 'GET /api/v1/health HTTP/1.0\r\nHost: \r\n\r\n', 'GET /api/v1/health HTTP/1.1\r\nConnection: close\r\n\r\n']) {
      const raw = await new Promise<string>((ok, fail) => {
        let buf = '';
        const s = connect(port, '127.0.0.1', () => s.write(head));
        s.on('data', (d) => (buf += d)).on('end', () => ok(buf)).on('error', fail);
      });
      // Node itself answers 400 for HTTP/1.1 without Host; the guard answers 403 otherwise.
      assert.match(raw, /^HTTP\/1\.[01] 40[03]/, JSON.stringify(head));
      assert.doesNotMatch(raw, /"ok":true/);
    }
  });
});

describe('Origin and fetch metadata', () => {
  test('foreign, null and lookalike origins are rejected', async () => {
    for (const origin of ['http://evil.example', 'null', 'http://localhost:9999', 'http://127.0.0.1:4317.evil.example', 'https://127.0.0.1:4317', 'http://127.0.0.1']) {
      assert.equal((await req('GET', '/api/v1/health', { origin })).statusCode, 403, origin);
    }
  });

  test('the API port, the Vite dev server and configured origins are accepted', async () => {
    for (const origin of ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://localhost:4317', 'http://[::1]:4317', 'http://localhost:4000']) {
      const r = await req('GET', '/api/v1/health', { origin });
      assert.equal(r.statusCode, 200, origin);
      noCors(r.headers);
    }
  });

  test('Sec-Fetch-Site: cross-site is rejected even with an allowed origin', async () => {
    assert.equal((await req('GET', '/api/v1/health', { origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'cross-site' })).statusCode, 403);
    assert.equal((await req('GET', '/api/v1/health', { 'sec-fetch-site': 'same-origin' })).statusCode, 200);
  });

  test('preflight from a foreign origin gets no CORS grant', async () => {
    const r = await req('OPTIONS', '/api/v1/impact', { origin: 'http://evil.example', 'access-control-request-method': 'POST' });
    assert.equal(r.statusCode, 403);
    noCors(r.headers);
  });
});

describe('POST content type', () => {
  test('text/plain and form bodies are refused (no-preflight CSRF path)', async () => {
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx']) {
      assert.equal((await req('POST', '/api/v1/defect/match', { 'content-type': ct }, '{"text":"OrderController"}')).statusCode, 415, ct);
    }
    assert.equal((await req('POST', '/api/v1/defect/match', {}, '{"text":"x"}')).statusCode, 415, 'missing content-type');
  });

  test('JSON bodies still work', async () => {
    const r = await req('POST', '/api/v1/defect/match', { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ text: 'OrderController' }));
    assert.equal(r.statusCode, 200);
    noCors(r.headers);
  });
});

describe('helpers', () => {
  test('parseHostHeader', () => {
    assert.equal(parseHostHeader('LocalHost:80'), 'localhost');
    assert.equal(parseHostHeader('[::1]:4317'), '[::1]');
    assert.equal(parseHostHeader(undefined), undefined);
    assert.equal(parseHostHeader('a:b:c'), undefined);
  });

  test('allowedOrigins is exact scheme://host:port', () => {
    const o = allowedOrigins({ port: 4400, extra: ['HTTP://Localhost:4173/'] });
    assert.ok(o.has('http://127.0.0.1:4400') && o.has('http://localhost:5173') && o.has('http://localhost:4173'));
    assert.ok(!o.has('http://127.0.0.1:4317'));
  });

  test('assertLoopbackBind refuses non-loopback addresses', () => {
    for (const h of ['0.0.0.0', '192.168.1.5', '::', 'example.com']) assert.throws(() => assertLoopbackBind(h), /loopback/, h);
    for (const h of ['127.0.0.1', '::1', 'localhost']) assert.doesNotThrow(() => assertLoopbackBind(h));
  });
});
