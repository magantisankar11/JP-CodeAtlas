export type Resolution = 'CONFIRMED' | 'FRAMEWORK_DERIVED' | 'AMBIGUOUS' | 'UNRESOLVED';
export const RESOLUTIONS: Resolution[] = ['CONFIRMED', 'FRAMEWORK_DERIVED', 'AMBIGUOUS', 'UNRESOLVED'];

export interface SnapshotRef { id: number; repoId: string; commitSha: string }
export interface Envelope<T> { apiVersion: string; snapshot: SnapshotRef; data: T }

export interface NodeDto {
  id: string; kind: string; name: string; fqn: string | null; signature: string | null; package: string | null;
  filePath: string | null; lineStart: number | null; lineEnd: number | null; inScope: boolean; attrs: Record<string, any>;
}
export interface Evidence { filePath: string | null; line: number; endLine?: number; column?: number; rule: string; resolution?: Resolution }
export interface EdgeDto {
  id: string; kind: string; src: string; dst: string; resolution: Resolution; evidence: Evidence[]; attrs: Record<string, any>;
}
export interface GraphNode extends NodeDto { depth: number; hasMore: boolean; pathResolution: Resolution }
export interface CatalogEntry extends NodeDto { incoming: Record<string, number>; outgoing: Record<string, number> }
export type Preset = 'flow' | 'type-impact' | 'data' | 'all' | 'ui';
export interface ReachResult {
  root: string; entryPoints: Array<NodeDto & { depth: number; pathResolution: Resolution; viaEnclosingType: boolean }>;
  visited: number; truncated: boolean; depth: number;
}
export interface GraphResult {
  root: string; direction: 'forward' | 'reverse'; nodes: GraphNode[]; edges: EdgeDto[]; cycleEdges: string[]; truncated: boolean;
  limits: { depth: number; nodes: number };
}
export interface SearchHit { id: string; kind: string; name: string; filePath: string | null }
export interface Excerpt { filePath: string; commitSha: string; from: number; to: number; totalLines: number; lines: Array<{ n: number; text: string }> }
export interface SnapshotDto extends SnapshotRef {
  sourceMode: string | null; engine: string | null; finishedAt: string | null; stats: Record<string, any>; scope: Record<string, any>;
  repoPath: string | null;
  /** Current (published by npm run sync or npm run load) snapshot of its repository. */
  current?: boolean;
}

export interface GraphQuery {
  root: string; direction: 'forward' | 'reverse'; depth: number; minResolution: Resolution; includeAccessors: boolean;
  collapseDispatch: boolean; limit: number; preset: Preset;
}

