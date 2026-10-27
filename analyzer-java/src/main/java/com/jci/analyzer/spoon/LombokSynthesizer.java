package com.jci.analyzer.spoon;

import spoon.reflect.code.CtExpression;
import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtClass;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.ModifierKind;
import spoon.reflect.factory.Factory;
import spoon.reflect.reference.CtTypeReference;

import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

/**
 * Adds the accessor methods Lombok would generate to the in-memory model (never to files), so calls such as
 * {@code form.getCustomerId()} bind to a declaration. Line numbers of real code are untouched; synthesized members
 * carry {@link SpoonSupport#LOMBOK_META} and point their evidence at the originating field.
 */
public final class LombokSynthesizer {

    private final Factory factory;
    private final SpoonSupport support;
    private int synthesized;
    private final Map<String, Integer> unsupported = new TreeMap<>();

    public LombokSynthesizer(Factory factory, SpoonSupport support) {
        this.factory = factory;
        this.support = support;
    }

    public void apply(List<CtType<?>> types) {
        for (CtType<?> t : types) {
            if (!(t instanceof CtClass<?> cls) || !support.isInSource(t)) {
                continue;
            }
            boolean data = SpoonSupport.hasAnnotation(cls, "Data");
            boolean value = SpoonSupport.hasAnnotation(cls, "Value");
            boolean classGetter = data || value || enabled(SpoonSupport.annotation(cls, "Getter"));
            boolean classSetter = data || enabled(SpoonSupport.annotation(cls, "Setter"));
            for (String a : List.of("Builder", "SuperBuilder", "With", "Accessors", "Delegate")) {
                if (SpoonSupport.hasAnnotation(cls, a)) {
                    unsupported.merge("@" + a, 1, Integer::sum);
                }
            }
            for (CtField<?> f : cls.getFields()) {
                if (f.isStatic()) {
                    continue;
                }
                CtAnnotation<?> fg = SpoonSupport.annotation(f, "Getter");
                CtAnnotation<?> fs = SpoonSupport.annotation(f, "Setter");
                boolean getter = fg != null ? enabled(fg) : classGetter;
                boolean setter = fs != null ? enabled(fs) : classSetter && !f.isFinal() && !value;
                if (getter) {
                    addGetter(cls, f);
                }
                if (setter) {
                    addSetter(cls, f);
                }
            }
        }
    }

    /** @Getter(AccessLevel.NONE) disables generation. */
    private static boolean enabled(CtAnnotation<?> a) {
        if (a == null) {
            return false;
        }
        CtExpression<?> v = SpoonSupport.annotationValue(a, "value");
        return v == null || !v.toString().endsWith("NONE");
    }

    private void addGetter(CtClass<?> cls, CtField<?> f) {
        String name = getterName(f);
        if (!cls.getMethodsByName(name).stream().filter(m -> m.getParameters().isEmpty()).toList().isEmpty()) {
            return;
        }
        CtMethod<Object> m = factory.Core().createMethod();
        m.setSimpleName(name);
        @SuppressWarnings("unchecked")
        CtTypeReference<Object> type = (CtTypeReference<Object>) f.getType().clone();
        m.setType(type);
        m.addModifier(ModifierKind.PUBLIC);
        mark(m, f, "Getter");
        cls.addMethod(m);
        synthesized++;
    }

    private void addSetter(CtClass<?> cls, CtField<?> f) {
        String name = "set" + capitalize(baseName(f));
        if (!cls.getMethodsByName(name).stream().filter(m -> m.getParameters().size() == 1).toList().isEmpty()) {
            return;
        }
        CtMethod<Object> m = factory.Core().createMethod();
        m.setSimpleName(name);
        @SuppressWarnings("unchecked")
        CtTypeReference<Object> voidType = (CtTypeReference<Object>) (CtTypeReference<?>) factory.Type().voidPrimitiveType();
        m.setType(voidType);
        m.addModifier(ModifierKind.PUBLIC);
        CtParameter<Object> p = factory.Core().createParameter();
        p.setSimpleName(f.getSimpleName());
        @SuppressWarnings("unchecked")
        CtTypeReference<Object> ptype = (CtTypeReference<Object>) f.getType().clone();
        p.setType(ptype);
        m.addParameter(p);
        mark(m, f, "Setter");
        cls.addMethod(m);
        synthesized++;
    }

    private static void mark(CtMethod<?> m, CtField<?> origin, String feature) {
        m.putMetadata(SpoonSupport.LOMBOK_META, feature);
        m.putMetadata(SpoonSupport.ORIGIN_META, origin);
    }

    private static boolean isPrimitiveBoolean(CtField<?> f) {
        return f.getType() != null && "boolean".equals(f.getType().getQualifiedName());
    }

    /** Lombok: boolean isActive -> isActive()/setActive(); boolean active -> isActive(); others getX(). */
    static String getterName(CtField<?> f) {
        if (isPrimitiveBoolean(f)) {
            return "is" + capitalize(baseName(f));
        }
        return "get" + capitalize(f.getSimpleName());
    }

    private static String baseName(CtField<?> f) {
        String n = f.getSimpleName();
        if (isPrimitiveBoolean(f) && n.length() > 2 && n.startsWith("is") && Character.isUpperCase(n.charAt(2))) {
            return n.substring(2);
        }
        return n;
    }

    static String capitalize(String s) {
        return s.isEmpty() ? s : s.substring(0, 1).toUpperCase(Locale.ROOT) + s.substring(1);
    }

    public int synthesizedCount() {
        return synthesized;
    }

    public Map<String, Integer> unsupported() {
        return unsupported;
    }
}
