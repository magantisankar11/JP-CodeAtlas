import { createHash } from 'node:crypto';

/** graph-v1 records (schemas/graph-v1.schema.json, 1.2.0 adds the UI kinds). */
export type Resolution = 'CONFIRMED' | 'FRAMEWORK_DERIVED' | 'AMBIGUOUS' | 'UNRESOLVED';
export const RANK: Record<Resolution, number> = { CONFIRMED: 0, FRAMEWORK_DERIVED: 1, AMBIGUOUS: 2, UNRESOLVED: 3 };

export interface Evidence { filePath: string; line: number; endLine: number; column: number; rule: string; resolution: Resolution }
export interface NodeRec {
  type: 'node'; id: string; kind: string; name: string; fqn?: string; signature?: string; module?: string; package?: string;
  filePath?: string; lineStart?: number; lineEnd?: number; inScope: boolean; attrs: Record<string, unknown>;
}
export interface EdgeRec { type: 'edge'; id: string; kind: string; src: string; dst: string; resolution: Resolution; evidence: Evidence[]; attrs: Record<string, unknown> }

const ALL_SITES = new Set(['conditional', 'inCallback']);

export class Graph {
  readonly nodes = new Map<string, NodeRec>();
  readonly edges = new Map<string, EdgeRec>();
  readonly diagnostics: Array<{ type: 'diagnostic'; severity: string; code: string; message: string; filePath?: string; line?: number }> = [];

  node(n: Omit<NodeRec, 'type' | 'inScope' | 'attrs'> & { attrs?: Record<string, unknown>; inScope?: boolean }): NodeRec {
    const existing = this.nodes.get(n.id);
    if (existing) return existing;
    const rec: NodeRec = { type: 'node', inScope: true, attrs: {}, ...n } as NodeRec;
    this.nodes.set(n.id, rec);
    return rec;
  }

  edge(kind: string, src: string, dst: string, resolution: Resolution, ev: Evidence, attrs: Record<string, unknown> = {}) {
    const id = 'e:' + createHash('sha1').update(`${kind}|${src}|${dst}`).digest('hex').slice(0, 20);
    const e = this.edges.get(id);
    if (!e) {
      this.edges.set(id, { type: 'edge', id, kind, src, dst, resolution, evidence: [ev], attrs: { ...attrs, siteCount: 1 } });
      return;
    }
    if (RANK[resolution] < RANK[e.resolution]) e.resolution = resolution;
    e.attrs.siteCount = Number(e.attrs.siteCount ?? 1) + 1;
    if (e.evidence.length < 25) e.evidence.push(ev);
    for (const k of ALL_SITES) if (k in e.attrs || k in attrs) e.attrs[k] = Boolean(e.attrs[k]) && Boolean(attrs[k]);
  }

  diag(severity: string, code: string, message: string, filePath?: string, line?: number) {
    this.diagnostics.push({ type: 'diagnostic', severity, code, message, filePath, line });
  }
}
