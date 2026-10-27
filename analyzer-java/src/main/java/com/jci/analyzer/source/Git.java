package com.jci.analyzer.source;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Read-only git access. Every call passes --no-optional-locks so git never refreshes
 * .git/index (plain "git status" may rewrite it).
 */
final class Git {

    private Git() {
    }

    static String run(Path repo, String... args) throws IOException {
        return new String(runBytes(repo, args), StandardCharsets.UTF_8);
    }

    static byte[] runBytes(Path repo, String... args) throws IOException {
        List<String> cmd = new ArrayList<>();
        cmd.add("git");
        cmd.add("--no-optional-locks");
        cmd.add("-C");
        cmd.add(repo.toString());
        cmd.addAll(List.of(args));
        ProcessBuilder pb = new ProcessBuilder(cmd).redirectErrorStream(false);
        pb.environment().put("GIT_OPTIONAL_LOCKS", "0");
        Process p = pb.start();
        byte[] out = p.getInputStream().readAllBytes();
        byte[] err = p.getErrorStream().readAllBytes();
        try {
            if (!p.waitFor(10, TimeUnit.MINUTES)) {
                p.destroyForcibly();
                throw new IOException("git timed out: " + String.join(" ", args));
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException(e);
        }
        if (p.exitValue() != 0) {
            throw new IOException("git " + String.join(" ", args) + " failed: " + new String(err, StandardCharsets.UTF_8).trim());
        }
        return out;
    }

    /** True only when {@code dir} itself is the top level of a work tree (not a parent repo's subfolder). */
    static boolean isRepoRoot(Path dir) {
        try {
            String top = run(dir, "rev-parse", "--show-toplevel").trim();
            return Path.of(top).toRealPath().equals(dir.toRealPath());
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }
}
