import { useQuery } from '@tanstack/react-query';
import { api, locateFile, type EdgeDto, type Evidence, type GraphResult, type NodeDto, type SnapshotDto } from '../api';
import { displayName, KIND_LABEL, kindColor, RESOLUTION_STYLE } from '../theme';

export type Selection = { type: 'node'; id: string } | { type: 'edge'; id: string };

type Reroot = (id: string, kind?: string) => void;

export function DetailsPanel(props: {
  snapshotId?: number; snapshot?: SnapshotDto; repoPath: string | null; commitSha: string; selection: Selection | null; graph: GraphResult | null;
  onSelect: (s: Selection) => void; onReroot: Reroot; onImpact: (id: string, name: string) => void;
}) {
  const { selection, snapshotId } = props;
  if (!selection) {
    return <aside className="details"><p className="note">Select a node or edge to see its metadata, contract and source.</p></aside>;
  }
  return (
    <aside className="details">
      {selection.type === 'node'
        ? <NodeDetails snapshotId={snapshotId} snapshot={props.snapshot} repoPath={props.repoPath} commitSha={props.commitSha} id={selection.id} onSelect={props.onSelect} onReroot={props.onReroot} onImpact={props.onImpact} />
        : <EdgeDetails snapshotId={snapshotId} edge={props.graph?.edges.find((e) => e.id === selection.id)} onSelect={props.onSelect} />}
    </aside>
  );
}

/** vscode:// link to the working tree; it may differ from the analysed commit, which the panel's source view shows. */
function EditorLink({ snapshot, file, line }: { snapshot?: SnapshotDto; file: string; line: number }) {
  const { repoPath, commitSha, path } = locateFile(snapshot, file);
  if (!repoPath) return null;
  const href = `vscode://file/${repoPath.replace(/\\/g, '/')}/${path}:${line}`;
  return (
    <a href={href} title={`Opens your working tree, which may differ from ${commitSha.slice(0, 10)}`}>Open in VS Code ↗</a>
  );
}

