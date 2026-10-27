# Java Code Intelligence

Static analysis of a Java/Spring repository into a commit-versioned knowledge graph (API endpoints, call graph,
Spring wiring, SQL, tables and migrations, DTO contracts, external integrations, jobs/events, security rules), with a
bounded interactive explorer. Phases 1–3 complete: execution flow, reverse dependencies, dependency intelligence,
impact analysis with regression candidates, Claude context bundles and a BMAD defect-impact workflow. Phase 4 (first
slice): the Vue front end (JustPerform-UI) is indexed and linked to the Core endpoints it calls, so impact runs from a
table or method up to the screens and routes that use it.

UI: search; tabs for endpoints, jobs & events, data (tables, procedures), integrations, types (DTOs, entities) and
config keys; forward flow / reverse impact with presets (execution flow, type impact, data); a reach panel listing every
entry point a change can affect with its evidence strength; details with contracts, security rule, columns and
commit-pinned source; "open in VS Code"; JSON export.

**Read-only by design.** The analyzer exports `git archive HEAD` into `workspace/`, never writes below the target
repository, runs every git command with `--no-optional-locks`, refuses to run if the workspace or output is inside the
target, and fails if `git status` of the target changes during a run. No application code is executed.

```
analyzer-java/   Java 21 CLI (Spoon 11.5 / JDT): analyze + engine bake-off probe   -> NDJSON (schemas/graph-v1)
analyzer-ui/     Node 22 CLI (TypeScript 5.9 compiler API + @vue/compiler-sfc): Vue/JS front end -> NDJSON (1.2.0)
server/          Node 22 + TypeScript, Fastify, better-sqlite3 (FTS5): loader, combine (UI→API stitching), REST API
web/             React 19 + @xyflow/react + elkjs: search, forward flow, reverse impact, screens, details, source
fixtures/        simple-rest + simple-ui fixtures with hand-written golden facts (positive and negative cases)
schemas/         graph-v1.schema.json, the versioned contract between analyzer and server
scripts/         bakeoff.sh, verify-edges.mjs
docs/decisions/  ADRs (0001: parser engine)
workspace/       (local only) exported sources, graphs, SQLite DB, reports
```

## Running it

Prerequisites on this machine: a full JDK 21+ (`~/.jdks/openjdk-26.0.1` works; compiled with `--release 21`),
Maven 3.9, Node 22 (`~/nvm/v22.22.0`), git.

```bash
export JAVA_HOME="$HOME/.jdks/openjdk-26.0.1"; export PATH="$JAVA_HOME/bin:$HOME/nvm/v22.22.0:$PATH"
npm run setup                     # installs server/ and web/ dependencies
npm run build:analyzer            # analyzer-java/target/jci-analyzer.jar (runs no tests; use npm run test:analyzer)

# 1. analyze the whole repository (~2.5 min, ~3 GB heap); --include pkg limits extraction to some packages
java -Xmx8g -jar analyzer-java/target/jci-analyzer.jar analyze \
  --repo ../JustPerform-Core --repo-id justperform-core \
  --out workspace/graphs/justperform-core-full.ndjson --workspace workspace
#    migrations: --schema-dir (default src/main/resources/db/migration, .../Stored_Procedures)
#    properties: --property-file (default src/main/resources/application.{properties,yml}); keys only

# 2. load into SQLite and make it current (re-loading the same repo+commit+scope replaces it; other commits are kept;
#    --no-publish loads without making it current)
npm run load -- ../workspace/graphs/justperform-core-full.ndjson

#    afterwards, keep Core + UI current with one command (see "Synchronization")
npm run sync

# 3. explore
npm run server                    # API on http://127.0.0.1:4317
npm run web                       # UI  on http://127.0.0.1:5173
```

Tests: `npm run test:analyzer` (golden fixture + units), `npm test` (server API + web typecheck),
`cd analyzer-ui && npm test` (simple-ui golden facts).
Edge verification against the analysed revision: `node scripts/verify-edges.mjs <graph.ndjson> <repo> 30 42`.

