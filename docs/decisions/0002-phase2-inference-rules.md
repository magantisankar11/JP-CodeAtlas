# ADR 0002 — Phase 2 inference rules and their resolution levels

Status: accepted (2026-10-26). Every rule below is exercised by `fixtures/simple-rest` (golden file) or `UnitTest`.
Principle: a rule may only raise a fact to FRAMEWORK_DERIVED when the language or framework semantics make it a
deterministic consequence of the source; anything else stays AMBIGUOUS or UNRESOLVED with a reason.

| Rule (evidence `rule`) | Produces | Level | Why it is sound / what keeps it honest |
|---|---|---|---|
| `SQL_VARIANTS` | QUERIES + READS/WRITES | FRAMEWORK_DERIVED | A `StringBuilder` whose only unknowns are **constant** appends inside if/else/switch branches can only hold one of 2^n texts (n ≤ 4 branch groups). Each variant is parsed; `inAllVariants` separates certain from conditional tables. Loops, lambdas, `&&`/`||` or any non-constant piece keep it UNRESOLVED. |
| `LEXICAL_SCOPE_NAME_ARITY` | CALLS | FRAMEWORK_DERIVED (unique) / AMBIGUOUS (overloads) | Only for unqualified `m(..)` / implicit `this.m(..)` with no compiler binding (typically inside lambdas passed to unresolved library methods). Java resolves such names in the enclosing class hierarchy, then outer classes — never across unrelated types. |
| `QUALIFIER`, `SINGLE_BEAN`, `PRIMARY_BEAN`, `INJECTION_POINT_NAME` + `@Bean` products | CALLS (dispatch) | FRAMEWORK_DERIVED | Spring's candidate resolution order. `@Bean` methods whose every `return` is `new C(..)` make C a bean named after the method. |
| `OPAQUE_BEAN_FACTORY` | CALLS (dispatch) | AMBIGUOUS | A `@Bean` method with an unknown product may satisfy the injection point; single-bean / `@Primary` narrowing is withdrawn. Qualifier or injection-point-name selection survives unless the opaque factory has that same name. |
| `URL_FROM_PROPERTY` | CALLS_EXTERNAL | FRAMEWORK_DERIVED | URL is `@Value("${key}")` field (+ constant suffix). The key is recorded; the value is never read. |
| `CONSTANT_URL`, `SDK_RECEIVER_TYPE` | CALLS_EXTERNAL | CONFIRMED | Constant text / declared receiver type from an import. |
| `FEIGN_MAPPING` | CALLS_EXTERNAL | FRAMEWORK_DERIVED | `@FeignClient` + mapping annotation on the interface method. |
| `JOBRUNR_LAMBDA` | SCHEDULES | FRAMEWORK_DERIVED | Methods invoked by a lambda/method reference passed to a JobRunr scheduler type. |
| `SPRING_EVENT_LISTENER` / `PUBLISH_EVENT` | TRIGGERS / PUBLISHES | FRAMEWORK_DERIVED / CONFIRMED | Event type from `@EventListener` classes or the single parameter; published type from the argument's static type. |
| `JPA_TABLE`, `JPA_NAMING_*` | MAPS_TO | FRAMEWORK_DERIVED | `@Table`/`@Column` or the configured physical naming strategy; access type follows `@Id` placement (field vs getter) or `@Access`. Columns are checked against the migration catalog: hard mismatch, or *unverified* when a migration passes the table to a stored procedure. |
| Prepared-statement DDL | catalog columns | (catalog data) | `CONCAT("ALTER TABLE ", @t, " ADD ", @c, ...)` is evaluated only when every argument is a literal or a literal `SET @var`. Procedure bodies are never executed or interpreted. |
| Security URL rules | `attrs.security` on endpoints | (attribute) | Ordered `requestMatchers(..).<rule>()` chains, first match wins, Spring path-pattern semantics. A rule with any unreadable argument can only be a *possible* match and is never chosen as the definitive rule; literal-vs-path-variable matches are reported as `mayAlsoMatchEarlier`. |
| `SIGNATURE_TYPE`, `FIELD_DECLARATION`, `TYPE_REFERENCE` | ACCEPTS/RETURNS, HAS_FIELD_TYPE, USES_TYPE | CONFIRMED | Declared types. Spring beans and their interfaces are excluded from USES_TYPE (covered by CALLS/INJECTS). |

## Path strength in reverse impact

`pathResolution` on each reached node is the best achievable *weakest link* over the returned subgraph
(max–min relaxation). It never upgrades evidence: a path through any FRAMEWORK_DERIVED edge (e.g. an MVC mapping or
interface dispatch) is at most FRAMEWORK_DERIVED, and an endpoint reached only through an AMBIGUOUS dispatch is reported
as AMBIGUOUS — the "potential impact requiring investigation" category.
