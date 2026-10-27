import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeUi } from './analyze.js';
import { readSources, readWorktree, verifyUnchanged } from './source.js';
import { VERSION } from './version.js';

/**
 *   npm run analyze -- --repo ../../main/JustPerform-UI --repo-id justperform-ui --out ../workspace/graphs/ui.ndjson
 *                      [--commit SHA | --worktree] [--root src --root test]
 * Read-only: sources come from `git cat-file` at the commit; the repo's git status must be unchanged afterwards.
 */
export { VERSION };

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    'repo-id': { type: 'string' },
    out: { type: 'string' },
    commit: { type: 'string' },
    worktree: { type: 'boolean', default: false },
    root: { type: 'string', multiple: true, default: ['src', 'test'] },
  },
});
if (!values.repo || !values['repo-id'] || !values.out) {
  console.error('usage: analyze --repo DIR --repo-id ID --out FILE.ndjson [--commit SHA] [--root src]...');
  process.exit(2);
}
const repo = resolve(values.repo);
const started = new Date();
const t0 = Date.now();
const src = values.worktree ? readWorktree(repo, values.root!) : readSources(repo, values.root!, values.commit);
const t1 = Date.now();
const { graph, stats } = analyzeUi(src.files);
verifyUnchanged(src);

const edgeKinds: Record<string, number> = {};
for (const e of graph.edges.values()) edgeKinds[`${e.kind}:${e.resolution}`] = (edgeKinds[`${e.kind}:${e.resolution}`] ?? 0) + 1;
const snapshot = {
  type: 'snapshot', schemaVersion: '1.2.0', repoId: values['repo-id'], repoPath: repo.replace(/\\/g, '/'), commitSha: src.commitSha,
  sourceMode: src.mode, analyzerVersion: VERSION, engine: 'typescript-5.9+vue-compiler-sfc-3.5', startedAt: started.toISOString(), finishedAt: new Date().toISOString(),
  scope: { sourceRoots: values.root, language: 'vue/js/ts' },
  stats: { ...stats, readMs: t1 - t0, analysisMs: Date.now() - t1, nodes: graph.nodes.size, edges: graph.edges.size, edgesByKindAndResolution: edgeKinds, diagnostics: graph.diagnostics.length },
};
const out = resolve(values.out);
mkdirSync(dirname(out), { recursive: true });
const lines = [JSON.stringify(snapshot), ...[...graph.nodes.values()].map((n) => JSON.stringify(n)), ...[...graph.edges.values()].map((e) => JSON.stringify(e)),
  ...graph.diagnostics.map((d) => JSON.stringify(d))];
writeFileSync(out, lines.join('\n') + '\n');
console.log(JSON.stringify({ out, commitSha: src.commitSha, stats: snapshot.stats }, null, 2));
