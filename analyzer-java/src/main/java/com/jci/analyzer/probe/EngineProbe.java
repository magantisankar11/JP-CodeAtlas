package com.jci.analyzer.probe;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.resolution.declarations.ResolvedConstructorDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedMethodLikeDeclaration;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.CombinedTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.JavaParserTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.ReflectionTypeSolver;
import com.jci.analyzer.Analyzer;
import com.jci.analyzer.graph.Ids;
import com.jci.analyzer.source.AnalyzerConfig;
import com.jci.analyzer.source.SourceSet;
import com.jci.analyzer.spoon.LombokSynthesizer;
import com.jci.analyzer.spoon.SpoonSupport;
import spoon.Launcher;
import spoon.reflect.CtModel;
import spoon.reflect.code.CtConstructorCall;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtNewClass;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.CtTypeParameter;
import spoon.reflect.visitor.filter.TypeFilter;

import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryType;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Stream;

/**
 * Bake-off: how many call sites each engine binds to an in-source declaration, how fast, with how much heap,
 * and whether its static (compile-time) call pairs reproduce the fixture's hand-written golden edges.
 */
public final class EngineProbe {

    private final ObjectMapper mapper = new ObjectMapper();
    private final TreeMap<String, Long> counts = new TreeMap<>();
    private final Set<String> pairs = new LinkedHashSet<>();

    public ObjectNode run(String engine, AnalyzerConfig cfg, Path golden) throws IOException {
        for (MemoryPoolMXBean p : ManagementFactory.getMemoryPoolMXBeans()) {
            if (p.getType() == MemoryType.HEAP) {
                p.resetPeakUsage();
            }
        }
        SourceSet src = SourceSet.prepare(cfg);
        ObjectNode report = mapper.createObjectNode();
        report.put("engine", engine);
        report.put("repoId", cfg.repoId());
        report.put("commitSha", src.commitSha());
        report.put("javaFiles", src.javaFileCount());
        switch (engine) {
            case "spoon" -> spoon(src, cfg, false, report);
            case "spoon-lombok" -> spoon(src, cfg, true, report);
            case "javaparser" -> javaparser(src, cfg, report);
            default -> throw new IllegalArgumentException("Unknown engine " + engine);
        }
        long total = counts.getOrDefault("callSites", 0L);
        ObjectNode c = report.putObject("callSites");
        counts.forEach(c::put);
        if (total > 0) {
            report.put("inSourceBindingRate", round(counts.getOrDefault("inSource", 0L) * 100.0 / total));
            report.put("anyBindingRate", round((counts.getOrDefault("inSource", 0L) + counts.getOrDefault("libraryResolved", 0L)) * 100.0 / total));
        }
        long heap = 0;
        for (MemoryPoolMXBean p : ManagementFactory.getMemoryPoolMXBeans()) {
            if (p.getType() == MemoryType.HEAP && p.getPeakUsage() != null) {
                heap += p.getPeakUsage().getUsed();
            }
        }
        report.put("heapPeakMb", heap / (1024 * 1024));
        report.put("staticPairs", pairs.size());
        if (golden != null) {
            report.set("golden", compareGolden(golden));
        }
        src.verifyUnchanged();
        return report;
    }

    // ------------------------------------------------------------------ Spoon

    private void spoon(SourceSet src, AnalyzerConfig cfg, boolean lombok, ObjectNode report) {
        long t0 = System.nanoTime();
        Launcher launcher = Analyzer.spoonLauncher(src.sourceRootDirs(), cfg.classpath());
        CtModel model = launcher.buildModel();
        report.put("buildMs", (System.nanoTime() - t0) / 1_000_000);
        long t1 = System.nanoTime();
        SpoonSupport support = new SpoonSupport(src, cfg);
        if (lombok) {
            List<CtType<?>> all = new ArrayList<>();
            for (CtType<?> t : model.getElements(new TypeFilter<>(CtType.class))) {
                if (!(t instanceof CtTypeParameter)) {
                    all.add(t);
                }
            }
            new LombokSynthesizer(launcher.getFactory(), support).apply(all);
        }
        for (CtType<?> top : model.getAllTypes()) {
            if (!support.inScope(top)) {
                continue;
            }
            for (CtInvocation<?> inv : top.getElements(new TypeFilter<>(CtInvocation.class))) {
                spoonSite(inv, SpoonSupport.declarationOf(inv.getExecutable()), support);
            }
            for (CtConstructorCall<?> cc : top.getElements(new TypeFilter<>(CtConstructorCall.class))) {
                if (!(cc instanceof CtNewClass<?>)) {
                    spoonSite(cc, SpoonSupport.declarationOf(cc.getExecutable()), support);
                }
            }
        }
        report.put("resolveMs", (System.nanoTime() - t1) / 1_000_000);
    }

    private void spoonSite(CtElement site, CtExecutable<?> decl, SpoonSupport support) {
        inc("callSites");
        if (decl == null) {
            inc("unresolved");
            return;
        }
        if (!support.isInSource(decl)) {
            inc("libraryResolved");
            return;
        }
        if (decl.isImplicit()) {
            inc("implicitConstructor");
            return;
        }
        inc("inSource");
        SpoonSupport.Owner owner = SpoonSupport.ownerOf(site);
        if (owner != null) {
            pairs.add(owner.id() + " -> " + SpoonSupport.methodId(decl));
        }
    }

    // ------------------------------------------------------------------ JavaParser

