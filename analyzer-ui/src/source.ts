import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const EXTENSIONS = ['.vue', '.js', '.mjs', '.cjs', '.ts', '.mts', '.jsx', '.tsx'];

export interface SourceSet {
  repo: string;
  commitSha: string;
  mode: 'HEAD' | 'WORKTREE';
  files: Map<string, string>;
  /** git status before reading, to prove nothing changed. */
  statusBefore: string | null;
}

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['--no-optional-locks', '-C', repo, ...args],
    { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });

/** True when `dir` is the top level of a git work tree. Asks git (show-cdup is empty at the top level) instead of
 *  comparing paths, which differ on Windows between 8.3 short names and long names. */
function isRepoRoot(dir: string): boolean {
  try {
    return git(dir, 'rev-parse', '--show-cdup').trim() === '' && git(dir, 'rev-parse', '--is-inside-work-tree').trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Reads source files of the given roots exactly as committed (`git ls-tree` + one `git cat-file --batch` process).
 * Nothing is written to the repository; for non-git folders the working copy is read and a content hash stands in for the SHA.
 */
export function readSources(repo: string, roots: string[], commit?: string): SourceSet {
  const wanted = (p: string) => EXTENSIONS.some((e) => p.endsWith(e)) && !p.includes('/node_modules/');
  if (!isRepoRoot(repo)) {
    if (commit) throw new Error(`${repo} is not the top level of a git repository; --commit ${commit} cannot be honoured`);
    const files = new Map<string, string>();
    for (const r of roots) walk(join(repo, r), repo, files, wanted);
    const h = createHash('sha256');
    for (const [p, t] of [...files.entries()].sort()) h.update(p + '\n' + t);
    return { repo, commitSha: `nogit-${h.digest('hex').slice(0, 12)}`, mode: 'WORKTREE', files, statusBefore: null };
  }
  const statusBefore = git(repo, 'status', '--porcelain=v1');
  const sha = git(repo, 'rev-parse', '--verify', `${commit ?? 'HEAD'}^{commit}`).trim();
  const listing = git(repo, 'ls-tree', '-r', '-z', '--full-tree', sha, '--', ...roots)
    .split('\0').filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [, type, oid] = line.slice(0, tab).split(' ');
      return { type, oid: oid!, path: line.slice(tab + 1) };
    })
    .filter((e) => e.type === 'blob' && wanted(e.path));
  const out = spawnSync('git', ['--no-optional-locks', '-C', repo, 'cat-file', '--batch'], {
    input: listing.map((e) => e.oid).join('\n') + '\n', maxBuffer: 1 << 30, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (out.status !== 0) throw new Error(`git cat-file failed: ${out.stderr?.toString()}`);
  const buf = out.stdout as Buffer;
  const files = new Map<string, string>();
  let pos = 0;
  for (const e of listing) {
    const nl = buf.indexOf(10, pos);
    const header = buf.subarray(pos, nl).toString('utf8');
    const size = Number(header.split(' ')[2]);
    files.set(e.path, buf.subarray(nl + 1, nl + 1 + size).toString('utf8'));
    pos = nl + 1 + size + 1;
  }
  return { repo, commitSha: sha, mode: 'HEAD', files, statusBefore };
}

/**
 * Working-copy sources (tracked and untracked, not ignored) for analysing uncommitted changes. commitSha stays HEAD and
 * mode is WORKTREE: line numbers refer to the files on disk, not to HEAD. Still read-only.
 */
export function readWorktree(repo: string, roots: string[]): SourceSet {
  const wanted = (p: string) => EXTENSIONS.some((e) => p.endsWith(e)) && !p.includes('/node_modules/');
  const statusBefore = git(repo, 'status', '--porcelain=v1');
  const sha = git(repo, 'rev-parse', '--verify', 'HEAD^{commit}').trim();
  const files = new Map<string, string>();
  for (const p of git(repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...roots).split('\0').filter(Boolean)) {
    if (!wanted(p)) continue;
    try {
      files.set(p, readFileSync(join(repo, p), 'utf8'));
    } catch {
      // deleted in the working tree
    }
  }
  return { repo, commitSha: sha, mode: 'WORKTREE', files, statusBefore };
}

export function verifyUnchanged(s: SourceSet) {
  if (s.statusBefore === null) return;
  const after = git(s.repo, 'status', '--porcelain=v1');
  if (after !== s.statusBefore) throw new Error('Target repository status changed during analysis');
}

function walk(dir: string, root: string, out: Map<string, string>, wanted: (p: string) => boolean) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, root, out, wanted);
    else {
      const rel = relative(root, full).split(sep).join('/');
      if (wanted(rel)) out.set(rel, readFileSync(full, 'utf8'));
    }
  }
}