## Resolution model (every edge carries one, plus evidence file:line)

| Level | Meaning |
|---|---|
| CONFIRMED | Compiler binding to exactly one declaration; SQL text fully constant through a recognised SQL API |
| FRAMEWORK_DERIVED | Documented rule: Spring bean resolution (`@Qualifier` > single bean > `@Primary` > injection-point name), single implementation (CHA), Lombok-generated member, MVC mapping |
| AMBIGUOUS | Several candidates (all listed in `attrs.candidates`) |
| UNRESOLVED | Reflection, `getBean`, runtime-built SQL (literal fragments kept, no tables derived) |

A call through an interface yields a CONFIRMED edge to the interface method and per-site dispatch edges to the
implementations; the UI collapses the interface hop by default (toggle "Interface hops"). Trivial accessors
(Lombok or hand-written `return field` / `this.f = p`, detected by body shape) are hidden by default.

Phase 2 inference rules (SQL variants, lexical-scope calls, `@Bean` factories, property-based URLs, JobRunr, events,
JPA mapping, migration idioms, security matching) and the levels they may produce are listed in
[ADR 0002](docs/decisions/0002-phase2-inference-rules.md).

## API (v1, read-only; every response names `snapshot {id, repoId, commitSha}`)

`GET /api/v1/snapshots` · `search?q&kinds` · `endpoints?method&q` · `node?id` (with incoming/outgoing) ·
`graph?root&direction=forward|reverse&depth&preset=flow|type-impact|data|all&minResolution&includeAccessors&collapseDispatch&limit` ·
`reach?root&preset&depth` (every endpoint / job / listener reaching a node in reverse, with path strength; 20k-node budget, nothing rendered) ·
`catalog?kind=DATABASE_TABLE|DATABASE_PROCEDURE|EXTERNAL_API|DTO|ENTITY|CONFIG_PROPERTY` or `catalog?entryPoints=true` (lists with per-kind edge counts) ·
`presets` · `source?file&from&to` (only files in the snapshot; read with `git show <sha>:<path>`; secrets redacted) · `diagnostics?code` ·
`freshness?remote=cached|live&refresh&rev.<repoId>=<branch|tag|sha>` (below)

### Freshness (`GET /api/v1/freshness`, `npm run impact -- --status`, header strip in the UI)

Each repository of a snapshot is reported on four **independent** dimensions (`server/src/freshness.ts`); none changes another.

| Dimension | Values | Meaning |
|---|---|---|
| `accuracy` (= `status`) | CURRENT / STALE / UNKNOWN | Does the graph describe the selected revision (default HEAD; `rev.<repoId>=` or `--rev <repoId>=<ref>` picks another)? STALE when the commits differ, with `matchingSnapshotId` if another loaded snapshot has exactly the selected commit(s). UNKNOWN when it cannot be established (no repository, not git, unresolvable revision, `WORKTREE` snapshot) |
| `branch` | UP_TO_DATE / BEHIND / AHEAD / DIVERGED / NO_UPSTREAM / UNKNOWN | Selected commit vs its upstream, with counts and their as-of time. The default branch is reported beside it (`branch.default`) for information only: a feature branch ahead of or diverged from it is never STALE |
| `remote` | VERIFIED / RECENT / UNKNOWN / NOT_APPLICABLE | How current the remote information is: VERIFIED by a live check, RECENT when the last fetch is within `JCI_FRESHNESS_MAX_REMOTE_AGE_H` (default 24), else UNKNOWN. Never downgrades a CURRENT snapshot |
| `worktree` | CLEAN / MODIFIED / UNKNOWN | Uncommitted changes **inside the analyzer's input scope** only (Java: `sourceRoots` `*.java`, `schemaDirs` `*.sql`, `application.{properties,yml,yaml}`; UI: `sourceRoots` with the parsed extensions, no `node_modules`). MODIFIED warns that the commit-pinned graph does not include them; it never makes the snapshot STALE |

