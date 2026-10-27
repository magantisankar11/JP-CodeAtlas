import { parse as parseSfc } from '@vue/compiler-sfc';
import ts from 'typescript';
import { Graph, type Evidence, type Resolution } from './graph.js';
import { ModuleResolver } from './resolve.js';

/**
 * Front-end extraction for Vue 3 / JS / TS sources. Facts are bound statically:
 *  - calls through imports, `export default new Class()` instances, Options API `this.x()`, Pinia `useXStore()` results,
 *    script-setup / Options API template references;
 *  - HTTP calls via axios / fetch with URLs partially evaluated (constants, concatenations, template literals,
 *    single-return helper functions, `process.env` / `window` bases);
 *  - vue-router route objects, template component usage, test files' imports.
 * A bare method name is never matched to an arbitrary declaration.
 */

export type Part = { t: 'lit'; v: string } | { t: 'base'; v: string } | { t: 'dyn'; v: string };

interface Block { sf: ts.SourceFile; lineOffset: number; setup: boolean }
/** extra: further top-level nodes belonging to a synthetic <module>/<setup> function. */
interface FnInfo { qual: string; name: string; role: string; body: ts.Node; block: Block; templateCallable: boolean; className?: string; extra?: ts.Node[] }
type Binding = { kind: 'import'; file: string | null; spec: string; imported: string; /** file line of the import declaration */ line: number };
type Export =
  | { kind: 'fn'; qual: string }
  | { kind: 'instance'; className: string }
  | { kind: 'class'; className: string }
  | { kind: 'store'; prefix: string }
  | { kind: 'value'; expr: ts.Expression; block: Block };

interface Module {
  path: string;
  isVue: boolean;
  isTest: boolean;
  blocks: Block[];
  template?: { ast: any; startLine: number };
  imports: Map<string, Binding>;
  values: Map<string, { expr: ts.Expression; block: Block }>;
  reassignedLater: Set<string>;
  functions: Map<string, FnInfo>;
  /** simple name → qual for module-level functions and template-callable component functions */
  byName: Map<string, string>;
  classes: Map<string, Map<string, string>>;
  stores: Map<string, Map<string, string>>;
  instances: Map<string, string>;
  exports: Map<string, Export>;
  optionsComponents: Map<string, string>;
  isStore: boolean;
}

const HTTP_VERBS: Record<string, string> = { get: 'GET', post: 'POST', put: 'PUT', delete: 'DELETE', patch: 'PATCH', head: 'HEAD', options: 'OPTIONS' };
const LIFECYCLE = new Set(['setup', 'data', 'created', 'beforeCreate', 'mounted', 'beforeMount', 'updated', 'beforeUpdate', 'activated', 'deactivated',
  'unmounted', 'beforeUnmount', 'destroyed', 'beforeDestroy', 'errorCaptured']);

export interface UiAnalysis { graph: Graph; stats: Record<string, number> }

