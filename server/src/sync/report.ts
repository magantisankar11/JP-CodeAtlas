import type { SyncReport } from './run.js';

/** Human-readable sync summary (the JSON report holds the same facts). */
export function renderSyncReport(r: SyncReport): string {
  const s = (x: string | null | undefined) => (x ? x.slice(0, 10) : '—');
  const sec = (ms: number) => `${Math.round(ms / 100) / 10} s`;
  const lines: string[] = [];
  lines.push(`sync ${r.outcome}${r.error ? ` at step ${r.error.step}` : ''} in ${sec(r.durationMs)}`);
  if (r.config) lines.push(`  repositories from ${r.config.source === 'config' ? r.config.file : 'the current snapshot'}; publishes ${r.config.publishId}`);
  for (const x of r.repos) {
    lines.push(`  ${x.repoId.padEnd(20)} ${x.rev} = ${s(x.commit)}  ${(x.action ?? 'NOT_REACHED').padEnd(11)} ${x.reason}${x.durationMs ? ` (${sec(x.durationMs)})` : ''}`);
  }
  if (r.combine) lines.push(`  combine: ${r.combine.reused ? 'reused' : 'built'} ${r.combine.file} (${sec(r.combine.durationMs)})`);
  if (r.load) lines.push(`  load: snapshot ${r.load.snapshotId} ${r.load.reused ? '(already loaded)' : `${r.load.nodes} nodes, ${r.load.edges} edges (${sec(r.load.durationMs)})`}`);
  for (const c of r.validation) lines.push(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.check}: ${c.detail}`);
  if (r.publish) lines.push(`  published snapshot ${r.publish.current}${r.publish.previous !== null ? ` (previous ${r.publish.previous} stays loaded)` : ''}`);
  if (r.error) lines.push(`  error: ${r.error.message}`, `  current snapshot unchanged: ${r.current ?? 'none'}`);
  else lines.push(`  current snapshot: ${r.current ?? 'none'}`);
  if (r.freshness) {
    for (const f of r.freshness.repos) {
      lines.push(`  freshness ${f.repoId}: ${f.accuracy}, branch ${f.branch}${f.branchBehind ? ` (behind ${f.branchBehind})` : ''}, remote ${f.remote}, worktree ${f.worktree}`);
    }
  }
  if (r.cleanedPending.length) lines.push(`  removed PENDING snapshot(s): ${r.cleanedPending.join(', ')}`);
  for (const w of r.warnings) lines.push(`  warning: ${w}`);
  return lines.join('\n');
}
