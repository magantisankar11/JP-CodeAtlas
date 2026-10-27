# CodeAtlas — Existing Implementation Audit

**Audited system:** `C:\Users\Maganti.Gowrisankar\projects\java-code-intel` (package name `java-code-intel`; "CodeAtlas" in this report)
**Target repositories:** JustPerform-Core `671715e6cb` (local HEAD), JustPerform-UI `0574a567e6` (local HEAD)
**Date:** 2026-10-26 · **Mode:** read-only. No source, configuration or dependency was changed. All test artefacts of this audit were written to a temporary scratchpad. This report is the only file created.

---

## 1. Executive summary

CodeAtlas is a working, evidence-first code intelligence platform:

- **Java analyzer:** Spoon/JDT, about 6.5k lines.
- **Vue/JS analyzer:** TypeScript compiler API, about 1k lines.
- **Server:** Node/Fastify with SQLite storage, a REST API, the impact engine, change analysis and context export, about 3.9k lines.
- **Explorer:** React Flow + ELK, about 1.3k lines.
- **Skill:** a user-level BMAD defect-impact skill.

Every test suite passes when executed. 17 of 18 end-to-end checks passed on the fixtures; the 18th, freshness through the API, is partial. Graph content was traced back to the exact source lines it cites.

**Prompt 1 (code intelligence, flow explorer, impact analyzer)** is **substantially complete**. There is one material analysis gap: **Spring Data JPA repositories** (`JpaRepository` interfaces and derived queries) never reach the tables they read and write.

**Prompt 2 (JSON graph, React Flow UI, search, visualisation)** is **largely complete**. It does not need to be executed again; a few targeted UI gaps remain (§10).

**Prompt 3 (Git-based continuous synchronisation)** is **mostly missing**:
- **Already in place:** commit-versioned snapshots, a per-commit graph cache, a CLI freshness check, and change-based impact on branches.
- **Missing:** automatic synchronisation, freshness in the API/UI, incremental re-indexing, snapshot retention and remote/branch tracking.

Prompt 3 is the right next milestone. It can reuse most of what slice 2 (change analysis) built.

**Most important risks:**
1. The loopback API accepts any `Host` header, so a malicious web page could read source code through **DNS rebinding** (verified: a forged `Host` returned 200 on a source read).
2. Storage grows without bound (≈ 2.7 GB in `workspace/`, a 512 MB un-checkpointed WAL, no pruning).
3. The **tool itself is not under version control** (`java-code-intel` is not a git repository).
4. The root `npm test` skips the Java and UI analyzer tests, and there is no CI or lint.

---

## 2. Scope and method

- **Inspected:** every module's source, the API routes, the data contract (`schemas/graph-v1.schema.json`, `server/src/contract.ts`), tests, fixtures, the stored databases and the workspace contents.
- **Executed:**
  - all test suites and type checks (§4.1);
  - an 18-check end-to-end script on the fixtures (§4.2) that re-indexes the fixture, calls the API in-process, verifies citations against source, and creates a throwaway git copy of the fixture for change and versioning checks;
  - a live check of the running explorer against the loaded system snapshot;
  - read-only queries against `workspace/jci.db` and `workspace/jci-changes.db`.
- **Not re-executed:** full-repository verification on JustPerform-Core and UI. Its results come from earlier runs (`workspace/graphs/verify-full.txt`, `verify-ui.txt`) and are marked as such.
- **Requirement texts:** the original Prompt 2 and Prompt 3 texts were not supplied to this audit. They are evaluated from their titles and from the capability list in the audit request. Findings marked *(inferred)* depend on that interpretation.

---

## 3. Feature coverage matrix

Status: **Complete** = implemented and verified in this audit · **Partial** = works with a stated gap · **Missing** · **Unverified** = present but not proven in this audit.

### 3.1 Prompt 1 — Java Code Intelligence, API Flow Explorer & Impact Analyzer

