package com.jci.analyzer.spoon;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jci.analyzer.graph.Graph;
import com.jci.analyzer.graph.Graph.NodeRec;
import com.jci.analyzer.graph.Ids;
import com.jci.analyzer.graph.Resolution;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtInterface;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtArrayTypeReference;
import spoon.reflect.reference.CtTypeReference;
import spoon.reflect.visitor.filter.TypeFilter;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Data-contract edges: endpoint ACCEPTS / RETURNS types, type HAS_FIELD_TYPE type, method USES_TYPE type.
 * Together with CALLS and EXPOSES they answer "which endpoints are affected if this DTO/entity changes".
 * Types reachable from endpoint contracts that are plain classes are reclassified as DTO.
 */
public final class ContractExtractor {

    private static final Set<String> DTO_RECLASSIFIABLE = Set.of("CLASS", "RECORD");
    private static final int MAX_FIELDS = 200;

    private final Graph graph;
    private final SpoonSupport support;
    private final TypeIndex index;
    private final NodeFactory nodes;
    private final Map<String, String> dtoRoots = new LinkedHashMap<>();
    private final Map<String, Set<String>> fieldTypes = new LinkedHashMap<>();
    private int usesTypeEdges;

    public ContractExtractor(Graph graph, SpoonSupport support, TypeIndex index, NodeFactory nodes) {
        this.graph = graph;
        this.support = support;
        this.index = index;
        this.nodes = nodes;
    }

    /** All in-source types mentioned by a type reference, including generic arguments and array components. */
    public Set<CtType<?>> inSourceTypes(CtTypeReference<?> ref) {
        Set<CtType<?>> out = new LinkedHashSet<>();
        collect(ref, out, 0);
        return out;
    }

    private void collect(CtTypeReference<?> ref, Set<CtType<?>> out, int depth) {
        if (ref == null || depth > 6) {
            return;
        }
        if (ref instanceof CtArrayTypeReference<?> arr) {
            collect(arr.getComponentType(), out, depth + 1);
            return;
        }
        CtType<?> t = index.type(SpoonSupport.erasure(ref));
        if (t != null && !t.isAnonymous()) {
            out.add(t);
        }
        try {
            for (CtTypeReference<?> arg : ref.getActualTypeArguments()) {
                collect(arg, out, depth + 1);
            }
        } catch (RuntimeException ignored) {
            // unresolvable generic arguments contribute nothing
        }
    }

    /** Called for every endpoint after its node exists. */
    public void endpoint(String endpointId, CtMethod<?> handler, ArrayNode params) {
        for (int i = 0; i < handler.getParameters().size(); i++) {
            CtParameter<?> p = handler.getParameters().get(i);
            String source = params.get(i) == null ? "" : params.get(i).path("source").asText();
            if ("FRAMEWORK".equals(source)) {
                continue;
            }
            for (CtType<?> t : inSourceTypes(p.getType())) {
                ObjectNode a = Graph.attrs();
                a.put("param", p.getSimpleName());
                a.put("source", source);
                graph.addEdge("ACCEPTS", endpointId, nodes.type(t).id, Resolution.CONFIRMED, support.evidence(p, "SIGNATURE_TYPE", Resolution.CONFIRMED), a);
                dtoRoots.putIfAbsent(SpoonSupport.typeId(t), "BODY".equals(source) ? "REQUEST_BODY" : "REQUEST_PARAM");
            }
        }
        for (CtType<?> t : inSourceTypes(handler.getType())) {
            graph.addEdge("RETURNS", endpointId, nodes.type(t).id, Resolution.CONFIRMED, support.evidence(handler, "SIGNATURE_TYPE", Resolution.CONFIRMED), null);
            dtoRoots.putIfAbsent(SpoonSupport.typeId(t), "RESPONSE");
        }
    }

