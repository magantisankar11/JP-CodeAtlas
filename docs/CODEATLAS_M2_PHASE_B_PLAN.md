# Milestone 2 — Phase B plan: graph freshness (revision 2)

Status: **implemented and verified (2026-10-27); see Results.** The live GitHub check ran with your OK (2026-10-27). Prerequisite Phase A: accepted.
Revision 2 applies your four decisions and the additional requirements (2026-10-27). It replaces the single combined
status of revision 1 with four independent dimensions.

## Current state (checked 2026-10-27)

| Item | Finding |
|---|---|
| Freshness today | Only the CLI command `npm run impact -- --status` (`server/src/cli/impact.ts:113`) reports it. It runs a synchronous `git rev-parse HEAD` per repository and sets `current = (HEAD == indexed)`. There is no API and no UI |
| Real result | Snapshot 7 (system) reports `current: true` for both repositories |
| Core reality | The indexed `671715e6cb` equals local HEAD (`master`). As of the last fetch (2026-10-26) it is **1,354 commits behind `origin/master`**, which is both its upstream and the default branch |
| UI reality | HEAD is `master_ds2` (upstream `origin/master_ds2`); the default branch is `origin/main`. The indexed `0574a567e6` is **1,305 ahead of `origin/main` and 0 behind** |
| Dirty trees | Core has 74 `git status` entries, all outside the analyzer scope (BMAD files in `.claude/`, `.agents/`). UI is clean. `git status` takes about 0.3 s per repository |
| Analyzer input scope | Java reads `sourceRoots` (`src/main/java`), `schemaDirs` (`.sql`) and the default config files `src/main/resources/application.{properties,yml,yaml}` (`AnalyzerConfig.java:32`). UI reads `src`, `test` with `.vue .js .mjs .cjs .ts .mts .jsx .tsx`, excluding `node_modules` (`analyzer-ui/src/source.ts:6`). The snapshot records roots and schema dirs but **not** the config-file list or the extensions |
| Timestamps | `snapshots.finished_at` / `loaded_at` exist. `scope.repos[]` (from `multi/combine.ts`) has no per-repository timestamp |
| Reusable code | `changes/git.ts`: `git()`, `defaultBranch()` and private `sha`/`isAncestor`/`count`/`tryGit`, all read-only with `--no-optional-locks`. `source.ts`: `reposOf()` |

## The four dimensions

Each repository of a snapshot is reported on four independent dimensions. None of them changes the value of another.

### 1. Snapshot accuracy: CURRENT / STALE / UNKNOWN

Does the graph describe the **selected revision**?

- **Selected revision:** by default, the repository's local HEAD. It can be overridden per repository with a branch, tag or commit (API `rev.<repoId>=`, CLI `--rev <repoId>=<ref>`, or the UI's "Compare against" field).
- **Comparison:** the selected revision is resolved to a commit and compared with the indexed commit.

| Condition | Accuracy | Reason |
|---|---|---|
| Indexed commit = selected commit, and the snapshot is commit-pinned (`HEAD` or `COMMIT`) | CURRENT | — |
| They differ | STALE | `INDEXED_COMMIT_DIFFERS`, with ahead/behind counts when computable |
| They differ, but another loaded snapshot has exactly the selected commit(s) | STALE for the served snapshot | `MATCHING_SNAPSHOT_AVAILABLE`, with `matchingSnapshotId` so the UI can switch to it |
| Selected revision doesn't resolve (unknown ref, invalid input) | UNKNOWN | `SELECTED_REVISION_UNRESOLVED` |
| The repository can't be read: missing path, not a git repository, `nogit-` content-hash snapshot, git error | UNKNOWN | `REPO_MISSING` / `NOT_A_GIT_REPO` / `NO_REPO_PATH` / `GIT_ERROR` |
| The snapshot was built from the working tree (`WORKTREE`) | UNKNOWN | `WORKTREE_SNAPSHOT`: the working-tree content at indexing time isn't recorded, so it can't be compared later |

