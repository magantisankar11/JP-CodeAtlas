package com.jci.analyzer;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jci.analyzer.graph.Graph;
import com.jci.analyzer.graph.Graph.EdgeRec;
import com.jci.analyzer.graph.Graph.NodeRec;
import com.jci.analyzer.source.AnalyzerConfig;
import com.jci.analyzer.source.SourceSet;
import com.jci.analyzer.source.PropertyIndex;
import com.jci.analyzer.spoon.CallGraphExtractor;
import com.jci.analyzer.spoon.ConfigExtractor;
import com.jci.analyzer.spoon.ConstantFolder;
import com.jci.analyzer.spoon.ContractExtractor;
import com.jci.analyzer.spoon.DatabaseNodes;
import com.jci.analyzer.spoon.EntityMapper;
import com.jci.analyzer.spoon.EntryPointExtractor;
import com.jci.analyzer.spoon.ExceptionExtractor;
import com.jci.analyzer.spoon.ExternalExtractor;
import com.jci.analyzer.spoon.SecurityExtractor;
import com.jci.analyzer.sql.SchemaCatalog;
import spoon.reflect.declaration.CtClass;
import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtMethod;
import com.jci.analyzer.spoon.EndpointExtractor;
import com.jci.analyzer.spoon.LombokSynthesizer;
import com.jci.analyzer.spoon.NodeFactory;
import com.jci.analyzer.spoon.SpoonSupport;
import com.jci.analyzer.spoon.SqlExtractor;
import com.jci.analyzer.spoon.TypeExtractor;
import com.jci.analyzer.spoon.TypeIndex;
import spoon.Launcher;
import spoon.compiler.Environment;
import spoon.reflect.CtModel;
import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.CtTypeParameter;
import spoon.reflect.visitor.filter.TypeFilter;

import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryType;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Full (non-incremental) analysis of one source set into one NDJSON snapshot. */
public final class Analyzer {

    public static final String VERSION = "0.2.0";
    public static final String ENGINE = "spoon-11.5.0/noclasspath+lombok-synth";

    public record Outcome(Path out, ObjectNode snapshot, Graph graph) {
    }

