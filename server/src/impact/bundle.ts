import type { DB } from '../db.js';
import type { EdgeDto, NodeDto } from '../contract.js';
import { getNode, PRESETS, traverse } from '../query.js';
import { readSnapshotFile, redact } from '../source.js';
import type { DefectMatch } from './defect.js';
import type { SnapshotInfo } from './engine.js';
import { renderImpactMarkdown, renderJiraDraft, renderTestsMarkdown } from './render.js';
import { CONTEXT_SCHEMA, type ImpactReport } from './types.js';

export interface BundleOptions {
  title: string;
  defectText?: string;
  match?: DefectMatch;
  /** Total source lines across all excerpts (keeps the bundle focused). */
  maxExcerptLines?: number;
  maxLinesPerExcerpt?: number;
}

interface Excerpt { file: string; from: number; to: number; commitSha: string; why: string; text: string }

/**
 * Focused, machine-readable context for an AI assistant: never the whole repository. Every excerpt is read from the
 * snapshot commit (`git show <sha>:<path>`), redacted, and labelled with why it was included.
 */
export function buildContextBundle(db: DB, snap: SnapshotInfo, report: ImpactReport, opts: BundleOptions): Record<string, string> {
  const sid = snap.id;
  const budget = opts.maxExcerptLines ?? 600;
  const perExcerpt = opts.maxLinesPerExcerpt ?? 80;

  // Verified execution path: forward flow from method/endpoint targets using only confirmed or framework-derived links.
  const flows = report.targets
    .filter((t) => t.kind === 'METHOD' || t.kind === 'API_ENDPOINT')
    .map((t) => traverse(db, sid, { root: t.id, direction: 'forward', depth: report.params.downstreamDepth, edgeKinds: PRESETS.flow!, minResolution: 'FRAMEWORK_DERIVED', includeAccessors: false, collapseDispatch: true, limit: 300 })!)
    .filter(Boolean);
  const flowEdges = flows.flatMap((g) => g.edges);
  const flowNodes = new Map(flows.flatMap((g) => g.nodes.map((n) => [n.id, n] as const)));

  // Excerpts in priority order until the line budget is spent.
  const excerpts: Excerpt[] = [];
  let used = 0;
  const seen = new Set<string>();
  const take = (file: string | null, from: number | null, to: number | null, why: string) => {
    if (!file || !from || used >= budget) return;
    const end = Math.min(to ?? from, from + perExcerpt - 1, from + (budget - used) - 1);
    const key = `${file}:${from}`;
    if (seen.has(key)) return;
    seen.add(key);
    let lines: string[];
    let commitSha: string;
    try {
      ({ lines, commitSha } = readSnapshotFile(snap, file));
    } catch {
      return;
    }
    const slice = lines.slice(from - 1, end).map(redact);
    if (!slice.length) return;
    excerpts.push({ file, from, to: from + slice.length - 1, commitSha, why, text: slice.join('\n') });
    used += slice.length;
  };
  const node = (id: string): NodeDto | undefined => flowNodes.get(id) ?? getNode(db, sid, id);
  for (const t of report.targets) take(t.file, t.line, node(t.id)?.lineEnd ?? t.line, 'analysis target');
  for (const c of report.rootCauseCandidates) take(c.file, c.line, node(c.nodeId)?.lineEnd ?? c.line, `root-cause candidate (${c.strength}): ${c.reasons[0] ?? ''}`);
  for (const d of report.directlyAffected) take(d.file, d.line, node(d.id)?.lineEnd ?? d.line, d.note ?? 'directly affected');
  // Direct callers: defects often sit where a target is invoked (argument checks, null handling, branching).
  for (const c of report.upstream.callers.filter((x) => x.depth === 1).slice(0, 6)) take(c.file, c.line, Math.min(node(c.id)?.lineEnd ?? c.line!, (c.line ?? 0) + 50), 'direct caller');
  for (const m of report.downstream.methods.filter((x) => x.depth === 1).slice(0, 12)) take(m.file, m.line, Math.min(node(m.id)?.lineEnd ?? m.line!, (m.line ?? 0) + 30), 'direct callee');
  for (const t of report.database) for (const s of t.statements.slice(0, 3)) take(s.file, s.line ? Math.max(1, s.line - 2) : null, s.line ? s.line + 4 : null, `SQL on ${t.table}`);
  for (const e of report.errorHandling) for (const th of e.thrownAt.slice(0, 2)) take(th.file, th.line ? Math.max(1, th.line - 2) : null, th.line ? th.line + 2 : null, `throws ${e.exception}`);
  for (const ep of report.upstream.entryPoints.filter((f) => f.classification === 'CONFIRMED_DEPENDENCY' && f.depth <= 3).slice(0, 8)) {
    take(ep.file, ep.line, Math.min(node(ep.id)?.lineEnd ?? ep.line!, (ep.line ?? 0) + 25), 'confirmed entry point handler');
  }

  const contracts = report.upstream.entryPoints.concat(report.targets)
    .filter((f) => f.kind === 'API_ENDPOINT')
    .slice(0, 25)
    .map((f) => {
      const n = node(f.id);
      const a = (n?.attrs ?? {}) as Record<string, any>;
      return { endpoint: f.name, fullPath: a.fullPath, handler: a.handler, params: a.params, requestBody: a.requestBody, responseType: a.responseType, security: a.security, classification: f.classification };
    });

  const files = new Map<string, Array<{ from: number; to: number; why: string }>>();
  for (const x of excerpts) {
    const list = files.get(x.file) ?? [];
    list.push({ from: x.from, to: x.to, why: x.why });
    files.set(x.file, list);
  }

  const context = {
    schema: CONTEXT_SCHEMA,
    snapshot: report.snapshot,
    generatedAt: report.generatedAt,
    title: opts.title,
    usage: 'Evidence for an AI assistant. Excerpts are exact at snapshot.commitSha; re-read files from the working tree before editing (it may differ). Classifications: CONFIRMED_DEPENDENCY / POTENTIAL_IMPACT / UNKNOWN.',
    defect: opts.defectText ? { text: redact(opts.defectText).slice(0, 4000), signals: opts.match?.signals ?? null, candidates: opts.match?.candidates.slice(0, 25) ?? [] } : null,
    targets: report.targets,
    verifiedExecutionPath: flowEdges.map((e: EdgeDto) => ({
      from: e.src, to: e.dst, kind: e.kind, resolution: e.resolution, file: e.evidence[0]?.filePath ?? null, line: e.evidence[0]?.line ?? null,
      ...(e.attrs.conditional ? { conditional: true } : {}),
    })),
    contracts,
    files: [...files.entries()].map(([path, ranges]) => ({ path, ranges })),
    excerpts,
    excerptBudget: { maxLines: budget, usedLines: used },
    relatedTests: { existing: report.tests, regressionCandidates: report.regressionCandidates },
    impactedEntryPoints: report.upstream.entryPoints,
    impactedCallers: report.upstream.callers.slice(0, 80),
    database: report.database,
    externals: report.downstream.externals,
    risks: report.risks,
    unknowns: report.unknowns,
    gates: report.gates,
    rootCauseCandidates: report.rootCauseCandidates,
  };

  const dependencies = {
    schema: CONTEXT_SCHEMA,
    snapshot: report.snapshot,
    note: 'Bounded subgraphs around the targets; IDs follow schemas/graph-v1.schema.json.',
    downstream: { nodes: [...flowNodes.values()].map(slim), edges: flowEdges },
    upstream: { entryPoints: report.upstream.entryPoints, callers: report.upstream.callers, truncated: report.upstream.truncated },
  };

  return {
    'context.json': JSON.stringify(context, null, 2),
    'flow.md': renderFlow(report, flows.map((g) => ({ root: g.root, nodes: new Map(g.nodes.map((n) => [n.id, n])), edges: g.edges }))),
    'dependencies.json': JSON.stringify(dependencies, null, 2),
    'impact-analysis.md': renderImpactMarkdown(report, opts.title),
    'relevant-tests.md': renderTestsMarkdown(report, opts.title),
    'jira-draft.md': renderJiraDraft(report, opts.title),
  };
}