For a system snapshot, the exact-match lookup requires a loaded snapshot whose `scope.repos[]` commits equal the selected commits of **every** repository. For a single-repository snapshot, `repo_id` and `commit_sha` must be equal.

Accuracy does **not** depend on the remote, on the default branch, or on uncommitted files (decisions 1, 2 and 4).

### 2. Branch currency: UP_TO_DATE / BEHIND / AHEAD / DIVERGED / NO_UPSTREAM / UNKNOWN

How does the **selected commit** relate to the tracking branch?

- **Tracking branch:** the upstream of the selected branch (`@{u}`), or of HEAD when a commit is selected.
- **Source of the remote side:** the local remote-tracking refs (cached), or a live check when requested (dimension 3).

| Condition | Value |
|---|---|
| Upstream equals the selected commit | UP_TO_DATE |
| Upstream has commits the selected commit lacks / lacks commits the selected commit has / both | BEHIND / AHEAD / DIVERGED, with counts |
| No upstream configured | NO_UPSTREAM |
| Live mode only: the remote tip isn't in local objects (not fetched) | BEHIND with `count: null` ("remote moved, not fetched") if the selected commit is an ancestor of the local tracking ref; otherwise UNKNOWN |
| The relationship can't be computed | UNKNOWN |

The **default-branch relation** is reported next to it: `defaultBranch`, `aheadOfDefault`, `behindDefault`, and `relation: SAME | AHEAD | BEHIND | DIVERGED | UNKNOWN`. It is informational only and never makes a feature branch STALE (decision 1).

Branch-currency counts based on cached tracking refs are labelled with their as-of time. When the remote currency is UNKNOWN, the counts still show, with that label.

### 3. Remote currency: VERIFIED / RECENT / UNKNOWN / NOT_APPLICABLE

How trustworthy is the remote information used in dimension 2?

| Condition | Value |
|---|---|
| A live check succeeded in this request, or a cached live result is within its TTL | VERIFIED (`checkedAt`) |
| Cached mode, and the tracking refs were updated within `JCI_FRESHNESS_MAX_REMOTE_AGE_H` (default **24**) | RECENT (`asOf`) |
| Tracking refs are older than that, were never fetched, or a live check failed | UNKNOWN (`REMOTE_INFO_OUTDATED` / `REMOTE_NEVER_FETCHED` / `REMOTE_UNAVAILABLE`, with a credential-free error) |
| No remote configured | NOT_APPLICABLE |