* The top-level `status` is the worst accuracy across repositories (STALE > UNKNOWN > CURRENT).
* **CodeAtlas never fetches** (that would write `.git`). Cached mode reads the local remote-tracking refs. `remote=live` /
  `--remote live` / "Check remote now" runs one `git ls-remote` per repository, never prompting for credentials
  (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, ssh `BatchMode`), 8 s timeout; a failure only sets `remote` to
  UNKNOWN and keeps the last verified result. CI workflows fetch in their own clone and index the exact commit (`--commit`).
* Results are cached in memory (30 s cached, 5 min live). Every snapshot-scoped response carries
  `X-JCI-Snapshot-Status` from that cache only (UNKNOWN until a check has run; it never runs git on the request path).
* Impact reports and bundles include `freshness` and a *Source freshness* section; a MODIFIED tree adds the unknown
  `LOCAL_MODIFICATIONS_NOT_INDEXED`, a non-CURRENT snapshot adds `SNAPSHOT_NOT_CURRENT`, and either sets the
  traceability gate to NEEDS_HUMAN. Analyse uncommitted changes with `npm run impact -- --changes --core working`.
* `--status` keeps `current` / `repoHead` with their original meaning (HEAD equality) and adds the four dimensions.

Reverse results carry `pathResolution` (best chain of evidence from the root, never stronger than its weakest edge)
and `viaEnclosingType` (reached only through a field of another type — potential impact, the field may be unused).

### Security model

Single-user local tool: there is **no authentication**, so the API is restricted to the local machine and to known browser pages
(`server/src/security.ts`, checked in `onRequest` before routing, tests in `server/test/security.test.ts`):

* Binds to loopback only. `JCI_HOST` may choose another loopback address; anything else (e.g. `0.0.0.0`) refuses to start.
* `Host` must be `127.0.0.1`, `localhost` or `[::1]` (any port), otherwise 403. This blocks DNS rebinding.
* `Origin`, when sent, must be exactly `http://{127.0.0.1|localhost|[::1]}:{API port|5173}` or listed in `JCI_ALLOWED_ORIGINS`
  (comma-separated, e.g. `http://localhost:4173`); `null` and other origins get 403. `Sec-Fetch-Site: cross-site` gets 403.
* POST bodies must be `application/json` (415 otherwise), so other sites cannot send requests that skip the CORS preflight.
* No CORS headers are ever sent. Any process on the machine itself can still call the API.

### Synchronization (`npm run sync`)

One command keeps the current snapshot in step with the repositories' committed revisions (`server/src/sync/`):

```bash
npm run sync -- --dry-run                       # what would be reused or re-indexed; writes nothing
npm run sync                                    # HEAD of each repository; UP_TO_DATE when nothing changed
npm run sync -- --rev justperform-core=bug/JP-123   # another revision (branch, tag, sha); never fetched
npm run sync -- --reindex justperform-ui        # re-index even though a graph exists (or --reindex all)
#   --json  --db FILE  --config FILE  --max-shrink 0.5  --allow-shrink
```

1. **Repositories:** `config/repos.yaml` (copy `config/repos.example.yaml`; git-ignored), else those recorded in the
   current system snapshot.
2. **Revisions** are resolved locally (`rev-parse`); sync never fetches or pulls. Run `git fetch`/`git pull` yourself, or in CI.
3. **Reuse:** the current snapshot built from the same commits, analyzer versions and stitch settings → `UP_TO_DATE`.
   Otherwise a graph file is reused per repository when it is a whole-repository HEAD-mode graph of that commit, written
   by the installed analyzer version (`java -jar jci-analyzer.jar version`, `analyzer-ui/src/version.ts`), with a
   supported schema and a complete last line.
4. **Index** what is missing: read-only (`git archive` / `git cat-file` at the commit), via `.partial/` and a rename.
   Core takes about 3 minutes (8 GB heap), UI a few seconds. A jar older than the analyzer sources is reported.
