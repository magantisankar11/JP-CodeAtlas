package com.jci.analyzer.spoon;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jci.analyzer.graph.Graph;
import com.jci.analyzer.graph.Graph.NodeRec;
import com.jci.analyzer.graph.Ids;
import com.jci.analyzer.graph.Resolution;
import spoon.reflect.code.CtExpression;
import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtAnnotationType;
import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtEnum;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtInterface;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtModifiable;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtRecord;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.ModifierKind;
import spoon.reflect.reference.CtTypeReference;

/** Creates METHOD and type nodes (plus DECLARES edges) on demand, so every edge endpoint has a node. */
public final class NodeFactory {

    private final Graph graph;
    private final SpoonSupport support;
    private final TypeIndex index;

    public NodeFactory(Graph graph, SpoonSupport support, TypeIndex index) {
        this.graph = graph;
        this.support = support;
        this.index = index;
    }

    public static String kindOf(CtType<?> t) {
        if (t instanceof CtAnnotationType<?>) {
            return "ANNOTATION";
        }
        if (t instanceof CtInterface<?>) {
            return "INTERFACE";
        }
        if (t instanceof CtEnum<?>) {
            return "ENUM";
        }
        if (t instanceof CtRecord) {
            return "RECORD";
        }
        if (SpoonSupport.hasAnnotation(t, "RestController", "Controller")) {
            return "CONTROLLER";
        }
        if (SpoonSupport.hasAnnotation(t, "Service")) {
            return "SERVICE";
        }
        if (SpoonSupport.hasAnnotation(t, "Repository")) {
            return "REPOSITORY";
        }
        if (SpoonSupport.hasAnnotation(t, "Configuration")) {
            return "CONFIGURATION";
        }
        if (SpoonSupport.hasAnnotation(t, "Entity")) {
            return "ENTITY";
        }
        if (SpoonSupport.hasAnnotation(t, "Component", "ControllerAdvice", "RestControllerAdvice")) {
            return "COMPONENT";
        }
        return "CLASS";
    }

    public NodeRec type(CtType<?> t) {
        String id = SpoonSupport.typeId(t);
        NodeRec existing = graph.node(id);
        if (existing != null && !existing.stub) {
            return existing;
        }
        NodeRec n = new NodeRec(id, kindOf(t), t.getSimpleName());
        n.fqn = Ids.normalizeFqn(t.getQualifiedName());
        n.pkg = SpoonSupport.packageOf(t);
        n.module = support.config().module();
        n.filePath = support.relPath(t);
        n.lineStart = SpoonSupport.line(t);
        n.lineEnd = SpoonSupport.endLine(t);
        n.inScope = support.inScope(t);
        ObjectNode a = n.attrs;
        a.set("annotations", strings(SpoonSupport.annotationNames(t)));
        a.put("abstract", t.isAbstract() && !(t instanceof CtInterface<?>));
        TypeIndex.BeanInfo bean = index.bean(t);
        if (bean != null) {
            a.put("beanName", bean.name());
            a.put("primary", bean.primary());
            if (bean.factoryMethod() != null) {
                a.put("beanFactory", bean.factoryMethod());
            }
        }
        if (t.getSuperclass() != null) {
            a.put("superClass", Ids.normalizeFqn(t.getSuperclass().getQualifiedName()));
        }
        ArrayNode ifaces = a.putArray("interfaces");
        t.getSuperInterfaces().forEach(i -> ifaces.add(Ids.normalizeFqn(i.getQualifiedName())));
        CtAnnotation<?> table = SpoonSupport.annotation(t, "Table");
        if (table != null && SpoonSupport.hasAnnotation(t, "Entity")) {
            String name = TypeIndex.literal(SpoonSupport.annotationValue(table, "name"));
            if (name != null) {
                a.put("table", name);
            }
        }
        if (SpoonSupport.hasAnnotation(t, "Transactional")) {
            a.put("transactional", true);
        }
        return graph.putNode(n);
    }

    /** Library/JDK type referenced by an edge; no source available. */
    public NodeRec externalType(CtTypeReference<?> ref) {
        String fqn = Ids.normalizeFqn(ref.getQualifiedName());
        String id = Ids.type(fqn);
        NodeRec existing = graph.node(id);
        if (existing != null) {
            return existing;
        }
        NodeRec n = new NodeRec(id, ref.isInterface() ? "INTERFACE" : "CLASS", ref.getSimpleName());
        n.fqn = fqn;
        int dot = fqn.lastIndexOf('.');
        n.pkg = dot > 0 ? fqn.substring(0, dot) : "";
        n.inScope = false;
        n.stub = true;
        n.attrs.put("external", true);
        return graph.putNode(n);
    }

