import { execFileSync } from 'node:child_process';
import type { DB } from '../db.js';
import { search, toNode, type NodeRow } from '../query.js';
import { readAtCommit, reposOf } from '../source.js';
import type { SnapshotInfo } from './engine.js';
import type { DefectCandidate, MatchStrength, RootCauseCandidate } from './types.js';

/**
 * Maps defect text (Jira summary, description, comments, logs) to graph nodes. Each candidate states why it matched.
 * Strength: EXACT (stack frame, URL path, table, fully-qualified name) > STRONG (exact identifier/exception name)
 * > TEXT (quoted message found in source at the commit) > WEAK (keyword search). WEAK candidates are suggestions only.
 */
export interface DefectMatch {
  signals: { stackFrames: number; paths: string[]; identifiers: string[]; exceptions: string[]; tables: string[]; messages: string[]; keywords: string[] };
  candidates: DefectCandidate[];
}

const ORDER: MatchStrength[] = ['EXACT', 'STRONG', 'TEXT', 'WEAK'];
/** Function words only: domain words such as "user" or "data" matter inside identifiers. */
const PHRASE_STOP = new Set(['the', 'and', 'for', 'with', 'does', 'not', 'are', 'was', 'from', 'into', 'when', 'that', 'this']);
const STOP = new Set(['the', 'and', 'for', 'with', 'when', 'from', 'this', 'that', 'not', 'are', 'was', 'were', 'have', 'has', 'should', 'error',
  'issue', 'bug', 'user', 'users', 'after', 'before', 'into', 'able', 'unable', 'getting', 'while', 'data', 'page', 'value', 'values', 'click', 'button']);