5. **Combine** Core + UI into `workspace/graphs/cache/system-<core>-<ui>.ndjson` (reused when built from the same files).
6. **Load** as PENDING: invisible to the API, CLI, web and freshness matching.
7. **Validate:** the loader's contract, schema and reference checks, then commits, counts, search index, dangling edges,
   UI path prefixes, content (endpoints; routes/components), a **shrink guard** (no node kind with ≥ 10 nodes drops more
   than 50%, `CALLS_API` links do not drop to zero; `--allow-shrink` for a real large refactor) and a query smoke test.
8. **Publish** in one SQLite transaction (`current_snapshots`): readers see the old snapshot or the new one, never a mix.
9. **On failure** the previous snapshot stays current and the PENDING snapshot is deleted; one left by an interrupted sync
   is deleted at the start of the next. Nothing else is ever deleted (old snapshots stay until Phase E retention).
10. **Report:** text or `--json`; `workspace/sync/last-sync.json` and `history.ndjson` (not for `--dry-run`), including
    the freshness of the resulting snapshot (a dirty working tree or a branch behind its upstream is a warning).

Exit codes: 0 published or up to date, 1 failed (previous snapshot kept), 2 usage or configuration error, 3 another sync
is running (`workspace/sync/sync.lock`; a lock of a process that no longer runs is taken over).

**Current snapshot.** `GET /api/v1/snapshots` marks each repository's current snapshot (`current: true`, additive), and
requests by `repo` (API) or `--repo` (CLI) use it. Without a published pointer the newest snapshot is current, as before.
`npm run load` publishes what it loads (`--no-publish` to keep the current one). The web opens the newest current snapshot
and marks it "(current)"; an open page keeps its selection, and its freshness strip offers "Switch to snapshot N".

## Phase 2 results (JustPerform-Core @ 671715e6cb, whole repository)

| | |
|---|---|
| Run | 1,522 files, 1,570 types in scope; 51 s model build + 88 s extraction; 3.1 GB heap; 135 MB NDJSON; loads into SQLite in 11 s |
| Graph | 46,957 nodes / 162,467 edges: 1,089 endpoints, 42,055 methods, 530 DTOs, 159 entities, 72,271 CALLS (77 AMBIGUOUS, 15 UNRESOLVED) |
| Data | 1,695 SQL statements: 1,320 constant + 140 resolved by variant enumeration, 235 UNRESOLVED; 1,597 READS / 388 WRITES; migration catalog of 160 live tables (97 dropped), 20 procedures from 1,313 scripts (1,052 DDL statements, 32 unparsed) |
| Entities | 159 MAPS_TO; 7 columns mapped by entities but defined by no migration (e.g. `t_landscape_token_master.expire_date`), 86 unverifiable (tables altered by stored procedures) |
| Contracts | 526 ACCEPTS, 522 RETURNS, 2,795 HAS_FIELD_TYPE, 36,449 USES_TYPE |
| Integrations | 21 Feign methods, 140 SDK calls (S3, Azure Blob, GCS, BigQuery, SAP JCo, mail, SFTP, Redis, Hazelcast), 2 property-based HTTP URLs, 20 runtime-built HTTP URLs |
| Entry points | 3 @Scheduled, 3 JobRunr @Recurring, 1 @Job, 6 JobRunr lambda schedules, 1 @EventListener, 3 WebSocket |
| Security | 27 URL rules from the SecurityFilterChain applied to every endpoint; 4 custom filters listed; context path `/JustPerform` |
| Also | 936 THROWS, 10 global exception handlers, 41 config keys read by code (values never read), 107 lambda calls recovered by lexical scope |
| Verification | 91,963 call-site evidence lines checked against the commit: 0 mismatches. 40-edge seeded sample (20 CONFIRMED, 16 FRAMEWORK_DERIVED, 4 AMBIGUOUS) reviewed by hand: all correct. Spot checks of security rules, Feign targets and entry points against the source: correct |
| Tests | analyzer 17 (golden fixture now covers every Phase 2 rule, incl. negative cases and a secret-leak check), server 21, web typecheck |
| Target repo | `git status` checksum identical before and after every run |