    public NodeRec method(CtExecutable<?> e) {
        String id = SpoonSupport.methodId(e);
        NodeRec existing = graph.node(id);
        if (existing != null && !existing.stub) {
            return existing;
        }
        CtType<?> owner = SpoonSupport.declaringType(e);
        NodeRec n = new NodeRec(id, "METHOD", e instanceof CtConstructor<?> ? "<init>" : e.getSimpleName());
        n.fqn = Ids.normalizeFqn(owner.getQualifiedName()) + "#" + n.name;
        n.signature = signature(e);
        n.pkg = SpoonSupport.packageOf(owner);
        n.module = support.config().module();
        n.filePath = support.relPath(e);
        n.lineStart = SpoonSupport.line(e);
        n.lineEnd = SpoonSupport.endLine(e);
        n.inScope = support.inScope(owner);
        ObjectNode a = n.attrs;
        a.put("declaringType", Ids.normalizeFqn(owner.getQualifiedName()));
        a.put("constructor", e instanceof CtConstructor<?>);
        if (e instanceof CtModifiable mod) {
            ArrayNode mods = a.putArray("modifiers");
            for (ModifierKind k : mod.getModifiers()) {
                mods.add(k.toString());
            }
            a.put("abstract", mod.isAbstract() || (e instanceof CtMethod<?> m && m.getBody() == null && owner instanceof CtInterface<?> && !m.isStatic()));
        }
        if (e instanceof CtMethod<?> m) {
            a.put("returnType", SpoonSupport.typeString(m.getType()));
        }
        ArrayNode params = a.putArray("params");
        for (CtParameter<?> p : e.getParameters()) {
            ObjectNode po = params.addObject();
            po.put("name", p.getSimpleName());
            po.put("type", SpoonSupport.typeString(p.getType()));
        }
        ArrayNode thrown = a.putArray("throws");
        e.getThrownTypes().forEach(tt -> thrown.add(Ids.normalizeFqn(tt.getQualifiedName())));
        a.set("annotations", strings(SpoonSupport.annotationNames(e)));
        if (SpoonSupport.hasAnnotation(e, "Async")) {
            a.put("async", true);
        }
        if (SpoonSupport.hasAnnotation(e, "Transactional") || SpoonSupport.hasAnnotation(owner, "Transactional")) {
            a.put("transactional", true);
        }
        CtAnnotation<?> scheduled = SpoonSupport.annotation(e, "Scheduled");
        if (scheduled != null) {
            ObjectNode s = a.putObject("scheduled");
            for (String key : new String[] {"cron", "fixedRate", "fixedDelay", "fixedRateString", "fixedDelayString"}) {
                CtExpression<?> v = SpoonSupport.annotationValue(scheduled, key);
                if (v != null) {
                    String lit = TypeIndex.literal(v);
                    s.put(key, lit != null ? lit : v.toString());
                }
            }
        }
        Object lombok = e.getMetadata(SpoonSupport.LOMBOK_META);
        if (lombok != null) {
            a.put("lombok", lombok.toString());
            a.put("synthesized", true);
        }
        String accessor = SpoonSupport.trivialAccessor(e);
        if (accessor != null) {
            a.put("accessor", accessor);
        }
        graph.putNode(n);
        NodeRec typeNode = type(owner);
        Resolution r = lombok != null ? Resolution.FRAMEWORK_DERIVED : Resolution.CONFIRMED;
        graph.addEdge("DECLARES", typeNode.id, n.id, r, support.evidence(e, lombok != null ? "LOMBOK_GENERATED" : "DECLARATION", r), null);
        return n;
    }

    /** &lt;clinit&gt; / &lt;instinit&gt; owners for code in initializers and field initializers. */
    public NodeRec syntheticMethod(SpoonSupport.Owner owner) {
        NodeRec existing = graph.node(owner.id());
        if (existing != null) {
            return existing;
        }
        String name = owner.id().substring(owner.id().indexOf('#') + 1, owner.id().indexOf('('));
        NodeRec n = new NodeRec(owner.id(), "METHOD", name);
        n.fqn = Ids.normalizeFqn(owner.type().getQualifiedName()) + "#" + name;
        n.signature = name + "()";
        n.pkg = SpoonSupport.packageOf(owner.type());
        n.module = support.config().module();
        n.filePath = support.relPath(owner.type());
        n.lineStart = SpoonSupport.line(owner.type());
        n.lineEnd = SpoonSupport.endLine(owner.type());
        n.inScope = support.inScope(owner.type());
        n.attrs.put("synthetic", true);
        n.attrs.put("declaringType", n.fqn.substring(0, n.fqn.indexOf('#')));
        graph.putNode(n);
        NodeRec typeNode = type(owner.type());
        graph.addEdge("DECLARES", typeNode.id, n.id, Resolution.CONFIRMED, support.evidence(owner.element(), "DECLARATION", Resolution.CONFIRMED), null);
        return n;
    }

    public NodeRec ownerNode(SpoonSupport.Owner owner) {
        if (owner.synthetic()) {
            return syntheticMethod(owner);
        }
        return method((CtExecutable<?>) owner.element());
    }

    public static String signature(CtExecutable<?> e) {
        StringBuilder sb = new StringBuilder(e instanceof CtConstructor<?> ? "<init>" : e.getSimpleName()).append('(');
        for (int i = 0; i < e.getParameters().size(); i++) {
            if (i > 0) {
                sb.append(", ");
            }
            CtParameter<?> p = e.getParameters().get(i);
            sb.append(simplify(SpoonSupport.typeString(p.getType()))).append(' ').append(p.getSimpleName());
        }
        sb.append(')');
        if (e instanceof CtMethod<?> m) {
            sb.append(" : ").append(simplify(SpoonSupport.typeString(m.getType())));
        }
        return sb.toString();
    }

    /** Drops package prefixes for display: java.util.List<a.b.Vo> -> List<Vo>. */
    static String simplify(String type) {
        return type.replaceAll("\\b(?:[a-z_][a-z0-9_]*\\.)+([A-Z])", "$1");
    }

    private ArrayNode strings(Iterable<String> values) {
        ArrayNode arr = graph.mapper().createArrayNode();
        values.forEach(arr::add);
        return arr;
    }
}
