import { execFile, execFileSync } from 'node:child_process';

/**
 * Read-only git for change analysis: rev-parse, merge-base, rev-list, log, diff, ls-files. Nothing is checked out,
 * fetched or written; every call uses --no-optional-locks so even the index stat cache is left alone.
 */
export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}
export const tryGit = (repo: string, ...args: string[]): string | null => {
  try {
    return git(repo, ...args).trim();
  } catch {
    return null;
  }
};
/** Never prompt for credentials (terminal, Git Credential Manager dialog or ssh passphrase): fail instead. */
export const NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };

/** Asynchronous {@link git} for the API server: same read-only flags, no prompts, bounded by a timeout. */
export function gitAsync(repo: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  return new Promise((ok, fail) => {
    execFile('git', ['--no-optional-locks', '-C', repo, ...args], {
      encoding: 'utf8', maxBuffer: 64 << 20, timeout: opts.timeoutMs ?? 30_000, windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...NO_PROMPT_ENV },
    }, (err, stdout, stderr) => (err ? fail(Object.assign(err, { stderr: String(stderr) })) : ok(stdout)));
  });
}

/** A user-supplied revision (branch, tag, sha, HEAD~1): plain characters only, never an option, no ranges or reflog syntax. */
export const SAFE_REV = /^(?!-)[A-Za-z0-9._/@^~-]{1,200}$/;
export const safeRev = (rev: string) => SAFE_REV.test(rev) && !rev.includes('..') && !rev.includes('@{');

export const sha = (repo: string, rev: string) => tryGit(repo, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`);
export const isAncestor = (repo: string, a: string, b: string) => {
  try {
    git(repo, 'merge-base', '--is-ancestor', a, b);
    return true;
  } catch {
    return false;
  }
};
export const count = (repo: string, range: string) => Number(tryGit(repo, 'rev-list', '--count', range) ?? '0');

export interface Commit { sha: string; subject: string }
export interface ResolvedChange {
  spec: string;
  /** 'commits': base..head; 'worktree': uncommitted changes (tracked + untracked) against HEAD. */
  mode: 'commits' | 'worktree';
  baseSha: string;
  headSha: string | null;
  /** How the base was chosen, for the report. */
  base: { ref: string; how: string };
  /** Other base candidates considered (closest first). */
  alternatives: Array<{ ref: string; commits: number; how: string }>;
  commits: Commit[];
}

/** Base candidates when a bare branch is given: the default branch plus long-lived integration branches. */
export const DEFAULT_BASE_PATTERNS = ['refs/remotes/origin/build/*', 'refs/remotes/origin/release/*', 'refs/remotes/origin/develop', 'refs/remotes/origin/development'];
const MAX_CANDIDATES = 40;

export function defaultBranch(repo: string): string {
  const head = tryGit(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (head) return head;
  for (const b of ['origin/master', 'origin/main', 'master', 'main']) if (sha(repo, b)) return b;
  throw new Error(`${repo}: cannot determine the default branch; pass a base explicitly`);
}

function commitsOf(repo: string, base: string, head: string): Commit[] {
  const out = tryGit(repo, 'log', '--no-merges', '--format=%H%x09%s', `${base}..${head}`) ?? '';
  return out.split('\n').filter(Boolean).map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) }));
}

/**
 * Where did this branch start, relative to candidate C?
 *  - not merged into C: merge-base(C, head)
 *  - already merged into C: the first merge on the ancestry path head..C whose first parent does not contain head
 *    brought the branch in; the branch's own commits start at merge-base(that merge's first parent, head)
 */
function baseAgainst(repo: string, candidate: string, head: string, mergedCache?: Map<string, { base: string; merge: string } | null>):
  { base: string; how: string } | null {
  const c = sha(repo, candidate);
  if (!c) return null;
  if (c === head) return null;
  if (!isAncestor(repo, head, c)) {
    const mb = tryGit(repo, 'merge-base', c, head);
    return mb ? { base: mb, how: `merge-base with ${candidate}` } : null;
  }
  // Every candidate that contains the branch got it through the same first merge; walk the history only once.
  const cached = mergedCache?.get(head);
  if (cached !== undefined) {
    return cached && isAncestor(repo, cached.merge, c)
      ? { base: cached.base, how: `already merged into ${candidate} by ${cached.merge.slice(0, 10)}; base is that merge's first parent` }
      : cached === null ? null : baseAgainst(repo, candidate, head);
  }
  const found = firstMerge(repo, c, head);
  mergedCache?.set(head, found);
  return found ? { base: found.base, how: `already merged into ${candidate} by ${found.merge.slice(0, 10)}; base is that merge's first parent` } : null;
}

