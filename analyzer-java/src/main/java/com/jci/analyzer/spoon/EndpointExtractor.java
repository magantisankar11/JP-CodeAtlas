package com.jci.analyzer.spoon;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jci.analyzer.graph.Graph;
import com.jci.analyzer.graph.Graph.NodeRec;
import com.jci.analyzer.graph.Ids;
import com.jci.analyzer.graph.Resolution;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtFieldRead;
import spoon.reflect.code.CtLiteral;
import spoon.reflect.code.CtNewArray;
import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtType;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Spring MVC handler methods -> API_ENDPOINT nodes and EXPOSES edges. */
public final class EndpointExtractor {

    private static final Map<String, String> SHORTCUTS = Map.of(
            "GetMapping", "GET", "PostMapping", "POST", "PutMapping", "PUT", "DeleteMapping", "DELETE", "PatchMapping", "PATCH");
    private static final Map<String, String> PARAM_SOURCES = new LinkedHashMap<>();
    private static final Set<String> FRAMEWORK_TYPES = Set.of(
            "HttpServletRequest", "HttpServletResponse", "MultipartHttpServletRequest", "ServletRequest", "ServletResponse",
            "HttpSession", "Principal", "Authentication", "Model", "ModelMap", "BindingResult", "Errors", "Locale",
            "WebRequest", "NativeWebRequest", "RedirectAttributes", "UriComponentsBuilder", "HttpHeaders", "SessionStatus");
    private static final Set<String> SIMPLE_TYPES = Set.of(
            "java.lang.String", "java.lang.Long", "java.lang.Integer", "java.lang.Boolean", "java.lang.Double", "java.lang.Float",
            "java.lang.Short", "java.lang.Byte", "java.lang.Character", "long", "int", "boolean", "double", "float", "short", "byte", "char",
            "java.math.BigDecimal", "java.math.BigInteger", "java.util.Date", "java.time.LocalDate", "java.time.LocalDateTime", "java.util.UUID");

    static {
        PARAM_SOURCES.put("PathVariable", "PATH");
        PARAM_SOURCES.put("RequestParam", "QUERY");
        PARAM_SOURCES.put("RequestHeader", "HEADER");
        PARAM_SOURCES.put("RequestBody", "BODY");
        PARAM_SOURCES.put("CookieValue", "COOKIE");
        PARAM_SOURCES.put("RequestPart", "PART");
        PARAM_SOURCES.put("ModelAttribute", "MODEL");
        PARAM_SOURCES.put("RequestAttribute", "ATTRIBUTE");
        PARAM_SOURCES.put("MatrixVariable", "MATRIX");
    }

    private final Graph graph;
    private final SpoonSupport support;
    private final NodeFactory nodes;
    private final ConstantFolder folder = new ConstantFolder();
    private int endpoints;

    private final ContractExtractor contract;
    private final String contextPath;

    public EndpointExtractor(Graph graph, SpoonSupport support, NodeFactory nodes) {
        this(graph, support, nodes, null, "");
    }

    /** @param contextPath servlet context path prepended for display as {@code fullPath}; ids stay servlet-relative */
    public EndpointExtractor(Graph graph, SpoonSupport support, NodeFactory nodes, ContractExtractor contract, String contextPath) {
        this.graph = graph;
        this.support = support;
        this.nodes = nodes;
        this.contract = contract;
        this.contextPath = contextPath == null ? "" : contextPath;
    }

    public static boolean isController(CtType<?> t) {
        return SpoonSupport.hasAnnotation(t, "RestController", "Controller");
    }

