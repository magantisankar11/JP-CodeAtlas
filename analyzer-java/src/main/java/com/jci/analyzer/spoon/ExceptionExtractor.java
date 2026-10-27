package com.jci.analyzer.spoon;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jci.analyzer.graph.Graph;
import com.jci.analyzer.graph.Resolution;
import spoon.reflect.code.CtConstructorCall;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtFieldRead;
import spoon.reflect.code.CtNewArray;
import spoon.reflect.code.CtThrow;
import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtTypeReference;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * THROWS (method -> exception type, from throw statements and throws clauses) and HANDLES_EXCEPTION
 * (@ExceptionHandler method -> exception type, global for @ControllerAdvice, local otherwise).
 */
public final class ExceptionExtractor {

    private final Graph graph;
    private final SpoonSupport support;
    private final TypeIndex index;
    private final NodeFactory nodes;
    private final Map<String, Integer> stats = new TreeMap<>();

    public ExceptionExtractor(Graph graph, SpoonSupport support, TypeIndex index, NodeFactory nodes) {
        this.graph = graph;
        this.support = support;
        this.index = index;
        this.nodes = nodes;
    }

    public void type(CtType<?> t) {
        boolean advice = SpoonSupport.hasAnnotation(t, "ControllerAdvice", "RestControllerAdvice");
        for (CtMethod<?> m : t.getMethods()) {
            declared(m);
            CtAnnotation<?> eh = SpoonSupport.annotation(m, "ExceptionHandler");
            if (eh == null) {
                continue;
            }
            List<CtTypeReference<?>> handled = classLiterals(SpoonSupport.annotationValue(eh, "value"));
            if (handled.isEmpty()) {
                for (CtParameter<?> p : m.getParameters()) {
                    if (p.getType() != null && looksThrowable(p.getType())) {
                        handled.add(p.getType());
                    }
                }
            }
            CtAnnotation<?> status = SpoonSupport.annotation(m, "ResponseStatus");
            for (CtTypeReference<?> ex : handled) {
                ObjectNode a = Graph.attrs();
                a.put("scope", advice ? "GLOBAL" : "CONTROLLER:" + t.getQualifiedName());
                if (status != null) {
                    CtExpression<?> v = SpoonSupport.annotationValue(status, "value", "code");
                    if (v instanceof CtFieldRead<?> fr) {
                        a.put("status", fr.getVariable().getSimpleName());
                    }
                }
                graph.addEdge("HANDLES_EXCEPTION", nodes.method(m).id, typeNode(ex), Resolution.FRAMEWORK_DERIVED,
                        support.evidence(eh, "SPRING_EXCEPTION_HANDLER", Resolution.FRAMEWORK_DERIVED), a);
                stats.merge("handlers", 1, Integer::sum);
            }
        }
        if (t instanceof spoon.reflect.declaration.CtClass<?> c) {
            c.getConstructors().stream().filter(x -> !x.isImplicit()).forEach(this::declared);
        }
    }

    /** Throw statements anywhere inside a top-level type (call once per top-level type). */
    public void throwStatements(CtType<?> top) {
        for (CtThrow th : top.getElements(new spoon.reflect.visitor.filter.TypeFilter<>(CtThrow.class))) {
            SpoonSupport.Owner owner = SpoonSupport.ownerOf(th);
            if (owner == null) {
                continue;
            }
            CtExpression<?> thrown = th.getThrownExpression();
            CtTypeReference<?> type = null;
            try {
                type = thrown instanceof CtConstructorCall<?> cc ? cc.getType() : thrown.getType();
            } catch (RuntimeException ignored) {
                // unknown type
            }
            if (type == null || !type.getQualifiedName().contains(".")) {
                stats.merge("unknownThrownTypes", 1, Integer::sum);
                continue;
            }
            ObjectNode a = Graph.attrs();
            a.put("rethrow", !(thrown instanceof CtConstructorCall<?>));
            graph.addEdge("THROWS", nodes.ownerNode(owner).id, typeNode(type), Resolution.CONFIRMED,
                    support.evidence(th, "THROW_STATEMENT", Resolution.CONFIRMED), a);
            stats.merge("throwStatements", 1, Integer::sum);
        }
    }

    private void declared(CtExecutable<?> e) {
        for (CtTypeReference<?> tt : e.getThrownTypes()) {
            ObjectNode a = Graph.attrs();
            a.put("declared", true);
            graph.addEdge("THROWS", nodes.method(e).id, typeNode(tt), Resolution.CONFIRMED, support.evidence(e, "THROWS_CLAUSE", Resolution.CONFIRMED), a);
        }
    }

    private String typeNode(CtTypeReference<?> ref) {
        CtType<?> decl = index.type(SpoonSupport.erasure(ref));
        return decl != null ? nodes.type(decl).id : nodes.externalType(ref).id;
    }

    private static boolean looksThrowable(CtTypeReference<?> t) {
        String n = t.getSimpleName();
        return n.endsWith("Exception") || n.endsWith("Error") || "Throwable".equals(n);
    }

    /** {@code X.class} / {@code {X.class, Y.class}} -> type references. */
    static List<CtTypeReference<?>> classLiterals(CtExpression<?> v) {
        List<CtTypeReference<?>> out = new ArrayList<>();
        List<CtExpression<?>> items = v instanceof CtNewArray<?> arr ? new ArrayList<>(arr.getElements()) : v == null ? List.of() : List.of(v);
        for (CtExpression<?> e : items) {
            if (e instanceof CtFieldRead<?> fr && "class".equals(fr.getVariable().getSimpleName())
                    && fr.getTarget() instanceof spoon.reflect.code.CtTypeAccess<?> ta && ta.getAccessedType() != null) {
                out.add(ta.getAccessedType());
            }
        }
        return out;
    }

    public Map<String, Integer> stats() {
        return stats;
    }
}
