package com.jci.analyzer.spoon;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jci.analyzer.graph.Evidence;
import com.jci.analyzer.graph.Graph;
import com.jci.analyzer.graph.Graph.NodeRec;
import com.jci.analyzer.graph.Ids;
import com.jci.analyzer.graph.Resolution;
import spoon.reflect.code.BinaryOperatorKind;
import spoon.reflect.code.CtAssignment;
import spoon.reflect.code.CtBinaryOperator;
import spoon.reflect.code.CtCase;
import spoon.reflect.code.CtCatch;
import spoon.reflect.code.CtConditional;
import spoon.reflect.code.CtConstructorCall;
import spoon.reflect.code.CtExecutableReferenceExpression;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtFieldAccess;
import spoon.reflect.code.CtFieldRead;
import spoon.reflect.code.CtFieldWrite;
import spoon.reflect.code.CtIf;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtLoop;
import spoon.reflect.code.CtNewClass;
import spoon.reflect.code.CtSuperAccess;
import spoon.reflect.code.CtThisAccess;
import spoon.reflect.code.CtVariableRead;
import spoon.reflect.declaration.CtClass;
import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtInterface;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.CtVariable;
import spoon.reflect.reference.CtExecutableReference;
import spoon.reflect.reference.CtTypeReference;
import spoon.reflect.visitor.filter.TypeFilter;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * CALLS edges. Every call site yields one statically bound edge (compiler binding) and, for overridable targets,
 * per-site dispatch edges to implementations, resolved by Spring bean rules or class-hierarchy analysis.
 * Method names are never matched across types.
 */
public final class CallGraphExtractor {

    private static final Set<String> LOG_NAMES = Set.of("log", "logger", "LOG", "LOGGER");
    private static final Set<String> REFLECTIVE = Set.of(
            "java.lang.reflect.Method#invoke", "java.lang.reflect.Constructor#newInstance", "java.lang.Class#forName", "java.lang.Class#newInstance");
    private static final int MAX_SAMPLES = 200;

    private final Graph graph;
    private final SpoonSupport support;
    private final TypeIndex index;
    private final NodeFactory nodes;
    private final SqlExtractor sql;
    private final Map<String, Integer> stats = new TreeMap<>();
    private final List<SiteListener> listeners = new ArrayList<>();
    private int samples;

    /** Extractors that inspect every in-scope call site (HTTP clients, config lookups, schedulers, ...). */
    public interface SiteListener {
        default void invocation(CtInvocation<?> inv, SpoonSupport.Owner owner) {
        }

        default void constructorCall(CtConstructorCall<?> cc, SpoonSupport.Owner owner) {
        }
    }

    public CallGraphExtractor listen(SiteListener l) {
        listeners.add(l);
        return this;
    }

    public CallGraphExtractor(Graph graph, SpoonSupport support, TypeIndex index, NodeFactory nodes, SqlExtractor sql) {
        this.graph = graph;
        this.support = support;
        this.index = index;
        this.nodes = nodes;
        this.sql = sql;
    }

    public void extract(CtType<?> top) {
        for (CtInvocation<?> inv : top.getElements(new TypeFilter<>(CtInvocation.class))) {
            SpoonSupport.Owner owner = SpoonSupport.ownerOf(inv);
            if (owner != null) {
                invocation(inv, owner);
            }
        }
        for (CtConstructorCall<?> cc : top.getElements(new TypeFilter<>(CtConstructorCall.class))) {
            if (cc instanceof CtNewClass<?>) {
                continue;
            }
            SpoonSupport.Owner owner = SpoonSupport.ownerOf(cc);
            if (owner != null) {
                constructorCall(cc, owner);
            }
        }
        for (CtExecutableReferenceExpression<?, ?> mr : top.getElements(new TypeFilter<>(CtExecutableReferenceExpression.class))) {
            SpoonSupport.Owner owner = SpoonSupport.ownerOf(mr);
            if (owner != null) {
                methodReference(mr, owner);
            }
        }
    }

    // ------------------------------------------------------------------ call sites

