package com.jci.analyzer.cli;

import com.jci.analyzer.Analyzer;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;

class MainVersionTest {

    @Test
    void versionPrintsTheAnalyzerVersionWrittenIntoGraphs() throws Exception {
        PrintStream original = System.out;
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        System.setOut(new PrintStream(buf, true, StandardCharsets.UTF_8));
        try {
            Main.main(new String[] {"version"});
        } finally {
            System.setOut(original);
        }
        assertEquals(Analyzer.VERSION, buf.toString(StandardCharsets.UTF_8).trim());
    }
}
