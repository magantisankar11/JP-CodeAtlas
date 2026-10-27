package com.jci.analyzer.spoon;

import com.jci.analyzer.graph.Evidence;
import com.jci.analyzer.graph.Ids;
import com.jci.analyzer.graph.Resolution;
import com.jci.analyzer.source.AnalyzerConfig;
import com.jci.analyzer.source.SourceSet;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtLambda;
import spoon.reflect.cu.SourcePosition;
import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtAnonymousExecutable;
import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtPackage;
import spoon.reflect.declaration.CtShadowable;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.CtTypeMember;
import spoon.reflect.reference.CtArrayTypeReference;
import spoon.reflect.reference.CtExecutableReference;
import spoon.reflect.reference.CtTypeReference;
import spoon.reflect.reference.CtWildcardReference;

import java.util.List;
import java.util.Map;
import java.util.Set;

/** Spoon helpers shared by all extractors. */
public final class SpoonSupport {

    /** Metadata key set on members synthesized for Lombok annotations; value = Lombok feature. */
    public static final String LOMBOK_META = "jci.lombok";
    /** Metadata key: the source element a synthesized member was derived from (used for evidence). */
    public static final String ORIGIN_META = "jci.origin";

    private final SourceSet sources;
    private final AnalyzerConfig config;

    public SpoonSupport(SourceSet sources, AnalyzerConfig config) {
        this.sources = sources;
        this.config = config;
    }

    public SourceSet sources() {
        return sources;
    }

    public AnalyzerConfig config() {
        return config;
    }

    // ---------------------------------------------------------------- identity

    public static String typeId(CtType<?> t) {
        return Ids.type(t.getQualifiedName());
    }

    public static String methodId(CtExecutable<?> e) {
        CtType<?> owner = declaringType(e);
        String name = e instanceof CtConstructor<?> ? "<init>" : e.getSimpleName();
        List<String> params = e.getParameters().stream().map(p -> erasure(p.getType())).toList();
        return Ids.method(owner == null ? "?" : owner.getQualifiedName(), name, params);
    }

    public static String syntheticMethodId(CtType<?> owner, String name) {
        return Ids.method(owner.getQualifiedName(), name, List.of());
    }

    public static CtType<?> declaringType(CtElement e) {
        if (e instanceof CtTypeMember tm && tm.getDeclaringType() != null) {
            return tm.getDeclaringType();
        }
        return e.getParent(CtType.class);
    }

    public static String erasure(CtTypeReference<?> t) {
        if (t == null) {
            return "?";
        }
        try {
            if (t instanceof CtArrayTypeReference<?> arr) {
                return erasure(arr.getComponentType()) + "[]";
            }
            CtTypeReference<?> er = t.getTypeErasure();
            return Ids.normalizeFqn(er == null ? t.getQualifiedName() : er.getQualifiedName());
        } catch (RuntimeException | StackOverflowError e) {
            return Ids.normalizeFqn(t.getQualifiedName());
        }
    }

    /** Human-readable generic type, e.g. org.springframework.http.ResponseEntity<java.util.List<x.Vo>>. */
    public static String typeString(CtTypeReference<?> t) {
        if (t == null) {
            return "?";
        }
        try {
            if (t instanceof CtWildcardReference w) {
                CtTypeReference<?> b = w.getBoundingType();
                if (b == null || "java.lang.Object".equals(b.getQualifiedName())) {
                    return "?";
                }
                return "? " + (w.isUpper() ? "extends " : "super ") + typeString(b);
            }
            if (t instanceof CtArrayTypeReference<?> arr) {
                return typeString(arr.getComponentType()) + "[]";
            }
            String base = Ids.normalizeFqn(t.getQualifiedName());
            List<CtTypeReference<?>> args = t.getActualTypeArguments();
            if (args == null || args.isEmpty()) {
                return base;
            }
            return base + "<" + String.join(",", args.stream().map(SpoonSupport::typeString).toList()) + ">";
        } catch (RuntimeException | StackOverflowError e) {
            return String.valueOf(t);
        }
    }

    // ---------------------------------------------------------------- source / scope