function NodeDetails(props: {
  snapshotId?: number; snapshot?: SnapshotDto; repoPath: string | null; commitSha: string; id: string; onSelect: (s: Selection) => void; onReroot: Reroot;
  onImpact: (id: string, name: string) => void;
}) {
  const q = useQuery({ queryKey: ['node', props.snapshotId, props.id], queryFn: () => api.node(props.snapshotId, props.id) });
  if (q.isLoading) return <p className="note">Loading…</p>;
  if (q.error) return <p className="error">{(q.error as Error).message}</p>;
  const { node, incoming, outgoing } = q.data!.data;
  const a = node.attrs;
  return (
    <>
      <span className="badge" style={{ color: kindColor(node.kind) }}>{KIND_LABEL[node.kind] ?? node.kind}</span>
      <h2>{displayName(node)}</h2>
      <div className="mono note" style={{ wordBreak: 'break-all' }}>{node.id}</div>
      <p style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="btn" onClick={() => props.onReroot(node.id, node.kind)}>Use as graph root</button>
        <button className="btn primary" onClick={() => props.onImpact(node.id, displayName(node))}>Impact report</button>
        {node.filePath && node.lineStart ? <EditorLink snapshot={props.snapshot} file={node.filePath} line={node.lineStart} /> : null}
      </p>
      <div className="kv">
        {node.signature && (<><div>Signature</div><div className="mono">{node.signature}</div></>)}
        {node.filePath && (<><div>Source</div><div className="mono">{node.filePath}:{node.lineStart}{node.lineEnd && node.lineEnd !== node.lineStart ? `-${node.lineEnd}` : ''}</div></>)}
        {a.entryPoint && (<><div>Entry point</div><div>{String(a.entryPoint).toLowerCase().replace(/_/g, ' ')}{a.entryPointDetail ? <span className="mono"> {JSON.stringify(a.entryPointDetail)}</span> : null}</div></>)}
        {a.contractRole && (<><div>Contract role</div><div className="mono">{String(a.contractRole).replace('NESTED_IN:', 'nested in ')}</div></>)}
        {a.beanFactory && (<><div>Bean factory</div><div className="mono">{String(a.beanFactory).replace('method:', '')}</div></>)}
        {a.feignClient && (<><div>Feign client</div><div className="mono">{a.feignClient} {a.feignUrlProperty ? `(url from \${${a.feignUrlProperty}})` : a.feignUrl ? `(${a.feignUrl})` : ''}</div></>)}
        <div>In scope</div><div>{node.inScope ? 'yes' : 'no (outgoing calls not extracted)'}</div>
        {Array.isArray(a.annotations) && a.annotations.length > 0 && (<><div>Annotations</div><div className="mono">{a.annotations.map((x: string) => `@${x}`).join(' ')}</div></>)}
        {a.beanName && (<><div>Spring bean</div><div className="mono">{a.beanName}{a.primary ? ' (@Primary)' : ''}</div></>)}
        {a.transactional && (<><div>Transactional</div><div>yes</div></>)}
        {a.async && (<><div>Async</div><div>yes (@Async)</div></>)}
        {a.lombok && (<><div>Lombok</div><div>generated {String(a.lombok).toLowerCase()} (synthesized; evidence points at the field)</div></>)}
        {a.scheduled && (<><div>Scheduled</div><div className="mono">{JSON.stringify(a.scheduled)}</div></>)}
        {a.table && (<><div>Table</div><div className="mono">{a.table}</div></>)}
      </div>
      {node.kind === 'API_ENDPOINT' && <Contract node={node} />}
      {node.kind === 'SQL_STATEMENT' && <SqlDetails node={node} />}
      {node.kind === 'DATABASE_TABLE' && <TableDetails node={node} />}
      {node.kind === 'EXTERNAL_API' && <ExternalDetails node={node} />}
      {node.kind === 'CONFIG_PROPERTY' && (
        <>
          <h3>Configuration key</h3>
          <p className="note">Only key names and where they are defined are indexed; values are never read.</p>
          <div className="kv">
            <div>Defined in</div><div className="mono">{(a.definedIn ?? []).join('\n') || (a.prefix ? 'prefix binding' : 'not found in indexed property files')}</div>
          </div>
        </>
      )}
      {Array.isArray(a.fields) && a.fields.length > 0 && (
        <>
          <h3>Fields ({a.fields.length})</h3>
          <table className="params">
            <tbody>
              {a.fields.map((f: { name: string; type: string; annotations?: string[] }) => (
                <tr key={f.name}><td className="mono">{f.name}</td><td className="mono">{simplify(f.type)}</td><td className="mono">{(f.annotations ?? []).map((x) => `@${x}`).join(' ')}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {node.kind === 'UNRESOLVED' && <p className="note">Reason: <strong>{String(a.reason)}</strong> — {String(a.hint ?? '')}. The target cannot be determined statically.</p>}
      <EdgeList title="Outgoing" edges={outgoing} self={node.id} onSelect={props.onSelect} />
      <EdgeList title="Incoming" edges={incoming} self={node.id} onSelect={props.onSelect} />
      {node.filePath && node.lineStart ? (
        <>
          <h3>Source @ snapshot commit</h3>
          <Source snapshotId={props.snapshotId} file={node.filePath} from={node.lineStart} to={Math.min(node.lineEnd ?? node.lineStart, node.lineStart + 60)} />
        </>
      ) : null}
    </>
  );
}

function Contract({ node }: { node: NodeDto }) {
  const a = node.attrs;
  const params = (a.params ?? []) as Array<Record<string, any>>;
  return (
    <>
      <h3>Request / response contract</h3>
      <div className="kv">
        <div>Method</div><div className="mono">{a.httpMethod}</div>
        <div>Path</div><div className="mono">{a.path}{a.pathResolved === false ? ' (partly unresolved)' : ''}</div>
        <div>Handler</div><div className="mono" style={{ wordBreak: 'break-all' }}>{String(a.handler).replace('method:', '')}</div>
        <div>Response</div><div className="mono">{a.responseType}</div>
        {a.requestBody && (<><div>Request body</div><div className="mono">{a.requestBody.type}{a.requestBody.validated ? ' (@Valid)' : ''}</div></>)}
        {a.consumes && (<><div>Consumes</div><div className="mono">{a.consumes.join(', ')}</div></>)}
        {a.produces && (<><div>Produces</div><div className="mono">{a.produces.join(', ')}</div></>)}
        {a.declaredExceptions?.length > 0 && (<><div>Throws</div><div className="mono">{a.declaredExceptions.join(', ')}</div></>)}
      </div>
      {params.length > 0 && (
        <table className="params">
          <thead><tr><th>Name</th><th>Source</th><th>Type</th><th>Req.</th></tr></thead>
          <tbody>
            {params.map((p, i) => (
              <tr key={i}>
                <td className="mono">{p.name}</td>
                <td>{p.source}{p.implicit ? '*' : ''}</td>
                <td className="mono">{String(p.type).replace(/\b(?:[a-z_][a-z0-9_]*\.)+([A-Z])/g, '$1')}</td>
                <td>{p.required === undefined ? '' : p.required ? 'yes' : 'no'}{p.validated ? ' @Valid' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Security (URL rules)</h3>
      {a.security ? (
        <div className="kv">
          <div>Rule</div><div className="mono">{a.security.rule}{a.security.args?.length ? `(${a.security.args.join(', ')})` : ''}</div>
          {a.security.matcher && (<><div>Matched by</div><div className="mono">{a.security.matcher}</div></>)}
          {a.security.file && (<><div>Defined at</div><div className="mono">{a.security.file}:{a.security.line}</div></>)}
          {a.security.mayAlsoMatchEarlier && (<><div>Caution</div><div>An earlier rule may match some values of the path variables: <span className="mono">{a.security.mayAlsoMatchEarlier}</span></div></>)}
          {a.fullPath && (<><div>Full path</div><div className="mono">{a.fullPath}</div></>)}
        </div>
      ) : <p className="note">No SecurityFilterChain rules found.</p>}
      <p className="note">Method-level checks inside services (e.g. Casbin enforce calls) are runtime policy and are not shown here.</p>
    </>
  );
}

const simplify = (t: string) => String(t).replace(/\b(?:[a-z_][a-z0-9_]*\.)+([A-Z])/g, '$1');

function TableDetails({ node }: { node: NodeDto }) {
  const a = node.attrs;
  const derived = new Set<string>(a.columnsFromPreparedDdl ?? []);
  return (
    <>
      <h3>Table</h3>
      <div className="kv">
        <div>Source</div><div>{a.inCatalog ? 'migration scripts' : `only referenced by code (${String(a.source).toLowerCase().replace(/_/g, ' ')}); not defined in the indexed migrations`}</div>
        {a.dropped && (<><div>Status</div><div>dropped by a later migration</div></>)}
        {a.columnsKnown === false && (<><div>Columns</div><div>not parsed (unsupported DDL)</div></>)}
        {a.alteredByProcedureCalls?.length > 0 && (<><div>Caution</div><div>Passed to stored procedures that may alter it: <span className="mono">{a.alteredByProcedureCalls.join('\n')}</span></div></>)}
      </div>
      {Array.isArray(a.columns) && a.columns.length > 0 && (
        <table className="params">
          <thead><tr><th>Column</th><th>Type</th></tr></thead>
          <tbody>
            {a.columns.map((c: { name: string; type: string }) => (
              <tr key={c.name}><td className="mono">{c.name}{derived.has(c.name) ? ' *' : ''}</td><td className="mono">{c.type}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {derived.size > 0 && <p className="note">* added by prepared-statement DDL evaluated from literal variables</p>}
    </>
  );
}

function ExternalDetails({ node }: { node: NodeDto }) {
  const a = node.attrs;
  return (
    <>
      <h3>External call</h3>
      <div className="kv">
        <div>Protocol</div><div>{a.protocol}{a.client ? ` (${a.client})` : ''}{a.service ? ` · ${a.service}` : ''}</div>
        {a.httpMethod && (<><div>Method</div><div className="mono">{a.httpMethod}</div></>)}
        {a.url && (<><div>URL</div><div className="mono">{a.url}</div></>)}
        {a.urlProperty && (<><div>URL from</div><div className="mono">{'${' + a.urlProperty + '}'}{a.path ? a.path : ''} (value not read)</div></>)}
        {a.path && !a.urlProperty && (<><div>Path</div><div className="mono">{a.path}</div></>)}
        {a.operation && (<><div>Operation</div><div className="mono">{a.clientType}#{a.operation}</div></>)}
        {a.fragments && (<><div>URL</div><div><span className="mono">{a.fragments.join('')}</span> <span className="note">(built at runtime: {a.reason})</span></div></>)}
      </div>
    </>
  );
}

function SqlDetails({ node }: { node: NodeDto }) {
  const a = node.attrs;
  return (
    <>
      <h3>SQL ({a.api})</h3>
      {a.resolved
        ? <pre className="src" style={{ padding: 8, whiteSpace: 'pre-wrap' }}>{a.sql}</pre>
        : (
          <>
            <p className="note">Built at runtime, so the executed text is unknown and no tables are derived from it. Literal fragments:</p>
            <pre className="src" style={{ padding: 8, whiteSpace: 'pre-wrap' }}>{(a.fragments ?? []).join('')}</pre>
            <p className="note">Reason: <span className="mono">{a.reason}</span></p>
          </>
        )}
      {a.parseError && <p className="note">Parser could not read this SQL ({a.parseError}); tables not derived.</p>}
    </>
  );
}

function EdgeList(props: { title: string; edges: EdgeDto[]; self: string; onSelect: (s: Selection) => void }) {
  const edges = props.edges.filter((e) => e.kind !== 'DECLARES' || props.title === 'Incoming');
  if (!edges.length) return null;
  return (
    <>
      <h3>{props.title} ({edges.length})</h3>
      {edges.slice(0, 50).map((e) => {
        const other = e.src === props.self ? e.dst : e.src;
        return (
          <div key={e.id} className="edge-row" onClick={() => props.onSelect({ type: 'edge', id: e.id })} title={other}>
            <span className="res" style={{ color: RESOLUTION_STYLE[e.resolution].stroke }}>{e.kind}</span>{' '}
            <span className="mono">{other.replace(/^(method|type):/, '').replace(/^.*\.(?=[A-Z][^.]*#)/, '')}</span>
          </div>
        );
      })}
    </>
  );
}

function EdgeDetails(props: { snapshotId?: number; edge?: EdgeDto; onSelect: (s: Selection) => void }) {
  const e = props.edge;
  if (!e) return <p className="note">Edge not in the current graph.</p>;
  const st = RESOLUTION_STYLE[e.resolution];
  const a = e.attrs;
  const sqlKind = ['QUERIES', 'READS', 'WRITES'].includes(e.kind);
  const KIND_HELP: Record<string, string> = {
    EXPOSES: 'Spring MVC mapping annotation on the handler method',
    INJECTS: 'Spring injection point (field / constructor)',
    ACCEPTS: 'Type appears in the endpoint handler’s parameters',
    RETURNS: 'Type appears in the endpoint handler’s return type',
    HAS_FIELD_TYPE: 'Field declared with this type (including generic arguments)',
    USES_TYPE: 'Method references this type in its signature or body',
    MAPS_TO: 'JPA entity mapped to the table (@Table or naming strategy)',
    CALLS_EXTERNAL: 'Call leaving the application (HTTP client, Feign, SDK)',
    SCHEDULES: 'Method handed to the job scheduler (runs later, asynchronously)',
    PUBLISHES: 'Spring application event published',
    TRIGGERS: 'Event delivered to an @EventListener',
    THROWS: 'throw statement or throws clause',
    HANDLES_EXCEPTION: '@ExceptionHandler for this exception type',
    READS_CONFIG: 'Configuration key read via @Value, @ConfigurationProperties or Environment',
    INVOKES_PROCEDURE: 'Stored procedure call parsed from the SQL text',
  };
  const help = sqlKind
    ? ({
      CONFIRMED: 'SQL text fully known at compile time and issued through a recognised SQL API; tables come from the SQL parser',
      FRAMEWORK_DERIVED: a.inAllVariants !== undefined || a.variantExpansion
        ? 'SQL assembled by conditional appends: every possible variant was enumerated and parsed'
        : 'SQL text fully known, but the SQL API was recognised by method name only (or tables mapped via JPA entities)',
      AMBIGUOUS: st.help,
      UNRESOLVED: 'SQL is built at runtime; no tables are derived from it',
    } as const)[e.resolution]
    : KIND_HELP[e.kind] ?? st.help;
  return (
    <>
      <span className="badge">{e.kind}</span>
      <h2 style={{ color: st.stroke }}>{st.label}</h2>
      <p className="note">{help}</p>
      <div className="kv">
        <div>From</div><div className="mono" style={{ cursor: 'pointer' }} onClick={() => props.onSelect({ type: 'node', id: e.src })}>{e.src}</div>
        <div>To</div><div className="mono" style={{ cursor: 'pointer' }} onClick={() => props.onSelect({ type: 'node', id: e.dst })}>{e.dst}</div>
        {a.dispatchRule && (<><div>Dispatch rule</div><div className="mono">{a.dispatchRule}</div></>)}
        {a.viaDispatch && (<><div>Static target</div><div className="mono">{a.viaDispatch}</div></>)}
        {a.reason && (<><div>Reason</div><div className="mono">{a.reason}</div></>)}
        {Array.isArray(a.candidates) && (<><div>Candidates</div><div className="mono">{a.candidates.join('\n')}</div></>)}
        {a.inAllVariants !== undefined && (<><div>SQL variants</div><div>{a.inAllVariants ? 'table used in every variant' : `table used in ${a.variantCount} variant(s) only (conditional)`}</div></>)}
        {e.kind === 'MAPS_TO' && Array.isArray(a.columns) && (
          <><div>Columns</div><div className="mono">{a.columns.map((c: { field: string; column: string }) => `${c.field} → ${c.column}`).join('\n')}</div></>
        )}
        {a.columnsNotInCatalog?.length > 0 && (<><div>Mismatch</div><div className="mono error">{a.columnsNotInCatalog.join(', ')} not defined by migrations</div></>)}
        {a.columnsUnverified?.length > 0 && (<><div>Unverified</div><div className="mono">{a.columnsUnverified.join(', ')} (table altered by stored procedures)</div></>)}
        <div>Call sites</div><div>{a.siteCount ?? e.evidence.length}{a.conditional ? ' · conditional' : ''}{a.inLoop ? ' · in loop' : ''}{a.inCatch ? ' · in catch' : ''}{a.inLambda ? ' · in lambda' : ''}{a.async ? ' · async' : ''}{a.methodRef ? ' · method reference' : ''}</div>
      </div>
      <h3>Evidence</h3>
      {e.evidence.map((ev, i) => <EvidenceView key={i} snapshotId={props.snapshotId} ev={ev} />)}
    </>
  );
}

function EvidenceView({ snapshotId, ev }: { snapshotId?: number; ev: Evidence }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="mono note">{ev.filePath}:{ev.line} · rule {ev.rule}{ev.resolution ? ` · ${ev.resolution}` : ''}</div>
      {ev.filePath && ev.line > 0 && <Source snapshotId={snapshotId} file={ev.filePath} from={ev.line} to={ev.endLine ?? ev.line} />}
    </div>
  );
}

function Source(props: { snapshotId?: number; file: string; from: number; to: number }) {
  const q = useQuery({
    queryKey: ['src', props.snapshotId, props.file, props.from, props.to],
    queryFn: () => api.source(props.snapshotId, props.file, props.from, props.to),
  });
  if (q.isLoading) return <p className="note">Loading source…</p>;
  if (q.error) return <p className="error">{(q.error as Error).message}</p>;
  const x = q.data!.data;
  return (
    <pre className="src">
      {x.lines.map((l) => (
        <div key={l.n} className={`ln ${l.n >= props.from && l.n <= props.to ? 'hl' : ''}`}><span className="n">{l.n}</span><span>{l.text}</span></div>
      ))}
    </pre>
  );
}
