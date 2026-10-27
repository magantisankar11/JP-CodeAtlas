package com.jci.analyzer.spoon;

import com.jci.analyzer.graph.Ids;
import spoon.reflect.code.CtExpression;
import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtClass;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtInterface;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.CtTypeParameter;
import spoon.reflect.reference.CtTypeReference;

import java.beans.Introspector;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Type hierarchy (in-source only) and Spring bean metadata, built once per run. */
public final class TypeIndex {

    public static final Set<String> STEREOTYPES = Set.of(
            "Component", "Service", "Repository", "Controller", "RestController", "Configuration", "ControllerAdvice", "RestControllerAdvice");

    /** @param factoryMethod id of the @Bean method that produces it, or null for stereotype-annotated classes */
    public record BeanInfo(String name, Set<String> qualifiers, boolean primary, String factoryMethod) {
    }

    /** A @Bean method whose concrete product type could not be determined statically. */
    public record OpaqueFactory(String name, String returnType, String methodId) {
    }

    private final Map<String, CtType<?>> types = new HashMap<>();
    private final Map<String, Set<String>> directSubtypes = new HashMap<>();
    private final Map<String, BeanInfo> beans = new HashMap<>();
    private final Map<String, Set<String>> subtypeCache = new HashMap<>();
    private final List<OpaqueFactory> opaqueFactories = new ArrayList<>();

    public TypeIndex(List<CtType<?>> allTypes, SpoonSupport support) {
        for (CtType<?> t : allTypes) {
            if (t instanceof CtTypeParameter || !support.isInSource(t)) {
                continue;
            }
            String fqn = Ids.normalizeFqn(t.getQualifiedName());
            types.put(fqn, t);
            for (CtTypeReference<?> sup : supertypes(t)) {
                directSubtypes.computeIfAbsent(Ids.normalizeFqn(sup.getQualifiedName()), k -> new LinkedHashSet<>()).add(fqn);
            }
            if (t instanceof CtClass<?> && !t.isAnonymous() && SpoonSupport.annotationNames(t).stream().anyMatch(STEREOTYPES::contains)) {
                beans.put(fqn, beanInfo(t));
            }
        }
        for (CtType<?> t : new ArrayList<>(types.values())) {
            if (beans.containsKey(Ids.normalizeFqn(t.getQualifiedName()))) {
                for (CtMethod<?> m : t.getMethods()) {
                    if (SpoonSupport.hasAnnotation(m, "Bean")) {
                        factory(m);
                    }
                }
            }
        }
    }

    /** @Bean method: product = the single in-source class every return statement instantiates, if any. */
    private void factory(CtMethod<?> m) {
        CtAnnotation<?> bean = SpoonSupport.annotation(m, "Bean");
        String name = literal(SpoonSupport.annotationValue(bean, "name", "value"));
        if (name == null || name.isEmpty()) {
            name = m.getSimpleName();
        }
        String product = null;
        boolean known = m.getBody() != null;
        if (known) {
            for (spoon.reflect.code.CtReturn<?> r : m.getBody().getElements(new spoon.reflect.visitor.filter.TypeFilter<>(spoon.reflect.code.CtReturn.class))) {
                String fqn = r.getReturnedExpression() instanceof spoon.reflect.code.CtConstructorCall<?> cc
                        && !(cc instanceof spoon.reflect.code.CtNewClass<?>) ? Ids.normalizeFqn(cc.getType().getQualifiedName()) : null;
                if (fqn == null || types.get(fqn) == null || (product != null && !product.equals(fqn))) {
                    known = false;
                    break;
                }
                product = fqn;
            }
        }
        String methodId = SpoonSupport.methodId(m);
        if (known && product != null) {
            Set<String> q = new LinkedHashSet<>();
            String qv = literal(SpoonSupport.annotationValue(SpoonSupport.annotation(m, "Qualifier"), "value"));
            if (qv != null) {
                q.add(qv);
            }
            beans.putIfAbsent(product, new BeanInfo(name, q, SpoonSupport.hasAnnotation(m, "Primary"), methodId));
        } else if (m.getType() != null) {
            opaqueFactories.add(new OpaqueFactory(name, Ids.normalizeFqn(SpoonSupport.erasure(m.getType())), methodId));
        }
    }

    /** @Bean methods with unknown concrete product whose declared type can satisfy an injection point of {@code typeFqn}. */
    public List<OpaqueFactory> opaqueFactoriesFor(String typeFqn) {
        String t = Ids.normalizeFqn(typeFqn);
        Set<String> subs = subtypesOf(t);
        return opaqueFactories.stream().filter(f -> f.returnType().equals(t) || subs.contains(f.returnType())).toList();
    }

