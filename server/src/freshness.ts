import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { DB } from './db.js';
import { gitAsync, safeRev } from './changes/git.js';
import { reposOf, type RepoRef } from './source.js';
import { VISIBLE } from './snapshots.js';

/**
 * Freshness of a snapshot against the source repositories, as four independent dimensions per repository:
 *   accuracy  — does the graph describe the selected revision (default HEAD)?   CURRENT / STALE / UNKNOWN
 *   branch    — selected commit vs its upstream (and, informational, the default branch)
 *   remote    — how current the remote information behind `branch` is
 *   worktree  — uncommitted changes inside the analyzer's input scope
 * No dimension changes another. Read-only git only: never fetches, never writes the index (--no-optional-locks).
 */

export type Accuracy = 'CURRENT' | 'STALE' | 'UNKNOWN';
export type BranchStatus = 'UP_TO_DATE' | 'BEHIND' | 'AHEAD' | 'DIVERGED' | 'NO_UPSTREAM' | 'UNKNOWN';
export type RemoteStatus = 'VERIFIED' | 'RECENT' | 'UNKNOWN' | 'NOT_APPLICABLE';
export type WorktreeStatus = 'CLEAN' | 'MODIFIED' | 'UNKNOWN';
export type Relation = 'SAME' | 'AHEAD' | 'BEHIND' | 'DIVERGED' | 'UNKNOWN';
export interface Reason { code: string; message: string }

export interface RepoFreshness {
  repoId: string; role: string | null; pathPrefix: string; repoPath: string | null; sourceMode: string | null;
  snapshotTimestamp: string | null; timestampSource: 'repo' | 'snapshot';
  /** = accuracy.status */
  status: Accuracy;
  accuracy: {
    status: Accuracy; indexedCommit: string;
    selected: { rev: string; commit: string | null; branch: string | null };
    indexedAheadOfSelected: number | null; indexedBehindSelected: number | null; reasons: Reason[];
  };
  branch: {
    status: BranchStatus; upstream: string | null; upstreamCommit: string | null;
    ahead: number | null; behind: number | null; asOf: string | null; source: 'tracking-ref' | 'ls-remote' | null; reasons: Reason[];
    default: { branch: string | null; commit: string | null; relation: Relation; ahead: number | null; behind: number | null };
  };
  remote: {
    status: RemoteStatus; name: string | null; url: string | null; source: 'tracking-ref' | 'ls-remote' | null;
    asOf: string | null; maxAgeHours: number; reasons: Reason[]; lastVerified: LiveResult | null;
  };
  worktree: { status: WorktreeStatus; changedInScope: number; changedOutsideScope: number; sample: string[]; warning: string | null; reasons: Reason[] };
}

export interface Freshness {
  /** Worst snapshot accuracy across repositories (STALE > UNKNOWN > CURRENT). */
  status: Accuracy;
  checkedAt: string;
  remoteMode: 'cached' | 'live';
  matchingSnapshotId: number | null;
  repos: RepoFreshness[];
}

export interface LiveResult { checkedAt: string; upstream: string | null; upstreamCommit: string | null; defaultBranch: string | null; defaultCommit: string | null }

export interface FreshnessOptions {
  /** Selected revision per repoId (branch, tag, sha); default HEAD. */
  revs?: Record<string, string>;
  remote?: 'cached' | 'live';
  refresh?: boolean;
  maxRemoteAgeHours?: number;
  liveTimeoutMs?: number;
  now?: () => number;
}

interface SnapLike {
  id: number; repoId: string; repoPath: string | null; commitSha: string; sourceMode?: string | null; engine?: string | null;
  finishedAt?: string | null; scope: Record<string, unknown>;
}

export class FreshnessInputError extends Error {}

const DEFAULT_MAX_REMOTE_AGE_H = Number(process.env.JCI_FRESHNESS_MAX_REMOTE_AGE_H ?? 24);
const CACHED_TTL_MS = 30_000;
const LIVE_TTL_MS = 5 * 60_000;
const HEADER_TTL_MS = 60_000;
const LIVE_TIMEOUT_MS = 8_000;

