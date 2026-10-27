import type { DB } from '../db.js';
import { resolutionRank, type EdgeDto, type NodeDto, type Resolution } from '../contract.js';
import { getNode, PRESETS, REACH_BUDGET, toEdge, toNode, traverse, type EdgeRow, type GraphResult, type NodeRow } from '../query.js';
import { evaluateGates, loadGates } from './gates.js';
import {
  classify, IMPACT_SCHEMA, type Classification, type ErrorPath, type EvidenceRef, type Finding, type ImpactReport, type RegressionCandidate,
  type Risk, type RootCauseCandidate, type TableUse, type UiImpact, type Unknown,
} from './types.js';

export interface SnapshotInfo {
  id: number; repoId: string; commitSha: string; sourceMode: string | null; analyzerVersion: string | null;
  scope: Record<string, unknown>; repoPath: string | null;
}

export interface ImpactRequest {
  targets: string[];
  upstreamDepth?: number;
  downstreamDepth?: number;
  rootCauses?: RootCauseCandidate[];
}

const TYPE_KINDS = new Set(['DTO', 'ENTITY', 'CLASS', 'RECORD', 'ENUM', 'INTERFACE', 'COMPONENT', 'SERVICE', 'REPOSITORY', 'CONTROLLER', 'CONFIGURATION']);
const MAX_LIST = 300;
/** Upstream hard cap; the node budget (REACH_BUDGET) bounds the cost. Real call chains to an endpoint exceed 10. */
export const MAX_UPSTREAM_DEPTH = 16;
const SHARED_CALLER_TYPES = 5;
const RES: Resolution[] = ['CONFIRMED', 'FRAMEWORK_DERIVED', 'AMBIGUOUS', 'UNRESOLVED'];
const CLASS_ORDER: Classification[] = ['CONFIRMED_DEPENDENCY', 'POTENTIAL_IMPACT', 'UNKNOWN'];

/** Frontend edges, followed in reverse from affected endpoints: endpoint ← HTTP call ← function ← component ← route. */
export const UI_UP = ['CALLS_API', 'MAKES_HTTP_CALL', 'CALLS', 'CONTAINS', 'RENDERS', 'ROUTES_TO'];
const UI_DOWN = ['CONTAINS', 'CALLS', 'MAKES_HTTP_CALL', 'CALLS_API', 'RENDERS'];
const UI_DEPTH = 12;
const UI_COMPONENT_KINDS = new Set(['UI_COMPONENT', 'UI_STORE', 'UI_MODULE']);
const isUiKind = (kind: string) => kind.startsWith('UI_');

/** Upstream preset by target kind: who depends on this? */
function upstreamPreset(kind: string): string[] {
  if (isUiKind(kind)) return UI_UP;
  if (kind === 'DATABASE_TABLE' || kind === 'DATABASE_PROCEDURE') return PRESETS.data!;
  if (TYPE_KINDS.has(kind) && kind !== 'SERVICE' && kind !== 'REPOSITORY' && kind !== 'CONTROLLER' && kind !== 'COMPONENT') return PRESETS['type-impact']!;
  if (kind === 'CONFIG_PROPERTY') return [...PRESETS.flow!, 'READS_CONFIG'];
  if (kind === 'EXTERNAL_API' || kind === 'EVENT') return PRESETS.flow!;
  return PRESETS.flow!;
}

const loc = (n: NodeDto) => ({ file: n.filePath, line: n.lineStart });
const label = (n: NodeDto) => (n.kind === 'METHOD' && n.fqn ? `${n.fqn.split('#')[0]!.split('.').pop()}.${n.name}()` : n.name);
const isEntryPoint = (n: NodeDto) => n.kind === 'API_ENDPOINT' || (typeof n.attrs.entryPoint === 'string' && n.attrs.entryPoint !== 'HTTP');
const typeOfMethod = (id: string) => (id.startsWith('method:') ? `type:${id.slice('method:'.length, id.indexOf('#'))}` : null);

function finding(n: NodeDto, depth: number, basis: Resolution, via = false, note?: string): Finding {
  return { id: n.id, kind: n.kind, name: label(n), fqn: n.fqn, ...loc(n), depth, classification: classify(basis, via), basis, ...(via ? { viaEnclosingType: true } : {}), ...(note ? { note } : {}) };
}

function better(a: Finding | undefined, b: Finding): Finding {
  if (!a) return b;
  const ca = CLASS_ORDER.indexOf(a.classification);
  const cb = CLASS_ORDER.indexOf(b.classification);
  return cb < ca || (cb === ca && b.depth < a.depth) ? b : a;
}

function byClassThenDepth(a: Finding, b: Finding) {
  return CLASS_ORDER.indexOf(a.classification) - CLASS_ORDER.indexOf(b.classification) || a.depth - b.depth || a.name.localeCompare(b.name);
}

function nodesByIds(db: DB, sid: number, ids: string[]): Map<string, NodeDto> {
  const out = new Map<string, NodeDto>();
  for (let i = 0; i < ids.length; i += 400) {
    const b = ids.slice(i, i + 400);
    for (const r of db.prepare(`SELECT * FROM nodes WHERE snapshot_id = ? AND id IN (${b.map(() => '?').join(',')})`).all(sid, ...b) as NodeRow[]) {
      out.set(r.id, toNode(r));
    }
  }
  return out;
}

function edgesWhere(db: DB, sid: number, col: 'src' | 'dst', ids: string[], kinds: string[]): EdgeDto[] {
  const out: EdgeDto[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const b = ids.slice(i, i + 300);
    out.push(...(db.prepare(`SELECT * FROM edges WHERE snapshot_id = ? AND ${col} IN (${b.map(() => '?').join(',')}) AND kind IN (${kinds.map(() => '?').join(',')})`)
      .all(sid, ...b, ...kinds) as EdgeRow[]).map(toEdge));
  }
  return out;
}