| Requirement | Status | Implementation | Evidence | Missing / limitation | Next action |
|---|---|---|---|---|---|
| Repository scanning & framework detection | Partial | `analyzer-java/.../source/SourceSet.java`, `spoon/TypeExtractor.java`, `TypeIndex.java` | Fixture: 172 nodes / 284 edges, contract-valid (E2E 1). Core: 1,522 files parsed (README Phase 2) | Spring only: no JAX-RS (`@Path`), Micronaut or Quarkus. No build-file (Maven module) detection; one source root per run | Accept for JustPerform (it has 0 `@Path` usages); add a module list if multi-module repos appear |
| API endpoint discovery | Complete | `spoon/EndpointExtractor.java` | E2E 2b: all 6 fixture endpoints, incl. multi-path mapping; Core 1,089 endpoints | Class-level `{var}` prefixes resolved; endpoints registered programmatically are not | — |
| Controller → Service → Repository flow | Complete | `spoon/CallGraphExtractor.java`, `server/src/query.ts` (`traverse`) | E2E 3: endpoint → controller → service impl → DAO impl → SQL → table | — | — |
| Helper & shared dependency resolution | Complete | `CallGraphExtractor.java` (static, lambda lexical scope, Lombok), `impact/engine.ts` (`sharedUtilities`) | Golden tests; shared-utility rule in `impact.test.ts` | 5,880 Core call sites with unknown receiver (no classpath) | Optional classpath (`--classpath-file`) needs approval to run Maven |
| Interface implementations & DI | Complete | `TypeIndex.java`, `CallGraphExtractor.java` (CHA, `@Qualifier`, `@Primary`, `@Bean` factories) | Golden tests; "interface hops collapsed" API test; ambiguous dispatch stays AMBIGUOUS | — | — |
| DTO and entity relationships | Complete | `ContractExtractor.java`, `EntityMapper.java` | ACCEPTS/RETURNS/HAS_FIELD_TYPE/MAPS_TO in golden file; "nested DTO via enclosing type" test | Field-level impact not distinguished (a type change is assessed as a whole) | — |
| Database queries & stored procedures | **Partial** | `SqlExtractor.java`, `sql/SchemaCatalog.java`, `DatabaseNodes.java` | E2E 4: table → 3 endpoints, matching the hand-written expectation; runtime table names correctly UNRESOLVED | **Spring Data JPA repositories are not modelled.** `BackupRepository extends JpaRepository` is a plain INTERFACE; `findByBackupId` and inherited `save`/`delete` have no table edges (6 such repositories in Core). 235 Core SQL statements UNRESOLVED. Table-level only, not column-level | **P1:** derived-query and `JpaRepository<Entity,…>` → entity → table edges (FRAMEWORK_DERIVED) |
| External API & event dependencies | Complete | `ExternalExtractor.java` (Feign, RestTemplate, WebClient, SDK), `EntryPointExtractor.java` (`@EventListener`, publisher, Kafka/Rabbit/JMS listeners, `@Scheduled`, JobRunr) | Golden fixture covers Feign, S3, JobRunr, events | Message-listener code paths untested on Core (0 usages there) | — |
| Forward & reverse traversal | Complete | `query.ts` `traverse`, `reach`; presets | E2E 3, 4, 4b; 17 API tests incl. cycles, truncation, evidence strength | Depth cap 10 in the API (`MAX_DEPTH`); impact engine cap 16 | Expose 16 in the API for parity |
| JSON graph generation & persistence | Complete | `schemas/graph-v1.schema.json`, `contract.ts`, `loader.ts`, `db.ts` | E2E 1: loader validates every record and every edge endpoint; committed test data identical to a fresh run (E2E 1b) | No JSON-Schema validator run in CI (zod mirrors the schema by hand). Additive v1.0 → 1.2 so far | Add a schema conformance test |
| Evidence & source line references | Complete | `graph/Evidence.java`, `source.ts` (`excerpt`, `readAtCommit`) | E2E 5: 110/110 declarations cite their name, 285/285 evidence lines in range; previous full-repo runs: 91,963 Core call sites, 49,220 UI citations verified | Lombok accessors cite the field (documented) | — |
| Change impact analysis | Complete | `impact/engine.ts`, `changes/*` | E2E 6, 8b; JP-10636 and JP-10455 trials | Declaration-level, not statement-level; default depth 8 can miss deep entry points (`--changes` uses 16; the gate flags it) | Raise the default for `--target` runs too, or warn more visibly |
| Regression test identification | Partial | `engine.ts` `buildCandidates`, UI spec detection | Candidates produced; UI specs flagged as potential coverage | JustPerform-Core has no tests, so no existing backend coverage can be shown; candidates are suggestions only | — |
| Claude Code context export | Complete | `impact/bundle.ts`, `cli/impact.ts`, `/export/context` | E2E 7: 7/7 excerpts identical to source at the snapshot commit; no secret leakage | — | — |
| BMAD integration | Partial | `~/.claude/skills/jci-defect-impact-analysis/` (user level), `config/closure-gates.yaml` | Skill workflow, gates and hand-offs to `bmad-investigate` / `bmad-quick-dev` documented | No BMAD module/agent in the project; skill behaviour is not tested automatically | Keep user-level; optionally package as a BMAD module later |
| Endpoint, class & method search | Complete | `query.ts` `search` (FTS5, camelCase splitting, name bonus) | E2E 2 | — | — |