    public static List<CtTypeReference<?>> supertypes(CtType<?> t) {
        List<CtTypeReference<?>> out = new ArrayList<>();
        if (t.getSuperclass() != null) {
            out.add(t.getSuperclass());
        }
        out.addAll(t.getSuperInterfaces());
        return out;
    }

    private static BeanInfo beanInfo(CtType<?> t) {
        String name = null;
        for (CtAnnotation<?> a : t.getAnnotations()) {
            if (STEREOTYPES.contains(SpoonSupport.annotationName(a))) {
                name = literal(SpoonSupport.annotationValue(a, "value"));
                if (name != null && !name.isEmpty()) {
                    break;
                }
            }
        }
        if (name == null || name.isEmpty()) {
            name = Introspector.decapitalize(t.getSimpleName());
        }
        Set<String> qualifiers = new LinkedHashSet<>();
        String q = literal(SpoonSupport.annotationValue(SpoonSupport.annotation(t, "Qualifier"), "value"));
        if (q != null) {
            qualifiers.add(q);
        }
        return new BeanInfo(name, qualifiers, SpoonSupport.hasAnnotation(t, "Primary"), null);
    }

    static String literal(CtExpression<?> e) {
        if (e == null) {
            return null;
        }
        ConstantFolder.Result r = new ConstantFolder().fold(e);
        return r.complete() ? r.value() : null;
    }

    public CtType<?> type(String fqn) {
        return types.get(Ids.normalizeFqn(fqn));
    }

    public boolean isBean(CtType<?> t) {
        return t != null && beans.containsKey(Ids.normalizeFqn(t.getQualifiedName()));
    }

    public BeanInfo bean(CtType<?> t) {
        return t == null ? null : beans.get(Ids.normalizeFqn(t.getQualifiedName()));
    }

    /** All transitive in-source subtypes (classes, interfaces, anonymous classes). */
    public Set<String> subtypesOf(String fqn) {
        return subtypeCache.computeIfAbsent(Ids.normalizeFqn(fqn), key -> {
            Set<String> seen = new LinkedHashSet<>();
            Deque<String> work = new ArrayDeque<>(directSubtypes.getOrDefault(key, Set.of()));
            while (!work.isEmpty()) {
                String s = work.pop();
                if (seen.add(s)) {
                    work.addAll(directSubtypes.getOrDefault(s, Set.of()));
                }
            }
            return seen;
        });
    }

    public static boolean isConcrete(CtType<?> t) {
        return t instanceof CtClass<?> && !(t instanceof CtInterface<?>) && !t.isAbstract();
    }

    /**
     * The method that runs for a receiver of concrete type {@code c} when {@code m} is called: the closest
     * declaration along c's superclass chain with the same name and parameter erasures as m.
     */
    public CtMethod<?> implementationIn(CtType<?> c, CtMethod<?> m) {
        String sig = paramSignature(m);
        boolean generic = m.getParameters().stream().anyMatch(p -> p.getType() instanceof spoon.reflect.reference.CtTypeParameterReference);
        CtType<?> cur = c;
        int guard = 0;
        while (cur != null && guard++ < 50) {
            CtMethod<?> exact = null;
            CtMethod<?> arity = null;
            int arityMatches = 0;
            for (CtMethod<?> cm : cur.getMethods()) {
                if (!cm.getSimpleName().equals(m.getSimpleName()) || cm.isStatic()) {
                    continue;
                }
                if (paramSignature(cm).equals(sig)) {
                    exact = cm;
                } else if (generic && cm.getParameters().size() == m.getParameters().size()) {
                    arity = cm;
                    arityMatches++;
                }
            }
            if (exact != null) {
                return exact;
            }
            if (arity != null && arityMatches == 1) {
                return arity;
            }
            if (cur == m.getDeclaringType()) {
                return m;
            }
            CtTypeReference<?> sup = cur.getSuperclass();
            cur = sup == null ? null : types.get(Ids.normalizeFqn(sup.getQualifiedName()));
        }
        // Interface default method not overridden along the class chain runs as declared.
        return m.getBody() != null && m.getDeclaringType() instanceof CtInterface<?> ? m : null;
    }

    private static String paramSignature(CtExecutable<?> e) {
        return String.join(",", e.getParameters().stream().map(p -> SpoonSupport.erasure(p.getType())).toList());
    }

    public int typeCount() {
        return types.size();
    }

    public int beanCount() {
        return beans.size();
    }
}
