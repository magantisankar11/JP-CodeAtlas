package com.jci.analyzer.spoon;

/** Exposes package-private matching for unit tests. */
public final class SecurityTestAccess {

    private SecurityTestAccess() {
    }

    public static String match(String pattern, String path) {
        return SecurityExtractor.match(pattern, path).name();
    }
}
