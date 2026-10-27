import type { ChangeSummary, Classification, Finding, FreshnessSummary, ImpactReport, RegressionCandidate } from './types.js';

const CLS: Record<Classification, string> = {
  CONFIRMED_DEPENDENCY: 'Confirmed dependency',
  POTENTIAL_IMPACT: 'Potential impact — needs investigation',
  UNKNOWN: 'Unknown — insufficient evidence',
};

const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const at = (f: { file: string | null; line: number | null }) => (f.file ? `\`${f.file}:${f.line ?? '?'}\`` : '—');
const short = (sha: string) => sha.slice(0, 12);
const commits = (r: ImpactReport) =>
  (r.snapshot.repos?.length ? `commits ${r.snapshot.repos.map((x) => `${x.repoId} \`${x.commitSha}\``).join(', ')}` : `commit \`${r.snapshot.commitSha}\``);

function table(head: string[], rows: unknown[][]): string {
  if (!rows.length) return '_None._\n';
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') + '\n';
}

function findings(list: Finding[], limit = 60): string {
  const rows = list.slice(0, limit).map((f) => [CLS[f.classification].split(' —')[0], f.name, f.basis.toLowerCase().replace('_', ' ') + (f.viaEnclosingType ? ', via enclosing type' : ''), f.depth, at(f)]);
  return table(['Class', 'Item', 'Evidence basis', 'Depth', 'Location'], rows) + (list.length > limit ? `\n_${list.length - limit} more not shown (see dependencies.json)._\n` : '');
}

function groupCounts(list: Finding[]) {
  const c = { CONFIRMED_DEPENDENCY: 0, POTENTIAL_IMPACT: 0, UNKNOWN: 0 };
  list.forEach((f) => c[f.classification]++);
  return c;
}

/** Snapshot accuracy, branch currency, remote currency and working tree, each on its own. */
export function renderFreshnessMarkdown(f: FreshnessSummary): string {
  const count = (a: number | null, b: number | null) => (a === null && b === null ? '' : ` (ahead ${a ?? '?'}, behind ${b ?? '?'})`);
  return ['## Source freshness', '',
    `Checked ${f.checkedAt} against each repository's HEAD. Snapshot accuracy: **${f.status}**.`, '',
    table(['Repository', 'Indexed', 'Selected (HEAD)', 'Snapshot accuracy', 'Branch currency', 'Remote information', 'Working tree'], f.repos.map((r) => [
      r.repoId, r.indexedCommit.slice(0, 12), `${r.selectedCommit?.slice(0, 12) ?? '?'}${r.selectedBranch ? ` (${r.selectedBranch})` : ''}`, r.accuracy,
      `${r.branch}${r.upstream ? ` vs ${r.upstream}` : ''}${count(r.branchAhead, r.branchBehind)}`, `${r.remote}${r.remoteAsOf ? ` as of ${r.remoteAsOf}` : ''}`,
      `${r.worktree}${r.changedInScope ? ` (${r.changedInScope} source change(s) not in the graph)` : ''}`,
    ]))].join('\n');
}

