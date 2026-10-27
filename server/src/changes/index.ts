import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

/**
 * Graphs per repository and commit. An existing NDJSON anywhere under the graph directories is reused when its snapshot
 * record names the same repository and commit, was read from the commit (sourceMode HEAD) and covers the whole
 * repository (no --include). Otherwise the analyzer runs read-only (`--commit`, or `--mode WORKTREE` / `--worktree`)
 * into the cache directory. Working-tree graphs are never reused.
 */
export interface GraphRef { file: string; repoId: string; commitSha: string; sourceMode: string; reused: boolean }
export type RepoKind = 'java' | 'ui';

export function readSnapshotLine(file: string): any | null {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    const first = JSON.parse(nl < 0 ? text : text.slice(0, nl));
    return first?.type === 'snapshot' ? first : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function* ndjsonFiles(dir: string, depth = 0): Generator<string> {
  if (!existsSync(dir) || depth > 3) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!name.startsWith('.')) yield* ndjsonFiles(p, depth + 1);
    } else if (name.endsWith('.ndjson')) yield p;
  }
}

/** True when the file ends with a newline-terminated, parseable JSON line (an interrupted write leaves a partial one). */
export function lastLineComplete(file: string): boolean {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const len = Math.min(size, 1 << 20);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    if (!text.endsWith('\n')) return false;
    const body = text.replace(/\r?\n$/, '');
    const nl = body.lastIndexOf('\n');
    if (nl < 0 && len < size) return false;
    JSON.parse(body.slice(nl + 1));
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * First reusable graph for repo + commit. `accept` adds caller checks on the snapshot record (e.g. analyzer version);
 * `requireComplete` skips files whose last line is cut off.
 */
export function findGraph(dirs: string[], repoId: string, commitSha: string,
  opts: { accept?: (snapshot: any) => boolean; requireComplete?: boolean } = {}): string | null {
  for (const d of dirs) {
    for (const f of ndjsonFiles(d)) {
      const s = readSnapshotLine(f);
      // Working-tree graphs are only reusable for folders without git, whose commitSha is a content hash.
      if (!s || s.repoId !== repoId || s.commitSha !== commitSha || (s.sourceMode === 'WORKTREE' && !commitSha.startsWith('nogit-'))) continue;
      const inc = s.scope?.includePackages;
      if (Array.isArray(inc) && inc.length) continue;
      if (opts.accept && !opts.accept(s)) continue;
      if (opts.requireComplete && !lastLineComplete(f)) continue;
      return f;
    }
  }
  return null;
}

/** JCI_JAVA, then JAVA_HOME, then the newest JDK under ~/.jdks, then java on PATH. */
export function javaExecutable(): string {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  if (process.env.JCI_JAVA) return process.env.JCI_JAVA;
  const fromHome = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', exe) : null;
  if (fromHome && existsSync(fromHome) && spawnSync(fromHome, ['-version']).status === 0) return fromHome;
  const jdks = join(homedir(), '.jdks');
  if (existsSync(jdks)) {
    const found = readdirSync(jdks).map((d) => join(jdks, d, 'bin', exe)).filter((p) => existsSync(p)).sort().reverse();
    if (found[0]) return found[0];
  }
  return 'java';
}

export interface IndexOptions {
  jciRoot: string;
  graphDirs: string[];
  cacheDir: string;
  log: (msg: string) => void;
  /** Extra reuse checks (sync): see findGraph. `reuse: false` always re-indexes. */
  accept?: (snapshot: any) => boolean;
  requireComplete?: boolean;
  reuse?: boolean;
}

/** Graph of `repoPath` at `commitSha` ('WORKTREE' for uncommitted changes), reusing a cached one when possible. */
export function ensureGraph(kind: RepoKind, repoPath: string, repoId: string, commitSha: string, opts: IndexOptions): GraphRef {
  const nogit = commitSha.startsWith('nogit-');
  const worktree = commitSha === 'WORKTREE' || nogit;
  if (commitSha !== 'WORKTREE' && opts.reuse !== false) {
    const hit = findGraph([...opts.graphDirs, opts.cacheDir], repoId, commitSha, { accept: opts.accept, requireComplete: opts.requireComplete });
    if (hit) {
      opts.log(`  ${repoId}@${commitSha.slice(0, 10)}: reusing ${hit}`);
      return { file: hit, repoId, commitSha, sourceMode: 'HEAD', reused: true };
    }
  }
  mkdirSync(opts.cacheDir, { recursive: true });
  const out = join(opts.cacheDir, `${repoId}-${worktree ? 'worktree' : commitSha.slice(0, 12)}.ndjson`);
  const tmpDir = join(opts.cacheDir, '.partial');
  mkdirSync(tmpDir, { recursive: true });
  const tmp = join(tmpDir, basename(out));
  const t0 = Date.now();
  opts.log(`  ${repoId}@${worktree ? 'working tree' : commitSha.slice(0, 10)}: indexing (${kind === 'java' ? 'about 3 minutes' : 'a few seconds'})…`);
  let r;
  if (kind === 'java') {
    const jar = join(opts.jciRoot, 'analyzer-java', 'target', 'jci-analyzer.jar');
    if (!existsSync(jar)) throw new Error(`${jar} not found; build it with npm run build:analyzer`);
    const heap = process.env.JCI_JAVA_OPTS?.split(' ').filter(Boolean) ?? ['-Xmx8g'];
    r = spawnSync(javaExecutable(), [...heap, '-jar', jar, 'analyze', '--repo', repoPath, '--repo-id', repoId, '--out', tmp,
      '--workspace', join(opts.jciRoot, 'workspace'), ...(worktree ? ['--mode', 'WORKTREE'] : ['--commit', commitSha])],
    { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 << 20 });
  } else {
    const dir = join(opts.jciRoot, 'analyzer-ui');
    r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--repo', repoPath, '--repo-id', repoId, '--out', tmp,
      ...(nogit ? [] : worktree ? ['--worktree'] : ['--commit', commitSha])], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 << 20 });
  }
  if (r.status !== 0) {
    const err = r.stderr?.toString().trim().split('\n').slice(-8).join('\n') ?? r.error?.message;
    throw new Error(`indexing ${repoId}@${commitSha} failed (exit ${r.status}):\n${err}`);
  }
  renameSync(tmp, out);
  const s = readSnapshotLine(out);
  if (nogit && s?.commitSha !== commitSha) throw new Error(`${repoPath} (not a git repository) changed since snapshot ${commitSha}; reload the current snapshot`);
  opts.log(`  ${repoId}: indexed in ${Math.round((Date.now() - t0) / 1000)} s`);
  return { file: resolve(out), repoId, commitSha: s?.commitSha ?? commitSha, sourceMode: s?.sourceMode ?? (worktree ? 'WORKTREE' : 'HEAD'), reused: false };
}
