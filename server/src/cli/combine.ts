import { parseArgs } from 'node:util';
import { combineGraphs } from '../multi/combine.js';

/**
 *   npm run combine -- --core ../workspace/graphs/justperform-core-full.ndjson --ui ../workspace/graphs/justperform-ui.ndjson
 *                      --out ../workspace/graphs/justperform-system.ndjson [--core-base process.env.JP_API]...
 *
 * See multi/combine.ts: one system snapshot from a Core graph and a UI graph, with UI → API links.
 */
const { values } = parseArgs({
  options: {
    core: { type: 'string' },
    ui: { type: 'string' },
    out: { type: 'string' },
    'system-id': { type: 'string', default: 'justperform-system' },
    'core-base': { type: 'string', multiple: true, default: ['process.env.JP_API'] },
  },
});
if (!values.core || !values.ui || !values.out) {
  console.error('usage: combine --core CORE.ndjson --ui UI.ndjson --out SYSTEM.ndjson [--system-id ID] [--core-base EXPR]...');
  process.exit(2);
}
const r = await combineGraphs(values.core, values.ui, values.out, { systemId: values['system-id'], coreBases: values['core-base'] });
console.log(JSON.stringify(r, null, 2));
