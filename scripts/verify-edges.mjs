// Verifies analyzer edges against the exact source revision they claim to come from.
//  1. Automated, all CALLS edges: the callee's name must occur in the cited line range (read via `git show sha:path`).
//  2. Seeded random sample printed side by side (call site, callee declaration) for manual review.
// Usage: node scripts/verify-edges.mjs <graph.ndjson> <repo-dir> [sampleSize=30] [seed=42]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [file, repo, sampleArg = '30', seedArg = '42'] = process.argv.slice(2);
const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const snap = lines[0];
const nodes = new Map(lines.filter((l) => l.type === 'node').map((n) => [n.id, n]));
const calls = lines.filter((l) => l.type === 'edge' && l.kind === 'CALLS' && l.dst.startsWith('method:'));

const cache = new Map();
function source(path) {
  if (!cache.has(path)) {
    const text = snap.commitSha.startsWith('nogit-')
      ? readFileSync(`${repo}/${path}`, 'utf8')
      : execFileSync('git', ['--no-optional-locks', '-C', repo, 'show', `${snap.commitSha}:${path}`], { encoding: 'utf8', maxBuffer: 64 << 20 });
    cache.set(path, text.split(/\r?\n/));
  }
  return cache.get(path);
}
const calleeToken = (dst) => {
  const name = dst.slice(dst.indexOf('#') + 1, dst.indexOf('('));
  if (name !== '<init>') return name;
  const type = dst.slice('method:'.length, dst.indexOf('#'));
  return type.slice(type.lastIndexOf('.') + 1);
};

let checked = 0;
const failures = [];
for (const e of calls) {
  for (const ev of e.evidence) {
    if (!ev.filePath || ev.line < 1) continue;
    checked++;
    const src = source(ev.filePath);
    const text = src.slice(ev.line - 1, Math.max(ev.line, ev.endLine ?? ev.line)).join('\n');
    // Constructors are also invoked by this(..)/super(..) delegation and by enum constants such as ACTIVE(1, "x").
    const ctorForm = e.dst.includes('#<init>(') && (/\b(this|super)\s*\(/.test(text) || /^\s*[A-Z][A-Z0-9_]*\s*\(/m.test(text));
    if (!text.includes(calleeToken(e.dst)) && !ctorForm) failures.push(`${ev.filePath}:${ev.line} lacks '${calleeToken(e.dst)}' for ${e.dst}`);
  }
}
const byRes = {};
for (const e of calls) byRes[e.resolution] = (byRes[e.resolution] ?? 0) + 1;
console.log(`snapshot ${snap.repoId}@${snap.commitSha}`);
console.log(`CALLS edges: ${calls.length} ${JSON.stringify(byRes)}`);
console.log(`evidence sites checked: ${checked}, text mismatches: ${failures.length}`);
failures.slice(0, 20).forEach((f) => console.log('  MISMATCH', f));

// Seeded sample (mulberry32), stratified by resolution, in-scope callers only.
let seed = Number(seedArg);
const rnd = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const want = Number(sampleArg);
const quota = { CONFIRMED: Math.round(want * 0.5), FRAMEWORK_DERIVED: Math.round(want * 0.4), AMBIGUOUS: want, UNRESOLVED: want };
const pool = calls.filter((e) => nodes.get(e.src)?.inScope).sort(() => rnd() - 0.5);
const picked = [];
for (const r of ['CONFIRMED', 'FRAMEWORK_DERIVED', 'AMBIGUOUS', 'UNRESOLVED']) {
  picked.push(...pool.filter((e) => e.resolution === r).slice(0, quota[r]));
}
console.log(`\n--- manual review sample (${Math.min(picked.length, want)}) ---`);
for (const [i, e] of picked.slice(0, want).entries()) {
  const ev = e.evidence[0];
  const callee = nodes.get(e.dst);
  const site = source(ev.filePath).slice(ev.line - 1, Math.max(ev.line, ev.endLine ?? ev.line)).map((s) => s.trim()).join(' ').slice(0, 220);
  const decl = callee?.filePath && callee.lineStart > 0 ? source(callee.filePath)[callee.lineStart - 1]?.trim().slice(0, 160) : '(synthesized: ' + (callee?.attrs?.lombok ?? '?') + ')';
  console.log(`\n#${i + 1} ${e.resolution} rule=${ev.rule}${e.attrs.dispatchRule ? '/' + e.attrs.dispatchRule : ''}`);
  console.log(`  caller : ${e.src.replace('method:', '')}`);
  console.log(`  callee : ${e.dst.replace('method:', '')}`);
  console.log(`  site   : ${ev.filePath.split('/').pop()}:${ev.line}  ${site}`);
  console.log(`  decl   : ${callee?.filePath?.split('/').pop() ?? '?'}:${callee?.lineStart ?? '?'}  ${decl}`);
}
process.exitCode = failures.length ? 1 : 0;
