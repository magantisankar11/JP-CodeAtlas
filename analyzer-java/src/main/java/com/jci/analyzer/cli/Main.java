package com.jci.analyzer.cli;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jci.analyzer.Analyzer;
import com.jci.analyzer.probe.EngineProbe;
import com.jci.analyzer.source.AnalyzerConfig;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Usage:
 *   analyze --repo DIR --repo-id ID --out FILE.ndjson --workspace DIR [--include pkg,pkg] [--source-root src/main/java]
 *           [--module NAME] [--mode AUTO|HEAD|WORKTREE] [--classpath-file FILE]
 *           [--schema-dir DIR]... (default src/main/resources/db/migration, .../Stored_Procedures)
 *           [--commit SHA] (analyse a past commit via git archive; default HEAD)
 *           [--property-file FILE]... (default src/main/resources/application.{properties,yml,yaml}; keys only)
 *   probe   --engine spoon|spoon-lombok|javaparser (same source options) --out REPORT.json [--golden FILE]
 *   version (prints the analyzerVersion written into graphs; used by npm run sync to decide graph reuse)
 */
public final class Main {

    private Main() {
    }

    /** The analyzerVersion this build writes into snapshot records. */
    static String version() {
        return Analyzer.VERSION;
    }

    public static void main(String[] argv) throws Exception {
        if (argv.length == 1 && "version".equals(argv[0])) {
            System.out.println(version());
            return;
        }
        if (argv.length == 0 || !Arrays.asList("analyze", "probe").contains(argv[0])) {
            System.err.println("usage: (analyze|probe) --repo DIR --repo-id ID --out FILE --workspace DIR [options] | version");
            System.exit(2);
        }
        Map<String, List<String>> opts = parse(Arrays.copyOfRange(argv, 1, argv.length));
        AnalyzerConfig cfg = config(opts);
        ObjectMapper mapper = new ObjectMapper();
        if ("analyze".equals(argv[0])) {
            Analyzer.Outcome o = new Analyzer().run(cfg);
            System.out.println(mapper.writerWithDefaultPrettyPrinter().writeValueAsString(o.snapshot()));
        } else {
            String golden = one(opts, "golden", null);
            ObjectNode report = new EngineProbe().run(one(opts, "engine", "spoon"), cfg, golden == null ? null : Path.of(golden));
            String json = mapper.writerWithDefaultPrettyPrinter().writeValueAsString(report);
            Files.createDirectories(cfg.out().toAbsolutePath().getParent());
            Files.writeString(cfg.out(), json);
            System.out.println(json);
        }
    }

    static AnalyzerConfig config(Map<String, List<String>> opts) throws Exception {
        Path repo = Path.of(required(opts, "repo"));
        List<Path> cp = new ArrayList<>();
        String cpFile = one(opts, "classpath-file", null);
        if (cpFile != null) {
            for (String p : Files.readString(Path.of(cpFile)).trim().split(java.io.File.pathSeparator)) {
                if (!p.isBlank()) {
                    cp.add(Path.of(p.trim()));
                }
            }
        }
        List<String> roots = opts.getOrDefault("source-root", List.of("src/main/java"));
        List<String> includes = new ArrayList<>();
        for (String s : opts.getOrDefault("include", List.of())) {
            for (String p : s.split(",")) {
                if (!p.isBlank()) {
                    includes.add(p.trim());
                }
            }
        }
        String repoId = required(opts, "repo-id");
        return new AnalyzerConfig(repo, repoId, one(opts, "module", repoId), roots, includes,
                Path.of(required(opts, "out")), Path.of(required(opts, "workspace")),
                AnalyzerConfig.SourceMode.valueOf(one(opts, "mode", "AUTO").toUpperCase()), cp,
                opts.getOrDefault("schema-dir", AnalyzerConfig.DEFAULT_SCHEMA_DIRS),
                opts.getOrDefault("property-file", AnalyzerConfig.DEFAULT_PROPERTY_FILES),
                one(opts, "commit", null));
    }

    static Map<String, List<String>> parse(String[] args) {
        Map<String, List<String>> m = new HashMap<>();
        for (int i = 0; i < args.length; i++) {
            if (!args[i].startsWith("--") || i + 1 >= args.length) {
                throw new IllegalArgumentException("Bad argument near " + args[i]);
            }
            m.computeIfAbsent(args[i].substring(2), k -> new ArrayList<>()).add(args[++i]);
        }
        return m;
    }

    private static String required(Map<String, List<String>> m, String key) {
        String v = one(m, key, null);
        if (v == null) {
            throw new IllegalArgumentException("Missing --" + key);
        }
        return v;
    }

    private static String one(Map<String, List<String>> m, String key, String def) {
        List<String> v = m.get(key);
        return v == null || v.isEmpty() ? def : v.get(v.size() - 1);
    }
}
