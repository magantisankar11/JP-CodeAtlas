package com.jci.analyzer.spoon;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jci.analyzer.graph.Graph;
import com.jci.analyzer.graph.Graph.NodeRec;
import com.jci.analyzer.graph.Ids;
import com.jci.analyzer.graph.Resolution;
import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtClass;
import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtInterface;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtTypeReference;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** Type and method nodes, EXTENDS / IMPLEMENTS, and Spring injection (INJECTS) for in-scope types. */
public final class TypeExtractor {

    static final Set<String> INJECT_ANNOTATIONS = Set.of("Autowired", "Inject", "Resource");
    private static final Set<String> WRAPPERS = Set.of(
            "java.util.List", "java.util.Set", "java.util.Collection", "java.util.Map", "java.util.Optional",
            "org.springframework.beans.factory.ObjectProvider", "jakarta.inject.Provider", "javax.inject.Provider");

    private final Graph graph;
    private final SpoonSupport support;
    private final TypeIndex index;
    private final NodeFactory nodes;

    public TypeExtractor(Graph graph, SpoonSupport support, TypeIndex index, NodeFactory nodes) {
        this.graph = graph;
        this.support = support;
        this.index = index;
        this.nodes = nodes;
    }

    public void extract(CtType<?> t) {
        NodeRec tn = nodes.type(t);
        for (CtMethod<?> m : t.getMethods()) {
            nodes.method(m);
        }
        if (t instanceof CtClass<?> c) {
            for (CtConstructor<?> ctor : c.getConstructors()) {
                if (!ctor.isImplicit()) {
                    nodes.method(ctor);
                }
            }
        }
        hierarchy(t, tn);
        if (index.isBean(t)) {
            injections(t, tn);
        }
    }

    private void hierarchy(CtType<?> t, NodeRec tn) {
        CtTypeReference<?> sup = t.getSuperclass();
        if (sup != null && !"java.lang.Object".equals(sup.getQualifiedName())) {
            graph.addEdge("EXTENDS", tn.id, target(sup), Resolution.CONFIRMED, support.evidence(t, "DECLARATION", Resolution.CONFIRMED), null);
        }
        for (CtTypeReference<?> i : t.getSuperInterfaces()) {
            String kind = t instanceof CtInterface<?> ? "EXTENDS" : "IMPLEMENTS";
            graph.addEdge(kind, tn.id, target(i), Resolution.CONFIRMED, support.evidence(t, "DECLARATION", Resolution.CONFIRMED), null);
        }
    }

    private String target(CtTypeReference<?> ref) {
        CtType<?> decl = index.type(ref.getQualifiedName());
        return decl != null ? nodes.type(decl).id : nodes.externalType(ref).id;
    }

    private void injections(CtType<?> t, NodeRec tn) {
        Set<String> external = new LinkedHashSet<>();
        for (CtField<?> f : t.getFields()) {
            if (!f.isStatic() && SpoonSupport.annotationNames(f).stream().anyMatch(INJECT_ANNOTATIONS::contains)) {
                inject(tn, f.getType(), "field", f.getSimpleName(), qualifier(f), f, external);
            }
        }
        if (t instanceof CtClass<?> c) {
            CtConstructor<?> ctor = injectionConstructor(c);
            if (ctor != null) {
                for (CtParameter<?> p : ctor.getParameters()) {
                    inject(tn, p.getType(), "constructor", p.getSimpleName(), qualifier(p), p, external);
                }
            } else if (SpoonSupport.hasAnnotation(c, "RequiredArgsConstructor", "AllArgsConstructor")) {
                boolean all = SpoonSupport.hasAnnotation(c, "AllArgsConstructor");
                for (CtField<?> f : c.getFields()) {
                    if (!f.isStatic() && f.getDefaultExpression() == null && (all || f.isFinal())) {
                        inject(tn, f.getType(), "lombok-constructor", f.getSimpleName(), qualifier(f), f, external);
                    }
                }
            }
        }
        if (!external.isEmpty()) {
            ArrayNode arr = tn.attrs.putArray("externalDependencies");
            external.forEach(arr::add);
        }
    }

    /** Spring picks the @Autowired constructor, or the only declared one. */
    public static CtConstructor<?> injectionConstructor(CtClass<?> c) {
        List<CtConstructor<?>> ctors = c.getConstructors().stream().filter(x -> !x.isImplicit()).<CtConstructor<?>>map(x -> x).toList();
        for (CtConstructor<?> x : ctors) {
            if (SpoonSupport.hasAnnotation(x, "Autowired", "Inject")) {
                return x;
            }
        }
        return ctors.size() == 1 && !ctors.get(0).getParameters().isEmpty() ? ctors.get(0) : null;
    }

    public static String qualifier(CtElement e) {
        CtAnnotation<?> q = SpoonSupport.annotation(e, "Qualifier");
        if (q == null) {
            q = SpoonSupport.annotation(e, "Named");
        }
        String v = q == null ? null : TypeIndex.literal(SpoonSupport.annotationValue(q, "value"));
        if (v == null) {
            CtAnnotation<?> r = SpoonSupport.annotation(e, "Resource");
            v = r == null ? null : TypeIndex.literal(SpoonSupport.annotationValue(r, "name"));
        }
        return v;
    }

    private void inject(NodeRec owner, CtTypeReference<?> type, String point, String name, String qualifier, CtElement at, Set<String> external) {
        if (type == null) {
            return;
        }
        CtTypeReference<?> target = type;
        String wrapper = null;
        String erased = SpoonSupport.erasure(type);
        if (WRAPPERS.contains(erased) && !type.getActualTypeArguments().isEmpty()) {
            List<CtTypeReference<?>> args = type.getActualTypeArguments();
            target = args.get(args.size() - 1);
            wrapper = erased;
        }
        CtType<?> decl = index.type(SpoonSupport.erasure(target));
        if (decl == null) {
            external.add(SpoonSupport.typeString(type));
            return;
        }
        ObjectNode a = Graph.attrs();
        a.put("point", point);
        a.put("name", name);
        if (qualifier != null) {
            a.put("qualifier", qualifier);
        }
        if (wrapper != null) {
            a.put("wrapper", wrapper);
        }
        graph.addEdge("INJECTS", owner.id, nodes.type(decl).id, Resolution.FRAMEWORK_DERIVED,
                support.evidence(at, "SPRING_DI", Resolution.FRAMEWORK_DERIVED), a);
    }

    static String id(CtType<?> t) {
        return Ids.type(t.getQualifiedName());
    }
}
