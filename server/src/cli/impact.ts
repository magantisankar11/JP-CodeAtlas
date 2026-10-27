import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '../db.js';
import { buildContextBundle } from '../impact/bundle.js';
import { matchDefect, rootCauseCandidates, type DefectMatch } from '../impact/defect.js';
import { analyzeChanges } from '../changes/run.js';
import { analyzeImpact, MAX_UPSTREAM_DEPTH } from '../impact/engine.js';
import { renderChangeMarkdown } from '../impact/render.js';
import { resolveSnapshot } from '../query.js';
import { VISIBLE } from '../snapshots.js';
import { readSnapshotFile, redact, reposOf } from '../source.js';
import { tryGit } from '../changes/git.js';
import { checkFreshness } from '../freshness.js';
import { attachFreshness } from '../impact/freshness.js';

/**
 * Impact analysis and Claude context bundle, read-only against the analysed repository.
 *
 *   npm run impact -- --repo justperform-core --defect ticket.txt --match-only        # numbered candidates (JSON)
 *   npm run impact -- --repo justperform-core --defect ticket.txt --pick 1,4 --title JP-123
 *   npm run impact -- --repo justperform-core --target "method:a.B#c()" --target type:a.Dto --title change-x
 *   npm run impact -- --changes --core bug/JP-123 [--ui bug/JP-123] [--core-base origin/master] --title JP-123
 *   npm run impact -- --repo justperform-system --status [--rev justperform-core=bug/JP-123] [--remote live]
 *
 * Without --pick, only EXACT defect matches become targets; WEAK matches are never selected automatically.
 * --changes takes per repository a branch, a commit, a range (A..B, A...B) or "working"; see changes/run.ts.
 */
const { values } = parseArgs({
  options: {
    db: { type: 'string', default: process.env.JCI_DB ?? resolve(import.meta.dirname, '../../../workspace/jci.db') },
    repo: { type: 'string' },
    snapshot: { type: 'string' },
    target: { type: 'string', multiple: true, default: [] },
    defect: { type: 'string' },
    pick: { type: 'string' },
    'match-only': { type: 'boolean', default: false },
    title: { type: 'string' },
    out: { type: 'string' },
    up: { type: 'string' },
    down: { type: 'string', default: '4' },
    gates: { type: 'string' },
    'max-excerpt-lines': { type: 'string', default: '600' },
    status: { type: 'boolean', default: false },
    rev: { type: 'string', multiple: true, default: [] },
    remote: { type: 'string', default: 'cached' },
    callers: { type: 'string' },
    changes: { type: 'boolean', default: false },
    core: { type: 'string' },
    ui: { type: 'string' },
    'core-base': { type: 'string' },
    'ui-base': { type: 'string' },
    'changes-db': { type: 'string', default: process.env.JCI_CHANGES_DB ?? resolve(import.meta.dirname, '../../../workspace/jci-changes.db') },
  },
});

const db = openDb(values.db!);
// Change analysis prefers the current system (multi-repository) snapshot when no snapshot is named.
const latestSystem = values.changes && !values.repo && !values.snapshot
  ? (db.prepare(`SELECT id FROM snapshots s WHERE json_extract(scope_json, '$.repos') IS NOT NULL AND ${VISIBLE}
       ORDER BY s.id IN (SELECT snapshot_id FROM current_snapshots) DESC, id DESC LIMIT 1`).get() as { id: number } | undefined)?.id
  : undefined;
const snap = resolveSnapshot(db, values.snapshot ? Number(values.snapshot) : latestSystem, values.repo);
if (!snap) {
  console.error(`No snapshot found${values.repo ? ` for repo ${values.repo}` : ''} in ${values.db}`);
  process.exit(2);
}

