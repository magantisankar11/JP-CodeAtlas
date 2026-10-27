# Milestone 2 — Phase A plan: security and version control

Status: **implemented and verified (2026-10-27); local git not initialised (awaiting approval).** Source: audit finding P0 (`CODEATLAS_IMPLEMENTATION_AUDIT.md`, Security row).

## Current state (checked)

| Item | Finding |
|---|---|
| Listener | `server/src/main.ts` binds `127.0.0.1:4317`; no auth (by design: local tool) |
| Routes | 11 GET + 3 POST (`/defect/match`, `/impact`, `/export/context`) in `server/src/app.ts`; no hooks, no CORS plugin, no CORS headers emitted |
| WebSocket / SSE | None (no `ws`, `@fastify/websocket` or upgrade handling) |
| Browser client | `web/src/api.ts` calls relative `/api/v1/...`; Vite dev server `127.0.0.1:5173` proxies `/api` with `changeOrigin: false`, so the API receives `Host: 127.0.0.1:5173` and `Origin: http://127.0.0.1:5173` |
| Vulnerability | Any `Host` is accepted: a page on `attacker.example` rebinding to 127.0.0.1 can read `/api/v1/source` (verified 200 in the audit) |
| POST bodies | Fastify accepts `text/plain` by default: a CORS "simple request" (no preflight) can reach the POST routes |
| `.gitignore` | Exists, covers `node_modules/ dist/ target/ workspace/ *.db*` and `.vite/`. Missing: credentials, logs, `.partial/`, test reports, IDE/local Claude settings |
| Version control | The tool folder is not a git repository |

## Design

Validation happens in one Fastify `onRequest` hook, before routing. That covers every current route, 404s, `OPTIONS`, and any future WebSocket route (`@fastify/websocket` upgrades also pass through `onRequest`).

1. **Host check (stops DNS rebinding).** The hostname from `Host` must be `127.0.0.1`, `localhost` or `[::1]`. Any port is accepted: a rebinding attacker controls the name, not the port, and accepting any port keeps `app.inject()` tests (which send `localhost:80`) working. A missing `Host` is rejected. The response is `403 {"error":"Forbidden host"}`.
2. **Origin check (stops cross-origin reads and CSRF from other local pages).** When an `Origin` header is present, it must be in the allow-list. The default list is the loopback hosts on the API port plus the Vite port `5173`. `JCI_ALLOWED_ORIGINS` (comma-separated) extends it. `Origin: null` is rejected. Requests without `Origin` (curl, the CLI, same-origin GET) pass.
3. **Fetch metadata (defence in depth).** `Sec-Fetch-Site: cross-site` is rejected even if the Origin check would pass.
4. **POST content type.** POST requests must be `application/json`; anything else returns 415. This removes the no-preflight path.
5. **No CORS.** The API never emits `Access-Control-Allow-*`. A test asserts this so a later change cannot add a wildcard silently.
6. **Bind guard.** `main.ts` keeps loopback-only binding. An optional `JCI_HOST` is accepted only if it is a loopback address; anything else makes startup fail with a message.

Rejections are logged at `warn` with the route and the rejected header name only. Header values are not echoed into responses.

## File-level changes

| File | Change | Size |
|---|---|---|
| `server/src/security.ts` (new) | `LOOPBACK_HOSTS`, `parseHostHeader()`, `allowedOrigins({ port, extra })`, `installRequestGuard(app, opts)` (the `onRequest` hook for rules 1–5), `assertLoopbackBind(host)` | ~80 lines |
| `server/src/app.ts` | `buildApp(db, opts)` gains an optional `security?: { port?: number; allowedOrigins?: string[] }` and calls `installRequestGuard`. The guard is always on; options only widen the Origin list. Signature stays compatible, so existing callers and tests are unchanged | +5 lines |
| `server/src/main.ts` | Read `JCI_HOST` (default `127.0.0.1`) and `JCI_ALLOWED_ORIGINS`, call `assertLoopbackBind`, pass the port to `buildApp` | +6 lines |
| `server/test/security.test.ts` (new) | Regression tests (below), using `inject()` plus one real-socket test on an ephemeral port | ~120 lines |
| `web/vite.config.ts` | Unchanged except a comment that the proxy keeps `changeOrigin: false` on purpose, and why. Vite 8 already rejects unknown `Host` values on the dev server (`server.allowedHosts` default); this is verified, not assumed | +2 lines |
| `.gitignore` | Extend (below) | +~25 lines |
| `README.md` | "Security model" section: loopback only, Host/Origin allow-list, `JCI_ALLOWED_ORIGINS`, no CORS, no auth (single-user local tool) | +~15 lines |
| `docs/CODEATLAS_IMPLEMENTATION_AUDIT.md` | Not edited (audit stays as recorded). The Phase A report goes into this file's "Results" section | — |