- **As-of time:** the newer of the `FETCH_HEAD` mtime and the tracking ref's latest reflog entry.
- **Live checks** run only on "Check remote now" or `--remote live`; nothing triggers them during navigation, search or graph traversal (decision 3). Each live check is one `git ls-remote <remote> HEAD refs/heads/<upstream>` call:
  - no prompt (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`);
  - an 8 s timeout.
- **A failed live check** sets only this dimension to UNKNOWN. Snapshot accuracy, working tree and the cached branch-currency counts are kept. The response also keeps `lastVerified` from the last successful live check, held in memory until the server restarts.
- **The tool never runs `git fetch`**, because fetching writes `.git`. CI workflows fetch in their own clone and index the exact target commit with the existing `--commit` option (Phase C `sync` will accept the same).

### 4. Working tree: CLEAN / MODIFIED / UNKNOWN

Are there uncommitted source changes the graph doesn't include?

- **Command:** `git status --porcelain --untracked-files=normal -- <analyzer scope>`. gitignored files are never listed.
- **Analyzer scope:** the paths the analyzer reads, filtered to the extensions it parses:
  - **Java:** `sourceRoots` (`*.java`), `schemaDirs` (`*.sql`) and the default config files;
  - **UI:** `sourceRoots` with the UI extensions, excluding `node_modules`.
  - Anything else counts as outside the scope: generated output, `.claude/`, unrelated untracked files (decision 4).
- **Values:**
  - CLEAN: nothing in scope changed.
  - MODIFIED: something in scope changed. Gives the count, up to 10 paths, and the warning *"The graph is pinned to `<sha>` and does not include N uncommitted source change(s)."*
  - UNKNOWN: the status couldn't be read, or the snapshot is `WORKTREE` (see dimension 1).
- **Changes outside the scope:** reported as a count only, without a warning.
- **Commit-pinned snapshots** never become STALE because of this dimension (decision 4).

Working-tree analysis, when the user asks to analyse local changes:
- `--changes … working` already indexes the working tree into a `WORKTREE` graph and raises `CHANGE_WORKTREE`. This is unchanged.
- **New:** normal impact runs (CLI and API `impact` / `export/context`) on a commit-pinned snapshot while the working tree is MODIFIED add the unknown **`LOCAL_MODIFICATIONS_NOT_INDEXED`**, plus a line in the bundle's traceability section, so the analysis is clearly marked as not covering them.

### Top-level `status`

The original requirement asks for one CURRENT / STALE / UNKNOWN value per repository.
- **Per repository:** `status` is defined as **snapshot accuracy**, nothing else.
- **Snapshot level:** `status` is the worst accuracy across repositories (STALE > UNKNOWN > CURRENT).
- **The other three dimensions** sit beside it and are never folded in.

## How the decisions map onto today's data (expected; confirmed during implementation)

| | Accuracy | Branch currency | Remote currency | Working tree | Default-branch relation |
|---|---|---|---|---|---|
| Core | CURRENT (indexed = HEAD `671715e6cb`) | BEHIND 1,354 (`origin/master`, as of 2026-10-26) | UNKNOWN (fetch over 24 h old) | CLEAN (74 changes outside the scope) | BEHIND 1,354 |
| UI | CURRENT (indexed = HEAD `0574a567e6`) | UP_TO_DATE or BEHIND (`origin/master_ds2`) | depends on the fetch age | CLEAN | AHEAD 1,305 (info) |
| System snapshot `status` | CURRENT | — | — | — | — |

The badge would therefore read **"Snapshot current · Core branch behind 1,354 (as of 26 Oct) · remote unverified"**, not green-only and not red.

## Conflicts with the current architecture, and how they are resolved

| # | Requirement | Conflict | Resolution (all additive) |
|---|---|---|---|
| C1 | "Compare against the **selected** repository/branch" | There is no notion of a selected revision; the UI selects a **snapshot** and the API defaults to the latest one | Add a selected revision as an input of the freshness check only (default HEAD; overridable per repository). Snapshot resolution of every existing route stays as it is |
| C2 | "Do not silently serve an outdated snapshot" | Every existing route serves the requested or latest snapshot without a freshness check. Making them refuse or switch would break API compatibility, and running git on every request would slow search and traversal | (a) A **response header** `X-JCI-Snapshot-Status: CURRENT\|STALE\|UNKNOWN` on every snapshot-scoped response, read from the freshness cache only. It never runs git inline: if there is no entry, it says UNKNOWN and computes in the background. (b) A permanently visible badge with both SHAs. (c) `report.freshness` plus the unknown in impact reports and bundles. Envelopes and status codes are unchanged |
| C3 | "STALE unless an exact matching snapshot exists" | Snapshots are matched by `(repo_id, commit, scope)`. System snapshots store their per-repository commits only inside `scope_json` | The lookup reads `scope_json` of the candidate snapshots (a handful of rows); no schema change. Unloaded graph files in `workspace/graphs/cache` don't count as snapshots; Phase C `sync` loads them |
| C4 | "Ignore generated or unrelated files unless in the analyzer's configured scope" | The snapshot doesn't record the Java config-file list or the per-analyzer extensions | Phase B mirrors them as constants in `freshness.ts` (with a comment pointing at `AnalyzerConfig.java:32` and `analyzer-ui/src/source.ts:6`) and a test that fails if the UI constant drifts. Recording `scope.inputs` in the analyzers is deferred to Phase D, which edits the Java analyzer anyway. Until then, a non-default config location would not be watched |
| C5 | "Keep previously verified local information on network failure" | The server is stateless apart from SQLite; nothing persists check results | An in-memory cache keeps the last successful live result per repository (`lastVerified`), and is lost on restart. Persisting it would mean a new table; not proposed |
| C6 | "Display indexed and selected SHAs" | The header shows only the snapshot label | The badge shows `indexed <sha8> · selected <sha8>` per repository |
| C7 | "Preserve existing API contracts" | CLI `--status` has `current` = HEAD equality | `current` keeps that meaning, which equals accuracy against HEAD. New keys `status`, `accuracy`, `branch`, `remote`, `worktree` are added beside it |
| C8 | Working-tree analysis needs a working-tree-aware snapshot | The UI can't build one (indexing is CLI-only until Phase C) | The badge's MODIFIED warning names the command (`--changes … working`, or `--mode WORKTREE` indexing); impact results carry `LOCAL_MODIFICATIONS_NOT_INDEXED` |

## API

### `GET /api/v1/freshness`

Query parameters:
- `snapshot` / `repo`: as other routes.
- `rev.<repoId>=<branch|tag|sha>`: optional, repeatable. Each value must match `^[A-Za-z0-9._/@^~-]{1,200}$`, must not start with `-`, and is passed after `--end-of-options`.
- `remote=cached|live` (default `cached`).
- `refresh=true` bypasses the cache.

```jsonc
{ "apiVersion": "...", "snapshot": { "id": 7, "repoId": "justperform-system", "commitSha": "671715e6cb…" },
  "data": {
    "status": "CURRENT",                 // worst accuracy across repos
    "checkedAt": "2026-10-27T…Z", "remoteMode": "cached",
    "matchingSnapshotId": null,          // a loaded snapshot exactly matching every selected commit, if the served one doesn't
    "repos": [{
      "repoId": "justperform-core", "role": "backend", "pathPrefix": "", "repoPath": "C:/…/JustPerform-Core",
      "sourceMode": "HEAD", "snapshotTimestamp": "2026-10-26T12:18:06Z", "timestampSource": "snapshot",
      "status": "CURRENT",               // = accuracy.status
      "accuracy": { "status": "CURRENT", "indexedCommit": "671715e6cb…",
                    "selected": { "rev": "HEAD", "commit": "671715e6cb…", "branch": "master" },
                    "indexedAheadOfSelected": 0, "indexedBehindSelected": 0, "reasons": [] },
      "branch":   { "status": "BEHIND", "upstream": "origin/master", "upstreamCommit": "96e2258d96…", "ahead": 0, "behind": 1354,
                    "asOf": "2026-10-26T04:45:00Z",
                    "default": { "branch": "origin/master", "commit": "96e2258d96…", "relation": "BEHIND", "ahead": 0, "behind": 1354 } },
      "remote":   { "status": "UNKNOWN", "name": "origin", "url": "https://github.com/JustPerform/JustPerform-Core.git",
                    "source": "tracking-ref", "asOf": "2026-10-26T04:45:00Z", "maxAgeHours": 24,
                    "reasons": [{ "code": "REMOTE_INFO_OUTDATED", "message": "…" }], "lastVerified": null },
      "worktree": { "status": "CLEAN", "changedInScope": 0, "changedOutsideScope": 74, "sample": [], "warning": null }
    }]
  } }
```

- Results are cached in memory per (snapshot, selected revisions, mode): 30 s for cached mode, 5 min for live mode.
- Git runs asynchronously, one repository per task, in parallel.
- Remote URLs and error texts have user info removed.
- Phase A's Host/Origin guard applies.

### Additive changes elsewhere

- **Snapshot-scoped GET and POST routes:** `X-JCI-Snapshot-Status` header, from the cache only (C2).
- **`POST /api/v1/impact` and `/export/context`:** `report.freshness` (cached mode, HEAD-selected), plus the unknown `LOCAL_MODIFICATIONS_NOT_INDEXED` when relevant. The traceability gate text names indexed and HEAD commits and an accuracy that isn't CURRENT.
- **CLI `impact`:** the same for bundles (`impact-analysis.md` gets a "Source freshness" block). `--status` gains `--rev` and `--remote live`.

## File-level changes

| File | Change | Size |
|---|---|---|
| `server/src/changes/git.ts` | Export `tryGit`, `sha`, `isAncestor`, `count`. Add `gitAsync(repo, args, { timeoutMs, env })` (same read-only flags plus the no-prompt environment) and `safeRev()`. Existing behaviour is unchanged | +35 |
| `server/src/freshness.ts` (new) | `checkFreshness(db, snap, { revs, remote, refresh })` and per-dimension functions `accuracy()`, `branchCurrency()`, `remoteCurrency()`, `worktree()`. Also `analyzerScope(repoRef)` (C4 constants), `findMatchingSnapshot()`, `redactRemoteUrl()`, the cache, `lastVerified` and `cachedStatusHeader(snapId)` | ~300 |
| `server/src/app.ts` | Route `/api/v1/freshness`. An `onSend` hook adds `X-JCI-Snapshot-Status` when the reply carries a snapshot envelope. `impact` / `export/context` attach `freshness` | +35 |
| `server/src/impact/types.ts` | `ImpactReport.freshness?: FreshnessSummary` (optional, additive) | +12 |
| `server/src/impact/render.ts`, `impact/gates.ts` | A "Source freshness" block, and `LOCAL_MODIFICATIONS_NOT_INDEXED` in the unknowns. Traceability is NEEDS-attention when accuracy isn't CURRENT | +30 |
| `server/src/multi/combine.ts` | `finishedAt` per repository in `scope.repos[]` (additive) | +2 |
| `server/src/cli/impact.ts` | `--status` uses `checkFreshness`. **Old keys keep their meaning** (C7); new options `--rev`, `--remote`. Bundles get `report.freshness`. Removes the duplicated `execFileSync` helper | ±40 |
| `server/test/freshness.test.ts` (new) | Unit and integration matrix (below) | ~350 |
| `server/test/api.test.ts`, `impact.test.ts` | Header present; `report.freshness` present; existing assertions unchanged | +20 |
| `web/src/api.ts` | `Freshness*` types; `api.freshness(snapshot, { revs, remote, refresh })` | +40 |
| `web/src/FreshnessBadge.tsx` (new) | Header strip and popover (below) | ~170 |
| `web/src/App.tsx` | Render the badge; when a matching snapshot exists, show "Switch to snapshot N", which calls the existing `setSnapshotId` | +8 |
| `web/src/styles.css` | Badge and popover styles with the existing tokens, light and dark | +40 |
| `README.md` | API entry, the four-dimension table, reason codes, the "never fetches; CI fetches in its own clone" note, the header | +40 |
| `~/.claude/skills/jci-defect-impact-analysis/SKILL.md` | Step 2 reads `accuracy` / `branch` / `remote` / `worktree`, and states that a MODIFIED tree needs `--changes … working` | ±10 |

The analyzed repositories are not touched: every git command is read-only, there is no fetch, and the test fixtures are temporary repositories.

## UI

- **Header strip,** always visible next to the snapshot selector: one compact row per repository with `repoId`, `indexed 671715e6 · selected 671715e6`, and four small labelled chips (accuracy, branch, remote, working tree).
  - The labels are text, such as "Snapshot current", "Branch behind 1,354", "Remote unverified" and "Working tree clean", so colour is never the only signal.
  - The strip has `role="status"`.
- **Popover:**
  - per-dimension details with their as-of times and reasons;
  - "Compare against" input per repository (branch, tag or SHA; validated by the server);
  - "Check remote now" (live) with a spinner and a credential-free error;
  - "Switch to snapshot N" when a matching snapshot exists;
  - the re-index command hint for STALE, and the `--changes … working` hint for MODIFIED.
- **Refresh:** refetch on window focus and every 5 min in cached mode only. Never live automatically.
- **When the freshness API fails:** every chip shows UNKNOWN ("freshness unavailable") and the SHAs still show from the snapshot list. Nothing turns green by default.

## Tests

Each dimension is tested over all of its values, independently of the others. Then a combination matrix pins down the independence rules that your decisions require: no dimension may change another.

| # | Scenario (temporary bare origin plus clones in `os.tmpdir()`) | Accuracy | Branch | Remote | Worktree |
|---|---|---|---|---|---|
| A1 | indexed = HEAD, clean, fetched just now | CURRENT | UP_TO_DATE | RECENT | CLEAN |
| A2 | Local commit after indexing | **STALE** | AHEAD | RECENT | CLEAN |
| A3 | `rev.<id>` set to another branch with a different commit | **STALE** | per branch | RECENT | CLEAN |
| A4 | A3, plus a second loaded snapshot at that commit | STALE + `matchingSnapshotId` | — | — | — |
| A5 | `rev.<id>=does-not-exist`, and `rev.<id>=--upload-pack=x` | UNKNOWN; the second gets **400** (injection rejected) | — | — | — |
| A6 | `nogit-` snapshot / missing path / null `repoPath` / `WORKTREE` snapshot | UNKNOWN (matching code) | UNKNOWN | — | UNKNOWN for WORKTREE |
| B1 | Another clone pushes, the test clone fetches | CURRENT | **BEHIND 1** | RECENT | CLEAN |
| B2 | Feature branch ahead of default, upstream equal | CURRENT | UP_TO_DATE | RECENT | CLEAN; default relation AHEAD (info) |
| B3 | Branch diverged from default | CURRENT | — | — | default relation DIVERGED; **not STALE** |
| B4 | No upstream | CURRENT | NO_UPSTREAM | RECENT/NA | CLEAN |
| B5 | Push without fetch, `remote=live` | CURRENT | BEHIND, `count: null` | VERIFIED | CLEAN |
| R1 | Tracking ref older than the max age (the age cutoff is injected) | **CURRENT (unchanged)** | counts labelled as-of | UNKNOWN `REMOTE_INFO_OUTDATED` | CLEAN |
| R2 | Never fetched | CURRENT | UNKNOWN or as-of | UNKNOWN `REMOTE_NEVER_FETCHED` | CLEAN |
| R3 | Live with a non-existent remote; live with a 1 ms timeout | **CURRENT (kept)** | cached counts kept | UNKNOWN `REMOTE_UNAVAILABLE` | CLEAN (kept) |
| R4 | Live success, then live failure | — | — | UNKNOWN with `lastVerified` = first result | — |
| R5 | No remote | CURRENT | NO_UPSTREAM | NOT_APPLICABLE | CLEAN |
| W1 | Edited `.java` under `src/main/java` | **CURRENT (unchanged)** | — | — | MODIFIED (count, sample, warning) |
| W2 | New untracked `.sql` in `schemaDirs`; edited `application.yml` | CURRENT | — | — | MODIFIED |
| W3 | Untracked `.claude/x.md`, `target/Foo.class`, `README.md`, a `.txt` under `src/main/java` | CURRENT | — | — | **CLEAN**, with `changedOutsideScope` > 0 |
| W4 | UI repository: edited `.vue` under `src`; file under `node_modules` | CURRENT | — | — | MODIFIED / out of scope |
| W5 | `git status` fails (corrupt `.git` simulation) | CURRENT | — | — | UNKNOWN |
| X1 | System snapshot, Core A1 + UI A2 | Snapshot `status` STALE; per-repository values separate | | | |
| X2 | A2 + W1 + R3 at once | STALE | AHEAD | UNKNOWN | MODIFIED: each reported independently |
| S1 | Remote URL with a token; error text of a failed live check | Token absent from the whole response | | | |
| S2 | Read-only: `.git/index` mtime, `git status`, refs, no `FETCH_HEAD` created, before and after the whole suite | Identical | | | |
| I1 | API: envelope; `remote=bogus` → 400; forged Host → 403; cache hit; `refresh=true` bypass | | | | |
| I2 | API: `X-JCI-Snapshot-Status` on search/graph: UNKNOWN before any check, the cached status after; no git on the request path | | | | |
| I3 | API impact on a MODIFIED tree: `report.freshness` and `LOCAL_MODIFICATIONS_NOT_INDEXED` present; existing impact assertions unchanged | | | | |
| I4 | CLI `--status`: old keys with old meaning plus the four dimensions; `--rev`, `--remote live` against the fake remote | | | | |
| I5 | Drift guard: the UI extension constant in `freshness.ts` equals `analyzer-ui/src/source.ts` `EXTENSIONS` | | | | |

### Verification beyond the tests

- All suites pass: server 63+, analyzer-ui 5, Java 17, plus typechecks.
- Live API on snapshot 7 matches the table above. I check the Core 1,354 independently with `git rev-list --count`.
- I run one live remote check against GitHub **only with your OK**.
- In the browser pane, I check the strip and popover:
  - the normal state;
  - "Compare against" another branch, which should show STALE;
  - the API stopped, which should show every chip UNKNOWN.
- The JustPerform-Core / UI `git status` checksums stay unchanged.

## Risks

- **The header (C2) is advisory.** Clients that ignore it can still use a stale snapshot. The badge and impact reports are the visible guarantees.
- **The C4 constants can drift** from the Java analyzer's config list until Phase D records `scope.inputs`; the UI constant has a drift test. A non-default config location isn't watched.
- **`lastVerified` is lost on server restart** (C5).
- **The GitHub live path is tested only manually.** The automated tests use a local fake remote, so credential-manager behaviour on this machine is verified once, by hand.
- **Old system snapshots** have no per-repository timestamp, so `timestampSource: "snapshot"` is used.

## Results

### Changed files

| File | Change |
|---|---|
| `server/src/freshness.ts` | New (~450 lines): the four dimensions, analyzer scope, exact-match lookup, URL redaction, caches keyed by snapshot id + every repository's commit/path/mode, `lastVerified`, `cachedSnapshotStatus` |
| `server/src/changes/git.ts` | Exports `tryGit`, `sha`, `isAncestor`, `count`; new `gitAsync`, `NO_PROMPT_ENV`, `safeRev`. Existing callers unchanged |
| `server/src/impact/freshness.ts` | New: `summarizeFreshness`, `attachFreshness` (unknowns + gate re-evaluation) |
| `server/src/impact/types.ts`, `render.ts`, `gates.ts` | `ImpactReport.freshness?`, *Source freshness* section, traceability NEEDS_HUMAN when not CURRENT or MODIFIED |
| `server/src/app.ts` | `GET /api/v1/freshness`; `X-JCI-Snapshot-Status` on snapshot-scoped routes; freshness on `impact` and `export/context` |
| `server/src/cli/impact.ts` | `--status` on `checkFreshness` (old keys kept) plus `--rev` and `--remote`; bundles get freshness; duplicated `execFileSync` helper removed |
| `server/src/multi/combine.ts` | `finishedAt` per repository in `scope.repos[]` |
| `server/test/freshness.test.ts` | New: 31 tests (A1–A6, B1–B5, R1–R5, W1–W5, X1, X2, worst-of, S1, S2, I1–I5) |
| `web/src/components/FreshnessBadge.tsx` | New: header strip and popover. Placed in `components/` to match the existing layout (the plan said `src/`) |
| `web/src/api.ts`, `App.tsx`, `styles.css` | Types and `api.freshness`; strip in the header; chip tokens for light and dark |
| `README.md`, `~/.claude/skills/jci-defect-impact-analysis/SKILL.md` | Freshness section; step 2 reports the four dimensions separately |

### Tests (executed)

| Suite | Result |
|---|---|
| server (`npm test`) | **94/94** (63 existing + 31 new); freshness file about 85 s (see Risks) |
| analyzer-ui | 5/5 |
| analyzer-java (`mvn test`) | 17/17 (GoldenFixtureTest 10, UnitTest 7) |
| Typechecks | server, web clean |

Three defects were found and fixed while making the matrix pass:
- `rev-parse --abbrev-ref` echoed `--end-of-options` into the upstream name.
- Fresh clones looked "never fetched", because clone writes no reflog for remote refs. HEAD's `clone: from` reflog entry is now used.
- The UI showed the previous result after a failed refetch. It now shows UNKNOWN.

### Live verification (snapshot 7, cached mode)

| Repository | Accuracy | Branch | Remote | Working tree | Default branch |
|---|---|---|---|---|---|
| justperform-core | CURRENT (`671715e6`) | BEHIND 1,354 vs `origin/master` | RECENT (fetch 2026-10-26 04:45Z) | CLEAN (74 outside scope) | BEHIND 1,354 |
| justperform-ui | CURRENT (`0574a567`) | UP_TO_DATE vs `origin/master_ds2` | RECENT | CLEAN | AHEAD 1,305 (info) |

- **Independent check:** `git rev-list --count` gives 1,354 and 1,305, matching the table.
- **Comparing Core against `origin/master`:** STALE, with 1,354 commits not in the graph. `matchingSnapshotId` is null because no such snapshot is loaded.
- **Unsafe revision** (`--upload-pack=x`): 400.
- **Header:** UNKNOWN before the first check, CURRENT after it.
- **Browser:**
  - the strip shows both SHAs and four labelled chips per repository;
  - the popover details are correct;
  - "Compare against" works;
  - with the API stopped, both a new and a cached query show "Freshness unavailable" and grey Unknown chips.
- **Target repositories:** `git status` checksums unchanged, and Core `FETCH_HEAD` unchanged. Another tool on the machine updated UI's `FETCH_HEAD` during the session; CodeAtlas never fetches.

### Live remote check (snapshot 7, `--remote live`, run once with your OK)

`npm run impact -- --repo justperform-system --status --remote live`: exit 0, 9.7 s, `status` CURRENT, `remoteMode` live.

| Repo | Remote | Upstream on GitHub | Branch | Accuracy / worktree |
|---|---|---|---|---|
| Core | VERIFIED (ls-remote, `https://github.com/JustPerform/JustPerform-Core.git`) | `origin/master` = `96e2258d`, the same as the local tracking ref | BEHIND 1,354 / ahead 0 | CURRENT / CLEAN |
| UI | VERIFIED (`https://github.com/JustPerform/JustPerform-UI.git`) | `origin/master_ds2` = `0574a567`, the same as the local tracking ref | UP_TO_DATE | CURRENT / CLEAN |

- The `FETCH_HEAD` mtime and md5 of both repositories were identical before and after the check, so nothing was fetched.
- No credential prompt appeared.
- **Defect found and fixed:** the parser read `ls-remote --symref`'s `ref: refs/heads/master<TAB>HEAD` line as HEAD's SHA. As a result, `lastVerified.defaultCommit` held the ref text, and in live mode the information-only default-branch relation came out wrong (Core: behind, count unknown; UI: UNKNOWN). Cached mode was not affected.
  - Fix: `shaFor` skips symref lines.
  - Regression check: B5 now asserts `defaultCommit` and the default relation; it failed before the fix and passes after.
  - Server tests: 94/94.
  - The fix has not been re-confirmed against GitHub, because that would be a second live check.

### Remaining risks

- **Slow git spawns:** each git process costs about 0.15–0.3 s on this machine, so one uncached check of snapshot 7 takes about 2 s. The cache makes this rare, and git spawns could be batched later if needed.
- **Advisory header:** clients that ignore `X-JCI-Snapshot-Status` can still use a stale snapshot without noticing.
- **Scope constants (C4):** the UI and Java-config lists have drift tests, but a non-default Java config location is not watched until Phase D records `scope.inputs`.
- **`lastVerified`** is kept in memory and lost on restart.
- **System snapshots** loaded before this change have no per-repository timestamp (`timestampSource: "snapshot"`).
