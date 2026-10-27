import {
  Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import { memo, useEffect, useMemo, useState } from 'react';
import type { GraphNode, GraphResult } from '../api';
import { layout, NODE_H, NODE_W } from '../layout';
import { displayName, KIND_LABEL, kindColor, RESOLUTION_STYLE } from '../theme';
import type { Selection } from './DetailsPanel';

type CodeNodeData = { node: GraphNode; isRoot: boolean; selected: boolean; reverse: boolean; onExpand: (id: string) => void };

const CodeNode = memo(({ data }: NodeProps<Node<CodeNodeData>>) => {
  const n = data.node;
  const sub = n.kind === 'METHOD' ? (n.signature ?? '') : n.kind === 'API_ENDPOINT' ? String(n.attrs.handler ?? '').split('#')[1] ?? '' : (n.fqn ?? n.filePath ?? '');
  return (
    <div className={`cnode ${data.isRoot ? 'root' : ''} ${data.selected ? 'selected' : ''} ${n.inScope ? '' : 'out'}`}
      style={{ ['--kind' as string]: kindColor(n.kind) }} title={n.id}>
      <Handle type="target" position={Position.Left} />
      <div className="kind">
        <span>{KIND_LABEL[n.kind] ?? n.kind}</span>
        {!n.inScope && <span title="Outside the analysed packages: outgoing calls not extracted">out of scope</span>}
        {n.attrs.async === true && <span>@Async</span>}
      </div>
      <div className="title">
        {data.reverse && !data.isRoot && (
          <span className="pr" style={{ background: RESOLUTION_STYLE[n.pathResolution].stroke }} title={`Strongest evidence path from the root: ${RESOLUTION_STYLE[n.pathResolution].label}`} />
        )}
        {displayName(n)}
      </div>
      <div className="sub mono">{sub}</div>
      {n.hasMore && (
        <button className="more" title="Expand" onClick={(e) => { e.stopPropagation(); data.onExpand(n.id); }}>⊕</button>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const nodeTypes = { code: CodeNode };

function Inner(props: {
  graph: GraphResult; rootId: string; selection: Selection | null;
  onSelect: (s: Selection) => void; onExpand: (id: string) => void; onReroot: (id: string) => void;
}) {
  const { graph, rootId, selection } = props;
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const flow = useReactFlow();
  const reverse = graph.direction === 'reverse';

  // Edges are drawn in execution direction; for reverse impact the layout runs right-to-left by flipping x.
  const layoutKey = graph.nodes.map((n) => n.id).sort().join('|') + '#' + graph.edges.length;
  useEffect(() => {
    let cancelled = false;
    layout(graph.nodes.map((n) => n.id), graph.edges.map((e) => ({ id: e.id, source: reverse ? e.dst : e.src, target: reverse ? e.src : e.dst })))
      .then((p) => {
        if (cancelled) return;
        if (reverse) {
          const maxX = Math.max(0, ...[...p.values()].map((v) => v.x));
          for (const [k, v] of p) p.set(k, { x: maxX - v.x, y: v.y });
        }
        setPositions(p);
        requestAnimationFrame(() => {
          // Fit when the result stays legible; otherwise start at a readable zoom on the root and let the user pan.
          const xs = [...p.values()].map((v) => v.x);
          const ys = [...p.values()].map((v) => v.y);
          const w = Math.max(...xs) - Math.min(...xs) + NODE_W;
          const h = Math.max(...ys) - Math.min(...ys) + NODE_H;
          const el = document.querySelector('.canvas');
          const fitZoom = el ? Math.min(el.clientWidth / w, el.clientHeight / h) : 1;
          const r = p.get(rootId);
          if (fitZoom < 0.55 && r) {
            // Root sits at the left for forward flows and at the right for reverse impact; show it plus a few layers.
            const x = reverse ? r.x - NODE_W : r.x + NODE_W * 2;
            void flow.setCenter(x, r.y + NODE_H / 2, { zoom: 0.8, duration: 200 });
          } else {
            void flow.fitView({ padding: 0.15, duration: 200, maxZoom: 1.2 });
          }
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, reverse]);

  const cycles = useMemo(() => new Set(graph.cycleEdges), [graph.cycleEdges]);
  const nodes: Node<CodeNodeData>[] = graph.nodes.map((n) => ({
    id: n.id,
    type: 'code',
    position: positions.get(n.id) ?? { x: 0, y: 0 },
    data: {
      node: n, isRoot: n.id === rootId, selected: selection?.type === 'node' && selection.id === n.id, reverse, onExpand: props.onExpand,
    },
  }));
  const edges: Edge[] = graph.edges.map((e) => {
    const st = RESOLUTION_STYLE[e.resolution];
    const selected = selection?.type === 'edge' && selection.id === e.id;
    const tags = [cycles.has(e.id) ? '↺ cycle' : '', e.attrs.async ? 'async' : '', e.attrs.conditional ? 'if' : '', e.kind !== 'CALLS' ? e.kind.toLowerCase() : '']
      .filter(Boolean).join(' · ');
    return {
      id: e.id,
      source: e.src,
      target: e.dst,
      label: tags || undefined,
      labelStyle: { fontSize: 10, fill: 'var(--muted)' },
      labelBgStyle: { fill: 'var(--panel)' },
      markerEnd: { type: MarkerType.ArrowClosed, color: st.stroke },
      style: { stroke: st.stroke, strokeDasharray: st.dash, strokeWidth: selected ? 3 : 1.5 },
    };
  });

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, n) => props.onSelect({ type: 'node', id: n.id })}
      onNodeDoubleClick={(_, n) => props.onReroot(n.id)}
      onEdgeClick={(_, e) => props.onSelect({ type: 'edge', id: e.id })}
      nodesDraggable
      nodesConnectable={false}
      minZoom={0.1}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={(n) => kindColor((n.data as CodeNodeData).node.kind)} />
      <Legend />
    </ReactFlow>
  );
}

function Legend() {
  return (
    <div className="legend" aria-label="Legend">
      {Object.entries(RESOLUTION_STYLE).map(([k, s]) => (
        <div className="row" key={k} title={s.help}>
          <svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" stroke={s.stroke} strokeWidth="2" strokeDasharray={s.dash} /></svg>
          {s.label}
        </div>
      ))}
      {['API_ENDPOINT', 'CONTROLLER', 'SERVICE', 'REPOSITORY', 'INTERFACE', 'METHOD', 'DTO', 'ENTITY', 'SQL_STATEMENT', 'DATABASE_TABLE',
        'EXTERNAL_API', 'CONFIG_PROPERTY', 'EVENT', 'UNRESOLVED'].map((k) => (
        <div className="row" key={k}>
          <svg width="10" height="10"><rect width="10" height="10" rx="2" fill={kindColor(k)} /></svg>
          {KIND_LABEL[k] ?? k}
        </div>
      ))}
    </div>
  );
}

export function GraphView(props: Parameters<typeof Inner>[0]) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
