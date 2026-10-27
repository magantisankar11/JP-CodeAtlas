package com.jci.analyzer.spoon;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jci.analyzer.graph.Graph;
import com.jci.analyzer.graph.Graph.NodeRec;
import com.jci.analyzer.graph.Ids;
import com.jci.analyzer.graph.Resolution;
import com.jci.analyzer.sql.SqlTables;
import com.jci.analyzer.util.Redactor;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtLambda;
import spoon.reflect.code.CtFieldRead;
import spoon.reflect.reference.CtTypeReference;

import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * SQL sinks (EntityManager / Hibernate Session / JdbcTemplate / JDBC) -> SQL_STATEMENT nodes, QUERIES edges and,
 * only for fully resolved text, READS / WRITES edges to tables.
 *
 * QUERIES resolution: CONFIRMED = receiver type known to be a SQL API and text fully constant;
 * FRAMEWORK_DERIVED = text constant but API recognised by its distinctive method name only;
 * UNRESOLVED = text built at runtime (fragments kept as evidence, no tables derived).
 */
public final class SqlExtractor {

    private static final Set<String> SQL_TYPES = Set.of(
            "jakarta.persistence.EntityManager", "javax.persistence.EntityManager",
            "org.hibernate.Session", "org.hibernate.SharedSessionContract", "org.hibernate.StatelessSession", "org.hibernate.query.QueryProducer",
            "org.springframework.jdbc.core.JdbcTemplate", "org.springframework.jdbc.core.JdbcOperations",
            "org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate", "org.springframework.jdbc.core.namedparam.NamedParameterJdbcOperations",
            "java.sql.Connection", "java.sql.Statement", "java.sql.PreparedStatement");
    private static final Set<String> DISTINCTIVE = Set.of(
            "createNativeQuery", "createSQLQuery", "createNativeMutationQuery", "prepareStatement", "prepareCall",
            "queryForList", "queryForObject", "queryForMap", "queryForRowSet", "queryForStream", "batchUpdate");
    private static final Set<String> GENERIC = Set.of(
            "createQuery", "createMutationQuery", "createSelectionQuery", "query", "update", "execute",
            "executeQuery", "executeUpdate", "executeLargeUpdate", "addBatch");
    private static final Set<String> JPQL = Set.of("createQuery", "createMutationQuery", "createSelectionQuery");
    private static final Set<String> STRINGY = Set.of("java.lang.String", "java.lang.CharSequence", "java.lang.StringBuilder", "java.lang.StringBuffer");
    private static final int MAX_SQL = 4000;

    private final Graph graph;
    private final SpoonSupport support;
    private final NodeFactory nodes;
    private final Map<String, String> entityTables;
    private final ConstantFolder folder = new ConstantFolder();
    private final Map<String, Integer> stats = new TreeMap<>();

    private final DatabaseNodes db;

    /** @param entityTables entity simple name -> table name, used for JPQL */
    public SqlExtractor(Graph graph, SpoonSupport support, NodeFactory nodes, Map<String, String> entityTables, DatabaseNodes db) {
        this.graph = graph;
        this.support = support;
        this.nodes = nodes;
        this.entityTables = entityTables;
        this.db = db;
    }