Bugs found and fixed through this verification (each now has a regression test): SQL fragments out of order; DDL in
files that also define procedures ignored; prepared-statement and procedure-applied migrations misreported as
schema mismatches; JPA property access (annotations on getters) ignored; `HttpMethod.X` matcher arguments not
recognised (a DELETE-only rule was applied to GET/POST) — unreadable security arguments now only yield "possible" matches.

## Phase 1 results (JustPerform-Core @ 671715e6cb, scope `com.crea.justperform.snippets`)

| | |
|---|---|
| Parsed / in scope | 1,522 files / 35 types (34 files, 12.6k LOC) |
| Endpoints | 34 on 32 handler methods; matches the 32 mapping annotations + one 3-path array |
| CALLS edges | 3,284 (2,056 CONFIRMED, 1,228 FRAMEWORK_DERIVED; 1,763 are accessor calls, hidden by default) |
| Call sites | 6,851 invocations: 2,692 bound in-source, 1,104 via Lombok synthesis, 2,249 JDK, 659 library types without classpath, 245 unknown receiver |
| SQL | 40 statements: 31 fully resolved (READS/WRITES on 6 tables), 9 UNRESOLVED (all conditional `StringBuilder` appends) |
| Time / memory | 53 s model build + 10 s extraction; 2.8 GB heap peak |
| Verification | 4,208 call-site evidence lines checked against `git show 671715e6cb:<file>`: 0 mismatches. 27-edge seeded sample (15 CONFIRMED, 12 FRAMEWORK_DERIVED) reviewed by hand: all correct; SINGLE_BEAN dispatch targets confirmed to be the only implementations |
| Fixture | 20 classes, 6 endpoints, 50+ golden assertions incl. 11 negative cases (name collisions, qualifier exclusion, layer skipping, overload self-binding, dynamic SQL, get-named business methods): all pass |
| Target repo | `git status` checksum and `.git/index` mtime identical before and after every run |

## Phase 3: impact analysis, context bundle, defect workflow

```bash
cd server
npm run impact -- --repo justperform-core --status                               # is the index at the repo's HEAD?
npm run impact -- --repo justperform-core --defect ticket.txt --match-only       # numbered code candidates for a ticket
npm run impact -- --repo justperform-core --defect ticket.txt --pick 1,3 --title JP-123   # writes the bundle
npm run impact -- --repo justperform-core --target "method:…" --target table:t_x # direct targets
npm run impact -- --repo justperform-core --callers "method:…"                    # call sites with source line at the commit
```

Bundle (default `workspace/bundles/<repo>-<sha12>-<slug>/`): `context.json` (schema `jci-context/1.0`: targets,
verified execution path, contracts, commit-pinned redacted excerpts within a 600-line budget, entry points, callers,
tables, externals, risks, unknowns, gates), `flow.md`, `dependencies.json`, `impact-analysis.md`, `relevant-tests.md`,
`jira-draft.md` (Jira wiki markup; never posted).

* **Classification** per finding: Confirmed dependency / Potential impact (ambiguous dispatch, or only via a field of an
  enclosing type) / Unknown (unresolved link). No numeric scores.
* **Risks** fire only on evidence: API contract or behaviour, background jobs, tables shared with other writers or not in
  migrations, entity–schema coupling, configuration keys, outbound integrations, multiple implementations, public
  endpoints, unhandled exceptions on HTTP paths, widely shared targets.
* **Regression candidates**: unit (branches, throw sites, collaborators to mock), API (MockMvc path, body, security
  expectation), contract, error path, job, data — with suggested test locations. No existing coverage is ever claimed.
* **Defect matching**: stack frames, URLs (context path stripped), tables, `Class.method`, exception names, quoted log
  messages (`git grep` at the commit, literal prefix for messages with runtime values), UI phrases → camelCase
  identifiers, keywords. Strength EXACT / STRONG / TEXT / WEAK; WEAK is never auto-selected.
* **Closure gates**: `config/closure-gates.yaml` (editable). Automatic checks report EVIDENCE_PRESENT / MISSING only;
  root cause, fix scope and verification are always NEEDS_HUMAN.
