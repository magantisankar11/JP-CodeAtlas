import { createHash } from 'node:crypto';

/**
 * UI → Core linking. A UI_HTTP_CALL carries its URL as parts ({t:'lit'|'base'|'dyn', v}); a Core API_ENDPOINT carries
 * its Spring path ("/api/role/spaceRole/{spaceId}"). Matching is purely textual over path segments — nothing is executed.
 *
 *  - literal UI segment vs literal endpoint segment: must be equal
 *  - any non-empty UI segment vs "{var}" endpoint segment: binds (a dynamic UI segment is the expected case)
 *  - UI segment containing a dynamic part vs literal endpoint segment: possible only ("fuzzy")
 * Among exact candidates Spring's own rule picks the winner (fewer URI variables, then longer literal text). A unique winner
 * is FRAMEWORK_DERIVED; ties and fuzzy-only candidates are AMBIGUOUS; nothing → a diagnostic, never an invented edge.
 */
export interface Part { t: 'lit' | 'base' | 'dyn'; v: string }
export interface Endpoint { id: string; httpMethod: string; path: string }
export interface HttpCall { id: string; httpMethod: string | null; parts: Part[]; variants?: Part[][]; filePath: string; line: number; endLine: number; column: number }
export interface StitchOptions {
  /** Base expressions that point at this Core service (e.g. "process.env.JP_API"); other bases are other services. */
  coreBases: string[];
  /** Servlet context path of the Core service, stripped from UI URLs that spell it out. */
  contextPath?: string;
  maxAmbiguous?: number;
}
export type Resolution = 'FRAMEWORK_DERIVED' | 'AMBIGUOUS';
export interface Link { call: string; endpoint: string; resolution: Resolution; rule: string; url: string; conditional: boolean; viaParams: boolean }
export interface StitchDiag { severity: 'INFO' | 'WARN'; code: string; message: string; call: string }
export interface StitchResult {
  links: Link[];
  diagnostics: StitchDiag[];
  stats: Record<string, number>;
}

type Token = { lit: string } | { dyn: string };
type Seg = Token[];
interface Pattern { ep: Endpoint; segs: Array<{ kind: 'lit'; text: string } | { kind: 'var' } | { kind: 'rest' } | { kind: 'mixed'; re: RegExp }>; vars: number; litLen: number }

const segIsDyn = (s: Seg) => s.some((t) => 'dyn' in t);
const segText = (s: Seg) => s.map((t) => ('lit' in t ? t.lit : '${' + t.dyn + '}')).join('');

/** UI URL → path segments relative to the context path, or a reason it cannot be matched. */
export function uiSegments(parts: Part[], opts: StitchOptions): { segs: Seg[] } | { skip: string; code: string } {
  let ps = parts;
  if (ps[0]?.t === 'base') {
    if (!opts.coreBases.includes(ps[0].v)) return { skip: `base ${ps[0].v} is not the Core service`, code: 'UI_HTTP_OTHER_SERVICE' };
    ps = ps.slice(1);
  } else if (ps[0]?.t === 'dyn') {
    return { skip: `URL starts with a runtime value (${ps[0].v})`, code: 'UI_HTTP_URL_UNKNOWN' };
  } else if (ps[0]?.t === 'lit' && /^[a-z]+:\/\//i.test(ps[0].v)) {
    return { skip: `absolute URL ${ps[0].v.slice(0, 60)}`, code: 'UI_HTTP_OTHER_SERVICE' };
  }
  const tokens: Token[] = [];
  for (const p of ps) {
    if (p.t === 'lit') {
      const cut = p.v.search(/[?#]/);
      if (cut >= 0) {
        if (cut > 0) tokens.push({ lit: p.v.slice(0, cut) });
        break;
      }
      if (p.v) tokens.push({ lit: p.v });
    } else tokens.push({ dyn: p.v });
  }
  const segs: Seg[] = [[]];
  for (const t of tokens) {
    if ('dyn' in t) {
      segs[segs.length - 1]!.push(t);
      continue;
    }
    const pieces = t.lit.split('/');
    pieces.forEach((piece, i) => {
      if (i > 0) segs.push([]);
      if (piece) segs[segs.length - 1]!.push({ lit: piece });
    });
  }
  const nonEmpty = segs.filter((s) => s.length);
  const ctx = (opts.contextPath ?? '').replace(/^\/+|\/+$/g, '');
  if (ctx && nonEmpty.length && !segIsDyn(nonEmpty[0]!) && segText(nonEmpty[0]!) === ctx) nonEmpty.shift();
  if (!nonEmpty.some((s) => !segIsDyn(s))) return { skip: 'URL has no literal path segment', code: 'UI_HTTP_URL_UNKNOWN' };
  return { segs: nonEmpty };
}

export function compilePattern(ep: Endpoint): Pattern {
  let vars = 0;
  let litLen = 0;
  const segs = ep.path.split('/').filter(Boolean).map((s) => {
    if (s === '**' || /^\{\*[^}]*\}$/.test(s)) {
      vars += 2;
      return { kind: 'rest' as const };
    }
    if (/^\{[^}]+\}$/.test(s)) {
      vars++;
      return { kind: 'var' as const };
    }
    if (s.includes('{') || s.includes('*')) {
      vars++;
      const re = new RegExp('^' + s.replace(/\{[^}]+\}|\*/g, '\u0000').split('\u0000').map((x) => x.replace(/[.+?^$()[\]\\|]/g, '\\$&')).join('.+') + '$');
      litLen += s.replace(/\{[^}]+\}|\*/g, '').length;
      return { kind: 'mixed' as const, re };
    }
    litLen += s.length;
    return { kind: 'lit' as const, text: s };
  });
  return { ep, segs, vars, litLen };
}

