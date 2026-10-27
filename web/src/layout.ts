import ELK from 'elkjs/lib/elk.bundled.js';

export const NODE_W = 250;
export const NODE_H = 58;

const elk = new ELK();

/** Layered left-to-right layout; returns top-left positions keyed by node id. */
export async function layout(nodeIds: string[], edges: Array<{ id: string; source: string; target: string }>) {
  const ids = new Set(nodeIds);
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.spacing.nodeNode': '22',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
    },
    children: nodeIds.map((id) => ({ id, width: NODE_W, height: NODE_H })),
    edges: edges
      .filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });
  const pos = new Map<string, { x: number; y: number }>();
  for (const c of graph.children ?? []) pos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  return pos;
}