export function analyzeUi(files: Map<string, string>): UiAnalysis {
  const graph = new Graph();
  const stats: Record<string, number> = {};
  const count = (k: string, n = 1) => (stats[k] = (stats[k] ?? 0) + n);
  const resolver = new ModuleResolver(new Set(files.keys()));
  const modules = new Map<string, Module>();

  // ---------------------------------------------------------------- pass 1: parse and declare
  for (const [path, text] of files) {
    try {
      modules.set(path, declare(path, text, resolver));
      count('files');
    } catch (e) {
      graph.diag('WARN', 'UI_PARSE_FAILED', `${path}: ${(e as Error).message}`, path);
      count('parseFailed');
    }
  }

  const lineOf = (b: Block, pos: number) => b.lineOffset + b.sf.getLineAndCharacterOfPosition(pos).line;
  const ev = (m: Module, b: Block, n: ts.Node, rule: string, r: Resolution): Evidence => ({
    filePath: m.path, line: lineOf(b, n.getStart(b.sf)), endLine: lineOf(b, n.getEnd()), column: b.sf.getLineAndCharacterOfPosition(n.getStart(b.sf)).character + 1, rule, resolution: r,
  });
  const fileId = (p: string) => (modules.get(p)?.isTest ? `ui:test:${p}` : `ui:file:${p}`);
  const fnId = (p: string, qual: string) => `ui:fn:${p}#${qual}`;

  // ---------------------------------------------------------------- nodes
  for (const m of modules.values()) {
    const text = files.get(m.path)!;
    const kind = m.isTest ? 'TEST_CASE' : m.isVue ? 'UI_COMPONENT' : m.isStore ? 'UI_STORE' : 'UI_MODULE';
    const name = m.path.split('/').pop()!;
    graph.node({ id: fileId(m.path), kind, name, fqn: m.path, filePath: m.path, lineStart: 1, lineEnd: text.split('\n').length, package: m.path.split('/').slice(0, -1).join('/'),
      attrs: { language: m.isVue ? 'vue' : m.path.split('.').pop(), ...(m.isTest ? { cases: testCases(m) } : {}) } });
    count(kind);
    for (const f of m.functions.values()) {
      const start = f.role === 'template' ? m.template!.startLine : lineOf(f.block, f.body.getStart(f.block.sf));
      const end = f.role === 'template' ? start : lineOf(f.block, f.body.getEnd());
      graph.node({ id: fnId(m.path, f.qual), kind: 'UI_FUNCTION', name: f.name, fqn: `${m.path}#${f.qual}`, filePath: m.path, lineStart: start, lineEnd: end,
        signature: f.qual, attrs: { role: f.role, templateCallable: f.templateCallable, ...(f.className ? { className: f.className } : {}) } });
      graph.edge('CONTAINS', fileId(m.path), fnId(m.path, f.qual), 'CONFIRMED',
        { filePath: m.path, line: start, endLine: end, column: 1, rule: 'DECLARATION', resolution: 'CONFIRMED' });
      count('functions');
    }
  }

  // ---------------------------------------------------------------- imports, tests
  for (const m of modules.values()) {
    for (const b of m.imports.values()) {
      if (!b.file || b.file === m.path) continue;
      const line = b.line;
      const kind = m.isTest && !modules.get(b.file)?.isTest ? 'TESTS' : 'IMPORTS';
      graph.edge(kind, fileId(m.path), fileId(b.file), 'CONFIRMED', { filePath: m.path, line, endLine: line, column: 1, rule: kind === 'TESTS' ? 'TEST_IMPORT' : 'IMPORT', resolution: 'CONFIRMED' });
    }
  }

  // ---------------------------------------------------------------- export lookup through imports
  const exportOf = (file: string | null, name: string, depth = 0): { module: Module; exp: Export } | null => {
    if (!file || depth > 5) return null;
    const mod = modules.get(file);
    if (!mod) return null;
    const exp = mod.exports.get(name);
    if (exp) return { module: mod, exp };
    return null;
  };

  // ---------------------------------------------------------------- partial evaluation of URL expressions
  const MAX_VARIANTS = 8;
  const product = (a: Part[][], b: Part[][]): Part[][] => {
    const out: Part[][] = [];
    for (const x of a) for (const y of b) if (out.length < MAX_VARIANTS) out.push([...x, ...y]);
    return out;
  };
  const isConditional = (n: ts.Node, stop: ts.Node) => {
    for (let p = n.parent; p && p !== stop; p = p.parent) {
      if (ts.isIfStatement(p) || ts.isConditionalExpression(p) || ts.isSwitchStatement(p) || ts.isCatchClause(p) || ts.isIterationStatement(p, false)) return true;
    }
    return false;
  };
  /**
   * Values a function-local variable can hold at `before`: declaration initializer, then `=` / `+=` assignments in source
   * order; conditional assignments add variants instead of replacing. null when the name is not a local of `body`.
   */
  const localVariants = (m: Module, b: Block, name: string, body: ts.Node, before: number, depth: number): Part[][] | null => {
    let decl: ts.VariableDeclaration | undefined;
    const assigns: Array<{ op: ts.SyntaxKind; rhs: ts.Expression; node: ts.Node }> = [];
    const v = (n: ts.Node) => {
      if (n.getStart(b.sf) >= before) return;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) decl = n;
      if (ts.isBinaryExpression(n) && ts.isIdentifier(n.left) && n.left.text === name
        && (n.operatorToken.kind === ts.SyntaxKind.EqualsToken || n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)) {
        assigns.push({ op: n.operatorToken.kind, rhs: n.right, node: n });
      }
      ts.forEachChild(n, v);
    };
    v(body);
    if (!decl) return null;
    let cur: Part[][] = decl.initializer ? evalV(m, b, decl.initializer, depth + 1, new Map(), { body, before: decl.getStart(b.sf) }) : [[{ t: 'dyn', v: name }]];
    for (const a of assigns.sort((x, y) => x.node.getStart(b.sf) - y.node.getStart(b.sf))) {
      const rhs = evalV(m, b, a.rhs, depth + 1, new Map(), { body, before: a.node.getStart(b.sf) });
      const next = a.op === ts.SyntaxKind.EqualsToken ? rhs : product(cur, rhs);
      cur = isConditional(a.node, body) ? [...cur, ...next].slice(0, MAX_VARIANTS) : next;
    }
    return cur;
  };
  const evaluate = (m: Module, b: Block, e: ts.Expression | undefined, depth = 0, params: Map<string, Part[]> = new Map()): Part[] =>
    evalV(m, b, e, depth, params)[0] ?? [{ t: 'dyn', v: '?' }];
  /** All variants (≤ 8) of a string expression; `scope` enables function-local variable resolution. */
  const evalV = (m: Module, b: Block, e: ts.Expression | undefined, depth = 0, params: Map<string, Part[]> = new Map(),
    scope?: { body: ts.Node; before: number }): Part[][] => {
    if (!e || depth > 12) return [[{ t: 'dyn', v: '?' }]];
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return evalV(m, b, e.expression, depth + 1, params, scope);
    if (ts.isTemplateExpression(e)) {
      let out: Part[][] = [[{ t: 'lit', v: e.head.text }]];
      for (const s of e.templateSpans) out = product(product(out, evalV(m, b, s.expression, depth + 1, params, scope)), [[{ t: 'lit', v: s.literal.text }]]);
      return out;
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return product(evalV(m, b, e.left, depth + 1, params, scope), evalV(m, b, e.right, depth + 1, params, scope));
    }
    if (ts.isIdentifier(e) && scope && !params.has(e.text)) {
      const local = localVariants(m, b, e.text, scope.body, scope.before, depth);
      if (local) return local;
    }
    return [evaluate1(m, b, e, depth, params)];
  };
  const evaluate1 = (m: Module, b: Block, e: ts.Expression, depth: number, params: Map<string, Part[]>): Part[] => {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return evaluate(m, b, e.expression, depth + 1, params);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [{ t: 'lit', v: e.text }];
    if (ts.isNumericLiteral(e)) return [{ t: 'lit', v: e.text }];
    if (ts.isTemplateExpression(e)) {
      const out: Part[] = [{ t: 'lit', v: e.head.text }];
      for (const s of e.templateSpans) out.push(...evaluate(m, b, s.expression, depth + 1, params), { t: 'lit', v: s.literal.text });
      return out;
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return [...evaluate(m, b, e.left, depth + 1, params), ...evaluate(m, b, e.right, depth + 1, params)];
    }
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      const left = evaluate(m, b, e.left, depth + 1, params);
      return left.length === 1 && left[0]!.t === 'base' ? left : [{ t: 'dyn', v: e.getText(b.sf).slice(0, 60) }];
    }
    const text = e.getText(b.sf);
    if (/^(process\.env|import\.meta\.env|window(\?)?\.(appConfig|location|origin)|location\.origin)/.test(text.replace(/\s/g, ''))) return [{ t: 'base', v: text.slice(0, 60) }];
    if (ts.isIdentifier(e)) {
      if (params.has(e.text)) return params.get(e.text)!;
      const local = m.values.get(e.text);
      if (local) return m.reassignedLater.has(e.text) ? [{ t: 'dyn', v: e.text }] : evaluate(m, local.block, local.expr, depth + 1);
      const imp = m.imports.get(e.text);
      if (imp) {
        const target = exportOf(imp.file, imp.imported);
        if (target?.exp.kind === 'value') return evaluate(target.module, target.exp.block, target.exp.expr, depth + 1);
      }
      return [{ t: 'dyn', v: e.text }];
    }
    if (ts.isCallExpression(e) && e.arguments.length <= 3) {
      // single-return helper functions such as jpEndpoint() / buildUrl(x)
      const fn = calleeFunction(m, e.expression);
      if (fn) {
        const ret = singleReturn(fn.info.body);
        if (ret) {
          const bound = new Map<string, Part[]>();
          const fnNode = fn.info.body.parent;
          if (fnNode && (ts.isFunctionDeclaration(fnNode) || ts.isFunctionExpression(fnNode) || ts.isArrowFunction(fnNode) || ts.isMethodDeclaration(fnNode))) {
            fnNode.parameters.forEach((p, i) => {
              if (ts.isIdentifier(p.name)) bound.set(p.name.text, evaluate(m, b, e.arguments[i], depth + 1, params));
            });
          }
          return evaluate(fn.module, fn.info.block, ret, depth + 1, bound);
        }
      }
    }
    return [{ t: 'dyn', v: text.slice(0, 60) }];
  };

  const calleeFunction = (m: Module, callee: ts.Expression): { module: Module; info: FnInfo } | null => {
    if (!ts.isIdentifier(callee)) return null;
    const q = m.byName.get(callee.text);
    if (q) return { module: m, info: m.functions.get(q)! };
    const imp = m.imports.get(callee.text);
    if (imp) {
      const t = exportOf(imp.file, imp.imported);
      if (t?.exp.kind === 'fn') return { module: t.module, info: t.module.functions.get(t.exp.qual)! };
    }
    return null;
  };

  // ---------------------------------------------------------------- pass 2: calls, HTTP, routes
  for (const m of modules.values()) {
    for (const f of m.functions.values()) {
      if (f.role === 'template') continue;
      const src = fnId(m.path, f.qual);
      const locals = new Map<string, { kind: 'store'; prefix: string; file: string } | { kind: 'instance'; className: string; file: string }>();
      const visit = (n: ts.Node, inCallback: boolean, conditional: boolean) => {
        if (n !== f.body && (ts.isArrowFunction(n) || ts.isFunctionExpression(n))) inCallback = true;
        if (ts.isIfStatement(n) || ts.isConditionalExpression(n) || ts.isCatchClause(n) || ts.isSwitchStatement(n)) conditional = true;
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression)) {
          const store = storeFactory(m, n.initializer.expression.text);
          if (store) locals.set(n.name.text, { kind: 'store', ...store });
        }
        if (ts.isCallExpression(n)) call(n, inCallback, conditional);
        ts.forEachChild(n, (c) => visit(c, inCallback, conditional));
      };
      const attrs = (inCallback: boolean, conditional: boolean) => ({ ...(inCallback ? { inCallback: true } : {}), conditional });
      const storeFactory = (mod: Module, name: string): { prefix: string; file: string } | null => {
        if (mod.stores.has(name)) return { prefix: name, file: mod.path };
        const imp = mod.imports.get(name);
        const t = imp ? exportOf(imp.file, imp.imported) : null;
        return t?.exp.kind === 'store' ? { prefix: t.exp.prefix, file: t.module.path } : null;
      };
      const link = (dstFile: string, qual: string | undefined, node: ts.Node, rule: string, r: Resolution, inCallback: boolean, conditional: boolean) => {
        if (!qual || !modules.get(dstFile)?.functions.has(qual)) return false;
        graph.edge('CALLS', src, fnId(dstFile, qual), r, ev(m, f.block, node, rule, r), attrs(inCallback, conditional));
        count(r === 'CONFIRMED' ? 'callsConfirmed' : 'callsDerived');
        return true;
      };
      const call = (c: ts.CallExpression, inCallback: boolean, conditional: boolean) => {
        const callee = c.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword) return;
        // HTTP clients
        const http = httpCall(m, c);
        if (http) {
          const b = f.block;
          const variants = (http.url ? evalV(m, b, http.url, 0, new Map(), { body: f.body, before: c.getStart(b.sf) }) : [[{ t: 'dyn', v: 'config' } as Part]])
            .map(mergeParts);
          const unique = [...new Map(variants.map((v) => [display(v), v])).values()];
          const line = lineOf(b, c.getStart(b.sf));
          const col = b.sf.getLineAndCharacterOfPosition(c.getStart(b.sf)).character + 1;
          const id = `ui:http:${m.path}#L${line}C${col}`;
          const merged = unique[0]!;
          const isResolved = (v: Part[]) => v.every((p, i) => p.t === 'lit' || (p.t === 'base' && i === 0));
          const resolved = unique.every(isResolved);
          graph.node({ id, kind: 'UI_HTTP_CALL', name: `${http.method ?? '?'} ${unique.map(display).join(' | ')}`.slice(0, 300), fqn: id.slice('ui:http:'.length), filePath: m.path,
            lineStart: line, lineEnd: lineOf(b, c.getEnd()),
            attrs: { httpMethod: http.method, client: http.client, parts: merged, url: display(merged), resolved, ...(unique.length > 1 ? { variants: unique } : {}) } });
          graph.edge('MAKES_HTTP_CALL', src, id, 'CONFIRMED', ev(m, b, c, 'HTTP_CLIENT_CALL', 'CONFIRMED'), attrs(inCallback, conditional));
          count('httpCalls');
          count(resolved ? 'httpUrlsResolved' : 'httpUrlsPartial');
          return;
        }
        if (ts.isIdentifier(callee)) {
          const q = m.byName.get(callee.text);
          if (q && link(m.path, q, c, 'LOCAL_BINDING', 'CONFIRMED', inCallback, conditional)) return;
          const imp = m.imports.get(callee.text);
          if (imp) {
            const t = exportOf(imp.file, imp.imported);
            if (t?.exp.kind === 'fn' && link(t.module.path, t.exp.qual, c, 'IMPORT_BINDING', 'CONFIRMED', inCallback, conditional)) return;
            if (t?.exp.kind === 'store') return;
          }
          count(imp && !imp.file ? 'libraryCalls' : 'unboundCalls');
          return;
        }
        if (ts.isPropertyAccessExpression(callee)) {
          const method = callee.name.text;
          const obj = callee.expression;
          if (obj.kind === ts.SyntaxKind.ThisKeyword) {
            if (f.className) {
              const q = m.classes.get(f.className)?.get(method);
              if (link(m.path, q, c, 'THIS_CLASS_METHOD', 'CONFIRMED', inCallback, conditional)) return;
            } else if (m.isVue) {
              const q = m.byName.get(method);
              if (q && m.functions.get(q)?.templateCallable && link(m.path, q, c, 'THIS_COMPONENT_METHOD', 'CONFIRMED', inCallback, conditional)) return;
            }
            count('unboundCalls');
            return;
          }
          if (ts.isIdentifier(obj)) {
            const local = locals.get(obj.text);
            if (local?.kind === 'store') {
              const q = modules.get(local.file)?.stores.get(local.prefix)?.get(method);
              if (link(local.file, q, c, 'PINIA_STORE', 'FRAMEWORK_DERIVED', inCallback, conditional)) return;
            }
            const inst = m.instances.get(obj.text);
            if (inst) {
              const q = m.classes.get(inst)?.get(method);
              if (link(m.path, q, c, 'INSTANCE_METHOD', 'CONFIRMED', inCallback, conditional)) return;
            }
            const imp = m.imports.get(obj.text);
            if (imp?.file) {
              if (imp.imported === '*') {
                const t = exportOf(imp.file, method);
                if (t?.exp.kind === 'fn' && link(t.module.path, t.exp.qual, c, 'NAMESPACE_IMPORT', 'CONFIRMED', inCallback, conditional)) return;
              }
              const t = exportOf(imp.file, imp.imported);
              if (t?.exp.kind === 'instance') {
                const q = t.module.classes.get(t.exp.className)?.get(method);
                if (link(t.module.path, q, c, 'IMPORTED_INSTANCE', 'CONFIRMED', inCallback, conditional)) return;
              }
            }
            count(imp && !imp.file ? 'libraryCalls' : 'unboundCalls');
            return;
          }
          count('unboundCalls');
        }
      };
      visit(f.body, false, false);
      for (const x of f.extra ?? []) visit(x, false, false);
    }

    // template → component functions and child components
    if (m.template) {
      const tq = '<template>';
      const tid = fnId(m.path, tq);
      const rendered = new Set<string>();
      let dynamicAt: any = null;
      walkTemplate(m.template.ast, (node: any) => {
        if (node.type === 1) {
          const isProp = node.tag === 'component' ? (node.props ?? []).find((p: any) => (p.type === 7 && p.arg?.content === 'is') || (p.type === 6 && p.name === 'is')) : null;
          if (isProp?.type === 7) dynamicAt ??= node.loc;
          const comp = templateComponent(m, isProp?.type === 6 ? isProp.value?.content ?? node.tag : node.tag);
          if (comp) {
            rendered.add(comp);
            graph.edge('RENDERS', fileId(m.path), fileId(comp), 'FRAMEWORK_DERIVED',
              { filePath: m.path, line: node.loc.start.line, endLine: node.loc.start.line, column: node.loc.start.column, rule: 'TEMPLATE_COMPONENT', resolution: 'FRAMEWORK_DERIVED' }, { tag: node.tag });
            count('renders');
          }
          for (const p of node.props ?? []) {
            if (p.type === 7 && p.exp?.content) templateRefs(p.exp.content, p.name === 'on' ? p.arg?.content : undefined, p.loc);
          }
        } else if (node.type === 5 && node.content?.content) templateRefs(node.content.content, undefined, node.loc);
      });
      // <component :is="expr">: any registered component not rendered statically may be the one shown → AMBIGUOUS.
      if (dynamicAt) {
        for (const comp of new Set(m.optionsComponents.values())) {
          if (rendered.has(comp)) continue;
          graph.edge('RENDERS', fileId(m.path), fileId(comp), 'AMBIGUOUS',
            { filePath: m.path, line: dynamicAt.start.line, endLine: dynamicAt.start.line, column: dynamicAt.start.column, rule: 'TEMPLATE_DYNAMIC_COMPONENT', resolution: 'AMBIGUOUS' }, { dynamic: true });
          count('rendersDynamic');
        }
      }
      function templateRefs(expr: string, event: string | undefined, loc: any) {
        for (const id of new Set(expr.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
          const q = m.byName.get(id);
          if (!q || !m.functions.get(q)?.templateCallable) continue;
          graph.edge('CALLS', tid, fnId(m.path, q), 'FRAMEWORK_DERIVED',
            { filePath: m.path, line: loc.start.line, endLine: loc.end.line, column: loc.start.column, rule: event ? 'TEMPLATE_EVENT_HANDLER' : 'TEMPLATE_REFERENCE', resolution: 'FRAMEWORK_DERIVED' },
            event ? { event } : {});
          count('templateBindings');
        }
      }
    }

    // vue-router route records
    for (const b of m.blocks) routes(m, b);
  }

  function routes(m: Module, b: Block) {
    const visit = (n: ts.Node, parentPath: string) => {
      if (ts.isObjectLiteralExpression(n)) {
        const path = prop(n, 'path');
        const comp = propNode(n, 'component');
        if (path && ts.isStringLiteralLike(path) && (comp || propNode(n, 'children') || propNode(n, 'redirect'))) {
          const full = joinRoute(parentPath, path.text);
          const id = `ui:route:${full}`;
          const nameNode = prop(n, 'name');
          const target = comp ? routeComponent(m, comp) : null;
          const line = lineOf(b, n.getStart(b.sf));
          graph.node({ id, kind: 'UI_ROUTE', name: full, fqn: full, filePath: m.path, lineStart: line, lineEnd: lineOf(b, n.getEnd()),
            attrs: { path: full, routeName: nameNode && ts.isStringLiteralLike(nameNode) ? nameNode.text : null, component: target, lazy: Boolean(comp && !ts.isIdentifier(comp)), entryPoint: 'UI_ROUTE' } });
          count('routes');
          if (target) {
            graph.edge('ROUTES_TO', id, fileId(target), 'FRAMEWORK_DERIVED', { filePath: m.path, line, endLine: line, column: 1, rule: 'VUE_ROUTER', resolution: 'FRAMEWORK_DERIVED' });
          } else if (comp) {
            graph.diag('INFO', 'UI_ROUTE_COMPONENT_UNRESOLVED', `${full}: ${comp.getText(b.sf).slice(0, 80)}`, m.path, line);
          }
          const children = propNode(n, 'children');
          if (children) ts.forEachChild(children, (c) => visit(c, full));
          return;
        }
      }
      ts.forEachChild(n, (c) => visit(c, parentPath));
    };
    visit(b.sf, '');
  }

  function routeComponent(m: Module, comp: ts.Node): string | null {
    if (ts.isIdentifier(comp)) return m.imports.get(comp.text)?.file ?? null;
    let found: string | null = null;
    const v = (n: ts.Node) => {
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
        found = (resolver.resolve(m.path, n.arguments[0].text)) ?? found;
      }
      ts.forEachChild(n, v);
    };
    v(comp);
    return found;
  }

  function templateComponent(m: Module, tag: string): string | null {
    const pascal = tag.includes('-') ? tag.split('-').map((s) => s[0]!.toUpperCase() + s.slice(1)).join('') : tag;
    const local = m.optionsComponents.get(pascal) ?? m.optionsComponents.get(tag);
    if (local) return local;
    const imp = m.imports.get(pascal) ?? m.imports.get(tag);
    return imp?.file && imp.file.endsWith('.vue') ? imp.file : null;
  }

  function httpCall(m: Module, c: ts.CallExpression): { method: string | null; url?: ts.Expression; client: string } | null {
    const callee = c.expression;
    const isAxios = (e: ts.Expression) => ts.isIdentifier(e) && (m.imports.get(e.text)?.spec === 'axios' || m.instances.get(e.text) === '<axios>');
    if (ts.isPropertyAccessExpression(callee) && isAxios(callee.expression)) {
      const verb = callee.name.text;
      if (HTTP_VERBS[verb]) return { method: HTTP_VERBS[verb]!, url: c.arguments[0], client: 'axios' };
      if (verb === 'request') return configCall(c.arguments[0]);
      return null;
    }
    if (isAxios(callee)) return configCall(c.arguments[0]);
    if (ts.isIdentifier(callee) && callee.text === 'fetch' && !m.imports.has('fetch')) {
      const opts = c.arguments[1];
      const method = opts && ts.isObjectLiteralExpression(opts) ? prop(opts, 'method') : undefined;
      return { method: method && ts.isStringLiteralLike(method) ? method.text.toUpperCase() : opts ? null : 'GET', url: c.arguments[0], client: 'fetch' };
    }
    return null;
    function configCall(cfg: ts.Expression | undefined) {
      if (!cfg || !ts.isObjectLiteralExpression(cfg)) return { method: null, client: 'axios' };
      const method = prop(cfg, 'method');
      return { method: method && ts.isStringLiteralLike(method) ? method.text.toUpperCase() : null, url: prop(cfg, 'url'), client: 'axios' };
    }
  }

  for (const m of modules.values()) {
    if (m.isVue && !m.template && m.blocks.length === 0) graph.diag('INFO', 'UI_EMPTY_SFC', m.path, m.path);
  }
  return { graph, stats };
}

