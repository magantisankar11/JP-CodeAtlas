import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import type { GateResult, ImpactReport } from './types.js';

export interface GateDef {
  id: string;
  title: string;
  requirement: string;
  check: 'entry-points' | 'compatibility' | 'unknowns' | 'regression' | 'traceability' | 'root-cause' | 'human';
}

export const DEFAULT_GATES_FILE = resolve(import.meta.dirname, '../../../config/closure-gates.yaml');

export function loadGates(file = DEFAULT_GATES_FILE): GateDef[] {
  const doc = parse(readFileSync(file, 'utf8')) as { gates?: GateDef[] };
  const gates = doc.gates ?? [];
  const ids = new Set<string>();
  for (const g of gates) {
    if (!g.id || ids.has(g.id)) throw new Error(`closure gates: missing or duplicate id ${g.id}`);
    ids.add(g.id);
  }
  return gates;
}

/** Automatic checks only ever report evidence presence; they never declare a gate passed on a person's behalf. */
export function evaluateGates(gates: GateDef[], r: ImpactReport): GateResult[] {
  return gates.map((g) => {
    const base = { id: g.id, title: g.title, requirement: g.requirement };
    switch (g.check) {
      case 'entry-points':
        if (r.upstream.truncated) return { ...base, status: 'MISSING', note: 'Upstream traversal hit its budget; the entry point list is incomplete.' };
        if (r.unknowns.some((u) => u.kind === 'DEPTH_LIMIT') && !r.upstream.entryPoints.length) {
          return { ...base, status: 'MISSING', note: `No entry point within depth ${r.params.upstreamDepth}, but upstream paths continue beyond it: absence of impact is not shown. Rerun with a larger --up.` };
        }
        return r.unknowns.some((u) => u.kind === 'DEPTH_LIMIT')
          ? { ...base, status: 'EVIDENCE_PRESENT', note: `${r.upstream.entryPoints.length} entry point(s) classified within depth ${r.params.upstreamDepth}; some paths continue beyond it, so the list may be incomplete.` }
          : { ...base, status: 'EVIDENCE_PRESENT', note: `${r.upstream.entryPoints.length} entry point(s) classified (depth ${r.params.upstreamDepth})${r.ui ? `, including ${r.ui.routes.length} UI route(s)${r.ui.truncated ? ' (UI traversal truncated)' : ''}` : ''}.` };
      case 'compatibility':
        return { ...base, status: 'EVIDENCE_PRESENT', note: `${r.risks.length} risk(s) evaluated across API, database, configuration, integration, security and error handling. Reviewer confirms.` };
      case 'unknowns':
        return { ...base, status: 'EVIDENCE_PRESENT', note: `${r.unknowns.length} unknown(s) listed.` };
      case 'regression':
        return r.regressionCandidates.length
          ? { ...base, status: 'EVIDENCE_PRESENT', note: `${r.regressionCandidates.length} candidate(s) identified; execution results must be attached by the engineer.` }
          : { ...base, status: 'MISSING', note: 'No regression candidates could be derived.' };
      case 'traceability':
        // A graph that does not describe HEAD (or whose source has uncommitted changes) needs a person's attention.
        if (r.freshness && (r.freshness.status !== 'CURRENT' || r.freshness.repos.some((x) => x.worktree === 'MODIFIED'))) {
          return { ...base, status: 'NEEDS_HUMAN', note: r.freshness.repos.map((x) => `${x.repoId}: indexed ${x.indexedCommit.slice(0, 12)}, HEAD ${x.selectedCommit?.slice(0, 12) ?? '?'}, `
            + `accuracy ${x.accuracy}, working tree ${x.worktree}`).join('; ') + '. Findings cite file:line at the indexed commits; confirm they still apply.' };
        }
        return { ...base, status: 'EVIDENCE_PRESENT', note: r.snapshot.repos?.length
          ? `Commits ${r.snapshot.repos.map((x) => `${x.repoId}@${x.commitSha}`).join(', ')}; findings cite file:line at those commits (paths starting with @<repoId>/ belong to that repository).`
          : `Commit ${r.snapshot.commitSha}; findings cite file:line at that commit.` };
      case 'root-cause':
        return r.rootCauseCandidates.length
          ? { ...base, status: 'NEEDS_HUMAN', note: `${r.rootCauseCandidates.length} evidence-ranked candidate location(s) listed; the root cause itself must be confirmed by a person.` }
          : { ...base, status: 'NEEDS_HUMAN', note: 'No defect text supplied; root cause must be established by a person.' };
      default:
        return { ...base, status: 'NEEDS_HUMAN', note: 'Requires engineer input.' };
    }
  });
}
