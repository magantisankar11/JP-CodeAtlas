package com.jci.analyzer.graph;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** In-memory graph with merge semantics, written once as NDJSON (snapshot line first). */
public final class Graph {

    public static final String SCHEMA_VERSION = "1.1.0";

    /** Boolean edge attributes that only hold if they hold at every call site. */
    private static final Set<String> ALL_SITES_KEYS = Set.of("conditional", "inLoop", "inCatch", "inLambda", "inAnonymousClass");

    private static final int MAX_EVIDENCE = 25;

    private final ObjectMapper mapper = new ObjectMapper();
    private final Map<String, NodeRec> nodes = new LinkedHashMap<>();
    private final Map<String, EdgeRec> edges = new LinkedHashMap<>();
    private final List<ObjectNode> diagnostics = new ArrayList<>();

    public static ObjectNode attrs() {
        return JsonNodeFactory.instance.objectNode();
    }

    /** Full node; replaces an earlier stub with the same id. */
    public NodeRec putNode(NodeRec node) {
        NodeRec existing = nodes.get(node.id);
        if (existing == null || (existing.stub && !node.stub)) {
            nodes.put(node.id, node);
            return node;
        }
        if (node.inScope && !existing.inScope) {
            existing.inScope = true;
        }
        return existing;
    }

    public boolean hasNode(String id) {
        return nodes.containsKey(id);
    }

    public NodeRec node(String id) {
        return nodes.get(id);
    }

    public Collection<NodeRec> nodes() {
        return nodes.values();
    }

    public Collection<EdgeRec> edges() {
        return edges.values();
    }

    public List<ObjectNode> diagnostics() {
        return diagnostics;
    }

    public EdgeRec addEdge(String kind, String src, String dst, Resolution resolution, Evidence evidence, ObjectNode attrs) {
        String id = Ids.edge(kind, src, dst);
        EdgeRec existing = edges.get(id);
        if (existing == null) {
            EdgeRec e = new EdgeRec(id, kind, src, dst, resolution, attrs == null ? attrs() : attrs.deepCopy());
            e.evidence.add(evidence);
            e.siteCount = 1;
            edges.put(id, e);
            return e;
        }
        existing.resolution = existing.resolution.strongest(resolution);
        existing.siteCount++;
        if (existing.evidence.size() < MAX_EVIDENCE && !existing.evidence.contains(evidence)) {
            existing.evidence.add(evidence);
        }
        mergeAttrs(existing.attrs, attrs);
        return existing;
    }

    private static void mergeAttrs(ObjectNode target, ObjectNode incoming) {
        if (incoming == null) {
            return;
        }
        for (String key : ALL_SITES_KEYS) {
            boolean a = target.path(key).asBoolean(false);
            boolean b = incoming.path(key).asBoolean(false);
            if (target.has(key) || incoming.has(key)) {
                target.put(key, a && b);
            }
        }
        Iterator<Map.Entry<String, com.fasterxml.jackson.databind.JsonNode>> it = incoming.fields();
        while (it.hasNext()) {
            Map.Entry<String, com.fasterxml.jackson.databind.JsonNode> f = it.next();
            if (ALL_SITES_KEYS.contains(f.getKey())) {
                continue;
            }
            if (!target.has(f.getKey())) {
                target.set(f.getKey(), f.getValue());
            } else if (f.getValue().isBoolean() && f.getValue().asBoolean()) {
                target.put(f.getKey(), true);
            }
        }
    }

    public void diagnostic(String severity, String code, String message, String filePath, Integer line) {
        ObjectNode d = mapper.createObjectNode();
        d.put("type", "diagnostic");
        d.put("severity", severity);
        d.put("code", code);
        d.put("message", message);
        if (filePath != null) {
            d.put("filePath", filePath);
        }
        if (line != null) {
            d.put("line", line);
        }
        diagnostics.add(d);
    }

    public void write(Path out, ObjectNode snapshot) throws IOException {
        Files.createDirectories(out.toAbsolutePath().getParent());
        try (BufferedWriter w = Files.newBufferedWriter(out, StandardCharsets.UTF_8)) {
            w.write(mapper.writeValueAsString(snapshot));
            w.newLine();
            for (NodeRec n : nodes.values()) {
                w.write(mapper.writeValueAsString(n.toJson(mapper)));
                w.newLine();
            }
            for (EdgeRec e : edges.values()) {
                w.write(mapper.writeValueAsString(e.toJson(mapper)));
                w.newLine();
            }
            for (ObjectNode d : diagnostics) {
                w.write(mapper.writeValueAsString(d));
                w.newLine();
            }
        }
    }

    public ObjectMapper mapper() {
        return mapper;
    }

    public static final class NodeRec {
        public final String id;
        /** Mutable only for post-pass reclassification (e.g. CLASS -> DTO). */
        public String kind;
        public final String name;
        public String fqn;
        public String signature;
        public String module;
        public String pkg;
        public String filePath;
        public Integer lineStart;
        public Integer lineEnd;
        public boolean inScope;
        /** Referenced-only placeholder; replaced when the full node is emitted. */
        public boolean stub;
        public final ObjectNode attrs = attrs();

        public NodeRec(String id, String kind, String name) {
            this.id = id;
            this.kind = kind;
            this.name = name;
        }

        ObjectNode toJson(ObjectMapper m) {
            ObjectNode o = m.createObjectNode();
            o.put("type", "node");
            o.put("id", id);
            o.put("kind", kind);
            o.put("name", name);
            putIfNotNull(o, "fqn", fqn);
            putIfNotNull(o, "signature", signature);
            putIfNotNull(o, "module", module);
            putIfNotNull(o, "package", pkg);
            putIfNotNull(o, "filePath", filePath);
            if (lineStart != null) {
                o.put("lineStart", lineStart);
            }
            if (lineEnd != null) {
                o.put("lineEnd", lineEnd);
            }
            o.put("inScope", inScope);
            o.set("attrs", attrs);
            return o;
        }
    }

    public static final class EdgeRec {
        public final String id;
        public final String kind;
        public final String src;
        public final String dst;
        public Resolution resolution;
        public final List<Evidence> evidence = new ArrayList<>();
        public final ObjectNode attrs;
        public int siteCount;

        EdgeRec(String id, String kind, String src, String dst, Resolution resolution, ObjectNode attrs) {
            this.id = id;
            this.kind = kind;
            this.src = src;
            this.dst = dst;
            this.resolution = resolution;
            this.attrs = attrs;
        }

        ObjectNode toJson(ObjectMapper m) {
            ObjectNode o = m.createObjectNode();
            o.put("type", "edge");
            o.put("id", id);
            o.put("kind", kind);
            o.put("src", src);
            o.put("dst", dst);
            o.put("resolution", resolution.name());
            ArrayNode ev = o.putArray("evidence");
            for (Evidence e : evidence) {
                ObjectNode x = ev.addObject();
                x.put("filePath", e.filePath());
                x.put("line", e.line());
                x.put("endLine", e.endLine());
                x.put("column", e.column());
                x.put("rule", e.rule());
                if (e.resolution() != null) {
                    x.put("resolution", e.resolution().name());
                }
            }
            ObjectNode a = attrs.deepCopy();
            a.put("siteCount", siteCount);
            o.set("attrs", a);
            return o;
        }
    }

    private static void putIfNotNull(ObjectNode o, String key, String value) {
        if (value != null) {
            o.put(key, value);
        }
    }
}