function firstMerge(repo: string, c: string, head: string): { base: string; merge: string } | null {
  const merges = (tryGit(repo, 'rev-list', '--ancestry-path', '--merges', '--reverse', `${head}..${c}`) ?? '').split('\n').filter(Boolean);
  for (const m of merges) {
    const p1 = sha(repo, `${m}^1`);
    if (p1 && !isAncestor(repo, head, p1)) {
      const mb = tryGit(repo, 'merge-base', p1, head);
      if (mb) return { base: mb, merge: m };
    }
  }
  return null;
}

function candidates(repo: string, patterns: string[], exclude: string): string[] {
  const out = new Set<string>([defaultBranch(repo)]);
  const refs = (tryGit(repo, 'for-each-ref', '--sort=-committerdate', `--count=${MAX_CANDIDATES}`, '--format=%(refname:short)', ...patterns) ?? '')
    .split('\n').filter(Boolean);
  for (const r of refs) if (r !== exclude) out.add(r);
  return [...out];
}

/**
 * Change specs:
 *   working              uncommitted changes against HEAD
 *   A..B                 commits reachable from B and not from A
 *   A...B                B against merge-base(A, B)
 *   <branch>             the branch's own commits: base = the closest candidate (default branch, build/release/develop
 *                        branches), handling branches that were already merged
 *   <commit>             that single commit against its first parent
 * `baseOverride` replaces the automatic base for <branch> specs.
 */
