import type { Freshness } from '../freshness.js';
import { evaluateGates, loadGates } from './gates.js';
import type { FreshnessSummary, ImpactReport } from './types.js';

export function summarizeFreshness(f: Freshness): FreshnessSummary {
  return {
    checkedAt: f.checkedAt,
    status: f.status,
    repos: f.repos.map((r) => ({
      repoId: r.repoId, indexedCommit: r.accuracy.indexedCommit, selectedCommit: r.accuracy.selected.commit, selectedBranch: r.accuracy.selected.branch,
      accuracy: r.accuracy.status, branch: r.branch.status, branchAhead: r.branch.ahead, branchBehind: r.branch.behind, upstream: r.branch.upstream,
      remote: r.remote.status, remoteAsOf: r.remote.asOf, worktree: r.worktree.status, changedInScope: r.worktree.changedInScope,
      reasons: [...r.accuracy.reasons, ...r.branch.reasons, ...r.remote.reasons, ...r.worktree.reasons].map((x) => x.code).filter((c, i, a) => a.indexOf(c) === i),
    })),
  };
}

/**
 * Records the source freshness in an impact report: the summary, an unknown when local source changes are not in the
 * graph or the graph does not match HEAD, and the traceability gate re-evaluated with it.
 */
export function attachFreshness(report: ImpactReport, f: Freshness, gatesFile?: string): ImpactReport {
  report.freshness = summarizeFreshness(f);
  for (const r of f.repos) {
    if (r.worktree.status === 'MODIFIED') {
      report.unknowns.push({
        kind: 'LOCAL_MODIFICATIONS_NOT_INDEXED', file: null, line: null,
        detail: `${r.repoId}: ${r.worktree.changedInScope} uncommitted source change(s) (e.g. ${r.worktree.sample.slice(0, 3).join(', ')}) are not in the graph at ${r.accuracy.indexedCommit.slice(0, 12)}; this analysis does not cover them. Use --changes … working for them.`,
      });
    }
    if (r.accuracy.status !== 'CURRENT') {
      report.unknowns.push({
        kind: 'SNAPSHOT_NOT_CURRENT', file: null, line: null,
        detail: `${r.repoId}: snapshot accuracy ${r.accuracy.status} against ${r.accuracy.selected.rev}${r.accuracy.selected.commit ? ` (${r.accuracy.selected.commit.slice(0, 12)})` : ''}: ${r.accuracy.reasons.map((x) => x.message).join('; ')}`,
      });
    }
  }
  report.gates = evaluateGates(loadGates(gatesFile), report);
  return report;
}