    private void invocation(CtInvocation<?> inv, SpoonSupport.Owner owner) {
        count("invocations");
        sql.inspect(inv, owner);
        for (SiteListener l : listeners) {
            l.invocation(inv, owner);
        }
        CtExecutableReference<?> ref = inv.getExecutable();
        CtExecutable<?> decl = SpoonSupport.declarationOf(ref);

        if (decl != null && !support.isInSource(decl)) {
            String key = Ids.normalizeFqn(SpoonSupport.declaringType(decl) == null ? "?" : SpoonSupport.declaringType(decl).getQualifiedName())
                    + "#" + decl.getSimpleName();
            if (REFLECTIVE.contains(key)) {
                unresolved(inv, owner, "REFLECTION", key);
            } else {
                count("library");
            }
            return;
        }
        if (decl == null && "getBean".equals(ref.getSimpleName())) {
            unresolved(inv, owner, "GET_BEAN", "getBean");
            return;
        }
        if (decl != null) {
            if (ref.isConstructor()) {
                if (!decl.isImplicit()) {
                    ObjectNode a = flow(inv, owner);
                    a.put("constructor", true);
                    edge(owner, nodes.method(decl).id, Resolution.CONFIRMED, "BINDING", inv, a);
                    count("resolvedInSource");
                }
                return;
            }
            boolean lombok = decl.getMetadata(SpoonSupport.LOMBOK_META) != null;
            Resolution r = lombok ? Resolution.FRAMEWORK_DERIVED : Resolution.CONFIRMED;
            ObjectNode a = flow(inv, owner);
            if (SpoonSupport.hasAnnotation(decl, "Async")) {
                a.put("async", true);
            }
            if (lombok) {
                a.put("lombokAccessor", true);
                count("lombokResolved");
            } else {
                count("resolvedInSource");
            }
            edge(owner, nodes.method(decl).id, r, lombok ? "LOMBOK_GENERATED" : "BINDING", inv, a);
            if (decl instanceof CtMethod<?> m) {
                dispatch(inv, owner, m, inv.getTarget(), a);
            }
            return;
        }
        unbound(inv, owner, ref);
    }

    private void constructorCall(CtConstructorCall<?> cc, SpoonSupport.Owner owner) {
        count("constructorCalls");
        for (SiteListener l : listeners) {
            l.constructorCall(cc, owner);
        }
        CtExecutable<?> decl = SpoonSupport.declarationOf(cc.getExecutable());
        if (decl == null || !support.isInSource(decl) || decl.isImplicit()) {
            return;
        }
        ObjectNode a = flow(cc, owner);
        a.put("constructor", true);
        edge(owner, nodes.method(decl).id, Resolution.CONFIRMED, "BINDING", cc, a);
        count("resolvedInSource");
    }

    private void methodReference(CtExecutableReferenceExpression<?, ?> mr, SpoonSupport.Owner owner) {
        count("methodReferences");
        CtExecutable<?> decl = SpoonSupport.declarationOf(mr.getExecutable());
        if (decl == null || !support.isInSource(decl) || decl.isImplicit()) {
            return;
        }
        ObjectNode a = flow(mr, owner);
        a.put("methodRef", true);
        a.put("deferred", true);
        boolean lombok = decl.getMetadata(SpoonSupport.LOMBOK_META) != null;
        if (lombok) {
            a.put("lombokAccessor", true);
        }
        edge(owner, nodes.method(decl).id, lombok ? Resolution.FRAMEWORK_DERIVED : Resolution.CONFIRMED, lombok ? "LOMBOK_GENERATED" : "BINDING", mr, a);
        count("resolvedInSource");
        if (decl instanceof CtMethod<?> m && !m.isStatic()) {
            dispatch(mr, owner, m, null, a);
        }
    }

    /**
     * Java lookup for an unqualified call {@code m(args)} (or {@code this.m(args)}): the enclosing class and its
     * supertypes, then outer classes. Used only when the compiler produced no binding, typically inside lambdas
     * passed to library methods whose functional type is unknown without a classpath.
     */
    static List<CtMethod<?>> lexicalCandidates(CtInvocation<?> inv, String name, int arity) {
        boolean unqualified = inv.getTarget() == null || (inv.getTarget() instanceof CtThisAccess<?> t && t.isImplicit());
        if (!unqualified) {
            return List.of();
        }
        CtType<?> scope = inv.getParent(CtType.class);
        while (scope != null) {
            List<CtMethod<?>> found = new ArrayList<>();
            for (CtMethod<?> m : scope.getAllMethods()) {
                if (m.getSimpleName().equals(name) && arityMatches(m, arity)) {
                    found.add(m);
                }
            }
            if (!found.isEmpty()) {
                return found;
            }
            scope = scope.getParent(CtType.class);
        }
        return List.of();
    }

