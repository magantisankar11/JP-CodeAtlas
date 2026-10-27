package com.jci.analyzer.spoon;

import spoon.reflect.code.BinaryOperatorKind;
import spoon.reflect.code.CtBinaryOperator;
import spoon.reflect.code.CtBlock;
import spoon.reflect.code.CtCase;
import spoon.reflect.code.CtCatch;
import spoon.reflect.code.CtConditional;
import spoon.reflect.code.CtConstructorCall;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtFieldRead;
import spoon.reflect.code.CtIf;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtLambda;
import spoon.reflect.code.CtLiteral;
import spoon.reflect.code.CtLocalVariable;
import spoon.reflect.code.CtLoop;
import spoon.reflect.code.CtSwitch;
import spoon.reflect.code.CtVariableRead;
import spoon.reflect.code.CtVariableWrite;
import spoon.reflect.cu.SourcePosition;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtInterface;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtVariable;
import spoon.reflect.visitor.filter.TypeFilter;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;

/**
 * Folds string expressions to compile-time-known text. Anything not provably constant becomes a
 * {@link #DYNAMIC} placeholder and the result is marked incomplete; callers must never treat
 * incomplete text as the executed SQL.
 */
public final class ConstantFolder {

    public static final String DYNAMIC = "${?}";

    private static final int MAX_DEPTH = 30;
    private static final Set<String> BUILDER_TYPES = Set.of("StringBuilder", "StringBuffer");
    private static final Set<String> BUILDER_READ_ONLY = Set.of(
            "toString", "length", "charAt", "indexOf", "lastIndexOf", "substring", "isEmpty", "chars", "capacity", "equals", "hashCode", "compareTo");

    /**
     * @param variants when not complete but the only unknowns are constant appends in if/else/switch branches:
     *                 every text the expression can take (see {@link #variants}); otherwise null
     */
    public record Result(boolean complete, String value, List<String> fragments, String reason, List<String> variants) {
        public boolean hasLiteralText() {
            return fragments.stream().anyMatch(f -> !DYNAMIC.equals(f) && !f.isBlank());
        }
    }

    private static final class State {
        String reason;
        boolean collectVariants;
        boolean nonEnumerable;
        List<String> variants;

        boolean fail(List<String> out, String why) {
            nonEnumerable = true;
            return failEnumerable(out, why);
        }

        boolean failEnumerable(List<String> out, String why) {
            out.add(DYNAMIC);
            if (reason == null) {
                reason = why;
            }
            return false;
        }
    }

    public Result fold(CtExpression<?> e) {
        List<String> parts = new ArrayList<>();
        State st = new State();
        CtExpression<?> builderSink = builderSink(e);
        st.collectVariants = builderSink != null;
        boolean ok = fold(builderSink != null ? builderSink : e, parts, 0, st);
        List<String> merged = merge(parts);
        List<String> variants = !ok && !st.nonEnumerable ? st.variants : null;
        return new Result(ok, ok ? String.join("", merged) : null, merged, ok ? null : st.reason, variants);
    }

    /** {@code sb.toString()}, a builder variable, or a never-reassigned local initialised with one of those. */
    private static CtExpression<?> builderSink(CtExpression<?> e) {
        CtExpression<?> cur = e;
        for (int i = 0; i < 3 && cur != null; i++) {
            if (cur instanceof CtInvocation<?> inv && "toString".equals(inv.getExecutable().getSimpleName())
                    && inv.getArguments().isEmpty() && inv.getTarget() instanceof CtVariableRead<?> t && localBuilder(t) != null) {
                return cur;
            }
            if (!(cur instanceof CtVariableRead<?> vr) || cur instanceof CtFieldRead<?>) {
                return null;
            }
            if (localBuilder(vr) != null) {
                return cur;
            }
            CtVariable<?> v;
            try {
                v = vr.getVariable().getDeclaration();
            } catch (RuntimeException ex) {
                return null;
            }
            if (!(v instanceof CtLocalVariable<?> lv) || isReassigned(lv)) {
                return null;
            }
            cur = lv.getDefaultExpression();
        }
        return null;
    }

