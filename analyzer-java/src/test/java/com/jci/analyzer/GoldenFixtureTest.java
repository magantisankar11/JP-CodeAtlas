package com.jci.analyzer;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jci.analyzer.source.AnalyzerConfig;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/** Analyzer output on fixtures/simple-rest must match the hand-written golden file exactly where it speaks. */
class GoldenFixtureTest {

    static final Path FIXTURE = Path.of("..", "fixtures", "simple-rest").toAbsolutePath().normalize();
    static final Path GOLDEN = Path.of("..", "fixtures", "simple-rest.expected.json").toAbsolutePath().normalize();
    static final ObjectMapper MAPPER = new ObjectMapper();

    static JsonNode snapshot;
    static final Map<String, JsonNode> NODES = new HashMap<>();
    static final List<JsonNode> EDGES = new ArrayList<>();
    static JsonNode golden;

    @BeforeAll
    static void analyze() throws Exception {
        Path out = Path.of("target", "test-out", "simple-rest.ndjson").toAbsolutePath();
        AnalyzerConfig cfg = new AnalyzerConfig(FIXTURE, "simple-rest", "simple-rest", List.of("src/main/java"), List.of(),
                out, Path.of("target", "test-ws").toAbsolutePath(), AnalyzerConfig.SourceMode.AUTO, List.of());
        new Analyzer().run(cfg);
        for (String line : Files.readAllLines(out)) {
            JsonNode n = MAPPER.readTree(line);
            switch (n.path("type").asText()) {
                case "snapshot" -> snapshot = n;
                case "node" -> NODES.put(n.path("id").asText(), n);
                case "edge" -> EDGES.add(n);
                default -> { }
            }
        }
        golden = MAPPER.readTree(GOLDEN.toFile());
    }

    @Test
    void snapshotHeader() {
        assertEquals("1.1.0", snapshot.path("schemaVersion").asText());
        assertTrue(snapshot.path("commitSha").asText().startsWith("nogit-"), "fixture is not a git repo");
        assertEquals("WORKTREE", snapshot.path("sourceMode").asText());
    }

    @Test
    void endpoints() {
        List<String> problems = new ArrayList<>();
        int expected = 0;
        for (JsonNode e : golden.path("endpoints")) {
            expected++;
            String id = e.path("id").asText();
            String handler = e.path("handler").asText();
            if (!NODES.containsKey(id)) {
                problems.add("missing endpoint " + id);
                continue;
            }
            boolean exposes = EDGES.stream().anyMatch(x -> "EXPOSES".equals(x.path("kind").asText())
                    && id.equals(x.path("src").asText()) && handler.equals(x.path("dst").asText()));
            if (!exposes) {
                problems.add("missing EXPOSES " + id + " -> " + handler);
            }
        }
        long actual = NODES.values().stream().filter(n -> "API_ENDPOINT".equals(n.path("kind").asText())).count();
        if (actual != expected) {
            problems.add("expected " + expected + " endpoints, found " + actual);
        }
        assertNoProblems(problems);
    }

    @Test
    void mustExist() {
        List<String> problems = new ArrayList<>();
        for (JsonNode exp : golden.path("mustExist")) {
            List<JsonNode> matches = EDGES.stream().filter(e -> matches(exp, e)).toList();
            if (matches.isEmpty()) {
                problems.add("MISSING " + describe(exp) + nearby(exp));
            }
        }
        assertNoProblems(problems);
    }

    @Test
    void mustNotExist() {
        List<String> problems = new ArrayList<>();
        for (JsonNode exp : golden.path("mustNotExist")) {
            for (JsonNode e : EDGES) {
                if (matches(exp, e)) {
                    problems.add("FORBIDDEN " + describe(exp) + " found as " + e.path("resolution").asText() + " (" + exp.path("_why").asText() + ")");
                }
            }
        }
        assertNoProblems(problems);
    }