    /** No binding: try the receiver's in-source type, else classify as library / unknown. */
    private void unbound(CtInvocation<?> inv, SpoonSupport.Owner owner, CtExecutableReference<?> ref) {
        List<CtMethod<?>> lexical = lexicalCandidates(inv, ref.getSimpleName(), inv.getArguments().size()).stream()
                .filter(support::isInSource).toList();
        if (!lexical.isEmpty()) {
            ObjectNode a = flow(inv, owner);
            boolean unique = lexical.size() == 1;
            if (!unique) {
                a.set("candidates", ids(lexical));
                a.put("reason", "OVERLOADS_WITH_SAME_ARITY");
            }
            for (CtMethod<?> m : lexical) {
                edge(owner, nodes.method(m).id, unique ? Resolution.FRAMEWORK_DERIVED : Resolution.AMBIGUOUS, "LEXICAL_SCOPE_NAME_ARITY", inv, a);
            }
            count(unique ? "lexicalResolved" : "lexicalAmbiguous");
            return;
        }
        CtTypeReference<?> dt = ref.getDeclaringType();
        if (dt == null && inv.getTarget() != null) {
            try {
                dt = inv.getTarget().getType();
            } catch (RuntimeException ignored) {
                dt = null;
            }
        }
        CtType<?> type = dt == null ? null : index.type(dt.getQualifiedName());
        if (type != null) {
            int arity = inv.getArguments().size();
            List<CtMethod<?>> cands = new ArrayList<>();
            boolean externalSuper = false;
            for (CtMethod<?> m : type.getAllMethods()) {
                if (m.getSimpleName().equals(ref.getSimpleName()) && arityMatches(m, arity)) {
                    if (support.isInSource(m)) {
                        cands.add(m);
                    } else {
                        externalSuper = true;
                    }
                }
            }
            ObjectNode a = flow(inv, owner);
            if (cands.size() == 1 && cands.get(0).getMetadata(SpoonSupport.LOMBOK_META) != null) {
                a.put("lombokAccessor", true);
                edge(owner, nodes.method(cands.get(0)).id, Resolution.FRAMEWORK_DERIVED, "LOMBOK_NAME_ARITY", inv, a);
                count("lombokResolved");
                return;
            }
            if (!cands.isEmpty()) {
                a.put("reason", "ARG_TYPES_UNRESOLVED");
                a.set("candidates", ids(cands));
                for (CtMethod<?> m : cands) {
                    edge(owner, nodes.method(m).id, Resolution.AMBIGUOUS, "RECEIVER_TYPE_NAME_ARITY", inv, a);
                }
                count("ambiguousArgTypes");
                return;
            }
            if (externalSuper || hasExternalSupertype(type)) {
                count("libraryUnbound");
                return;
            }
            unresolved(inv, owner, "NO_MATCHING_DECLARATION", Ids.normalizeFqn(type.getQualifiedName()) + "#" + ref.getSimpleName());
            return;
        }
        if (dt != null && dt.getQualifiedName().contains(".")) {
            count("libraryUnbound");
            return;
        }
        if (isLombokLogger(inv)) {
            count("library");
            return;
        }
        count("unknownReceiver");
        if (samples++ < MAX_SAMPLES) {
            graph.diagnostic("INFO", "UNKNOWN_RECEIVER", "Call '" + ref.getSimpleName() + "' has no resolvable receiver type (likely a library type missing from the classpath)",
                    support.relPath(inv), SpoonSupport.line(inv));
        }
    }

    private boolean hasExternalSupertype(CtType<?> t) {
        for (CtTypeReference<?> s : TypeIndex.supertypes(t)) {
            CtType<?> d = index.type(s.getQualifiedName());
            if (d == null || hasExternalSupertype(d)) {
                return true;
            }
        }
        return false;
    }

    private static boolean arityMatches(CtMethod<?> m, int arity) {
        int n = m.getParameters().size();
        if (n == arity) {
            return true;
        }
        return n > 0 && m.getParameters().get(n - 1).isVarArgs() && arity >= n - 1;
    }