    private static CtLocalVariable<?> localBuilder(CtVariableRead<?> r) {
        try {
            return r.getVariable().getDeclaration() instanceof CtLocalVariable<?> lv && isBuilder(lv) ? lv : null;
        } catch (RuntimeException ex) {
            return null;
        }
    }

    private boolean fold(CtExpression<?> e, List<String> out, int depth, State st) {
        if (e == null) {
            return st.fail(out, "NULL_EXPRESSION");
        }
        if (depth > MAX_DEPTH) {
            return st.fail(out, "TOO_DEEP");
        }
        if (e instanceof CtLiteral<?> lit) {
            Object v = lit.getValue();
            if (v == null) {
                return st.fail(out, "NULL_LITERAL");
            }
            out.add(String.valueOf(v));
            return true;
        }
        if (e instanceof CtBinaryOperator<?> bin) {
            if (bin.getKind() != BinaryOperatorKind.PLUS) {
                return st.fail(out, "NON_CONCAT_OPERATOR");
            }
            boolean l = fold(bin.getLeftHandOperand(), out, depth + 1, st);
            boolean r = fold(bin.getRightHandOperand(), out, depth + 1, st);
            return l && r;
        }
        if (e instanceof CtFieldRead<?> fr) {
            CtField<?> f;
            try {
                f = fr.getVariable().getFieldDeclaration();
            } catch (RuntimeException ex) {
                f = null;
            }
            boolean constant = f != null && f.getDefaultExpression() != null
                    && (f.isFinal() || f.getDeclaringType() instanceof CtInterface<?>);
            if (!constant) {
                return st.fail(out, "FIELD_NOT_CONSTANT:" + fr.getVariable().getSimpleName());
            }
            return fold(f.getDefaultExpression(), out, depth + 1, st);
        }
        if (e instanceof CtVariableRead<?> vr) {
            CtVariable<?> v;
            try {
                v = vr.getVariable().getDeclaration();
            } catch (RuntimeException ex) {
                v = null;
            }
            if (v instanceof CtParameter<?>) {
                return st.fail(out, "PARAMETER:" + v.getSimpleName());
            }
            if (v instanceof CtLocalVariable<?> lv) {
                if (isBuilder(lv)) {
                    return foldBuilder(lv, e, out, depth, st);
                }
                if (lv.getDefaultExpression() == null) {
                    return st.fail(out, "LOCAL_WITHOUT_INITIALIZER:" + lv.getSimpleName());
                }
                if (isReassigned(lv)) {
                    fold(lv.getDefaultExpression(), out, depth + 1, st);
                    return st.fail(out, "LOCAL_REASSIGNED:" + lv.getSimpleName());
                }
                return fold(lv.getDefaultExpression(), out, depth + 1, st);
            }
            return st.fail(out, "UNKNOWN_VARIABLE");
        }
        if (e instanceof CtInvocation<?> inv && "toString".equals(inv.getExecutable().getSimpleName())
                && inv.getArguments().isEmpty() && inv.getTarget() instanceof CtVariableRead<?> target) {
            CtVariable<?> v;
            try {
                v = target.getVariable().getDeclaration();
            } catch (RuntimeException ex) {
                v = null;
            }
            if (v instanceof CtLocalVariable<?> lv && isBuilder(lv)) {
                return foldBuilder(lv, e, out, depth, st);
            }
        }
        return st.fail(out, "NON_CONSTANT_EXPRESSION:" + e.getClass().getSimpleName().replace("Impl", ""));
    }

    private static boolean isBuilder(CtLocalVariable<?> lv) {
        return lv.getType() != null && BUILDER_TYPES.contains(lv.getType().getSimpleName());
    }

    private static boolean isReassigned(CtLocalVariable<?> lv) {
        CtBlock<?> scope = lv.getParent(CtBlock.class);
        if (scope == null) {
            return true;
        }
        for (CtVariableWrite<?> w : scope.getElements(new TypeFilter<>(CtVariableWrite.class))) {
            if (refersTo(w, lv)) {
                return true;
            }
        }
        return false;
    }