    @Test
    void everyEdgeEndpointIsANode() {
        List<String> problems = new ArrayList<>();
        for (JsonNode e : EDGES) {
            for (String k : new String[] {"src", "dst"}) {
                if (!NODES.containsKey(e.path(k).asText())) {
                    problems.add(k + " not a node: " + e.path(k).asText());
                }
            }
            if (e.path("evidence").isEmpty()) {
                problems.add("no evidence: " + e.path("id").asText());
            }
        }
        assertNoProblems(problems);
    }

    /** Evidence must point at real source: the callee's name occurs within the cited line range. */
    @Test
    void callEvidenceMatchesSourceText() throws Exception {
        List<String> problems = new ArrayList<>();
        Map<String, List<String>> files = new HashMap<>();
        for (JsonNode e : EDGES) {
            if (!"CALLS".equals(e.path("kind").asText())) {
                continue;
            }
            String dst = e.path("dst").asText();
            if (!dst.startsWith("method:")) {
                continue;
            }
            String name = dst.substring(dst.indexOf('#') + 1, dst.indexOf('('));
            if ("<init>".equals(name)) {
                String type = dst.substring("method:".length(), dst.indexOf('#'));
                name = "new " + type.substring(type.lastIndexOf('.') + 1);
            }
            for (JsonNode ev : e.path("evidence")) {
                String file = ev.path("filePath").asText();
                List<String> lines = files.computeIfAbsent(file, f -> read(FIXTURE.resolve(f)));
                int from = ev.path("line").asInt();
                int to = Math.max(from, ev.path("endLine").asInt());
                if (from < 1 || to > lines.size()) {
                    problems.add("bad line range " + file + ":" + from + "-" + to + " for " + dst);
                    continue;
                }
                String text = String.join("\n", lines.subList(from - 1, to));
                if (!text.contains(name)) {
                    problems.add(file + ":" + from + "-" + to + " does not mention '" + name + "' (edge to " + dst + ")");
                }
            }
        }
        assertNoProblems(problems);
    }

    @Test
    void noUnexpectedUnresolvedCalls() {
        List<String> unresolved = EDGES.stream()
                .filter(e -> "CALLS".equals(e.path("kind").asText()) && "UNRESOLVED".equals(e.path("resolution").asText()))
                .map(e -> e.path("src").asText() + " -> " + e.path("dst").asText())
                .toList();
        assertEquals(1, unresolved.size(), "only the reflective call is expected to be unresolved: " + unresolved);
    }

    // ------------------------------------------------------------------ helpers

    static boolean matches(JsonNode exp, JsonNode e) {
        if (!exp.path("kind").asText().equals(e.path("kind").asText())) {
            return false;
        }
        if (!endpointMatches(exp, "src", e.path("src").asText()) || !endpointMatches(exp, "dst", e.path("dst").asText())) {
            return false;
        }
        if (exp.has("resolution") && !exp.path("resolution").asText().equals(e.path("resolution").asText())) {
            return false;
        }
        if (exp.has("attrs") && !attrsMatch(exp.path("attrs"), e.path("attrs"))) {
            return false;
        }
        if (exp.has("dstAttrs")) {
            JsonNode dst = NODES.get(e.path("dst").asText());
            return dst != null && attrsMatch(exp.path("dstAttrs"), dst.path("attrs"));
        }
        return true;
    }

    static boolean endpointMatches(JsonNode exp, String key, String actual) {
        if (exp.has(key)) {
            return exp.path(key).asText().equals(actual);
        }
        if (exp.has(key + "Prefix")) {
            return actual.startsWith(exp.path(key + "Prefix").asText());
        }
        return true;
    }

