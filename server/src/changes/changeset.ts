import type { DB } from '../db.js';
import { toEdge, toNode, type EdgeRow, type NodeRow } from '../query.js';
import type { NodeDto } from '../contract.js';
import type { FileChange } from './git.js';

/**
 * Changed lines → graph nodes, on both sides of a change, plus contract differences between the base and head graphs.
 *
 * Line mapping: a hunk maps to the most specific declarations it overlaps (methods, UI functions, routes, tables,
 * procedures, config keys, test cases; a node is dropped when a smaller overlapping one lies inside it). Only when no
 * declaration overlaps does it fall back to the innermost enclosing type (Java field / annotation edits) or, for UI
 * files, the component / module (template and top-level script edits). Java lines outside every declaration (imports,
 * comments) stay unmapped and are reported.
 *
 * Old-side ranges are looked up in the base graph and new-side ranges in the head graph; a node found in both graphs
 * is MODIFIED, only in head ADDED, only in base REMOVED. A removed and an added method with the same declaring type and
 * name are reported as SIGNATURE_CHANGED.
 */
export type ChangeKind = 'MODIFIED' | 'ADDED' | 'REMOVED' | 'SIGNATURE_CHANGED';
export interface ChangedNode {
  id: string; kind: string; name: string; fqn: string | null; file: string | null; line: number | null;
  change: ChangeKind; repoId: string; pairedWith?: string;
}
export interface UnmappedHunk { repoId: string; file: string; side: 'old' | 'new'; from: number; to: number }

const SPECIFIC = new Set(['METHOD', 'UI_FUNCTION', 'UI_ROUTE', 'DATABASE_TABLE', 'DATABASE_PROCEDURE', 'CONFIG_PROPERTY', 'TEST_CASE']);
const JAVA_CONTAINERS = new Set(['CLASS', 'INTERFACE', 'ENUM', 'RECORD', 'ANNOTATION', 'DTO', 'ENTITY', 'SERVICE', 'REPOSITORY', 'CONTROLLER', 'COMPONENT', 'CONFIGURATION']);
const UI_FILES = new Set(['UI_COMPONENT', 'UI_MODULE', 'UI_STORE', 'TEST_CASE']);
const isPseudo = (n: NodeDto) => n.kind === 'UI_FUNCTION' && String(n.signature ?? n.fqn ?? '').includes('<');
const span = (n: NodeDto) => (n.lineEnd ?? n.lineStart ?? 0) - (n.lineStart ?? 0);
const inside = (a: NodeDto, b: NodeDto) => a !== b && (a.lineStart ?? 0) >= (b.lineStart ?? 0) && (a.lineEnd ?? a.lineStart ?? 0) <= (b.lineEnd ?? b.lineStart ?? 0) && span(a) < span(b);

function overlapping(db: DB, sid: number, file: string, from: number, to: number): NodeDto[] {
  return (db.prepare(`SELECT * FROM nodes WHERE snapshot_id = ? AND file_path = ? AND line_start IS NOT NULL
      AND line_start <= ? AND COALESCE(line_end, line_start) >= ?`).all(sid, file, to, from) as NodeRow[]).map(toNode);
}

function fileNodes(db: DB, sid: number, file: string): NodeDto[] {
  return (db.prepare(`SELECT * FROM nodes WHERE snapshot_id = ? AND file_path = ?`).all(sid, file) as NodeRow[]).map(toNode);
}

/** The nodes a changed line range stands for; empty when it is outside every declaration. */
export function mapRange(db: DB, sid: number, file: string, from: number, to: number, isUi: boolean): NodeDto[] {
  const hits = overlapping(db, sid, file, from, to);
  const specific = hits.filter((n) => SPECIFIC.has(n.kind) && !isPseudo(n));
  const innermost = (list: NodeDto[]) => list.filter((n) => !list.some((m) => inside(m, n)));
  if (specific.length) return innermost(specific);
  const containers = hits.filter((n) => JAVA_CONTAINERS.has(n.kind));
  if (containers.length) return innermost(containers);
  if (isUi) return fileNodes(db, sid, file).filter((n) => UI_FILES.has(n.kind)).slice(0, 1);
  return [];
}

const exists = (db: DB, sid: number, ids: string[]): Map<string, NodeDto> => {
  const out = new Map<string, NodeDto>();
  for (let i = 0; i < ids.length; i += 400) {
    const b = ids.slice(i, i + 400);
    for (const r of db.prepare(`SELECT * FROM nodes WHERE snapshot_id = ? AND id IN (${b.map(() => '?').join(',')})`).all(sid, ...b) as NodeRow[]) out.set(r.id, toNode(r));
  }
  return out;
};