    private static boolean refersTo(spoon.reflect.code.CtVariableAccess<?> access, CtLocalVariable<?> lv) {
        try {
            return access.getVariable().getDeclaration() == lv;
        } catch (RuntimeException ex) {
            return false;
        }
    }

    /**
     * StringBuilder text is constant only if every append before the sink is unconditional, has a constant
     * argument, and the builder is not otherwise mutated or passed elsewhere.
     */
    private boolean foldBuilder(CtLocalVariable<?> lv, CtExpression<?> sink, List<String> out, int depth, State st) {
        CtBlock<?> scope = lv.getParent(CtBlock.class);
        if (scope == null || isReassigned(lv)) {
            return st.fail(out, "BUILDER_REASSIGNED");
        }
        int sinkStart = start(sink);
        boolean ok = true;
        CtExpression<?> init = lv.getDefaultExpression();
        if (init instanceof CtConstructorCall<?> cc && BUILDER_TYPES.contains(cc.getType().getSimpleName())) {
            if (cc.getArguments().size() == 1) {
                CtExpression<?> arg = cc.getArguments().get(0);
                boolean capacity = arg instanceof CtLiteral<?> l && l.getValue() instanceof Number;
                if (!capacity) {
                    ok &= fold(arg, out, depth + 1, st);
                }
            } else if (!cc.getArguments().isEmpty()) {
                ok = st.fail(out, "BUILDER_INIT_UNSUPPORTED");
            }
        } else {
            return st.fail(out, "BUILDER_INIT_UNKNOWN");
        }
        // Collect every contribution with its source position first, then fold in source order so that
        // placeholders for conditional / unsupported pieces land where they occur in the text.
        List<Piece> pieces = new ArrayList<>();
        for (CtVariableRead<?> r : scope.getElements(new TypeFilter<>(CtVariableRead.class))) {
            if (!refersTo(r, lv) || r == sink || start(r) >= sinkStart) {
                continue;
            }
            CtElement parent = r.getParent();
            if (parent instanceof CtInvocation<?> inv && inv.getTarget() == r) {
                String name = inv.getExecutable().getSimpleName();
                if ("append".equals(name)) {
                    CtInvocation<?> cur = inv;
                    while (true) {
                        if (cur.getArguments().size() != 1) {
                            pieces.add(new Piece(cur, null, "APPEND_OVERLOAD_UNSUPPORTED"));
                            break;
                        }
                        CtExpression<?> arg = cur.getArguments().get(0);
                        Condition c = conditional(cur, scope);
                        if (c == null) {
                            pieces.add(new Piece(arg, arg, null));
                        } else if (c.enumerable()) {
                            pieces.add(new Piece(arg, arg, "CONDITIONAL_APPEND", c.group()));
                        } else {
                            pieces.add(new Piece(arg, arg, "LOOP_OR_DEFERRED_APPEND"));
                        }
                        CtElement next = cur.getParent();
                        if (next instanceof CtInvocation<?> n2 && n2.getTarget() == cur && "append".equals(n2.getExecutable().getSimpleName())) {
                            cur = n2;
                        } else {
                            break;
                        }
                    }
                } else if (!BUILDER_READ_ONLY.contains(name)) {
                    pieces.add(new Piece(inv, null, "BUILDER_MUTATED:" + name));
                }
            } else if (!(parent instanceof CtInvocation<?> sinkInv && sinkInv == sink)) {
                pieces.add(new Piece(r, null, "BUILDER_ESCAPES"));
            }
        }
        pieces.sort(Comparator.comparingInt(p -> start(p.at())));
        List<String> initText = List.copyOf(out);
        for (Piece p : pieces) {
            if (p.failure() == null) {
                ok &= fold(p.arg(), out, depth + 1, st);
            } else if (p.group() != null) {
                st.failEnumerable(out, p.failure());
                ok = false;
            } else {
                ok = st.fail(out, p.failure());
            }
        }
        if (!ok && st.collectVariants && depth == 0) {
            st.variants = variants(initText, pieces, st);
        }
        return ok;
    }