export function analyzeImpact(db: DB, snap: SnapshotInfo, req: ImpactRequest, gatesFile?: string): ImpactReport {
  const sid = snap.id;
  const upDepth = Math.min(req.upstreamDepth ?? 8, MAX_UPSTREAM_DEPTH);
  const downDepth = Math.min(req.downstreamDepth ?? 4, 10);
  const targets = req.targets.map((id) => getNode(db, sid, id)).filter((n): n is NodeDto => Boolean(n));
  if (!targets.length) throw new Error(`None of the targets exist in snapshot ${sid}: ${req.targets.join(', ')}`);
  const targetIds = new Set(targets.map((t) => t.id));

  // ---------------------------------------------------------------- upstream (who depends on the targets)
  const up = new Map<string, Finding>();
  const upGraphs: GraphResult[] = [];
  let upTruncated = false;
  let examined = 0;
  for (const t of targets) {
    const g = traverse(db, sid, {
      root: t.id, direction: 'reverse', depth: upDepth, edgeKinds: upstreamPreset(t.kind), includeAccessors: true, collapseDispatch: false, limit: REACH_BUDGET,
    }, REACH_BUDGET)!;
    upGraphs.push(g);
    upTruncated ||= g.truncated;
    examined += g.nodes.length;
    for (const n of g.nodes) {
      if (targetIds.has(n.id)) continue;
      up.set(n.id, better(up.get(n.id), finding(n, n.depth, n.pathResolution, n.viaEnclosingType)));
    }
  }
  const entryPoints = [...up.values()].filter((f) => f.kind === 'API_ENDPOINT' || upNode(upGraphs, f.id)?.attrs.entryPoint && upNode(upGraphs, f.id)?.attrs.entryPoint !== 'HTTP');
  for (const t of targets) if (isEntryPoint(t)) entryPoints.push(finding(t, 0, 'CONFIRMED', false, 'is itself an entry point'));
  entryPoints.sort(byClassThenDepth);
  const callers = [...up.values()].filter((f) => f.kind === 'METHOD').sort(byClassThenDepth);

  // ---------------------------------------------------------------- downstream (what the targets depend on)
  const downGraphs: GraphResult[] = [];
  let downTruncated = false;
  for (const t of targets) {
    let kinds: string[] | null = null;
    if (t.kind === 'METHOD' || t.kind === 'API_ENDPOINT') kinds = PRESETS.flow!;
    else if (t.kind === 'ENTITY') kinds = ['MAPS_TO'];
    else if (isUiKind(t.kind)) kinds = [...UI_DOWN, ...PRESETS.flow!];
    if (!kinds) continue;
    const g = traverse(db, sid, { root: t.id, direction: 'forward', depth: downDepth, edgeKinds: kinds, includeAccessors: false, collapseDispatch: true, limit: 500 })!;
    downGraphs.push(g);
    downTruncated ||= g.truncated;
  }
  const down = new Map<string, Finding>();
  for (const g of downGraphs) {
    for (const n of g.nodes) {
      if (targetIds.has(n.id)) continue;
      down.set(n.id, better(down.get(n.id), finding(n, n.depth, n.pathResolution, n.viaEnclosingType)));
    }
  }
  const downNodes = new Map(downGraphs.flatMap((g) => g.nodes.map((n) => [n.id, n] as const)));
  const downEdges = downGraphs.flatMap((g) => g.edges);
  const downMethods = [...down.values()].filter((f) => f.kind === 'METHOD').sort(byClassThenDepth);

  // ---------------------------------------------------------------- directly affected: targets, implementations, declaring types
  const direct = new Map<string, Finding>();
  for (const t of targets) direct.set(t.id, finding(t, 0, 'CONFIRMED', false, 'analysis target'));
  const methodTargets = targets.filter((t) => t.kind === 'METHOD').map((t) => t.id);
  if (methodTargets.length) {
    const impls = db.prepare(`SELECT DISTINCT dst, json_extract(attrs_json, '$.viaDispatch') AS via, resolution FROM edges
      WHERE snapshot_id = ? AND kind = 'CALLS' AND json_extract(attrs_json, '$.viaDispatch') IN (${methodTargets.map(() => '?').join(',')})`)
      .all(sid, ...methodTargets) as Array<{ dst: string; via: string; resolution: Resolution }>;
    const abstracts = db.prepare(`SELECT DISTINCT json_extract(attrs_json, '$.viaDispatch') AS via FROM edges
      WHERE snapshot_id = ? AND kind = 'CALLS' AND dst IN (${methodTargets.map(() => '?').join(',')}) AND json_extract(attrs_json, '$.viaDispatch') IS NOT NULL`)
      .all(sid, ...methodTargets) as Array<{ via: string }>;
    const extra = nodesByIds(db, sid, [...impls.map((r) => r.dst), ...abstracts.map((r) => r.via)]);
    for (const r of impls) {
      const n = extra.get(r.dst);
      if (n && !direct.has(n.id)) direct.set(n.id, finding(n, 1, r.resolution, false, `implementation of ${r.via.replace('method:', '')}`));
    }
    for (const r of abstracts) {
      const n = extra.get(r.via);
      if (n && !direct.has(n.id)) direct.set(n.id, finding(n, 1, 'CONFIRMED', false, 'interface / overridden method of a target'));
    }
  }

  // ---------------------------------------------------------------- shared utilities (fan-in evidence)
  const candidatesForShared = [...methodTargets, ...downMethods.slice(0, MAX_LIST).map((m) => m.id)];
  const fanIn = new Map<string, { callers: Set<string>; types: Set<string> }>();
  for (const e of edgesWhere(db, sid, 'dst', candidatesForShared, ['CALLS'])) {
    const f = fanIn.get(e.dst) ?? { callers: new Set(), types: new Set() };
    f.callers.add(e.src);
    const ty = typeOfMethod(e.src);
    if (ty) f.types.add(ty);
    fanIn.set(e.dst, f);
  }
  const sharedUtilities = candidatesForShared
    .filter((id) => (fanIn.get(id)?.types.size ?? 0) >= SHARED_CALLER_TYPES)
    .map((id) => {
      const base = direct.get(id) ?? down.get(id)!;
      return { ...base, callers: fanIn.get(id)!.callers.size, callerTypes: fanIn.get(id)!.types.size };
    })
    .sort((a, b) => b.callerTypes - a.callerTypes);

  // ---------------------------------------------------------------- data contracts of affected endpoints
  const endpointFindings = new Map<string, Finding>();
  for (const f of entryPoints) if (f.kind === 'API_ENDPOINT') endpointFindings.set(f.id, f);
  const contractEdges = edgesWhere(db, sid, 'src', [...endpointFindings.keys()], ['ACCEPTS', 'RETURNS']);
  const typeNames = nodesByIds(db, sid, [...new Set(contractEdges.map((e) => e.dst))]);
  const dataContracts = [...endpointFindings.values()].map((f) => ({
    endpoint: f.name,
    accepts: contractEdges.filter((e) => e.src === f.id && e.kind === 'ACCEPTS').map((e) => typeNames.get(e.dst)?.name ?? e.dst),
    returns: contractEdges.filter((e) => e.src === f.id && e.kind === 'RETURNS').map((e) => typeNames.get(e.dst)?.name ?? e.dst),
    classification: f.classification,
    viaEnclosingType: Boolean(f.viaEnclosingType),
  }));

  // ---------------------------------------------------------------- frontend consumers (system snapshots)
  let ui: UiImpact | undefined;
  if (db.prepare(`SELECT 1 FROM nodes WHERE snapshot_id = ? AND kind = 'UI_HTTP_CALL' LIMIT 1`).get(sid)) {
    const seeds = [...endpointFindings.values(), ...targets.filter((t) => t.kind === 'API_ENDPOINT' || isUiKind(t.kind)).map((t) => finding(t, 0, 'CONFIRMED'))];
    ui = uiUpstream(db, sid, seeds);
    for (const r of ui.routes) entryPoints.push(r);
    entryPoints.sort(byClassThenDepth);
  }

  // ---------------------------------------------------------------- database
  const tableIds = new Set<string>();
  for (const e of downEdges) if (e.kind === 'READS' || e.kind === 'WRITES') tableIds.add(e.dst);
  for (const t of targets) if (t.kind === 'DATABASE_TABLE') tableIds.add(t.id);
  for (const e of downEdges) if (e.kind === 'MAPS_TO') tableIds.add(e.dst);
  const tableNodes = nodesByIds(db, sid, [...tableIds]);
  const tableIn = edgesWhere(db, sid, 'dst', [...tableIds], ['READS', 'WRITES', 'MAPS_TO']);
  const sqlInImpact = new Set(downEdges.filter((e) => e.kind === 'QUERIES').map((e) => e.dst));
  const targetTables = new Set(targets.filter((t) => t.kind === 'DATABASE_TABLE').map((t) => t.id));
  const sqlNodes = nodesByIds(db, sid, [...new Set(tableIn.filter((e) => e.kind !== 'MAPS_TO').map((e) => e.src))]);
  const entityNodes = nodesByIds(db, sid, [...new Set(tableIn.filter((e) => e.kind === 'MAPS_TO').map((e) => e.src))]);
  const database: TableUse[] = [...tableIds].map((tid) => {
    const n = tableNodes.get(tid);
    const incoming = tableIn.filter((e) => e.dst === tid);
    const relevant = incoming.filter((e) => e.kind !== 'MAPS_TO' && (targetTables.has(tid) || sqlInImpact.has(e.src)));
    return {
      table: n?.name ?? tid,
      inCatalog: n?.attrs.inCatalog !== false,
      reads: relevant.filter((e) => e.kind === 'READS').length,
      writes: relevant.filter((e) => e.kind === 'WRITES').length,
      statements: relevant.slice(0, 50).map((e) => {
        const s = sqlNodes.get(e.src);
        return {
          id: e.src, file: s?.filePath ?? null, line: s?.lineStart ?? null, operation: String(s?.attrs.operation ?? '?'), resolution: e.resolution,
          ...(e.attrs.conditional ? { conditionalTable: true } : {}),
        };
      }),
      entities: incoming.filter((e) => e.kind === 'MAPS_TO').map((e) => entityNodes.get(e.src)?.name ?? e.src),
      writersOutsideImpact: targetTables.has(tid) ? 0 : incoming.filter((e) => e.kind === 'WRITES' && !sqlInImpact.has(e.src)).length,
    };
  }).sort((a, b) => b.writes - a.writes || a.table.localeCompare(b.table));

  // ---------------------------------------------------------------- error handling
  // Targets, their downstream, and direct callers (which react to the targets' results, e.g. throw on null).
  const throwerIds = [...new Set([...methodTargets, ...downMethods.map((m) => m.id), ...callers.filter((c) => c.depth === 1).map((c) => c.id)])];
  const throws = edgesWhere(db, sid, 'src', throwerIds, ['THROWS']);
  const handlerEdges = (db.prepare(`SELECT * FROM edges WHERE snapshot_id = ? AND kind = 'HANDLES_EXCEPTION'`).all(sid) as EdgeRow[]).map(toEdge);
  const extendsOf = (id: string) => (db.prepare(`SELECT dst FROM edges WHERE snapshot_id = ? AND src = ? AND kind = 'EXTENDS'`).all(sid, id) as Array<{ dst: string }>).map((r) => r.dst);
  const ancestors = (id: string) => {
    const chain: string[] = [id];
    for (let cur = id, i = 0; i < 20; i++) {
      const next = extendsOf(cur)[0];
      if (!next) break;
      chain.push(next);
      cur = next;
    }
    return chain;
  };
  const httpAffected = endpointFindings.size > 0 || targets.some((t) => t.kind === 'API_ENDPOINT');
  const throwerNodes = nodesByIds(db, sid, [...new Set(throws.map((e) => e.src))]);
  const errorHandling: ErrorPath[] = [...new Set(throws.map((e) => e.dst))].map((exId) => {
    const chain = ancestors(exId);
    const top = chain[chain.length - 1]!;
    const handlers = handlerEdges.flatMap((h) => {
      const idx = chain.indexOf(h.dst);
      let basis: ErrorPath['handlers'][number]['basis'] | null = idx === 0 ? 'EXACT' : idx > 0 ? 'SUPERTYPE' : null;
      if (!basis && /^type:java\./.test(top) && /Exception$/.test(top) && (h.dst === 'type:java.lang.Exception' || h.dst === 'type:java.lang.Throwable')) {
        basis = 'ASSUMED_JDK_HIERARCHY';
      }
      return basis ? [{ handler: h.src.replace('method:', ''), status: (h.attrs.status as string) ?? null, scope: String(h.attrs.scope ?? ''), basis }] : [];
    });
    const handled: ErrorPath['handled'] = !httpAffected ? 'NOT_HTTP'
      : handlers.some((h) => h.basis !== 'ASSUMED_JDK_HIERARCHY') ? 'YES' : handlers.length ? 'PROBABLY' : 'NO';
    return {
      exception: exId.replace('type:', ''),
      thrownAt: throws.filter((e) => e.dst === exId).slice(0, 20).map((e) => ({
        method: label(throwerNodes.get(e.src) ?? ({ kind: 'METHOD', name: e.src, fqn: null } as NodeDto)),
        file: e.evidence[0]?.filePath ?? null, line: e.evidence[0]?.line ?? null, declared: e.attrs.declared === true,
      })),
      handlers, handled,
    };
  });

  // ---------------------------------------------------------------- security, configuration
  const epNodes = nodesByIds(db, sid, [...endpointFindings.keys(), ...targets.filter((t) => t.kind === 'API_ENDPOINT').map((t) => t.id)]);
  const security = [...epNodes.values()].map((n) => ({
    endpoint: n.name, rule: String((n.attrs as any).security?.rule ?? 'UNKNOWN'), args: ((n.attrs as any).security?.args ?? []) as string[],
    matcher: ((n.attrs as any).security?.matcher as string) ?? null, caution: ((n.attrs as any).security?.mayAlsoMatchEarlier as string) ?? null,
  }));
  const configOwners = [...throwerIds, ...new Set(throwerIds.map(typeOfMethod).filter((x): x is string => Boolean(x)))];
  const configEdges = edgesWhere(db, sid, 'src', configOwners, ['READS_CONFIG']);
  const configNodes = nodesByIds(db, sid, [...new Set(configEdges.map((e) => e.dst))]);
  const configuration = [...configNodes.values()].map((c) => ({
    key: c.name,
    defined: c.attrs.defined !== false,
    readers: (db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE snapshot_id = ? AND dst = ? AND kind = 'READS_CONFIG'`).get(sid, c.id) as { n: number }).n,
  }));

  // ---------------------------------------------------------------- unknowns
  const unknowns: Unknown[] = [];
  const allEdges = [...upGraphs.flatMap((g) => g.edges), ...downEdges];
  const seenEdge = new Set<string>();
  let ambiguous = 0;
  for (const e of allEdges) {
    if (seenEdge.has(e.id)) continue;
    seenEdge.add(e.id);
    if (e.resolution === 'UNRESOLVED') {
      unknowns.push({ kind: `UNRESOLVED_${e.kind}`, detail: `${e.src.replace(/^method:/, '')} → ${String(e.attrs.reason ?? e.dst)}`, edgeId: e.id, file: e.evidence[0]?.filePath ?? null, line: e.evidence[0]?.line ?? null });
    } else if (e.resolution === 'AMBIGUOUS') {
      ambiguous++;
      if (ambiguous <= 30) {
        unknowns.push({ kind: 'AMBIGUOUS_DISPATCH', detail: `${e.src.replace(/^method:/, '')} → ${e.dst.replace(/^method:/, '')} (${String(e.attrs.reason ?? e.attrs.dispatchRule ?? '')})`, edgeId: e.id, file: e.evidence[0]?.filePath ?? null, line: e.evidence[0]?.line ?? null });
      }
    }
  }
  if (ambiguous > 30) unknowns.push({ kind: 'AMBIGUOUS_DISPATCH', detail: `${ambiguous - 30} more ambiguous links not listed`, file: null, line: null });
  for (const n of [...upGraphs.flatMap((g) => g.nodes), ...downNodes.values()]) {
    if (!n.inScope && n.kind === 'METHOD') {
      unknowns.push({ kind: 'OUT_OF_SCOPE', detail: `${label(n)} is outside the analysed packages; its outgoing calls were not extracted`, nodeId: n.id, ...loc(n) });
      break;
    }
  }
  if (upTruncated) unknowns.push({ kind: 'TRUNCATED_UPSTREAM', detail: `Upstream traversal hit the ${REACH_BUDGET}-node budget; entry point list may be incomplete`, file: null, line: null });
  if (downTruncated) unknowns.push({ kind: 'TRUNCATED_DOWNSTREAM', detail: 'Downstream traversal hit its 500-node limit at the given depth', file: null, line: null });
  if (database.length) unknowns.push({ kind: 'RUNTIME_DATASOURCE', detail: 'Datasource routing is decided at runtime: tables are named, the target database/tenant is not', file: null, line: null });
  if (endpointFindings.size) unknowns.push({ kind: 'RUNTIME_AUTHORIZATION', detail: 'Method-level authorization (e.g. Casbin enforce calls) is runtime policy and not evaluated per endpoint', file: null, line: null });
  const outOfDepth = upGraphs.some((g) => g.nodes.some((n) => n.hasMore));
  if (outOfDepth) unknowns.push({ kind: 'DEPTH_LIMIT', detail: `Some upstream paths continue beyond depth ${upDepth}`, file: null, line: null });

  // ---------------------------------------------------------------- tests
  const testNodes = (db.prepare(`SELECT * FROM nodes WHERE snapshot_id = ? AND kind = 'TEST_CASE' LIMIT 1`).all(sid) as NodeRow[]).map(toNode);
  const roots = Array.isArray(snap.scope.sourceRoots) ? (snap.scope.sourceRoots as string[]).join(', ') : 'src/main/java';
  const existing: Finding[] = [];
  if (ui) {
    // A spec counts only when it imports an affected component or store. Specs importing a shared service module (which
    // they usually mock) say nothing about this endpoint, and even a component import does not prove the affected call runs.
    const reachedFiles = ui.components.filter((c) => c.kind === 'UI_COMPONENT' || c.kind === 'UI_STORE').map((c) => c.id);
    const testEdges = edgesWhere(db, sid, 'dst', reachedFiles, ['TESTS']);
    for (const [id, n] of nodesByIds(db, sid, [...new Set(testEdges.map((e) => e.src))])) {
      const covered = [...new Set(testEdges.filter((e) => e.src === id).map((e) => e.dst.replace('ui:file:', '')))];
      existing.push(finding(n, 0, 'AMBIGUOUS', false, `imports ${covered.slice(0, 5).join(', ')}; whether it exercises the affected call is not proven`));
    }
  }
  const tests = {
    existing,
    note: existing.length
      ? `${existing.length} frontend spec(s) import affected components (potential coverage only); no backend test sources are indexed (source roots: ${roots}).`
      : testNodes.length
        ? 'Test cases are indexed but none link to the affected code.'
        : `No test sources are indexed in this snapshot (source roots: ${roots}). No existing test coverage can be claimed for the affected code.`,
  };
  if (ui?.unlinkedCalls) {
    unknowns.push({ kind: 'UI_UNLINKED_HTTP', detail: `${ui.unlinkedCalls} UI HTTP call(s) build their URL at runtime and could not be linked to an endpoint; they may also call the affected endpoints`, file: null, line: null });
  }
  if (ui?.truncated) unknowns.push({ kind: 'TRUNCATED_UI', detail: `UI traversal hit its budget or depth ${UI_DEPTH}; the screen list may be incomplete`, file: null, line: null });

  // ---------------------------------------------------------------- risks and regression candidates
  const risks = buildRisks({ targets, entryPoints, endpointFindings, database, errorHandling, security, configuration, sharedUtilities, direct, downNodes, unknowns, ui });
  const regressionCandidates = buildCandidates(db, sid, { targets, entryPoints, database, errorHandling, epNodes, ui, existingTests: existing });
  const repos = Array.isArray(snap.scope.repos)
    ? (snap.scope.repos as Array<{ repoId: string; commitSha: string; role?: string }>).map((r) => ({ repoId: r.repoId, commitSha: r.commitSha, role: r.role }))
    : undefined;

  const report: ImpactReport = {
    schema: IMPACT_SCHEMA,
    snapshot: { id: snap.id, repoId: snap.repoId, commitSha: snap.commitSha, sourceMode: snap.sourceMode, analyzerVersion: snap.analyzerVersion, ...(repos ? { repos } : {}) },
    generatedAt: new Date().toISOString(),
    params: { upstreamDepth: upDepth, downstreamDepth: downDepth },
    targets: targets.map((t) => finding(t, 0, 'CONFIRMED')),
    directlyAffected: [...direct.values()],
    upstream: { entryPoints, callers: callers.slice(0, MAX_LIST), truncated: upTruncated, examined },
    downstream: {
      methods: downMethods.slice(0, MAX_LIST),
      externals: [...down.values()].filter((f) => f.kind === 'EXTERNAL_API').sort(byClassThenDepth),
      events: [...down.values()].filter((f) => f.kind === 'EVENT'),
      truncated: downTruncated,
    },
    sharedUtilities, dataContracts, database, errorHandling, security, configuration, risks, unknowns, tests, regressionCandidates,
    ...(ui ? { ui } : {}),
    rootCauseCandidates: req.rootCauses ?? [],
    gates: [],
  };
  report.gates = evaluateGates(loadGates(gatesFile), report);
  return report;
}

/**
 * Reverse walk over frontend edges from the affected endpoints (and UI targets). Path strength is the max-min rule used
 * everywhere else: a node's basis is the weakest link on its strongest path, seeded with the endpoint's own basis.
 */
function uiUpstream(db: DB, sid: number, seeds: Finding[], budget = REACH_BUDGET): UiImpact {
  const best = new Map<string, { rank: number; depth: number; via: boolean; note?: string }>();
  for (const s of seeds) {
    const r = resolutionRank(s.basis);
    const prev = best.get(s.id);
    if (!prev || r < prev.rank) best.set(s.id, { rank: r, depth: s.depth, via: Boolean(s.viaEnclosingType) });
  }
  const seedNames = new Map(seeds.map((s) => [s.id, s.name]));
  let frontier = [...best.keys()];
  let truncated = false;
  for (let level = 1; level <= UI_DEPTH && frontier.length; level++) {
    const next = new Set<string>();
    for (const e of edgesWhere(db, sid, 'dst', frontier, UI_UP)) {
      if (!e.src.startsWith('ui:')) continue;
      const from = best.get(e.dst)!;
      const rank = Math.max(from.rank, resolutionRank(e.resolution));
      const prev = best.get(e.src);
      if (prev && (prev.rank < rank || (prev.rank === rank && prev.depth <= from.depth + 1))) continue;
      const note = e.kind === 'CALLS_API' ? `calls ${seedNames.get(e.dst) ?? e.dst.replace('endpoint:', '')}${e.attrs.conditional ? ' (conditional URL)' : ''}` : prev?.note;
      best.set(e.src, { rank, depth: from.depth + 1, via: from.via, note });
      next.add(e.src);
    }
    frontier = [...next];
    if (best.size > budget || (level === UI_DEPTH && frontier.length)) {
      truncated = true;
      break;
    }
  }
  const ids = [...best.keys()].filter((id) => id.startsWith('ui:'));
  const nodes = nodesByIds(db, sid, ids);
  const all = ids.flatMap((id) => {
    const n = nodes.get(id);
    const b = best.get(id)!;
    return n ? [finding(n, b.depth, RES[b.rank] ?? 'UNRESOLVED', b.via, b.note)] : [];
  });
  const pick = (pred: (f: Finding) => boolean) => all.filter(pred).sort(byClassThenDepth).slice(0, MAX_LIST);
  const unlinked = db.prepare(`SELECT COUNT(*) AS n FROM diagnostics WHERE snapshot_id = ? AND code IN ('UI_HTTP_URL_UNKNOWN', 'UI_HTTP_TOO_MANY_CANDIDATES')`).get(sid) as { n: number };
  return {
    httpCalls: pick((f) => f.kind === 'UI_HTTP_CALL'),
    functions: pick((f) => f.kind === 'UI_FUNCTION'),
    components: pick((f) => UI_COMPONENT_KINDS.has(f.kind)),
    routes: pick((f) => f.kind === 'UI_ROUTE'),
    truncated,
    unlinkedCalls: unlinked.n,
  };
}

function upNode(graphs: GraphResult[], id: string) {
  for (const g of graphs) {
    const n = g.nodes.find((x) => x.id === id);
    if (n) return n;
  }
  return undefined;
}

function best(findings: Finding[]): Classification {
  return findings.map((f) => f.classification).sort((a, b) => CLASS_ORDER.indexOf(a) - CLASS_ORDER.indexOf(b))[0] ?? 'UNKNOWN';
}

function ref(f: { id?: string; file: string | null; line: number | null }): EvidenceRef {
  return { nodeId: f.id, file: f.file, line: f.line };
}

function buildRisks(ctx: {
  targets: NodeDto[]; entryPoints: Finding[]; endpointFindings: Map<string, Finding>; database: TableUse[]; errorHandling: ErrorPath[];
  security: ImpactReport['security']; configuration: ImpactReport['configuration']; sharedUtilities: ImpactReport['sharedUtilities'];
  direct: Map<string, Finding>; downNodes: Map<string, NodeDto>; unknowns: Unknown[]; ui?: UiImpact;
}): Risk[] {
  const risks: Risk[] = [];
  if (ctx.ui?.httpCalls.length) {
    const screens = ctx.ui.components.filter((c) => c.kind === 'UI_COMPONENT');
    risks.push({
      id: 'R-UI-CONSUMERS', category: 'UI',
      title: `${ctx.ui.httpCalls.length} UI HTTP call site(s) in ${screens.length} component(s) and ${ctx.ui.routes.length} route(s) use the affected endpoint(s)`,
      detail: 'Response shape, status codes and error payloads are consumed by these screens; verify them in the browser or with component tests. '
        + (ctx.ui.routes.length ? `Routes: ${ctx.ui.routes.slice(0, 15).map((r) => r.name).join(', ')}` : 'No routed screen reaches them within the traversal depth.'),
      classification: best(ctx.ui.httpCalls), evidence: ctx.ui.httpCalls.slice(0, 30).map(ref),
    });
  }
  const endpoints = [...ctx.endpointFindings.values()];
  const typeTargets = ctx.targets.filter((t) => TYPE_KINDS.has(t.kind));
  if (typeTargets.length && endpoints.length) {
    const directEps = endpoints.filter((e) => !e.viaEnclosingType);
    risks.push({
      id: 'R-API-CONTRACT', category: 'API_CONTRACT',
      title: `Type change alters the JSON contract of ${directEps.length} endpoint(s) directly and ${endpoints.length - directEps.length} through enclosing types`,
      detail: 'Renaming, removing or retyping fields changes request/response payloads. Clients of these endpoints (UI, add-ins, integrations) must stay compatible; consider additive changes.',
      classification: best(endpoints), evidence: endpoints.slice(0, 40).map(ref),
    });
  } else if (endpoints.length) {
    risks.push({
      id: 'R-API-BEHAVIOUR', category: 'API_CONTRACT',
      title: `${endpoints.length} endpoint(s) execute the changed code`,
      detail: 'Behaviour changes surface in these endpoints\' responses and side effects even when signatures are unchanged.',
      classification: best(endpoints), evidence: endpoints.slice(0, 40).map(ref),
    });
  }
  const jobs = ctx.entryPoints.filter((e) => e.kind === 'METHOD');
  if (jobs.length) {
    risks.push({
      id: 'R-JOBS', category: 'BACKGROUND_JOBS', title: `${jobs.length} scheduled job / listener entry point(s) reach the changed code`,
      detail: 'Background executions have no HTTP caller to report failures; verify logs, retries and idempotency.',
      classification: best(jobs), evidence: jobs.map(ref),
    });
  }
  for (const t of ctx.database.filter((d) => d.writes > 0 && d.writersOutsideImpact > 0)) {
    risks.push({
      id: `R-DB-SHARED-${t.table}`, category: 'DATABASE', title: `Table ${t.table} is also written by ${t.writersOutsideImpact} statement(s) outside this impact`,
      detail: 'Changes to how this table is written must stay consistent with the other writers.',
      classification: 'CONFIRMED_DEPENDENCY', evidence: t.statements.slice(0, 10).map((s) => ({ nodeId: s.id, file: s.file, line: s.line })),
    });
  }
  for (const t of ctx.database.filter((d) => !d.inCatalog)) {
    risks.push({
      id: `R-DB-UNCATALOGED-${t.table}`, category: 'DATABASE', title: `Table ${t.table} is not defined by the indexed migration scripts`,
      detail: 'It may be created at runtime, in another schema, or by a dynamic name; schema changes cannot be checked statically.',
      classification: 'UNKNOWN', evidence: t.statements.slice(0, 5).map((s) => ({ nodeId: s.id, file: s.file, line: s.line })),
    });
  }
  const entityTargets = ctx.targets.filter((t) => t.kind === 'ENTITY');
  if (entityTargets.length && ctx.database.length) {
    risks.push({
      id: 'R-DB-ENTITY', category: 'DATABASE', title: `Entity change is coupled to table(s) ${ctx.database.map((d) => d.table).join(', ')}`,
      detail: 'Column renames or type changes need a Flyway migration and must keep native SQL that reads the same table working.',
      classification: 'CONFIRMED_DEPENDENCY', evidence: entityTargets.map((t) => ({ nodeId: t.id, file: t.filePath, line: t.lineStart })),
    });
  }
  if (ctx.configuration.length) {
    risks.push({
      id: 'R-CONFIG', category: 'CONFIGURATION', title: `${ctx.configuration.length} configuration key(s) read on the affected paths`,
      detail: ctx.configuration.map((c) => `${c.key}${c.defined ? '' : ' (not defined in indexed property files)'}, ${c.readers} reader(s)`).join('; '),
      classification: 'CONFIRMED_DEPENDENCY', evidence: [],
    });
  }
  const externals = [...ctx.downNodes.values()].filter((n) => n.kind === 'EXTERNAL_API');
  if (externals.length) {
    const unresolved = externals.filter((n) => n.id.startsWith('external:http:?'));
    risks.push({
      id: 'R-INTEGRATION', category: 'INTEGRATION', title: `${externals.length} outbound call target(s) on the affected paths${unresolved.length ? `, ${unresolved.length} with runtime-built URLs` : ''}`,
      detail: externals.slice(0, 15).map((n) => n.name).join('; '),
      classification: unresolved.length ? 'UNKNOWN' : 'CONFIRMED_DEPENDENCY', evidence: externals.slice(0, 15).map((n) => ({ nodeId: n.id, file: n.filePath, line: n.lineStart })),
    });
  }
  const impls = [...ctx.direct.values()].filter((f) => f.note?.startsWith('implementation of'));
  if (impls.length > 1) {
    risks.push({
      id: 'R-IMPLEMENTATIONS', category: 'IMPLEMENTATIONS', title: `${impls.length} implementations share the changed contract`,
      detail: 'Interface or overridden-method changes must be applied consistently to every implementation.',
      classification: best(impls), evidence: impls.map(ref),
    });
  }
  const publicEps = ctx.security.filter((s) => s.rule === 'permitAll');
  if (publicEps.length) {
    risks.push({
      id: 'R-SECURITY-PUBLIC', category: 'SECURITY', title: `${publicEps.length} affected endpoint(s) are publicly accessible (permitAll)`,
      detail: publicEps.map((s) => s.endpoint).join('; '), classification: 'CONFIRMED_DEPENDENCY', evidence: [],
    });
  }
  const unhandled = ctx.errorHandling.filter((e) => e.handled === 'NO' || e.handled === 'PROBABLY');
  if (unhandled.length) {
    risks.push({
      id: 'R-ERRORS', category: 'ERROR_HANDLING',
      title: `${unhandled.length} exception type(s) on HTTP paths without an exact @ExceptionHandler`,
      detail: unhandled.map((e) => `${e.exception}: ${e.handled === 'NO' ? 'no handler' : 'only a generic Exception handler (assumed JDK hierarchy)'}`).join('; '),
      classification: unhandled.some((e) => e.handled === 'NO') ? 'CONFIRMED_DEPENDENCY' : 'POTENTIAL_IMPACT',
      evidence: unhandled.flatMap((e) => e.thrownAt.slice(0, 3).map((t) => ({ file: t.file, line: t.line }))),
    });
  }
  // Only a shared *target* is a risk: helpers the target merely calls are unchanged by the fix (listed as context).
  const targetIds = new Set(ctx.targets.map((t) => t.id));
  const sharedTargets = ctx.sharedUtilities.filter((s) => targetIds.has(s.id));
  if (sharedTargets.length) {
    risks.push({
      id: 'R-SHARED', category: 'SHARED_CODE',
      title: `Changed method(s) are widely shared: ${sharedTargets.map((s) => `${s.name} (${s.callers} callers in ${s.callerTypes} types)`).join(', ')}`,
      detail: 'Every caller observes the change; prefer an additive variant or a narrowly scoped parameter over changing shared behaviour.',
      classification: 'CONFIRMED_DEPENDENCY', evidence: sharedTargets.map(ref),
    });
  }
  return risks;
}

function testPath(fqnType: string, suffix: string) {
  const pkg = fqnType.slice(0, fqnType.lastIndexOf('.'));
  const cls = fqnType.slice(fqnType.lastIndexOf('.') + 1);
  return `src/test/java/${pkg.replace(/\./g, '/')}/${cls}${suffix}.java`;
}

function buildCandidates(db: DB, sid: number, ctx: {
  targets: NodeDto[]; entryPoints: Finding[]; database: TableUse[]; errorHandling: ErrorPath[]; epNodes: Map<string, NodeDto>;
  ui?: UiImpact; existingTests?: Finding[];
}): RegressionCandidate[] {
  const out: RegressionCandidate[] = [];
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  for (const t of ctx.targets.filter((x) => x.kind === 'METHOD' && x.fqn)) {
    const typeFqn = t.fqn!.split('#')[0]!;
    const branches = edgesWhere(db, sid, 'src', [t.id], ['CALLS', 'THROWS', 'QUERIES'])
      .filter((e) => e.attrs.conditional === true || e.kind === 'THROWS');
    const deps = edgesWhere(db, sid, 'src', [`type:${typeFqn}`], ['INJECTS']).map((e) => e.dst.replace('type:', '').split('.').pop());
    out.push({
      id: id('UNIT'), level: 'UNIT', title: `Unit test ${label(t)}`, target: t.id, classification: 'CONFIRMED_DEPENDENCY',
      rationale: 'Directly changed method: pin current behaviour before changing it, then assert the fix.',
      evidence: [{ nodeId: t.id, file: t.filePath, line: t.lineStart }],
      suggestedLocation: testPath(typeFqn, 'Test'),
      hints: [
        ...(deps.length ? [`Mock injected collaborators: ${[...new Set(deps)].join(', ')}`] : []),
        ...branches.slice(0, 12).map((e) => `${e.kind === 'THROWS' ? 'Exercise throw of' : 'Cover branch calling'} ${e.dst.replace(/^(method|type|sql):/, '').split('@')[0]} at ${e.evidence[0]?.filePath}:${e.evidence[0]?.line}`),
      ],
    });
  }
  const eps = ctx.entryPoints.filter((e) => e.kind === 'API_ENDPOINT');
  const ordered = [...eps.filter((e) => e.classification === 'CONFIRMED_DEPENDENCY').slice(0, 25), ...eps.filter((e) => e.classification !== 'CONFIRMED_DEPENDENCY').slice(0, 15)];
  for (const f of ordered) {
    const ep = ctx.epNodes.get(f.id);
    const controller = String(ep?.attrs.controller ?? '');
    const sec = (ep?.attrs as any)?.security?.rule;
    out.push({
      id: id('API'), level: 'API', title: `API test ${f.name}`, target: f.id, classification: f.classification,
      rationale: f.classification === 'CONFIRMED_DEPENDENCY'
        ? `Reaches the changed code (${f.basis.toLowerCase().replace('_', ' ')} path, depth ${f.depth}).`
        : `May reach the changed code (${f.viaEnclosingType ? 'through a field of an enclosing type' : 'ambiguous dispatch'}); confirm before relying on it.`,
      evidence: [ref(f)],
      suggestedLocation: controller ? testPath(controller, 'IT') : 'src/test/java/...IT.java',
      hints: [
        `MockMvc ${ep?.attrs.httpMethod ?? ''} ${ep?.attrs.fullPath ?? ep?.attrs.path ?? ''}`.trim(),
        ...((ep?.attrs as any)?.requestBody ? [`Request body ${String((ep!.attrs as any).requestBody.type).split('.').pop()}${(ep!.attrs as any).requestBody.validated ? ' (@Valid: include invalid-payload case)' : ''}`] : []),
        `Response ${String(ep?.attrs.responseType ?? '?').replace(/\b(?:[a-z_][a-z0-9_]*\.)+([A-Z])/g, '$1')}`,
        ...(sec === 'authenticated' ? ['Security: expect 401 without credentials, success with an authenticated user'] : sec ? [`Security rule: ${sec}`] : []),
      ],
    });
  }
  for (const f of ctx.entryPoints.filter((e) => e.kind === 'METHOD')) {
    out.push({
      id: id('JOB'), level: 'JOB', title: `Job/listener test ${f.name}`, target: f.id, classification: f.classification,
      rationale: 'Background entry point reaching the changed code.', evidence: [ref(f)],
      suggestedLocation: f.fqn ? testPath(f.fqn.split('#')[0]!, 'Test') : 'src/test/java/...',
      hints: ['Invoke the job method directly with representative inputs; assert side effects and error logging'],
    });
  }
  for (const t of ctx.database.filter((d) => d.writes > 0).slice(0, 15)) {
    out.push({
      id: id('DATA'), level: 'DATA', title: `Data verification for ${t.table}`, target: `table:${t.table}`, classification: 'CONFIRMED_DEPENDENCY',
      rationale: `${t.writes} write statement(s) on the affected paths${t.writersOutsideImpact ? `; ${t.writersOutsideImpact} other writer(s) exist` : ''}.`,
      evidence: t.statements.filter((s) => s.operation !== 'SELECT').slice(0, 5).map((s) => ({ nodeId: s.id, file: s.file, line: s.line })),
      suggestedLocation: 'Repository/DAO integration test against a disposable database',
      hints: ['Assert rows written/updated for the changed scenario and that unrelated rows are untouched'],
    });
  }
  for (const e of ctx.errorHandling.filter((x) => x.handled !== 'NOT_HTTP')) {
    out.push({
      id: id('ERR'), level: 'ERROR_PATH', title: `Error path ${e.exception.split('.').pop()}`, target: `type:${e.exception}`,
      classification: e.handled === 'YES' ? 'CONFIRMED_DEPENDENCY' : 'POTENTIAL_IMPACT',
      rationale: e.handled === 'YES' ? `Handled by ${e.handlers.map((h) => `${h.handler}${h.status ? ` (${h.status})` : ''}`).join(', ')}` : 'No exact handler: verify the HTTP status and body clients receive.',
      evidence: e.thrownAt.slice(0, 3).map((t) => ({ file: t.file, line: t.line })),
      suggestedLocation: 'Alongside the API tests above', hints: ['Trigger the throw site; assert status code and error payload'],
    });
  }
  const typeTargets = ctx.targets.filter((t) => TYPE_KINDS.has(t.kind));
  for (const t of typeTargets) {
    for (const f of eps.filter((e) => !e.viaEnclosingType).slice(0, 20)) {
      out.push({
        id: id('CONTRACT'), level: 'CONTRACT', title: `JSON contract of ${f.name} for ${t.name}`, target: f.id, classification: f.classification,
        rationale: `${t.name} is part of this endpoint's request or response.`, evidence: [ref(f)],
        suggestedLocation: 'JSON serialization / contract test', hints: ['Snapshot the serialized payload before the change and diff after'],
      });
    }
  }
  if (ctx.ui) {
    const called = [...new Set(ctx.ui.httpCalls.map((c) => c.note?.replace(/^calls /, '')).filter(Boolean))];
    for (const r of ctx.ui.routes.slice(0, 15)) {
      out.push({
        id: id('UI_E2E'), level: 'UI_E2E', title: `UI flow on route ${r.name}`, target: r.id, classification: r.classification,
        rationale: `Routed screen reaches the affected endpoint(s) through the frontend graph (depth ${r.depth}).`, evidence: [ref(r)],
        suggestedLocation: 'Browser / end-to-end test of this route',
        hints: [`Open ${r.name}; trigger the actions that call: ${called.slice(0, 5).join('; ')}`, 'Check loading, success and error rendering'],
      });
    }
    const tested = new Set((ctx.existingTests ?? []).flatMap((t) => (t.note ?? '').replace(/^imports /, '').split(';')[0]!.split(', ')));
    for (const c of ctx.ui.components.filter((x) => x.kind === 'UI_COMPONENT').slice(0, 15)) {
      const file = c.file?.replace(/^@[^/]+\//, '') ?? '';
      const base = file.split('/').pop()?.replace(/\.vue$/, '') || c.name;
      out.push({
        id: id('UI_COMPONENT'), level: 'UI_COMPONENT', title: `Component test ${c.name}`, target: c.id, classification: c.classification,
        rationale: tested.has(file) ? 'Already imported by an existing spec: extend it for the changed response.' : `Component reaches the affected endpoint(s) (depth ${c.depth}).`,
        evidence: [ref(c)], suggestedLocation: `test/unit/${base}.spec.js`,
        hints: ['Mount with the HTTP service mocked; assert the request sent and how the response / error is rendered'],
      });
    }
  }
  return out;
}

export { RES };
