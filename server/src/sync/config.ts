import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { DB } from '../db.js';
import { tryGit } from '../changes/git.js';
import { listSnapshots } from '../query.js';

/**
 * Repositories `npm run sync` keeps current: `config/repos.yaml` when present, else the repositories recorded in the
 * current system snapshot (`scope.repos`). Either one Java backend and one UI frontend (combined into a system
 * snapshot), or a single repository published under its own id.
 */
export class SyncConfigError extends Error {}

export type RepoKind = 'java' | 'ui';
export interface SyncRepo { id: string; kind: RepoKind; path: string; role: 'backend' | 'frontend' }
export interface SyncConfig {
  source: 'config' | 'snapshot';
  file: string | null;
  /** Published id: the system id for Core + UI, else the single repository's id. */
  publishId: string;
  system: { id: string; coreBases: string[] } | null;
  repos: SyncRepo[];
}

const ID = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);
const fileSchema = z.object({
  system: z.object({ id: ID, coreBases: z.array(z.string().min(1)).min(1).optional() }).optional(),
  repos: z.array(z.object({ id: ID, kind: z.enum(['java', 'ui']), path: z.string().min(1) })).min(1).max(2),
});

export const DEFAULT_CORE_BASES = ['process.env.JP_API'];

function finish(source: SyncConfig['source'], file: string | null, systemId: string | null, coreBases: string[], repos: SyncRepo[]): SyncConfig {
  if (new Set(repos.map((r) => r.id)).size !== repos.length) throw new SyncConfigError('repository ids must be unique');
  if (repos.length === 2) {
    if (!repos.some((r) => r.kind === 'java') || !repos.some((r) => r.kind === 'ui')) {
      throw new SyncConfigError('two repositories must be one java (backend) and one ui (frontend) repository');
    }
    if (!systemId) throw new SyncConfigError('two repositories need system.id (the id of the combined snapshot)');
  }
  for (const r of repos) {
    if (!existsSync(r.path)) throw new SyncConfigError(`${r.id}: path ${r.path} does not exist`);
    if (tryGit(r.path, 'rev-parse', '--is-inside-work-tree') !== 'true') throw new SyncConfigError(`${r.id}: ${r.path} is not a git work tree`);
  }
  // Java first: the combine step takes the Core graph as primary.
  const ordered = [...repos].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'java' ? -1 : 1));
  return {
    source, file, publishId: repos.length === 2 ? systemId! : ordered[0]!.id,
    system: repos.length === 2 ? { id: systemId!, coreBases } : null, repos: ordered,
  };
}

export function loadConfigFile(file: string): SyncConfig {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new SyncConfigError(`${file}: ${(e as Error).message}`);
  }
  const p = fileSchema.safeParse(raw);
  if (!p.success) throw new SyncConfigError(`${file}: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const repos = p.data.repos.map((r) => ({ id: r.id, kind: r.kind, path: r.path, role: r.kind === 'java' ? 'backend' as const : 'frontend' as const }));
  return finish('config', file, p.data.system?.id ?? null, p.data.system?.coreBases ?? DEFAULT_CORE_BASES, repos);
}

/** From the current snapshot that spans several repositories (newest first). */
export function detectFromSnapshots(db: DB): SyncConfig | null {
  const sys = listSnapshots(db).find((s) => s.current && Array.isArray(s.scope.repos) && (s.scope.repos as unknown[]).length > 1);
  if (!sys) return null;
  const repos = (sys.scope.repos as Array<{ repoId: string; repoPath?: string; role?: string }>).map((r) => {
    if (!r.repoPath) throw new SyncConfigError(`snapshot ${sys.id}: repository ${r.repoId} has no path; create config/repos.yaml`);
    const kind: RepoKind = r.role === 'frontend' ? 'ui' : 'java';
    return { id: r.repoId, kind, path: r.repoPath, role: kind === 'java' ? 'backend' as const : 'frontend' as const };
  });
  return finish('snapshot', null, sys.repoId, DEFAULT_CORE_BASES, repos);
}

export function detectRepos(db: DB, configFile: string): SyncConfig {
  if (existsSync(configFile)) return loadConfigFile(configFile);
  const found = detectFromSnapshots(db);
  if (found) return found;
  throw new SyncConfigError(`no ${configFile} and no current multi-repository snapshot to detect repositories from; `
    + 'copy config/repos.example.yaml to config/repos.yaml and set the paths');
}
