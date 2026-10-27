import type { Resolution } from '../contract.js';

/** Report contract version; fields are only ever added within 1.x. */
export const IMPACT_SCHEMA = 'jci-impact/1.0';
export const CONTEXT_SCHEMA = 'jci-context/1.0';

/**
 * CONFIRMED_DEPENDENCY  every link on the best path is a compiler fact or a documented deterministic framework rule
 * POTENTIAL_IMPACT      the path needs an ambiguous dispatch, or only passes through a field of an enclosing type
 * UNKNOWN               the path depends on an unresolved link (reflection, runtime SQL/URL, ...)
 */
export type Classification = 'CONFIRMED_DEPENDENCY' | 'POTENTIAL_IMPACT' | 'UNKNOWN';

export function classify(path: Resolution, viaEnclosingType = false): Classification {
  if (path === 'UNRESOLVED') return 'UNKNOWN';
  if (path === 'AMBIGUOUS' || viaEnclosingType) return 'POTENTIAL_IMPACT';
  return 'CONFIRMED_DEPENDENCY';
}

export interface Loc {
  file: string | null;
  line: number | null;
}

export interface Finding extends Loc {
  id: string;
  kind: string;
  name: string;
  fqn: string | null;
  depth: number;
  classification: Classification;
  /** Weakest evidence level on the best path from the target. */
  basis: Resolution;
  viaEnclosingType?: boolean;
  note?: string;
}

export interface EvidenceRef extends Loc {
  nodeId?: string;
  edgeId?: string;
  rule?: string;
}

export interface Risk {
  id: string;
  category: 'API_CONTRACT' | 'DATABASE' | 'CONFIGURATION' | 'INTEGRATION' | 'IMPLEMENTATIONS' | 'BACKGROUND_JOBS' | 'SECURITY' | 'ERROR_HANDLING' | 'SHARED_CODE' | 'UI' | 'CHANGE';
  title: string;
  detail: string;
  classification: Classification;
  evidence: EvidenceRef[];
}

export interface Unknown extends Loc {
  kind: string;
  detail: string;
  nodeId?: string;
  edgeId?: string;
}

export interface TableUse {
  table: string;
  inCatalog: boolean;
  reads: number;
  writes: number;
  statements: Array<Loc & { id: string; operation: string; resolution: Resolution; conditionalTable?: boolean }>;
  entities: string[];
  writersOutsideImpact: number;
}

export interface ErrorPath {
  exception: string;
  thrownAt: Array<Loc & { method: string; declared: boolean }>;
  handlers: Array<{ handler: string; status: string | null; scope: string; basis: 'EXACT' | 'SUPERTYPE' | 'ASSUMED_JDK_HIERARCHY' }>;
  /** Spring MVC handler coverage for exceptions escaping HTTP entry points. */
  handled: 'YES' | 'PROBABLY' | 'NO' | 'NOT_HTTP';
}

export interface RegressionCandidate {
  id: string;
  level: 'UNIT' | 'API' | 'JOB' | 'DATA' | 'ERROR_PATH' | 'CONTRACT' | 'UI_COMPONENT' | 'UI_E2E';
  title: string;
  target: string;
  classification: Classification;
  rationale: string;
  evidence: EvidenceRef[];
  suggestedLocation: string;
  hints: string[];
}

export interface RootCauseCandidate extends Loc {
  nodeId: string;
  name: string;
  strength: MatchStrength;
  reasons: string[];
}

export type MatchStrength = 'EXACT' | 'STRONG' | 'TEXT' | 'WEAK';

export interface DefectCandidate extends Loc {
  nodeId: string;
  kind: string;
  name: string;
  strength: MatchStrength;
  reasons: string[];
}

export interface GateResult {
  id: string;
  title: string;
  requirement: string;
  status: 'EVIDENCE_PRESENT' | 'MISSING' | 'NEEDS_HUMAN';
  note: string;
}

