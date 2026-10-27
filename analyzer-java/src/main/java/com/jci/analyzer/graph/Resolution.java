package com.jci.analyzer.graph;

/** Ordered strongest first; when one edge is seen at several sites the strongest resolution wins. */
public enum Resolution {
    CONFIRMED,
    FRAMEWORK_DERIVED,
    AMBIGUOUS,
    UNRESOLVED;

    public Resolution strongest(Resolution other) {
        return other == null || ordinal() <= other.ordinal() ? this : other;
    }
}