    public void extract(CtType<?> controller) {
        if (!isController(controller) || controller.isAbstract()) {
            return;
        }
        boolean rest = SpoonSupport.hasAnnotation(controller, "RestController");
        CtAnnotation<?> classMapping = SpoonSupport.annotation(controller, "RequestMapping");
        List<String> classPaths = paths(classMapping, controller);
        for (CtMethod<?> m : controller.getAllMethods()) {
            if (!support.isInSource(m) || m.isStatic()) {
                continue;
            }
            CtAnnotation<?> mapping = null;
            String fixedMethod = null;
            for (CtAnnotation<?> a : m.getAnnotations()) {
                String n = SpoonSupport.annotationName(a);
                if (SHORTCUTS.containsKey(n)) {
                    mapping = a;
                    fixedMethod = SHORTCUTS.get(n);
                    break;
                }
                if ("RequestMapping".equals(n)) {
                    mapping = a;
                }
            }
            if (mapping == null) {
                continue;
            }
            List<String> httpMethods = fixedMethod != null ? List.of(fixedMethod) : requestMethods(mapping);
            List<String> methodPaths = paths(mapping, m);
            NodeRec handler = nodes.method(m);
            for (String cp : classPaths) {
                for (String mp : methodPaths) {
                    String path = joinPaths(cp, mp);
                    for (String hm : httpMethods) {
                        endpoint(controller, m, handler, hm, path, rest, mapping);
                    }
                }
            }
        }
    }

    private void endpoint(CtType<?> controller, CtMethod<?> m, NodeRec handler, String httpMethod, String path, boolean rest, CtAnnotation<?> mapping) {
        String id = Ids.endpoint(httpMethod, path);
        handler.attrs.put("entryPoint", "HTTP");
        if (graph.hasNode(id)) {
            String other = graph.node(id).attrs.path("handler").asText();
            if (!other.equals(handler.id)) {
                graph.diagnostic("WARN", "DUPLICATE_ENDPOINT", id + " is mapped by " + other + " and " + handler.id, support.relPath(m), SpoonSupport.line(m));
            }
        } else {
            NodeRec n = new NodeRec(id, "API_ENDPOINT", httpMethod + " " + path);
            n.fqn = id.substring("endpoint:".length());
            n.module = support.config().module();
            n.pkg = SpoonSupport.packageOf(controller);
            n.filePath = support.relPath(m);
            n.lineStart = SpoonSupport.line(m);
            n.lineEnd = SpoonSupport.endLine(m);
            n.inScope = support.inScope(controller);
            ObjectNode a = n.attrs;
            a.put("httpMethod", httpMethod);
            a.put("path", path);
            a.put("fullPath", contextPath.isEmpty() ? path : joinPaths(contextPath, path));
            a.put("pathResolved", !path.contains(ConstantFolder.DYNAMIC));
            a.put("handler", handler.id);
            a.put("controller", Ids.normalizeFqn(controller.getQualifiedName()));
            a.put("restController", rest);
            a.put("responseType", SpoonSupport.typeString(m.getType()));
            contract(m, a);
            for (String key : new String[] {"consumes", "produces"}) {
                List<String> v = strings(SpoonSupport.annotationValue(mapping, key));
                if (!v.isEmpty()) {
                    ArrayNode arr = a.putArray(key);
                    v.forEach(arr::add);
                }
            }
            ArrayNode thrown = a.putArray("declaredExceptions");
            m.getThrownTypes().forEach(t -> thrown.add(Ids.normalizeFqn(t.getQualifiedName())));
            graph.putNode(n);
            endpoints++;
            if (contract != null) {
                contract.endpoint(id, m, (ArrayNode) a.get("params"));
            }
        }
        graph.addEdge("EXPOSES", id, handler.id, Resolution.FRAMEWORK_DERIVED, support.evidence(mapping, "SPRING_MVC_MAPPING", Resolution.FRAMEWORK_DERIVED), null);
    }

