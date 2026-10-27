import { z } from 'zod';

/** Mirrors schemas/graph-v1.schema.json. Within major version 1 fields are only ever added. */
export const SUPPORTED_SCHEMA_MAJOR = 1;
export const API_VERSION = '1.0.0';

export const RESOLUTIONS = ['CONFIRMED', 'FRAMEWORK_DERIVED', 'AMBIGUOUS', 'UNRESOLVED'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const resolutionRank = (r: string): number => {
  const i = (RESOLUTIONS as readonly string[]).indexOf(r);
  return i < 0 ? RESOLUTIONS.length : i;
};

const evidence = z.looseObject({
  filePath: z.string().nullable().optional(),
  line: z.number().int(),
  endLine: z.number().int().optional(),
  column: z.number().int().optional(),
  rule: z.string(),
  resolution: z.enum(RESOLUTIONS).optional(),
});

export const snapshotRecord = z.looseObject({
  type: z.literal('snapshot'),
  schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  repoId: z.string().min(1),
  repoPath: z.string().optional(),
  commitSha: z.string().min(1),
  sourceMode: z.enum(['HEAD', 'WORKTREE']).optional(),
  analyzerVersion: z.string(),
  engine: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  scope: z.looseObject({}),
  stats: z.looseObject({}),
});

export const nodeRecord = z.looseObject({
  type: z.literal('node'),
  id: z.string().min(1),
  kind: z.string().min(1),
  name: z.string(),
  fqn: z.string().optional(),
  signature: z.string().optional(),
  module: z.string().optional(),
  package: z.string().optional(),
  filePath: z.string().optional(),
  lineStart: z.number().int().optional(),
  lineEnd: z.number().int().optional(),
  inScope: z.boolean().optional(),
  attrs: z.looseObject({}).optional(),
});

export const edgeRecord = z.looseObject({
  type: z.literal('edge'),
  id: z.string().min(1),
  kind: z.string().min(1),
  src: z.string().min(1),
  dst: z.string().min(1),
  resolution: z.enum(RESOLUTIONS),
  evidence: z.array(evidence).min(1),
  attrs: z.looseObject({}).optional(),
});

export const diagnosticRecord = z.looseObject({
  type: z.literal('diagnostic'),
  severity: z.enum(['INFO', 'WARN', 'ERROR']),
  code: z.string(),
  message: z.string(),
  filePath: z.string().optional(),
  line: z.number().int().optional(),
});

export type SnapshotRecord = z.infer<typeof snapshotRecord>;
export type NodeRecord = z.infer<typeof nodeRecord>;
export type EdgeRecord = z.infer<typeof edgeRecord>;
export type DiagnosticRecord = z.infer<typeof diagnosticRecord>;

export interface NodeDto {
  id: string;
  kind: string;
  name: string;
  fqn: string | null;
  signature: string | null;
  package: string | null;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  inScope: boolean;
  attrs: Record<string, unknown>;
}

export interface EdgeDto {
  id: string;
  kind: string;
  src: string;
  dst: string;
  resolution: Resolution;
  evidence: Array<{ filePath: string | null; line: number; endLine?: number; column?: number; rule: string; resolution?: Resolution }>;
  attrs: Record<string, unknown>;
}

export interface SnapshotDto {
  id: number;
  repoId: string;
  commitSha: string;
  sourceMode: string | null;
  analyzerVersion: string | null;
  engine: string | null;
  finishedAt: string | null;
  loadedAt: string;
  scope: Record<string, unknown>;
  stats: Record<string, unknown>;
  /** Snapshot list only: current (published) snapshot of its repository. */
  current?: boolean;
}