* **Past commits**: `analyze --commit <sha>` indexes any revision via `git archive` (regression windows).
* API: `POST /api/v1/defect/match`, `POST /api/v1/impact`, `POST /api/v1/export/context`; UI: **Defect** tab and an
  **Impact report** button on every node, with bundle downloads.
* BMAD: user-level skill `~/.claude/skills/jci-defect-impact-analysis` (ticket → targets → bundle → graded root cause →
  smallest safe fix → compatibility → tests → `analysis.md` + `jira-comment.md` → gates). Reads Jira, never writes it;
  never edits production code; hands off to `bmad-investigate` / `bmad-quick-dev`.

### Trial: JP-10636 (closed bug, known fix `6c95199529`)

Indexed the parent commit `bf0135c3` and ran the workflow on the ticket text alone (no stack trace or class names).
The UI phrase "Enable user selection" matched `*UserSelection*` methods; the bundle's direct-caller excerpt and
`--callers` showed `populateIntegrationMemberMap` passing a literal `null` rule type into `populateSelectionDimMemberVO`,
which calls `RulesUtil.isWorkflowRule(null)` → `ruleType.equals(...)` NPE, reached only from
`GET /activity/loadTaskCalculationData`. That is the exact location and one-line fix of the real commit. Artefacts:
`workspace/bundles/JP-10636-prefix/` (incl. `analysis.md`, `jira-comment.md`). Lessons applied: phrase-to-identifier
matching, caller excerpts in the bundle, the `--callers` mode, `--commit` indexing.

## Phase 4 (slice 1): front end and UI → API links

Repositories in scope: **JustPerform-Core** (backend) and **JustPerform-UI** (`../main/JustPerform-UI`, Vue 3 +
Quasar). No other repository under `~/projects` is read. Each repository is analysed on its own at its own commit;
`combine` joins them into one *system* snapshot:

```bash
cd analyzer-ui && npm install
npm run analyze -- --repo ../../main/JustPerform-UI --repo-id justperform-ui --out ../workspace/graphs/justperform-ui.ndjson
cd ../server
npm run combine -- --core ../workspace/graphs/justperform-core-full.ndjson --ui ../workspace/graphs/justperform-ui.ndjson \
  --out ../workspace/graphs/justperform-system.ndjson      # [--core-base process.env.JP_API]...
npm run load -- ../workspace/graphs/justperform-system.ndjson
npm run impact -- --repo justperform-system --status         # per-repository commit vs HEAD
```

* **UI analyzer** (read-only: `git ls-tree` + `git cat-file --batch` at the commit; `git status` checked before/after).
  Nodes: `UI_COMPONENT` (.vue), `UI_MODULE`, `UI_STORE` (Pinia), `UI_FUNCTION` (functions, class methods, Options-API
  methods/computed/watch/hooks, `<script setup>`, `<template>`), `UI_ROUTE` (vue-router), `UI_HTTP_CALL` (axios / fetch
  call sites), `TEST_CASE` (specs). Edges: `CONTAINS`, `IMPORTS`, `CALLS` (import/instance/`this`/Pinia/template event
  bindings), `RENDERS` (template tags; `<component :is>` → AMBIGUOUS to each registered component), `ROUTES_TO`,
  `MAKES_HTTP_CALL`, `TESTS` (import-based). URLs are partially evaluated (literals, template strings, `+`, module and
  function-local constants, single-return helpers like `jpEndpoint()`; conditional `let url` keeps every variant).
* **Stitching** (`server/src/multi/stitch.ts`): a `UI_HTTP_CALL` links to an `API_ENDPOINT` with `CALLS_API` by HTTP
  method and path segments after removing the base, context path and query string. A dynamic segment binds a `{var}`;
  Spring's most-specific rule picks among exact matches → FRAMEWORK_DERIVED. Ties, or a segment that is part literal and
  part runtime value, → AMBIGUOUS. Anything else becomes a diagnostic, never an edge: `UI_HTTP_NO_ENDPOINT`,
  `UI_HTTP_METHOD_MISMATCH`, `UI_HTTP_OTHER_SERVICE`, `UI_HTTP_URL_UNKNOWN`, `UI_HTTP_TOO_MANY_CANDIDATES`.