    /**
     * Every text the builder can hold when all non-constant contributions are constant appends inside if/else/switch
     * branches (no loops): one variant per combination of branch groups. A superset of the reachable texts when
     * branches are correlated or mutually exclusive, which only makes "present in every variant" more conservative.
     */
    private List<String> variants(List<String> init, List<Piece> pieces, State st) {
        if (st.nonEnumerable) {
            return null;
        }
        List<CtElement> groups = new ArrayList<>();
        List<String> texts = new ArrayList<>();
        for (Piece p : pieces) {
            if (p.arg() == null) {
                return null;
            }
            Result r = new ConstantFolder().fold(p.arg());
            if (!r.complete()) {
                return null;
            }
            texts.add(r.value());
            if (p.group() != null && !groups.contains(p.group())) {
                groups.add(p.group());
            }
        }
        if (groups.isEmpty() || groups.size() > MAX_VARIANT_GROUPS) {
            return null;
        }
        List<String> out = new ArrayList<>();
        String prefix = String.join("", init);
        for (int mask = 0; mask < (1 << groups.size()); mask++) {
            StringBuilder sb = new StringBuilder(prefix);
            for (int i = 0; i < pieces.size(); i++) {
                CtElement g = pieces.get(i).group();
                if (g == null || (mask & (1 << groups.indexOf(g))) != 0) {
                    sb.append(texts.get(i));
                }
            }
            out.add(sb.toString());
        }
        return out;
    }

    /** One builder contribution: an appended argument, or a failure located at {@code at}; group = enumerable branch. */
    private record Piece(CtElement at, CtExpression<?> arg, String failure, CtElement group) {
        Piece(CtElement at, CtExpression<?> arg, String failure) {
            this(at, arg, failure, null);
        }
    }

    private static final int MAX_VARIANT_GROUPS = 4;

    /** Conditionality of {@code e} below {@code stopAt}; null when it always executes. */
    private record Condition(boolean enumerable, CtElement group) {
    }

    private static Condition conditional(CtElement e, CtElement stopAt) {
        CtElement child = e;
        CtElement cur = e.isParentInitialized() ? e.getParent() : null;
        CtElement group = null;
        boolean enumerable = true;
        boolean any = false;
        while (cur != null && cur != stopAt) {
            if (cur instanceof CtLoop || cur instanceof CtCatch || cur instanceof CtLambda<?>) {
                enumerable = false;
                any = true;
            } else if (cur instanceof CtIf || cur instanceof CtCase<?> || cur instanceof CtConditional<?>) {
                if (group == null) {
                    group = cur instanceof CtIf ? child : cur;
                }
                any = true;
            } else if (cur instanceof CtSwitch<?>) {
                any = true;
            } else if (cur instanceof CtBinaryOperator<?> b && (b.getKind() == BinaryOperatorKind.AND || b.getKind() == BinaryOperatorKind.OR)
                    && b.getRightHandOperand() == child) {
                enumerable = false;
                any = true;
            }
            child = cur;
            cur = cur.isParentInitialized() ? cur.getParent() : null;
        }
        if (!any) {
            return null;
        }
        return new Condition(enumerable && group != null, group);
    }

    private static int start(CtElement e) {
        SourcePosition p = e.getPosition();
        return p != null && p.isValidPosition() ? p.getSourceStart() : Integer.MAX_VALUE;
    }

    private static List<String> merge(List<String> parts) {
        List<String> out = new ArrayList<>();
        StringBuilder lit = new StringBuilder();
        for (String p : parts) {
            if (DYNAMIC.equals(p)) {
                if (!lit.isEmpty()) {
                    out.add(lit.toString());
                    lit.setLength(0);
                }
                if (out.isEmpty() || !DYNAMIC.equals(out.get(out.size() - 1))) {
                    out.add(DYNAMIC);
                }
            } else {
                lit.append(p);
            }
        }
        if (!lit.isEmpty()) {
            out.add(lit.toString());
        }
        return out;
    }
}