    private boolean isLombokLogger(CtInvocation<?> inv) {
        if (!(inv.getTarget() instanceof CtVariableRead<?> vr)) {
            return false;
        }
        if (!LOG_NAMES.contains(vr.getVariable().getSimpleName())) {
            return false;
        }
        CtType<?> t = inv.getParent(CtType.class);
        while (t != null) {
            if (SpoonSupport.hasAnnotation(t, "Slf4j", "Log4j2", "Log4j", "Log", "CommonsLog", "XSlf4j", "JBossLog", "Flogger")) {
                return true;
            }
            t = t.getParent(CtType.class);
        }
        return false;
    }

    // ------------------------------------------------------------------ dispatch

    private record Candidate(CtType<?> concrete, CtMethod<?> impl) {
    }

    private record InjectionPoint(String name, String qualifier, boolean injected) {
    }

    private void dispatch(CtElement site, SpoonSupport.Owner owner, CtMethod<?> m, CtExpression<?> target, ObjectNode baseAttrs) {
        if (m.isStatic() || m.isPrivate() || m.isFinal() || target instanceof CtSuperAccess<?>) {
            return;
        }
        CtType<?> declaring = m.getDeclaringType();
        if (declaring == null || (declaring.isFinal() && !(declaring instanceof CtInterface<?>))) {
            return;
        }
        List<Candidate> cands = new ArrayList<>();
        List<CtType<?>> receivers = new ArrayList<>();
        if (TypeIndex.isConcrete(declaring)) {
            receivers.add(declaring);
        }
        for (String sub : index.subtypesOf(declaring.getQualifiedName())) {
            CtType<?> s = index.type(sub);
            if (s != null && TypeIndex.isConcrete(s)) {
                receivers.add(s);
            }
        }
        for (CtType<?> c : receivers) {
            CtMethod<?> impl = index.implementationIn(c, m);
            if (impl != null && !impl.isAbstract()) {
                cands.add(new Candidate(c, impl));
            }
        }
        if (cands.stream().allMatch(c -> c.impl() == m)) {
            return;
        }
        boolean concreteTarget = m.getBody() != null;
        InjectionPoint ip = injectionPoint(target, owner);
        boolean ownerIsBean = index.isBean(owner.type());

        List<Candidate> chosen = cands;
        Resolution res;
        String rule;
        String reason = null;
        if (ip != null && ip.injected() && ownerIsBean) {
            List<Candidate> beans = cands.stream().filter(c -> index.isBean(c.concrete())).toList();
            List<Candidate> q = ip.qualifier() == null ? List.of() : beans.stream().filter(c -> {
                TypeIndex.BeanInfo b = index.bean(c.concrete());
                return b.name().equals(ip.qualifier()) || b.qualifiers().contains(ip.qualifier());
            }).toList();
            List<Candidate> primary = beans.stream().filter(c -> index.bean(c.concrete()).primary()).toList();
            List<Candidate> byName = beans.stream().filter(c -> index.bean(c.concrete()).name().equals(ip.name())).toList();
            if (ip.qualifier() != null && q.size() == 1) {
                chosen = q;
                res = Resolution.FRAMEWORK_DERIVED;
                rule = "QUALIFIER";
            } else if (ip.qualifier() != null) {
                chosen = beans.isEmpty() ? cands : beans;
                res = Resolution.AMBIGUOUS;
                rule = "QUALIFIER_NO_UNIQUE_MATCH";
                reason = "QUALIFIER_NO_UNIQUE_MATCH";
            } else if (beans.size() == 1) {
                chosen = beans;
                res = Resolution.FRAMEWORK_DERIVED;
                rule = "SINGLE_BEAN";
            } else if (primary.size() == 1) {
                chosen = primary;
                res = Resolution.FRAMEWORK_DERIVED;
                rule = "PRIMARY_BEAN";
            } else if (byName.size() == 1) {
                chosen = byName;
                res = Resolution.FRAMEWORK_DERIVED;
                rule = "INJECTION_POINT_NAME";
            } else if (beans.isEmpty()) {
                res = Resolution.AMBIGUOUS;
                rule = "NO_BEAN_CANDIDATE";
                reason = "NO_IN_SOURCE_BEAN (may be produced by an @Bean method)";
            } else {
                chosen = beans;
                res = Resolution.AMBIGUOUS;
                rule = "MULTIPLE_BEANS";
                reason = "MULTIPLE_BEANS";
            }
            // A @Bean method with an unknown product may also satisfy this injection point: do not narrow.
            List<TypeIndex.OpaqueFactory> opaque = index.opaqueFactoriesFor(declaring.getQualifiedName());
            // A qualifier or injection-point name that selects a known bean by name stays valid unless an opaque
            // factory registers that same name; type-only rules (single bean, @Primary) gain an unknown candidate.
            boolean nameSelects = ("QUALIFIER".equals(rule) && opaque.stream().noneMatch(f -> f.name().equals(ip.qualifier())))
                    || ("INJECTION_POINT_NAME".equals(rule) && opaque.stream().noneMatch(f -> f.name().equals(ip.name())));
            if (!opaque.isEmpty() && res == Resolution.FRAMEWORK_DERIVED && !nameSelects) {
                res = Resolution.AMBIGUOUS;
                reason = "BEAN_FACTORY_UNKNOWN_PRODUCT: " + String.join(", ", opaque.stream().map(TypeIndex.OpaqueFactory::methodId).toList());
                rule = "OPAQUE_BEAN_FACTORY";
            }
        } else if (!concreteTarget && distinctImpls(cands) == 1) {
            res = Resolution.FRAMEWORK_DERIVED;
            rule = "CHA_SINGLE_IMPL";
        } else {
            res = Resolution.AMBIGUOUS;
            rule = concreteTarget ? "CHA_OVERRIDE_MAY_APPLY" : "CHA_MULTIPLE_IMPLS";
            reason = rule;
        }
        Map<String, CtMethod<?>> impls = new LinkedHashMap<>();
        for (Candidate c : chosen) {
            impls.putIfAbsent(SpoonSupport.methodId(c.impl()), c.impl());
        }
        String staticId = SpoonSupport.methodId(m);
        ArrayNode candidateIds = graph.mapper().createArrayNode();
        impls.keySet().forEach(candidateIds::add);
        for (Map.Entry<String, CtMethod<?>> e : impls.entrySet()) {
            if (e.getValue() == m) {
                continue;
            }
            ObjectNode a = baseAttrs.deepCopy();
            a.put("viaDispatch", staticId);
            a.put("dispatchRule", rule);
            if (SpoonSupport.hasAnnotation(e.getValue(), "Async")) {
                a.put("async", true);
            }
            if (res == Resolution.AMBIGUOUS) {
                a.set("candidates", candidateIds);
                a.put("reason", reason);
            }
            edge(owner, nodes.method(e.getValue()).id, res, rule, site, a);
            count(res == Resolution.AMBIGUOUS ? "dispatchAmbiguous" : "dispatchDerived");
        }
    }