export function renderImpactMarkdown(r: ImpactReport, title: string): string {
  const eps = groupCounts(r.upstream.entryPoints);
  const lines: string[] = [];
  lines.push(`# Impact analysis: ${title}`, '');
  lines.push(`Repository **${r.snapshot.repoId}** at ${commits(r)} (${r.snapshot.sourceMode ?? '?'}, analyzer ${r.snapshot.analyzerVersion ?? '?'}). Generated ${r.generatedAt}.`, '');
  lines.push('> Findings are static-analysis evidence, not runtime observations. Classes: **Confirmed dependency** (compiler facts or deterministic framework rules), '
    + '**Potential impact** (ambiguous dispatch or only through a field of an enclosing type), **Unknown** (an unresolved link such as reflection or runtime-built SQL/URL). '
    + 'No numeric scores are produced.', '');
  lines.push('## Summary', '');
  lines.push(`- Targets: ${r.targets.map((t) => `\`${t.name}\``).join(', ')}`);
  lines.push(`- Entry points reaching the targets: **${r.upstream.entryPoints.length}** (${eps.CONFIRMED_DEPENDENCY} confirmed, ${eps.POTENTIAL_IMPACT} potential, ${eps.UNKNOWN} unknown)${r.upstream.truncated ? ' — **traversal budget reached, list incomplete**' : ''}`);
  lines.push(`- Upstream callers: ${r.upstream.callers.length}; downstream methods: ${r.downstream.methods.length}; tables: ${r.database.length}; outbound calls: ${r.downstream.externals.length}`);
  if (r.ui) {
    lines.push(`- Frontend: ${r.ui.httpCalls.length} HTTP call site(s), ${r.ui.components.length} component(s)/module(s), ${r.ui.routes.length} route(s)${r.ui.truncated ? ' — **UI traversal incomplete**' : ''}`);
  }
  lines.push(`- Risks: ${r.risks.length}; unknowns: ${r.unknowns.length}; regression candidates: ${r.regressionCandidates.length}`);
  lines.push(`- Tests: ${r.tests.note}`, '');
  if (r.change) lines.push(renderChangeMarkdown(r.change), '');
  if (r.freshness) lines.push(renderFreshnessMarkdown(r.freshness), '');

  if (r.rootCauseCandidates.length) {
    lines.push('## Root-cause candidates (evidence-ranked, not conclusions)', '');
    lines.push(table(['Strength', 'Location', 'Code', 'Why'], r.rootCauseCandidates.map((c) => [c.strength, at(c), c.name, c.reasons.join('; ')])));
  }
  lines.push('## Directly affected code', '', findings(r.directlyAffected));
  lines.push('## Entry points (endpoints, jobs, listeners)', '', findings(r.upstream.entryPoints, 120));
  lines.push('## Upstream callers', '', findings(r.upstream.callers, 60));
  lines.push('## Downstream dependencies', '', findings(r.downstream.methods, 60));
  if (r.sharedUtilities.length) {
    lines.push('### Shared utilities on the path', '', '_Widely called helpers used by the affected code. They are context, not impacted; changing them as part of this fix would need its own impact analysis._', '',
      table(['Method', 'Callers', 'Calling types', 'Location'], r.sharedUtilities.map((s) => [s.name, s.callers, s.callerTypes, at(s)])));
  }
  if (r.ui) {
    lines.push('## Frontend consumers (UI → API)', '', '_Paths starting with `@<repoId>/` are in that repository. UI HTTP calls are linked to endpoints by HTTP method and URL path segments '
      + '(framework-derived); ties and partial matches are potential impact._', '');
    lines.push('### Routes', '', findings(r.ui.routes, 40));
    lines.push('### HTTP call sites', '', table(['Class', 'Call', 'Endpoint', 'Location'],
      r.ui.httpCalls.slice(0, 60).map((f) => [CLS[f.classification].split(' —')[0], f.name, f.note?.replace(/^calls /, '') ?? '', at(f)])));
    lines.push('### Components and modules', '', findings(r.ui.components, 60));
  }
  lines.push('## Data contracts of affected endpoints', '');
  lines.push(table(['Endpoint', 'Accepts', 'Returns', 'Class'], r.dataContracts.slice(0, 80).map((d) => [d.endpoint, d.accepts.join(', '), d.returns.join(', '), CLS[d.classification].split(' —')[0] + (d.viaEnclosingType ? ' (via enclosing type)' : '')])));
  lines.push('## Database interactions', '');
  lines.push(table(['Table', 'In migrations', 'Reads', 'Writes', 'Other writers', 'Entities', 'Statements'],
    r.database.map((t) => [t.table, t.inCatalog ? 'yes' : 'no', t.reads, t.writes, t.writersOutsideImpact, t.entities.join(', '),
      t.statements.slice(0, 4).map((s) => `${s.operation} ${s.file?.split('/').pop()}:${s.line}${s.resolution === 'FRAMEWORK_DERIVED' && s.conditionalTable ? ' (conditional)' : ''}`).join('; ')])));
  lines.push('## Outbound integrations', '', findings(r.downstream.externals));
  lines.push('## Error handling', '');
  lines.push(table(['Exception', 'Thrown at', 'Handlers', 'HTTP handling'],
    r.errorHandling.map((e) => [e.exception, e.thrownAt.slice(0, 3).map((t) => `${t.method}${t.declared ? ' (throws clause)' : ''} ${t.file?.split('/').pop()}:${t.line}`).join('; '),
      e.handlers.map((h) => `${h.handler}${h.status ? ` → ${h.status}` : ''} [${h.basis.toLowerCase()}]`).join('; ') || '—', e.handled])));
  lines.push('## Security (URL rules) of affected endpoints', '');
  lines.push(table(['Endpoint', 'Rule', 'Matcher', 'Caution'], r.security.slice(0, 80).map((s) => [s.endpoint, `${s.rule}${s.args.length ? `(${s.args.join(', ')})` : ''}`, s.matcher ?? '', s.caution ?? ''])));
  if (r.configuration.length) {
    lines.push('## Configuration keys read', '', table(['Key', 'Defined in property files', 'Readers'], r.configuration.map((c) => [c.key, c.defined ? 'yes' : 'no', c.readers])));
  }
  lines.push('## Backward-compatibility and regression risks', '');
  for (const k of r.risks) {
    lines.push(`### ${k.title}`, '', `*${k.category}* · **${CLS[k.classification]}**`, '', k.detail, '');
    if (k.evidence.length) lines.push(k.evidence.slice(0, 8).map((e) => `- ${e.nodeId ? `\`${e.nodeId.replace(/^(method|type|endpoint):/, '')}\` ` : ''}${at(e)}`).join('\n'), '');
  }
  if (!r.risks.length) lines.push('_No risk rule fired. This is not evidence of safety; review unknowns below._', '');
  lines.push('## Unknowns', '');
  lines.push(table(['Kind', 'Detail', 'Location'], r.unknowns.map((u) => [u.kind, u.detail, at(u)])));
  lines.push('## Regression test candidates', '', `See \`relevant-tests.md\` (${r.regressionCandidates.length} candidates).`, '');
  lines.push('## Closure quality gates', '');
  lines.push(table(['Gate', 'Status', 'Note'], r.gates.map((g) => [`${g.id} ${g.title}`, g.status, g.note])));
  return lines.join('\n');
}