if (values.changes) {
  const jciRoot = resolve(import.meta.dirname, '../../..');
  const changesDb = openDb(values['changes-db']!);
  const log = (m: string) => console.error(m);
  let result;
  try {
    result = await analyzeChanges(snap, { core: values.core, ui: values.ui, coreBase: values['core-base'], uiBase: values['ui-base'] }, {
      jciRoot, graphDirs: [join(jciRoot, 'workspace', 'graphs')], cacheDir: join(jciRoot, 'workspace', 'graphs', 'cache'), db: changesDb, log,
      // Changed code is often deep inside utilities: search for entry points as far as the engine allows.
      upstreamDepth: values.up ? Number(values.up) : MAX_UPSTREAM_DEPTH, downstreamDepth: Number(values.down), gatesFile: values.gates,
    });
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(2);
  }
  const title = values.title ?? [values.core, values.ui].filter(Boolean).join(' + ');
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'change';
  const outDir = resolve(values.out ?? resolve(jciRoot, 'workspace', 'bundles', slug));
  for (const r of reposOf(snap)) {
    if (r.repoPath && (outDir + sep).toLowerCase().startsWith(resolve(r.repoPath).toLowerCase() + sep)) {
      console.error(`error: --out ${outDir} is inside repository ${r.repoId}; choose a folder outside it`);
      process.exit(2);
    }
  }
  mkdirSync(outDir, { recursive: true });
  const files: Record<string, string> = result.report
    ? buildContextBundle(changesDb, result.snap, result.report, { title, maxExcerptLines: Number(values['max-excerpt-lines']) })
    : { 'impact-analysis.md': `# Change analysis: ${title}\n\n${result.note}\n\n${renderChangeMarkdown(result.change)}\n` };
  files['change.json'] = JSON.stringify(result.change, null, 2);
  if (result.patch) files['change.diff'] = result.patch;
  for (const [name, content] of Object.entries(files)) writeFileSync(join(outDir, name), content);
  const r = result.report;
  const count = (c: string) => r?.upstream.entryPoints.filter((e) => e.classification === c).length ?? 0;
  console.log(JSON.stringify({
    outDir,
    files: Object.keys(files),
    repos: result.change.repos.map((x) => ({ repoId: x.repoId, spec: x.spec, base: `${x.baseSha.slice(0, 12)} (${x.base.how})`, head: x.headSha?.slice(0, 12) ?? (x.mode === 'worktree' ? 'working tree' : null), commits: x.commits.length, files: x.files.length })),
    changed: result.change.nodes.map((n) => `${n.change} ${n.kind} ${n.name}`).slice(0, 30),
    analysedOn: result.change.analysedOn,
    ...(r ? {
      entryPoints: { confirmed: count('CONFIRMED_DEPENDENCY'), potential: count('POTENTIAL_IMPACT'), unknown: count('UNKNOWN'), truncated: r.upstream.truncated },
      ui: r.ui ? { routes: r.ui.routes.length, components: r.ui.components.length, httpCalls: r.ui.httpCalls.length } : undefined,
      risks: r.risks.map((k) => `${k.classification}: ${k.title}`),
      regressionCandidates: r.regressionCandidates.length,
    } : { note: result.note }),
  }, null, 2));
  changesDb.close();
  db.close();
  process.exit(0);
}

if (values.status) {
  // Freshness per repository (freshness.ts): snapshot accuracy, branch currency, remote currency, working tree.
  // `repoHead` / `current` keep their original meaning (HEAD and HEAD equality) for existing callers.
  const revs: Record<string, string> = {};
  for (const r of values.rev!) {
    const i = r.indexOf('=');
    if (i < 1) {
      console.error(`--rev expects <repoId>=<branch|tag|sha>, got ${r}`);
      process.exit(2);
    }
    revs[r.slice(0, i)] = r.slice(i + 1);
  }
  if (values.remote !== 'cached' && values.remote !== 'live') {
    console.error('--remote must be cached or live');
    process.exit(2);
  }
  let fr;
  try {
    fr = await checkFreshness(db, snap, { revs, remote: values.remote });
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(2);
  }
  const repos = reposOf(snap).map((r) => {
    const h = r.repoPath && !r.commitSha.startsWith('nogit-') ? tryGit(r.repoPath, 'rev-parse', 'HEAD') : null;
    const f = fr.repos.find((x) => x.repoId === r.repoId)!;
    return {
      repoId: r.repoId, role: r.role, repoPath: r.repoPath, commitSha: r.commitSha, pathPrefix: r.pathPrefix, repoHead: h, current: h === null ? null : h === r.commitSha,
      status: f.status, accuracy: f.accuracy, branch: f.branch, remote: f.remote, worktree: f.worktree,
    };
  });
  const primary = repos.find((r) => !r.pathPrefix) ?? repos[0]!;
  console.log(JSON.stringify({
    snapshot: { id: snap.id, repoId: snap.repoId, commitSha: snap.commitSha, sourceMode: snap.sourceMode, finishedAt: snap.finishedAt, repoPath: snap.repoPath },
    repoHead: primary.repoHead,
    current: repos.some((r) => r.current === null) ? null : repos.every((r) => r.current),
    status: fr.status, checkedAt: fr.checkedAt, remoteMode: fr.remoteMode, matchingSnapshotId: fr.matchingSnapshotId,
    ...(repos.length > 1 ? { repos } : { accuracy: primary.accuracy, branch: primary.branch, remote: primary.remote, worktree: primary.worktree }),
  }, null, 2));
  process.exit(0);
}