    private void javaparser(SourceSet src, AnalyzerConfig cfg, ObjectNode report) throws IOException {
        long t0 = System.nanoTime();
        ParserConfiguration pc = new ParserConfiguration().setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21);
        CombinedTypeSolver solver = new CombinedTypeSolver(new ReflectionTypeSolver(false));
        for (Path root : src.sourceRootDirs()) {
            solver.add(new JavaParserTypeSolver(root, pc));
        }
        pc.setSymbolResolver(new JavaSymbolSolver(solver));
        JavaParser parser = new JavaParser(pc);
        List<CompilationUnit> units = new ArrayList<>();
        for (Path root : src.sourceRootDirs()) {
            try (Stream<Path> files = Files.walk(root)) {
                for (Path f : files.filter(p -> p.toString().endsWith(".java")).toList()) {
                    ParseResult<CompilationUnit> r = parser.parse(f);
                    if (r.getResult().isEmpty()) {
                        inc("parseFailedFiles");
                        continue;
                    }
                    CompilationUnit cu = r.getResult().get();
                    String pkg = cu.getPackageDeclaration().map(p -> p.getNameAsString()).orElse("");
                    if (cfg.inScope(pkg)) {
                        units.add(cu);
                    }
                    if (!r.isSuccessful()) {
                        inc("parseProblemFiles");
                    }
                }
            }
        }
        report.put("buildMs", (System.nanoTime() - t0) / 1_000_000);
        long t1 = System.nanoTime();
        for (CompilationUnit cu : units) {
            for (MethodCallExpr mc : cu.findAll(MethodCallExpr.class)) {
                inc("callSites");
                try {
                    ResolvedMethodDeclaration d = mc.resolve();
                    jpBound(mc, d, d.toAst().isPresent());
                } catch (Throwable e) {
                    inc("unresolved");
                }
            }
            for (ObjectCreationExpr oc : cu.findAll(ObjectCreationExpr.class)) {
                if (oc.getAnonymousClassBody().isPresent()) {
                    continue;
                }
                inc("callSites");
                try {
                    ResolvedConstructorDeclaration d = oc.resolve();
                    Optional<Node> ast = d.toAst();
                    if (ast.isEmpty() && isSourceType(d.declaringType().getQualifiedName(), solver)) {
                        inc("implicitConstructor");
                        continue;
                    }
                    jpBound(oc, d, ast.isPresent());
                } catch (Throwable e) {
                    inc("unresolved");
                }
            }
        }
        report.put("resolveMs", (System.nanoTime() - t1) / 1_000_000);
    }

    private static boolean isSourceType(String fqn, CombinedTypeSolver solver) {
        try {
            return solver.tryToSolveType(fqn).isSolved() && solver.solveType(fqn).toAst().isPresent();
        } catch (Throwable e) {
            return false;
        }
    }

    private void jpBound(Node site, ResolvedMethodLikeDeclaration d, boolean inSource) {
        if (!inSource) {
            inc("libraryResolved");
            return;
        }
        inc("inSource");
        Optional<CallableDeclaration> caller = site.findAncestor(CallableDeclaration.class);
        if (caller.isEmpty()) {
            return;
        }
        try {
            ResolvedMethodLikeDeclaration c = caller.get() instanceof MethodDeclaration md ? md.resolve() : ((ConstructorDeclaration) caller.get()).resolve();
            pairs.add(jpId(c) + " -> " + jpId(d));
        } catch (Throwable e) {
            inc("callerUnresolved");
        }
    }

    private static String jpId(ResolvedMethodLikeDeclaration d) {
        List<String> params = new ArrayList<>();
        for (int i = 0; i < d.getNumberOfParams(); i++) {
            String p = d.getParam(i).getType().erasure().describe();
            if (p.endsWith("...")) {
                p = p.substring(0, p.length() - 3) + "[]";
            }
            params.add(p);
        }
        String name = d instanceof ResolvedConstructorDeclaration ? "<init>" : d.getName();
        return Ids.method(d.declaringType().getQualifiedName(), name, params);
    }

    // ------------------------------------------------------------------ golden

    private ObjectNode compareGolden(Path golden) throws IOException {
        JsonNode g = mapper.readTree(golden.toFile());
        ObjectNode out = mapper.createObjectNode();
        ArrayNode missing = out.putArray("missingStaticEdges");
        ArrayNode violations = out.putArray("violations");
        int expected = 0;
        int matched = 0;
        for (JsonNode e : g.path("mustExist")) {
            if (!"CALLS".equals(e.path("kind").asText()) || !"CONFIRMED".equals(e.path("resolution").asText()) || !e.has("dst")) {
                continue;
            }
            expected++;
            String pair = e.path("src").asText() + " -> " + e.path("dst").asText();
            if (pairs.contains(pair)) {
                matched++;
            } else {
                missing.add(pair);
            }
        }
        for (JsonNode e : g.path("mustNotExist")) {
            if (!"CALLS".equals(e.path("kind").asText()) || !e.has("dst") || e.has("resolution")) {
                continue;
            }
            String pair = e.path("src").asText() + " -> " + e.path("dst").asText();
            if (pairs.contains(pair)) {
                violations.add(pair);
            }
        }
        out.put("staticExpected", expected);
        out.put("staticMatched", matched);
        return out;
    }

    private void inc(String key) {
        counts.merge(key, 1L, Long::sum);
    }

    private static double round(double v) {
        return Math.round(v * 10.0) / 10.0;
    }
}