    public Outcome run(AnalyzerConfig cfg) throws IOException {
        Instant started = Instant.now();
        resetHeapPeaks();
        SourceSet src = SourceSet.prepare(cfg);
        Graph graph = new Graph();
        src.warnings().forEach(w -> graph.diagnostic("WARN", "DIRTY_WORKTREE", w, null, null));

        long t0 = System.nanoTime();
        Launcher launcher = spoonLauncher(src.sourceRootDirs(), cfg.classpath());
        CtModel model = launcher.buildModel();
        long modelMs = (System.nanoTime() - t0) / 1_000_000;

        long t1 = System.nanoTime();
        SpoonSupport support = new SpoonSupport(src, cfg);
        List<CtType<?>> allTypes = new ArrayList<>();
        for (CtType<?> t : model.getElements(new TypeFilter<>(CtType.class))) {
            if (!(t instanceof CtTypeParameter)) {
                allTypes.add(t);
            }
        }
        LombokSynthesizer lombok = new LombokSynthesizer(launcher.getFactory(), support);
        lombok.apply(allTypes);
        TypeIndex index = new TypeIndex(allTypes, support);
        NodeFactory nodes = new NodeFactory(graph, support, index);

        PropertyIndex props = PropertyIndex.load(src, cfg.propertyFiles());
        String contextPath = props.whitelistedValue("server.servlet.context-path").filter(v -> !v.contains("${")).orElse("");
        SchemaCatalog catalog = SchemaCatalog.load(src.readTree(cfg.schemaDirs()));
        DatabaseNodes db = new DatabaseNodes(graph, catalog, cfg.module());
        db.emitCatalog();

        TypeExtractor types = new TypeExtractor(graph, support, index, nodes);
        ContractExtractor contract = new ContractExtractor(graph, support, index, nodes);
        EndpointExtractor endpoints = new EndpointExtractor(graph, support, nodes, contract, contextPath);
        SqlExtractor sql = new SqlExtractor(graph, support, nodes, entityTables(allTypes, support), db);
        EntityMapper entities = new EntityMapper(graph, support, nodes, db,
                props.whitelistedValue("spring.jpa.hibernate.naming.physical-strategy").orElse(null));
        ExternalExtractor external = new ExternalExtractor(graph, support, nodes);
        ConfigExtractor config = new ConfigExtractor(graph, support, nodes, props);
        EntryPointExtractor entryPoints = new EntryPointExtractor(graph, support, index, nodes);
        ExceptionExtractor exceptions = new ExceptionExtractor(graph, support, index, nodes);
        SecurityExtractor security = new SecurityExtractor(support);
        CallGraphExtractor calls = new CallGraphExtractor(graph, support, index, nodes, sql)
                .listen(external).listen(config).listen(entryPoints);

        int inScopeTypes = 0;
        List<CtType<?>> tops = new ArrayList<>();
        List<CtType<?>> named = new ArrayList<>();
        for (CtType<?> top : model.getAllTypes()) {
            if (!support.inScope(top)) {
                continue;
            }
            tops.add(top);
            for (CtType<?> t : top.getElements(new TypeFilter<>(CtType.class))) {
                if (t instanceof CtTypeParameter || t.isAnonymous() || t.isLocalType()) {
                    continue;
                }
                inScopeTypes++;
                named.add(t);
                types.extract(t);
                endpoints.extract(t);
                contract.type(t);
                entities.map(t);
                external.feignClient(t);
                config.type(t);
                entryPoints.type(t);
                exceptions.type(t);
                security.type(t);
            }
        }
        for (CtType<?> top : tops) {
            calls.extract(top);
            exceptions.throwStatements(top);
        }
        for (CtType<?> t : named) {
            for (CtMethod<?> m : t.getMethods()) {
                if (m.getBody() != null || !m.getParameters().isEmpty() || m.getType() != null) {
                    contract.uses(m, nodes.method(m).id);
                }
            }
            if (t instanceof CtClass<?> c) {
                for (CtConstructor<?> ctor : c.getConstructors()) {
                    if (!ctor.isImplicit()) {
                        contract.uses(ctor, nodes.method(ctor).id);
                    }
                }
            }
        }
        contract.classifyDtos();
        security.apply(graph);
        closeDanglingEdges(graph);
        long analyzeMs = (System.nanoTime() - t1) / 1_000_000;

        src.verifyUnchanged();

        ObjectNode snap = graph.mapper().createObjectNode();
        snap.put("type", "snapshot");
        snap.put("schemaVersion", Graph.SCHEMA_VERSION);
        snap.put("repoId", cfg.repoId());
        snap.put("repoPath", src.repo().toString().replace('\\', '/'));
        snap.put("commitSha", src.commitSha());
        snap.put("sourceMode", src.mode().name());
        snap.put("analyzerVersion", VERSION);
        snap.put("engine", ENGINE);
        snap.put("startedAt", started.toString());
        snap.put("finishedAt", Instant.now().toString());
        ObjectNode scope = snap.putObject("scope");
        ArrayNode roots = scope.putArray("sourceRoots");
        cfg.sourceRoots().forEach(roots::add);
        ArrayNode inc = scope.putArray("includePackages");
        cfg.includePackages().forEach(inc::add);
        scope.put("module", cfg.module());
        scope.put("contextPath", contextPath);
        ArrayNode schemaDirs = scope.putArray("schemaDirs");
        cfg.schemaDirs().forEach(schemaDirs::add);

        ObjectNode stats = snap.putObject("stats");
        stats.put("javaFilesParsed", src.javaFileCount());
        stats.put("typesInSource", index.typeCount());
        stats.put("typesInScope", inScopeTypes);
        stats.put("springBeans", index.beanCount());
        stats.put("endpoints", endpoints.endpointCount());
        stats.put("lombokMembersSynthesized", lombok.synthesizedCount());
        putMap(stats.putObject("lombokUnsupported"), lombok.unsupported());
        putMap(stats.putObject("calls"), calls.stats());
        putMap(stats.putObject("sql"), sql.stats());
        putMap(stats.putObject("schemaCatalog"), catalog.stats());
        ObjectNode ent = stats.putObject("entities");
        ent.put("mapped", entities.mapped());
        ent.put("columnsNotInCatalog", entities.columnMismatches());
        putMap(stats.putObject("external"), external.stats());
        putMap(stats.putObject("config"), config.stats());
        stats.put("propertyKeysIndexed", props.keyCount());
        putMap(stats.putObject("entryPoints"), entryPoints.stats());
        putMap(stats.putObject("exceptions"), exceptions.stats());
        stats.put("usesTypeEdges", contract.usesTypeEdges());
        stats.set("security", security.summary(graph));
        Map<String, Integer> byKind = new TreeMap<>();
        Map<String, Integer> byResolution = new TreeMap<>();
        for (EdgeRec e : graph.edges()) {
            byKind.merge(e.kind, 1, Integer::sum);
            byResolution.merge(e.kind + ":" + e.resolution.name(), 1, Integer::sum);
        }
        Map<String, Integer> nodeKinds = new TreeMap<>();
        for (NodeRec n : graph.nodes()) {
            nodeKinds.merge(n.kind, 1, Integer::sum);
        }
        putMap(stats.putObject("nodesByKind"), nodeKinds);
        putMap(stats.putObject("edgesByKind"), byKind);
        putMap(stats.putObject("edgesByKindAndResolution"), byResolution);
        stats.put("modelBuildMs", modelMs);
        stats.put("analysisMs", analyzeMs);
        stats.put("heapPeakMb", heapPeakMb());
        stats.put("diagnostics", graph.diagnostics().size());

        graph.write(cfg.out(), snap);
        return new Outcome(cfg.out(), snap, graph);
    }

