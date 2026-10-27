import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '../db.js';
import { loadNdjson } from '../loader.js';

/** Loads graphs and makes each one current for its repository, unless --no-publish (see snapshots.ts). */
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: 'string', default: process.env.JCI_DB ?? resolve(import.meta.dirname, '../../../workspace/jci.db') },
    'repo-path': { type: 'string' },
    'no-publish': { type: 'boolean', default: false },
  },
});

if (!positionals.length) {
  console.error('usage: npm run load -- <graph.ndjson> [--repo-path DIR] [--db FILE] [--no-publish]');
  process.exit(2);
}
const db = openDb(values.db!);
for (const file of positionals) {
  const r = await loadNdjson(db, resolve(file), { repoPath: values['repo-path'], publish: !values['no-publish'] });
  console.log(`${r.replaced ? 'replaced' : 'loaded'} snapshot ${r.snapshotId}: ${r.repoId}@${r.commitSha.slice(0, 12)} `
    + `(${r.nodes} nodes, ${r.edges} edges, ${r.diagnostics} diagnostics) into ${values.db}${values['no-publish'] ? '' : ' (current)'}`);
}
db.close();