// ------------------------------------------------------------------------------------------------ analyzer input scope
/**
 * What the analyzers read, so unrelated or generated files never count as source changes. Mirrors
 * analyzer-java AnalyzerConfig (default config files) and analyzer-ui/src/source.ts EXTENSIONS (drift-tested); the
 * snapshot records the roots and schema dirs but not these lists.
 */
export const JAVA_CONFIG_FILES = ['src/main/resources/application.properties', 'src/main/resources/application.yml', 'src/main/resources/application.yaml'];
export const UI_EXTENSIONS = ['.vue', '.js', '.mjs', '.cjs', '.ts', '.mts', '.jsx', '.tsx'];

export interface AnalyzerScope { kind: 'java' | 'ui'; pathspecs: string[]; inScope: (path: string) => boolean }

const under = (p: string, dir: string) => { const d = dir.replace(/\\/g, '/').replace(/^\.\/|\/+$/g, ''); return d === '' || d === '.' || p === d || p.startsWith(d + '/'); };

export function analyzerScope(ref: RepoRef, snap: SnapLike): AnalyzerScope {
  const ui = ref.role === 'frontend' || (!ref.role && /typescript|vue/i.test(snap.engine ?? '') && !/spoon/i.test(snap.engine ?? ''));
  const roots = (ref.sourceRoots?.length ? ref.sourceRoots : ui ? ['src'] : ['src/main/java']).map((r) => r.replace(/\\/g, '/'));
  if (ui) {
    return {
      kind: 'ui', pathspecs: roots,
      inScope: (p) => roots.some((r) => under(p, r)) && !p.split('/').includes('node_modules') && UI_EXTENSIONS.some((e) => p.endsWith(e)),
    };
  }
  // Schema dirs are recorded for the primary (Java) repository only.
  const schemaDirs = !ref.pathPrefix && Array.isArray(snap.scope.schemaDirs) ? (snap.scope.schemaDirs as string[]).filter((d) => !isAbsolute(d)) : [];
  return {
    kind: 'java', pathspecs: [...roots, ...schemaDirs, ...JAVA_CONFIG_FILES],
    inScope: (p) => (roots.some((r) => under(p, r)) && p.endsWith('.java'))
      || (schemaDirs.some((d) => under(p, d)) && p.toLowerCase().endsWith('.sql'))
      || JAVA_CONFIG_FILES.includes(p),
  };
}

// ------------------------------------------------------------------------------------------------------------ helpers
/** user:password@ / token@ in remote URLs and in git error text. */
export const redactRemoteUrl = (s: string) => s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1');

const tryAsync = async (repo: string, args: string[], timeoutMs?: number) => {
  try {
    return (await gitAsync(repo, args, { timeoutMs })).trim();
  } catch {
    return null;
  }
};
const commitOf = (repo: string, rev: string) => tryAsync(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
/** [left-only, right-only] commit counts of a...b, or null when either object is missing. */
async function leftRight(repo: string, a: string, b: string): Promise<[number, number] | null> {
  const out = await tryAsync(repo, ['rev-list', '--left-right', '--count', `${a}...${b}`, '--']);
  const m = out ? /^(\d+)\s+(\d+)$/.exec(out) : null;
  return m ? [Number(m[1]), Number(m[2])] : null;
}
const relationOf = (lr: [number, number] | null): Relation =>
  !lr ? 'UNKNOWN' : lr[0] === 0 && lr[1] === 0 ? 'SAME' : lr[1] === 0 ? 'AHEAD' : lr[0] === 0 ? 'BEHIND' : 'DIVERGED';
const branchStatusOf = (r: Relation): BranchStatus => (r === 'SAME' ? 'UP_TO_DATE' : r);

/**
 * Last time the remote-tracking refs were updated: newest of the FETCH_HEAD mtime, the tracking ref's reflog and the
 * clone itself (clone writes no FETCH_HEAD and no reflog for remote refs, but HEAD's reflog records "clone: from …").
 */
async function remoteAsOf(repo: string, ref: string | null): Promise<number | null> {
  const times: number[] = [];
  const fh = await tryAsync(repo, ['rev-parse', '--git-path', 'FETCH_HEAD']);
  if (fh) {
    try {
      times.push(statSync(isAbsolute(fh) ? fh : join(repo, fh)).mtimeMs);
    } catch { /* never fetched */ }
  }
  const stamp = (t: string | null) => { if (t && /^\d+$/.test(t)) times.push(Number(t) * 1000); };
  if (ref) stamp(await tryAsync(repo, ['log', '-g', '-1', '--format=%ct', `refs/remotes/${ref}`, '--']));
  stamp(await tryAsync(repo, ['log', '-g', '-1', '--grep-reflog=clone: from', '--format=%ct', 'HEAD', '--']));
  return times.length ? Math.max(...times) : null;
}

/** Porcelain v1 -z entries → paths (renames: the new path). */
function porcelainPaths(out: string): string[] {
  const tok = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i]!;
    if (t.length < 4) continue;
    paths.push(t.slice(3));
    if (t[0] === 'R' || t[0] === 'C') i++;
  }
  return paths;
}

