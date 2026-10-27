import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, RESOLUTIONS, type GraphQuery } from '../api';
import { RESOLUTION_STYLE } from '../theme';

/**
 * For reverse traversals: every entry point (endpoint, job, listener) that can reach the root, grouped by the strongest
 * chain of evidence. Computed server-side with a large budget, so it does not depend on how much of the graph is drawn.
 */
export function ReachPanel(props: { snapshotId?: number; query: GraphQuery; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  const { query } = props;
  const q = useQuery({
    queryKey: ['reach', props.snapshotId, query.root, query.depth, query.preset, query.minResolution, query.includeAccessors],
    queryFn: () => api.reach(props.snapshotId, {
      root: query.root, depth: query.depth, preset: query.preset, minResolution: query.minResolution, includeAccessors: query.includeAccessors,
    }),
    enabled: query.direction === 'reverse',
  });
  if (query.direction !== 'reverse') return null;
  const r = q.data?.data;
  return (
    <div className="reach" aria-label="Affected entry points">
      <h4>
        <span>{q.isFetching ? 'Computing reach…' : `Entry points reaching this (${r?.entryPoints.length ?? 0}${r?.truncated ? '+, budget reached' : ''})`}</span>
        <button className="btn" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button>
      </h4>
      {q.error && <div className="error">{(q.error as Error).message}</div>}
      {open && r && (
        <>
          {r.entryPoints.length === 0 && <div className="note">None within depth {r.depth}. Increase depth or change “Follow”.</div>}
          {RESOLUTIONS.map((res) => {
            const group = r.entryPoints.filter((n) => n.pathResolution === res);
            if (!group.length) return null;
            return (
              <div key={res}>
                <div className="grp" style={{ color: RESOLUTION_STYLE[res].stroke }} title={RESOLUTION_STYLE[res].help}>
                  {RESOLUTION_STYLE[res].label} path ({group.length})
                </div>
                {group.map((n) => (
                  <div key={n.id} className="row mono" onClick={() => props.onPick(n.id)} title={`${n.id} · depth ${n.depth}`}>
                    {n.kind === 'API_ENDPOINT' ? n.name : `${String(n.attrs.entryPoint).toLowerCase()}: ${n.fqn?.split('#')[0]?.split('.').pop()}.${n.name}()`}
                    {n.viaEnclosingType && <span className="flag" style={{ marginLeft: 6 }} title="Reached only through a field of another type: the code may not touch this field">via enclosing type</span>}
                  </div>
                ))}
              </div>
            );
          })}
          <div className="note" style={{ marginTop: 6 }}>
            {r.visited} nodes examined within depth {r.depth}. Path strength = best chain of evidence; framework-derived links
            (Spring wiring, MVC mappings) cap it below confirmed, ambiguous dispatch marks potential impact.
          </div>
        </>
      )}
    </div>
  );
}
