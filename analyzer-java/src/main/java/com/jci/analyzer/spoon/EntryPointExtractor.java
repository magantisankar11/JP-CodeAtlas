package com.jci.analyzer.spoon;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jci.analyzer.graph.Graph;
import com.jci.analyzer.graph.Graph.NodeRec;
import com.jci.analyzer.graph.Ids;
import com.jci.analyzer.graph.Resolution;
import spoon.reflect.code.CtExecutableReferenceExpression;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtFieldRead;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtLambda;
import spoon.reflect.code.CtNewArray;
import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtTypeReference;
import spoon.reflect.visitor.filter.TypeFilter;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Non-HTTP ways code starts running: @Scheduled, JobRunr (@Recurring/@Job and lambdas passed to the scheduler),
 * Spring events (@EventListener, publishEvent), messaging listeners, startup hooks. Emits attrs.entryPoint on the
 * method node, SCHEDULES (scheduler call -> scheduled method), PUBLISHES (method -> EVENT) and TRIGGERS (EVENT -> listener).
 */
public final class EntryPointExtractor implements CallGraphExtractor.SiteListener {

    private static final Map<String, String> ANNOTATIONS = Map.of(
            "Scheduled", "SCHEDULED", "Recurring", "RECURRING_JOB", "Job", "JOB", "EventListener", "EVENT_LISTENER",
            "TransactionalEventListener", "EVENT_LISTENER", "MessageMapping", "WEBSOCKET", "SubscribeMapping", "WEBSOCKET",
            "KafkaListener", "MESSAGE_LISTENER", "RabbitListener", "MESSAGE_LISTENER", "JmsListener", "MESSAGE_LISTENER");
    private static final Set<String> JOBRUNR_TYPES = Set.of(
            "org.jobrunr.scheduling.JobScheduler", "org.jobrunr.scheduling.BackgroundJob",
            "org.jobrunr.scheduling.JobRequestScheduler", "org.jobrunr.scheduling.BackgroundJobRequest");
    private static final Set<String> EVENT_PUBLISHERS = Set.of(
            "org.springframework.context.ApplicationEventPublisher", "org.springframework.context.ApplicationContext",
            "org.springframework.context.ConfigurableApplicationContext");

    private final Graph graph;
    private final SpoonSupport support;
    private final TypeIndex index;
    private final NodeFactory nodes;
    private final Map<String, Integer> stats = new TreeMap<>();

    public EntryPointExtractor(Graph graph, SpoonSupport support, TypeIndex index, NodeFactory nodes) {
        this.graph = graph;
        this.support = support;
        this.index = index;
        this.nodes = nodes;
    }

    public void type(CtType<?> t) {
        boolean runner = TypeIndex.supertypes(t).stream().anyMatch(s -> Set.of("CommandLineRunner", "ApplicationRunner").contains(s.getSimpleName()));
        for (CtMethod<?> m : t.getMethods()) {
            String kind = null;
            CtAnnotation<?> ann = null;
            for (CtAnnotation<?> a : m.getAnnotations()) {
                String k = ANNOTATIONS.get(SpoonSupport.annotationName(a));
                if (k != null) {
                    kind = k;
                    ann = a;
                    break;
                }
            }
            if (kind == null && (SpoonSupport.hasAnnotation(m, "PostConstruct") || (runner && "run".equals(m.getSimpleName())))) {
                kind = "STARTUP";
            }
            if (kind == null) {
                continue;
            }
            NodeRec n = nodes.method(m);
            n.attrs.put("entryPoint", kind);
            if (ann != null) {
                ObjectNode detail = n.attrs.putObject("entryPointDetail");
                for (String key : new String[] {"cron", "fixedRate", "fixedDelay", "id", "name", "value", "zone", "topics", "queues", "destination"}) {
                    CtExpression<?> v = SpoonSupport.annotationValue(ann, key);
                    if (v != null && !(v instanceof CtNewArray<?>)) {
                        String lit = TypeIndex.literal(v);
                        detail.put(key, lit != null ? lit : v.toString());
                    }
                }
            }
            if ("EVENT_LISTENER".equals(kind)) {
                for (CtTypeReference<?> ev : listenedEvents(m, ann)) {
                    String eventId = event(ev);
                    graph.addEdge("TRIGGERS", eventId, n.id, Resolution.FRAMEWORK_DERIVED, support.evidence(m, "SPRING_EVENT_LISTENER", Resolution.FRAMEWORK_DERIVED), null);
                }
            }
            stats.merge(kind, 1, Integer::sum);
        }
    }

