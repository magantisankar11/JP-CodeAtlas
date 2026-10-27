import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type Freshness, type RepoFreshness, type SnapshotDto } from '../api';

/**
 * Freshness strip in the header: per repository the indexed and selected commits and four independent chips (snapshot
 * accuracy, branch currency, remote information, working tree). Cached checks only refresh on focus and every 5 min;
 * the remote is contacted only by "Check remote now". When the API fails, every chip says unknown — never green.
 */
type Tone = 'ok' | 'warn' | 'unknown' | 'info';
const short = (s: string | null | undefined) => (s ? s.slice(0, 8) : '—');
const n = (x: number | null) => (x === null ? '?' : x.toLocaleString());
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

function chips(r: RepoFreshness): Array<{ dim: string; tone: Tone; text: string }> {
  const a = r.accuracy.status;
  const b = r.branch;
  const branchText = {
    UP_TO_DATE: 'Branch up to date', BEHIND: `Branch behind ${n(b.behind)}`, AHEAD: `Branch ahead ${n(b.ahead)}`,
    DIVERGED: `Branch diverged (+${n(b.ahead)}/−${n(b.behind)})`, NO_UPSTREAM: 'No upstream', UNKNOWN: 'Branch unknown',
  }[b.status];
  return [
    { dim: 'Snapshot accuracy', tone: a === 'CURRENT' ? 'ok' : a === 'STALE' ? 'warn' : 'unknown', text: `Snapshot ${a.toLowerCase()}` },
    { dim: 'Branch currency', tone: b.status === 'UP_TO_DATE' || b.status === 'AHEAD' ? 'ok' : b.status === 'BEHIND' || b.status === 'DIVERGED' ? 'warn' : b.status === 'NO_UPSTREAM' ? 'info' : 'unknown', text: branchText },
    { dim: 'Remote information', tone: r.remote.status === 'VERIFIED' || r.remote.status === 'RECENT' ? 'ok' : r.remote.status === 'NOT_APPLICABLE' ? 'info' : 'unknown',
      text: { VERIFIED: 'Remote verified', RECENT: 'Remote recent', UNKNOWN: 'Remote unverified', NOT_APPLICABLE: 'No remote' }[r.remote.status] },
    { dim: 'Working tree', tone: r.worktree.status === 'CLEAN' ? 'ok' : r.worktree.status === 'MODIFIED' ? 'warn' : 'unknown',
      text: r.worktree.status === 'MODIFIED' ? `${r.worktree.changedInScope} uncommitted source change(s)` : `Working tree ${r.worktree.status.toLowerCase()}` },
  ];
}

/** Indexed commits straight from the snapshot list, so they show even when the freshness API is unavailable. */
function indexedRepos(s: SnapshotDto): Array<{ repoId: string; commitSha: string }> {
  return Array.isArray(s.scope?.repos) && s.scope.repos.length ? s.scope.repos : [{ repoId: s.repoId, commitSha: s.commitSha }];
}

export function FreshnessBadge(props: { snapshot?: SnapshotDto; onSwitch: (id: number) => void }) {
  const sid = props.snapshot?.id;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [revs, setRevs] = useState<Record<string, string>>({});
  const [live, setLive] = useState<{ data?: Freshness; error?: string; busy: boolean }>({ busy: false });
  useEffect(() => {
    setRevs({});
    setDraft({});
    setLive({ busy: false });
  }, [sid]);
  useEffect(() => setLive({ busy: false }), [revs]);

  const q = useQuery({
    queryKey: ['freshness', sid, revs],
    queryFn: () => api.freshness(sid, { revs }),
    enabled: sid !== undefined,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
  // A failed refetch keeps the previous data in the query cache: never show it as current.
  const f = live.data ?? (q.isError ? undefined : q.data?.data);
  const failed = !f && (q.isError || !!live.error);

  const checkRemote = async () => {
    setLive({ busy: true });
    try {
      setLive({ busy: false, data: (await api.freshness(sid, { revs, remote: 'live', refresh: true })).data });
    } catch (e) {
      setLive({ busy: false, error: (e as Error).message });
    }
  };
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);
  if (!props.snapshot) return null;

  const rows = f
    ? f.repos.map((r) => ({ repoId: r.repoId, indexed: r.accuracy.indexedCommit, selected: r.accuracy.selected.commit, rev: r.accuracy.selected.rev, chips: chips(r) }))
    : indexedRepos(props.snapshot).map((r) => ({
      repoId: r.repoId, indexed: r.commitSha, selected: null, rev: revs[r.repoId] || 'HEAD',
      chips: ['Snapshot accuracy', 'Branch currency', 'Remote information', 'Working tree'].map((dim) => ({ dim, tone: 'unknown' as Tone, text: q.isLoading ? 'Checking…' : 'Unknown' })),
    }));

  return (
    <div className="fresh">
      <button className="fresh-strip" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}
        title="Index freshness: snapshot accuracy, branch, remote and working tree, each on its own">
        <span role="status" aria-live="polite" className="fresh-rows">
          {failed && <span className="chip unknown">Freshness unavailable</span>}
          {rows.map((r) => (
            <span key={r.repoId} className="fresh-row">
              <b>{r.repoId}</b>
              <span className="sha" title={`Indexed ${r.indexed} · selected ${r.rev} = ${r.selected ?? 'unknown'}`}>indexed {short(r.indexed)} · {r.rev === 'HEAD' ? 'HEAD' : r.rev} {short(r.selected)}</span>
              {r.chips.map((c) => <span key={c.dim} className={`chip ${c.tone}`} aria-label={`${c.dim}: ${c.text}`}>{c.text}</span>)}
            </span>
          ))}
        </span>
      </button>
      {open && (
        <div className="fresh-pop" role="dialog" aria-label="Index freshness details">
          <div className="fresh-head">
            <span>{f ? `Checked ${when(f.checkedAt)} (${f.remoteMode === 'live' ? 'remote checked live' : 'local remote-tracking refs'})` : failed ? 'The freshness API is unavailable: nothing below is verified.' : 'Checking…'}</span>
            <button className="btn" onClick={checkRemote} disabled={live.busy} title="Contacts each git remote once (ls-remote), without fetching and without prompting for credentials">
              {live.busy ? 'Checking remote…' : 'Check remote now'}
            </button>
            <button className="btn" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </div>
          {live.error && <div className="error">Remote check failed: {live.error}. Local results are unchanged.</div>}
          {q.isError && <div className="error">{(q.error as Error).message}</div>}
          {f?.matchingSnapshotId != null && (
            <div className="fresh-note">A loaded snapshot matches the selected commit(s).{' '}
              <button className="btn" onClick={() => { props.onSwitch(f.matchingSnapshotId!); setOpen(false); }}>Switch to snapshot {f.matchingSnapshotId}</button>
            </div>
          )}
          <form className="fresh-compare" onSubmit={(e) => { e.preventDefault(); setRevs({ ...draft }); }}>
            {rows.map((r) => (
              <label key={r.repoId}>Compare {r.repoId} against
                <input value={draft[r.repoId] ?? ''} placeholder="HEAD (branch, tag or SHA)" onChange={(e) => setDraft({ ...draft, [r.repoId]: e.target.value })} />
              </label>
            ))}
            <button className="btn" type="submit">Compare</button>
            {Object.values(revs).some(Boolean) && <button className="btn" type="button" onClick={() => { setRevs({}); setDraft({}); }}>Reset to HEAD</button>}
          </form>
          {f?.repos.map((r) => <RepoDetails key={r.repoId} r={r} />)}
        </div>
      )}
    </div>
  );
}

