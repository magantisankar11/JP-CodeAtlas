import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { api, defaultsFor, RESOLUTIONS, type GraphQuery, type GraphResult, type ImpactRequest, type Preset, type Resolution } from './api';
import { ImpactPanel } from './components/ImpactPanel';
import { DetailsPanel, type Selection } from './components/DetailsPanel';
import { FreshnessBadge } from './components/FreshnessBadge';
import { GraphView } from './components/GraphView';
import { ReachPanel } from './components/ReachPanel';
import { SearchPanel } from './components/SearchPanel';
import { RESOLUTION_STYLE } from './theme';

function merge(base: GraphResult, extra: GraphResult): GraphResult {
  const nodes = new Map(base.nodes.map((n) => [n.id, n]));
  for (const n of extra.nodes) {
    const prev = nodes.get(n.id);
    nodes.set(n.id, prev ? { ...prev, hasMore: prev.hasMore && n.hasMore } : n);
  }
  const expandedRoot = nodes.get(extra.root);
  if (expandedRoot) nodes.set(extra.root, { ...expandedRoot, hasMore: extra.nodes.find((n) => n.id === extra.root)?.hasMore ?? false });
  const edges = new Map(base.edges.map((e) => [e.id, e]));
  for (const e of extra.edges) edges.set(e.id, e);
  return {
    ...base,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    cycleEdges: [...new Set([...base.cycleEdges, ...extra.cycleEdges])],
    truncated: base.truncated || extra.truncated,
  };
}

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function App() {
  const snapshots = useQuery({ queryKey: ['snapshots'], queryFn: api.snapshots });
  const [snapshotId, setSnapshotId] = useState<number>();
  const [params, setParams] = useState<Omit<GraphQuery, 'root'>>({
    direction: 'forward', depth: 3, minResolution: 'UNRESOLVED', includeAccessors: false, collapseDispatch: true, limit: 150, preset: 'flow',
  });
  const [root, setRoot] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [impactReq, setImpactReq] = useState<ImpactRequest | null>(null);

  // Default: the newest current (published) snapshot; the list is newest first, so this is [0] when nothing is published.
  const snapshot = snapshots.data?.data.find((s) => s.id === snapshotId) ?? snapshots.data?.data.find((s) => s.current) ?? snapshots.data?.data[0];
  useEffect(() => {
    if (snapshotId === undefined && snapshot) setSnapshotId(snapshot.id);
  }, [snapshot, snapshotId]);

  useEffect(() => {
    if (!root || !snapshot) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.graph(snapshot.id, { root, ...params })
      .then((r) => !cancelled && setGraph(r.data))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [root, params, snapshot]);

  const expand = useCallback(async (id: string) => {
    if (!snapshot || !graph) return;
    try {
      const r = await api.graph(snapshot.id, { ...params, root: id, depth: 2 });
      setGraph((g) => (g ? merge(g, r.data) : r.data));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [snapshot, graph, params]);

  /** Picking a new root applies sensible defaults for its kind (e.g. a DTO opens as reverse type-impact). */
  const openRoot = (id: string, kind?: string) => {
    const k = kind ?? graph?.nodes.find((n) => n.id === id)?.kind;
    if (k) {
      const d = defaultsFor(k);
      const depth = d.direction === 'reverse' ? Math.max(params.depth, 6) : params.depth;
      setParams((p) => ({ ...p, ...d, depth }));
    }
    setRoot(id);
    setSelection({ type: 'node', id });
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>Java Code Intel</h1>
        {snapshots.data && snapshots.data.data.length > 0 ? (
          <select value={snapshot?.id} onChange={(e) => setSnapshotId(Number(e.target.value))} aria-label="Snapshot">
            {snapshots.data.data.map((s) => (
              <option key={s.id} value={s.id}>{s.repoId} @ {s.commitSha.slice(0, 10)} ({Array.isArray(s.scope?.repos) ? s.scope.repos.map((r: { repoId: string }) => r.repoId).join(' + ') : String(s.scope?.includePackages?.join(', ') || 'all packages')}){s.current ? ' (current)' : ''}</option>
            ))}
          </select>
        ) : (
          <span className="snap">{snapshots.isLoading ? 'Loading…' : 'No snapshot loaded'}</span>
        )}
        <FreshnessBadge snapshot={snapshot} onSwitch={setSnapshotId} />
        <div className="controls">
          <div className="seg" role="group" aria-label="Direction">
            <button className={params.direction === 'forward' ? 'on' : ''} onClick={() => setParams({ ...params, direction: 'forward' })}>Forward flow</button>
            <button className={params.direction === 'reverse' ? 'on' : ''} onClick={() => setParams({ ...params, direction: 'reverse' })}>Reverse impact</button>
          </div>
          <label title="Which relationships to follow">Follow
            <select value={params.preset} onChange={(e) => setParams({ ...params, preset: e.target.value as Preset })} aria-label="Edge preset">
              <option value="flow">Execution flow</option>
              <option value="type-impact">Type impact (DTO/entity)</option>
              <option value="data">Data (tables)</option>
              <option value="all">All relationships</option>
              <option value="ui">Screens (UI → API)</option>
            </select>
          </label>
          <label>Depth
            <input type="number" min={1} max={10} value={params.depth} style={{ width: 52 }} aria-label="Depth"
              onChange={(e) => setParams({ ...params, depth: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} />
          </label>
          <label>Show
            <select value={params.minResolution} onChange={(e) => setParams({ ...params, minResolution: e.target.value as Resolution })}>
              {RESOLUTIONS.map((r, i) => (
                <option key={r} value={r}>{i === 0 ? 'Confirmed only' : `${RESOLUTION_STYLE[RESOLUTIONS[0]!].label} … ${RESOLUTION_STYLE[r].label}`}</option>
              ))}
            </select>
          </label>
          <label>
            <input type="checkbox" aria-label="Show accessors" checked={params.includeAccessors} onChange={(e) => setParams({ ...params, includeAccessors: e.target.checked })} />
            Accessors
          </label>
          <label title="Show the statically bound interface/abstract method next to the implementation it dispatches to">
            <input type="checkbox" aria-label="Show interface hops" checked={!params.collapseDispatch} onChange={(e) => setParams({ ...params, collapseDispatch: !e.target.checked })} />
            Interface hops
          </label>
          <label>Max nodes
            <input type="number" min={10} max={500} step={10} value={params.limit} style={{ width: 64 }} aria-label="Max nodes"
              onChange={(e) => setParams({ ...params, limit: Math.max(10, Math.min(500, Number(e.target.value) || 150)) })} />
          </label>
          <button className="btn" disabled={!graph} onClick={() => graph && snapshot && download(
            `graph-${graph.direction}-${snapshot.commitSha.slice(0, 10)}.json`,
            JSON.stringify({ snapshot: { repoId: snapshot.repoId, commitSha: snapshot.commitSha }, query: { root, ...params }, ...graph }, null, 2),
          )}>Export JSON</button>
        </div>
      </header>

      <SearchPanel snapshotId={snapshot?.id} activeRoot={root} onPick={openRoot} onAnalyze={setImpactReq} />

      <main className="canvas">
        {impactReq && (
          <ImpactPanel snapshotId={snapshot?.id} request={impactReq} onClose={() => setImpactReq(null)}
            onPick={(id) => setSelection({ type: 'node', id })} />
        )}
        {error && <div className="banner error">{error}</div>}
        {!error && graph && (
          <div className="banner">
            {graph.nodes.length} nodes · {graph.edges.length} edges · depth {graph.limits.depth}
            {graph.cycleEdges.length > 0 && ` · ${graph.cycleEdges.length} cycle edge(s)`}
            {graph.truncated && ' · truncated (use ⊕ to expand)'}
            {loading && ' · loading…'}
          </div>
        )}
        {root && graph ? (
          <>
            <GraphView graph={graph} rootId={root} selection={selection} onSelect={setSelection} onExpand={expand} onReroot={(id) => openRoot(id)} />
            <ReachPanel snapshotId={snapshot?.id} query={{ root, ...params }} onPick={(id) => setSelection({ type: 'node', id })} />
          </>
        ) : (
          <div className="empty">
            <div>
              <p><strong>Pick an endpoint, class or method</strong> on the left to see its execution flow.</p>
              <p className="note">Only a bounded neighbourhood is drawn; expand nodes marked ⊕ to go further.</p>
            </div>
          </div>
        )}
      </main>

      <DetailsPanel snapshotId={snapshot?.id} snapshot={snapshot} repoPath={snapshot?.repoPath ?? null} commitSha={snapshot?.commitSha ?? ''}
        selection={selection} graph={graph} onSelect={setSelection} onReroot={openRoot}
        onImpact={(id, name) => setImpactReq({ targets: [id], title: name })} />
    </div>
  );
}
