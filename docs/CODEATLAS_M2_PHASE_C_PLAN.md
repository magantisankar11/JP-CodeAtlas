# Milestone 2 — Phase C plan: automatic graph synchronization (`npm run sync`)

**Status:** implemented and verified (2026-10-27), with the four defaults approved; see Results.
**Prerequisites:** Phase A and Phase B are accepted.

**Goal:** one command brings the published graph up to date with the selected source revisions. It reuses commit-indexed graphs where they are still valid and re-indexes only the repositories that changed. It recombines Core and UI, validates the result and loads it, then publishes it as current in one step. If anything fails, the previous snapshot stays current.

**Out of scope:**
- Incremental parsing: a changed repository is re-indexed in full, as instructed.
- Fetching from a remote.
- Working-tree snapshots.
- Retention and pruning of old snapshots (Phase E).

## How things work today

| Area | Today | Consequence for sync |
|---|---|---|
| Which snapshot is "current" | `resolveSnapshot` and the web pick the **highest id** (`query.ts:58`, `App.tsx:53`) | Loading a snapshot is the same as publishing it, so a graph that is loaded but not yet validated would be served at once. |
| Loader | `loadNdjson` checks every record against the contract, the schema major version and dangling edges before inserting, all in one transaction (`loader.ts`). If the same repo, commit, scope and mode is reloaded, the earlier row is **deleted** and replaced. | Schema and reference validation can be reused. However, the replace path could delete the snapshot that is currently published. |
| Graph reuse | `ensureGraph` / `findGraph` (`changes/index.ts`) reuse an NDJSON file for the same repo and commit if it was built from a commit (HEAD mode) and covers the whole repository. Indexing is read-only (`--commit`) and goes through `.partial/`, then a rename. | Reuse can stay as it is. It still needs analyzer-version and truncation checks. |
| Combine | `combineGraphs` (`multi/combine.ts`) is deterministic for the same component files. `changes/run.ts` already caches `system-<core12>-<ui12>.ndjson`. | The same cache name and reuse rule apply. |
| Repository config | None. Repository paths live only in each snapshot's `scope.repos` and in the README and skill commands. | Repositories must be detected or configured. |
| Analyzer version | Recorded in each graph (`analyzerVersion`: Java `0.2.0`, UI `ui-0.1.0`). The jar can't be asked for its version. | Without that, a graph made by an older analyzer can't be recognised and would be reused. |

### Conflicts with the current architecture, and how this plan resolves them

- **K1 — no notion of "current".**
  - Add a published-snapshot pointer for each repoId, plus a PENDING state for snapshots that sync has loaded but not yet published.
  - Compatibility: if a repoId has no pointer, resolution falls back to the highest id, which is today's behaviour. `npm run load` keeps making the snapshot it loads current (it publishes by default).
- **K2 — the loader's replace path.**
  - When the row being replaced is the published one, the pointer moves to the new row in the same transaction.
  - Sync never triggers a replace: an identical snapshot that is already loaded is reused as it is.
- **K3 — no repository config.**
  - `config/repos.yaml` is optional. Without it, the repositories are detected from the current system snapshot's `scope.repos`.
- **K4 — the analyzer version can't be queried.**
  - Add a `version` subcommand to the Java analyzer (one line) and move the UI analyzer's version into its own module.
  - Changing the Java analyzer means rebuilding the jar.
- **K5 — staging inside the live database vs a separate file.**
  - I considered loading into a temporary database and swapping files.
  - I rejected it for two reasons. On Windows the running API server holds `jci.db` open, so the rename fails. A swap would also have to copy every other snapshot.
  - Instead, PENDING rows are hidden from every reader, and publishing flips the pointer in a single SQLite transaction (WAL mode, so readers see either the old snapshot or the new one).
- **K6 — cleaning up a failed or interrupted run deletes rows.**
  - Only PENDING rows that sync created itself and never published are deleted. Published or loaded snapshots, graph files and source repositories are never deleted.
  - This is a planned deletion, so it's listed here for your approval.
