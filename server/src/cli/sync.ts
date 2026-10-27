import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '../db.js';
import { SyncConfigError } from '../sync/config.js';
import { SyncLockedError } from '../sync/lock.js';
import { renderSyncReport } from '../sync/report.js';
import { syncGraphs, SyncInputError, type SyncReport } from '../sync/run.js';

/**
 * Keeps the current snapshot in step with the repositories' selected revisions (default HEAD); see sync/run.ts.
 *
 *   npm run sync [-- --rev <repoId>=<ref>]... [--reindex <repoId|all>]... [--dry-run] [--json]
 *                [--db FILE] [--config FILE] [--max-shrink 0.5] [--allow-shrink]
 *
 * Exit codes: 0 published or up to date, 1 failed (previous snapshot stays current), 2 usage or configuration error,
 * 3 another sync is running. Never fetches: run `git fetch` first if the remote should be included.
 */
const jciRoot = resolve(import.meta.dirname, '../../..');
let values;
try {
  ({ values } = parseArgs({
    options: {
      db: { type: 'string', default: process.env.JCI_DB ?? join(jciRoot, 'workspace', 'jci.db') },
      config: { type: 'string', default: process.env.JCI_REPOS_CONFIG ?? join(jciRoot, 'config', 'repos.yaml') },
      rev: { type: 'string', multiple: true, default: [] },
      reindex: { type: 'string', multiple: true, default: [] },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'max-shrink': { type: 'string', default: '0.5' },
      'allow-shrink': { type: 'boolean', default: false },
    },
  }));
} catch (e) {
  console.error(`${(e as Error).message}\nusage: npm run sync -- [--rev ID=REF]... [--reindex ID|all]... [--dry-run] [--json] [--db FILE] [--config FILE] [--max-shrink 0.5] [--allow-shrink]`);
  process.exit(2);
}

const revs: Record<string, string> = {};
for (const r of values.rev) {
  const i = r.indexOf('=');
  if (i <= 0 || revs[r.slice(0, i)] !== undefined) {
    console.error(`--rev ${r}: expected <repoId>=<ref>, once per repository`);
    process.exit(2);
  }
  revs[r.slice(0, i)] = r.slice(i + 1);
}
const maxShrink = Number(values['max-shrink']);
if (!(maxShrink > 0 && maxShrink < 1)) {
  console.error('--max-shrink: expected a fraction between 0 and 1 (e.g. 0.5)');
  process.exit(2);
}

const db = openDb(values.db!);
const print = (r: SyncReport) => console.log(values.json ? JSON.stringify(r, null, 2) : renderSyncReport(r));
try {
  const report = await syncGraphs({
    db, jciRoot, graphDirs: [join(jciRoot, 'workspace', 'graphs')], cacheDir: join(jciRoot, 'workspace', 'graphs', 'cache'),
    stateDir: join(jciRoot, 'workspace', 'sync'), configFile: values.config!, revs, reindex: values.reindex, dryRun: values['dry-run'],
    maxShrink, allowShrink: values['allow-shrink'], log: values.json ? (m) => console.error(m) : (m) => console.error(`  ${m}`),
  });
  print(report);
  process.exitCode = report.outcome === 'FAILED' ? 1 : 0;
} catch (e) {
  const report = (e as { report?: SyncReport }).report;
  if (report) print(report);
  else console.error((e as Error).message);
  process.exitCode = e instanceof SyncLockedError ? 3 : e instanceof SyncInputError || e instanceof SyncConfigError ? 2 : 1;
} finally {
  db.close();
}