// ---------------------------------------------------------------- declaration pass

function declare(path: string, text: string, resolver: ModuleResolver): Module {
  const isVue = path.endsWith('.vue');
  const isTest = /(^|\/)(test|tests|__tests__)\//.test(path) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(path);
  const m: Module = {
    path, isVue, isTest, blocks: [], imports: new Map(), values: new Map(), reassignedLater: new Set(), functions: new Map(), byName: new Map(),
    classes: new Map(), stores: new Map(), instances: new Map(), exports: new Map(), optionsComponents: new Map(), isStore: false,
  };
  if (isVue) {
    const { descriptor } = parseSfc(text, { filename: path });
    for (const [blk, setup] of [[descriptor.script, false], [descriptor.scriptSetup, true]] as const) {
      if (!blk) continue;
      const kind = blk.lang === 'ts' ? ts.ScriptKind.TS : blk.lang === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.JS;
      m.blocks.push({ sf: ts.createSourceFile(path, blk.content, ts.ScriptTarget.Latest, true, kind), lineOffset: blk.loc.start.line, setup });
    }
    if (descriptor.template?.ast) m.template = { ast: descriptor.template.ast, startLine: descriptor.template.loc.start.line };
  } else {
    const kind = path.endsWith('.ts') || path.endsWith('.mts') ? ts.ScriptKind.TS : path.endsWith('.tsx') ? ts.ScriptKind.TSX : path.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
    m.blocks.push({ sf: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind), lineOffset: 1, setup: false });
  }
  const addFn = (b: Block, qual: string, name: string, role: string, body: ts.Node, templateCallable: boolean, className?: string) => {
    if (m.functions.has(qual)) return;
    m.functions.set(qual, { qual, name, role, body, block: b, templateCallable, className });
    if (!m.byName.has(name) && (role === 'function' || templateCallable)) m.byName.set(name, qual);
  };
  const fnBody = (n: ts.Node): ts.Node | null => {
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.body) return n.body;
    return null;
  };
  const exported = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((x) => x.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((x) => x.kind === ts.SyntaxKind.DefaultKeyword);

  const optionsObject = (b: Block, obj: ts.ObjectLiteralExpression) => {
    for (const p of obj.properties) {
      const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
      if (!key) continue;
      if (key === 'components' && ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)) {
        for (const c of p.initializer.properties) {
          const local = ts.isShorthandPropertyAssignment(c) ? c.name.text : ts.isPropertyAssignment(c) && ts.isIdentifier(c.initializer) ? c.initializer.text : null;
          const tag = c.name && (ts.isIdentifier(c.name) || ts.isStringLiteral(c.name)) ? c.name.text : null;
          const file = local ? m.imports.get(local)?.file : null;
          if (tag && file) m.optionsComponents.set(tag, file);
        }
        continue;
      }
      if ((key === 'methods' || key === 'computed' || key === 'watch') && ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)) {
        for (const mp of p.initializer.properties) {
          const name = mp.name && (ts.isIdentifier(mp.name) || ts.isStringLiteral(mp.name)) ? mp.name.text : null;
          const body = ts.isMethodDeclaration(mp) ? fnBody(mp) : ts.isPropertyAssignment(mp) ? fnBody(mp.initializer) ?? (ts.isObjectLiteralExpression(mp.initializer) ? mp.initializer : null) : null;
          if (name && body) addFn(b, `${key}.${name}`, name, key === 'methods' ? 'method' : key, body, key !== 'watch');
        }
        continue;
      }
      const body = ts.isMethodDeclaration(p) ? fnBody(p) : ts.isPropertyAssignment(p) ? fnBody(p.initializer) : null;
      if (body && LIFECYCLE.has(key)) {
        addFn(b, key, key, 'lifecycle', body, false);
        if (key === 'setup') setupReturn(b, body);
      }
    }
  };
  // Options API setup(): functions returned from setup are template-callable
  const setupReturn = (b: Block, body: ts.Node) => {
    if (!ts.isBlock(body)) return;
    for (const s of body.statements) {
      if (ts.isFunctionDeclaration(s) && s.name && s.body) addFn(b, `setup.${s.name.text}`, s.name.text, 'method', s.body, true);
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          const fb = d.initializer && fnBody(d.initializer);
          if (ts.isIdentifier(d.name) && fb) addFn(b, `setup.${d.name.text}`, d.name.text, 'method', fb, true);
        }
      }
    }
  };
  const storeDef = (b: Block, varName: string, call: ts.CallExpression) => {
    const actions = new Map<string, string>();
    m.isStore = true;
    const def = call.arguments[1] ?? call.arguments[0];
    if (def && ts.isObjectLiteralExpression(def)) {
      for (const p of def.properties) {
        const key = p.name && ts.isIdentifier(p.name) ? p.name.text : null;
        if ((key === 'actions' || key === 'getters') && ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)) {
          for (const a of p.initializer.properties) {
            const name = a.name && ts.isIdentifier(a.name) ? a.name.text : null;
            const body = ts.isMethodDeclaration(a) ? fnBody(a) : ts.isPropertyAssignment(a) ? fnBody(a.initializer) : null;
            if (name && body) {
              addFn(b, `${varName}.${name}`, name, 'store-action', body, false);
              actions.set(name, `${varName}.${name}`);
            }
          }
        }
      }
    } else if (def && (ts.isArrowFunction(def) || ts.isFunctionExpression(def)) && ts.isBlock(def.body)) {
      for (const s of def.body.statements) {
        if (ts.isFunctionDeclaration(s) && s.name && s.body) {
          addFn(b, `${varName}.${s.name.text}`, s.name.text, 'store-action', s.body, false);
          actions.set(s.name.text, `${varName}.${s.name.text}`);
        }
        if (ts.isVariableStatement(s)) {
          for (const d of s.declarationList.declarations) {
            const fb = d.initializer && fnBody(d.initializer);
            if (ts.isIdentifier(d.name) && fb) {
              addFn(b, `${varName}.${d.name.text}`, d.name.text, 'store-action', fb, false);
              actions.set(d.name.text, `${varName}.${d.name.text}`);
            }
          }
        }
      }
    }
    m.stores.set(varName, actions);
  };

  for (const b of m.blocks) {
    // imports first: everything else may refer to them
    for (const s of b.sf.statements) {
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
      const spec = s.moduleSpecifier.text;
      const file = resolver.resolve(path, spec);
      const clause = s.importClause;
      if (!clause) continue;
      const line = b.lineOffset + b.sf.getLineAndCharacterOfPosition(s.getStart(b.sf)).line;
      if (clause.name) m.imports.set(clause.name.text, { kind: 'import', file, spec, line, imported: 'default' });
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) m.imports.set(nb.name.text, { kind: 'import', file, spec, line, imported: '*' });
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) m.imports.set(el.name.text, { kind: 'import', file, spec, line, imported: (el.propertyName ?? el.name).text });
    }
  }
  for (const b of m.blocks) {
    const topLevelCode: ts.Node[] = [];
    for (const s of b.sf.statements) {
      if (ts.isImportDeclaration(s)) continue;
      if (ts.isFunctionDeclaration(s) && s.name && s.body) {
        addFn(b, s.name.text, s.name.text, 'function', s.body, b.setup);
        if (exported(s)) m.exports.set(isDefault(s) ? 'default' : s.name.text, { kind: 'fn', qual: s.name.text });
        continue;
      }
      if (ts.isFunctionDeclaration(s) && !s.name && s.body && isDefault(s)) {
        addFn(b, 'default', 'default', 'function', s.body, false);
        m.exports.set('default', { kind: 'fn', qual: 'default' });
        continue;
      }
      if (ts.isClassDeclaration(s) && s.name) {
        const methods = new Map<string, string>();
        for (const mem of s.members) {
          const name = mem.name && (ts.isIdentifier(mem.name) || ts.isStringLiteral(mem.name)) ? mem.name.text : null;
          const body = ts.isMethodDeclaration(mem) ? fnBody(mem) : ts.isPropertyDeclaration(mem) && mem.initializer ? fnBody(mem.initializer) : null;
          if (name && body) {
            addFn(b, `${s.name.text}.${name}`, name, 'class-method', body, false, s.name.text);
            methods.set(name, `${s.name.text}.${name}`);
          }
        }
        m.classes.set(s.name.text, methods);
        if (exported(s)) m.exports.set(isDefault(s) ? 'default' : s.name.text, { kind: 'class', className: s.name.text });
        continue;
      }
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer) continue;
          const name = d.name.text;
          const init = d.initializer;
          const body = fnBody(init);
          if (body) {
            addFn(b, name, name, 'function', body, b.setup);
            if (exported(s)) m.exports.set(name, { kind: 'fn', qual: name });
          } else if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'defineStore') {
            storeDef(b, name, init);
            if (exported(s)) m.exports.set(name, { kind: 'store', prefix: name });
          } else if (ts.isNewExpression(init) && ts.isIdentifier(init.expression)) {
            m.instances.set(name, init.expression.text);
          } else if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === 'create'
            && ts.isIdentifier(init.expression.expression) && m.imports.get(init.expression.expression.text)?.spec === 'axios') {
            m.instances.set(name, '<axios>');
          } else {
            m.values.set(name, { expr: init, block: b });
            if (exported(s)) m.exports.set(name, { kind: 'value', expr: init, block: b });
            if (b.setup) topLevelCode.push(init);
          }
          if (!body && ts.isCallExpression(init) && !(ts.isIdentifier(init.expression) && init.expression.text === 'defineStore')) topLevelCode.push(init);
        }
        continue;
      }
      if (ts.isExportAssignment(s)) {
        const e = s.expression;
        if (ts.isNewExpression(e) && ts.isIdentifier(e.expression)) m.exports.set('default', { kind: 'instance', className: e.expression.text });
        else if (ts.isObjectLiteralExpression(e)) optionsObject(b, e);
        else if (ts.isCallExpression(e) && e.arguments[0] && ts.isObjectLiteralExpression(e.arguments[0])) optionsObject(b, e.arguments[0]);
        else if (ts.isIdentifier(e)) {
          if (m.functions.has(e.text)) m.exports.set('default', { kind: 'fn', qual: e.text });
          else if (m.instances.has(e.text)) m.exports.set('default', { kind: 'instance', className: m.instances.get(e.text)! });
          else if (m.stores.has(e.text)) m.exports.set('default', { kind: 'store', prefix: e.text });
          else if (m.classes.has(e.text)) m.exports.set('default', { kind: 'class', className: e.text });
        }
        continue;
      }
      if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause) && !s.moduleSpecifier) {
        for (const el of s.exportClause.elements) {
          const local = (el.propertyName ?? el.name).text;
          if (m.functions.has(local)) m.exports.set(el.name.text, { kind: 'fn', qual: local });
          else if (m.stores.has(local)) m.exports.set(el.name.text, { kind: 'store', prefix: local });
          else if (m.values.has(local)) m.exports.set(el.name.text, { kind: 'value', ...m.values.get(local)! });
        }
        continue;
      }
      // Top-level reassignment (`API_URL = jpEndpoint() + moduleName`): the last unconditional one wins.
      if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(s.expression.left) && m.values.has(s.expression.left.text)) {
        m.values.set(s.expression.left.text, { expr: s.expression.right, block: b });
        continue;
      }
      topLevelCode.push(s);
    }
    // values assigned inside functions are runtime-dependent
    for (const f of m.functions.values()) {
      if (f.block !== b) continue;
      const v = (n: ts.Node) => {
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && m.values.has(n.left.text)) m.reassignedLater.add(n.left.text);
        ts.forEachChild(n, v);
      };
      v(f.body);
    }
    if (topLevelCode.length) {
      // Synthetic function for top-level code: each node is walked in place (positions stay in the real source file).
      const qual = b.setup ? '<setup>' : '<module>';
      addFn(b, qual, qual, b.setup ? 'setup' : 'module', topLevelCode[0]!, false);
      m.functions.get(qual)!.extra = topLevelCode.slice(1);
    }
  }
  if (m.template) m.functions.set('<template>', { qual: '<template>', name: '<template>', role: 'template', body: m.blocks[0]?.sf ?? ts.createSourceFile(path, '', ts.ScriptTarget.Latest), block: m.blocks[0] ?? ({} as Block), templateCallable: false });
  return m;
}