- **K7 — the open web UI keeps its selected snapshot after a publish.**
  - New sessions default to the current snapshot.
  - Open sessions get the existing "Switch to snapshot N" hint from Phase B, because the new snapshot matches the selected commits.
- **K8 — Phase B rules.**
  - Sync indexes committed revisions only (default HEAD of each repository) and never fetches. Core is therefore published at the local HEAD and will still show "branch BEHIND origin"; that is correct.
  - Uncommitted source changes produce a warning, as in Phase B, and are never indexed into a published snapshot.

## Workflow

These map to the 10 steps in the brief. Each step's outcome goes into the report.

1. **Detect repositories** (`sync/config.ts`).
   - Source: `config/repos.yaml` (validated with zod), otherwise the current system snapshot's `scope.repos`. The mapping is role backend → java and frontend → ui; the id, path and role are kept.
   - Each path must exist and be a git work tree. If neither source is available, the run stops with exit 2 and explains how to configure the repositories.
2. **Resolve revisions.**
   - The revision is `--rev <repoId>=<ref>` (checked with `safeRev`) or HEAD.
   - It is resolved with `git --no-optional-locks rev-parse --verify <ref>^{commit}`; there is never a fetch.
   - The worktree check reuses the Phase B scope logic, so MODIFIED produces a warning.