function Reasons(props: { list: Array<{ code: string; message: string }> }) {
  if (!props.list.length) return null;
  return <ul className="fresh-reasons">{props.list.map((x, i) => <li key={i}><code>{x.code}</code> {x.message}</li>)}</ul>;
}

function RepoDetails({ r }: { r: RepoFreshness }) {
  const d = r.branch.default;
  return (
    <section className="fresh-repo">
      <h5>{r.repoId} <span className="muted">{r.repoPath}</span></h5>
      <dl>
        <dt>Snapshot accuracy</dt>
        <dd><b>{r.accuracy.status}</b> — indexed <code>{short(r.accuracy.indexedCommit)}</code>, selected {r.accuracy.selected.rev}
          {r.accuracy.selected.branch && r.accuracy.selected.rev === 'HEAD' ? ` (${r.accuracy.selected.branch})` : ''} = <code>{short(r.accuracy.selected.commit)}</code>
          {r.snapshotTimestamp && <>, indexed at {when(r.snapshotTimestamp)}</>}
          <Reasons list={r.accuracy.reasons} />
          {r.accuracy.status === 'STALE' && <div className="muted">Re-index this revision to analyse it (see the README re-index commands).</div>}
        </dd>
        <dt>Branch currency</dt>
        <dd><b>{r.branch.status}</b>{r.branch.upstream && <> vs {r.branch.upstream} <code>{short(r.branch.upstreamCommit)}</code></>}
          {(r.branch.ahead !== null || r.branch.behind !== null) && <> — ahead {n(r.branch.ahead)}, behind {n(r.branch.behind)}</>}
          {r.branch.asOf && <> (as of {when(r.branch.asOf)})</>}
          <div className="muted">Default branch {d.branch ?? '—'}: {d.relation.toLowerCase()}{d.ahead !== null ? ` (ahead ${n(d.ahead)}, behind ${n(d.behind)})` : ''} — information only.</div>
          <Reasons list={r.branch.reasons} />
        </dd>
        <dt>Remote information</dt>
        <dd><b>{r.remote.status}</b>{r.remote.name && <> — {r.remote.name} {r.remote.url}</>}, as of {when(r.remote.asOf)} (max age {r.remote.maxAgeHours} h)
          {r.remote.lastVerified && r.remote.status !== 'VERIFIED' && <div className="muted">Last verified live {when(r.remote.lastVerified.checkedAt)}.</div>}
          <Reasons list={r.remote.reasons} />
          {r.remote.status === 'UNKNOWN' && <div className="muted">CodeAtlas never fetches. Run <code>git fetch</code> yourself, or use “Check remote now”.</div>}
        </dd>
        <dt>Working tree</dt>
        <dd><b>{r.worktree.status}</b> — {r.worktree.changedInScope} source change(s) in the analyzer scope, {r.worktree.changedOutsideScope} other change(s) ignored
          {r.worktree.warning && <div className="warn-text">{r.worktree.warning}</div>}
          {r.worktree.sample.length > 0 && <ul className="fresh-reasons">{r.worktree.sample.map((p) => <li key={p}><code>{p}</code></li>)}</ul>}
          <Reasons list={r.worktree.reasons} />
        </dd>
      </dl>
    </section>
  );
}
