package com.jci.analyzer.sql;

import net.sf.jsqlparser.parser.CCJSqlParserUtil;
import net.sf.jsqlparser.statement.Statement;
import net.sf.jsqlparser.statement.alter.Alter;
import net.sf.jsqlparser.statement.alter.AlterExpression;
import net.sf.jsqlparser.statement.alter.AlterOperation;
import net.sf.jsqlparser.statement.create.table.ColumnDefinition;
import net.sf.jsqlparser.statement.create.table.CreateTable;
import net.sf.jsqlparser.statement.create.view.CreateView;
import net.sf.jsqlparser.statement.drop.Drop;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Table / column / procedure catalog replayed from migration scripts in Flyway order (versioned V files by
 * version, then repeatable R files by name). Only DDL is interpreted; data statements are skipped unread.
 */
public final class SchemaCatalog {

    public static final class Table {
        public final String name;
        public boolean view;
        public boolean dropped;
        public boolean columnsKnown = true;
        public String file;
        public int line;
        public final Map<String, String> columns = new LinkedHashMap<>();
        public final List<String> changedIn = new ArrayList<>();
        /** Columns added by prepared-statement DDL assembled from literal session variables. */
        public final List<String> derivedColumns = new ArrayList<>();
        /** Procedures called with this table name as a literal argument: they may alter it in ways not modelled. */
        public final List<String> procedureTouched = new ArrayList<>();

        Table(String name) {
            this.name = name;
        }
    }

    public record Procedure(String name, String kind, String file, int line) {
    }

    private static final Pattern DDL_START = Pattern.compile("(?is)^\\s*(create|alter|drop)\\s+(?:or\\s+replace\\s+)?(?:temporary\\s+)?(table|view)\\b.*");
    private static final Pattern CREATE_HEADER = Pattern.compile(
            "(?is)^\\s*create\\s+(?:or\\s+replace\\s+)?(?:temporary\\s+)?(table|view)\\s+(?:if\\s+not\\s+exists\\s+)?([`\"\\[]?[\\w.$]+[`\"\\]]?)");
    private static final Pattern ROUTINE = Pattern.compile(
            "(?i)create\\s+(?:or\\s+replace\\s+)?(?:definer\\s*=\\s*\\S+\\s+)?(procedure|function)\\s+(?:if\\s+not\\s+exists\\s+)?[`\"]?([\\w.$]+)[`\"]?");
    private static final Pattern VERSIONED = Pattern.compile("^V([0-9._]+)__.*");

    private final Map<String, Table> tables = new LinkedHashMap<>();
    private final Map<String, Procedure> procedures = new LinkedHashMap<>();
    private int files;
    private int ddlStatements;
    private int ddlUnparsed;

    /** @param files repo-relative path -> text */
    public static SchemaCatalog load(Map<String, String> files) {
        SchemaCatalog c = new SchemaCatalog();
        List<String> ordered = new ArrayList<>(files.keySet().stream().filter(p -> p.toLowerCase(Locale.ROOT).endsWith(".sql")).toList());
        ordered.sort(Comparator.comparing(SchemaCatalog::flywayOrderKey));
        for (String path : ordered) {
            c.file(path, files.get(path));
        }
        return c;
    }

    /** V files by numeric version, then everything else (repeatables) by name. */
    static String flywayOrderKey(String path) {
        String name = path.substring(path.lastIndexOf('/') + 1);
        Matcher m = VERSIONED.matcher(name);
        if (!m.matches()) {
            return "1|" + name.toLowerCase(Locale.ROOT);
        }
        StringBuilder sb = new StringBuilder("0|");
        for (String part : m.group(1).split("[._]")) {
            sb.append(String.format("%010d.", part.isEmpty() ? 0 : Long.parseLong(part.length() > 18 ? part.substring(0, 18) : part)));
        }
        return sb.toString();
    }

