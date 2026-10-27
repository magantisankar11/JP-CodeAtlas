import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const MASK = '***REDACTED***';
const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  [/\b(password|passwd|pwd|secret|client[_-]?secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key)\b(\s*[=:]\s*)(?![:?])('[^']*'|"[^"]*"|[^\s,;&)]+)/gi, `$1$2${MASK}`],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, MASK],
];

/** Same rules as the analyzer's Redactor: secrets never leave the server, bind parameters stay. */
export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export interface Excerpt {
  filePath: string;
  commitSha: string;
  from: number;
  to: number;
  totalLines: number;
  lines: Array<{ n: number; text: string }>;
}

const cache = new Map<string, string[]>();

/**
 * Reads a file exactly as it was at the snapshot's commit (`git show sha:path`); for non-git snapshots it reads
 * the working copy, as it does for WORKTREE snapshots (analysed from uncommitted files). Read-only: git runs with
 * --no-optional-locks.
 */
export function readAtCommit(repoPath: string, commitSha: string, filePath: string, worktree = false): string[] {
  const key = `${repoPath}|${worktree ? 'WORKTREE' : commitSha}|${filePath}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let text: string;
  if (worktree || commitSha.startsWith('nogit-')) {
    const root = resolve(repoPath);
    const full = resolve(root, filePath);
    if (!full.startsWith(root + sep)) throw new Error('path escapes repository');
    text = readFileSync(full, 'utf8');
  } else {
    text = execFileSync('git', ['--no-optional-locks', '-C', repoPath, 'show', `${commitSha}:${filePath}`], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  }
  const lines = text.split(/\r?\n/);
  if (cache.size > 200) cache.clear();
  cache.set(key, lines);
  return lines;
}

export function excerpt(repoPath: string, commitSha: string, filePath: string, from: number, to: number, context = 3, worktree = false): Excerpt {
  const all = readAtCommit(repoPath, commitSha, filePath, worktree);
  const start = Math.max(1, Math.min(from, to) - context);
  const end = Math.min(all.length, Math.max(from, to) + context, start + 400);
  const lines = [];
  for (let n = start; n <= end; n++) lines.push({ n, text: redact(all[n - 1] ?? '') });
  return { filePath, commitSha, from: start, to: end, totalLines: all.length, lines };
}

export interface RepoRef { repoId: string; repoPath: string | null; commitSha: string; pathPrefix: string; sourceRoots?: string[]; role?: string; sourceMode?: string | null }
interface SnapLike { repoId: string; repoPath: string | null; commitSha: string; scope: Record<string, unknown>; sourceMode?: string | null }

/**
 * Repositories of a snapshot. Single-repo snapshots have one, unprefixed. System snapshots (cli/combine.ts) list every
 * repository in scope.repos; files of non-primary repositories carry the prefix "@<repoId>/" in node and evidence paths.
 */
export function reposOf(snap: SnapLike): RepoRef[] {
  const listed = Array.isArray(snap.scope.repos) ? (snap.scope.repos as RepoRef[]) : [];
  if (!listed.length) {
    const roots = Array.isArray(snap.scope.sourceRoots) ? (snap.scope.sourceRoots as string[]) : undefined;
    return [{ repoId: snap.repoId, repoPath: snap.repoPath, commitSha: snap.commitSha, pathPrefix: '', sourceRoots: roots, sourceMode: snap.sourceMode }];
  }
  // The primary repository's path may be overridden at load time (--repo-path); keep that override.
  return listed.map((r) => (r.pathPrefix ? r : { ...r, repoPath: snap.repoPath ?? r.repoPath }));
}

/** Snapshot file path → the repository, commit and repo-relative path to read it from. */
export function locate(snap: SnapLike, filePath: string): { repo: RepoRef; path: string } {
  const repos = reposOf(snap).sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);
  for (const r of repos) if (r.pathPrefix && filePath.startsWith(r.pathPrefix)) return { repo: r, path: filePath.slice(r.pathPrefix.length) };
  const primary = repos.find((r) => !r.pathPrefix) ?? repos[repos.length - 1]!;
  return { repo: primary, path: filePath };
}

/** readAtCommit for a snapshot file path, routed to its repository. */
export function readSnapshotFile(snap: SnapLike, filePath: string): { lines: string[]; commitSha: string } {
  const { repo, path } = locate(snap, filePath);
  if (!repo.repoPath) throw new Error(`repository ${repo.repoId} has no path`);
  return { lines: readAtCommit(repo.repoPath, repo.commitSha, path, repo.sourceMode === 'WORKTREE'), commitSha: repo.commitSha };
}