async function get<T>(path: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  const res = await fetch(`/api/v1/${path}?${qs}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body as T;
}

async function post<T>(path: string, params: Record<string, string | number | undefined>, body: unknown): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  const res = await fetch(`/api/v1/${path}?${qs}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json as T;
}

export type Classification = 'CONFIRMED_DEPENDENCY' | 'POTENTIAL_IMPACT' | 'UNKNOWN';
export interface Finding { id: string; kind: string; name: string; fqn: string | null; file: string | null; line: number | null; depth: number; classification: Classification; basis: Resolution; viaEnclosingType?: boolean; note?: string }
export interface DefectCandidate { nodeId: string; kind: string; name: string; strength: 'EXACT' | 'STRONG' | 'TEXT' | 'WEAK'; reasons: string[]; file: string | null; line: number | null }
export interface ImpactReport {
  schema: string; snapshot: SnapshotRef & { sourceMode: string | null }; generatedAt: string; params: { upstreamDepth: number; downstreamDepth: number };
  targets: Finding[]; directlyAffected: Finding[];
  upstream: { entryPoints: Finding[]; callers: Finding[]; truncated: boolean; examined: number };
  downstream: { methods: Finding[]; externals: Finding[]; events: Finding[]; truncated: boolean };
  database: Array<{ table: string; inCatalog: boolean; reads: number; writes: number; writersOutsideImpact: number; entities: string[] }>;
  errorHandling: Array<{ exception: string; handled: string; handlers: Array<{ handler: string; status: string | null }> }>;
  risks: Array<{ id: string; category: string; title: string; detail: string; classification: Classification }>;
  unknowns: Array<{ kind: string; detail: string; file: string | null; line: number | null }>;
  tests: { note: string };
  ui?: { httpCalls: Finding[]; functions: Finding[]; components: Finding[]; routes: Finding[]; truncated: boolean; unlinkedCalls: number };
  regressionCandidates: Array<{ id: string; level: string; title: string; classification: Classification; rationale: string; suggestedLocation: string; hints: string[] }>;
  rootCauseCandidates: Array<{ nodeId: string; name: string; strength: string; reasons: string[]; file: string | null; line: number | null }>;
  gates: Array<{ id: string; title: string; status: string; note: string }>;
}
export interface ImpactRequest { targets: string[]; defectText?: string; title?: string }

// Freshness (GET /api/v1/freshness): four independent dimensions per repository.
export interface FreshnessReason { code: string; message: string }
export interface RepoFreshness {
  repoId: string; role: string | null; pathPrefix: string; repoPath: string | null; sourceMode: string | null;
  snapshotTimestamp: string | null; status: 'CURRENT' | 'STALE' | 'UNKNOWN';
  accuracy: { status: 'CURRENT' | 'STALE' | 'UNKNOWN'; indexedCommit: string; selected: { rev: string; commit: string | null; branch: string | null };
    indexedAheadOfSelected: number | null; indexedBehindSelected: number | null; reasons: FreshnessReason[] };
  branch: { status: 'UP_TO_DATE' | 'BEHIND' | 'AHEAD' | 'DIVERGED' | 'NO_UPSTREAM' | 'UNKNOWN'; upstream: string | null; upstreamCommit: string | null;
    ahead: number | null; behind: number | null; asOf: string | null; source: string | null; reasons: FreshnessReason[];
    default: { branch: string | null; commit: string | null; relation: 'SAME' | 'AHEAD' | 'BEHIND' | 'DIVERGED' | 'UNKNOWN'; ahead: number | null; behind: number | null } };
  remote: { status: 'VERIFIED' | 'RECENT' | 'UNKNOWN' | 'NOT_APPLICABLE'; name: string | null; url: string | null; source: string | null; asOf: string | null;
    maxAgeHours: number; reasons: FreshnessReason[]; lastVerified: { checkedAt: string } | null };
  worktree: { status: 'CLEAN' | 'MODIFIED' | 'UNKNOWN'; changedInScope: number; changedOutsideScope: number; sample: string[]; warning: string | null; reasons: FreshnessReason[] };
}
export interface Freshness { status: 'CURRENT' | 'STALE' | 'UNKNOWN'; checkedAt: string; remoteMode: 'cached' | 'live'; matchingSnapshotId: number | null; repos: RepoFreshness[] }

export const api = {
  snapshots: () => get<{ data: SnapshotDto[] }>('snapshots', {}),
  search: (snapshot: number | undefined, q: string) => get<Envelope<SearchHit[]>>('search', { snapshot, q, limit: 25 }),
  endpoints: (snapshot: number | undefined, method?: string) => get<Envelope<NodeDto[]>>('endpoints', { snapshot, method }),
  graph: (snapshot: number | undefined, q: GraphQuery) => get<Envelope<GraphResult>>('graph', { snapshot, ...q }),
  node: (snapshot: number | undefined, id: string) =>
    get<Envelope<{ node: NodeDto; outgoing: EdgeDto[]; incoming: EdgeDto[] }>>('node', { snapshot, id }),
  source: (snapshot: number | undefined, file: string, from: number, to: number) =>
    get<Envelope<Excerpt>>('source', { snapshot, file, from, to, context: 4 }),
  reach: (snapshot: number | undefined, q: Pick<GraphQuery, 'root' | 'depth' | 'preset' | 'minResolution' | 'includeAccessors'>) =>
    get<Envelope<ReachResult>>('reach', { snapshot, ...q }),
  defectMatch: (snapshot: number | undefined, text: string) =>
    post<Envelope<{ signals: Record<string, unknown>; candidates: DefectCandidate[] }>>('defect/match', { snapshot }, { text }),
  impact: (snapshot: number | undefined, req: ImpactRequest) => post<Envelope<ImpactReport>>('impact', { snapshot }, req),
  exportContext: (snapshot: number | undefined, req: ImpactRequest) => post<Envelope<{ files: Record<string, string> }>>('export/context', { snapshot }, req),
  catalog: (snapshot: number | undefined, params: { kind?: string; entryPoints?: boolean; q?: string }) =>
    get<Envelope<CatalogEntry[]>>('catalog', { snapshot, limit: 2000, ...params }),
  /** Cached mode never contacts the remote; live (explicit user action only) runs one ls-remote per repository. */
  freshness: (snapshot: number | undefined, o: { revs?: Record<string, string>; remote?: 'cached' | 'live'; refresh?: boolean } = {}) =>
    get<Envelope<Freshness>>('freshness', {
      snapshot, remote: o.remote, refresh: o.refresh || undefined,
      ...Object.fromEntries(Object.entries(o.revs ?? {}).filter(([, v]) => v.trim()).map(([k, v]) => [`rev.${k}`, v.trim()])),
    }),
};

/** Sensible default traversal for a root of the given kind. */
export function defaultsFor(kind: string): { direction: 'forward' | 'reverse'; preset: Preset } {
  if (['DTO', 'ENTITY', 'CLASS', 'RECORD', 'ENUM', 'INTERFACE'].includes(kind)) return { direction: 'reverse', preset: 'type-impact' };
  if (['DATABASE_TABLE', 'DATABASE_PROCEDURE'].includes(kind)) return { direction: 'reverse', preset: 'data' };
  if (['CONFIG_PROPERTY', 'EXTERNAL_API', 'EVENT'].includes(kind)) return { direction: 'reverse', preset: 'all' };
  if (['UI_ROUTE', 'UI_COMPONENT', 'UI_FUNCTION', 'UI_STORE', 'UI_MODULE'].includes(kind)) return { direction: 'forward', preset: 'ui' };
  return { direction: 'forward', preset: 'flow' };
}

export interface RepoRef { repoId: string; repoPath: string | null; commitSha: string; pathPrefix: string }

/** System snapshots prefix files of non-primary repositories with "@<repoId>/" (scope.repos); map back to that repository. */
export function locateFile(snapshot: { repoPath: string | null; commitSha: string; scope?: Record<string, any> } | undefined, file: string) {
  const repos = (snapshot?.scope?.repos ?? []) as RepoRef[];
  const repo = repos.find((r) => r.pathPrefix && file.startsWith(r.pathPrefix));
  return repo
    ? { repoId: repo.repoId, repoPath: repo.repoPath, commitSha: repo.commitSha, path: file.slice(repo.pathPrefix.length) }
    : { repoId: null, repoPath: snapshot?.repoPath ?? null, commitSha: snapshot?.commitSha ?? '', path: file };
}