function slim(n: NodeDto & { depth?: number }) {
  return { id: n.id, kind: n.kind, name: n.name, fqn: n.fqn, signature: n.signature, filePath: n.filePath, lineStart: n.lineStart, lineEnd: n.lineEnd, depth: n.depth };
}

/** Execution tree (confirmed + framework-derived links only), each step with its source location. */
function renderFlow(r: ImpactReport, flows: Array<{ root: string; nodes: Map<string, NodeDto>; edges: EdgeDto[] }>): string {
  const out = [`# Execution flow`, '', `Commit \`${r.snapshot.commitSha}\`. Only CONFIRMED and FRAMEWORK_DERIVED links; ambiguous/unresolved links are listed in impact-analysis.md.`, ''];
  if (!flows.length) out.push('_No method or endpoint target: no forward flow to show._');
  const name = (n?: NodeDto) => (n ? (n.kind === 'METHOD' && n.fqn ? `${n.fqn.split('#')[0]!.split('.').pop()}.${n.name}()` : n.name) : '?');
  for (const f of flows) {
    const children = new Map<string, EdgeDto[]>();
    for (const e of f.edges) children.set(e.src, [...(children.get(e.src) ?? []), e]);
    const printed = new Set<string>();
    const walk = (id: string, indent: number, via?: EdgeDto) => {
      const n = f.nodes.get(id);
      const tag = via ? `[${via.kind.toLowerCase()}${via.resolution === 'FRAMEWORK_DERIVED' ? ', derived' : ''}${via.attrs.conditional ? ', conditional' : ''}] ` : '';
      const where = via?.evidence[0]?.filePath ? ` — call at \`${via.evidence[0].filePath}:${via.evidence[0].line}\`` : n?.filePath ? ` — \`${n.filePath}:${n.lineStart}\`` : '';
      const repeated = printed.has(id);
      out.push(`${'  '.repeat(indent)}- ${tag}**${name(n)}**${where}${repeated ? ' _(expanded above)_' : ''}`);
      if (repeated || indent > 12) return;
      printed.add(id);
      for (const e of children.get(id) ?? []) walk(e.dst, indent + 1, e);
    };
    out.push(`## From ${name(f.nodes.get(f.root))}`, '');
    walk(f.root, 0);
    out.push('');
  }
  return out.join('\n');
}