### 3.2 Prompt 2 — JSON-based React Flow UI, Search & Dependency Visualisation *(inferred)*

| Requirement | Status | Implementation | Evidence | Missing / limitation | Next action |
|---|---|---|---|---|---|
| JSON graph served to the UI | Complete | `app.ts` `/graph`, `/node`, `/reach`, `/catalog` | E2E 3–4b, API tests | Versioned under `/api/v1` | — |
| React Flow visualisation with layout | Complete *(edge drawing unverified here)* | `web/src/components/GraphView.tsx`, `layout.ts` (ELK) | Live check: endpoint selected → 2 nodes, banner "1 edge" | The browser pane was hidden, so edge SVGs were not drawn and could not be checked visually in this audit | Visual re-check with the pane visible |
| Search & catalog tabs | Complete | `SearchPanel.tsx` (endpoints, screens, jobs & events, data, integrations, types, config, defect) | Live check: lists populated from the system snapshot | — | — |
| Node expansion & filters | Complete | `App.tsx` (`expand`, presets, depth, min resolution, accessors, interface hops, node limit) | API truncation/`hasMore` tests | — | — |
| Source navigation | Complete | `DetailsPanel.tsx` (commit-pinned excerpt, VS Code link per repository) | E2E 5b | The VS Code link opens the working tree, which may differ (stated in the tooltip) | — |
| Missing / stale / unresolved data in the UI | **Partial** | Error states in all panels; UNRESOLVED nodes explained; truncation banners | E2E 10: API returns 404/400 cleanly | **No staleness indicator:** the UI never says the snapshot is behind HEAD. No React error boundary, so one render error blanks the app. No UI tests | **P1:** freshness badge; error boundary; small Playwright smoke test |
| Multi-repository view (UI + Core) | Complete | `locateFile`, Screens tab, `ui` preset | Live check: system snapshot selectable | — | — |

### 3.3 Prompt 3 — Git-based Continuous Graph Synchronisation & Maintenance *(inferred)*