export function matchDefect(db: DB, snap: SnapshotInfo, text: string): DefectMatch {
  const sid = snap.id;
  const out = new Map<string, DefectCandidate>();
  const add = (row: NodeRow | undefined, strength: MatchStrength, reason: string) => {
    if (!row) return;
    const n = toNode(row);
    const prev = out.get(n.id);
    if (prev) {
      if (ORDER.indexOf(strength) < ORDER.indexOf(prev.strength)) prev.strength = strength;
      if (!prev.reasons.includes(reason)) prev.reasons.push(reason);
      return;
    }
    out.set(n.id, { nodeId: n.id, kind: n.kind, name: n.kind === 'METHOD' && n.fqn ? `${n.fqn.split('#')[0]!.split('.').pop()}.${n.name}()` : n.name, strength, reasons: [reason], file: n.filePath, line: n.lineStart });
  };
  const one = (sql: string, ...args: unknown[]) => db.prepare(sql).get(sid, ...args) as NodeRow | undefined;
  const many = (sql: string, ...args: unknown[]) => db.prepare(sql).all(sid, ...args) as NodeRow[];

  // Stack frames: at com.x.Foo$Bar.method(Foo.java:123)
  let frames = 0;
  for (const m of text.matchAll(/at\s+([\w.$]+)\.([\w$<>]+)\(([\w$]+\.java):(\d+)\)/g)) {
    frames++;
    const type = m[1]!.replace(/\$/g, '.');
    const line = Number(m[4]);
    const exact = one(`SELECT * FROM nodes WHERE snapshot_id = ? AND kind = 'METHOD' AND fqn = ? AND line_start <= ? AND line_end >= ? LIMIT 1`, `${type}#${m[2]}`, line, line);
    if (exact) add(exact, 'EXACT', `stack frame ${m[3]}:${line}`);
    else for (const r of many(`SELECT * FROM nodes WHERE snapshot_id = ? AND kind = 'METHOD' AND fqn = ? LIMIT 5`, `${type}#${m[2]}`)) add(r, 'STRONG', `stack frame ${type}.${m[2]} (line ${line} not inside it at this commit)`);
  }

  // URL paths, with or without context path / host; optional HTTP method in front.
  const contextPath = String(snap.scope.contextPath ?? '');
  const paths = new Set<string>();
  const endpoints = many(`SELECT * FROM nodes WHERE snapshot_id = ? AND kind = 'API_ENDPOINT'`);
  for (const m of text.matchAll(/(?:\b(GET|POST|PUT|PATCH|DELETE)\s+)?(?:https?:\/\/[^\s/]+)?(\/[A-Za-z0-9_\-./{}]+)/g)) {
    let p = m[2]!.replace(/[.,;:)]+$/, '').split('?')[0]!;
    if (contextPath && p.startsWith(contextPath + '/')) p = p.slice(contextPath.length);
    if (!p.includes('/', 1) || p.endsWith('.java')) continue;
    paths.add(p);
    for (const e of endpoints) {
      const a = JSON.parse(e.attrs_json) as { path: string; httpMethod: string };
      if (m[1] && a.httpMethod !== m[1] && a.httpMethod !== 'ANY') continue;
      if (pathMatches(a.path, p)) add(e, 'EXACT', `URL ${m[1] ? m[1] + ' ' : ''}${p}`);
    }
  }

  // Tables
  const tables = [...new Set([...text.matchAll(/\b(t_[a-z0-9_]+)\b/gi)].map((m) => m[1]!.toLowerCase()))];
  for (const t of tables) add(one(`SELECT * FROM nodes WHERE snapshot_id = ? AND id = ?`, `table:${t}`), 'EXACT', `table name ${t}`);

  // Class.method references ("SnippetsServiceImpl.deleteSnippet"): the class name scopes the method name.
  for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9_]*)\.([a-z][A-Za-z0-9_]*)\b/g)) {
    const rows = many(`SELECT * FROM nodes WHERE snapshot_id = ? AND kind = 'METHOD' AND (fqn LIKE ? OR fqn = ?) LIMIT 6`, `%.${m[1]}#${m[2]}`, `${m[1]}#${m[2]}`);
    for (const r of rows) add(r, rows.length <= 2 ? 'EXACT' : 'STRONG', `reference ${m[1]}.${m[2]}${rows.length > 2 ? ` (${rows.length} overloads/types)` : ''}`);
  }

  // Exceptions and identifiers
  const exceptions = [...new Set([...text.matchAll(/\b([A-Z][A-Za-z0-9]*(?:Exception|Error))\b/g)].map((m) => m[1]!))];
  for (const ex of exceptions) {
    for (const r of many(`SELECT * FROM nodes WHERE snapshot_id = ? AND kind NOT IN ('METHOD') AND name = ? LIMIT 3`, ex)) add(r, 'STRONG', `exception ${ex}`);
  }
  const identifiers = [...new Set([...text.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)(?:\(\))?/g)].map((m) => m[1]!))]
    .filter((x) => !exceptions.includes(x)).slice(0, 40);
  for (const id of identifiers) {
    const fq = one(`SELECT * FROM nodes WHERE snapshot_id = ? AND fqn = ? LIMIT 1`, id);
    if (fq) {
      add(fq, 'EXACT', `fully-qualified ${id}`);
      continue;
    }
    const rows = many(`SELECT * FROM nodes WHERE snapshot_id = ? AND name = ? AND kind IN ('METHOD','CLASS','DTO','ENTITY','SERVICE','REPOSITORY','CONTROLLER','COMPONENT','INTERFACE') LIMIT 8`, id);
    // A name shared by several declarations is only a hint: STRONG only when it nearly identifies one place.
    for (const r of rows) add(r, rows.length <= 2 ? 'STRONG' : 'WEAK', `identifier ${id}${rows.length > 2 ? ` (${rows.length}${rows.length === 8 ? '+' : ''} declarations share this name)` : ''}`);
  }

  // Quoted messages, located in source at the analysed commit.
  const messages = [...new Set([...text.matchAll(/["“']([^"”'\n]{8,120})["”']/g)].map((m) => m[1]!.trim()))].slice(0, 6);
  for (const msg of messages) {
    let hits = grepSource(db, snap, msg);
    // Logged messages usually end with runtime values ("Order not found: 42"): retry with the literal prefix.
    const prefix = msg.replace(/\s*\S*\d\S*.*$/, '').trimEnd();
    if (!hits.length && prefix.length >= 8 && prefix !== msg) hits = grepSource(db, snap, prefix);
    for (const hit of hits.slice(0, 10)) {
      const r = one(`SELECT * FROM nodes WHERE snapshot_id = ? AND kind = 'METHOD' AND file_path = ? AND line_start <= ? AND line_end >= ?
                     ORDER BY (line_end - line_start) LIMIT 1`, hit.file, hit.line, hit.line);
      add(r, 'TEXT', `message "${msg.slice(0, 60)}" at ${hit.file}:${hit.line}`);
    }
  }

  // Phrases → identifiers: UI wording like "Enable user selection" is usually camelCase in code (allowUserSelection,
  // populateUserSelection). Try the whole phrase, then drop leading words; 2+ words required to stay specific.
  const title = text.split('\n')[0] ?? '';
  const phrases = new Set<string>(messages);
  for (const m of title.matchAll(/\b([A-Za-z]{3,}(?:\s+[A-Za-z]{3,}){1,3})\b/g)) phrases.add(m[1]!);
  const phraseHits = new Set<string>();
  for (const phrase of phrases) {
    const words = (phrase.match(/[A-Za-z]{3,}/g) ?? []).filter((w) => !PHRASE_STOP.has(w.toLowerCase())).slice(0, 4);
    for (let start = 0; start <= words.length - 2; start++) {
      const camel = words.slice(start).map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join('');
      if (phraseHits.has(camel)) continue;
      const rows = many(`SELECT * FROM nodes WHERE snapshot_id = ? AND kind = 'METHOD' AND name LIKE ? AND in_scope = 1
                         AND json_extract(attrs_json, '$.accessor') IS NULL LIMIT 12`, `%${camel}%`);
      if (!rows.length) continue;
      phraseHits.add(camel);
      for (const r of rows.slice(0, 8)) add(r, rows.length <= 8 ? 'TEXT' : 'WEAK', `phrase "${phrase}" ~ identifier *${camel}*${rows.length > 8 ? ' (many)' : ''}`);
      break;
    }
  }

  // Keywords (weak)
  const keywords = [...new Set((text.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)))].slice(0, 12);
  if (keywords.length) {
    for (const h of search(db, sid, keywords.slice(0, 4).join(' '), [], 5)) add(one(`SELECT * FROM nodes WHERE snapshot_id = ? AND id = ?`, h.id), 'WEAK', `keywords ${keywords.slice(0, 4).join(', ')}`);
  }

  const candidates = [...out.values()].sort((a, b) => ORDER.indexOf(a.strength) - ORDER.indexOf(b.strength) || b.reasons.length - a.reasons.length).slice(0, 60);
  return { signals: { stackFrames: frames, paths: [...paths], identifiers, exceptions, tables, messages, keywords }, candidates };
}