* **System snapshot**: Core records pass through unchanged (ids, paths, evidence). UI file paths carry the prefix
  `@justperform-ui/`; `scope.repos` lists every repository with its commit, so source excerpts, context bundles,
  defect text search (`git grep` per repository) and `--callers` read each file from its own repository and commit.
* **Impact**: from every affected endpoint a separate reverse walk (depth 12) follows `CALLS_API ← MAKES_HTTP_CALL ←
  CALLS ← CONTAINS ← RENDERS ← ROUTES_TO`, with the same weakest-link classification. Reports gain a *Frontend
  consumers* section (routes, HTTP call sites, components), routes join the entry points, risk `R-UI-CONSUMERS`,
  regression candidates `UI_COMPONENT` / `UI_E2E`, and existing specs that import an affected component (always
  POTENTIAL: an import does not prove the call is exercised; specs that only import the shared service are not counted).
* **Explorer**: *Screens* tab (routes, HTTP calls with link status), `Screens (UI → API)` preset, UI kind colours,
  editor links and source excerpts routed to the right repository.

Results at Core `671715e6cb` + UI `0574a567e6`: 922 UI files, 670 components, 16,970 functions, 28 routes, 11 specs;
792 HTTP call sites, 476 with fully literal URLs; **741 linked** (740 unique, 1 ambiguous), 35 without any Core
endpoint (e.g. `chart/saveDashboardTemplate`, `dataForge/checkNodeStructureImpact` — candidates for dead UI code or
missing backend), 5 method mismatches (e.g. `DELETE api/processFlow/activity' + activityId` — missing `/`), 4 to the
AI service, 7 with runtime-only URLs. Verification (`workspace/graphs/verify-ui.txt`): all 49,220 UI evidence
citations checked against the source at the UI commit; 49,202 pass the automatic check, the remaining 18 build the URL
from an imported prefix (`API_URL`, `baseUrl()`) and were confirmed by hand. Both repositories' `git status` unchanged.

## Phase 4 (slice 2): change-based impact

Impact of what a branch, commit, range or the working tree changes, across Core and UI:

```bash
cd server
npm run impact -- --changes --core bug/JP-10455 --title JP-10455                 # Core branch only; UI as it is
npm run impact -- --changes --ui bug/JP-123                                      # UI branch only; Core as it is
npm run impact -- --changes --core bug/JP-123 --ui bug/JP-123 --out ../workspace/bundles/JP-123
npm run impact -- --changes --core working                                       # uncommitted changes
npm run impact -- --changes --core 6c95199529                                    # one commit
npm run impact -- --changes --core origin/master...origin/bug/JP-123             # explicit base...head
```

* **Specs** per repository (`--core`, `--ui`; leave one out and that repository is taken as in the current
  snapshot): a branch (local or remote; `bug/X` also finds `origin/bug/X`), a commit (against its first parent),
  `A..B`, `A...B`, or `working` (tracked and untracked changes against HEAD).
* **Base of a branch** is chosen automatically and always reported: among the default branch (`origin/HEAD`:
  `master` in Core, `main` in UI) and the 40 most recent `origin/build/*`, `origin/release/*`, `origin/develop`
  branches, the one that leaves the branch the fewest commits of its own. Branches that were already merged are
  handled: the base is the first parent of the merge that brought them in. Override with `--core-base` / `--ui-base`.
* **Graphs** of base and head are built read-only (`--commit`, `--mode WORKTREE`) into
  `workspace/graphs/cache/` and reused next time; any existing whole-repository graph of the same commit under
  `workspace/graphs/` is reused too. A Core commit takes about 3 minutes, a UI commit seconds. Base and head system
  snapshots go to `workspace/jci-changes.db` (separate from `jci.db`), with UI → API links recomputed on each side.
* **Changed lines → declarations** on both sides (methods, UI functions, routes, tables, procedures, config keys,
  tests; else the enclosing type, or the component for template edits): MODIFIED / ADDED / REMOVED /
  SIGNATURE_CHANGED. Contract differences between base and head: endpoints removed, moved or with changed
  request/response/security, fields and columns added/removed/retyped, calls added/removed by modified code, and UI
  calls that lose their endpoint (`R-CHANGE-UI-LINK-LOST`).
