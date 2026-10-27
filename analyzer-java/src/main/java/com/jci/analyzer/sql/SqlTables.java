package com.jci.analyzer.sql;

import net.sf.jsqlparser.parser.CCJSqlParserUtil;
import net.sf.jsqlparser.schema.Table;
import net.sf.jsqlparser.statement.Statement;
import net.sf.jsqlparser.statement.delete.Delete;
import net.sf.jsqlparser.statement.execute.Execute;
import net.sf.jsqlparser.statement.insert.Insert;
import net.sf.jsqlparser.statement.merge.Merge;
import net.sf.jsqlparser.statement.select.Select;
import net.sf.jsqlparser.statement.truncate.Truncate;
import net.sf.jsqlparser.statement.update.Update;
import net.sf.jsqlparser.util.TablesNamesFinder;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Table-level read/write extraction from fully resolved SQL text. Never called on partial SQL. */
public final class SqlTables {

    public record TableAccess(String table, boolean write) {
    }

    public record Result(String operation, List<TableAccess> tables, String procedure, String error) {
        public boolean parsed() {
            return error == null;
        }
    }

    private SqlTables() {
    }

    public static Result analyze(String sql) {
        String text = sql.strip();
        while (text.endsWith(";")) {
            text = text.substring(0, text.length() - 1).strip();
        }
        Statement stmt;
        try {
            stmt = CCJSqlParserUtil.parse(text);
        } catch (Exception | Error e) {
            return new Result(leadingKeyword(text), List.of(), null, firstLine(e.getMessage()));
        }
        String operation = operationOf(stmt, text);
        if (stmt instanceof Execute ex) {
            return new Result("EXECUTE", List.of(), ex.getName(), null);
        }
        Set<String> all = new LinkedHashSet<>();
        try {
            for (String t : new TablesNamesFinder<Void>().getTables(stmt)) {
                all.add(normalize(t));
            }
        } catch (UnsupportedOperationException e) {
            return new Result(operation, List.of(), null, "Table extraction unsupported: " + firstLine(e.getMessage()));
        }
        String target = writeTarget(stmt);
        List<TableAccess> out = new ArrayList<>();
        if (target != null) {
            out.add(new TableAccess(target, true));
        }
        for (String t : all) {
            if (!t.equals(target)) {
                out.add(new TableAccess(t, false));
            }
        }
        return new Result(operation, out, null, null);
    }

    private static String writeTarget(Statement stmt) {
        Table t = null;
        if (stmt instanceof Insert s) {
            t = s.getTable();
        } else if (stmt instanceof Update s) {
            t = s.getTable();
        } else if (stmt instanceof Delete s) {
            t = s.getTable();
        } else if (stmt instanceof Merge s) {
            t = s.getTable();
        } else if (stmt instanceof Truncate s) {
            t = s.getTable();
        }
        return t == null ? null : normalize(t.getFullyQualifiedName());
    }

    private static String operationOf(Statement stmt, String text) {
        if (stmt instanceof Select) {
            return "SELECT";
        }
        if (stmt instanceof Insert) {
            return "INSERT";
        }
        if (stmt instanceof Update) {
            return "UPDATE";
        }
        if (stmt instanceof Delete) {
            return "DELETE";
        }
        if (stmt instanceof Merge) {
            return "MERGE";
        }
        if (stmt instanceof Truncate) {
            return "TRUNCATE";
        }
        return leadingKeyword(text);
    }

    public static String leadingKeyword(String text) {
        String t = text.stripLeading();
        int i = 0;
        while (i < t.length() && Character.isLetter(t.charAt(i))) {
            i++;
        }
        return i == 0 ? "UNKNOWN" : t.substring(0, i).toUpperCase(Locale.ROOT);
    }

    static String normalize(String name) {
        return name.replace("`", "").replace("\"", "").replace("[", "").replace("]", "").toLowerCase(Locale.ROOT);
    }

    private static String firstLine(String s) {
        if (s == null) {
            return "parse error";
        }
        int nl = s.indexOf('\n');
        return nl < 0 ? s : s.substring(0, nl);
    }
}
