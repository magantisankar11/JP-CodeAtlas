package com.jci.analyzer.source;

import com.jci.analyzer.graph.Ids;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * The exact sources being analysed. In HEAD mode the committed tree is exported with
 * {@code git archive} into the tool workspace, so every reported line belongs to {@link #commitSha}.
 * Nothing is ever written below the target repository.
 */
public final class SourceSet {

    private final AnalyzerConfig config;
    private final Path repo;
    private final Path root;
    private final String commitSha;
    private final AnalyzerConfig.SourceMode mode;
    private final boolean git;
    private final String statusBefore;
    private final List<String> warnings = new ArrayList<>();

    private SourceSet(AnalyzerConfig config, Path repo, Path root, String commitSha, AnalyzerConfig.SourceMode mode, boolean git, String statusBefore) {
        this.config = config;
        this.repo = repo;
        this.root = root;
        this.commitSha = commitSha;
        this.mode = mode;
        this.git = git;
        this.statusBefore = statusBefore;
    }

    public static SourceSet prepare(AnalyzerConfig cfg) throws IOException {
        Path repo = cfg.repo().toRealPath();
        Files.createDirectories(cfg.workspace());
        Path ws = cfg.workspace().toRealPath();
        if (ws.startsWith(repo)) {
            throw new IllegalArgumentException("Workspace " + ws + " is inside the target repository; refusing to run (indexing must be read-only).");
        }
        Path outParent = cfg.out().toAbsolutePath().normalize().getParent();
        if (outParent != null && outParent.startsWith(repo)) {
            throw new IllegalArgumentException("Output " + cfg.out() + " is inside the target repository; refusing to run.");
        }
        boolean git = Git.isRepoRoot(repo);
        AnalyzerConfig.SourceMode mode = cfg.mode();
        if (mode == AnalyzerConfig.SourceMode.AUTO) {
            mode = git ? AnalyzerConfig.SourceMode.HEAD : AnalyzerConfig.SourceMode.WORKTREE;
        }
        if (mode == AnalyzerConfig.SourceMode.HEAD && !git) {
            throw new IllegalArgumentException("HEAD mode needs a git repository root: " + repo);
        }
        if (!git) {
            String sha = "nogit-" + contentHash(repo, cfg.sourceRoots());
            return new SourceSet(cfg, repo, repo, sha, mode, false, null);
        }
        // A specific commit (--commit) is exported exactly like HEAD; the working tree is never consulted.
        String rev = cfg.commit() == null ? "HEAD" : cfg.commit();
        if (cfg.commit() != null && mode != AnalyzerConfig.SourceMode.HEAD) {
            throw new IllegalArgumentException("--commit requires HEAD (committed tree) mode");
        }
        String sha = Git.run(repo, "rev-parse", "--verify", rev + "^{commit}").trim();
        String status = Git.run(repo, "status", "--porcelain=v1");
        Path root = repo;
        if (mode == AnalyzerConfig.SourceMode.HEAD) {
            root = ws.resolve(safe(cfg.repoId())).resolve(sha).resolve("src");
            if (!Files.exists(root.resolve(".complete"))) {
                exportHead(repo, root, cfg.sourceRoots(), sha);
            }
        }
        SourceSet s = new SourceSet(cfg, repo, root, sha, mode, true, status);
        if (cfg.commit() == null) {
            s.checkDirtyScope(status);
        }
        return s;
    }

    private void checkDirtyScope(String status) {
        long dirty = status.lines()
                .filter(l -> l.length() > 3 && l.charAt(0) != '?')
                .map(l -> l.substring(3))
                .filter(p -> config.sourceRoots().stream().anyMatch(p::startsWith))
                .count();
        if (dirty > 0) {
            String where = mode == AnalyzerConfig.SourceMode.HEAD
                    ? "analysis reflects committed HEAD " + commitSha + ", not the working tree"
                    : "WORKTREE mode: line numbers may not match commit " + commitSha;
            warnings.add(dirty + " modified tracked file(s) under the source roots; " + where);
        }
    }

    private static void exportHead(Path repo, Path target, List<String> roots, String sha) throws IOException {
        Path tmp = Files.createDirectories(target.getParent()).resolve("src-export.zip");
        List<String> args = new ArrayList<>(List.of("archive", "--format=zip", "-o", tmp.toString(), sha, "--"));
        args.addAll(roots);
        Git.run(repo, args.toArray(String[]::new));
        if (Files.exists(target)) {
            deleteTree(target);
        }
        Files.createDirectories(target);
        try (InputStream in = Files.newInputStream(tmp); ZipInputStream zip = new ZipInputStream(in)) {
            ZipEntry e;
            while ((e = zip.getNextEntry()) != null) {
                Path dest = target.resolve(e.getName()).normalize();
                if (!dest.startsWith(target)) {
                    throw new IOException("Refusing zip entry outside target: " + e.getName());
                }
                if (e.isDirectory()) {
                    Files.createDirectories(dest);
                } else {
                    Files.createDirectories(dest.getParent());
                    Files.copy(zip, dest, StandardCopyOption.REPLACE_EXISTING);
                }
            }
        }
        Files.delete(tmp);
        Files.writeString(target.resolve(".complete"), "ok");
    }

    private static void deleteTree(Path p) throws IOException {
        try (Stream<Path> s = Files.walk(p)) {
            for (Path x : s.sorted(Comparator.reverseOrder()).toList()) {
                Files.delete(x);
            }
        }
    }

    private static String contentHash(Path repo, List<String> roots) throws IOException {
        StringBuilder sb = new StringBuilder();
        for (String r : roots) {
            Path dir = repo.resolve(r);
            if (!Files.isDirectory(dir)) {
                continue;
            }
            try (Stream<Path> s = Files.walk(dir)) {
                for (Path f : s.filter(x -> x.toString().endsWith(".java")).sorted().toList()) {
                    sb.append(repo.relativize(f).toString().replace('\\', '/')).append('\n');
                    sb.append(Ids.sha1(Files.readString(f))).append('\n');
                }
            }
        }
        return Ids.sha1(sb.toString()).substring(0, 12);
    }

    private static String safe(String s) {
        return s.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    /** Fails loudly if the target working tree changed while we were running. */
    public void verifyUnchanged() throws IOException {
        if (!git) {
            return;
        }
        String after = Git.run(repo, "status", "--porcelain=v1");
        if (!after.equals(statusBefore)) {
            throw new IllegalStateException("Target repository status changed during indexing. Before:\n" + statusBefore + "\nAfter:\n" + after);
        }
    }

    /**
     * Text files under the given repo-relative directories, read into memory only (HEAD: streamed from
     * {@code git archive}; WORKTREE: read from disk). Keys are repo-relative paths, sorted.
     */
    public java.util.SortedMap<String, String> readTree(List<String> dirs) throws IOException {
        java.util.SortedMap<String, String> out = new java.util.TreeMap<>();
        if (git && mode == AnalyzerConfig.SourceMode.HEAD) {
            List<String> existing = new ArrayList<>();
            for (String d : dirs) {
                if (!Git.run(repo, "ls-tree", "-d", "--name-only", commitSha, "--", d).isBlank()) {
                    existing.add(d);
                }
            }
            if (existing.isEmpty()) {
                return out;
            }
            List<String> args = new ArrayList<>(List.of("archive", "--format=zip", commitSha, "--"));
            args.addAll(existing);
            byte[] zipBytes = Git.runBytes(repo, args.toArray(String[]::new));
            try (ZipInputStream zip = new ZipInputStream(new java.io.ByteArrayInputStream(zipBytes))) {
                ZipEntry e;
                while ((e = zip.getNextEntry()) != null) {
                    if (!e.isDirectory()) {
                        out.put(e.getName(), new String(zip.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8));
                    }
                }
            }
            return out;
        }
        for (String d : dirs) {
            Path dir = repo.resolve(d);
            if (!Files.isDirectory(dir)) {
                continue;
            }
            try (Stream<Path> s = Files.walk(dir)) {
                for (Path f : s.filter(Files::isRegularFile).toList()) {
                    out.put(repo.relativize(f).toString().replace('\\', '/'), Files.readString(f));
                }
            }
        }
        return out;
    }

    /** One repo-relative file at the analysed revision, in memory only; empty if absent. */
    public java.util.Optional<String> readFile(String path) throws IOException {
        if (git && mode == AnalyzerConfig.SourceMode.HEAD) {
            if (Git.run(repo, "ls-tree", "--name-only", commitSha, "--", path).isBlank()) {
                return java.util.Optional.empty();
            }
            return java.util.Optional.of(Git.run(repo, "show", commitSha + ":" + path));
        }
        Path f = repo.resolve(path);
        return Files.isRegularFile(f) ? java.util.Optional.of(Files.readString(f)) : java.util.Optional.empty();
    }

    public List<Path> sourceRootDirs() {
        List<Path> dirs = new ArrayList<>();
        for (String r : config.sourceRoots()) {
            Path d = root.resolve(r);
            if (Files.isDirectory(d)) {
                dirs.add(d);
            }
        }
        return dirs;
    }

    /** Repo-relative path with forward slashes, or null when the file is not part of this source set. */
    public String relativize(File file) {
        if (file == null) {
            return null;
        }
        Path p = file.toPath().toAbsolutePath().normalize();
        Path r = root.toAbsolutePath().normalize();
        if (!p.startsWith(r)) {
            try {
                p = p.toRealPath();
                r = r.toRealPath();
            } catch (IOException e) {
                return null;
            }
            if (!p.startsWith(r)) {
                return null;
            }
        }
        return r.relativize(p).toString().replace('\\', '/');
    }

    public long javaFileCount() throws IOException {
        long n = 0;
        for (Path d : sourceRootDirs()) {
            try (Stream<Path> s = Files.walk(d)) {
                n += s.filter(x -> x.toString().endsWith(".java")).count();
            }
        }
        return n;
    }

    public Path repo() {
        return repo;
    }

    public Path root() {
        return root;
    }

    public String commitSha() {
        return commitSha;
    }

    public AnalyzerConfig.SourceMode mode() {
        return mode;
    }

    public boolean isGit() {
        return git;
    }

    public List<String> warnings() {
        return warnings;
    }
}