export interface ImpactReport {
  schema: typeof IMPACT_SCHEMA;
  snapshot: {
    id: number; repoId: string; commitSha: string; sourceMode: string | null; analyzerVersion: string | null;
    /** Multi-repo (system) snapshots: every repository and the commit it was analysed at. */
    repos?: Array<{ repoId: string; commitSha: string; role?: string }>;
  };
  generatedAt: string;
  params: { upstreamDepth: number; downstreamDepth: number };
  targets: Finding[];
  directlyAffected: Finding[];
  upstream: { entryPoints: Finding[]; callers: Finding[]; truncated: boolean; examined: number };
  downstream: { methods: Finding[]; externals: Finding[]; events: Finding[]; truncated: boolean };
  sharedUtilities: Array<Finding & { callers: number; callerTypes: number }>;
  dataContracts: Array<{ endpoint: string; accepts: string[]; returns: string[]; classification: Classification; viaEnclosingType: boolean }>;
  database: TableUse[];
  errorHandling: ErrorPath[];
  security: Array<{ endpoint: string; rule: string; args: string[]; matcher: string | null; caution: string | null }>;
  configuration: Array<{ key: string; defined: boolean; readers: number }>;
  risks: Risk[];
  unknowns: Unknown[];
  tests: { existing: Finding[]; note: string };
  regressionCandidates: RegressionCandidate[];
  /** Frontend consumers of the affected endpoints (system snapshots only; absent when no UI repository is indexed). */
  ui?: UiImpact;
  /** Change-based analysis (impact --changes): what changed between base and head, per repository. */
  change?: ChangeSummary;
  /** Source freshness of the snapshot when the report was made (HEAD selected, cached remote information). */
  freshness?: FreshnessSummary;
  rootCauseCandidates: RootCauseCandidate[];
  gates: GateResult[];
}

export interface FreshnessSummary {
  checkedAt: string;
  /** Worst snapshot accuracy across repositories. */
  status: 'CURRENT' | 'STALE' | 'UNKNOWN';
  repos: Array<{
    repoId: string; indexedCommit: string; selectedCommit: string | null; selectedBranch: string | null;
    accuracy: string; branch: string; branchAhead: number | null; branchBehind: number | null; upstream: string | null;
    remote: string; remoteAsOf: string | null; worktree: string; changedInScope: number; reasons: string[];
  }>;
}

export interface UiImpact {
  /** UI_HTTP_CALL sites linked (CALLS_API) to affected endpoints; note names the endpoint. */
  httpCalls: Finding[];
  functions: Finding[];
  components: Finding[];
  routes: Finding[];
  truncated: boolean;
  /** UI HTTP calls in the snapshot whose URL could not be linked to any endpoint (they may also reach affected code). */
  unlinkedCalls: number;
}

export interface ChangeSummary {
  /** Graph the impact was computed on: base (dependents of modified/removed code) or head (only additions). */
  analysedOn: 'base' | 'head';
  repos: Array<{
    repoId: string; role?: string; spec: string | null; mode: 'commits' | 'worktree' | 'unchanged';
    baseSha: string; headSha: string | null; base: { ref: string; how: string };
    alternatives: Array<{ ref: string; commits: number; how: string }>;
    commits: Array<{ sha: string; subject: string }>;
    files: Array<{ path: string; status: string; added: number; removed: number; mappedNodes: number }>;
    outsideRoots: string[];
  }>;
  nodes: Array<{ id: string; kind: string; name: string; file: string | null; line: number | null; change: string; repoId: string; pairedWith?: string }>;
  endpoints: Array<{ id: string; name: string; change: string; to?: string; fields?: string[]; file: string | null; line: number | null }>;
  types: Array<{ id: string; name: string; kind: string; added: string[]; removed: string[]; retyped: string[]; file: string | null; line: number | null }>;
  tables: Array<{ id: string; name: string; kind: string; added: string[]; removed: string[]; retyped: string[]; file: string | null; line: number | null }>;
  calls: Array<{ method: string; name: string; added: string[]; removed: string[] }>;
  uiLinks: Array<{ call: string; name: string; file: string | null; line: number | null; change: string; before: string[]; after: string[]; urlBefore?: string }>;
  unmappedHunks: Array<{ repoId: string; file: string; side: 'old' | 'new'; from: number; to: number }>;
}
