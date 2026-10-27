package com.jci.analyzer.spoon;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jci.analyzer.graph.Graph;
import com.jci.analyzer.graph.Resolution;
import com.jci.analyzer.sql.SchemaCatalog;
import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.ModifierKind;

import java.beans.Introspector;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * JPA entity -> table MAPS_TO edges with the field/column map. Names come from @Table/@Column/@JoinColumn; otherwise
 * from the configured physical naming strategy (Spring Boot default: camelCase -> snake_case). Columns are checked
 * against the migration catalog and mismatches reported, never silently "fixed".
 */
public final class EntityMapper {

    private final Graph graph;
    private final SpoonSupport support;
    private final NodeFactory nodes;
    private final DatabaseNodes db;
    private final boolean standardNaming;
    private int mapped;
    private int columnMismatches;

    /** @param physicalStrategy value of spring.jpa.hibernate.naming.physical-strategy, or null */
    public EntityMapper(Graph graph, SpoonSupport support, NodeFactory nodes, DatabaseNodes db, String physicalStrategy) {
        this.graph = graph;
        this.support = support;
        this.nodes = nodes;
        this.db = db;
        this.standardNaming = physicalStrategy != null && physicalStrategy.contains("PhysicalNamingStrategyStandardImpl");
    }

    public void map(CtType<?> t) {
        if (!SpoonSupport.hasAnnotation(t, "Entity")) {
            return;
        }
        String explicit = TypeIndex.literal(SpoonSupport.annotationValue(SpoonSupport.annotation(t, "Table"), "name"));
        String table = explicit != null && !explicit.isEmpty() ? explicit : physical(t.getSimpleName());
        String rule = explicit != null && !explicit.isEmpty() ? "JPA_TABLE" : standardNaming ? "JPA_NAMING_STANDARD" : "JPA_NAMING_SNAKE_CASE";
        SchemaCatalog.Table catalogTable = db.catalog().table(table);
        String tableId = db.table(table, "JPA_ENTITY");
        ObjectNode a = Graph.attrs();
        ArrayNode cols = a.putArray("columns");
        ArrayNode missing = a.putArray("columnsNotInCatalog");
        ArrayNode unverified = a.putArray("columnsUnverified");
        boolean procedureAltered = catalogTable != null && !catalogTable.procedureTouched.isEmpty();
        boolean propertyAccess = isPropertyAccess(t);
        a.put("access", propertyAccess ? "PROPERTY" : "FIELD");
        for (Persistent p : persistentAttributes(t, propertyAccess)) {
            boolean relation = SpoonSupport.hasAnnotation(p.element(), "OneToMany", "ManyToMany");
            if (relation && !SpoonSupport.hasAnnotation(p.element(), "JoinColumn")) {
                continue;
            }
            CtAnnotation<?> col = SpoonSupport.annotation(p.element(), "Column");
            if (col == null) {
                col = SpoonSupport.annotation(p.element(), "JoinColumn");
            }
            String name = col == null ? null : TypeIndex.literal(SpoonSupport.annotationValue(col, "name"));
            String column = name != null && !name.isEmpty() ? name.toLowerCase(Locale.ROOT) : physical(p.name());
            ObjectNode co = cols.addObject();
            co.put("field", p.name());
            co.put("column", column);
            co.put("explicit", name != null && !name.isEmpty());
            if (SpoonSupport.hasAnnotation(p.element(), "Id", "EmbeddedId")) {
                co.put("id", true);
            }
            if (catalogTable != null && catalogTable.columnsKnown && !catalogTable.columns.containsKey(column)) {
                if (procedureAltered) {
                    // A migration hands this table to a stored procedure that may add the column: cannot verify.
                    unverified.add(column);
                } else {
                    missing.add(column);
                    columnMismatches++;
                }
            }
        }
        if (catalogTable == null) {
            a.put("tableInCatalog", false);
        }
        graph.addEdge("MAPS_TO", nodes.type(t).id, tableId, Resolution.FRAMEWORK_DERIVED, support.evidence(t, rule, Resolution.FRAMEWORK_DERIVED), a);
        if (!missing.isEmpty()) {
            graph.diagnostic("INFO", "ENTITY_COLUMN_NOT_IN_CATALOG",
                    t.getQualifiedName() + " maps column(s) " + missing + " that the migrations do not define for " + table, support.relPath(t), SpoonSupport.line(t));
        }
        mapped++;
    }

    /** A persistent attribute: logical name plus the element carrying its mapping annotations. */
    private record Persistent(String name, CtElement element) {
    }

    /** JPA default access type follows the placement of @Id/@EmbeddedId (fields vs getters); @Access overrides. */
    static boolean isPropertyAccess(CtType<?> t) {
        CtAnnotation<?> access = SpoonSupport.annotation(t, "Access");
        if (access != null) {
            return String.valueOf(SpoonSupport.annotationValue(access, "value")).endsWith("PROPERTY");
        }
        for (CtField<?> f : t.getFields()) {
            if (SpoonSupport.hasAnnotation(f, "Id", "EmbeddedId")) {
                return false;
            }
        }
        for (CtMethod<?> m : t.getMethods()) {
            if (SpoonSupport.hasAnnotation(m, "Id", "EmbeddedId")) {
                return true;
            }
        }
        return false;
    }

    private static List<Persistent> persistentAttributes(CtType<?> t, boolean propertyAccess) {
        List<Persistent> out = new ArrayList<>();
        if (!propertyAccess) {
            for (CtField<?> f : t.getFields()) {
                if (!f.isStatic() && !SpoonSupport.hasAnnotation(f, "Transient") && !f.hasModifier(ModifierKind.TRANSIENT)) {
                    out.add(new Persistent(f.getSimpleName(), f));
                }
            }
            return out;
        }
        for (CtMethod<?> m : t.getMethods()) {
            String n = m.getSimpleName();
            boolean getter = m.getParameters().isEmpty() && !m.isStatic()
                    && (n.startsWith("get") && n.length() > 3 || n.startsWith("is") && n.length() > 2);
            if (!getter || SpoonSupport.hasAnnotation(m, "Transient") || m.getMetadata(SpoonSupport.LOMBOK_META) != null) {
                continue;
            }
            out.add(new Persistent(Introspector.decapitalize(n.substring(n.startsWith("is") ? 2 : 3)), m));
        }
        return out;
    }

    /** Spring Boot's CamelCaseToUnderscoresNamingStrategy, unless the standard (identity) strategy is configured. */
    String physical(String logical) {
        if (standardNaming) {
            return logical.toLowerCase(Locale.ROOT);
        }
        StringBuilder sb = new StringBuilder(logical.replace('.', '_'));
        for (int i = 1; i < sb.length() - 1; i++) {
            if (Character.isLowerCase(sb.charAt(i - 1)) && Character.isUpperCase(sb.charAt(i)) && Character.isLowerCase(sb.charAt(i + 1))) {
                sb.insert(i++, '_');
            }
        }
        return sb.toString().toLowerCase(Locale.ROOT);
    }

    public int mapped() {
        return mapped;
    }

    public int columnMismatches() {
        return columnMismatches;
    }
}