/** What changed, per repository: the compared commits, files, declarations and contract differences. */
export function renderChangeMarkdown(c: ChangeSummary): string {
  const lines: string[] = ['## Change set', ''];
  lines.push(`_Impact below is computed on the **${c.analysedOn}** graph: ${c.analysedOn === 'base'
    ? 'the dependents of code that existed before the change.' : 'the change only adds code; dependents are those of the new code.'}_`, '');
  lines.push(table(['Repository', 'Change', 'Base', 'Head', 'Commits', 'Files'], c.repos.map((r) => [
    r.repoId, r.spec ?? 'unchanged', `${short(r.baseSha)} (${r.base.how})`, r.headSha ? short(r.headSha) : r.mode === 'worktree' ? 'working tree' : short(r.baseSha),
    r.commits.length, r.files.length,
  ])));
  for (const r of c.repos.filter((x) => x.commits.length)) {
    lines.push(`**${r.repoId} commits:** ${r.commits.slice(0, 20).map((m) => `\`${m.sha.slice(0, 10)}\` ${m.subject}`).join('; ')}${r.commits.length > 20 ? ` … ${r.commits.length - 20} more` : ''}`, '');
  }
  const files = c.repos.flatMap((r) => r.files.map((f) => [r.repoId, f.status, f.path, `+${f.added}/-${f.removed}`, f.mappedNodes]));
  if (files.length) lines.push('### Changed files', '', table(['Repository', 'Status', 'File', 'Lines', 'Declarations'], files.slice(0, 80)));
  lines.push('### Changed declarations', '', table(['Change', 'Kind', 'Item', 'Location'], c.nodes.slice(0, 100).map((n) => [n.change, n.kind, n.name, at(n)])));
  if (c.endpoints.length) lines.push('### Endpoint differences', '', table(['Change', 'Endpoint', 'Detail'], c.endpoints.map((e) => [e.change, e.name, e.to ? `→ ${e.to}` : e.fields?.join(', ') ?? ''])));
  const fieldRows = [...c.types, ...c.tables].map((t) => [t.kind, t.name, t.added.join(', '), t.removed.join(', '), t.retyped.join(', ')]);
  if (fieldRows.length) lines.push('### Field and column differences', '', table(['Kind', 'Name', 'Added', 'Removed', 'Retyped'], fieldRows));
  if (c.calls.length) {
    lines.push('### New and removed calls in modified code', '', table(['Method', 'Now calls', 'No longer calls'],
      c.calls.slice(0, 40).map((x) => [x.name, x.added.map((d) => d.replace(/^(method|ui:fn):/, '')).join(', '), x.removed.map((d) => d.replace(/^(method|ui:fn):/, '')).join(', ')])));
  }
  const ui = c.uiLinks.filter((u) => u.change !== 'NEW_LINKED');
  if (c.uiLinks.length) {
    lines.push('### UI → API link differences', '', ui.length
      ? table(['Change', 'UI call', 'Before', 'After', 'Location'], ui.map((u) => [u.change, u.name + (u.urlBefore ? ` (was ${u.urlBefore})` : ''), u.before.join(', ') || '—', u.after.join(', ') || '—', at(u)]))
      : `_${c.uiLinks.length} new UI call(s), all linked to an endpoint._\n`);
  }
  return lines.join('\n');
}

export function renderTestsMarkdown(r: ImpactReport, title: string): string {
  const lines = [`# Relevant tests: ${title}`, '', `At ${commits(r)}.`, '', '## Existing tests', '', r.tests.note, ''];
  if (r.tests.existing.length) lines.push(...r.tests.existing.map((f) => `- \`${f.file}\` — ${f.note ?? ''}`), '');
  lines.push('## Recommended regression candidates', '', 'Ordered by level, then evidence class. Candidates are recommendations derived from the dependency graph; none have been executed.', '');
  const levels: RegressionCandidate['level'][] = ['UNIT', 'API', 'CONTRACT', 'ERROR_PATH', 'JOB', 'DATA', 'UI_COMPONENT', 'UI_E2E'];
  for (const lv of levels) {
    const list = r.regressionCandidates.filter((c) => c.level === lv);
    if (!list.length) continue;
    lines.push(`### ${lv}`, '');
    for (const c of list) {
      lines.push(`- [ ] **${c.title}** — ${CLS[c.classification].split(' —')[0]}`);
      lines.push(`  - Why: ${c.rationale}`);
      lines.push(`  - Where: \`${c.suggestedLocation}\``);
      for (const h of c.hints) lines.push(`  - ${h}`);
      if (c.evidence.length) lines.push(`  - Evidence: ${c.evidence.slice(0, 3).map(at).join(', ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function renderJiraDraft(r: ImpactReport, title: string): string {
  const eps = groupCounts(r.upstream.entryPoints);
  const confirmed = r.upstream.entryPoints.filter((f) => f.classification === 'CONFIRMED_DEPENDENCY');
  const lines = [`h2. Impact analysis — ${title}`, '', `*Commit:* ${r.snapshot.repos?.length ? r.snapshot.repos.map((x) => `${short(x.commitSha)} (${x.repoId})`).join(', ') : `${short(r.snapshot.commitSha)} (${r.snapshot.repoId})`} · generated by java-code-intel ${r.snapshot.analyzerVersion ?? ''}`, ''];
  lines.push('h3. Root cause', '', r.rootCauseCandidates.length
    ? `_To be confirmed by the engineer._ Evidence-ranked candidate locations:\n${r.rootCauseCandidates.slice(0, 5).map((c) => `* ${c.strength}: {{${c.name}}} at {{${c.file}:${c.line}}} — ${c.reasons.join('; ')}`).join('\n')}`
    : '_To be completed by the engineer._', '');
  if (r.change) {
    const changed = r.change.nodes.filter((n) => n.change !== 'ADDED');
    lines.push('h3. Fix', '', ...r.change.repos.filter((x) => x.spec).map((x) =>
      `* ${x.repoId}: {{${x.spec}}} — ${x.commits.length} commit(s) ${x.commits.slice(0, 5).map((m) => `{{${m.sha.slice(0, 10)}}} ${m.subject}`).join('; ')} · ${x.files.length} file(s)`),
    `* Changed: ${changed.slice(0, 10).map((n) => `{{${n.name}}}`).join(', ') || 'additions only'}${changed.length > 10 ? ` … ${changed.length - 10} more` : ''}`, '');
  } else {
    lines.push('h3. Fix', '', '_Smallest safe change, alternatives considered, files touched — to be completed._', '');
  }
  lines.push('h3. Impact', '', `* Entry points reaching the changed code: ${r.upstream.entryPoints.length} (${eps.CONFIRMED_DEPENDENCY} confirmed, ${eps.POTENTIAL_IMPACT} potential, ${eps.UNKNOWN} unknown)${r.upstream.truncated ? ' — incomplete (budget reached)' : ''}`);
  for (const f of confirmed.slice(0, 15)) lines.push(`** ${f.name}`);
  if (confirmed.length > 15) lines.push(`** … ${confirmed.length - 15} more in impact-analysis.md`);
  if (r.ui) {
    lines.push(`* UI: ${r.ui.routes.length} route(s), ${r.ui.components.filter((c) => c.kind === 'UI_COMPONENT').length} component(s), ${r.ui.httpCalls.length} HTTP call site(s)`
      + (r.ui.routes.length ? ` — ${r.ui.routes.slice(0, 8).map((x) => x.name).join(', ')}` : ''));
  }
  lines.push(`* Tables: ${r.database.map((t) => `${t.table} (R${t.reads}/W${t.writes})`).join(', ') || 'none'}`);
  lines.push(`* Outbound calls: ${r.downstream.externals.map((e) => e.name).slice(0, 8).join(', ') || 'none'}`, '');
  lines.push('h3. Backward compatibility', '', r.risks.length ? r.risks.map((k) => `* [${k.classification.replace('_', ' ').toLowerCase()}] ${k.title}`).join('\n') : '* No risk rule fired (not evidence of safety).', '');
  lines.push('h3. Regression tests', '', ...r.regressionCandidates.slice(0, 15).map((c) => `* ( ) ${c.level}: ${c.title}`), r.regressionCandidates.length > 15 ? `* … ${r.regressionCandidates.length - 15} more in relevant-tests.md` : '', '_Attach execution results before closure._', '');
  lines.push('h3. Unknowns and residual risk', '', ...r.unknowns.slice(0, 12).map((u) => `* ${u.kind}: ${u.detail}`), '');
  lines.push('h3. Closure gates', '', '||Gate||Status||Note||', ...r.gates.map((g) => `|${g.id} ${g.title}|${g.status}|${g.note.replace(/\|/g, '/')}|`), '');
  lines.push('_Draft only: review and edit before posting. Nothing was written to Jira._');
  return lines.join('\n');
}