/**
 * 'exact' | 'fuzzy' | null; viaParams tells whether a dynamic UI segment was bound to a URI variable; partial tells that a
 * fuzzy match rests on a segment mixing literal text and a runtime value ("sea${x}" vs "search").
 */
export function matchSegs(ui: Seg[], p: Pattern): { quality: 'exact' | 'fuzzy'; viaParams: boolean; partial?: boolean } | null {
  let fuzzy = false;
  let partial = false;
  let viaParams = false;
  for (let i = 0; i < p.segs.length; i++) {
    const ps = p.segs[i]!;
    if (ps.kind === 'rest') return { quality: fuzzy ? 'fuzzy' : 'exact', viaParams: viaParams || ui.slice(i).some(segIsDyn) };
    const us = ui[i];
    if (!us) return null;
    if (ps.kind === 'var') {
      if (segIsDyn(us)) viaParams = true;
      continue;
    }
    const text = segText(us);
    if (!segIsDyn(us)) {
      if (ps.kind === 'lit' ? text !== ps.text : !ps.re.test(text)) return null;
      continue;
    }
    // Dynamic text inside a segment that the endpoint spells literally: compatible prefix/suffix → possible, not proven.
    const first = us[0]!;
    const last = us[us.length - 1]!;
    const lit = ps.kind === 'lit' ? ps.text : null;
    if (lit !== null && 'lit' in first && !lit.startsWith(first.lit)) return null;
    if (lit !== null && 'lit' in last && !lit.endsWith(last.lit)) return null;
    fuzzy = true;
    if (us.some((t) => 'lit' in t)) partial = true;
  }
  if (ui.length !== p.segs.length) return null;
  return { quality: fuzzy ? 'fuzzy' : 'exact', viaParams, ...(partial ? { partial } : {}) };
}

const display = (parts: Part[]) => parts.map((p) => (p.t === 'lit' ? p.v : p.t === 'base' ? '{base}' : '${' + p.v + '}')).join('');