export interface RepoSide { repoId: string; pathPrefix: string; isUi: boolean; files: FileChange[] }

export function mapChanges(db: DB, baseSid: number, headSid: number, repos: RepoSide[]):
  { nodes: ChangedNode[]; unmapped: UnmappedHunk[]; mappedPerFile: Map<string, number> } {
  const baseHits = new Map<string, string>(); // id -> repoId
  const headHits = new Map<string, string>();
  const unmapped: UnmappedHunk[] = [];
  const mappedPerFile = new Map<string, number>();
  for (const r of repos) {
    for (const f of r.files) {
      const key = r.pathPrefix + (f.newPath ?? f.oldPath);
      let mapped = 0;
      const side = (sid: number, path: string | null, ranges: Array<[number, number]>, sink: Map<string, string>, s: 'old' | 'new') => {
        if (!path) return;
        const file = r.pathPrefix + path;
        for (const [a, b] of ranges) {
          const hit = mapRange(db, sid, file, a, b, r.isUi);
          if (!hit.length) unmapped.push({ repoId: r.repoId, file, side: s, from: a, to: Math.min(b, a + 100000) });
          for (const n of hit) sink.set(n.id, r.repoId);
          mapped += hit.length;
        }
      };
      side(baseSid, f.oldPath, f.oldRanges, baseHits, 'old');
      side(headSid, f.newPath, f.newRanges, headHits, 'new');
      mappedPerFile.set(key, mapped);
    }
  }
  const ids = [...new Set([...baseHits.keys(), ...headHits.keys()])];
  const inBase = exists(db, baseSid, ids);
  const inHead = exists(db, headSid, ids);
  const nodes: ChangedNode[] = ids.map((id) => {
    const n = inHead.get(id) ?? inBase.get(id)!;
    const change: ChangeKind = inBase.has(id) && inHead.has(id) ? 'MODIFIED' : inHead.has(id) ? 'ADDED' : 'REMOVED';
    return { id, kind: n.kind, name: label(n), fqn: n.fqn, file: n.filePath, line: n.lineStart, change, repoId: baseHits.get(id) ?? headHits.get(id)! };
  });
  // A method whose parameter list changed has a new id: pair removed/added methods of the same type and name.
  const removed = nodes.filter((n) => n.change === 'REMOVED' && n.kind === 'METHOD');
  for (const a of nodes.filter((n) => n.change === 'ADDED' && n.kind === 'METHOD')) {
    const r = removed.find((x) => x.fqn === a.fqn && !x.pairedWith);
    if (r) {
      r.change = 'SIGNATURE_CHANGED';
      a.change = 'SIGNATURE_CHANGED';
      r.pairedWith = a.id;
      a.pairedWith = r.id;
    }
  }
  return { nodes, unmapped, mappedPerFile };
}

export const label = (n: NodeDto) => (n.kind === 'METHOD' && n.fqn ? `${n.fqn.split('#')[0]!.split('.').pop()}.${n.name}()` : n.name);

// ---------------------------------------------------------------- contract differences

export interface EndpointChange { id: string; name: string; change: 'ADDED' | 'REMOVED' | 'MOVED' | 'CONTRACT_CHANGED'; to?: string; fields?: string[]; file: string | null; line: number | null }
export interface FieldChange { id: string; name: string; kind: string; added: string[]; removed: string[]; retyped: string[]; file: string | null; line: number | null }
export interface CallChange { method: string; name: string; added: string[]; removed: string[] }
export interface UiLinkChange {
  call: string; name: string; file: string | null; line: number | null;
  change: 'LINK_LOST' | 'RELINKED' | 'NEW_UNLINKED' | 'NEW_LINKED';
  before: string[]; after: string[];
  /** Set when the call's URL text was edited (paired by function and HTTP method). */
  urlBefore?: string;
}

const kindNodes = (db: DB, sid: number, kind: string) => new Map((db.prepare(`SELECT * FROM nodes WHERE snapshot_id = ? AND kind = ?`).all(sid, kind) as NodeRow[]).map((r) => [r.id, toNode(r)] as const));
const CONTRACT_KEYS = ['httpMethod', 'path', 'params', 'requestBody', 'responseType', 'consumes', 'produces'];

