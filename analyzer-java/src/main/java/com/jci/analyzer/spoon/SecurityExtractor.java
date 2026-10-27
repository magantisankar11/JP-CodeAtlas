package com.jci.analyzer.spoon;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jci.analyzer.graph.Graph;
import com.jci.analyzer.graph.Graph.NodeRec;
import spoon.reflect.code.CtConstructorCall;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtFieldRead;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.cu.SourcePosition;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtType;
import spoon.reflect.visitor.filter.TypeFilter;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * URL authorization rules from SecurityFilterChain beans ({@code requestMatchers(..).permitAll()} etc., evaluated
 * in declaration order, first match wins) applied to every endpoint as attrs.security. Method-level checks inside
 * services (e.g. Casbin enforce calls) are runtime policy and are not represented here.
 */
public final class SecurityExtractor {

    private static final Set<String> RULES = Set.of(
            "permitAll", "authenticated", "denyAll", "anonymous", "fullyAuthenticated", "rememberMe",
            "hasRole", "hasAnyRole", "hasAuthority", "hasAnyAuthority", "access", "hasIpAddress");
    private static final Set<String> MATCHERS = Set.of("requestMatchers", "antMatchers", "mvcMatchers", "regexMatchers", "anyRequest");
    private static final Set<String> FILTER_METHODS = Set.of("addFilterBefore", "addFilterAfter", "addFilterAt", "addFilter");

    /** @param uncertain an argument could not be read statically: the rule may only ever be a "possible" match */
    public record Rule(List<String> patterns, String httpMethod, String rule, List<String> args, String file, int line, int order, boolean uncertain) {
    }

    private final SpoonSupport support;
    private final List<Rule> rules = new ArrayList<>();
    private final List<String> filters = new ArrayList<>();
    private final List<String> sources = new ArrayList<>();

    public SecurityExtractor(SpoonSupport support) {
        this.support = support;
    }

    public void type(CtType<?> t) {
        for (CtMethod<?> m : t.getMethods()) {
            boolean chain = m.getType() != null && "SecurityFilterChain".equals(m.getType().getSimpleName());
            boolean legacy = "configure".equals(m.getSimpleName()) && m.getParameters().size() == 1
                    && "HttpSecurity".equals(m.getParameters().get(0).getType().getSimpleName());
            if (!chain && !legacy) {
                continue;
            }
            sources.add(support.relPath(m) + ":" + SpoonSupport.line(m));
            List<CtInvocation<?>> invs = m.getElements(new TypeFilter<>(CtInvocation.class));
            invs.sort(Comparator.comparingInt(i -> start(i)));
            for (CtInvocation<?> inv : invs) {
                String name = inv.getExecutable().getSimpleName();
                if (RULES.contains(name) && inv.getTarget() instanceof CtInvocation<?> matcher
                        && MATCHERS.contains(matcher.getExecutable().getSimpleName())) {
                    rule(inv, matcher);
                } else if (FILTER_METHODS.contains(name) && !inv.getArguments().isEmpty()) {
                    CtExpression<?> f = inv.getArguments().get(0);
                    String type;
                    try {
                        type = f instanceof CtConstructorCall<?> cc ? cc.getType().getQualifiedName() : f.getType().getQualifiedName();
                    } catch (RuntimeException e) {
                        type = f.toString();
                    }
                    filters.add(name + " " + type + " @" + support.relPath(inv) + ":" + SpoonSupport.line(inv));
                }
            }
        }
    }

    private void rule(CtInvocation<?> rule, CtInvocation<?> matcher) {
        List<String> patterns = new ArrayList<>();
        String method = null;
        if ("anyRequest".equals(matcher.getExecutable().getSimpleName())) {
            patterns.add("/**");
        }
        boolean uncertain = false;
        for (CtExpression<?> a : matcher.getArguments()) {
            String httpMethod = httpMethod(a);
            if (httpMethod != null) {
                method = httpMethod;
                continue;
            }
            String s = TypeIndex.literal(a);
            if (s == null) {
                uncertain = true;
            }
            patterns.add(s != null ? s : ConstantFolder.DYNAMIC);
        }
        List<String> args = new ArrayList<>();
        for (CtExpression<?> a : rule.getArguments()) {
            String s = TypeIndex.literal(a);
            args.add(s != null ? s : a.toString());
        }
        rules.add(new Rule(patterns, method, rule.getExecutable().getSimpleName(), args, support.relPath(rule), SpoonSupport.endLine(rule), rules.size(), uncertain));
    }

    private static final java.util.regex.Pattern HTTP_METHOD = java.util.regex.Pattern.compile("(?:^|\\.)HttpMethod\\.(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE)$");

    /** HttpMethod.X however Spoon models it without a classpath (field read, variable read, type access). */
    static String httpMethod(CtExpression<?> a) {
        java.util.regex.Matcher m = HTTP_METHOD.matcher(String.valueOf(a).strip());
        return m.find() ? m.group(1) : null;
    }