if (values.callers) {
  // Every call site of a method with the source line at the snapshot commit: shows the arguments actually passed.
  const rows = db.prepare(`SELECT src, resolution, evidence_json FROM edges WHERE snapshot_id = ? AND dst = ? AND kind = 'CALLS'`)
    .all(snap.id, values.callers) as Array<{ src: string; resolution: string; evidence_json: string }>;
  const sites = rows.flatMap((r) => (JSON.parse(r.evidence_json) as Array<{ filePath: string; line: number; endLine?: number }>).map((ev) => {
    let text = '';
    try {
      text = readSnapshotFile(snap, ev.filePath).lines.slice(ev.line - 1, Math.max(ev.line, ev.endLine ?? ev.line)).map((l) => redact(l.trim())).join(' ');
    } catch {
      text = '(source unavailable)';
    }
    return { caller: r.src, resolution: r.resolution, file: ev.filePath, line: ev.line, code: text };
  }));
  console.log(JSON.stringify({ snapshot: { repoId: snap.repoId, commitSha: snap.commitSha }, callee: values.callers, sites }, null, 2));
  process.exit(0);
}

let defectText: string | undefined;
let match: DefectMatch | undefined;
if (values.defect) {
  defectText = values.defect === '-' ? readFileSync(0, 'utf8') : readFileSync(values.defect, 'utf8');
  match = matchDefect(db, snap, defectText);
  if (values['match-only']) {
    console.log(JSON.stringify({
      snapshot: { id: snap.id, repoId: snap.repoId, commitSha: snap.commitSha },
      signals: match.signals,
      candidates: match.candidates.map((c, i) => ({ n: i + 1, ...c })),
    }, null, 2));
    process.exit(0);
  }
}

let targets = [...values.target!];
if (match) {
  const picked = values.pick
    ? values.pick.split(',').map((s) => match!.candidates[Number(s.trim()) - 1]).filter(Boolean)
    : match.candidates.filter((c) => c.strength === 'EXACT').slice(0, 5);
  targets.push(...picked.map((c) => c!.nodeId));
}
targets = [...new Set(targets)];
if (!targets.length) {
  console.error('No targets. Pass --target ID, or --defect FILE with --pick N[,M] (run with --match-only to see candidates).');
  process.exit(2);
}

const report = analyzeImpact(db, snap, {
  targets,
  upstreamDepth: values.up ? Number(values.up) : undefined,
  downstreamDepth: Number(values.down),
  rootCauses: match ? rootCauseCandidates(match) : undefined,
}, values.gates);
// Record whether the graph still describes HEAD and whether uncommitted source changes are missing from it.
attachFreshness(report, await checkFreshness(db, snap), values.gates);

const title = values.title ?? report.targets.map((t) => t.name).join(', ').slice(0, 80);
const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'impact';
const outDir = resolve(values.out ?? resolve(import.meta.dirname, `../../../workspace/bundles/${snap.repoId}-${snap.commitSha.slice(0, 12)}-${slug}`));
mkdirSync(outDir, { recursive: true });
const files = buildContextBundle(db, snap, report, { title, defectText, match, maxExcerptLines: Number(values['max-excerpt-lines']) });
for (const [name, content] of Object.entries(files)) writeFileSync(join(outDir, name), content);

const count = (c: string) => report.upstream.entryPoints.filter((e) => e.classification === c).length;
console.log(JSON.stringify({
  outDir,
  files: Object.keys(files),
  snapshot: report.snapshot,
  targets: report.targets.map((t) => t.id),
  entryPoints: { confirmed: count('CONFIRMED_DEPENDENCY'), potential: count('POTENTIAL_IMPACT'), unknown: count('UNKNOWN'), truncated: report.upstream.truncated },
  risks: report.risks.map((r) => `${r.classification}: ${r.title}`),
  unknowns: report.unknowns.length,
  regressionCandidates: report.regressionCandidates.length,
  gates: report.gates.map((g) => `${g.id} ${g.status}`),
}, null, 2));
db.close();