| Requirement | Status | Implementation | Evidence | Missing / limitation | Next action |
|---|---|---|---|---|---|
| Git commit-based graph versioning | Complete | Snapshot key `repo + commit + scope + source mode` (`loader.ts`); `--commit` in both analyzers | E2E 9: snapshot SHA = `git rev-parse` for HEAD and `--commit` graphs | Single-repo snapshots and system snapshots are separate rows; no "current" pointer per repository | Add a `current` flag or table per repo/branch |
| Graph freshness detection | **Partial** | `npm run impact -- --status` (per repository: snapshot commit vs local HEAD) | E2E 10b: `/health` reports no freshness; nothing in the UI | Compares with the **local** HEAD only, not the remote default branch (local Core HEAD `671715e6cb` vs `origin/master` `96e2258d96`). Uncommitted changes are not detected | **P1:** `/api/v1/freshness` + UI badge; compare HEAD, `origin/<default>` and dirty state |
| Automatic graph synchronisation | **Missing** | — | No watcher, hook, schedule or sync command (grep across all modules) | Re-indexing is manual: analyze → combine → load | **P1:** `npm run sync` (detect → index changed repo(s) → combine → load → prune), optionally scheduled |
| Incremental indexing | Missing | — | Every run re-parses the whole repository (≈ 100 s for Core) | Per-commit cache exists (`changes/index.ts`) but is whole-graph | P2: start with "skip if commit already indexed"; true incremental is a larger design |
| Change-based impact on branches / working tree | Complete | `changes/git.ts`, `changeset.ts`, `run.ts`, `index.ts` | E2E 8, 8b, 8c; 5 tests in `changes.test.ts`; JP-10455 trial | Base selection is heuristic (reported, overridable) | — |
| Snapshot retention & cleanup | Missing | — | `jci-changes.db` keeps every base/head pair (2 × 65k nodes per change); 2.7 GB workspace | No pruning, VACUUM or WAL checkpoint | **P1:** retention policy + `npm run prune` |
| Support for feature development & enhancements | Partial | `--changes --core working`, branch analysis | E2E 8b | No "where would a new feature plug in" view (e.g. similar endpoints, extension points) | P3 |

---

## 4. End-to-end verification (executed in this audit)

### 4.1 Test suites

| Suite | Command | Result |
|---|---|---|
| Java analyzer | `mvn -B -o -q test` (JDK 26, `--release 21`) | **Pass:** 17 tests (GoldenFixtureTest 10, UnitTest 7). An extra `DebugProbeTest` report in `target/surefire-reports/` is stale: its source no longer exists |
| Server | `npm test` in `server/` | **Pass:** 50/50 (api 17, impact 8, defect 3, bundle 1, impact API 1, loader 4, stitch 11, changes 5) |
| UI analyzer | `npm test` in `analyzer-ui/` | **Pass:** 5/5 |
| Type checks | `tsc --noEmit` in server, web, analyzer-ui | **Pass:** no errors |
| Lint | — | **Not available:** no linter configured |

### 4.2 The ten requested behaviours

| # | Behaviour | Result | What was executed and observed |
|---|---|---|---|
| 1 | Indexing generates valid JSON | **Pass** | Fresh analyzer run on `fixtures/simple-rest` → 172 nodes, 284 edges, schema 1.1.0; every record passed the loader's zod contract and the referential check. The committed `server/test/data/simple-rest.ndjson` is identical to the fresh run (no stale test data) |
| 2 | Search returns correct endpoints and symbols | **Pass** | `OrderController` → controller first; `getOrder` → 3 methods; `t_order` → table first; `/endpoints` lists all 6 |
| 3 | Endpoint shows its dependency graph | **Pass** | `GET /api/orders/{orderId}` forward depth 6: endpoint → `OrderServiceImpl#getOrder` → `OrderDaoImpl#findById` → SQL → table |
| 4 | Forward and reverse traversal correct | **Pass** | `t_order` reverse → exactly the 3 endpoints of the hand-written expectation. `GET /search` correctly does *not* reach it: its SQL uses the runtime table name `<tenant>_orders` (UNRESOLVED). My initial "≥ 4" criterion was wrong and was corrected against the source |
| 5 | Nodes reference actual source | **Pass** | 110/110 declarations contain their name in the cited range; 285/285 evidence lines exist; the source API serves indexed files only (unindexed 404, path escape 404) |
| 6 | Impact identifies relevant dependencies | **Pass** | `OrderDaoImpl#findById` → entry points `GET /api/orders/{orderId}` and job `CheckoutService.reconcile()`, table `t_order`, 3 risks, 4 test candidates |
| 7 | Context export is traceable | **Pass** | 7/7 excerpts byte-identical to the source at the snapshot commit; commit recorded; the fixture's fake `sk_live` secret absent from every file |
| 8 | Changed source updates the graph | **Pass** | Throwaway git copy: commit adds a `throw` to `getOrder` → head graph has the new THROWS edge, base graph does not. `--changes` on that branch → `MODIFIED OrderServiceImpl.getOrder()` → entry point `GET /api/orders/{orderId}`; repository status and HEAD unchanged |
| 9 | Snapshots match their git commit | **Pass** | HEAD graph SHA = `rev-parse HEAD`; `--commit` graph SHA = that commit; mode HEAD |
| 10 | Missing, stale and unresolved data handled safely | **Partial** | API: unknown node 404, unknown snapshot 404, invalid depth 400, confirmed-only filter works. UI shows errors and truncation. **Stale data is not surfaced anywhere in the API or UI** (CLI only) |

