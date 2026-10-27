package com.jci.analyzer.spoon;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jci.analyzer.graph.Graph;
import com.jci.analyzer.graph.Graph.NodeRec;
import com.jci.analyzer.graph.Ids;
import com.jci.analyzer.sql.SchemaCatalog;

import java.util.Locale;
import java.util.Map;

/** DATABASE_TABLE / DATABASE_PROCEDURE nodes: from the migration catalog first, otherwise from what code references. */
public final class DatabaseNodes {

    private final Graph graph;
    private final SchemaCatalog catalog;
    private final String module;

    public DatabaseNodes(Graph graph, SchemaCatalog catalog, String module) {
        this.graph = graph;
        this.catalog = catalog;
        this.module = module;
    }

    public SchemaCatalog catalog() {
        return catalog;
    }

    public void emitCatalog() {
        for (SchemaCatalog.Table t : catalog.tables().values()) {
            NodeRec n = new NodeRec(Ids.table(t.name), "DATABASE_TABLE", t.name);
            n.fqn = t.name;
            n.module = module;
            n.filePath = t.file;
            n.lineStart = t.line;
            n.lineEnd = t.line;
            n.inScope = true;
            ObjectNode a = n.attrs;
            a.put("source", "MIGRATIONS");
            a.put("inCatalog", true);
            a.put("view", t.view);
            a.put("dropped", t.dropped);
            a.put("columnsKnown", t.columnsKnown);
            ArrayNode cols = a.putArray("columns");
            for (Map.Entry<String, String> c : t.columns.entrySet()) {
                ObjectNode co = cols.addObject();
                co.put("name", c.getKey());
                co.put("type", c.getValue());
            }
            ArrayNode changed = a.putArray("changedIn");
            t.changedIn.stream().limit(50).forEach(changed::add);
            if (!t.derivedColumns.isEmpty()) {
                ArrayNode d = a.putArray("columnsFromPreparedDdl");
                t.derivedColumns.forEach(d::add);
            }
            if (!t.procedureTouched.isEmpty()) {
                ArrayNode p = a.putArray("alteredByProcedureCalls");
                t.procedureTouched.stream().limit(20).forEach(p::add);
            }
            graph.putNode(n);
        }
        for (SchemaCatalog.Procedure p : catalog.procedures().values()) {
            NodeRec n = new NodeRec(procedureId(p.name()), "DATABASE_PROCEDURE", p.name());
            n.fqn = p.name();
            n.module = module;
            n.filePath = p.file();
            n.lineStart = p.line();
            n.lineEnd = p.line();
            n.inScope = true;
            n.attrs.put("routine", p.kind());
            n.attrs.put("inCatalog", true);
            graph.putNode(n);
        }
    }

    public static String procedureId(String name) {
        return "procedure:" + name.toLowerCase(Locale.ROOT);
    }

    /** Ensures a table node exists; tables unknown to the catalog are flagged so they are not mistaken for verified schema. */
    public String table(String name, String source) {
        String id = Ids.table(name);
        if (!graph.hasNode(id)) {
            NodeRec t = new NodeRec(id, "DATABASE_TABLE", name.toLowerCase(Locale.ROOT));
            t.fqn = t.name;
            t.module = module;
            t.inScope = true;
            t.attrs.put("source", source);
            t.attrs.put("inCatalog", false);
            graph.putNode(t);
        }
        return id;
    }

    public String procedure(String name) {
        String id = procedureId(name);
        if (!graph.hasNode(id)) {
            NodeRec p = new NodeRec(id, "DATABASE_PROCEDURE", name.toLowerCase(Locale.ROOT));
            p.fqn = p.name;
            p.module = module;
            p.inScope = true;
            p.attrs.put("inCatalog", false);
            graph.putNode(p);
        }
        return id;
    }
}
