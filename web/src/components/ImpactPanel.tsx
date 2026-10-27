import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Classification, type Finding, type ImpactRequest } from '../api';

const CLS: Record<Classification, { label: string; color: string }> = {
  CONFIRMED_DEPENDENCY: { label: 'Confirmed dependency', color: 'var(--r-confirmed)' },
  POTENTIAL_IMPACT: { label: 'Potential impact', color: 'var(--r-ambiguous)' },
  UNKNOWN: { label: 'Unknown', color: 'var(--r-unresolved)' },
};

function save(name: string, content: string, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Impact report for the selected targets (and optional defect text), with bundle downloads. */
export function ImpactPanel(props: { snapshotId?: number; request: ImpactRequest; onClose: () => void; onPick: (id: string) => void }) {
  const q = useQuery({
    queryKey: ['impact', props.snapshotId, props.request],
    queryFn: () => api.impact(props.snapshotId, props.request),
  });
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = q.data?.data;
  const download = async (only?: string) => {
    setExporting(true);
    setError(null);
    try {
      const files = (await api.exportContext(props.snapshotId, props.request)).data.files;
      const prefix = `${(props.request.title ?? 'impact').replace(/[^A-Za-z0-9_-]+/g, '-')}-`;
      for (const [name, content] of Object.entries(files)) {
        if (!only || only === name) save(prefix + name, content, name.endsWith('.json') ? 'application/json' : 'text/markdown');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  };
  const group = (list: Finding[]) => (['CONFIRMED_DEPENDENCY', 'POTENTIAL_IMPACT', 'UNKNOWN'] as Classification[])
    .map((c) => [c, list.filter((f) => f.classification === c)] as const).filter(([, l]) => l.length);

  return (
    <div className="impact" role="dialog" aria-label="Impact report">
      <div className="impact-head">
        <h2>Impact report{props.request.title ? `: ${props.request.title}` : ''}</h2>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn primary" disabled={exporting || !r} onClick={() => download()}>{exporting ? 'Exporting…' : 'Download context bundle (6 files)'}</button>
          <button className="btn" disabled={exporting || !r} onClick={() => download('impact-analysis.md')}>impact-analysis.md</button>
          <button className="btn" disabled={exporting || !r} onClick={() => download('jira-draft.md')}>jira-draft.md</button>
          <button className="btn" onClick={props.onClose}>Close</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {q.isLoading && <p className="note">Analysing upstream and downstream dependencies…</p>}
      {q.error && <p className="error">{(q.error as Error).message}</p>}
      {r && (
        <div className="impact-body">
          <p className="note">
            Commit <span className="mono">{r.snapshot.commitSha.slice(0, 12)}</span> · static evidence, not runtime observation · no numeric scores.
            {r.upstream.truncated && <strong className="error"> Traversal budget reached: entry point list incomplete.</strong>}
          </p>
          <div className="kpis">
            <div><b>{r.upstream.entryPoints.length}</b> entry points</div>
            <div><b>{r.upstream.callers.length}</b> callers</div>
            <div><b>{r.downstream.methods.length}</b> downstream</div>
            <div><b>{r.database.length}</b> tables</div>
            <div><b>{r.risks.length}</b> risks</div>
            <div><b>{r.unknowns.length}</b> unknowns</div>
            <div><b>{r.regressionCandidates.length}</b> test candidates</div>
          </div>

          {r.rootCauseCandidates.length > 0 && (
            <section>
              <h3>Root-cause candidates (evidence-ranked, not conclusions)</h3>
              {r.rootCauseCandidates.map((c) => (
                <div key={c.nodeId} className="row" onClick={() => props.onPick(c.nodeId)}>
                  <span className="flag">{c.strength}</span> <span className="mono">{c.name}</span> <span className="note">{c.reasons.join('; ')}</span>
                </div>
              ))}
            </section>
          )}

          <section>
            <h3>Entry points</h3>
            {r.upstream.entryPoints.length === 0 && <p className="note">None within depth {r.params.upstreamDepth}.</p>}
            {group(r.upstream.entryPoints).map(([c, list]) => (
              <div key={c}>
                <div className="grp" style={{ color: CLS[c].color }}>{CLS[c].label} ({list.length})</div>
                {list.slice(0, 60).map((f) => (
                  <div key={f.id} className="row mono" onClick={() => props.onPick(f.id)} title={`${f.basis} · depth ${f.depth}`}>
                    {f.name}{f.viaEnclosingType && <span className="flag" style={{ marginLeft: 6 }}>via enclosing type</span>}
                  </div>
                ))}
                {list.length > 60 && <div className="note">{list.length - 60} more in the downloaded report</div>}
              </div>
            ))}
          </section>

          {r.ui && (
            <section>
              <h3>Frontend consumers</h3>
              <p className="note">
                {r.ui.routes.length} route(s) · {r.ui.components.filter((c) => c.kind === 'UI_COMPONENT').length} component(s) · {r.ui.httpCalls.length} HTTP call site(s)
                {r.ui.truncated && <strong className="error"> UI traversal incomplete.</strong>}
              </p>
              {[...r.ui.routes, ...r.ui.httpCalls].slice(0, 40).map((f) => (
                <div key={f.id} className="row mono" onClick={() => props.onPick(f.id)} title={`${f.basis} · depth ${f.depth}${f.note ? ` · ${f.note}` : ''}`}>
                  <span className="flag" style={{ color: CLS[f.classification].color }}>{f.kind === 'UI_ROUTE' ? 'route' : 'call'}</span> {f.name}
                </div>
              ))}
            </section>
          )}

          <section>
            <h3>Risks</h3>
            {r.risks.length === 0 && <p className="note">No risk rule fired — not evidence of safety; check unknowns.</p>}
            {r.risks.map((k) => (
              <div key={k.id} className="risk">
                <div><span className="flag" style={{ background: 'transparent', border: `1px solid ${CLS[k.classification].color}`, color: CLS[k.classification].color }}>{CLS[k.classification].label}</span> <b>{k.title}</b></div>
                <div className="note">{k.category} · {k.detail}</div>
              </div>
            ))}
          </section>

          {r.database.length > 0 && (
            <section>
              <h3>Database</h3>
              <table className="params">
                <thead><tr><th>Table</th><th>R</th><th>W</th><th>Other writers</th><th>Entities</th></tr></thead>
                <tbody>{r.database.map((t) => <tr key={t.table}><td className="mono">{t.table}{t.inCatalog ? '' : ' *'}</td><td>{t.reads}</td><td>{t.writes}</td><td>{t.writersOutsideImpact}</td><td className="mono">{t.entities.join(', ')}</td></tr>)}</tbody>
              </table>
            </section>
          )}

          {r.errorHandling.length > 0 && (
            <section>
              <h3>Error handling</h3>
              {r.errorHandling.map((e) => (
                <div key={e.exception} className="row"><span className="mono">{e.exception.split('.').pop()}</span> <span className="flag">{e.handled}</span> <span className="note">{e.handlers.map((h) => h.handler.split('.').pop()).join(', ')}</span></div>
              ))}
            </section>
          )}

          <section>
            <h3>Unknowns ({r.unknowns.length})</h3>
            {r.unknowns.slice(0, 30).map((u, i) => <div key={i} className="row"><span className="flag">{u.kind}</span> <span className="note">{u.detail}</span></div>)}
          </section>

          <section>
            <h3>Regression test candidates</h3>
            <p className="note">{r.tests.note}</p>
            {r.regressionCandidates.slice(0, 40).map((c) => (
              <details key={c.id}>
                <summary><span className="flag">{c.level}</span> {c.title} <span className="note">({CLS[c.classification].label})</span></summary>
                <div className="note">{c.rationale}</div>
                <div className="mono note">{c.suggestedLocation}</div>
                <ul>{c.hints.map((h, i) => <li key={i} className="note">{h}</li>)}</ul>
              </details>
            ))}
          </section>

          <section>
            <h3>Closure gates</h3>
            <table className="params">
              <tbody>{r.gates.map((g) => <tr key={g.id}><td>{g.id} {g.title}</td><td><span className="flag">{g.status}</span></td><td className="note">{g.note}</td></tr>)}</tbody>
            </table>
          </section>
        </div>
      )}
    </div>
  );
}