    public void inspect(CtInvocation<?> inv, SpoonSupport.Owner owner) {
        String name = inv.getExecutable().getSimpleName();
        if (!DISTINCTIVE.contains(name) && !GENERIC.contains(name)) {
            return;
        }
        if (inv.getArguments().isEmpty()) {
            return;
        }
        String receiver = receiverType(inv);
        boolean apiConfirmed = receiver != null && SQL_TYPES.contains(receiver);
        if (!apiConfirmed && !DISTINCTIVE.contains(name)) {
            return;
        }
        CtExpression<?> arg = inv.getArguments().get(0);
        if (arg instanceof CtLambda<?> || (arg instanceof CtFieldRead<?> fr && "class".equals(fr.getVariable().getSimpleName()))) {
            return;
        }
        // A known non-text first argument (e.g. a PreparedStatementCreator) is not SQL; unknown types are kept.
        CtTypeReference<?> argType = safeType(arg);
        if (argType != null && argType.getQualifiedName().contains(".") && !STRINGY.contains(argType.getQualifiedName())) {
            return;
        }
        ConstantFolder.Result folded = folder.fold(arg);
        boolean jpql = JPQL.contains(name);
        int line = SpoonSupport.line(inv);
        int col = SpoonSupport.column(inv);
        String sqlId = Ids.sql(owner.id(), line, col);
        NodeRec ownerNode = nodes.ownerNode(owner);

        NodeRec n = new NodeRec(sqlId, "SQL_STATEMENT", (jpql ? "JPQL " : "SQL ") + "@" + line);
        n.module = support.config().module();
        n.pkg = ownerNode.pkg;
        n.filePath = support.relPath(inv);
        n.lineStart = line;
        n.lineEnd = SpoonSupport.endLine(inv);
        n.inScope = ownerNode.inScope;
        ObjectNode a = n.attrs;
        a.put("api", (receiver == null ? "?" : simple(receiver)) + "." + name);
        a.put("language", jpql ? "JPQL" : "SQL");
        a.put("resolved", folded.complete());
        Resolution res;
        SqlTables.Result tables = null;
        Map<String, VariantTable> variantTables = null;
        if (folded.complete()) {
            String sql = folded.value();
            tables = jpql ? null : SqlTables.analyze(sql);
            String redacted = Redactor.redact(sql);
            a.put("sql", truncate(redacted, a));
            a.put("operation", tables != null ? tables.operation() : SqlTables.leadingKeyword(sql));
            if (tables != null && tables.procedure() != null) {
                a.put("procedure", tables.procedure());
            }
            if (tables != null && !tables.parsed()) {
                a.put("parseError", tables.error());
                count("parseFailed");
                graph.diagnostic("INFO", "SQL_PARSE_FAILED", tables.error(), n.filePath, line);
            }
            res = apiConfirmed ? Resolution.CONFIRMED : Resolution.FRAMEWORK_DERIVED;
            count("resolved");
        } else {
            ArrayNode frags = a.putArray("fragments");
            folded.fragments().forEach(f -> frags.add(Redactor.redact(f)));
            a.put("reason", folded.reason());
            a.put("operation", folded.fragments().isEmpty() || ConstantFolder.DYNAMIC.equals(folded.fragments().get(0))
                    ? "UNKNOWN" : SqlTables.leadingKeyword(folded.fragments().get(0)));
            res = Resolution.UNRESOLVED;
            if (folded.variants() != null && !jpql) {
                variantTables = variantTables(folded.variants(), a);
                if (variantTables != null) {
                    res = Resolution.FRAMEWORK_DERIVED;
                    count("resolvedByVariants");
                }
            }
            if (res == Resolution.UNRESOLVED) {
                count("unresolved");
            }
        }
        graph.putNode(n);
        ObjectNode ea = Graph.attrs();
        ea.put("api", a.get("api").asText());
        if (!apiConfirmed) {
            ea.put("apiMatchedByName", true);
        }
        if (variantTables != null) {
            ea.put("variantExpansion", true);
        }
        graph.addEdge("QUERIES", ownerNode.id, sqlId, res, support.evidence(inv,
                variantTables != null ? "SQL_VARIANTS" : apiConfirmed ? "SQL_API_RECEIVER" : "SQL_API_NAME", res), ea);

        if (tables != null && tables.procedure() != null) {
            graph.addEdge("INVOKES_PROCEDURE", sqlId, db.procedure(tables.procedure()), res, support.evidence(inv, "SQL_PARSE", res), null);
        }
        if (tables != null && tables.parsed()) {
            for (SqlTables.TableAccess t : tables.tables()) {
                tableEdge(sqlId, t.table(), t.write(), res, inv, null);
            }
        } else if (jpql && folded.complete()) {
            jpqlEntities(sqlId, folded.value(), inv);
        } else if (variantTables != null) {
            int total = a.path("variants").asInt();
            for (VariantTable vt : variantTables.values()) {
                ObjectNode ta = Graph.attrs();
                ta.put("inAllVariants", vt.count == a.path("variantsParsed").asInt() && vt.count == total);
                ta.put("conditional", !ta.path("inAllVariants").asBoolean());
                ta.put("variantCount", vt.count);
                tableEdge(sqlId, vt.table, vt.write, Resolution.FRAMEWORK_DERIVED, inv, ta);
            }
        }
    }