    private static final Pattern ROUTINE_STATEMENT = Pattern.compile("(?is)^\\s*(create\\s+(or\\s+replace\\s+)?(definer\\s*=\\s*\\S+\\s+)?(procedure|function|trigger|event)|drop\\s+(procedure|function|trigger|event))\\b.*");
    private static final Pattern SET_VAR = Pattern.compile("(?is)^\\s*set\\s+@(\\w+)\\s*=\\s*(['\"])(.*?)\\2\\s*$");
    private static final Pattern CALL = Pattern.compile("(?is)^\\s*call\\s+[`\"]?([\\w.$]+)[`\"]?\\s*\\((.*)\\)\\s*$");
    private static final Pattern LITERAL = Pattern.compile("'([^']*)'|\"([^\"]*)\"");

    private void file(String path, String text) {
        files++;
        Matcher r = ROUTINE.matcher(text);
        while (r.find()) {
            String name = r.group(2).toLowerCase(Locale.ROOT);
            procedures.putIfAbsent(name, new Procedure(name, r.group(1).toUpperCase(Locale.ROOT), path, lineOf(text, r.start())));
        }
        Map<String, String> vars = new LinkedHashMap<>();
        for (Chunk ch : split(text)) {
            if (ROUTINE_STATEMENT.matcher(ch.text).matches()) {
                continue;
            }
            Matcher set = SET_VAR.matcher(ch.text);
            if (set.matches()) {
                vars.put(set.group(1).toLowerCase(Locale.ROOT), set.group(3));
                continue;
            }
            Matcher call = CALL.matcher(ch.text);
            if (call.matches()) {
                Matcher lit = LITERAL.matcher(call.group(2));
                while (lit.find()) {
                    String arg = normalize(lit.group(1) != null ? lit.group(1) : lit.group(2));
                    Table t = tables.get(arg);
                    if (t != null) {
                        t.procedureTouched.add(call.group(1).toLowerCase(Locale.ROOT) + " @" + path + ":" + ch.line);
                    }
                }
                continue;
            }
            String derived = preparedDdl(ch.text, vars);
            if (derived != null) {
                try {
                    Statement st = CCJSqlParserUtil.parse(derived);
                    Map<String, Set<String>> before = snapshotColumns();
                    apply(st, path, ch.line);
                    recordDerived(before);
                    ddlStatements++;
                } catch (Exception | Error e) {
                    ddlUnparsed++;
                }
                continue;
            }
            if (!DDL_START.matcher(ch.text).matches()) {
                continue;
            }
            ddlStatements++;
            Statement st;
            try {
                st = CCJSqlParserUtil.parse(ch.text);
            } catch (Exception | Error e) {
                ddlUnparsed++;
                Matcher h = CREATE_HEADER.matcher(ch.text);
                if (h.find()) {
                    Table t = table(h.group(2), path, ch.line);
                    t.view = "view".equalsIgnoreCase(h.group(1));
                    t.columnsKnown = false;
                }
                continue;
            }
            apply(st, path, ch.line);
        }
    }

    /**
     * MySQL idempotent-migration idiom: {@code CONCAT("ALTER TABLE ", @tablename, " ADD ", @columnname, " int")} inside
     * a prepared statement. Evaluated only when every CONCAT argument is a string literal or a literal session variable.
     */
    static String preparedDdl(String chunk, Map<String, String> vars) {
        String lower = chunk.toLowerCase(Locale.ROOT);
        int c = lower.indexOf("concat(");
        while (c >= 0) {
            int start = c + "concat(".length();
            int depth = 1;
            int i = start;
            char quote = 0;
            for (; i < chunk.length() && depth > 0; i++) {
                char ch = chunk.charAt(i);
                if (quote != 0) {
                    if (ch == quote) {
                        quote = 0;
                    }
                } else if (ch == '\'' || ch == '"') {
                    quote = ch;
                } else if (ch == '(') {
                    depth++;
                } else if (ch == ')') {
                    depth--;
                }
            }
            String args = chunk.substring(start, Math.max(start, i - 1));
            String value = concatValue(args, vars);
            if (value != null && DDL_START.matcher(value).matches()) {
                return value.strip().replaceAll(";\\s*$", "");
            }
            c = lower.indexOf("concat(", i);
        }
        return null;
    }

    private static String concatValue(String args, Map<String, String> vars) {
        StringBuilder out = new StringBuilder();
        for (String raw : splitTopLevel(args)) {
            String a = raw.strip();
            if (a.length() >= 2 && (a.startsWith("'") && a.endsWith("'") || a.startsWith("\"") && a.endsWith("\""))) {
                out.append(a, 1, a.length() - 1);
            } else if (a.startsWith("@") && vars.containsKey(a.substring(1).toLowerCase(Locale.ROOT))) {
                out.append(vars.get(a.substring(1).toLowerCase(Locale.ROOT)));
            } else {
                return null;
            }
        }
        return out.toString();
    }