    public boolean isInSource(CtElement e) {
        if (e == null) {
            return false;
        }
        if (e.getMetadata(LOMBOK_META) != null) {
            return true;
        }
        if (e instanceof CtShadowable s && s.isShadow()) {
            return false;
        }
        SourcePosition p = e.getPosition();
        return p != null && p.isValidPosition() && p.getFile() != null && sources.relativize(p.getFile()) != null;
    }

    public static CtType<?> topLevel(CtType<?> t) {
        CtType<?> cur = t;
        while (cur.getDeclaringType() != null) {
            cur = cur.getDeclaringType();
        }
        if (cur.isParentInitialized() && !(cur.getParent() instanceof CtPackage)) {
            CtType<?> outer = cur.getParent(CtType.class);
            if (outer != null) {
                return topLevel(outer);
            }
        }
        return cur;
    }

    public static String packageOf(CtType<?> t) {
        CtPackage p = topLevel(t).getPackage();
        return p == null ? "" : p.getQualifiedName();
    }

    public boolean inScope(CtType<?> t) {
        return t != null && isInSource(t) && config.inScope(packageOf(t));
    }

    public String relPath(CtElement e) {
        SourcePosition p = e.getPosition();
        if (p == null || !p.isValidPosition()) {
            Object origin = e.getMetadata(ORIGIN_META);
            return origin instanceof CtElement o ? relPath(o) : null;
        }
        return sources.relativize(p.getFile());
    }

    public Evidence evidence(CtElement e, String rule, Resolution resolution) {
        SourcePosition p = e.getPosition();
        if ((p == null || !p.isValidPosition()) && e.getMetadata(ORIGIN_META) instanceof CtElement origin) {
            p = origin.getPosition();
        }
        if (p == null || !p.isValidPosition()) {
            return new Evidence(relPath(e), 0, 0, 0, rule, resolution);
        }
        return new Evidence(sources.relativize(p.getFile()), p.getLine(), p.getEndLine(), p.getColumn(), rule, resolution);
    }

    public static int line(CtElement e) {
        SourcePosition p = e.getPosition();
        if ((p == null || !p.isValidPosition()) && e.getMetadata(ORIGIN_META) instanceof CtElement origin) {
            p = origin.getPosition();
        }
        return p != null && p.isValidPosition() ? p.getLine() : 0;
    }

    public static int endLine(CtElement e) {
        SourcePosition p = e.getPosition();
        if ((p == null || !p.isValidPosition()) && e.getMetadata(ORIGIN_META) instanceof CtElement origin) {
            p = origin.getPosition();
        }
        return p != null && p.isValidPosition() ? p.getEndLine() : 0;
    }

    public static int column(CtElement e) {
        SourcePosition p = e.getPosition();
        return p != null && p.isValidPosition() ? p.getColumn() : 0;
    }

    // ---------------------------------------------------------------- annotations

    public static String annotationName(CtAnnotation<?> a) {
        try {
            return a.getAnnotationType().getSimpleName();
        } catch (RuntimeException e) {
            return "?";
        }
    }

    public static boolean hasAnnotation(CtElement e, String... simpleNames) {
        Set<String> names = Set.of(simpleNames);
        for (CtAnnotation<?> a : e.getAnnotations()) {
            if (names.contains(annotationName(a))) {
                return true;
            }
        }
        return false;
    }

    public static CtAnnotation<?> annotation(CtElement e, String simpleName) {
        for (CtAnnotation<?> a : e.getAnnotations()) {
            if (simpleName.equals(annotationName(a))) {
                return a;
            }
        }
        return null;
    }

    public static CtExpression<?> annotationValue(CtAnnotation<?> a, String... keys) {
        if (a == null) {
            return null;
        }
        Map<String, CtExpression> values = a.getValues();
        for (String k : keys) {
            CtExpression<?> v = values.get(k);
            if (v != null) {
                return v;
            }
        }
        return null;
    }

    public static List<String> annotationNames(CtElement e) {
        return e.getAnnotations().stream().map(SpoonSupport::annotationName).toList();
    }

    // ---------------------------------------------------------------- resolution helpers

    public static CtExecutable<?> declarationOf(CtExecutableReference<?> ref) {
        if (ref == null) {
            return null;
        }
        try {
            return ref.getExecutableDeclaration();
        } catch (RuntimeException | StackOverflowError e) {
            return null;
        }
    }

