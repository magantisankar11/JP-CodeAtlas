package com.jci.analyzer.util;

import java.util.regex.Pattern;

/** Masks secret-looking values in any text the analyzer emits (SQL, literals). Bind parameters are left alone. */
public final class Redactor {

    public static final String MASK = "***REDACTED***";

    private static final Pattern KEY_VALUE = Pattern.compile(
            "(?i)\\b(password|passwd|pwd|secret|client[_-]?secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key)\\b(\\s*[=:]\\s*)(?![:?])('[^']*'|\"[^\"]*\"|[^\\s,;&)]+)");
    private static final Pattern AWS_KEY = Pattern.compile("\\b(AKIA|ASIA)[0-9A-Z]{16}\\b");
    private static final Pattern PEM = Pattern.compile("-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----");
    private static final Pattern JWT = Pattern.compile("\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b");

    private Redactor() {
    }

    public static String redact(String s) {
        if (s == null || s.isEmpty()) {
            return s;
        }
        String r = PEM.matcher(s).replaceAll(MASK);
        r = KEY_VALUE.matcher(r).replaceAll("$1$2" + MASK);
        r = AWS_KEY.matcher(r).replaceAll(MASK);
        r = JWT.matcher(r).replaceAll(MASK);
        return r;
    }
}