3. **Reuse.**
   - The current snapshot is already built from exactly these commits and analyzer versions → **UP_TO_DATE**. Nothing is written, and the exit code is 0.
   - Otherwise, a graph file is reused for each repository when all of these hold:
     - the repo and commit match, the mode is HEAD and there are no `includePackages` (today's rule);
     - the analyzer version equals the installed analyzer's version;
     - the schema major version is supported;
     - the last line parses, so the file is not truncated.
   - `--reindex <repoId|all>` forces re-indexing.
4. **Re-index changed repositories.**
   - Uses `ensureGraph` unchanged: read-only (`git archive` / `--commit`), written to `.partial/` and then renamed.
   - Java takes about 3 min with an 8 GB heap; UI takes about 5 s.
   - If the jar is older than the newest analyzer source file, the run warns; it never builds the jar automatically.
5. **Recombine.**
   - `combineGraphs` writes `cache/system-<core12>-<ui12>.ndjson` via a temporary file and rename, and that file is reused when the components and the stitch version match.
   - Configurations with a single repository skip this step.
6. **Validate** (`sync/validate.ts`).
   - **Before loading:** the loader's existing checks (contract, schema major version, dangling edges, duplicate ids through the primary keys).
   - **After loading the PENDING row:**
     - the commits in `scope.repos` equal the planned commits, and the mode is HEAD;
     - the node, edge and diagnostic counts in the database equal the loader's counts;
     - the number of FTS rows equals the number of searchable nodes;
     - every UI file path carries a prefix declared in `scope.repos`;
     - the backend has at least one `API_ENDPOINT`, and the frontend has at least one `UI_ROUTE` or `UI_COMPONENT`;
     - **shrink guard:** compared with the previous current snapshot, no node kind drops by more than 50% and the number of `CALLS_API` links doesn't fall to zero. The threshold is set with `--max-shrink 0.5`, and `--allow-shrink` overrides the guard. This catches an analyzer that fails silently and produces an almost empty graph;
     - **query smoke test:** a search returns hits, and one traversal from an endpoint returns nodes.
7. **Load** the combined file with `loadNdjson(db, file, { state: 'PENDING' })`.
   - The PENDING row is invisible to the API, the CLI, the web and the freshness snapshot match.
   - If an identical snapshot is already loaded, its row is reused and only steps 6 and 8 run.
8. **Publish atomically.** One transaction upserts `current_snapshots(repo_id → snapshot_id)` and clears the PENDING state. Nothing is published unless every check in step 6 passed.
9. **On failure:**
   - the pointer stays unchanged and the PENDING row is deleted;
   - partial graph files stay in `.partial/`, which is never read;
   - the exit code is 1, and the report names the failed step;
   - orphaned PENDING rows from an interrupted run are deleted at the start of the next sync, while the lock is held.
10. **Report.**
    - Formats: human-readable text, or `--json`.
    - Files: `workspace/sync/last-sync.json`, plus a line appended to `workspace/sync/history.ndjson`.
    - Contents:
      - the outcome (`PUBLISHED`, `UP_TO_DATE`, `FAILED` or `DRY_RUN`);
      - per repository: revision, commit, action (`REUSED`, `INDEXED` or `UNCHANGED`), graph file, analyzer version, duration and reason;
      - combine statistics and the list of validation checks;
      - load counts and duration;
      - publish: previous id → new id;
      - the Phase B freshness of the new snapshot (cached mode);
      - warnings, such as a modified worktree, a stale jar, or a branch behind its upstream.

**Concurrency:**
- `workspace/sync/sync.lock` is created exclusively and holds the pid and start time. A second sync exits with code 3. A lock whose pid is no longer running is taken over, and the report says so.
- The API server can keep running during a sync (SQLite WAL mode).

**CLI:**

```
npm run sync [-- --rev <repoId>=<ref>]... [--reindex <repoId|all>]... [--dry-run] [--json]
             [--db FILE] [--config FILE] [--max-shrink 0.5] [--allow-shrink]
```

- Exit codes: 0 = published or up to date, 1 = failed (the previous snapshot is kept), 2 = usage or config error, 3 = a sync is already running.
- `--dry-run` performs steps 1–3 and reports the plan, writing nothing (not even the report files).
- CI: `git fetch && npm run sync -- --rev justperform-core=<sha>`. The fetch is CI's own step, never sync's.

## Files

### New

| File | Content |
|---|---|
| `server/src/snapshots.ts` | `currentSnapshotId(db, repoId)`, `publishSnapshot(db, id, by)`, `isPending`, `dropPending(db, id)`, `orphanedPending(db)`, plus the SQL fragment `VISIBLE` that hides PENDING rows. |
| `server/src/sync/config.ts` | zod schema for `config/repos.yaml` (`system: {id, coreBases}`, `repos: [{id, kind, path, role}]`) and `detectRepos(db, file?)`. |
| `server/src/sync/run.ts` | `syncGraphs(opts): SyncReport` runs steps 1–10. The indexer, combiner and clock are injectable, so tests can avoid the 3-minute Java run. |
| `server/src/sync/validate.ts` | The checks after loading (step 6). Each check returns `{check, ok, detail}`. |
| `server/src/sync/lock.ts` | Exclusive lock file with detection of locks left by dead processes. |
| `server/src/sync/report.ts` | Text rendering, and the `last-sync.json` / `history.ndjson` writers. |
| `server/src/cli/sync.ts` | Argument parsing, exit codes, and a usage line in the doc comment (same style as `cli/impact.ts`). |
| `config/repos.example.yaml` | Example config for the two JustPerform repositories. The real `config/repos.yaml` is git-ignored because it contains local paths. |
| `server/test/sync.test.ts` | See Tests. |
| `server/test/data/sync/` | Small UI and Java graph fixtures, or ones derived from `simple-rest.ndjson` / `simple-ui.ndjson`, with commits rewritten per test. |

### Changed

| File | Change |
|---|---|
| `server/src/db.ts` | Two tables added with `CREATE TABLE IF NOT EXISTS`, so no migration is needed: `current_snapshots(repo_id PK, snapshot_id FK, published_at, published_by)` and `snapshot_state(snapshot_id PK FK, state CHECK IN ('PENDING'), created_at)`. |
| `server/src/loader.ts` | `loadNdjson(db, file, { repoPath?, state?, publish? })`. A replace moves the pointer when the replaced row was published. Without new options the behaviour is unchanged (no publish). |
| `server/src/query.ts` | `resolveSnapshot` order: explicit id → pointer for the repoId → highest visible id. With no repoId, it prefers the most recently published snapshot. `listSnapshots` hides PENDING rows and adds `current: boolean` (an additive field). |
| `server/src/freshness.ts` | `findMatchingSnapshot` ignores PENDING rows. |
| `server/src/cli/load.ts` | Publishes by default, which keeps today's behaviour in which the snapshot just loaded is current. New flag `--no-publish`. |
| `server/src/cli/impact.ts` | `latestSystem` prefers the published system snapshot. |
| `server/src/changes/index.ts` | `findGraph` / `ensureGraph` gain an optional `accept(snapshotLine)` predicate and a check that the last line is complete. `changes/run.ts` keeps its current behaviour because it passes neither. |
| `analyzer-java/.../Analyzer.java` | A `version` subcommand that prints `VERSION`. The jar is rebuilt with `npm run build:analyzer`. |
| `analyzer-java/src/test/...` | One test for the `version` subcommand. |
| `analyzer-ui/src/version.ts` (new), `src/cli.ts` | `VERSION` moves into its own module so sync can import it without running the CLI. `cli.ts` re-exports it. |
| `server/package.json`, root `package.json` | A `sync` script in both. |
| `web/src/api.ts`, `web/src/App.tsx` | `SnapshotDto.current?`. The default selection becomes the newest current snapshot, which is still `[0]` when no snapshot has been published. The snapshot drop-down marks the current one with "(current)". |
| `README.md` | A "Synchronization" section; the re-index commands are replaced with `npm run sync`. |
| `~/.claude/skills/jci-defect-impact-analysis/SKILL.md` | In step 2, the three-command re-index becomes `npm run sync`, with `--dry-run` first and still asking you before running it. |
| `.gitignore` | Adds `config/repos.yaml`. `workspace/` is already ignored. |

**Not changed:** the analyzer logic, stitch, the impact engine, change analysis, the React Flow UI, the BMAD integration, and the analyzed repositories.

## Tests (`server/test/sync.test.ts`)

Tests use temporary git repositories and an in-memory or temporary database, with injected indexers that copy fixture graphs.

| ID | Case | Expected result |
|---|---|---|
| C1 | `--dry-run` | Plan reported. Database row count unchanged, no graph or report files written. |
| C2 | First sync | Both repositories INDEXED, combined, validated and PUBLISHED. The pointer is set, and `resolveSnapshot(repoId)` returns the new snapshot. |
| C3 | Second sync, no change | UP_TO_DATE. No indexer calls, no new rows. |
| C4 | Only the UI commit moved | Core REUSED, UI INDEXED. The new snapshot is published, and the old one is still loaded. |
| C5 | Reuse refused | Analyzer version mismatch, `includePackages`, WORKTREE graph or truncated file each cause a re-index. |
| C6 | Indexer fails | FAILED with exit 1. Pointer unchanged, no visible new row. |
| C7 | Validation fails | Dangling edge, commit mismatch, shrink guard or empty frontend: the PENDING row is removed and the pointer is unchanged. `--allow-shrink` lets the shrink case through. |
| C8 | Interrupted run | The PENDING row is invisible to `listSnapshots`, `resolveSnapshot` and `findMatchingSnapshot`. The next sync removes it. |
| C9 | Lock | A concurrent run gets exit 3. A lock held by a dead pid is taken over. |
| C10 | Publish is atomic | A reader between load and publish (through a hook) still sees the previous snapshot, and sees the new one after publish. |
| C11 | Compatibility | Without pointers, resolution still picks the highest id. `npm run load` still makes the new snapshot current. The snapshot list shape is additive only. |
| C12 | Loader replaces the published row | The pointer follows the new id. |
| C13 | Read-only | The target repositories' `git status`, index mtime and `FETCH_HEAD` are unchanged (same method as Phase B S2). |
| C14 | `--rev` | A valid SHA indexes that commit. An invalid ref gives exit 2 before anything is written. |
| C15 | Config | Detection from the config file, detection from the system snapshot, and neither (exit 2). |
| C16 | Report | `last-sync.json` has every section, and `history.ndjson` gets a line appended. |
| C17 | Real UI analyzer | One end-to-end run on a small UI fixture repository, without injection. The Java analyzer is covered by its existing tests plus the `version` test. |

All existing tests must still pass: server 94, analyzer-ui 5 and Java 17 (+1).

### Verification against the real repositories

These steps write only to `workspace/` and `jci.db`, never to either repository.

1. `npm run sync -- --dry-run`. Expected: both repositories UNCHANGED, because snapshot 7 already holds `671715e6` and `0574a567`. Whether the outcome is UP_TO_DATE depends on the analyzer-version check.
2. `npm run sync`. Expected: UP_TO_DATE with nothing written, and snapshot 7 still current.
3. `npm run sync -- --reindex justperform-ui`. This re-indexes the UI (about 5 s), recombines, loads (about 20 s) and publishes a new system snapshot (about 160 MB in the database). The web shows it as "(current)".
4. Failure check on a **copy** of `jci.db` (`--db`), using a forced validation failure. Expected: the published pointer and the snapshot list are unchanged.
5. Check that the repository checksums and `FETCH_HEAD` are unchanged, as in Phase B.

A Core re-index (about 3 min, 8 GB heap) runs only if you ask for it.

## Defaults to confirm

1. **Repository config:** optional `config/repos.yaml` (git-ignored), with detection from the current system snapshot as the fallback.
2. **Analyzer upgrade:** a change in analyzer version forces a re-index on the next sync. For Core that takes about 3 min.
3. **Shrink guard:** a 50% drop in any node kind, or zero `CALLS_API` links, fails validation unless `--allow-shrink` is given.
4. **Cleanup (K6):** sync may delete only the PENDING rows it created itself and never published.

## Risks

- **Disk and database growth:** every publish adds a system snapshot of about 160 MB to the database and about 160 MB of NDJSON to `cache/`, and nothing is pruned until Phase E. Sync only warns when the database is larger than 2 GB.
- **Memory:** the loader keeps the whole system graph in memory, as it does today.
- **Jar version:** the jar's version is the one compiled into it. If the jar wasn't rebuilt after an analyzer change, sync can only warn based on file times.
- **Shrink guard:** it is a heuristic. A real large refactor needs `--allow-shrink`.
- **Open browser sessions:** they keep the snapshot they had selected until the user switches (K7).

## Results

### Changed files

**New:**
- `server/src/snapshots.ts`
- `server/src/sync/{config,lock,validate,run,report}.ts`
- `server/src/cli/sync.ts`
- `server/test/sync.test.ts`
- `config/repos.example.yaml`
- `analyzer-ui/src/version.ts`
- `analyzer-java/src/test/java/com/jci/analyzer/cli/MainVersionTest.java`

**Changed:**

| File | Change |
|---|---|
| `server/src/db.ts` | `current_snapshots` and `snapshot_state` tables |
| `server/src/loader.ts` | `publish` and `state` options; a replace keeps the pointer |
| `server/src/query.ts` | Resolution order, hiding of PENDING snapshots, `current` flag in the list |
| `server/src/contract.ts` | `SnapshotDto.current?` |
| `server/src/freshness.ts` | The snapshot match ignores PENDING snapshots |
| `server/src/cli/load.ts` | Publishes by default; `--no-publish` |
| `server/src/cli/impact.ts` | Prefers the published system snapshot |
| `server/src/changes/index.ts` | `accept` and `requireComplete` reuse checks, `lastLineComplete`, `reuse: false` |
| `server/src/changes/run.ts` | `loadedSnapshot` exported |
| `server/src/multi/combine.ts` | Records `stats.stitchOptions.coreBases` |
| `analyzer-java/.../cli/Main.java` | `version` subcommand; jar rebuilt |
| `analyzer-ui/src/cli.ts` | Re-exports `VERSION` |
| `server/package.json`, `package.json` | `sync` script |
| `web/src/api.ts`, `web/src/App.tsx` | Default to the current snapshot; "(current)" label |
| `.gitignore` | `config/repos.yaml` |
| `README.md` | "Synchronization" section; run steps |
| `~/.claude/skills/jci-defect-impact-analysis/SKILL.md` | Step 2 now uses `npm run sync` |

**Deviations from the plan:**
- The shrink guard ignores node kinds that had fewer than 10 nodes before, because tiny counts give meaningless ratios.
- The stitch settings are recorded in `stats` rather than `scope`, so the key that identifies a snapshot does not change.
- The report-file writer lives in `sync/run.ts`; `sync/report.ts` renders the text.

### Tests (executed)

- **Server:** 114/114 (94 existing + 20 new: C1–C17 with C7a/b/c and C15b). Typecheck is clean for the server and the web.
- **Mutation check:**
  - Making PENDING snapshots visible fails C8 and C10.
  - Ignoring validation failures fails C7b.
- **UI analyzer:** 5/5.
- **Java:** 18/18 (17 + `MainVersionTest`). Maven needs `JAVA_HOME=~/.jdks/openjdk-26.0.1` because the machine's `JAVA_HOME` points to a JDK 21 that has been removed.
- **Jar:** the rebuilt jar reports `version` = `0.2.0`, the same version recorded in the existing Core graph, so that graph is still reused.

### Verification against the real repositories

| Run | Result |
|---|---|
| `npm run sync -- --dry-run` | DRY_RUN in 3.6 s. Repositories were detected from snapshot 7, both UNCHANGED. No files written. |
| `npm run sync` | UP_TO_DATE: snapshot 7, both UNCHANGED. Report files written. Warning: Core is 1,354 commits behind `origin/master`. |
| `npm run sync -- --reindex justperform-ui` | PUBLISHED snapshot 8 in 32 s (details below). |
| Forced failure on a backup copy of `jci.db` | FAILED at validate (details below). |

**The `--reindex justperform-ui` run, step by step:**
- Core graph REUSED (`justperform-core-full.ndjson`, analyzer 0.2.0).
- UI INDEXED in 7 s.
- Combine took 11 s; load took 9 s (65,669 nodes, 204,812 edges).
- All 9 checks passed: 1,089 endpoints, 698 UI routes and components, all edges resolve, and there was no shrink against snapshot 7.

**The forced failure:** a real UI re-index whose PENDING snapshot lost five search rows during the load step.
- Validation failed with `search-index: 63954 rows for 63959 searchable nodes`.
- The current snapshot stayed 8, and the snapshot list `[8,7,2,1]` was unchanged.
- PENDING snapshot 9 was deleted.

**After the runs:**
- **API:** the list marks 8 as `current: true` and 7 as `false`; default resolution returns snapshot 8.
- **CLI:** `impact --status` uses snapshot 8 (CURRENT).
- **Web:** opens snapshot 8, labelled "(current)".
- **Analyzed repositories:** for JustPerform-Core and JustPerform-UI, `git status` checksums, index modification times and `FETCH_HEAD` were identical before and after all runs.

### Remaining risks

- **Disk and database growth:** `jci.db` is now 714 MB plus a 512 MB WAL file. Each publish adds about 160 MB and nothing is pruned, so this is Phase E (retention, WAL checkpoint, VACUUM).
- **Core re-index not run:** a real Core re-index (about 3 min, 8 GB heap) was not exercised in this phase. The Java path uses the unchanged `ensureGraph`, plus the reuse checks covered by C5.
- **Stale jar:** the version check trusts the version compiled into the jar. A stale jar is detected only by comparing file times, and then only reported as a warning.
- **Shrink guard:** it is a heuristic. A real large deletion needs `--allow-shrink`.
- **Open browser tabs:** they keep their selected snapshot after a publish.
- **Stale snapshot 7:** snapshot 7 is no longer current but is kept, as are its cache files. Phase E's retention policy decides when it goes.
- **Machine setup:** the broken `JAVA_HOME` affects Maven only. Sync's own Java lookup skips a `JAVA_HOME` that doesn't exist.