---

## 5. Working functionality (verified)

- Read-only indexing of Java (Spoon) and Vue/JS (TypeScript API). Sources are read from git objects at a commit, and `git status` is checked before and after (E2E 8c, previous full runs).
- A versioned graph contract (v1.0 → 1.2, additive only), validated on load.
- Four evidence levels on every edge, using a weakest-link path rule and the classifications Confirmed / Potential / Unknown, with no numeric scores.
- The REST API (14 routes), FTS search, bounded traversal, reach and catalog.
- The explorer: search tabs, presets, expansion, filters, details, commit-pinned source, editor links, JSON export, and impact and defect panels.
- The impact engine:
  - entry points, callers, downstream calls, tables, contracts, errors and security;
  - UI consumers, risks, unknowns and regression candidates;
  - closure gates that never claim human gates.
- Defect matching from ticket text and stack traces; context bundles with redaction.
- UI → Core linking. 741 of 792 real UI HTTP calls were linked in an earlier run; unlinked calls become diagnostics, never edges.
- Change-based impact on branches, commits, ranges and the working tree, with automatic base selection, merged-branch handling, contract differences and lost UI links.

---

## 6. Missing functionality

1. **Spring Data JPA repositories → tables** (derived queries, inherited CRUD, `@Query` if introduced).
2. **Freshness in the API and UI**: comparison with the remote default branch and dirty-state detection.
3. **Automatic synchronisation**: a sync command, optional schedule/hook, re-combine and reload.
4. **Snapshot retention and storage maintenance**: pruning, `VACUUM`, WAL checkpoint.
5. **Incremental indexing** (beyond the per-commit cache).
6. **UI error boundary and UI tests**: no browser test exists.
7. **Unified test entry point / CI**: the root `npm test` runs only the server tests and the web type check.
8. *(Lower)* Non-Spring frameworks; multi-module scanning; column-level SQL dependencies; Excel add-in client.

---

## 7. Architecture evaluation

