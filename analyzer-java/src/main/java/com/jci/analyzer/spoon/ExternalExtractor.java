package com.jci.analyzer.spoon;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jci.analyzer.graph.Graph;
import com.jci.analyzer.graph.Graph.NodeRec;
import com.jci.analyzer.graph.Ids;
import com.jci.analyzer.graph.Resolution;
import com.jci.analyzer.source.PropertyIndex;
import com.jci.analyzer.util.Redactor;
import spoon.reflect.code.CtConstructorCall;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtFieldRead;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtTypeReference;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Calls leaving the application: HTTP (RestTemplate / RestClient / WebClient / Apache HttpClient / Feign) and
 * SDK clients of external services. Target resolution: CONFIRMED = constant URL; FRAMEWORK_DERIVED = URL from a
 * configuration property (key recorded, value never read) or a Feign mapping; UNRESOLVED = URL built at runtime.
 */
public final class ExternalExtractor implements CallGraphExtractor.SiteListener {

    private static final Set<String> REST_TYPES = Set.of(
            "org.springframework.web.client.RestTemplate", "org.springframework.web.client.RestOperations",
            "org.springframework.web.client.RestClient", "org.springframework.web.reactive.function.client.WebClient");
    private static final Map<String, String> REST_METHODS = Map.ofEntries(
            Map.entry("getForObject", "GET"), Map.entry("getForEntity", "GET"), Map.entry("postForObject", "POST"),
            Map.entry("postForEntity", "POST"), Map.entry("postForLocation", "POST"), Map.entry("put", "PUT"),
            Map.entry("delete", "DELETE"), Map.entry("patchForObject", "PATCH"), Map.entry("headForHeaders", "HEAD"),
            Map.entry("optionsForAllow", "OPTIONS"), Map.entry("exchange", "?"), Map.entry("execute", "?"));
    private static final Set<String> APACHE_PACKAGES = Set.of("org.apache.hc.client5.http.classic.methods", "org.apache.http.client.methods");
    private static final Map<String, String> APACHE_TYPES = Map.of(
            "HttpGet", "GET", "HttpPost", "POST", "HttpPut", "PUT", "HttpDelete", "DELETE", "HttpPatch", "PATCH", "HttpHead", "HEAD");
    private static final Map<String, String> SDK_PACKAGES = new LinkedHashMap<>();

    static {
        SDK_PACKAGES.put("com.amazonaws.services.s3", "AWS S3");
        SDK_PACKAGES.put("software.amazon.awssdk.services.s3", "AWS S3");
        SDK_PACKAGES.put("com.azure.storage.blob", "Azure Blob Storage");
        SDK_PACKAGES.put("com.google.cloud.storage", "Google Cloud Storage");
        SDK_PACKAGES.put("com.google.cloud.bigquery", "Google BigQuery");
        SDK_PACKAGES.put("com.sap.conn.jco", "SAP JCo");
        SDK_PACKAGES.put("org.springframework.mail", "SMTP (Spring Mail)");
        SDK_PACKAGES.put("jakarta.mail", "SMTP (Jakarta Mail)");
        SDK_PACKAGES.put("javax.mail", "SMTP (JavaMail)");
        SDK_PACKAGES.put("com.jcraft.jsch", "SSH/SFTP (JSch)");
        SDK_PACKAGES.put("org.springframework.data.redis", "Redis");
        SDK_PACKAGES.put("com.hazelcast", "Hazelcast");
    }

    private final Graph graph;
    private final SpoonSupport support;
    private final NodeFactory nodes;
    private final ConstantFolder folder = new ConstantFolder();
    private final Map<String, Integer> stats = new TreeMap<>();

    public ExternalExtractor(Graph graph, SpoonSupport support, NodeFactory nodes) {
        this.graph = graph;
        this.support = support;
        this.nodes = nodes;
    }

    public void invocation(CtInvocation<?> inv, SpoonSupport.Owner owner) {
        String receiver = receiverType(inv);
        if (receiver == null) {
            return;
        }
        String name = inv.getExecutable().getSimpleName();
        if (REST_TYPES.contains(receiver) && REST_METHODS.containsKey(name) && !inv.getArguments().isEmpty()) {
            String method = REST_METHODS.get(name);
            if ("?".equals(method) && inv.getArguments().size() > 1) {
                String m = SecurityExtractor.httpMethod(inv.getArguments().get(1));
                method = m != null ? m : method;
            }
            http(inv, owner, simple(receiver) + "." + name, method, inv.getArguments().get(0));
            return;
        }
        for (Map.Entry<String, String> sdk : SDK_PACKAGES.entrySet()) {
            if (receiver.startsWith(sdk.getKey() + ".")) {
                String id = "external:sdk:" + sdk.getValue() + "#" + name;
                if (!graph.hasNode(id)) {
                    NodeRec n = new NodeRec(id, "EXTERNAL_API", sdk.getValue() + " · " + name);
                    n.fqn = sdk.getValue() + "#" + name;
                    n.inScope = true;
                    n.attrs.put("protocol", "SDK");
                    n.attrs.put("service", sdk.getValue());
                    n.attrs.put("operation", name);
                    n.attrs.put("clientType", receiver);
                    graph.putNode(n);
                }
                ObjectNode a = Graph.attrs();
                a.put("protocol", "SDK");
                a.put("clientType", receiver);
                edge(owner, id, Resolution.CONFIRMED, "SDK_RECEIVER_TYPE", inv, a);
                count("sdkCalls");
                return;
            }
        }
    }

