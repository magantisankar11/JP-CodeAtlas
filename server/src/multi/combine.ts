import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { edgeId, stitch, type Endpoint, type HttpCall, type StitchResult } from './stitch.js';

/**
 * Builds one "system" snapshot from a Core (Java) graph and a UI graph. The Core repo stays primary: its records pass
 * through unchanged (line endings normalised), so Core ids, paths and evidence are unchanged. UI file paths get the prefix
 * "@<uiRepoId>/" so the server can route source reads to the right repository (scope.repos). UI_HTTP_CALL → API_ENDPOINT
 * links are added as CALLS_API edges by stitch.ts; calls that cannot be linked become diagnostics.
 */
export const VERSION = 'stitch-0.1.0';

export interface CombineOptions { systemId?: string; coreBases?: string[] }

async function* lines(file: string) {
  for await (const l of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) if (l.trim()) yield l;
}

export async function combineGraphs(coreFile: string, uiFile: string, outFile: string, opts: CombineOptions = {}):
  Promise<{ out: string; endpoints: number; stitch: StitchResult['stats'] }> {
  const started = new Date();
  // Pass 1 over Core: snapshot + endpoints only.
  let core: any;
  const endpoints: Endpoint[] = [];
  for await (const l of lines(coreFile)) {
    if (!core) {
      core = JSON.parse(l);
      if (core.type !== 'snapshot') throw new Error(`${coreFile}: first line must be a snapshot record`);
      continue;
    }
    if (!l.includes('"API_ENDPOINT"')) continue;
    const o = JSON.parse(l);
    if (o.type === 'node' && o.kind === 'API_ENDPOINT' && o.attrs?.path) endpoints.push({ id: o.id, httpMethod: o.attrs.httpMethod, path: o.attrs.path });
  }

  const uiRecs = readFileSync(uiFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const ui = uiRecs[0];
  if (ui?.type !== 'snapshot') throw new Error(`${uiFile}: first line must be a snapshot record`);
  const prefix = `@${ui.repoId}/`;
  const pre = (p?: string) => (p ? prefix + p : p);

  const calls: HttpCall[] = uiRecs
    .filter((o) => o.type === 'node' && o.kind === 'UI_HTTP_CALL')
    .map((o) => ({ id: o.id, httpMethod: o.attrs.httpMethod ?? null, parts: o.attrs.parts, variants: o.attrs.variants, filePath: o.filePath, line: o.lineStart, endLine: o.lineEnd ?? o.lineStart, column: 1 }));
  const byId = new Map(calls.map((c) => [c.id, c]));
  const result = stitch(endpoints, calls, { coreBases: opts.coreBases ?? ['process.env.JP_API'], contextPath: core.scope?.contextPath });

  const out = createWriteStream(resolve(outFile), 'utf8');
  const write = (o: unknown) => new Promise<void>((res) => (out.write(JSON.stringify(o) + '\n') ? res() : out.once('drain', () => res())));
  const writeRaw = (l: string) => new Promise<void>((res) => (out.write(l + '\n') ? res() : out.once('drain', () => res())));

  const repo = (s: any, pathPrefix: string, role: string) => ({ repoId: s.repoId, role, repoPath: s.repoPath, commitSha: s.commitSha, sourceMode: s.sourceMode,
    sourceRoots: s.scope?.sourceRoots, analyzerVersion: s.analyzerVersion, schemaVersion: s.schemaVersion, finishedAt: s.finishedAt, pathPrefix });
  await write({
    type: 'snapshot', schemaVersion: '1.2.0', repoId: opts.systemId ?? 'justperform-system', repoPath: core.repoPath, commitSha: core.commitSha, sourceMode: core.sourceMode,
    analyzerVersion: `${VERSION} (${core.analyzerVersion} + ${ui.analyzerVersion})`, engine: `${core.engine} + ${ui.engine}`,
    startedAt: started.toISOString(), finishedAt: new Date().toISOString(),
    scope: { ...core.scope, primaryRepo: core.repoId, repos: [repo(core, '', 'backend'), repo(ui, prefix, 'frontend')], ui: ui.scope },
    stats: { ...core.stats, ui: ui.stats, stitch: result.stats, stitchOptions: { coreBases: opts.coreBases ?? ['process.env.JP_API'] } },
  });

  let first = true;
  for await (const l of lines(coreFile)) {
    if (first) {
      first = false;
      continue;
    }
    await writeRaw(l);
  }
  for (const o of uiRecs.slice(1)) {
    if (o.type === 'node') await write({ ...o, filePath: pre(o.filePath), attrs: { ...o.attrs, repoId: ui.repoId } });
    else if (o.type === 'edge') await write({ ...o, evidence: o.evidence.map((e: any) => ({ ...e, filePath: pre(e.filePath) })) });
    else await write({ ...o, filePath: pre(o.filePath) });
  }
  for (const k of result.links) {
    const c = byId.get(k.call)!;
    await write({
      type: 'edge', id: edgeId('CALLS_API', k.call, k.endpoint), kind: 'CALLS_API', src: k.call, dst: k.endpoint, resolution: k.resolution,
      evidence: [{ filePath: pre(c.filePath), line: c.line, endLine: c.endLine, column: c.column, rule: k.rule, resolution: k.resolution }],
      attrs: { url: k.url, ...(k.conditional ? { conditional: true } : {}), ...(k.viaParams ? { viaParams: true } : {}), crossRepo: true },
    });
  }
  for (const d of result.diagnostics) {
    const c = byId.get(d.call)!;
    await write({ type: 'diagnostic', severity: d.severity, code: d.code, message: d.message, filePath: pre(c.filePath), line: c.line });
  }
  await new Promise<void>((res) => out.end(res));
  return { out: resolve(outFile), endpoints: endpoints.length, stitch: result.stats };
}