export function stitch(endpoints: Endpoint[], calls: HttpCall[], opts: StitchOptions): StitchResult {
  const max = opts.maxAmbiguous ?? 10;
  const byFirst = new Map<string, Pattern[]>();
  const wildFirst: Pattern[] = [];
  for (const ep of endpoints) {
    const p = compilePattern(ep);
    const f = p.segs[0];
    if (f?.kind === 'lit') (byFirst.get(f.text) ?? byFirst.set(f.text, []).get(f.text)!).push(p);
    else wildFirst.push(p);
  }
  const links: Link[] = [];
  const diagnostics: StitchDiag[] = [];
  const stats: Record<string, number> = { calls: calls.length, linked: 0, linkedExact: 0, linkedAmbiguous: 0, unmatched: 0, otherService: 0, urlUnknown: 0, methodMismatch: 0, conditionalUrls: 0 };
  const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);

  for (const call of calls) {
    const variants = call.variants?.length ? call.variants : [call.parts];
    const conditional = variants.length > 1;
    if (conditional) bump('conditionalUrls');
    const found = new Map<string, Link>();
    const skips: Array<{ code: string; skip: string }> = [];
    const mismatched = new Set<string>();
    for (const parts of variants) {
      const url = display(parts);
      const u = uiSegments(parts, opts);
      if ('skip' in u) {
        skips.push(u);
        continue;
      }
      const first = u.segs[0]!;
      const pool = segIsDyn(first) ? [...byFirst.values()].flat().concat(wildFirst) : (byFirst.get(segText(first)) ?? []).concat(wildFirst);
      const exact: Array<{ p: Pattern; viaParams: boolean }> = [];
      const fuzzy: Array<{ p: Pattern; viaParams: boolean; partial?: boolean }> = [];
      for (const p of pool) {
        const m = matchSegs(u.segs, p);
        if (!m) continue;
        if (call.httpMethod && p.ep.httpMethod !== call.httpMethod) {
          mismatched.add(`${p.ep.httpMethod} ${p.ep.path}`);
          continue;
        }
        if (m.quality === 'exact') exact.push({ p, viaParams: m.viaParams });
        else fuzzy.push({ p, viaParams: m.viaParams, partial: m.partial });
      }
      const add = (c: { p: Pattern; viaParams: boolean }, resolution: Resolution, rule: string) => {
        const prev = found.get(c.p.ep.id);
        if (prev && prev.resolution === 'FRAMEWORK_DERIVED') return;
        found.set(c.p.ep.id, { call: call.id, endpoint: c.p.ep.id, resolution, rule, url, conditional, viaParams: c.viaParams });
      };
      if (exact.length) {
        // Spring's most-specific-wins, per HTTP method: fewer URI variables, then more literal characters.
        const groups = new Map<string, typeof exact>();
        for (const c of exact) (groups.get(c.p.ep.httpMethod) ?? groups.set(c.p.ep.httpMethod, []).get(c.p.ep.httpMethod)!).push(c);
        const winners: typeof exact = [];
        for (const g of groups.values()) {
          g.sort((a, b) => a.p.vars - b.p.vars || b.p.litLen - a.p.litLen);
          winners.push(...g.filter((c) => c.p.vars === g[0]!.p.vars && c.p.litLen === g[0]!.p.litLen));
        }
        // A whole-segment runtime value (an id) is taken to bind the {var}; a segment that is part literal, part runtime
        // could equal a more specific literal path that Spring would prefer, so those candidates make the result ambiguous.
        const partials = fuzzy.filter((c) => c.partial);
        const unique = winners.length === 1 && !partials.length;
        for (const c of winners.slice(0, max)) {
          add(c, unique ? 'FRAMEWORK_DERIVED' : 'AMBIGUOUS', unique ? (c.viaParams ? 'UI_HTTP_PATH_PARAM_MATCH' : 'UI_HTTP_PATH_MATCH') : partials.length ? 'UI_HTTP_PATH_PARTIAL' : 'UI_HTTP_PATH_TIE');
        }
        for (const c of partials.slice(0, max)) add(c, 'AMBIGUOUS', 'UI_HTTP_PATH_PARTIAL');
      } else if (fuzzy.length && fuzzy.length <= max) {
        for (const c of fuzzy) add(c, 'AMBIGUOUS', 'UI_HTTP_PATH_PARTIAL');
      } else if (fuzzy.length) {
        diagnostics.push({ severity: 'WARN', code: 'UI_HTTP_TOO_MANY_CANDIDATES', message: `${call.httpMethod ?? '?'} ${url}: ${fuzzy.length} endpoints could match a dynamic segment; not linked`, call: call.id });
      }
    }
    if (found.size) {
      bump('linked');
      const vals = [...found.values()];
      bump(vals.every((l) => l.resolution === 'FRAMEWORK_DERIVED') ? 'linkedExact' : 'linkedAmbiguous');
      links.push(...vals);
      continue;
    }
    if (mismatched.size) {
      bump('methodMismatch');
      diagnostics.push({ severity: 'WARN', code: 'UI_HTTP_METHOD_MISMATCH',
        message: `${call.httpMethod} ${display(call.parts)}: path exists only as ${[...mismatched].slice(0, 5).join(', ')}`, call: call.id });
      continue;
    }
    if (skips.length === variants.length) {
      const s = skips[0]!;
      bump(s.code === 'UI_HTTP_OTHER_SERVICE' ? 'otherService' : 'urlUnknown');
      diagnostics.push({ severity: 'INFO', code: s.code, message: `${call.httpMethod ?? '?'} ${display(call.parts)}: ${s.skip}`, call: call.id });
      continue;
    }
    bump('unmatched');
    diagnostics.push({ severity: 'WARN', code: 'UI_HTTP_NO_ENDPOINT', message: `${call.httpMethod ?? '?'} ${display(call.parts)}: no Core endpoint matches`, call: call.id });
  }
  return { links, diagnostics, stats };
}

export const edgeId = (kind: string, src: string, dst: string) => 'e:' + createHash('sha1').update(`${kind}|${src}|${dst}`).digest('hex').slice(0, 20);
