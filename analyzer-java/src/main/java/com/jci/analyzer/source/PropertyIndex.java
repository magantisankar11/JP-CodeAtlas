package com.jci.analyzer.source;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Spring property keys and where they are defined. Values are never retained, except for a short whitelist of
 * structural keys that cannot hold secrets (servlet paths, JPA naming strategy).
 */
public final class PropertyIndex {

    public static final Set<String> VALUE_WHITELIST = Set.of(
            "server.servlet.context-path", "spring.mvc.servlet.path", "spring.jpa.hibernate.naming.physical-strategy");

    public record Definition(String file, int line) {
    }

    private final Map<String, List<Definition>> keys = new LinkedHashMap<>();
    private final Map<String, String> whitelisted = new LinkedHashMap<>();

    public static PropertyIndex load(SourceSet src, List<String> files) throws IOException {
        PropertyIndex idx = new PropertyIndex();
        for (String f : files) {
            Optional<String> text = src.readFile(f);
            if (text.isEmpty()) {
                continue;
            }
            if (f.endsWith(".properties")) {
                idx.properties(f, text.get());
            } else {
                idx.yaml(f, text.get());
            }
        }
        return idx;
    }

    private void properties(String file, String text) {
        String[] lines = text.split("\\R", -1);
        for (int i = 0; i < lines.length; i++) {
            String l = lines[i].strip();
            if (l.isEmpty() || l.startsWith("#") || l.startsWith("!")) {
                continue;
            }
            int sep = indexOfSeparator(l);
            String key = (sep < 0 ? l : l.substring(0, sep)).strip();
            if (key.isEmpty()) {
                continue;
            }
            keys.computeIfAbsent(key, k -> new ArrayList<>()).add(new Definition(file, i + 1));
            if (sep >= 0 && VALUE_WHITELIST.contains(key)) {
                whitelisted.put(key, l.substring(sep + 1).strip());
            }
        }
    }

    /** Minimal YAML: nested "key:" lines by indentation; values are only read for whitelisted keys. */
    private void yaml(String file, String text) {
        String[] lines = text.split("\\R", -1);
        List<String> stack = new ArrayList<>();
        List<Integer> indents = new ArrayList<>();
        for (int i = 0; i < lines.length; i++) {
            String raw = lines[i];
            String l = raw.strip();
            if (l.isEmpty() || l.startsWith("#") || l.startsWith("-") || l.equals("---")) {
                continue;
            }
            int colon = l.indexOf(':');
            if (colon <= 0) {
                continue;
            }
            int indent = raw.length() - raw.stripLeading().length();
            while (!indents.isEmpty() && indents.get(indents.size() - 1) >= indent) {
                indents.remove(indents.size() - 1);
                stack.remove(stack.size() - 1);
            }
            stack.add(l.substring(0, colon).strip());
            indents.add(indent);
            String rest = l.substring(colon + 1).strip();
            if (!rest.isEmpty()) {
                String key = String.join(".", stack);
                keys.computeIfAbsent(key, k -> new ArrayList<>()).add(new Definition(file, i + 1));
                if (VALUE_WHITELIST.contains(key)) {
                    whitelisted.put(key, rest.replaceAll("^[\"']|[\"']$", ""));
                }
            }
        }
    }

    private static int indexOfSeparator(String l) {
        for (int i = 0; i < l.length(); i++) {
            char c = l.charAt(i);
            if (c == '\\') {
                i++;
            } else if (c == '=' || c == ':') {
                return i;
            }
        }
        return -1;
    }

    public List<Definition> definitions(String key) {
        return keys.getOrDefault(key, List.of());
    }

    public Optional<String> whitelistedValue(String key) {
        return Optional.ofNullable(whitelisted.get(key));
    }

    public int keyCount() {
        return keys.size();
    }

    /** "${a.b:default}" -> "a.b"; null when the text is not a single placeholder. */
    public static String placeholderKey(String expression) {
        if (expression == null) {
            return null;
        }
        String s = expression.strip();
        if (!s.startsWith("${") || !s.endsWith("}") || s.indexOf("${", 2) >= 0) {
            return null;
        }
        String inner = s.substring(2, s.length() - 1);
        int colon = inner.indexOf(':');
        return (colon >= 0 ? inner.substring(0, colon) : inner).strip();
    }
}