    private static List<String> splitTopLevel(String s) {
        List<String> out = new ArrayList<>();
        int depth = 0;
        char quote = 0;
        int last = 0;
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (quote != 0) {
                if (ch == quote) {
                    quote = 0;
                }
            } else if (ch == '\'' || ch == '"') {
                quote = ch;
            } else if (ch == '(') {
                depth++;
            } else if (ch == ')') {
                depth--;
            } else if (ch == ',' && depth == 0) {
                out.add(s.substring(last, i));
                last = i + 1;
            }
        }
        out.add(s.substring(last));
        return out;
    }

    private Map<String, Set<String>> snapshotColumns() {
        Map<String, Set<String>> m = new LinkedHashMap<>();
        tables.forEach((k, v) -> m.put(k, new java.util.HashSet<>(v.columns.keySet())));
        return m;
    }

    private void recordDerived(Map<String, Set<String>> before) {
        tables.forEach((k, v) -> {
            Set<String> old = before.getOrDefault(k, Set.of());
            for (String col : v.columns.keySet()) {
                if (!old.contains(col) && !v.derivedColumns.contains(col)) {
                    v.derivedColumns.add(col);
                }
            }
        });
    }

    private void apply(Statement st, String path, int line) {
        if (st instanceof CreateTable ct) {
            Table t = table(ct.getTable().getName(), path, line);
            t.dropped = false;
            if (ct.getColumnDefinitions() != null) {
                for (ColumnDefinition cd : ct.getColumnDefinitions()) {
                    t.columns.put(normalize(cd.getColumnName()), String.valueOf(cd.getColDataType()));
                }
            }
        } else if (st instanceof CreateView cv) {
            Table t = table(cv.getView().getName(), path, line);
            t.view = true;
            t.columnsKnown = false;
        } else if (st instanceof Drop d && d.getName() != null && ("TABLE".equalsIgnoreCase(d.getType()) || "VIEW".equalsIgnoreCase(d.getType()))) {
            Table t = tables.get(normalize(d.getName().getName()));
            if (t != null) {
                t.dropped = true;
                t.changedIn.add(path + ":" + line);
            }
        } else if (st instanceof Alter a && a.getTable() != null) {
            Table t = tables.computeIfAbsent(normalize(a.getTable().getName()), n -> {
                Table x = new Table(n);
                x.file = path;
                x.line = line;
                x.columnsKnown = false;
                return x;
            });
            t.changedIn.add(path + ":" + line);
            if (a.getAlterExpressions() == null) {
                return;
            }
            for (AlterExpression ae : a.getAlterExpressions()) {
                AlterOperation op = ae.getOperation();
                if (op == AlterOperation.DROP && ae.getColumnName() != null) {
                    t.columns.remove(normalize(ae.getColumnName()));
                } else if (op == AlterOperation.CHANGE && ae.getColumnOldName() != null) {
                    t.columns.remove(normalize(ae.getColumnOldName()));
                }
                if (ae.getColDataTypeList() != null && (op == AlterOperation.ADD || op == AlterOperation.MODIFY
                        || op == AlterOperation.CHANGE || op == AlterOperation.ALTER)) {
                    for (AlterExpression.ColumnDataType c : ae.getColDataTypeList()) {
                        t.columns.put(normalize(c.getColumnName()), String.valueOf(c.getColDataType()));
                    }
                }
            }
        }
    }

    private Table table(String rawName, String path, int line) {
        String name = normalize(rawName);
        Table t = tables.computeIfAbsent(name, Table::new);
        if (t.file == null) {
            t.file = path;
            t.line = line;
        } else {
            t.changedIn.add(path + ":" + line);
        }
        return t;
    }

    static String normalize(String name) {
        String n = SqlTables.normalize(name);
        int dot = n.lastIndexOf('.');
        return dot >= 0 ? n.substring(dot + 1) : n;
    }

    private record Chunk(String text, int line) {
    }

    private static final Pattern DELIMITER_LINE = Pattern.compile("(?i)DELIMITER[ \\t]+(\\S+)[^\\n]*");

    /**
     * Splits on the current delimiter (';' unless changed by a MySQL {@code DELIMITER x} line) outside quotes and
     * comments; comments are dropped from the chunk text.
     */
    static List<Chunk> split(String text) {
        List<Chunk> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        int line = 1;
        int startLine = 1;
        char quote = 0;
        String delimiter = ";";
        boolean atLineStart = true;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            char next = i + 1 < text.length() ? text.charAt(i + 1) : 0;
            if (quote == 0 && atLineStart && (c == 'D' || c == 'd')) {
                Matcher dm = DELIMITER_LINE.matcher(text).region(i, text.length());
                if (dm.lookingAt()) {
                    if (!cur.toString().isBlank()) {
                        out.add(new Chunk(cur.toString().strip(), startLine + leadingNewlines(cur)));
                    }
                    cur.setLength(0);
                    delimiter = dm.group(1);
                    i = dm.end() - 1;
                    startLine = line;
                    continue;
                }
            }
            atLineStart = c == '\n' || (atLineStart && (c == ' ' || c == '\t'));
            if (quote == 0 && !";".equals(delimiter) && text.startsWith(delimiter, i)) {
                if (!cur.toString().isBlank()) {
                    out.add(new Chunk(cur.toString().strip(), startLine + leadingNewlines(cur)));
                }
                cur.setLength(0);
                startLine = line;
                i += delimiter.length() - 1;
                continue;
            }
            if (quote == 0 && c == '-' && next == '-') {
                while (i < text.length() && text.charAt(i) != '\n') {
                    i++;
                }
                line++;
                cur.append('\n');
                atLineStart = true;
                continue;
            }
            if (quote == 0 && c == '/' && next == '*') {
                int end = text.indexOf("*/", i + 2);
                end = end < 0 ? text.length() : end + 2;
                for (int j = i; j < end; j++) {
                    if (text.charAt(j) == '\n') {
                        line++;
                        cur.append('\n');
                    }
                }
                i = end - 1;
                continue;
            }
            if (c == '\n') {
                line++;
            }
            if (quote != 0) {
                if (c == quote) {
                    quote = 0;
                }
            } else if (c == '\'' || c == '"' || c == '`') {
                quote = c;
            } else if (c == ';' && ";".equals(delimiter)) {
                if (!cur.toString().isBlank()) {
                    out.add(new Chunk(cur.toString().strip(), startLine + leadingNewlines(cur)));
                }
                cur.setLength(0);
                startLine = line;
                continue;
            }
            cur.append(c);
        }
        if (!cur.toString().isBlank()) {
            out.add(new Chunk(cur.toString().strip(), startLine + leadingNewlines(cur)));
        }
        return out;
    }

    private static int leadingNewlines(CharSequence s) {
        int n = 0;
        for (int i = 0; i < s.length() && Character.isWhitespace(s.charAt(i)); i++) {
            if (s.charAt(i) == '\n') {
                n++;
            }
        }
        return n;
    }

    private static int lineOf(String text, int offset) {
        int n = 1;
        for (int i = 0; i < offset && i < text.length(); i++) {
            if (text.charAt(i) == '\n') {
                n++;
            }
        }
        return n;
    }

    public Map<String, Table> tables() {
        return tables;
    }

    public Map<String, Procedure> procedures() {
        return procedures;
    }

    public boolean isEmpty() {
        return tables.isEmpty() && procedures.isEmpty();
    }

    public Table table(String name) {
        return tables.get(normalize(name));
    }

    public Map<String, Integer> stats() {
        Map<String, Integer> m = new LinkedHashMap<>();
        m.put("files", files);
        m.put("tables", (int) tables.values().stream().filter(t -> !t.view && !t.dropped).count());
        m.put("views", (int) tables.values().stream().filter(t -> t.view && !t.dropped).count());
        m.put("dropped", (int) tables.values().stream().filter(t -> t.dropped).count());
        m.put("procedures", procedures.size());
        m.put("ddlStatements", ddlStatements);
        m.put("ddlUnparsed", ddlUnparsed);
        return m;
    }
}
