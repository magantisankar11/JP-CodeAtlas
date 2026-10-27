import type { Resolution } from './api';

export const KIND_COLOR: Record<string, string> = {
  API_ENDPOINT: 'var(--k-endpoint)',
  CONTROLLER: 'var(--k-controller)',
  SERVICE: 'var(--k-service)',
  COMPONENT: 'var(--k-service)',
  REPOSITORY: 'var(--k-repository)',
  INTERFACE: 'var(--k-interface)',
  METHOD: 'var(--k-method)',
  SQL_STATEMENT: 'var(--k-sql)',
  DATABASE_TABLE: 'var(--k-table)',
  DATABASE_PROCEDURE: 'var(--k-table)',
  ENTITY: 'var(--k-entity)',
  DTO: 'var(--k-dto)',
  EXTERNAL_API: 'var(--k-external)',
  CONFIG_PROPERTY: 'var(--k-config)',
  EVENT: 'var(--k-event)',
  UNRESOLVED: 'var(--k-unresolved)',
  UI_ROUTE: 'var(--k-ui-route)',
  UI_COMPONENT: 'var(--k-ui-component)',
  UI_STORE: 'var(--k-ui-component)',
  UI_MODULE: 'var(--k-ui-module)',
  UI_FUNCTION: 'var(--k-ui-module)',
  UI_HTTP_CALL: 'var(--k-ui-http)',
  TEST_CASE: 'var(--k-other)',
};
export const kindColor = (kind: string) => KIND_COLOR[kind] ?? 'var(--k-other)';

export const RESOLUTION_STYLE: Record<Resolution, { stroke: string; dash?: string; label: string; help: string }> = {
  CONFIRMED: { stroke: 'var(--r-confirmed)', label: 'Confirmed', help: 'Compiler binding to exactly one declaration' },
  FRAMEWORK_DERIVED: { stroke: 'var(--r-derived)', dash: '7 4', label: 'Framework-derived', help: 'Spring bean / single implementation / Lombok / mapping rule' },
  AMBIGUOUS: { stroke: 'var(--r-ambiguous)', dash: '2 4', label: 'Ambiguous', help: 'Several candidates; all are shown' },
  UNRESOLVED: { stroke: 'var(--r-unresolved)', dash: '10 3 2 3', label: 'Unresolved', help: 'Target unknown (reflection, dynamic SQL, …)' },
};

export const KIND_LABEL: Record<string, string> = {
  API_ENDPOINT: 'ENDPOINT', SQL_STATEMENT: 'SQL', DATABASE_TABLE: 'TABLE', DATABASE_PROCEDURE: 'PROCEDURE',
  EXTERNAL_API: 'EXTERNAL', CONFIG_PROPERTY: 'CONFIG',
  UI_ROUTE: 'ROUTE', UI_COMPONENT: 'VUE', UI_STORE: 'STORE', UI_MODULE: 'JS', UI_FUNCTION: 'UI FN', UI_HTTP_CALL: 'HTTP CALL', TEST_CASE: 'SPEC',
};

export const RESOLUTION_SHORT: Record<Resolution, string> = {
  CONFIRMED: 'confirmed', FRAMEWORK_DERIVED: 'derived', AMBIGUOUS: 'ambiguous', UNRESOLVED: 'unresolved',
};

/** Method nodes show "Type.method(…)"; everything else its name. */
export function displayName(n: { kind: string; name: string; fqn: string | null; attrs: Record<string, any> }) {
  if (n.kind === 'METHOD' && n.fqn) {
    const [type] = n.fqn.split('#');
    const simple = type!.slice(type!.lastIndexOf('.') + 1);
    return `${simple}.${n.name}()`;
  }
  return n.name;
}