    private static List<CtTypeReference<?>> listenedEvents(CtMethod<?> m, CtAnnotation<?> ann) {
        List<CtTypeReference<?>> out = new ArrayList<>(ExceptionExtractor.classLiterals(
                ann == null ? null : SpoonSupport.annotationValue(ann, "value", "classes")));
        if (out.isEmpty() && m.getParameters().size() == 1) {
            out.add(m.getParameters().get(0).getType());
        }
        return out;
    }

    private String event(CtTypeReference<?> ev) {
        String fqn = Ids.normalizeFqn(SpoonSupport.erasure(ev));
        String id = "event:" + fqn;
        if (!graph.hasNode(id)) {
            NodeRec n = new NodeRec(id, "EVENT", ev.getSimpleName());
            n.fqn = fqn;
            n.inScope = true;
            n.attrs.put("eventType", fqn);
            n.attrs.put("inSource", index.type(fqn) != null);
            graph.putNode(n);
        }
        return id;
    }

    public void invocation(CtInvocation<?> inv, SpoonSupport.Owner owner) {
        String receiver = ExternalExtractor.receiverType(inv);
        if (receiver == null) {
            return;
        }
        String name = inv.getExecutable().getSimpleName();
        if (JOBRUNR_TYPES.contains(receiver)) {
            for (CtExpression<?> arg : inv.getArguments()) {
                for (CtExecutable<?> target : scheduledTargets(arg)) {
                    NodeRec tn = nodes.method(target);
                    if (!tn.attrs.has("entryPoint")) {
                        tn.attrs.put("entryPoint", "JOBRUNR_LAMBDA");
                    }
                    ObjectNode a = Graph.attrs();
                    a.put("api", "JobRunr." + name);
                    a.put("recurring", name.toLowerCase().contains("recurr"));
                    graph.addEdge("SCHEDULES", nodes.ownerNode(owner).id, tn.id, Resolution.FRAMEWORK_DERIVED,
                            support.evidence(inv, "JOBRUNR_LAMBDA", Resolution.FRAMEWORK_DERIVED), a);
                    stats.merge("jobrunrSchedules", 1, Integer::sum);
                }
            }
        } else if (EVENT_PUBLISHERS.contains(receiver) && "publishEvent".equals(name) && inv.getArguments().size() == 1) {
            CtTypeReference<?> type;
            try {
                type = inv.getArguments().get(0).getType();
            } catch (RuntimeException e) {
                type = null;
            }
            if (type == null || !type.getQualifiedName().contains(".")) {
                stats.merge("unresolvedEventTypes", 1, Integer::sum);
                return;
            }
            graph.addEdge("PUBLISHES", nodes.ownerNode(owner).id, event(type), Resolution.CONFIRMED,
                    support.evidence(inv, "PUBLISH_EVENT", Resolution.CONFIRMED), null);
            stats.merge("eventPublications", 1, Integer::sum);
        }
    }

    /** In-source methods invoked by a lambda / method reference handed to the scheduler. */
    private List<CtExecutable<?>> scheduledTargets(CtExpression<?> arg) {
        List<CtExecutable<?>> out = new ArrayList<>();
        if (arg instanceof CtLambda<?> l) {
            List<CtInvocation<?>> calls = l.getElements(new TypeFilter<>(CtInvocation.class));
            for (CtInvocation<?> c : calls) {
                if (c.getParent(CtLambda.class) != l) {
                    continue;
                }
                CtExecutable<?> d = SpoonSupport.declarationOf(c.getExecutable());
                if (d == null) {
                    List<CtMethod<?>> lexical = CallGraphExtractor.lexicalCandidates(c, c.getExecutable().getSimpleName(), c.getArguments().size());
                    d = lexical.size() == 1 ? lexical.get(0) : null;
                }
                if (d != null && support.isInSource(d) && !d.isImplicit()) {
                    out.add(d);
                }
            }
        } else if (arg instanceof CtExecutableReferenceExpression<?, ?> mr) {
            CtExecutable<?> d = SpoonSupport.declarationOf(mr.getExecutable());
            if (d != null && support.isInSource(d)) {
                out.add(d);
            }
        }
        return out;
    }

    public Map<String, Integer> stats() {
        return stats;
    }
}