/** Root-cause candidate locations: matched code (not endpoints/tables), strongest evidence first. Never a conclusion. */
export function rootCauseCandidates(m: DefectMatch): RootCauseCandidate[] {
  return m.candidates
    .filter((c) => c.kind === 'METHOD' && c.strength !== 'WEAK')
    .map((c) => ({ nodeId: c.nodeId, name: c.name, strength: c.strength, reasons: c.reasons, file: c.file, line: c.line }));
}

function pathMatches(pattern: string, concrete: string): boolean {
  const a = pattern.split('/').filter(Boolean);
  const b = concrete.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg === b[i] || (seg.startsWith('{') && seg.endsWith('}')) || (b[i]!.startsWith('{') && b[i]!.endsWith('}')));
}

/** Fixed-string search in the indexed sources of every repository of the snapshot, at its commit (git grep, read-only). */
function grepSource(db: DB, snap: SnapshotInfo, needle: string): Array<{ file: string; line: number }> {
  const hits: Array<{ file: string; line: number }> = [];
  for (const repo of reposOf(snap)) {
    if (!repo.repoPath) continue;
    const roots = repo.sourceRoots?.length ? repo.sourceRoots : ['src/main/java'];
    if (!repo.commitSha.startsWith('nogit-') && repo.sourceMode !== 'WORKTREE') {
      try {
        const outText = execFileSync('git', ['--no-optional-locks', '-C', repo.repoPath, 'grep', '-n', '-F', '-I', '-e', needle, repo.commitSha, '--', ...roots],
          { encoding: 'utf8', maxBuffer: 16 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
        for (const l of outText.split('\n').filter(Boolean)) {
          const rest = l.slice(repo.commitSha.length + 1);
          const i = rest.indexOf(':');
          const j = rest.indexOf(':', i + 1);
          hits.push({ file: repo.pathPrefix + rest.slice(0, i), line: Number(rest.slice(i + 1, j)) });
        }
      } catch {
        // git grep exits 1 when nothing matches
      }
      continue;
    }
    const files = db.prepare(`SELECT DISTINCT file_path AS f FROM nodes WHERE snapshot_id = ? AND file_path IS NOT NULL`).all(snap.id) as Array<{ f: string }>;
    for (const { f } of files) {
      if (repo.pathPrefix ? !f.startsWith(repo.pathPrefix) : f.startsWith('@')) continue;
      readAtCommit(repo.repoPath, repo.commitSha, f.slice(repo.pathPrefix.length), true).forEach((text, i) => {
        if (text.includes(needle)) hits.push({ file: f, line: i + 1 });
      });
    }
  }
  return hits;
}