    public void constructorCall(CtConstructorCall<?> cc, SpoonSupport.Owner owner) {
        CtTypeReference<?> t = cc.getType();
        if (t == null || t.getPackage() == null || !APACHE_PACKAGES.contains(t.getPackage().getQualifiedName())
                || !APACHE_TYPES.containsKey(t.getSimpleName()) || cc.getArguments().isEmpty()) {
            return;
        }
        http(cc, owner, "ApacheHttpClient." + t.getSimpleName(), APACHE_TYPES.get(t.getSimpleName()), cc.getArguments().get(0));
    }

    private void http(CtElement site, SpoonSupport.Owner owner, String api, String method, CtExpression<?> urlArg) {
        CtExpression<?> url = unwrapUri(urlArg);
        ConstantFolder.Result folded = folder.fold(url);
        String property = propertyKey(url);
        String suffix = "";
        if (property == null && url instanceof spoon.reflect.code.CtBinaryOperator<?> bin) {
            // ${base} + "/constant/path": the property gives the host, the rest must fold completely.
            List<CtExpression<?>> parts = new java.util.ArrayList<>();
            flattenConcat(bin, parts);
            String key = propertyKey(parts.get(0));
            if (key != null) {
                StringBuilder rest = new StringBuilder();
                boolean ok = true;
                for (CtExpression<?> p : parts.subList(1, parts.size())) {
                    ConstantFolder.Result r = folder.fold(p);
                    if (!r.complete()) {
                        ok = false;
                        break;
                    }
                    rest.append(r.value());
                }
                if (ok) {
                    property = key;
                    suffix = stripQuery(rest.toString());
                }
            }
        }
        String id;
        String label;
        Resolution res;
        String rule;
        ObjectNode na = Graph.attrs();
        if (folded.complete()) {
            String clean = Redactor.redact(stripQuery(folded.value()));
            id = "external:http:" + method + " " + clean;
            label = method + " " + clean;
            res = Resolution.CONFIRMED;
            rule = "CONSTANT_URL";
            na.put("url", clean);
            count("httpConstant");
        } else if (property != null) {
            id = "external:http:" + method + " ${" + property + "}" + suffix;
            label = method + " ${" + property + "}" + suffix;
            res = Resolution.FRAMEWORK_DERIVED;
            rule = "URL_FROM_PROPERTY";
            na.put("urlProperty", property);
            if (!suffix.isEmpty()) {
                na.put("path", suffix);
            }
            count("httpProperty");
        } else {
            int line = SpoonSupport.line(site);
            id = "external:http:?:" + owner.id() + "@L" + line + "C" + SpoonSupport.column(site);
            label = method + " (URL built at runtime)";
            res = Resolution.UNRESOLVED;
            rule = "URL_DYNAMIC";
            ArrayNode frags = na.putArray("fragments");
            folded.fragments().forEach(f -> frags.add(Redactor.redact(f)));
            na.put("reason", folded.reason());
            count("httpUnresolved");
        }
        if (!graph.hasNode(id)) {
            NodeRec n = new NodeRec(id, "EXTERNAL_API", label);
            n.fqn = label;
            n.inScope = true;
            if (res == Resolution.UNRESOLVED) {
                n.filePath = support.relPath(site);
                n.lineStart = SpoonSupport.line(site);
                n.lineEnd = SpoonSupport.endLine(site);
            }
            n.attrs.setAll(na);
            n.attrs.put("protocol", "HTTP");
            n.attrs.put("httpMethod", method);
            graph.putNode(n);
        }
        ObjectNode a = Graph.attrs();
        a.put("protocol", "HTTP");
        a.put("api", api);
        a.put("httpMethod", method);
        edge(owner, id, res, rule, site, a);
    }