    /** Field list on the type node and HAS_FIELD_TYPE edges to in-source field types. */
    public void type(CtType<?> t) {
        NodeRec tn = nodes.type(t);
        ArrayNode fields = tn.attrs.putArray("fields");
        Set<String> targets = new LinkedHashSet<>();
        for (CtField<?> f : t.getFields()) {
            if (f.isStatic()) {
                continue;
            }
            if (fields.size() < MAX_FIELDS) {
                ObjectNode fo = fields.addObject();
                fo.put("name", f.getSimpleName());
                fo.put("type", SpoonSupport.typeString(f.getType()));
                List<String> ann = SpoonSupport.annotationNames(f);
                if (!ann.isEmpty()) {
                    ArrayNode an = fo.putArray("annotations");
                    ann.forEach(an::add);
                }
            }
            for (CtType<?> ft : inSourceTypes(f.getType())) {
                if (ft == t) {
                    continue;
                }
                ObjectNode a = Graph.attrs();
                a.put("field", f.getSimpleName());
                String ftId = nodes.type(ft).id;
                graph.addEdge("HAS_FIELD_TYPE", tn.id, ftId, Resolution.CONFIRMED, support.evidence(f, "FIELD_DECLARATION", Resolution.CONFIRMED), a);
                targets.add(ftId);
            }
        }
        fieldTypes.put(tn.id, targets);
    }

    /**
     * USES_TYPE from a method to every in-source data type it references (signature or body). Spring beans and
     * their interfaces are skipped: those dependencies are already CALLS / INJECTS edges.
     */
    public void uses(CtExecutable<?> e, String methodId) {
        CtType<?> own = SpoonSupport.declaringType(e);
        Set<String> signature = new LinkedHashSet<>();
        for (CtParameter<?> p : e.getParameters()) {
            inSourceTypes(p.getType()).forEach(t -> signature.add(SpoonSupport.typeId(t)));
        }
        if (e instanceof CtMethod<?> m) {
            inSourceTypes(m.getType()).forEach(t -> signature.add(SpoonSupport.typeId(t)));
        }
        Map<String, CtElement> first = new LinkedHashMap<>();
        Map<String, CtType<?>> decls = new LinkedHashMap<>();
        for (CtTypeReference<?> r : e.getElements(new TypeFilter<>(CtTypeReference.class))) {
            CtType<?> t;
            try {
                t = index.type(SpoonSupport.erasure(r));
            } catch (RuntimeException ex) {
                continue;
            }
            if (t == null || t == own || t.isAnonymous() || isBeanContract(t)) {
                continue;
            }
            String id = SpoonSupport.typeId(t);
            first.putIfAbsent(id, r);
            decls.putIfAbsent(id, t);
        }
        for (Map.Entry<String, CtType<?>> d : decls.entrySet()) {
            ObjectNode a = Graph.attrs();
            a.put("inSignature", signature.contains(d.getKey()));
            CtElement at = first.get(d.getKey());
            graph.addEdge("USES_TYPE", methodId, nodes.type(d.getValue()).id, Resolution.CONFIRMED,
                    support.evidence(at.getPosition().isValidPosition() ? at : e, "TYPE_REFERENCE", Resolution.CONFIRMED), a);
            usesTypeEdges++;
        }
    }

    private boolean isBeanContract(CtType<?> t) {
        if (index.isBean(t)) {
            return true;
        }
        if (t instanceof CtInterface<?>) {
            for (String sub : index.subtypesOf(t.getQualifiedName())) {
                if (index.isBean(index.type(sub))) {
                    return true;
                }
            }
        }
        return false;
    }

    /** Types reachable from endpoint contracts through fields become DTO (plain classes and records only). */
    public void classifyDtos() {
        Map<String, String> reason = new LinkedHashMap<>(dtoRoots);
        Deque<String> work = new ArrayDeque<>(dtoRoots.keySet());
        while (!work.isEmpty()) {
            String id = work.pop();
            for (String child : fieldTypes.getOrDefault(id, Set.of())) {
                if (!reason.containsKey(child)) {
                    reason.put(child, "NESTED_IN:" + id.substring("type:".length()));
                    work.add(child);
                }
            }
        }
        for (Map.Entry<String, String> r : reason.entrySet()) {
            NodeRec n = graph.node(r.getKey());
            if (n == null) {
                continue;
            }
            n.attrs.put("contractRole", r.getValue());
            if (DTO_RECLASSIFIABLE.contains(n.kind)) {
                n.kind = "DTO";
            }
        }
    }

    public int usesTypeEdges() {
        return usesTypeEdges;
    }

    static String id(CtType<?> t) {
        return Ids.type(t.getQualifiedName());
    }
}