    /** Annotates every endpoint node with the first rule that matches it. */
    public void apply(Graph graph) {
        if (rules.isEmpty()) {
            return;
        }
        for (NodeRec n : graph.nodes()) {
            if (!"API_ENDPOINT".equals(n.kind)) {
                continue;
            }
            String path = n.attrs.path("path").asText();
            String httpMethod = n.attrs.path("httpMethod").asText();
            ObjectNode sec = n.attrs.putObject("security");
            Rule possibleEarlier = null;
            Rule chosen = null;
            for (Rule r : rules) {
                if (r.httpMethod() != null && !"ANY".equals(httpMethod) && !r.httpMethod().equals(httpMethod)) {
                    continue;
                }
                Match best = Match.NO;
                for (String p : r.patterns()) {
                    Match m = match(p, path);
                    if (m.ordinal() < best.ordinal()) {
                        best = m;
                    }
                }
                if (best == Match.EXACT && r.uncertain()) {
                    best = Match.POSSIBLE;
                }
                if (best == Match.EXACT) {
                    chosen = r;
                    break;
                }
                if (best == Match.POSSIBLE && possibleEarlier == null) {
                    possibleEarlier = r;
                }
            }
            if (chosen == null) {
                sec.put("rule", "UNMATCHED");
                continue;
            }
            sec.put("rule", chosen.rule());
            ArrayNode args = sec.putArray("args");
            chosen.args().forEach(args::add);
            sec.put("matcher", String.join(", ", chosen.patterns()));
            sec.put("file", chosen.file());
            sec.put("line", chosen.line());
            sec.put("order", chosen.order());
            if (possibleEarlier != null) {
                sec.put("mayAlsoMatchEarlier", possibleEarlier.rule() + " " + String.join(", ", possibleEarlier.patterns())
                        + " @" + possibleEarlier.file() + ":" + possibleEarlier.line());
            }
        }
    }

    enum Match { EXACT, POSSIBLE, NO }

    /**
     * Spring path-pattern semantics on segments: {@code **} = zero or more segments, {@code *} / {@code ?} within a segment,
     * {@code {var}} = one segment. An endpoint variable segment matched by a literal pattern segment is only POSSIBLE.
     */
    static Match match(String pattern, String path) {
        return seg(split(pattern), 0, split(path), 0);
    }

    private static Match seg(List<String> p, int i, List<String> s, int j) {
        if (i == p.size()) {
            return j == s.size() ? Match.EXACT : Match.NO;
        }
        String ps = p.get(i);
        if ("**".equals(ps)) {
            Match best = Match.NO;
            for (int k = j; k <= s.size(); k++) {
                Match m = seg(p, i + 1, s, k);
                if (m == Match.EXACT) {
                    return m;
                }
                if (m == Match.POSSIBLE) {
                    best = Match.POSSIBLE;
                }
            }
            return best;
        }
        if (j == s.size()) {
            return Match.NO;
        }
        Match here = one(ps, s.get(j));
        if (here == Match.NO) {
            return Match.NO;
        }
        Match rest = seg(p, i + 1, s, j + 1);
        return rest == Match.NO ? Match.NO : here == Match.POSSIBLE || rest == Match.POSSIBLE ? Match.POSSIBLE : Match.EXACT;
    }

    private static Match one(String pattern, String segment) {
        if (pattern.contains(ConstantFolder.DYNAMIC)) {
            return Match.NO;
        }
        boolean variable = segment.startsWith("{") && segment.endsWith("}");
        if (pattern.startsWith("{") && pattern.endsWith("}") || "*".equals(pattern)) {
            return Match.EXACT;
        }
        if (variable) {
            return Match.POSSIBLE;
        }
        StringBuilder regex = new StringBuilder();
        for (char c : pattern.toCharArray()) {
            regex.append(c == '*' ? "[^/]*" : c == '?' ? "[^/]" : java.util.regex.Pattern.quote(String.valueOf(c)));
        }
        return segment.matches(regex.toString()) ? Match.EXACT : Match.NO;
    }

    private static List<String> split(String path) {
        List<String> out = new ArrayList<>();
        for (String s : path.split("/")) {
            if (!s.isEmpty()) {
                out.add(s);
            }
        }
        return out;
    }

    /** End offset: every invocation in a fluent chain starts where the chain starts, but ends in call order. */
    private static int start(CtInvocation<?> i) {
        SourcePosition p = i.getPosition();
        return p != null && p.isValidPosition() ? p.getSourceEnd() : Integer.MAX_VALUE;
    }

    public ObjectNode summary(Graph graph) {
        ObjectNode o = graph.mapper().createObjectNode();
        o.put("rules", rules.size());
        ArrayNode src = o.putArray("filterChains");
        sources.forEach(src::add);
        ArrayNode f = o.putArray("filters");
        filters.forEach(f::add);
        o.put("note", "URL rules only; method-level authorization (e.g. Casbin enforce calls) is runtime policy");
        return o;
    }

    static String lower(String s) {
        return s.toLowerCase(Locale.ROOT);
    }
}