    private static int distinctImpls(List<Candidate> cands) {
        return (int) cands.stream().map(c -> SpoonSupport.methodId(c.impl())).distinct().count();
    }

    /** Spring injection point behind a receiver expression (field injection, constructor injection or Lombok constructor). */
    private InjectionPoint injectionPoint(CtExpression<?> target, SpoonSupport.Owner owner) {
        if (!(target instanceof CtFieldRead<?> fr) || (fr.getTarget() != null && !(fr.getTarget() instanceof CtThisAccess<?>))) {
            return null;
        }
        CtField<?> f;
        try {
            f = fr.getVariable().getFieldDeclaration();
        } catch (RuntimeException e) {
            return null;
        }
        if (f == null || f.isStatic()) {
            return null;
        }
        if (SpoonSupport.annotationNames(f).stream().anyMatch(TypeExtractor.INJECT_ANNOTATIONS::contains)) {
            return new InjectionPoint(f.getSimpleName(), TypeExtractor.qualifier(f), true);
        }
        CtType<?> t = f.getDeclaringType();
        if (t instanceof CtClass<?> c) {
            CtConstructor<?> ctor = TypeExtractor.injectionConstructor(c);
            if (ctor != null && ctor.getBody() != null) {
                for (CtAssignment<?, ?> as : ctor.getBody().getElements(new TypeFilter<>(CtAssignment.class))) {
                    if (as.getAssigned() instanceof CtFieldWrite<?> fw && fw.getVariable().getSimpleName().equals(f.getSimpleName())
                            && as.getAssignment() instanceof CtVariableRead<?> vr) {
                        CtVariable<?> v;
                        try {
                            v = vr.getVariable().getDeclaration();
                        } catch (RuntimeException e) {
                            v = null;
                        }
                        if (v instanceof CtParameter<?> p && ctor.getParameters().contains(p)) {
                            return new InjectionPoint(p.getSimpleName(), TypeExtractor.qualifier(p), true);
                        }
                    }
                }
            }
            if (ctor == null && f.getDefaultExpression() == null
                    && (SpoonSupport.hasAnnotation(c, "AllArgsConstructor") || (f.isFinal() && SpoonSupport.hasAnnotation(c, "RequiredArgsConstructor")))) {
                return new InjectionPoint(f.getSimpleName(), TypeExtractor.qualifier(f), true);
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ helpers

    private void unresolved(CtElement site, SpoonSupport.Owner owner, String reason, String hint) {
        int line = SpoonSupport.line(site);
        int col = SpoonSupport.column(site);
        String id = Ids.unresolved(reason, owner.id(), line, col);
        NodeRec n = new NodeRec(id, "UNRESOLVED", reason.toLowerCase().replace('_', ' ') + ": " + hint);
        n.filePath = support.relPath(site);
        n.lineStart = line;
        n.lineEnd = SpoonSupport.endLine(site);
        n.inScope = true;
        n.attrs.put("reason", reason);
        n.attrs.put("hint", hint);
        graph.putNode(n);
        ObjectNode a = flow(site, owner);
        a.put("reason", reason);
        edge(owner, id, Resolution.UNRESOLVED, reason, site, a);
        count("unresolved");
    }

    private void edge(SpoonSupport.Owner owner, String dst, Resolution res, String rule, CtElement site, ObjectNode attrs) {
        NodeRec src = nodes.ownerNode(owner);
        NodeRec target = graph.node(dst);
        if (target != null && target.attrs.has("accessor")) {
            attrs.put("accessor", true);
        }
        Evidence ev = support.evidence(site, rule, res);
        graph.addEdge("CALLS", src.id, dst, res, ev, attrs);
    }

    /** Control-flow context of a call site, relative to its owning method. */
    private static ObjectNode flow(CtElement site, SpoonSupport.Owner owner) {
        ObjectNode a = Graph.attrs();
        boolean conditional = false;
        boolean loop = false;
        boolean inCatch = false;
        CtElement child = site;
        CtElement cur = site.isParentInitialized() ? site.getParent() : null;
        while (cur != null && cur != owner.element()) {
            if (cur instanceof CtIf ifs && (child == ifs.getThenStatement() || child == ifs.getElseStatement())) {
                conditional = true;
            } else if (cur instanceof CtConditional<?> c && (child == c.getThenExpression() || child == c.getElseExpression())) {
                conditional = true;
            } else if (cur instanceof CtCase<?>) {
                conditional = true;
            } else if (cur instanceof CtLoop l && child == l.getBody()) {
                loop = true;
                conditional = true;
            } else if (cur instanceof CtCatch) {
                inCatch = true;
                conditional = true;
            } else if (cur instanceof CtBinaryOperator<?> b && (b.getKind() == BinaryOperatorKind.AND || b.getKind() == BinaryOperatorKind.OR)
                    && child == b.getRightHandOperand()) {
                conditional = true;
            }
            child = cur;
            cur = cur.isParentInitialized() ? cur.getParent() : null;
        }
        a.put("conditional", conditional);
        if (loop) {
            a.put("inLoop", true);
        }
        if (inCatch) {
            a.put("inCatch", true);
        }
        if (owner.inLambda()) {
            a.put("inLambda", true);
        }
        if (owner.inAnonymousClass()) {
            a.put("inAnonymousClass", true);
        }
        return a;
    }

    private ArrayNode ids(List<CtMethod<?>> methods) {
        ArrayNode arr = graph.mapper().createArrayNode();
        methods.forEach(m -> arr.add(SpoonSupport.methodId(m)));
        return arr;
    }

    private void count(String key) {
        stats.merge(key, 1, Integer::sum);
    }

    public Map<String, Integer> stats() {
        return stats;
    }

    static boolean isFieldAccess(CtExpression<?> e) {
        return e instanceof CtFieldAccess<?>;
    }
}