No API response shape, route, query parameter or CLI option changes. Behaviour changes only for requests that are currently insecure.

## Regression tests (`security.test.ts`)

| # | Request | Expect |
|---|---|---|
| 1 | `GET /api/v1/health`, `Host: attacker.example:4317` | 403 |
| 2 | `GET /api/v1/source?...` (the audit's reproduction), forged Host | 403, body has no source text |
| 3 | `POST /api/v1/impact`, forged Host | 403 |
| 4 | Hosts `127.0.0.1:4317`, `localhost:4317`, `[::1]:4317`, `localhost` | 200 |
| 5 | Lookalikes: `127.0.0.1.attacker.example`, `localhost.attacker.example`, `127.0.0.2`, `0.0.0.0`, `LOCALHOST:4317` (case-insensitive accept) | 403, except the case variant, which gets 200 |
| 6 | Missing or empty Host (real socket, raw HTTP/1.0) | 403 |
| 7 | `Origin: http://evil.example` with a valid Host | 403 |
| 8 | `Origin: null`, `Origin: http://localhost:9999`, `Origin: http://127.0.0.1:4317.evil.example` | 403 |
| 9 | `Origin: http://127.0.0.1:5173` and `http://localhost:4317` | 200 |
| 10 | `JCI_ALLOWED_ORIGINS`-style option adds `http://localhost:4000` | 200 for it, 403 for others |
| 11 | `Sec-Fetch-Site: cross-site` with an allowed Origin | 403 |
| 12 | `POST /api/v1/defect/match` with `content-type: text/plain` | 415 |
| 13 | `OPTIONS /api/v1/impact` preflight from an evil Origin | 403; no `Access-Control-Allow-Origin` |
| 14 | Any allowed response | No `Access-Control-Allow-*` headers |
| 15 | Unknown route with a forged Host | 403, not 404 (the guard runs before routing) |
| 16 | `assertLoopbackBind('0.0.0.0')` and `('192.168.1.5')` | Throws; `127.0.0.1` and `::1` do not |

### Verification beyond the unit tests

- The full existing suites still pass: server 50, analyzer-ui 5, Java 17, plus typechecks.
- I restart the running API server and reproduce the audit's `curl -H "Host: attacker.example"` source read; it must return 403.
- A normal `curl` request without a forged Host must still return 200.
- `curl -H "Host: attacker.example" http://127.0.0.1:5173/` must be rejected by Vite.
- In the browser pane, through Vite, search and graph must still work, which proves the proxied Host and Origin are allowed.

## `.gitignore` additions

```gitignore
# Generated graphs, databases and extracted sources (anywhere, not only ./workspace)
workspace/
**/.partial/
*.sqlite
*.sqlite3
*.db-journal
# Credentials and local config
.env
.env.*
!.env.example
*.pem
*.key
*.p12
*.pfx
*.jks
*.keystore
.npmrc
.claude/settings.local.json
# Logs, reports, temp
*.log
*.err
coverage/
test-results/
playwright-report/
*.tmp
# Editors / OS
.idea/
.vscode/
*.iml
.DS_Store
Thumbs.db
```

Kept tracked on purpose: `server/test/data/*.ndjson`, `fixtures/**` (test inputs), `schemas/`, and `config/`.

Verification without creating a repository in the tool folder: I use a throwaway `--git-dir` in the scratchpad with `--work-tree` pointing at the tool and run `ls-files --others --exclude-standard`. Then I check that list for:

- any `.db`, `.ndjson` outside the test data, or files over 1 MB;
- secret-looking names;
- anything from `workspace/`.

## Local git initialization: proposal, **not executed**

The commands below need your approval. There is no remote and no push.

```bash
cd /c/Users/Maganti.Gowrisankar/projects/java-code-intel
git init -b main
git status --short          # review what would be tracked
```

- **First commit:** only on your explicit request. Your standing rule is "no commits", so I would stop after `git init` and you would commit yourself.
- **Size check:** the tracked set is expected to be about 13k lines of source plus fixtures, under 5 MB. `workspace/` (2.7 GB) is excluded.
- **Remote:** none. `git remote` stays empty, and adding one needs separate approval.

## Risks

- **Other local origins:** a non-default Vite port, `vite preview` (4173), or another tool calling the API would get 403 until it is added through `JCI_ALLOWED_ORIGINS`. The error message names the variable.
- **No authentication:** any local process can still read the API; Phase A does not add auth. This is acceptable for a single-user workstation tool, and the README will state it.
- **Vite dev-server protection** is Vite's own; the tests cover only the API. I will check Vite once manually and record the result.

## Results

### Changed files

| File | Change |
|---|---|
| `server/src/security.ts` | New: `parseHostHeader`, `allowedOrigins`, `installRequestGuard`, `assertLoopbackBind` |
| `server/src/app.ts` | Imports the guard; `buildApp(db, { logger?, security? })` always installs it |
| `server/src/main.ts` | `JCI_HOST` (loopback only, checked), `JCI_ALLOWED_ORIGINS`, port passed to the guard |
| `server/test/security.test.ts` | New: 13 tests across 4 suites, covering the 16 cases planned above |
| `web/vite.config.ts` | Comment only |
| `.gitignore` | Rewritten as planned (a superset of the old rules) |
| `README.md` | New "Security model" subsection under API |

### Tests (executed)

| Suite | Result |
|---|---|
| server (`npm test`) | 63/63 pass: 50 existing + 13 new |
| Mutation check | With `installRequestGuard` commented out, 7 of the 13 security tests fail. The 6 that still pass are helper and allowed-path tests. Guard restored afterwards |
| analyzer-ui | 5/5 pass |
| analyzer-java (`mvn test`) | 17/17 pass (GoldenFixtureTest 10, UnitTest 7); the DebugProbeTest report is a known stale artefact |
| Typechecks | server, web and analyzer-ui clean |

### Live verification (restarted API on 127.0.0.1:4317)

| Check | Result |
|---|---|
| Audit reproduction: source read with `Host: attacker.example:4317` | **403** `Forbidden host…`, no source in the body (was 200) |
| Same read, normal Host | 200 |
| `Origin: http://evil.example` / `Origin: http://127.0.0.1:5173` | 403 / 200 |
| POST `/defect/match` with `text/plain` | 415 |
| `JCI_HOST=0.0.0.0` | Startup refused ("Refusing to listen on…") |
| Vite `:5173`, forged Host (page and proxied `/api`) | 403 / 403 |
| Proxied `/api/v1/health` | 200 |
| `Access-Control-*` headers on an allowed response | none |
| Browser (built-in pane, via Vite) | Search, node, graph (35 nodes / 57 edge paths in the DOM), source and POST `/impact` all 200, nothing blocked |
| JustPerform-Core / UI `git status` checksums | Unchanged (`b0496fd1…` / `d41d8cd9…`) |

`.gitignore` check: a throwaway `--git-dir` in `%TEMP%` (deleted afterwards) with `--work-tree` pointing at the tool gives **155 files, 1.2 MB**.

- **Excluded:** no database, WAL, log, credential or `workspace/` file is in the set, and no file is over 1 MB.
- **NDJSON:** only `server/test/data/*.ndjson`.
- **Secret-pattern hits:** only deliberate redaction test data, such as the fixture's fake `sk_live_SHOULD_NEVER_APPEAR_IN_OUTPUT`.

### Remaining risks

- Visual edge rendering is still unverified. Edge paths exist in the DOM, but the graph canvas looked empty in the narrow, scaled pane. This is scheduled for Phase F.
- Origins not on the allow-list (e.g. `vite preview` on 4173) get 403 until they are added to `JCI_ALLOWED_ORIGINS`.
- There is no authentication against other local processes; this is accepted and documented.
- The tool still has no version control until `git init` is approved.
