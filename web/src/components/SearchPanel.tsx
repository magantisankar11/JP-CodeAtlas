import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
import { api, type CatalogEntry, type ImpactRequest } from '../api';
import { DefectPanel } from './DefectPanel';
import { KIND_LABEL, kindColor } from '../theme';

const METHODS = ['', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY'];

type Tab = 'endpoints' | 'screens' | 'entry' | 'data' | 'external' | 'types' | 'config' | 'defect';
const TABS: Array<[Tab, string]> = [
  ['endpoints', 'Endpoints'], ['screens', 'Screens'], ['entry', 'Jobs & events'], ['data', 'Data'], ['external', 'Integrations'], ['types', 'Types'], ['config', 'Config'], ['defect', 'Defect'],
];

type Pick = (id: string, kind: string) => void;

export function SearchPanel(props: { snapshotId?: number; activeRoot: string | null; onPick: Pick; onAnalyze: (req: ImpactRequest) => void }) {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>('endpoints');
  const query = useDeferredValue(q.trim());

  const hits = useQuery({
    queryKey: ['search', props.snapshotId, query],
    queryFn: () => api.search(props.snapshotId, query),
    enabled: props.snapshotId !== undefined && query.length >= 2,
  });

  return (
    <aside className="side">
      <div className="search">
        <input placeholder="Search endpoint, class, method, table, file…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{label}</button>
        ))}
      </div>
      <div className="list">
        {query.length >= 2 && (
          <>
            <div className="section"><span>Search results</span>{hits.isFetching && <span>…</span>}</div>
            {hits.error && <div className="item error">{(hits.error as Error).message}</div>}
            {hits.data?.data.length === 0 && <div className="item note">No matches</div>}
            {hits.data?.data.map((h) => (
              <div key={h.id} className={`item ${props.activeRoot === h.id ? 'active' : ''}`} onClick={() => props.onPick(h.id, h.kind)} title={h.id}>
                <span className="badge" style={{ color: kindColor(h.kind) }}>{KIND_LABEL[h.kind] ?? h.kind}</span>
                <span className="name">{h.name}</span>
              </div>
            ))}
          </>
        )}
        {tab === 'defect' && <DefectPanel snapshotId={props.snapshotId} onAnalyze={props.onAnalyze} onPick={props.onPick} />}
        {tab === 'endpoints' && <Endpoints {...props} filter={query} />}
        {tab === 'screens' && (
          <>
            <CatalogList {...props} filter={query} params={{ kind: 'UI_ROUTE' }} title="UI routes"
              meta={(n) => String(n.attrs.component ?? '').split('/').pop() ?? ''} />
            <CatalogList {...props} filter={query} params={{ kind: 'UI_HTTP_CALL' }} title="UI HTTP calls"
              meta={(n) => (n.outgoing.CALLS_API ? `→ ${n.outgoing.CALLS_API} endpoint${n.outgoing.CALLS_API === 1 ? '' : 's'}` : 'not linked')}
              flags={(n) => [n.attrs.resolved ? '' : 'dynamic URL', n.attrs.variants ? 'conditional' : ''].filter(Boolean)} />
          </>
        )}
        {tab === 'entry' && <CatalogList {...props} filter={query} params={{ entryPoints: true }} title="Scheduled jobs, listeners, startup"
          meta={(n) => String(n.attrs.entryPoint).toLowerCase().replace(/_/g, ' ')} />}
        {tab === 'data' && (
          <>
            <CatalogList {...props} filter={query} params={{ kind: 'DATABASE_TABLE' }} title="Tables"
              meta={(n) => `R ${n.incoming.READS ?? 0} · W ${n.incoming.WRITES ?? 0}${n.incoming.MAPS_TO ? ' · entity' : ''}`}
              flags={(n) => [n.attrs.inCatalog === false ? 'not in migrations' : '', n.attrs.dropped ? 'dropped' : ''].filter(Boolean)} />
            <CatalogList {...props} filter={query} params={{ kind: 'DATABASE_PROCEDURE' }} title="Stored procedures"
              meta={(n) => `called ${n.incoming.INVOKES_PROCEDURE ?? 0}`} />
          </>
        )}
        {tab === 'external' && <CatalogList {...props} filter={query} params={{ kind: 'EXTERNAL_API' }} title="Outbound calls"
          meta={(n) => `${n.incoming.CALLS_EXTERNAL ?? 0} caller${(n.incoming.CALLS_EXTERNAL ?? 0) === 1 ? '' : 's'}`}
          flags={(n) => [n.id.startsWith('external:http:?') ? 'URL unresolved' : '', n.attrs.urlProperty ? 'from config' : ''].filter(Boolean)} />}
        {tab === 'types' && (
          <>
            <CatalogList {...props} filter={query} params={{ kind: 'DTO' }} title="DTOs (API contracts)"
              meta={(n) => `${(n.incoming.ACCEPTS ?? 0) + (n.incoming.RETURNS ?? 0)} endpoint refs · ${n.incoming.USES_TYPE ?? 0} methods`} />
            <CatalogList {...props} filter={query} params={{ kind: 'ENTITY' }} title="JPA entities"
              meta={(n) => `${n.incoming.USES_TYPE ?? 0} methods`} />
          </>
        )}
        {tab === 'config' && <CatalogList {...props} filter={query} params={{ kind: 'CONFIG_PROPERTY' }} title="Configuration keys read by code"
          meta={(n) => `${n.incoming.READS_CONFIG ?? 0} readers`}
          flags={(n) => (n.attrs.defined === false ? ['not defined in property files'] : [])} />}
      </div>
    </aside>
  );
}