export function endpointChanges(db: DB, baseSid: number, headSid: number): EndpointChange[] {
  const b = kindNodes(db, baseSid, 'API_ENDPOINT');
  const h = kindNodes(db, headSid, 'API_ENDPOINT');
  const out: EndpointChange[] = [];
  const headByHandler = new Map([...h.values()].map((n) => [String(n.attrs.handler ?? ''), n]));
  for (const [id, n] of b) {
    const m = h.get(id);
    if (!m) {
      const moved = headByHandler.get(String(n.attrs.handler ?? ''));
      out.push(moved && !b.has(moved.id)
        ? { id, name: n.name, change: 'MOVED', to: moved.name, file: n.filePath, line: n.lineStart }
        : { id, name: n.name, change: 'REMOVED', file: n.filePath, line: n.lineStart });
      continue;
    }
    const fields = CONTRACT_KEYS.filter((k) => JSON.stringify(n.attrs[k] ?? null) !== JSON.stringify(m.attrs[k] ?? null));
    const secB = (n.attrs as any).security?.rule ?? null;
    const secH = (m.attrs as any).security?.rule ?? null;
    if (secB !== secH) fields.push(`security (${secB} → ${secH})`);
    if (fields.length) out.push({ id, name: n.name, change: 'CONTRACT_CHANGED', fields, file: m.filePath, line: m.lineStart });
  }
  const movedTo = new Set(out.filter((e) => e.change === 'MOVED').map((e) => e.to));
  for (const [id, n] of h) if (!b.has(id) && !movedTo.has(n.name)) out.push({ id, name: n.name, change: 'ADDED', file: n.filePath, line: n.lineStart });
  return out;
}

type Field = { name: string; type?: string };
function fieldDiff(before: Field[], after: Field[], typeKey: 'type' = 'type') {
  const bm = new Map(before.map((f) => [f.name, f]));
  const am = new Map(after.map((f) => [f.name, f]));
  return {
    added: [...am.keys()].filter((k) => !bm.has(k)),
    removed: [...bm.keys()].filter((k) => !am.has(k)),
    retyped: [...am.keys()].filter((k) => bm.has(k) && (bm.get(k)![typeKey] ?? '') !== (am.get(k)![typeKey] ?? '')).map((k) => `${k}: ${bm.get(k)![typeKey]} → ${am.get(k)![typeKey]}`),
  };
}

/** Field changes of types declared in the changed files (DTOs, entities, …), and column changes of every table. */
export function fieldChanges(db: DB, baseSid: number, headSid: number, changedFiles: string[]): { types: FieldChange[]; tables: FieldChange[] } {
  const types: FieldChange[] = [];
  const typeRows = (sid: number) => {
    const out = new Map<string, NodeDto>();
    for (const f of changedFiles) {
      for (const r of db.prepare(`SELECT * FROM nodes WHERE snapshot_id = ? AND file_path = ? AND json_extract(attrs_json, '$.fields') IS NOT NULL`).all(sid, f) as NodeRow[]) {
        out.set(r.id, toNode(r));
      }
    }
    return out;
  };
  const tb = typeRows(baseSid);
  const th = typeRows(headSid);
  for (const id of new Set([...tb.keys(), ...th.keys()])) {
    const b = tb.get(id);
    const h = th.get(id);
    const d = fieldDiff((b?.attrs.fields as Field[]) ?? [], (h?.attrs.fields as Field[]) ?? []);
    if (b && h && (d.added.length || d.removed.length || d.retyped.length)) {
      types.push({ id, name: h.name, kind: h.kind, ...d, file: h.filePath, line: h.lineStart });
    }
  }
  const tables: FieldChange[] = [];
  const bt = kindNodes(db, baseSid, 'DATABASE_TABLE');
  const ht = kindNodes(db, headSid, 'DATABASE_TABLE');
  for (const [id, h] of ht) {
    const b = bt.get(id);
    const cols = (n?: NodeDto) => ((n?.attrs.columns as Field[]) ?? []);
    if (!b) {
      if (h.attrs.inCatalog !== false) tables.push({ id, name: h.name, kind: 'DATABASE_TABLE', added: ['(new table)'], removed: [], retyped: [], file: h.filePath, line: h.lineStart });
      continue;
    }
    if (h.attrs.dropped && !b.attrs.dropped) {
      tables.push({ id, name: h.name, kind: 'DATABASE_TABLE', added: [], removed: ['(table dropped)'], retyped: [], file: h.filePath, line: h.lineStart });
      continue;
    }
    const d = fieldDiff(cols(b), cols(h));
    if (d.added.length || d.removed.length || d.retyped.length) tables.push({ id, name: h.name, kind: 'DATABASE_TABLE', ...d, file: h.filePath, line: h.lineStart });
  }
  return { types, tables };
}