    private void contract(CtMethod<?> m, ObjectNode a) {
        ArrayNode params = a.putArray("params");
        for (CtParameter<?> p : m.getParameters()) {
            ObjectNode po = params.addObject();
            String type = SpoonSupport.typeString(p.getType());
            po.put("javaName", p.getSimpleName());
            po.put("type", type);
            String source = null;
            CtAnnotation<?> ann = null;
            for (Map.Entry<String, String> e : PARAM_SOURCES.entrySet()) {
                ann = SpoonSupport.annotation(p, e.getKey());
                if (ann != null) {
                    source = e.getValue();
                    break;
                }
            }
            boolean implicit = false;
            if (source == null) {
                String simple = p.getType() == null ? "" : p.getType().getSimpleName();
                if (FRAMEWORK_TYPES.contains(simple)) {
                    source = "FRAMEWORK";
                } else if ("MultipartFile".equals(simple)) {
                    source = "PART";
                    implicit = true;
                } else {
                    source = SIMPLE_TYPES.contains(SpoonSupport.erasure(p.getType())) ? "QUERY" : "MODEL";
                    implicit = true;
                }
            }
            po.put("source", source);
            if (implicit) {
                po.put("implicit", true);
            }
            String name = ann == null ? null : TypeIndex.literal(SpoonSupport.annotationValue(ann, "value", "name"));
            po.put("name", name == null || name.isEmpty() ? p.getSimpleName() : name);
            if (ann != null) {
                CtExpression<?> req = SpoonSupport.annotationValue(ann, "required");
                CtExpression<?> def = SpoonSupport.annotationValue(ann, "defaultValue");
                boolean required = !(req instanceof CtLiteral<?> l && Boolean.FALSE.equals(l.getValue())) && def == null;
                po.put("required", required);
                if (def != null) {
                    String d = TypeIndex.literal(def);
                    po.put("defaultValue", d == null ? def.toString() : d);
                }
            }
            if (SpoonSupport.hasAnnotation(p, "Valid", "Validated")) {
                po.put("validated", true);
            }
            List<String> constraints = SpoonSupport.annotationNames(p).stream()
                    .filter(n -> !PARAM_SOURCES.containsKey(n) && !"Valid".equals(n) && !"Validated".equals(n)).toList();
            if (!constraints.isEmpty()) {
                ArrayNode c = po.putArray("annotations");
                constraints.forEach(c::add);
            }
            if ("BODY".equals(source)) {
                ObjectNode body = a.putObject("requestBody");
                body.put("type", type);
                body.put("validated", SpoonSupport.hasAnnotation(p, "Valid", "Validated"));
            }
        }
    }

    private List<String> paths(CtAnnotation<?> mapping, spoon.reflect.declaration.CtElement at) {
        if (mapping == null) {
            return List.of("");
        }
        CtExpression<?> v = SpoonSupport.annotationValue(mapping, "value", "path");
        if (v == null) {
            return List.of("");
        }
        List<String> out = new ArrayList<>();
        for (CtExpression<?> e : elements(v)) {
            ConstantFolder.Result r = folder.fold(e);
            if (r.complete()) {
                out.add(r.value());
            } else {
                graph.diagnostic("WARN", "ENDPOINT_PATH_UNRESOLVED", "Mapping path is not a compile-time constant (" + r.reason() + "): " + e,
                        support.relPath(at), SpoonSupport.line(mapping));
                out.add(String.join("", r.fragments()));
            }
        }
        return out.isEmpty() ? List.of("") : out;
    }

    private List<String> requestMethods(CtAnnotation<?> mapping) {
        CtExpression<?> v = SpoonSupport.annotationValue(mapping, "method");
        if (v == null) {
            return List.of("ANY");
        }
        List<String> out = new ArrayList<>();
        for (CtExpression<?> e : elements(v)) {
            if (e instanceof CtFieldRead<?> fr) {
                out.add(fr.getVariable().getSimpleName());
            } else {
                String s = e.toString();
                out.add(s.substring(s.lastIndexOf('.') + 1));
            }
        }
        return out;
    }

    private List<String> strings(CtExpression<?> v) {
        if (v == null) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (CtExpression<?> e : elements(v)) {
            String s = TypeIndex.literal(e);
            out.add(s != null ? s : e.toString());
        }
        return out;
    }

    private static List<CtExpression<?>> elements(CtExpression<?> v) {
        if (v instanceof CtNewArray<?> arr) {
            return new ArrayList<>(arr.getElements());
        }
        return List.of(v);
    }

    /** Spring-style join: exactly one slash between segments, leading slash, no trailing slash. */
    public static String joinPaths(String classPath, String methodPath) {
        StringBuilder sb = new StringBuilder();
        for (String part : new String[] {classPath, methodPath}) {
            String p = part == null ? "" : part.strip();
            while (p.startsWith("/")) {
                p = p.substring(1);
            }
            while (p.endsWith("/")) {
                p = p.substring(0, p.length() - 1);
            }
            if (!p.isEmpty()) {
                sb.append('/').append(p);
            }
        }
        String out = sb.toString().replaceAll("/{2,}", "/");
        return out.isEmpty() ? "/" : out;
    }

    public int endpointCount() {
        return endpoints;
    }
}