| Area | Finding | Evidence | Recommendation |
|---|---|---|---|
| **Security** | API accepts any `Host` header: **DNS-rebinding exposure** of source code and graph | `curl -H "Host: attacker.example" …/api/v1/source?…` → 200 | **P0:** reject requests whose `Host` is not `127.0.0.1:4317` / `localhost:4317` (Fastify `onRequest` hook); also check `Origin` on POST |
| Security | No authentication (documented single-user tool); redaction is regex-based | `source.ts` `PATTERNS`, `Redactor.java` | Keep, but add tests for more secret shapes (connection strings, `Bearer`) |
| **Version control** | The tool itself is **not a git repository**; there is no history or rollback for about 13k lines | `git rev-parse` fails in `java-code-intel` | **P0 (owner decision):** `git init` locally, with no remote and nothing pushed; consistent with "local only" |
| Duplicate functionality | git invocation in 7 places; redaction in 2 (Java + TS); snapshot-line reading in 2; kind sets repeated in `engine.ts`, `changeset.ts`, `theme.ts`; URL display in 3 | `analyzer-ui/src/source.ts`, `server/src/source.ts`, `changes/git.ts`, `impact/defect.ts`, `cli/impact.ts`, `scripts/verify-edges.mjs`, `source/Git.java` | P2: one `server/src/git.ts`; a shared `kinds.ts`; keep the Java/TS redactors but test them against the same corpus |
| Unnecessary dependencies | `javaparser-symbol-solver-core` is only used by the Phase-0 engine bake-off (`probe`); it inflates the shaded jar | `probe/EngineProbe.java`, `cli/Main.java` | P3: move `probe` to a separate profile or drop it |
| Hardcoded demo data | None in source. Machine-specific JDK discovery (`~/.jdks`) and absolute paths in the user-level skill are intentional | grep for user paths: none in source | — |
| Incorrect relationships | None found in this audit (fixture: 0 mismatches). Known *missing* relationships: Spring Data repositories; runtime SQL/URLs (correctly UNRESOLVED) | E2E 4, 5 | P1 (Spring Data) |
| Performance | First change analysis ≈ 4 min (two Core indexes); system load ≈ 17 s per snapshot; later runs ≈ 6 s from cache. Catalog loads up to 20,000 rows per request | JP-10455 trial; `query.ts` `catalog` | Acceptable for one user. P2: page the catalog; index the cache |
| Storage | `workspace/` ≈ 2.7 GB: `jci.db` 468 MB plus a **512 MB WAL**, `jci-changes.db` 496 MB (one base/head pair), graphs 1 GB incl. duplicates (system graph also cached) | `du`, snapshot listing | **P1:** retention + `wal_checkpoint(TRUNCATE)` + `VACUUM`; delete graphs that a combined graph supersedes |
| Stale references | Obsolete artefacts: `justperform-core-snippets.ndjson` (schema 1.0.0), `justperform-core-prefix-JP-10636.ndjson` and `jci-trial-prefix.db` (trial at `bf0135c3`), `workspace/graphs/simple-ui.ndjson`, stale surefire report, empty `.partial/` and `*.err` files | Directory listing | P2: a `prune` command; label trial artefacts |
| Error handling | Server: zod-validated parameters, 4xx on bad input. Web: per-panel error text, but **no error boundary**. CLI: change analysis reports errors with exit code 2; partial index outputs go to `.partial/` | `app.ts`, `App.tsx`, `changes/index.ts` | P1: React error boundary |
| Test coverage gaps | No UI (browser) tests; no automated test of Java-side `--changes` (verified only in this audit's E2E 8b); no schema-conformance test; root `npm test` incomplete | §4.1 | P1: wire all suites into the root `npm test`; add the E2E 8b case as a server test gated on the jar |
| Maintenance complexity | Moderate. Largest files: `analyze.ts` 770 lines, `engine.ts` 677, `CallGraphExtractor.java` 613. ADRs exist for the parser engine and inference rules only | File sizes; `docs/decisions/` | P2: ADRs for multi-repo stitching and change analysis; split `engine.ts` (UI pass, risks, candidates) |

---

## 8. Technical risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| DNS rebinding reads source via the loopback API | Low–medium (needs a malicious page while the server runs) | High (proprietary source) | Host/Origin allow-list (P0) |
| Loss of the tool's code (no VCS) | Medium | High | Local `git init` (P0, owner decision) |
| Users trust a stale graph | High (no freshness indicator; local HEAD already behind `origin/master`) | Medium–high (wrong impact) | Freshness API/UI + sync (P1) |
| Missing DB edges for Spring Data repositories make impact look smaller | Medium (6 repositories in Core) | Medium | Spring Data modelling (P1) |
| Disk growth from change analysis | High (≈ 250 MB per analysed change pair) | Medium | Retention / prune (P1) |
| "No impact found" when entry points are deeper than the default depth | Medium | Medium | `--changes` already uses 16 and the gate reports MISSING; apply the same to `--target` (P2) |
| Silent mis-indexing on unusual paths | Low (one Windows 8.3-path bug found and fixed during slice 2) | High | Keep the "fail loudly on `--commit` without git" rule; add a regression test (P2) |

---

## 9. Prioritised improvements

| Priority | Item | Size | Reuses |
|---|---|---|---|
| P0 | Host/Origin allow-list on the API | S | `app.ts` |
| P0 | Put `java-code-intel` under local git (owner decision; no remote) | S | — |
| P1 | Freshness service: `/api/v1/freshness` (per repo: snapshot commit, local HEAD, `origin/<default>`, dirty, commits behind) + UI badge | M | `cli/impact.ts --status`, `changes/git.ts` (`defaultBranch`) |
| P1 | `npm run sync`: detect changed repos → index (cache) → combine → load → mark current → prune; optional schedule | M | `changes/index.ts` (`ensureGraph`), `multi/combine.ts`, `loader.ts` |
| P1 | Retention: keep N snapshots per repo and the latest per branch; checkpoint/VACUUM; clean `.partial/` | S | `db.ts` |
| P1 | Spring Data JPA: repository → entity → table edges, derived-query operation, inherited CRUD | M | `EntityMapper.java`, `TypeIndex.java` |
| P1 | Root `npm test` runs all suites; React error boundary; one browser smoke test | S–M | existing suites |
| P2 | Consolidate git helpers and kind sets; ADRs for stitching and change analysis | S | — |
| P2 | API depth parity (16) and a depth warning for `--target` runs | S | `query.ts`, `engine.ts` |
| P2 | Paged catalog; clean up stale artefacts | S | — |
| P3 | Incremental indexing; feature-planning view; non-Spring frameworks; Excel add-in | L | — |

---

## 10. Does Prompt 2 still need execution?

**No, not as a whole.** Its core is in place and verified: JSON graph API, React Flow + ELK, search and catalog, expansion, filters, details, source navigation and export. Re-running it would duplicate working code. Execute only these deltas:

1. a freshness/staleness badge;
2. a React error boundary;
3. a browser smoke test;
4. a visual re-check of edge rendering with the pane visible (unverified in this audit).

## 11. Does Prompt 3 still need execution?

**Yes, scoped.** Already done, so don't rebuild:
- commit-versioned snapshots;
- the per-commit graph cache and analyzer runner (`changes/index.ts`);
- read-only git helpers (`changes/git.ts`);
- change-based impact.

Still to do: freshness in the API and UI, the sync workflow, retention, and (later) incremental indexing.

## 12. Should existing components be reused?

**Yes, all of them.** No component needs replacing. Specifically, reuse:
- `changes/index.ts` for sync indexing;
- `changes/git.ts` for freshness (`defaultBranch`, commit counting);
- `multi/combine.ts` and `loader.ts` (replace semantics) for refreshing the system snapshot;
- the existing API envelope (`snapshot {id, repoId, commitSha}`) for the freshness endpoint.

Keep the contract additive within v1 (new fields only). Keep the CLI flags backward compatible.

## 13. Recommended next development milestone

**Milestone: "Trustworthy and current graphs"**

1. **Security & hygiene (P0):** Host/Origin allow-list; local git for the tool.
2. **Freshness (P1):** API endpoint and UI badge covering local HEAD, remote default branch and dirty state.
3. **Sync (P1):** `npm run sync` with cache reuse, re-combine, load, a current-snapshot marker and retention/prune.
4. **Coverage (P1):** Spring Data JPA repository → table edges.
5. **Quality gate (P1):** one root `npm test` for all suites, the error boundary and a browser smoke test.

**Exit criteria:**
- The UI shows when a snapshot is behind.
- One command brings both repositories' graphs up to date and removes superseded data.
- Repository calls reach their tables.
- All suites run from one command.
- A forged `Host` header is rejected.