    public static CtType<?> typeDeclarationOf(CtTypeReference<?> ref) {
        if (ref == null) {
            return null;
        }
        try {
            return ref.getTypeDeclaration();
        } catch (RuntimeException | StackOverflowError e) {
            return null;
        }
    }

    // ---------------------------------------------------------------- accessors

    /**
     * "getter" / "setter" when the method body is exactly {@code return field;} or {@code this.field = param;}
     * (decided by body shape, never by name); Lombok-synthesized accessors report their feature. Otherwise null.
     */
    public static String trivialAccessor(CtExecutable<?> e) {
        Object lombok = e.getMetadata(LOMBOK_META);
        if (lombok != null) {
            return lombok.toString().toLowerCase(java.util.Locale.ROOT);
        }
        if (!(e instanceof CtMethod<?> m) || m.isStatic() || m.getBody() == null || m.getBody().getStatements().size() != 1) {
            return null;
        }
        spoon.reflect.code.CtStatement s = m.getBody().getStatements().get(0);
        if (m.getParameters().isEmpty() && s instanceof spoon.reflect.code.CtReturn<?> r
                && r.getReturnedExpression() instanceof spoon.reflect.code.CtFieldRead<?> fr && ownField(fr, m)) {
            return "getter";
        }
        if (m.getParameters().size() == 1 && s instanceof spoon.reflect.code.CtAssignment<?, ?> a
                && a.getAssigned() instanceof spoon.reflect.code.CtFieldWrite<?> fw && ownField(fw, m)
                && a.getAssignment() instanceof spoon.reflect.code.CtVariableRead<?> vr
                && vr.getVariable().getSimpleName().equals(m.getParameters().get(0).getSimpleName())) {
            return "setter";
        }
        return null;
    }

    private static boolean ownField(spoon.reflect.code.CtFieldAccess<?> access, CtMethod<?> m) {
        boolean thisTarget = access.getTarget() == null || access.getTarget() instanceof spoon.reflect.code.CtThisAccess<?>;
        if (!thisTarget) {
            return false;
        }
        try {
            CtField<?> f = access.getVariable().getFieldDeclaration();
            return f != null && f.getDeclaringType() == m.getDeclaringType() && !f.isStatic();
        } catch (RuntimeException ex) {
            return false;
        }
    }

    // ---------------------------------------------------------------- owners

    /**
     * The named method a call site belongs to. Code in lambdas and anonymous/local classes is attributed
     * to the enclosing named method (flagged); initializers become synthetic &lt;clinit&gt;/&lt;instinit&gt; owners.
     */
    public record Owner(String id, CtElement element, CtType<?> type, boolean inLambda, boolean inAnonymousClass, boolean synthetic) {
    }

    public static Owner ownerOf(CtElement e) {
        boolean lambda = false;
        boolean anon = false;
        CtElement cur = e.isParentInitialized() ? e.getParent() : null;
        while (cur != null) {
            if (cur instanceof CtLambda<?>) {
                lambda = true;
            } else if (cur instanceof CtMethod<?> || cur instanceof CtConstructor<?>) {
                CtType<?> dt = declaringType(cur);
                if (dt != null && (dt.isAnonymous() || dt.isLocalType())) {
                    anon = true;
                } else if (dt != null) {
                    return new Owner(methodId((CtExecutable<?>) cur), cur, dt, lambda, anon, false);
                }
            } else if (cur instanceof CtAnonymousExecutable ae) {
                CtType<?> dt = declaringType(ae);
                if (dt != null && (dt.isAnonymous() || dt.isLocalType())) {
                    anon = true;
                } else if (dt != null) {
                    return new Owner(syntheticMethodId(dt, ae.isStatic() ? "<clinit>" : "<instinit>"), ae, dt, lambda, anon, true);
                }
            } else if (cur instanceof CtField<?> f) {
                CtType<?> dt = f.getDeclaringType();
                if (dt != null && (dt.isAnonymous() || dt.isLocalType())) {
                    anon = true;
                } else if (dt != null) {
                    return new Owner(syntheticMethodId(dt, f.isStatic() ? "<clinit>" : "<instinit>"), f, dt, lambda, anon, true);
                }
            } else if (cur instanceof CtPackage) {
                return null;
            }
            cur = cur.isParentInitialized() ? cur.getParent() : null;
        }
        return null;
    }
}
