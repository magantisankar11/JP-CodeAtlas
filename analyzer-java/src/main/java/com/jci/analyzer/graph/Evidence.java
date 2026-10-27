package com.jci.analyzer.graph;

/** Where a fact was observed. Lines are 1-based and refer to the analysed commit. */
public record Evidence(String filePath, int line, int endLine, int column, String rule, Resolution resolution) {
}
