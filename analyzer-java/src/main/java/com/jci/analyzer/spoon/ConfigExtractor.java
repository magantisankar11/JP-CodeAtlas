package com.jci.analyzer.spoon;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jci.analyzer.graph.Graph;
import com.jci.analyzer.graph.Graph.NodeRec;
import com.jci.analyzer.graph.Resolution;
import com.jci.analyzer.source.PropertyIndex;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtType;

import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Configuration keys the code depends on (READS_CONFIG): @Value placeholders, @ConfigurationProperties prefixes and
 * Environment lookups with constant keys. Keys and their defining files only — property values are never read.
 */
public final class ConfigExtractor implements CallGraphExtractor.SiteListener {

    private static final Set<String> ENV_TYPES = Set.of(
            "org.springframework.core.env.Environment", "org.springframework.core.env.ConfigurableEnvironment",
            "org.springframework.core.env.PropertyResolver", "org.springframework.core.env.StandardEnvironment");
    private static final Set<String> ENV_METHODS = Set.of("getProperty", "getRequiredProperty", "containsProperty");

    private final Graph graph;
    private final SpoonSupport support;
    private final NodeFactory nodes;
    private final PropertyIndex properties;
    private final Map<String, Integer> stats = new TreeMap<>();

    public ConfigExtractor(Graph graph, SpoonSupport support, NodeFactory nodes, PropertyIndex properties) {
        this.graph = graph;
        this.support = support;
        this.nodes = nodes;
        this.properties = properties;
    }

    public void type(CtType<?> t) {
        String typeId = nodes.type(t).id;
        CtAnnotation<?> cp = SpoonSupport.annotation(t, "ConfigurationProperties");
        if (cp != null) {
            String prefix = TypeIndex.literal(SpoonSupport.annotationValue(cp, "prefix", "value"));
            if (prefix != null) {
                read(typeId, prefix + ".*", t, "CONFIGURATION_PROPERTIES", null);
            }
        }
        for (CtField<?> f : t.getFields()) {
            value(typeId, f, "field", f.getSimpleName());
        }
        for (CtMethod<?> m : t.getMethods()) {
            executable(m);
        }
        if (t instanceof spoon.reflect.declaration.CtClass<?> c) {
            c.getConstructors().forEach(this::executable);
        }
    }

    private void executable(CtExecutable<?> e) {
        if (e.isImplicit()) {
            return;
        }
        String id = null;
        for (CtParameter<?> p : e.getParameters()) {
            if (SpoonSupport.hasAnnotation(p, "Value")) {
                id = id == null ? nodes.method(e).id : id;
                value(id, p, "param", p.getSimpleName());
            }
        }
        if (SpoonSupport.hasAnnotation(e, "Value")) {
            value(nodes.method(e).id, e, "method", e.getSimpleName());
        }
    }

    private void value(String ownerId, CtElement el, String point, String name) {
        CtAnnotation<?> v = SpoonSupport.annotation(el, "Value");
        if (v == null) {
            return;
        }
        String expr = TypeIndex.literal(SpoonSupport.annotationValue(v, "value"));
        String key = PropertyIndex.placeholderKey(expr);
        if (key == null) {
            count(expr != null && expr.startsWith("#{") ? "spelValues" : "nonSimpleValues");
            return;
        }
        ObjectNode a = Graph.attrs();
        a.put("point", point);
        a.put("name", name);
        a.put("hasDefault", expr.contains(":"));
        read(ownerId, key, el, "VALUE_INJECTION", a);
    }

    public void invocation(CtInvocation<?> inv, SpoonSupport.Owner owner) {
        if (!ENV_METHODS.contains(inv.getExecutable().getSimpleName()) || inv.getArguments().isEmpty()) {
            return;
        }
        String receiver = ExternalExtractor.receiverType(inv);
        if (receiver == null || !ENV_TYPES.contains(receiver)) {
            return;
        }
        String key = TypeIndex.literal(inv.getArguments().get(0));
        if (key == null) {
            count("dynamicEnvironmentKeys");
            return;
        }
        read(nodes.ownerNode(owner).id, key, inv, "ENVIRONMENT_LOOKUP", null);
    }

    private void read(String ownerId, String key, CtElement at, String rule, ObjectNode attrs) {
        String id = "config:" + key;
        if (!graph.hasNode(id)) {
            NodeRec n = new NodeRec(id, "CONFIG_PROPERTY", key);
            n.fqn = key;
            n.inScope = true;
            ArrayNode defs = n.attrs.putArray("definedIn");
            if (key.endsWith(".*")) {
                n.attrs.put("prefix", true);
            } else {
                for (PropertyIndex.Definition d : properties.definitions(key)) {
                    defs.add(d.file() + ":" + d.line());
                }
                n.attrs.put("defined", !defs.isEmpty());
            }
            graph.putNode(n);
            count("keys");
        }
        Resolution r = "ENVIRONMENT_LOOKUP".equals(rule) ? Resolution.CONFIRMED : Resolution.FRAMEWORK_DERIVED;
        graph.addEdge("READS_CONFIG", ownerId, id, r, support.evidence(at, rule, r), attrs);
    }

    private void count(String k) {
        stats.merge(k, 1, Integer::sum);
    }

    public Map<String, Integer> stats() {
        return stats;
    }
}
