import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { before, describe, test } from 'node:test';
import { analyzeUi } from '../src/analyze.js';
import type { Graph } from '../src/graph.js';
import { ModuleResolver } from '../src/resolve.js';
import { readSources } from '../src/source.js';

const FIXTURE = resolve(import.meta.dirname, '../../fixtures/simple-ui');
const GOLDEN = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../fixtures/simple-ui.expected.json'), 'utf8'));

type Part = { t: 'lit' | 'base' | 'dyn'; v: string };
const display = (parts: Part[]) => parts.map((p) => (p.t === 'lit' ? p.v : p.t === 'base' ? '{base}' : '${?}')).join('');

let graph: Graph;
const edge = (kind: string, src: string, dst: string) => [...graph.edges.values()].find((e) => e.kind === kind && e.src === src && e.dst === dst);

before(() => {
  graph = analyzeUi(readSources(FIXTURE, ['src', 'test']).files).graph;
});

describe('simple-ui golden facts', () => {
  test('nodes and attributes', () => {
    for (const exp of GOLDEN.nodes) {
      const n = graph.nodes.get(exp.id);
      assert.ok(n, `missing node ${exp.id}`);
      assert.equal(n.kind, exp.kind, exp.id);
      for (const [k, v] of Object.entries(exp.attrs ?? {})) assert.deepEqual(n.attrs[k], v, `${exp.id} attrs.${k}`);
    }
  });

  test('conditional URLs keep every variant', () => {
    for (const [id, urls] of Object.entries(GOLDEN.variants as Record<string, string[]>)) {
      const v = graph.nodes.get(id)?.attrs.variants as Part[][] | undefined;
      assert.ok(v, `${id} has no variants`);
      assert.deepEqual(v.map(display).sort(), [...urls].sort());
    }
  });

  test('edges with resolution and rule', () => {
    for (const exp of GOLDEN.edges) {
      const e = edge(exp.kind, exp.src, exp.dst);
      assert.ok(e, `missing ${exp.kind} ${exp.src} -> ${exp.dst}`);
      assert.equal(e.resolution, exp.resolution, `${exp.kind} ${exp.src} -> ${exp.dst}`);
      assert.ok(e.evidence.some((ev) => ev.rule === exp.rule), `${exp.kind} ${exp.src} -> ${exp.dst}: rule ${exp.rule}`);
    }
    for (const f of GOLDEN.forbiddenEdges) assert.equal(edge(f.kind, f.src, f.dst), undefined, `forbidden ${f.kind} ${f.src} -> ${f.dst}`);
  });

  test('every edge cites a real line of its file', () => {
    const files = readSources(FIXTURE, ['src', 'test']).files;
    for (const e of graph.edges.values()) {
      for (const ev of e.evidence) {
        const text = files.get(ev.filePath);
        assert.ok(text, `${e.kind} evidence file ${ev.filePath}`);
        assert.ok(ev.line >= 1 && ev.line <= text.split('\n').length, `${e.kind} ${ev.filePath}:${ev.line}`);
      }
    }
  });
});

describe('module resolution', () => {
  const r = new ModuleResolver(new Set(['src/pages/A.vue', 'src/boot/axios.js', 'src/util/index.js', 'quasar.config.js']));
  test('relative, alias, index and app-root specifiers', () => {
    assert.equal(r.resolve('src/pages/B.vue', './A.vue'), 'src/pages/A.vue');
    assert.equal(r.resolve('src/pages/B.vue', 'pages/A'), 'src/pages/A.vue');
    assert.equal(r.resolve('src/pages/B.vue', 'boot/axios'), 'src/boot/axios.js');
    assert.equal(r.resolve('src/pages/B.vue', '../util'), 'src/util/index.js');
    assert.equal(r.resolve('src/pages/B.vue', 'app/quasar.config'), 'quasar.config.js');
    assert.equal(r.resolve('src/pages/B.vue', 'vue'), null);
  });
});