    private static final class VariantTable {
        final String table;
        boolean write;
        int count;

        VariantTable(String table) {
            this.table = table;
        }
    }

    /** Parses each SQL variant; null when none parses (then nothing is derived). */
    private Map<String, VariantTable> variantTables(java.util.List<String> variants, ObjectNode a) {
        Map<String, VariantTable> out = new java.util.LinkedHashMap<>();
        int parsed = 0;
        ArrayNode texts = a.putArray("sqlVariants");
        for (String v : variants) {
            if (texts.size() < 8) {
                texts.add(truncate(Redactor.redact(v), Graph.attrs()));
            }
            SqlTables.Result r = SqlTables.analyze(v);
            if (!r.parsed()) {
                continue;
            }
            parsed++;
            for (SqlTables.TableAccess t : r.tables()) {
                VariantTable vt = out.computeIfAbsent(t.table(), VariantTable::new);
                vt.count++;
                vt.write |= t.write();
            }
        }
        a.put("variants", variants.size());
        a.put("variantsParsed", parsed);
        if (parsed == 0) {
            return null;
        }
        a.put("enumerated", true);
        return out;
    }

    /** JPQL names entities, not tables: map known entity names via @Table (FRAMEWORK_DERIVED). */
    private void jpqlEntities(String sqlId, String jpql, CtInvocation<?> inv) {
        String op = SqlTables.leadingKeyword(jpql);
        boolean write = Set.of("UPDATE", "DELETE", "INSERT").contains(op);
        for (Map.Entry<String, String> e : entityTables.entrySet()) {
            if (jpql.matches("(?s).*\\b" + java.util.regex.Pattern.quote(e.getKey()) + "\\b.*")) {
                ObjectNode a = Graph.attrs();
                a.put("viaEntity", e.getKey());
                tableEdge(sqlId, e.getValue(), write, Resolution.FRAMEWORK_DERIVED, inv, a);
            }
        }
    }

    private void tableEdge(String sqlId, String table, boolean write, Resolution res, CtInvocation<?> inv, ObjectNode attrs) {
        String id = db.table(table, "SQL_TEXT");
        graph.addEdge(write ? "WRITES" : "READS", sqlId, id, res, support.evidence(inv, "SQL_PARSE", res), attrs);
    }

    private static String receiverType(CtInvocation<?> inv) {
        CtTypeReference<?> dt = null;
        try {
            dt = inv.getExecutable().getDeclaringType();
        } catch (RuntimeException ignored) {
            // fall through to the target expression's static type
        }
        if ((dt == null || !SQL_TYPES.contains(dt.getQualifiedName())) && inv.getTarget() != null) {
            CtTypeReference<?> tt = safeType(inv.getTarget());
            if (tt != null) {
                dt = tt;
            }
        }
        return dt == null ? null : dt.getQualifiedName();
    }

    private static CtTypeReference<?> safeType(CtExpression<?> e) {
        try {
            return e.getType();
        } catch (RuntimeException ex) {
            return null;
        }
    }

    private static String simple(String fqn) {
        return fqn.substring(fqn.lastIndexOf('.') + 1);
    }

    private static String truncate(String s, ObjectNode a) {
        if (s.length() <= MAX_SQL) {
            return s;
        }
        a.put("truncated", true);
        return s.substring(0, MAX_SQL);
    }

    private void count(String key) {
        stats.merge(key, 1, Integer::sum);
    }

    public Map<String, Integer> stats() {
        return stats;
    }
}