function Endpoints(props: { snapshotId?: number; activeRoot: string | null; onPick: Pick; filter: string }) {
  const [method, setMethod] = useState('');
  const eps = useQuery({
    queryKey: ['endpoints', props.snapshotId, method],
    queryFn: () => api.endpoints(props.snapshotId, method || undefined),
    enabled: props.snapshotId !== undefined,
  });
  const f = props.filter.toLowerCase();
  const list = (eps.data?.data ?? []).filter((e) => !f || e.name.toLowerCase().includes(f));
  return (
    <>
      <div className="section">
        <span>Endpoints {list.length}</span>
        <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="HTTP method">
          {METHODS.map((m) => <option key={m} value={m}>{m || 'All methods'}</option>)}
        </select>
      </div>
      {eps.error && <div className="item error">{(eps.error as Error).message}</div>}
      {list.map((e) => (
        <div key={e.id} className={`item ${props.activeRoot === e.id ? 'active' : ''}`} onClick={() => props.onPick(e.id, e.kind)} title={String(e.attrs.handler)}>
          <span className="badge mono" style={{ color: kindColor('API_ENDPOINT') }}>{String(e.attrs.httpMethod)}</span>
          <span className="name mono">{String(e.attrs.path)}</span>
          {e.attrs.security?.rule === 'permitAll' && <span className="flag" title="Spring Security permitAll">public</span>}
        </div>
      ))}
    </>
  );
}

function CatalogList(props: {
  snapshotId?: number; activeRoot: string | null; onPick: Pick; filter: string; title: string;
  params: { kind?: string; entryPoints?: boolean }; meta: (n: CatalogEntry) => string; flags?: (n: CatalogEntry) => string[];
}) {
  const res = useQuery({
    queryKey: ['catalog', props.snapshotId, props.params],
    queryFn: () => api.catalog(props.snapshotId, props.params),
    enabled: props.snapshotId !== undefined,
  });
  const f = props.filter.toLowerCase();
  const list = (res.data?.data ?? []).filter((n) => !f || n.name.toLowerCase().includes(f) || (n.fqn ?? '').toLowerCase().includes(f));
  return (
    <>
      <div className="section"><span>{props.title}</span><span>{res.isFetching ? '…' : list.length}</span></div>
      {res.error && <div className="item error">{(res.error as Error).message}</div>}
      {list.map((n) => (
        <div key={n.id} className={`item ${props.activeRoot === n.id ? 'active' : ''}`} onClick={() => props.onPick(n.id, n.kind)} title={n.fqn ?? n.id}>
          <span className="name">{n.kind === 'METHOD' && n.fqn ? `${n.fqn.split('#')[0]!.split('.').pop()}.${n.name}()` : n.name}</span>
          {props.flags?.(n).map((fl) => <span key={fl} className="flag">{fl}</span>)}
          <span className="meta">{props.meta(n)}</span>
        </div>
      ))}
    </>
  );
}