    public static Launcher spoonLauncher(List<Path> sourceRoots, List<Path> classpath) {
        Launcher launcher = new Launcher();
        Environment env = launcher.getEnvironment();
        env.setNoClasspath(true);
        env.setComplianceLevel(21);
        env.setCommentEnabled(false);
        env.setAutoImports(false);
        env.setIgnoreDuplicateDeclarations(true);
        env.setIgnoreSyntaxErrors(true);
        env.setShouldCompile(false);
        if (classpath != null && !classpath.isEmpty()) {
            env.setSourceClasspath(classpath.stream().map(Path::toString).toArray(String[]::new));
        }
        for (Path d : sourceRoots) {
            launcher.addInputResource(d.toString());
        }
        return launcher;
    }

    private static Map<String, String> entityTables(List<CtType<?>> types, SpoonSupport support) {
        Map<String, String> out = new HashMap<>();
        for (CtType<?> t : types) {
            if (!support.isInSource(t) || !SpoonSupport.hasAnnotation(t, "Entity")) {
                continue;
            }
            CtAnnotation<?> table = SpoonSupport.annotation(t, "Table");
            ConstantFolder.Result name = table == null || SpoonSupport.annotationValue(table, "name") == null
                    ? null : new ConstantFolder().fold(SpoonSupport.annotationValue(table, "name"));
            out.put(t.getSimpleName(), name != null && name.complete() ? name.value() : t.getSimpleName());
        }
        return out;
    }

    /** Every edge endpoint must exist as a node; anything missing becomes an explicit UNRESOLVED stub. */
    private static void closeDanglingEdges(Graph graph) {
        List<String> missing = new ArrayList<>();
        for (EdgeRec e : graph.edges()) {
            for (String id : new String[] {e.src, e.dst}) {
                if (!graph.hasNode(id)) {
                    missing.add(id);
                }
            }
        }
        for (String id : missing) {
            if (graph.hasNode(id)) {
                continue;
            }
            NodeRec n = new NodeRec(id, "UNRESOLVED", id);
            n.stub = true;
            n.attrs.put("reason", "MISSING_NODE");
            graph.putNode(n);
            graph.diagnostic("WARN", "DANGLING_EDGE_ENDPOINT", "Edge endpoint had no node: " + id, null, null);
        }
    }

    private static void putMap(ObjectNode o, Map<String, Integer> m) {
        m.forEach(o::put);
    }

    private static void resetHeapPeaks() {
        for (MemoryPoolMXBean p : ManagementFactory.getMemoryPoolMXBeans()) {
            if (p.getType() == MemoryType.HEAP) {
                p.resetPeakUsage();
            }
        }
    }

    static long heapPeakMb() {
        long sum = 0;
        for (MemoryPoolMXBean p : ManagementFactory.getMemoryPoolMXBeans()) {
            if (p.getType() == MemoryType.HEAP && p.getPeakUsage() != null) {
                sum += p.getPeakUsage().getUsed();
            }
        }
        return sum / (1024 * 1024);
    }
}
