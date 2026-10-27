package com.jci.analyzer.source;

import java.nio.file.Path;
import java.util.List;

/**
 * @param repo            target repository (read-only)
 * @param sourceRoots     repo-relative source roots, e.g. src/main/java
 * @param includePackages package prefixes whose code is analysed; empty = everything.
 *                        The whole source tree is always parsed so references outside the scope still resolve.
 * @param workspace       tool-owned directory for extracted sources and caches; must be outside {@code repo}
 * @param schemaDirs      repo-relative directories of SQL migrations / procedures (read in memory, never copied)
 * @param propertyFiles   repo-relative Spring property files; only keys are read, plus whitelisted values
 * @param commit          commit-ish to analyse instead of HEAD (null = HEAD); read via git archive, never checked out
 */
public record AnalyzerConfig(
        Path repo,
        String repoId,
        String module,
        List<String> sourceRoots,
        List<String> includePackages,
        Path out,
        Path workspace,
        SourceMode mode,
        List<Path> classpath,
        List<String> schemaDirs,
        List<String> propertyFiles,
        String commit) {

    public static final List<String> DEFAULT_SCHEMA_DIRS = List.of("src/main/resources/db/migration", "src/main/resources/Stored_Procedures");
    public static final List<String> DEFAULT_PROPERTY_FILES = List.of(
            "src/main/resources/application.properties", "src/main/resources/application.yml", "src/main/resources/application.yaml");

    public enum SourceMode { HEAD, WORKTREE, AUTO }

    /** Phase 1 constructor shape: default schema dirs and property files. */
    public AnalyzerConfig(Path repo, String repoId, String module, List<String> sourceRoots, List<String> includePackages,
                          Path out, Path workspace, SourceMode mode, List<Path> classpath) {
        this(repo, repoId, module, sourceRoots, includePackages, out, workspace, mode, classpath, DEFAULT_SCHEMA_DIRS, DEFAULT_PROPERTY_FILES, null);
    }

    public boolean inScope(String packageName) {
        if (includePackages.isEmpty()) {
            return true;
        }
        String pkg = packageName == null ? "" : packageName;
        for (String p : includePackages) {
            if (pkg.equals(p) || pkg.startsWith(p + ".")) {
                return true;
            }
        }
        return false;
    }
}
