package com.jci.analyzer;

import com.jci.analyzer.spoon.EndpointExtractor;
import com.jci.analyzer.sql.SqlTables;
import com.jci.analyzer.util.Redactor;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class UnitTest {

    @Test
    void joinPaths() {
        assertEquals("/api/orders/search/v2", EndpointExtractor.joinPaths("/api/orders", "search/v2"));
        assertEquals("/api/orders", EndpointExtractor.joinPaths("/api/orders/", ""));
        assertEquals("/api/snippets/snippets/{refId}", EndpointExtractor.joinPaths("/api/snippets", "snippets/{refId}"));
        assertEquals("/", EndpointExtractor.joinPaths("", ""));
        assertEquals("/a/b", EndpointExtractor.joinPaths("a//", "//b/"));
    }

    @Test
    void sqlTables() {
        SqlTables.Result r = SqlTables.analyze("insert into t_a (x) select y from t_b b join t_c c on b.id = c.id");
        assertEquals("INSERT", r.operation());
        assertEquals(List.of(new SqlTables.TableAccess("t_a", true), new SqlTables.TableAccess("t_b", false), new SqlTables.TableAccess("t_c", false)), r.tables());

        SqlTables.Result u = SqlTables.analyze("update `t_order` set deleted = 1 where order_id = :id;");
        assertEquals(List.of(new SqlTables.TableAccess("t_order", true)), u.tables());

        SqlTables.Result bad = SqlTables.analyze("select from where");
        assertFalse(bad.parsed());
        assertTrue(bad.tables().isEmpty(), "unparseable SQL must not yield guessed tables");
    }

    @Test
    void securityPathMatching() {
        assertEquals("EXACT", com.jci.analyzer.spoon.SecurityTestAccess.match("/api/orders/**", "/api/orders/{id}/lines"));
        assertEquals("EXACT", com.jci.analyzer.spoon.SecurityTestAccess.match("/api/**", "/api"));
        assertEquals("POSSIBLE", com.jci.analyzer.spoon.SecurityTestAccess.match("/api/orders/search", "/api/orders/{id}"));
        assertEquals("NO", com.jci.analyzer.spoon.SecurityTestAccess.match("/api/user/*", "/api/user/a/b"));
        assertEquals("EXACT", com.jci.analyzer.spoon.SecurityTestAccess.match("/actuator/metrics/**", "/actuator/metrics"));
        assertEquals("NO", com.jci.analyzer.spoon.SecurityTestAccess.match("/a.b", "/axb"), "dots are literal");
    }

    @Test
    void flywayOrderAndCatalog() {
        java.util.Map<String, String> files = new java.util.LinkedHashMap<>();
        files.put("m/V1.10__b.sql", "ALTER TABLE t ADD COLUMN c3 INT;");
        files.put("m/V1.2__a.sql", "CREATE TABLE t (c1 INT, c2 VARCHAR(10));\nALTER TABLE t DROP COLUMN c2;");
        files.put("m/R__p.sql", "DELIMITER $$\nCREATE PROCEDURE prc_x() BEGIN SELECT 1; END$$");
        com.jci.analyzer.sql.SchemaCatalog c = com.jci.analyzer.sql.SchemaCatalog.load(files);
        assertEquals(List.of("c1", "c3"), List.copyOf(c.table("t").columns.keySet()), "V1.2 runs before V1.10");
        assertTrue(c.procedures().containsKey("prc_x"));
    }

    @Test
    void migrationIdioms() {
        java.util.Map<String, String> files = new java.util.LinkedHashMap<>();
        files.put("m/V1__a.sql", "CREATE TABLE t_a (id INT);\nCREATE TABLE t_b (id INT);");
        files.put("m/V2__b.sql", String.join("\n",
                "SET @tablename = \"t_a\";",
                "SET @columnname = \"extra\";",
                "SET @s = (SELECT IF((SELECT COUNT(*) FROM x) > 0, \"SELECT 1\", CONCAT(\"ALTER TABLE \", @tablename, \" ADD \", @columnname, \" int;\")));",
                "PREPARE p FROM @s;",
                "DELIMITER $$",
                "CREATE PROCEDURE add_col(IN tn VARCHAR(64)) BEGIN SELECT 1; END $$",
                "DELIMITER ;",
                "-- comment before a plain statement",
                "ALTER TABLE t_b ADD COLUMN after_proc INT;",
                "CALL add_col('t_b');"));
        com.jci.analyzer.sql.SchemaCatalog c = com.jci.analyzer.sql.SchemaCatalog.load(files);
        assertEquals(List.of("id", "extra"), List.copyOf(c.table("t_a").columns.keySet()), "prepared-statement DDL from literal variables");
        assertEquals(List.of("extra"), c.table("t_a").derivedColumns);
        assertEquals(List.of("id", "after_proc"), List.copyOf(c.table("t_b").columns.keySet()), "DDL after a DELIMITER block is still read");
        assertEquals(1, c.table("t_b").procedureTouched.size());
        assertTrue(c.procedures().containsKey("add_col"));
    }

    @Test
    void placeholderKeys() {
        assertEquals("a.b", com.jci.analyzer.source.PropertyIndex.placeholderKey("${a.b:default}"));
        assertEquals("a.b", com.jci.analyzer.source.PropertyIndex.placeholderKey("${a.b}"));
        assertEquals(null, com.jci.analyzer.source.PropertyIndex.placeholderKey("prefix-${a.b}"));
        assertEquals(null, com.jci.analyzer.source.PropertyIndex.placeholderKey("#{bean.x}"));
    }

    @Test
    void redaction() {
        assertEquals("jdbc:mysql://h/db?user=a&password=" + Redactor.MASK, Redactor.redact("jdbc:mysql://h/db?user=a&password=s3cr3t"));
        assertEquals("where password = :pwd", Redactor.redact("where password = :pwd"), "bind parameters stay");
        assertEquals("key " + Redactor.MASK, Redactor.redact("key AKIAABCDEFGHIJKLMNOP"));
    }
}
