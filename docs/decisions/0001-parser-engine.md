# ADR 0001 — Parser engine: Spoon (JDT) over JavaParser + SymbolSolver

Status: accepted (2026-10-26) · Evidence: `workspace/bakeoff/justperform-core/*.json`, `scripts/bakeoff.sh`

## Context

The analyzer must bind call sites to declarations in JustPerform-Core: Java 21, Spring Boot 3.5,
1,522 files, about 423k LOC, Lombok in 673 files. It runs without the project classpath (several private jars and
no build step against the target). Decision rule fixed before the run: prefer the engine that binds more call sites
to in-source declarations; if within 2 points, prefer the faster one; reject any engine that violates a golden
negative case.

## Bake-off (JustPerform-Core @ 671715e6cb, scope `com.crea.justperform.snippets`, whole tree parsed)

| Engine | Call sites | Bound in-source | Bound at all | Parse | Resolve | Heap peak | Fixture golden (static CALLS) |
|---|---|---|---|---|---|---|---|
| Spoon 11.5.0, noclasspath | 7,413 | **35.4 %** (2,627) | **71.8 %** | 51.3 s | **1.3 s** | 1,980 MB | 15/16, 0 violations |
| JavaParser 3.28.2 + SymbolSolver | 7,382 | 32.3 % (2,381) | 65.9 % | 19.5 s | 29.3 s | 2,194 MB | 15/16, 0 violations |

* Both engines miss the same golden edge in the probe because the probe does not count method references
  (`this::toForm`); the full analyzer emits it.
* Neither engine produced a forbidden edge (name collisions, qualifier-excluded beans, layer skipping, self-overload).
* "Bound at all" includes JDK calls. Most unbound sites are calls on Spring/Hibernate/Jackson types that are absent
  without a classpath, not missed internal calls (see analyzer `calls.unknownReceiver` / `libraryUnbound` stats).
* The repository's `git status` checksum and `.git/index` mtime were identical before and after all runs.

## Decision

Use **Spoon** (Eclipse JDT under the hood) in noclasspath mode. It binds 246 more call sites in-source (+10 %),
resolves 20x faster once the model is built, and has better Java 21 coverage. It does build the model more slowly
than JavaParser parses, but the totals are comparable (52 s vs 49 s) and model build is a one-off per snapshot.

## Consequences

* Lombok is handled by synthesizing accessors in the in-memory model (`LombokSynthesizer`), not by delombok,
  which would reprint files and break line-number traceability.
* Library-call binding can be raised later by supplying `--classpath-file` (output of
  `mvn dependency:build-classpath`), which needs a separate approval because it runs Maven against the target.
* JavaParser stays as a dependency only for the `probe` command so the comparison can be re-run.