/** Callees added or removed by each modified method or function. */
export function callChanges(db: DB, baseSid: number, headSid: number, modified: ChangedNode[]): CallChange[] {
  const out: CallChange[] = [];
  const callees = (sid: number, id: string) => new Set((db.prepare(`SELECT dst FROM edges WHERE snapshot_id = ? AND src = ? AND kind IN ('CALLS', 'MAKES_HTTP_CALL', 'QUERIES', 'CALLS_EXTERNAL')`)
    .all(sid, id) as Array<{ dst: string }>).map((r) => r.dst));
  for (const m of modified.filter((n) => n.change === 'MODIFIED' && (n.kind === 'METHOD' || n.kind === 'UI_FUNCTION'))) {
    const b = callees(baseSid, m.id);
    const h = callees(headSid, m.id);
    const added = [...h].filter((x) => !b.has(x) && !x.startsWith('ui:http:') && !x.startsWith('sql:'));
    const removed = [...b].filter((x) => !h.has(x) && !x.startsWith('ui:http:') && !x.startsWith('sql:'));
    if (added.length || removed.length) out.push({ method: m.id, name: m.name, added: added.slice(0, 30), removed: removed.slice(0, 30) });
  }
  return out;
}

/**
 * UI → API links before and after. A call is identified by its enclosing function, HTTP method and URL text, so it keeps
 * its identity when lines move. LINK_LOST is the breaking case: the call is unchanged but no endpoint serves it anymore.
 */
export function uiLinkChanges(db: DB, baseSid: number, headSid: number): UiLinkChange[] {
  const linksOf = (sid: number) => {
    const calls = (db.prepare(`SELECT n.*, e.src AS fn FROM nodes n JOIN edges e ON e.snapshot_id = n.snapshot_id AND e.dst = n.id AND e.kind = 'MAKES_HTTP_CALL'
        WHERE n.snapshot_id = ? AND n.kind = 'UI_HTTP_CALL'`).all(sid) as Array<NodeRow & { fn: string }>);
    const api = new Map<string, string[]>();
    for (const e of (db.prepare(`SELECT * FROM edges WHERE snapshot_id = ? AND kind = 'CALLS_API'`).all(sid) as EdgeRow[]).map(toEdge)) {
      (api.get(e.src) ?? api.set(e.src, []).get(e.src)!).push(e.dst);
    }
    const out = new Map<string, { node: NodeDto; endpoints: string[] }>();
    for (const r of calls) {
      const n = toNode(r);
      const key = `${r.fn}|${n.attrs.httpMethod ?? '?'}|${n.attrs.url ?? ''}`;
      out.set(key, { node: n, endpoints: (api.get(n.id) ?? []).sort() });
    }
    return out;
  };
  const b = linksOf(baseSid);
  const h = linksOf(headSid);
  // Calls whose URL text was edited: pair the leftovers of the same function and HTTP method, in source order.
  const fnMethod = (key: string) => key.split('|').slice(0, 2).join('|');
  const leftB = [...b.keys()].filter((k) => !h.has(k));
  const leftH = [...h.keys()].filter((k) => !b.has(k));
  const pairedBefore = new Map<string, string>();
  for (const group of new Set(leftH.map(fnMethod))) {
    const bs = leftB.filter((k) => fnMethod(k) === group).sort((x, y) => (b.get(x)!.node.lineStart ?? 0) - (b.get(y)!.node.lineStart ?? 0));
    const hs = leftH.filter((k) => fnMethod(k) === group).sort((x, y) => (h.get(x)!.node.lineStart ?? 0) - (h.get(y)!.node.lineStart ?? 0));
    hs.slice(0, bs.length).forEach((k, i) => pairedBefore.set(k, bs[i]!));
  }
  const out: UiLinkChange[] = [];
  for (const [key, after] of h) {
    const beforeKey = b.has(key) ? key : pairedBefore.get(key);
    const before = beforeKey ? b.get(beforeKey) : undefined;
    const base = {
      call: after.node.id, name: after.node.name, file: after.node.filePath, line: after.node.lineStart, before: before?.endpoints ?? [], after: after.endpoints,
      ...(before && beforeKey !== key ? { urlBefore: String(before.node.attrs.url ?? '') } : {}),
    };
    if (!before) {
      out.push({ ...base, change: after.endpoints.length ? 'NEW_LINKED' : 'NEW_UNLINKED' });
    } else if (before.endpoints.length && !after.endpoints.length) {
      out.push({ ...base, change: 'LINK_LOST' });
    } else if (before.endpoints.join() !== after.endpoints.join()) {
      out.push({ ...base, change: 'RELINKED' });
    }
  }
  return out;
}
