package com.jci.analyzer.graph;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;

/**
 * Stable identifiers. IDs never contain the commit SHA so the same symbol keeps its ID across commits.
 * Nested types use '.' (not '$') so IDs match what developers type and what JavaParser reports.
 */
public final class Ids {

    private Ids() {
    }

    public static String normalizeFqn(String fqn) {
        return fqn == null ? "?" : fqn.replace('$', '.');
    }

    public static String type(String fqn) {
        return "type:" + normalizeFqn(fqn);
    }

    public static String method(String typeFqn, String name, List<String> paramTypes) {
        return "method:" + normalizeFqn(typeFqn) + "#" + name + "(" + String.join(",", paramTypes.stream().map(Ids::normalizeFqn).toList()) + ")";
    }

    public static String endpoint(String httpMethod, String path) {
        return "endpoint:" + httpMethod + " " + path;
    }

    public static String sql(String ownerMethodId, int line, int column) {
        return "sql:" + ownerMethodId + "@L" + line + "C" + column;
    }

    public static String table(String name) {
        return "table:" + name.toLowerCase(Locale.ROOT);
    }

    public static String unresolved(String reason, String ownerId, int line, int column) {
        return "unresolved:" + reason + ":" + ownerId + "@L" + line + "C" + column;
    }

    public static String edge(String kind, String src, String dst) {
        return "e:" + sha1(kind + "|" + src + "|" + dst).substring(0, 20);
    }

    public static String sha1(String s) {
        return digest("SHA-1", s.getBytes(StandardCharsets.UTF_8));
    }

    public static String digest(String algorithm, byte[] data) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance(algorithm).digest(data));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