const lastVerified = new Map<string, LiveResult>();
type CacheEntry = { at: number; value: Promise<Freshness> };
const cache = new Map<string, CacheEntry>();
const headerCache = new Map<string, { at: number; status: Accuracy }>();
/** Identity of what a check describes: snapshot id plus every repository commit and path. */
const snapKey = (snap: SnapLike) => `${snap.id}|${reposOf(snap).map((r) => `${r.repoId}@${r.commitSha}:${r.repoPath ?? ''}:${r.sourceMode ?? ''}`).join(',')}`;

// ------------------------------------------------------------------------------------------------------------ per repo
async function checkRepo(ref: RepoRef & { finishedAt?: string }, snap: SnapLike, opts: Required<Pick<FreshnessOptions, 'remote' | 'maxRemoteAgeHours' | 'liveTimeoutMs' | 'now'>>,
  rev: string): Promise<RepoFreshness> {
  const maxAgeHours = opts.maxRemoteAgeHours;
  const out: RepoFreshness = {
    repoId: ref.repoId, role: ref.role ?? null, pathPrefix: ref.pathPrefix, repoPath: ref.repoPath, sourceMode: ref.sourceMode ?? null,
    snapshotTimestamp: ref.finishedAt ?? snap.finishedAt ?? null, timestampSource: ref.finishedAt ? 'repo' : 'snapshot',
    status: 'UNKNOWN',
    accuracy: { status: 'UNKNOWN', indexedCommit: ref.commitSha, selected: { rev, commit: null, branch: null }, indexedAheadOfSelected: null, indexedBehindSelected: null, reasons: [] },
    branch: { status: 'UNKNOWN', upstream: null, upstreamCommit: null, ahead: null, behind: null, asOf: null, source: null, reasons: [],
      default: { branch: null, commit: null, relation: 'UNKNOWN', ahead: null, behind: null } },
    remote: { status: 'UNKNOWN', name: null, url: null, source: null, asOf: null, maxAgeHours, reasons: [], lastVerified: null },
    worktree: { status: 'UNKNOWN', changedInScope: 0, changedOutsideScope: 0, sample: [], warning: null, reasons: [] },
  };
  const unknownAll = (code: string, message: string) => {
    const r = [{ code, message }];
    out.accuracy.reasons = r;
    out.branch.reasons = r;
    out.remote.reasons = r;
    out.worktree.reasons = r;
    return out;
  };
  const repo = ref.repoPath;
  if (!repo) return unknownAll('NO_REPO_PATH', 'The snapshot has no repository path; reload it with --repo-path');
  try {
    if (!statSync(repo).isDirectory()) throw new Error();
  } catch {
    return unknownAll('REPO_MISSING', `Repository folder not found: ${repo}`);
  }
  if (ref.commitSha.startsWith('nogit-')) return unknownAll('NOT_A_GIT_REPO', 'Indexed from a folder without git (content hash); revisions cannot be compared');
  if ((await tryAsync(repo, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return unknownAll('NOT_A_GIT_REPO', `${repo} is not a git working tree`);

  // ---- selected revision
  const selectedCommit = await commitOf(repo, rev);
  out.accuracy.selected.commit = selectedCommit;
  const headBranch = await tryAsync(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const selBranch = rev === 'HEAD' ? headBranch
    : (await tryAsync(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${rev}`])) ? rev : null;
  out.accuracy.selected.branch = selBranch;

  // ---- 1. accuracy
  const worktreeSnapshot = ref.sourceMode === 'WORKTREE';
  if (worktreeSnapshot) {
    out.accuracy.reasons.push({ code: 'WORKTREE_SNAPSHOT', message: 'Indexed from the working tree; its content at indexing time is not recorded, so it cannot be compared afterwards' });
  } else if (!selectedCommit) {
    out.accuracy.reasons.push({ code: 'SELECTED_REVISION_UNRESOLVED', message: `Revision ${rev} does not resolve to a commit in ${ref.repoId}` });
  } else if (selectedCommit === ref.commitSha) {
    out.accuracy.status = 'CURRENT';
    out.accuracy.indexedAheadOfSelected = 0;
    out.accuracy.indexedBehindSelected = 0;
  } else {
    out.accuracy.status = 'STALE';
    const lr = await leftRight(repo, ref.commitSha, selectedCommit);
    if (lr) [out.accuracy.indexedAheadOfSelected, out.accuracy.indexedBehindSelected] = lr;
    out.accuracy.reasons.push({ code: 'INDEXED_COMMIT_DIFFERS', message: `Graph indexed at ${ref.commitSha.slice(0, 12)}, selected ${rev} is ${selectedCommit.slice(0, 12)}`
      + (lr ? ` (selected has ${lr[1]} commit(s) not in the graph, graph has ${lr[0]} not in selected)` : ' (commit counts unavailable)') });
  }
  out.status = out.accuracy.status;

  // ---- remotes, upstream, default branch
  const remotes = ((await tryAsync(repo, ['remote'])) ?? '').split(/\r?\n/).filter(Boolean);
  const upBranch = selBranch ?? headBranch;
  const upstream = upBranch ? await tryAsync(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${upBranch}@{upstream}`]) : null;
  const upstreamRemote = upBranch ? await tryAsync(repo, ['config', '--get', `branch.${upBranch}.remote`]) : null;
  const remoteName = (upstreamRemote && remotes.includes(upstreamRemote) ? upstreamRemote : null) ?? (remotes.includes('origin') ? 'origin' : remotes[0] ?? null);
  out.remote.name = remoteName;
  if (remoteName) {
    const url = await tryAsync(repo, ['remote', 'get-url', remoteName]);
    out.remote.url = url ? redactRemoteUrl(url) : null;
  }
  let defaultBranch: string | null = null;
  if (remoteName) {
    defaultBranch = await tryAsync(repo, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remoteName}/HEAD`]);
    if (!defaultBranch) {
      for (const b of ['master', 'main']) if (await commitOf(repo, `refs/remotes/${remoteName}/${b}`)) { defaultBranch = `${remoteName}/${b}`; break; }
    }
  }

  // ---- 3. remote currency (decides where branch currency's remote side comes from)
  const now = opts.now();
  const asOfMs = remoteName ? await remoteAsOf(repo, upstream ?? defaultBranch) : null;
  const asOf = asOfMs ? new Date(asOfMs).toISOString() : null;
  out.remote.asOf = asOf;
  let live: LiveResult | null = null;
  const known = lastVerified.get(repo) ?? null;
  out.remote.lastVerified = known;
  if (!remoteName) {
    out.remote.status = 'NOT_APPLICABLE';
    out.remote.reasons.push({ code: 'NO_REMOTE', message: 'No git remote configured' });
  } else if (opts.remote === 'live') {
    try {
      const upRef = upstream && upstream.startsWith(`${remoteName}/`) ? `refs/heads/${upstream.slice(remoteName.length + 1)}` : null;
      const lsOut = await gitAsync(repo, ['ls-remote', '--symref', remoteName, 'HEAD', ...(upRef ? [upRef] : [])], { timeoutMs: opts.liveTimeoutMs });
      const lines = lsOut.split(/\r?\n/).filter(Boolean);
      const headSym = lines.map((l) => /^ref: refs\/heads\/(\S+)\s+HEAD$/.exec(l)?.[1]).find(Boolean) ?? null;
      // Skip the "ref: refs/heads/x<TAB>HEAD" symref line: only "<sha><TAB><name>" lines carry commits.
      const shaFor = (name: string) => lines.filter((l) => !l.startsWith('ref: ')).map((l) => l.split('\t')).find(([, n]) => n === name)?.[0] ?? null;
      live = {
        checkedAt: new Date(now).toISOString(),
        upstream, upstreamCommit: upRef ? shaFor(upRef) : null,
        defaultBranch: headSym ? `${remoteName}/${headSym}` : defaultBranch, defaultCommit: shaFor('HEAD'),
      };
      lastVerified.set(repo, live);
      out.remote.lastVerified = live;
      out.remote.status = 'VERIFIED';
      out.remote.source = 'ls-remote';
      out.remote.asOf = live.checkedAt;
    } catch (e) {
      const err = e as Error & { stderr?: string; killed?: boolean; signal?: string };
      const detail = err.killed || err.signal ? `timed out after ${opts.liveTimeoutMs} ms` : (err.stderr || err.message).split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
      out.remote.reasons.push({ code: 'REMOTE_UNAVAILABLE', message: `Live check of ${remoteName} failed: ${redactRemoteUrl(detail)}. Local results are unaffected; remote figures below are from the last fetch.` });
      out.remote.source = 'tracking-ref';
    }
  } else if (known && now - Date.parse(known.checkedAt) < LIVE_TTL_MS && known.upstream === upstream) {
    live = known;
    out.remote.status = 'VERIFIED';
    out.remote.source = 'ls-remote';
    out.remote.asOf = known.checkedAt;
  }
  if (remoteName && !live) {
    out.remote.source = 'tracking-ref';
    if (out.remote.reasons.some((r) => r.code === 'REMOTE_UNAVAILABLE')) out.remote.status = 'UNKNOWN';
    else if (!asOfMs) {
      out.remote.status = 'UNKNOWN';
      out.remote.reasons.push({ code: 'REMOTE_NEVER_FETCHED', message: `No fetch of ${remoteName} recorded; fetch the repository yourself or check the remote now` });
    } else if (now - asOfMs > maxAgeHours * 3_600_000) {
      out.remote.status = 'UNKNOWN';
      out.remote.reasons.push({ code: 'REMOTE_INFO_OUTDATED', message: `Last fetch of ${remoteName} was ${asOf} (older than ${maxAgeHours} h); fetch the repository yourself or check the remote now` });
    } else out.remote.status = 'RECENT';
  }

  // ---- 2. branch currency (selected commit vs upstream), default-branch relation (informational)
  out.branch.upstream = upstream;
  out.branch.source = remoteName ? (live ? 'ls-remote' : 'tracking-ref') : null;
  out.branch.asOf = live ? live.checkedAt : asOf;
  const compare = async (target: string | null, localRef: string | null): Promise<{ commit: string | null; lr: [number, number] | null; movedUnfetched: boolean }> => {
    if (!selectedCommit) return { commit: target, lr: null, movedUnfetched: false };
    const localSha = localRef ? await commitOf(repo, `refs/remotes/${localRef}`) : null;
    const commit = target ?? localSha;
    if (!commit) return { commit: null, lr: null, movedUnfetched: false };
    if (await commitOf(repo, commit)) return { commit, lr: await leftRight(repo, selectedCommit, commit), movedUnfetched: false };
    // Remote tip not fetched: behind (count unknown) only if the selected commit is already on that line locally.
    const onLine = localSha ? (await leftRight(repo, selectedCommit, localSha))?.[0] === 0 : false;
    return { commit, lr: null, movedUnfetched: onLine };
  };
  if (!upstream) {
    out.branch.status = 'NO_UPSTREAM';
    out.branch.reasons.push({ code: 'NO_UPSTREAM', message: upBranch ? `Branch ${upBranch} has no upstream` : 'Detached HEAD without an upstream' });
  } else if (!selectedCommit) {
    out.branch.reasons.push({ code: 'SELECTED_REVISION_UNRESOLVED', message: `Revision ${rev} does not resolve` });
  } else {
    const c = await compare(live ? live.upstreamCommit : null, upstream);
    out.branch.upstreamCommit = c.commit;
    if (c.lr) {
      out.branch.status = branchStatusOf(relationOf(c.lr));
      [out.branch.ahead, out.branch.behind] = c.lr;
    } else if (c.movedUnfetched) {
      out.branch.status = 'BEHIND';
      out.branch.ahead = 0;
      out.branch.reasons.push({ code: 'REMOTE_MOVED_NOT_FETCHED', message: `${upstream} moved on the remote to a commit not fetched locally; commit count unknown` });
    } else out.branch.reasons.push({ code: 'RELATION_UNKNOWN', message: `Relation of ${rev} to ${upstream} cannot be determined` });
  }
  const defBranch = live?.defaultBranch ?? defaultBranch;
  out.branch.default.branch = defBranch;
  if (defBranch && selectedCommit) {
    const d = await compare(live && live.defaultBranch === defBranch ? live.defaultCommit : null, defBranch);
    out.branch.default.commit = d.commit;
    out.branch.default.relation = d.lr ? relationOf(d.lr) : d.movedUnfetched ? 'BEHIND' : 'UNKNOWN';
    if (d.lr) [out.branch.default.ahead, out.branch.default.behind] = d.lr;
  }

  // ---- 4. working tree (analyzer scope only)
  if (worktreeSnapshot) {
    out.worktree.reasons.push({ code: 'WORKTREE_SNAPSHOT', message: 'Indexed from the working tree; uncommitted changes since indexing cannot be determined' });
  } else {
    const scope = analyzerScope(ref, snap);
    try {
      const st = ['-c', 'status.relativePaths=false', 'status', '--porcelain=v1', '-z'];
      const scoped = porcelainPaths(await gitAsync(repo, [...st, '--untracked-files=all', '--', ...scope.pathspecs]));
      const all = porcelainPaths(await gitAsync(repo, [...st, '--untracked-files=normal']));
      const inScope = scoped.filter(scope.inScope);
      const inSet = new Set(inScope);
      out.worktree.changedInScope = inScope.length;
      out.worktree.changedOutsideScope = all.filter((p) => !inSet.has(p) && !(p.endsWith('/') && inScope.some((q) => q.startsWith(p)))).length;
      out.worktree.sample = inScope.slice(0, 10);
      out.worktree.status = inScope.length ? 'MODIFIED' : 'CLEAN';
      if (inScope.length) {
        out.worktree.warning = `The graph is pinned to ${ref.commitSha.slice(0, 12)} and does not include ${inScope.length} uncommitted source change(s). `
          + 'Analyse them with `npm run impact -- --changes --core working` (or --ui working), or index with --mode WORKTREE.';
      }
    } catch (e) {
      out.worktree.reasons.push({ code: 'GIT_ERROR', message: `git status failed: ${redactRemoteUrl(((e as { stderr?: string }).stderr || (e as Error).message).trim().split(/\r?\n/)[0] ?? '')}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------- snapshot
const WORST: Accuracy[] = ['STALE', 'UNKNOWN', 'CURRENT'];
export const worstAccuracy = (xs: Accuracy[]): Accuracy => (xs.length ? WORST.find((w) => xs.includes(w))! : 'UNKNOWN');

/** A loaded snapshot (other than `exclude`) indexed exactly at the given commit of every repository. */
export function findMatchingSnapshot(db: DB, exclude: SnapLike, commits: Map<string, string>): number | null {
  const rows = db.prepare(`SELECT id, repo_id, commit_sha, source_mode, scope_json FROM snapshots s WHERE id != ? AND ${VISIBLE} ORDER BY id DESC`).all(exclude.id) as
    Array<{ id: number; repo_id: string; commit_sha: string; source_mode: string | null; scope_json: string }>;
  const multi = reposOf(exclude).length > 1;
  for (const r of rows) {
    if (r.source_mode === 'WORKTREE') continue;
    if (multi) {
      if (r.repo_id !== exclude.repoId) continue;
      const repos = (JSON.parse(r.scope_json) as { repos?: Array<{ repoId: string; commitSha: string }> }).repos ?? [];
      if (repos.length === commits.size && repos.every((x) => commits.get(x.repoId) === x.commitSha)) return r.id;
    } else if (r.repo_id === exclude.repoId && r.commit_sha === commits.get(exclude.repoId)) return r.id;
  }
  return null;
}

async function compute(db: DB, snap: SnapLike, opts: FreshnessOptions): Promise<Freshness> {
  const o = {
    remote: opts.remote ?? 'cached', maxRemoteAgeHours: opts.maxRemoteAgeHours ?? DEFAULT_MAX_REMOTE_AGE_H,
    liveTimeoutMs: opts.liveTimeoutMs ?? LIVE_TIMEOUT_MS, now: opts.now ?? Date.now,
  } as const;
  const refs = reposOf(snap) as Array<RepoRef & { finishedAt?: string }>;
  const repos = await Promise.all(refs.map((r) => checkRepo(r, snap, o, opts.revs?.[r.repoId] ?? 'HEAD')));
  const status = worstAccuracy(repos.map((r) => r.status));
  let matchingSnapshotId: number | null = null;
  if (status === 'STALE' && repos.every((r) => r.accuracy.selected.commit)) {
    matchingSnapshotId = findMatchingSnapshot(db, snap, new Map(repos.map((r) => [r.repoId, r.accuracy.selected.commit!])));
    if (matchingSnapshotId !== null) {
      for (const r of repos) if (r.status === 'STALE') r.accuracy.reasons.push({ code: 'MATCHING_SNAPSHOT_AVAILABLE', message: `Snapshot ${matchingSnapshotId} is indexed at the selected commit(s)` });
    }
  }
  const result: Freshness = { status, checkedAt: new Date(o.now()).toISOString(), remoteMode: o.remote, matchingSnapshotId, repos };
  if (!opts.revs || !Object.keys(opts.revs).length) headerCache.set(snapKey(snap), { at: o.now(), status });
  return result;
}

/** Validates per-repository revisions; throws FreshnessInputError for unknown repositories or unsafe input. */
export function validateRevs(snap: SnapLike, revs: Record<string, string>): void {
  const ids = new Set(reposOf(snap).map((r) => r.repoId));
  for (const [id, rev] of Object.entries(revs)) {
    if (!ids.has(id)) throw new FreshnessInputError(`Unknown repository ${id} (snapshot has ${[...ids].join(', ')})`);
    if (!safeRev(rev)) throw new FreshnessInputError(`Invalid revision for ${id}: use a branch, tag or commit (letters, digits, . _ / - ^ ~ @)`);
  }
}

/** Freshness with an in-memory cache (30 s cached mode, 5 min live) and de-duplicated concurrent checks. */
export function checkFreshness(db: DB, snap: SnapLike, opts: FreshnessOptions = {}): Promise<Freshness> {
  const revs = Object.fromEntries(Object.entries(opts.revs ?? {}).filter(([, v]) => v && v !== 'HEAD').sort(([a], [b]) => a.localeCompare(b)));
  try {
    validateRevs(snap, revs);
  } catch (e) {
    return Promise.reject(e);
  }
  const mode = opts.remote ?? 'cached';
  const key = `${snapKey(snap)}|${mode}|${JSON.stringify(revs)}|${opts.maxRemoteAgeHours ?? ''}`;
  const now = (opts.now ?? Date.now)();
  const hit = cache.get(key);
  if (hit && !opts.refresh && now - hit.at < (mode === 'live' ? LIVE_TTL_MS : CACHED_TTL_MS)) return hit.value;
  const value = compute(db, snap, { ...opts, revs });
  cache.set(key, { at: now, value });
  value.catch(() => cache.delete(key));
  return value;
}

/**
 * Snapshot status for the X-JCI-Snapshot-Status header, from the cache only: never runs git on the request path. A
 * missing or expired entry answers UNKNOWN and starts a background check for later requests.
 */
export function cachedSnapshotStatus(db: DB, snap: SnapLike, now = Date.now()): Accuracy {
  const h = headerCache.get(snapKey(snap));
  if (h && now - h.at < HEADER_TTL_MS) return h.status;
  checkFreshness(db, snap).catch(() => {});
  return 'UNKNOWN';
}