* **Impact** is computed for everything that existed before the change, on the base graph (its dependents are what can
  break); for pure additions on the head graph. The bundle adds a *Change set* section, `change.json` and
  `change.diff` (redacted). Lines outside every declaration, files outside the analysed roots, a working-tree head and
  commits mentioning several tickets are listed as unknowns.

Trial `bug/JP-10455` (already merged): base `75931b01d8` chosen automatically ("already merged into origin/master by
6a846e56f9"), the single fix commit `2f25e8f9` (`queryCount > 0` → `StringUtils.isNotBlank(sb)` before
`UNION ALL`) mapped to `SubDataActionCalculationUtil.formAutoJournalQuery()`. Its callers reach 4 confirmed
endpoints at depth 9–10 (`POST /api/sheet/impactedRecordsCount`, `POST /activity/saveReportData`,
`POST /api/snippets/controlReport/{board,details}`) and 2 UI routes (potential, via dynamic components). First run
about 4 minutes (two Core indexes + loads), later runs about 6 s from the cache. This trial is why `--changes`
searches upstream to depth 16 by default: at the general default of 8 it found no entry point at all, and the
entry-points gate now reports MISSING when nothing is found but paths continue beyond the depth limit.

## Known limitations (after Phase 4 slice 2)

* Root cause, fix scope and verification remain human judgements; the tool ranks evidence and never concludes.
* Excel add-in and other clients are not indexed; their calls into Core are invisible.
* UI: no type checking of JS (calls through untyped parameters, `$refs`, event buses, `provide/inject`, mixin
  methods called from templates of other components, and `this.$router.push` navigation are not edges). 34,013
  call sites stay unbound (mostly library/DOM calls). Dynamic `<component :is>` gives AMBIGUOUS renders only.
  Routes are matched to screens by component; route guards and child routes declared outside `routes.js` are not.
* UI→API links are textual: runtime base URLs other than the configured `--core-base`, URLs built from server
  responses, and payload compatibility (field names in request/response bodies) are not checked.
* Change analysis maps lines to declarations, not to behaviour: a change inside a method is "the method changed";
  which branch of it changed is in `change.diff`. Moved code without edits shows as REMOVED + ADDED. The automatic base
  is a heuristic (closest integration branch); check the listed commits, or pass `--core-base` / `--ui-base`.
* Impact of *what* changes (e.g. which DTO field) is not distinguished: a type change is assessed as a whole.
* **Index the whole repository** (no `--include`) for reverse questions; with `--include`, call sites outside the
  scope are not extracted and their callers are invisible.
* No classpath: 5,880 call sites have no resolvable receiver type (calls on library types reached through chains);
  4 overload choices stay AMBIGUOUS when argument types are library types. `--classpath-file` exists, but running
  `mvn dependency:build-classpath` against the target needs separate approval.
* SQL: 235 statements remain UNRESOLVED (loops, parameters, >4 conditional branch groups); table-level only, no
  column-level SQL dependencies. Migration DDL applied inside stored procedures is not interpreted (tables flagged).
* Datasource routing (multi-tenant `MultiRoutingDataSource`) is runtime: edges name tables, not which database.
* Security: URL rules only. Casbin `enforce` checks inside services are runtime policy and not modelled per endpoint.
* Lambdas implementing in-source functional interfaces are not dispatch candidates; `@Builder` is not synthesized.
* Exception-to-handler matching uses in-source EXTENDS chains; for JDK exceptions caught only by a generic
  `Exception` handler it assumes the JDK hierarchy and reports "PROBABLY". Unchecked exceptions that are not thrown
  explicitly (e.g. NPEs, as in JP-10636) are not modelled.
* No tests exist in JustPerform-Core, so backend TESTS edges are empty; UI spec coverage is reported as potential only.
* Single-user local tool: API binds to 127.0.0.1 with no authentication.