export function resolveChange(repo: string, spec: string, opts: { baseOverride?: string; basePatterns?: string[] } = {}): ResolvedChange {
  if (spec === 'working') {
    const head = sha(repo, 'HEAD');
    if (!head) throw new Error(`${repo}: no HEAD commit`);
    return { spec, mode: 'worktree', baseSha: head, headSha: null, base: { ref: 'HEAD', how: 'uncommitted changes against HEAD' }, alternatives: [], commits: [] };
  }
  const tri = spec.match(/^(.+?)\.\.\.(.+)$/);
  const two = tri ? null : spec.match(/^(.+?)\.\.(.+)$/);
  const range = tri ?? two;
  if (range) {
    const [, a, b] = range;
    const head = sha(repo, b!);
    const left = sha(repo, a!);
    if (!head || !left) throw new Error(`${repo}: cannot resolve ${!head ? b : a}`);
    const base = tri ? tryGit(repo, 'merge-base', left, head) : left;
    if (!base) throw new Error(`${repo}: ${a} and ${b} have no common history`);
    return { spec, mode: 'commits', baseSha: base, headSha: head, base: { ref: a!, how: tri ? `merge-base with ${a}` : `range start ${a}` }, alternatives: [], commits: commitsOf(repo, base, head) };
  }
  // A branch that exists only on the remote may be named without "origin/".
  if (!sha(repo, spec) && sha(repo, `origin/${spec}`)) spec = `origin/${spec}`;
  const head = sha(repo, spec);
  if (!head) {
    const leaf = spec.split('/').pop()!;
    const near = tryGit(repo, 'for-each-ref', '--count=5', '--format=%(refname:short)', `refs/heads/**/*${leaf}*`, `refs/remotes/**/*${leaf}*`);
    throw new Error(`${repo}: '${spec}' is not a branch or commit${near ? `; did you mean: ${near.split('\n').join(', ')}` : ''}`);
  }
  const isBranch = Boolean(tryGit(repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${spec}`, `refs/remotes/${spec}`));
  if (opts.baseOverride) {
    const b = sha(repo, opts.baseOverride);
    if (!b) throw new Error(`${repo}: cannot resolve base ${opts.baseOverride}`);
    const against = baseAgainst(repo, opts.baseOverride, head);
    if (!against) throw new Error(`${repo}: ${spec} has no commits of its own relative to ${opts.baseOverride}`);
    return { spec, mode: 'commits', baseSha: against.base, headSha: head, base: { ref: opts.baseOverride, how: against.how }, alternatives: [], commits: commitsOf(repo, against.base, head) };
  }
  if (!isBranch) {
    const parent = sha(repo, `${head}^1`);
    if (!parent) throw new Error(`${repo}: ${spec} has no parent commit`);
    return { spec, mode: 'commits', baseSha: parent, headSha: head, base: { ref: `${spec}^1`, how: 'single commit against its first parent' }, alternatives: [], commits: commitsOf(repo, parent, head) };
  }
  const cache = new Map<string, { base: string; merge: string } | null>();
  const scored: Array<{ ref: string; base: string; how: string; commits: number }> = [];
  for (const ref of candidates(repo, opts.basePatterns ?? DEFAULT_BASE_PATTERNS, spec)) {
    const b = baseAgainst(repo, ref, head, cache);
    if (!b) continue;
    const n = count(repo, `${b.base}..${head}`);
    if (n > 0) scored.push({ ref, base: b.base, how: b.how, commits: n });
    if (scored.length >= 4 && scored.some((s) => s.commits === 1)) break; // cannot do better than one commit
  }
  if (!scored.length) throw new Error(`${repo}: no base found for ${spec}; pass the base explicitly (e.g. --core-base origin/master)`);
  const def = defaultBranch(repo);
  scored.sort((x, y) => x.commits - y.commits || Number(y.ref === def) - Number(x.ref === def));
  const best = scored[0]!;
  return {
    spec, mode: 'commits', baseSha: best.base, headSha: head, base: { ref: best.ref, how: best.how },
    alternatives: scored.slice(1, 4).map(({ ref, commits, how }) => ({ ref, commits, how })),
    commits: commitsOf(repo, best.base, head),
  };
}

export interface FileChange {
  status: 'A' | 'M' | 'D' | 'R';
  oldPath: string | null;
  newPath: string | null;
  /** Changed line ranges [from, to] on each side; pure insertions/deletions give an empty range on the other side. */
  oldRanges: Array<[number, number]>;
  newRanges: Array<[number, number]>;
  added: number;
  removed: number;
}

/** Unified diff with zero context → per-file changed line ranges on both sides. */
export function parseUnifiedDiff(text: string): FileChange[] {
  const files: FileChange[] = [];
  let cur: FileChange | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { status: 'M', oldPath: null, newPath: null, oldRanges: [], newRanges: [], added: 0, removed: 0 };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) cur.status = 'A';
    else if (line.startsWith('deleted file mode')) cur.status = 'D';
    else if (line.startsWith('rename from ')) {
      cur.status = 'R';
      cur.oldPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) cur.newPath = line.slice('rename to '.length);
    else if (line.startsWith('--- ')) cur.oldPath = line === '--- /dev/null' ? null : line.replace(/^--- (a\/)?/, '');
    else if (line.startsWith('+++ ')) cur.newPath = line === '+++ /dev/null' ? null : line.replace(/^\+\+\+ (b\/)?/, '');
    else if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const [os, oc, ns, nc] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
      if (oc > 0) cur.oldRanges.push([os, os + oc - 1]);
      if (nc > 0) cur.newRanges.push([ns, ns + nc - 1]);
      cur.removed += oc;
      cur.added += nc;
    }
  }
  return files.filter((f) => f.oldPath || f.newPath);
}

const wanted = (path: string | null, roots: string[]) => Boolean(path && roots.some((r) => path === r || path.startsWith(r.replace(/\/$/, '') + '/')));

/**
 * Changed files of a resolved change, split into files under the analysed roots and the rest (reported, not mapped).
 * The raw diff (for the context bundle) is limited to the analysed roots.
 */
export function diffChange(repo: string, ch: ResolvedChange, roots: string[]): { files: FileChange[]; outside: FileChange[]; patch: string } {
  const range = ch.mode === 'worktree' ? ['HEAD'] : [ch.baseSha, ch.headSha!];
  const args = ['diff', '--no-color', '--no-ext-diff', '-M', '-U0', ...range];
  const all = parseUnifiedDiff(git(repo, ...args));
  if (ch.mode === 'worktree') {
    // Untracked files are additions in full.
    const untracked = git(repo, 'ls-files', '-z', '--others', '--exclude-standard').split('\0').filter(Boolean);
    for (const p of untracked) all.push({ status: 'A', oldPath: null, newPath: p, oldRanges: [], newRanges: [[1, Number.MAX_SAFE_INTEGER]], added: 0, removed: 0 });
  }
  const inRoots = (f: FileChange) => wanted(f.newPath, roots) || wanted(f.oldPath, roots);
  const patch = git(repo, 'diff', '--no-color', '--no-ext-diff', '-M', '-U3', ...range, '--', ...roots);
  return { files: all.filter(inRoots), outside: all.filter((f) => !inRoots(f)), patch };
}