function prop(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key) return p.initializer;
  }
  return undefined;
}
function propNode(obj: ts.ObjectLiteralExpression, key: string): ts.Node | undefined {
  for (const p of obj.properties) {
    const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
    if (name !== key) continue;
    if (ts.isPropertyAssignment(p)) return p.initializer;
    if (ts.isMethodDeclaration(p) || ts.isShorthandPropertyAssignment(p)) return p;
  }
  return undefined;
}

function singleReturn(body: ts.Node): ts.Expression | null {
  if (!ts.isBlock(body)) return ts.isExpression(body) ? body : null;
  const stmts = body.statements.filter((s) => !ts.isEmptyStatement(s));
  return stmts.length === 1 && ts.isReturnStatement(stmts[0]!) && stmts[0]!.expression ? stmts[0]!.expression : null;
}

export function mergeParts(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (p.t === 'lit' && last?.t === 'lit') last.v += p.v;
    else if (p.t === 'lit' && p.v === '') continue;
    else out.push({ ...p });
  }
  return out;
}

export function display(parts: Part[]): string {
  return parts.map((p) => (p.t === 'lit' ? p.v : p.t === 'base' ? '{base}' : '${?}')).join('');
}

function joinRoute(parent: string, path: string): string {
  if (path.startsWith('/')) return path;
  const p = parent.endsWith('/') ? parent : parent + '/';
  return (p + path).replace(/\/+/g, '/');
}

function walkTemplate(node: any, fn: (n: any) => void) {
  if (!node) return;
  fn(node);
  for (const c of node.children ?? []) walkTemplate(c, fn);
  for (const b of node.branches ?? []) walkTemplate(b, fn);
}

function testCases(m: Module): string[] {
  const out: string[] = [];
  for (const b of m.blocks) {
    const v = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ['describe', 'it', 'test'].includes(n.expression.text)
        && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && out.length < 60) out.push(n.arguments[0].text);
      ts.forEachChild(n, v);
    };
    v(b.sf);
  }
  return out;
}
