import { useState } from 'react';
import { api, type DefectCandidate, type ImpactRequest } from '../api';
import { KIND_LABEL, kindColor } from '../theme';

/** Paste ticket text, review matched code (with reasons), choose targets, run the impact report. */
export function DefectPanel(props: { snapshotId?: number; onAnalyze: (req: ImpactRequest) => void; onPick: (id: string, kind: string) => void }) {
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [candidates, setCandidates] = useState<DefectCandidate[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const match = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.defectMatch(props.snapshotId, text);
      setCandidates(r.data.candidates);
      setChosen(new Set(r.data.candidates.filter((c) => c.strength === 'EXACT').slice(0, 5).map((c) => c.nodeId)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) => setChosen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <div className="defect">
      <input placeholder="Ticket key or title (e.g. JP-12345)" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Ticket title" />
      <textarea rows={8} placeholder="Paste the ticket summary, description, log lines or stack trace…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Defect text" />
      <button className="btn" disabled={busy || text.trim().length < 5} onClick={match}>{busy ? 'Matching…' : 'Find related code'}</button>
      {error && <div className="error">{error}</div>}
      {candidates && (
        <>
          <div className="section"><span>Candidates ({candidates.length})</span><span>{chosen.size} selected</span></div>
          <p className="note" style={{ margin: '0 10px' }}>EXACT matches are preselected. Weak matches are hints only: select them only after checking.</p>
          {candidates.map((c) => (
            <label key={c.nodeId} className="item" title={c.reasons.join('\n')}>
              <input type="checkbox" checked={chosen.has(c.nodeId)} onChange={() => toggle(c.nodeId)} />
              <span className="flag">{c.strength}</span>
              <span className="badge" style={{ color: kindColor(c.kind) }}>{KIND_LABEL[c.kind] ?? c.kind}</span>
              <span className="name" onClick={(e) => { e.preventDefault(); props.onPick(c.nodeId, c.kind); }}>{c.name}</span>
            </label>
          ))}
          <div style={{ padding: 10 }}>
            <button className="btn primary" disabled={!chosen.size} onClick={() => props.onAnalyze({ targets: [...chosen], defectText: text, title: title || undefined })}>
              Analyse impact of {chosen.size} selected
            </button>
          </div>
        </>
      )}
    </div>
  );
}