    /** Every expected key must match; nested objects are matched partially, arrays and scalars exactly. */
    static boolean attrsMatch(JsonNode expected, JsonNode actual) {
        Iterator<Map.Entry<String, JsonNode>> it = expected.fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> f = it.next();
            JsonNode a = actual.path(f.getKey());
            boolean ok = f.getValue().isObject() ? a.isObject() && attrsMatch(f.getValue(), a) : f.getValue().equals(a);
            if (!ok) {
                return false;
            }
        }
        return true;
    }

    @Test
    void nodes() {
        List<String> problems = new ArrayList<>();
        for (JsonNode exp : golden.path("nodes")) {
            JsonNode n = NODES.get(exp.path("id").asText());
            if (n == null) {
                problems.add("missing node " + exp.path("id").asText());
                continue;
            }
            if (!exp.path("kind").asText().equals(n.path("kind").asText())) {
                problems.add(exp.path("id").asText() + " kind " + n.path("kind").asText() + " != " + exp.path("kind").asText());
            }
            if (exp.has("attrs") && !attrsMatch(exp.path("attrs"), n.path("attrs"))) {
                problems.add(exp.path("id").asText() + " attrs " + n.path("attrs") + " do not contain " + exp.path("attrs"));
            }
            if (exp.has("columns")) {
                List<String> cols = new ArrayList<>();
                n.path("attrs").path("columns").forEach(c -> cols.add(c.path("name").asText()));
                List<String> want = new ArrayList<>();
                exp.path("columns").forEach(c -> want.add(c.asText()));
                if (!cols.equals(want)) {
                    problems.add(exp.path("id").asText() + " columns " + cols + " != " + want);
                }
            }
        }
        assertNoProblems(problems);
    }

    @Test
    void diagnostics() throws Exception {
        List<String> problems = new ArrayList<>();
        List<JsonNode> diags = new ArrayList<>();
        for (String line : Files.readAllLines(Path.of("target", "test-out", "simple-rest.ndjson"))) {
            JsonNode n = MAPPER.readTree(line);
            if ("diagnostic".equals(n.path("type").asText())) {
                diags.add(n);
            }
        }
        for (JsonNode exp : golden.path("diagnostics")) {
            boolean found = diags.stream().anyMatch(d -> d.path("code").asText().equals(exp.path("code").asText())
                    && d.path("message").asText().contains(exp.path("messageContains").asText()));
            if (!found) {
                problems.add("missing diagnostic " + exp);
            }
        }
        assertNoProblems(problems);
    }

    /** Property values and secrets must never reach the output, wherever they appear in the fixture. */
    @Test
    void noForbiddenTextInOutput() throws Exception {
        String text = Files.readString(Path.of("target", "test-out", "simple-rest.ndjson"));
        List<String> problems = new ArrayList<>();
        for (JsonNode f : golden.path("forbiddenText")) {
            if (text.contains(f.asText())) {
                problems.add("output contains forbidden text '" + f.asText() + "'");
            }
        }
        assertNoProblems(problems);
    }

    static String describe(JsonNode exp) {
        return exp.path("kind").asText() + " " + exp.path("src").asText(exp.path("srcPrefix").asText() + "*")
                + " -> " + exp.path("dst").asText(exp.path("dstPrefix").asText() + "*") + " [" + exp.path("resolution").asText("any") + "]";
    }

    static String nearby(JsonNode exp) {
        StringBuilder sb = new StringBuilder();
        for (JsonNode e : EDGES) {
            if (exp.path("kind").asText().equals(e.path("kind").asText()) && endpointMatches(exp, "src", e.path("src").asText())) {
                sb.append("\n      have: -> ").append(e.path("dst").asText()).append(" [").append(e.path("resolution").asText()).append("] ")
                        .append(e.path("attrs"));
            }
        }
        return sb.toString();
    }

    static List<String> read(Path p) {
        try {
            return Files.readAllLines(p);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static void assertNoProblems(List<String> problems) {
        if (!problems.isEmpty()) {
            fail(problems.size() + " problem(s):\n  " + String.join("\n  ", problems));
        }
    }
}