    /** Feign interface methods -> EXTERNAL_API (client name + mapping); callers already CALL the interface method. */
    public void feignClient(CtType<?> t) {
        CtAnnotation<?> fc = SpoonSupport.annotation(t, "FeignClient");
        if (fc == null) {
            return;
        }
        String client = TypeIndex.literal(SpoonSupport.annotationValue(fc, "name", "value", "contextId"));
        String urlExpr = TypeIndex.literal(SpoonSupport.annotationValue(fc, "url"));
        String basePath = TypeIndex.literal(SpoonSupport.annotationValue(fc, "path"));
        String urlKey = PropertyIndex.placeholderKey(urlExpr);
        NodeRec tn = nodes.type(t);
        tn.attrs.put("feignClient", client == null ? "?" : client);
        if (urlKey != null) {
            tn.attrs.put("feignUrlProperty", urlKey);
        } else if (urlExpr != null && !urlExpr.isBlank()) {
            tn.attrs.put("feignUrl", Redactor.redact(urlExpr));
        } else {
            tn.attrs.put("feignUrl", "resolved at runtime (service discovery or custom configuration)");
        }
        for (CtMethod<?> m : t.getMethods()) {
            String httpMethod = null;
            CtAnnotation<?> mapping = null;
            for (CtAnnotation<?> a : m.getAnnotations()) {
                String n = SpoonSupport.annotationName(a);
                if (n.endsWith("Mapping")) {
                    mapping = a;
                    httpMethod = switch (n) {
                        case "GetMapping" -> "GET";
                        case "PostMapping" -> "POST";
                        case "PutMapping" -> "PUT";
                        case "DeleteMapping" -> "DELETE";
                        case "PatchMapping" -> "PATCH";
                        default -> "ANY";
                    };
                }
            }
            if (mapping == null) {
                continue;
            }
            String path = TypeIndex.literal(SpoonSupport.annotationValue(mapping, "value", "path"));
            String full = EndpointExtractor.joinPaths(basePath == null ? "" : basePath, path == null ? "" : path);
            String id = "external:feign:" + client + " " + httpMethod + " " + full;
            if (!graph.hasNode(id)) {
                NodeRec n = new NodeRec(id, "EXTERNAL_API", client + ": " + httpMethod + " " + full);
                n.fqn = id.substring("external:feign:".length());
                n.inScope = true;
                n.attrs.put("protocol", "HTTP");
                n.attrs.put("client", "Feign");
                n.attrs.put("feignClient", client);
                n.attrs.put("httpMethod", httpMethod);
                n.attrs.put("path", full);
                if (urlKey != null) {
                    n.attrs.put("urlProperty", urlKey);
                }
                graph.putNode(n);
            }
            ObjectNode a = Graph.attrs();
            a.put("protocol", "HTTP");
            a.put("api", "Feign");
            graph.addEdge("CALLS_EXTERNAL", nodes.method(m).id, id, Resolution.FRAMEWORK_DERIVED,
                    support.evidence(mapping, "FEIGN_MAPPING", Resolution.FRAMEWORK_DERIVED), a);
            count("feignMethods");
        }
    }

    private void edge(SpoonSupport.Owner owner, String dst, Resolution res, String rule, CtElement site, ObjectNode attrs) {
        graph.addEdge("CALLS_EXTERNAL", nodes.ownerNode(owner).id, dst, res, support.evidence(site, rule, res), attrs);
    }

    private static void flattenConcat(CtExpression<?> e, List<CtExpression<?>> out) {
        if (e instanceof spoon.reflect.code.CtBinaryOperator<?> b && b.getKind() == spoon.reflect.code.BinaryOperatorKind.PLUS) {
            flattenConcat(b.getLeftHandOperand(), out);
            flattenConcat(b.getRightHandOperand(), out);
        } else {
            out.add(e);
        }
    }

    /** URI.create(x) / new URI(x) are unwrapped one level to the string argument. */
    private static CtExpression<?> unwrapUri(CtExpression<?> e) {
        if (e instanceof CtInvocation<?> inv && "create".equals(inv.getExecutable().getSimpleName()) && inv.getArguments().size() == 1) {
            return inv.getArguments().get(0);
        }
        if (e instanceof CtConstructorCall<?> cc && cc.getType() != null && "URI".equals(cc.getType().getSimpleName()) && cc.getArguments().size() == 1) {
            return cc.getArguments().get(0);
        }
        return e;
    }

    /** A field initialised by @Value("${key}") → key. */
    static String propertyKey(CtExpression<?> e) {
        if (!(e instanceof CtFieldRead<?> fr)) {
            return null;
        }
        CtField<?> f;
        try {
            f = fr.getVariable().getFieldDeclaration();
        } catch (RuntimeException ex) {
            return null;
        }
        if (f == null) {
            return null;
        }
        return PropertyIndex.placeholderKey(TypeIndex.literal(SpoonSupport.annotationValue(SpoonSupport.annotation(f, "Value"), "value")));
    }

    private static String stripQuery(String url) {
        int q = url.indexOf('?');
        return q >= 0 ? url.substring(0, q) : url;
    }

    static String receiverType(CtInvocation<?> inv) {
        try {
            CtTypeReference<?> dt = inv.getExecutable().getDeclaringType();
            if (dt != null && dt.getQualifiedName().contains(".")) {
                return dt.getQualifiedName();
            }
            if (inv.getTarget() != null && inv.getTarget().getType() != null) {
                String q = inv.getTarget().getType().getQualifiedName();
                return q.contains(".") ? q : null;
            }
        } catch (RuntimeException ignored) {
            // unknown receiver
        }
        return null;
    }

    private static String simple(String fqn) {
        return fqn.substring(fqn.lastIndexOf('.') + 1);
    }

    private void count(String k) {
        stats.merge(k, 1, Integer::sum);
    }

    public Map<String, Integer> stats() {
        return stats;
    }

    static List<String> sdkServices() {
        return List.copyOf(SDK_PACKAGES.values());
    }

    static String id(String s) {
        return Ids.sha1(s);
    }
}
