# server — Hono HTTP layer

Owns: `server/**`, `scripts/dev.mjs`, `tests/server/**`.

## Running

- `npm run dev` → `scripts/dev.mjs` spawns `node --watch --import tsx/esm server/cli.ts --no-open`
  (`CCA_DEV=1`) and the local Vite CLI using the same Node executable (port 5173, proxies `/api`
  to 4141). Open http://127.0.0.1:5173/. The runner rejects unsupported Node versions before
  starting either process; run `nvm use` in the same shell if Node 23 is selected. Vite starts
  only after the API reports it is listening. If the API does not start within 30 seconds, the
  runner exits instead of leaving Vite serving repeated `ECONNREFUSED` proxy errors; the
  underlying startup error remains visible in the `[server]` output.
  The runner honors nvm's explicit `NVM_BIN/node` selection first, then `npm_node_execpath`,
  relaunching if necessary. This handles a PATH entry shadowing nvm's Node for both npm and
  its scripts. It does not change the terminal's default Node version. Supported runtimes
  are Node 22.13+ (22.x) and Node 24+, matching `package.json`; Node 22 is the `.nvmrc` default.
  It is deliberately not `tsx watch`: that CLI opens a unix domain socket to its child, which
  sandboxed shells refuse with `EPERM`. `tsx/esm` is the loader half only.
- `npm start` → runs the built `dist/server/cli.js` directly (production: one process on 4141).
- `npm run reindex` → `tsx server/cli.ts --reindex --no-open`: full rebuild, prints a line count,
  exits. Does not start the HTTP server. (`node --import tsx/esm server/cli.ts --reindex
  --no-open` is the equivalent that works without the `tsx` CLI's unix socket.)
- CLI flags: `--port <n>` (default `4141`/`CCA_PORT`), `--no-open`, `--claude-dir <path>`
  (overrides configured roots, also `CCA_CLAUDE_DIR`), `--home <path>` (overrides `CCA_HOME`),
  `--reindex`, `--demo` (see below).
- `--demo [--seed <n>] [--sessions <n>]` — serves the synthetic dataset instead of the user's real
  transcripts, generating it first if `<CCA_HOME>/demo/projects` doesn't exist yet
  (`core/demo/generate.ts`; defaults to the generator's own seed/session count when `--seed`/
  `--sessions` are omitted). Mutually exclusive with `--claude-dir`. Serves exactly as
  `--claude-dir <CCA_HOME>/demo/projects --home <CCA_HOME>/demo/home` would — a dataset and DB
  entirely separate from the user's real one, which this flag never reads or writes. See
  `docs/dev/demo.md` for the on-disk layout and the (pre-existing, separate) `scripts/demo.mjs`/
  `npm run demo`, which does the same thing against the **built** server and is a better fit for
  screenshots/recordings; `--demo` here is for a quick `npm run dev`-style look without a build.

## Layout

- `paths.ts` — resolves `CCA_HOME` (default `~/.claude-cost-analyzer`), `index.sqlite`,
  `config.json`, and transcript roots. `~` expansion, 0700/0600 permissions, path-traversal guard
  (`isInside`) used by `static.ts`.
- `config.ts` — `ConfigStore`: loads/validates/persists `config.json` (`{ pricing, settings }`),
  atomic writes (tmp + rename), `updatePricing`/`resetPricing`/`updateSettings`/`togglePin`.
  Corrupt or schema-invalid config falls back to defaults (`store.warnings`), never crashes.
- `warnings.ts` — filters the one `node:sqlite` `ExperimentalWarning` (SPEC §1.8). It must be the
  **first** import of `cli.ts` and of `worker.ts`: ES modules evaluate imports before the importing
  module's own statements, so a filter written at the top of `cli.ts` runs after `node:sqlite` has
  already loaded and warned. Worker threads get their own warning listeners, which is why the
  worker imports it too (the only `server/` module it may import — it has no dependencies).
- `auth.ts` — `hostGuard` (Host allow-list + Sec-Fetch-Site + Origin, all `/api/*`),
  `sessionAuth` (cookie check, all `/api/*` except `/api/auth/session`; `CCA_ALLOW_UNAUTH_STATUS=1`
  exempts `GET /api/status`), `securityHeaders` (nosniff/CSP/no-referrer/no-store on `/api`).
  One random 32-byte token per process, compared with `timingSafeEqual`. In dev (`CCA_DEV=1`),
  `CCA_DEV_ORIGINS` adds comma-separated extra dev origins to both the Host and Origin lists for
  people running a second Vite server; entries that are not `http(s)` URLs on a loopback host with
  an explicit port are dropped, so a typo cannot widen the allow-list to a routable address.
- `rootsPolicy.ts` — `validateRoots(roots, ccaHome, previousRoots?)`, called from
  `routes/settings.ts` on every `PUT /api/settings`. Rejects a root that isn't an existing
  directory (grandfathered for a root that was already saved and has since disappeared — an
  unrelated settings change, e.g. a theme toggle, must not be blocked by an unmounted drive) or
  that is/contains a sensitive system or credential location (always enforced, no grandfather).
  See "Security model" below.
- `schemas.ts` / `validate.ts` — zod schemas for every query/body, plus `parseQuery`/`parseParams`/
  `parseJsonBody` returning `{ ok: true, data }` or `{ ok: false, response }` (a ready 400
  `Response`, never echoing the raw input).
- `routes/*.ts` — one file per resource; each takes `AppDeps` and returns a `Hono` sub-app mounted
  in `app.ts`. Errors always `{ error: { code, message } }`.
  `routes/status.ts` also fills `StatusResponse.scratchSessions`: `Store.status()` counts rows and
  knows nothing about `hideScratchProjects`, so the route calls `store.listProjects` once more
  with a `QueryContext` whose `settings.hideScratchProjects` is forced to `false` and sums the
  `sessionCount` of the scratch subtree. It runs only while the setting is on, and the field is
  omitted otherwise, so "no scratch filtering" costs nothing.
- `indexing.ts` + `worker.ts` — `IndexManager`: spawns a `worker_threads` Worker per run
  (`worker.ts`), single-flight (`requestFull`/`requestRescan`/`requestIncremental` while a run is
  in progress get coalesced — `full` > `rescan` > `incremental` priority), forwards `progress`
  events to the injected `broadcast`. Worker path resolves relative to `import.meta.url`: `.ts`
  (tsx dev) spawns with `execArgv: ['--import','tsx/esm']`, `.js` (built) spawns plain.
  `IndexManagerOptions` also takes `pricing: () => PricingConfig` (read at the start of every run
  and sent to the worker — indexing needs it for `charsPerToken` in attribution) and an optional
  `onRunComplete(mode, result)`, which `server/index.ts` uses to call `store.reopen()` after a
  `full` rebuild.
- `sse.ts` — `GET /api/events`, 15s ping, per-client write queue via `hono/streaming` `streamSSE`,
  cleaned up on abort. `closeAll()` ends every client itself for shutdown (see "Shutdown" below).
- `watcher.ts` — `fs.watch(root, { recursive: true })` per root, 3s per-file quiet period, batches
  settled paths into `IndexManager.requestIncremental`. Missing roots are logged and skipped, not
  fatal.
- `shutdown.ts` — `createShutdown(deps)`: the `RunningServer.close()` sequence, pulled out of
  `index.ts` so it can be unit-tested against fakes (see "Shutdown" below).
- `static.ts` — serves `dist/web` (resolves to the same directory whether running from
  `server/static.ts` via tsx or `dist/server/static.js`), immutable caching under `/assets/`, SPA
  fallback to `index.html` for other non-`/api` GETs, traversal-safe (`isInside`). When `dist/web`
  does not exist yet, **every route** (any path without a file extension, plus `/index.html`)
  returns the short "run `npm run build`" notice rather than only `/` — reloading `/sessions`
  after `npm start` without a build used to answer a bare `not found`. Requests that look like
  assets still fall through, so a missing file reads as missing.
- `app.ts` — `createApp(deps)`: security headers → hostGuard → auth-session route →
  sessionAuth → API routes → static/SPA. `deps.staticRoot` is test-only (real callers omit it).
- `index.ts` — `startServer(opts)`: wires the real `Store`/`ConfigStore`/`IndexManager`/watcher,
  binds `@hono/node-server` to `127.0.0.1`, returns `{ url, close() }`.
- `cli.ts` — flag parsing, `--reindex` short-circuit (passes the user's `PricingConfig` into
  `runIndex`), opens the browser (`open`, macOS only, unless `--no-open`), graceful
  SIGINT/SIGTERM shutdown with a hard fallback exit timer and immediate exit on a second signal
  (see "Shutdown" below), and turns `SqliteFeatureError` into one plain line + exit 1 (the
  wrong-Node-build case). Warning filtering lives in `warnings.ts`, imported first.

## Shutdown

`cli.ts` catches `SIGINT`/`SIGTERM`, logs one `received <signal>, shutting down` line, and calls
`RunningServer.close()` (built by `server/shutdown.ts`'s `createShutdown`). Order matters and is
what fixed a real hang + a burst of `unhandled error in request handler` logs on Ctrl-C:

1. `watcher.dispose()` and `index.dispose()` (terminates the indexing `Worker`) stop any new work.
2. `sse.closeAll()` ends every open `/api/events` stream *itself* — writes a `bye` frame, then
   closes the writer — instead of leaving an SSE connection for `server.close()` to wait on
   forever (an `EventSource` never closes its side first). `StreamingApi.write`/`writeSSE`
   already swallow their own errors, so this never throws back into the request handler.
3. `server.close(cb)` stops accepting new connections; `closeIdleConnections()` /
   `closeAllConnections()` (Node 18.2+ `http.Server` methods, feature-detected since the
   `ServerType` union also covers `Http2Server`, which lacks them — this app never turns on
   HTTP/2) force-drop anything still open rather than wait on it.
4. `store.close()` runs **last**, only after every connection is confirmed gone. Closing it any
   earlier is what produced the `unhandled error in request handler` lines: an in-flight (or
   force-aborted) request calling into a Store whose DB handle had already been closed underneath
   it.

`cli.ts` also sets an unref'd `setTimeout(() => process.exit(0), 3_000)` as a fallback in case some
unforeseen handle keeps step 3 from resolving, and a second `SIGINT`/`SIGTERM` while a shutdown is
already in progress exits immediately rather than waiting out that fallback.

`createShutdown` takes its five dependencies (`watcher`, `index`, `sse`, `store`, `server`) as a
plain object so `tests/server/shutdown.test.ts` can exercise the whole sequence — including
ordering and the `Http2Server`-shaped server without `closeAllConnections` — against fakes, with
no real `listen()`.

## Wiring notes

- `createApp(deps: AppDeps)` is the thing to mount/test. `AppDeps` = `{ store, config, index, sse,
  roots, port, dev, version, ccaHome, staticRoot? }`. `ccaHome` is the resolved, absolute `CCA_HOME`
  (from `paths.ts`); `routes/settings.ts` needs it to keep a new `settings.roots` entry from
  pointing back at the app's own config/DB directory. `store: Store`, `config: ConfigStore` (real class, not
  just the interface — routes call `config.get()/.updatePricing()/...` directly). `roots` is the
  **resolved** root list: `GET /api/status` reports it, because `--claude-dir`/`CCA_CLAUDE_DIR`
  override `settings.roots` and the status pill must show what is actually indexed.
- `IndexManagerLike` (in `indexing.ts`) has `status()`, `requestFull()`, `requestRescan()`,
  `requestIncremental(paths)`, `dispose()`. `requestRescan` runs `runIndex({ full: false })`
  (mtime/size diff across all roots, no explicit path list) — used at boot and for
  `POST /api/reindex` without `{ full: true }`. `requestFull` runs `runIndex({ full: true })`
  (drop + rebuild). `requestIncremental(paths)` runs `indexChangedFiles(paths, …)` (watcher path).
- `createStore(dbPath: string): Store` from `core/db/store.js` is a synchronous factory, as
  assumed; `core/db` landed with the exports in `core/store.ts` and this module typechecks
  against them unchanged.
- `GET /api/sessions/:id`, `/transcript`, `/agents` and `GET /api/export/sessions/:id.json` read
  `?whatIf=` and pass it through `queryContext(config, whatIf)` onto `QueryContext.whatIf`, since
  those four routes have no `RangeQuery` to carry it. Everything else passes its query object
  straight to the Store.

## Gotchas

- `server/worker.ts` must stay free of any import from the rest of `server/` (besides types) —
  it runs in an isolated worker thread.
- Tests never hit the real DB: `tests/server/fake-store.ts` implements `Store` in memory;
  `ConfigStore` tests use a real temp `CCA_HOME` (`mkdtempSync` under `os.tmpdir()`, cleaned up in
  `afterEach`).
- `sessionAuth` special-cases the literal path `/api/auth/session`, not registration order, so it
  works no matter where that route is mounted.

## Security model

This is a single-user, loopback-only tool that indexes and serves the contents of your own Claude
Code transcripts. The threat model is deliberately narrow: **a malicious web page open in the same
browser, or another process on the same machine, trying to read transcript data or repurpose the
indexer** — not a remote attacker (the server only binds `127.0.0.1`) and not a multi-tenant
authorization problem (there is exactly one "user").

**Threats considered and controls:**

- *Another loopback app embedding this UI in an iframe* — opt-in via `CCA_EMBED_ORIGINS`
  (comma-separated loopback parent origins, e.g. `http://127.0.0.1:3000`). Relaxes CSP
  `frame-ancestors` only; does not add CORS or widen Host/Origin checks. Unset keeps
  `frame-ancestors 'none'`.
- *Cross-site request from a page the user has open, or DNS rebinding to `127.0.0.1`* — `hostGuard`
  requires an exact `Host` match against `127.0.0.1:<port>` / `localhost:<port>` (plus the Vite dev
  origin only when `CCA_DEV=1`); rejects any `Sec-Fetch-Site` other than `same-origin`/`none`; and
  rejects an `Origin` that doesn't match. All three fail closed (403) — confirmed against appended
  subdomains, trailing dots, bracketed/unbracketed IPv6 loopback, missing port, mixed case, and
  decimal/octal/short-form IPv4 rewrites of `127.0.0.1`, none of which match the allow-list string.
- *A page that got past hostGuard reading data anyway* — every other route requires the
  `cca_session` cookie (`HttpOnly; SameSite=Strict; Path=/`, never `Secure` — this is plain
  `http://127.0.0.1`, and `Secure` would silently stop the browser from ever sending it), one
  random 32-byte token generated fresh per process and compared with `timingSafeEqual`. A cookie
  from a previous process (or a different port) does not authenticate a new one. `GET /api/status`
  is the sole, opt-in (`CCA_ALLOW_UNAUTH_STATUS=1`) exception, for health checks that run before the
  browser has a cookie; it leaks only counts/paths/version, never transcript content.
- *SQL/FTS injection* — every query is a `node:sqlite` prepared statement; table/column names in
  interpolated SQL are always code-level literals (never request input), verified by reading every
  `${...}` in `core/db/*.ts`. Full-text search wraps the user's query as a single quoted FTS5
  phrase (`ftsPhrase`, doubling embedded quotes) before binding it, so FTS operators (`OR`, `NEAR`,
  column filters, `*`) are inert text, not query syntax — confirmed with a real `node:sqlite` FTS5
  table against `DROP TABLE`, unbalanced quotes, and bare operators: all return zero rows, never a
  500, and the table survives.
- *Header injection / path traversal via user-controlled values* — `GET
  /api/export/sessions/:id.json`'s id is validated as a plain token
  (`/^[A-Za-z0-9._-]+$/`) before it is embedded in `Content-Disposition`, so a quote or CRLF in the
  id 400s instead of breaking out of the header. Static file serving (`static.ts`) normalizes the
  request path and re-checks it with `isInside(webRoot, target)`; `path.normalize`/`path.join` on
  an always-`/`-rooted request path cannot resolve above the root regardless of `../`, encoded
  `%2e%2e`, or doubled slashes (verified). Symlinks placed inside `dist/web` that point outside it
  are not specially detected (same non-goal as the traversal guard's design) but `dist/web` is
  build output, not attacker-writable through this app.
- *`settings.roots` pointed at something sensitive* — see `rootsPolicy.ts`: rejected unless the
  root is an existing directory that is not, and does not contain as an ancestor relationship,
  a fixed list of system directories (`/etc`, `/var`, `/System`, `/Library`, `/root`, `/proc`,
  `/sys`, `/dev`, …) or per-user credential locations (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`,
  `~/.docker`, `~/.npmrc`, `~/.netrc`, `~/.pypirc`, `~/.git-credentials`, `~/.claude` itself, and
  the app's own `CCA_HOME`). `~/.claude/projects` — the documented default root — is explicitly
  carved back out. The "existing directory" half of the check is skipped for a root that was
  already saved and has since disappeared, so an unrelated settings change doesn't get blocked by
  an unmounted drive; the sensitive-location half always runs, on every save, no exceptions.
- *Oversize/malformed request bodies* — `hono/body-limit` caps every `/api/*` body at 1 MiB
  (every real payload — pricing table, settings, `{full}`) is a few KB; a 20 MB body 413s before
  being buffered or parsed. Malformed JSON 400s (`c.req.json()` failure is caught, never a bare
  500). `__proto__`/`constructor` keys in a JSON body are inert: `JSON.parse` creates them as
  ordinary own properties (verified — this is standard JS engine behavior, not something this app
  does), and zod strips unrecognized keys regardless.
- *Information leakage on error* — every route returns `{ error: { code, message } }`; `message`
  is always a fixed string, never the request input, a stack trace, or a DB error. An uncaught
  throw inside a route handler (`app.onError`) is normalized to the same envelope; only the
  error's *constructor name* is logged server-side (e.g. `TypeError`), never `.message`/`.stack`,
  so a bug that surfaced a fragment of transcript content inside an error message can't leak it
  into the log either. `GET /api/status` includes `dbPath` — accepted as fine for a single-user
  local tool (it's the path to the user's own machine's own file) but nothing else there is
  sensitive.
- *Resource exhaustion* — the indexing `Worker` is watched for `message`/`error`/`exit`; a worker
  that dies without ever posting a terminal message (OOM kill, a native crash, `process.exit()`
  inside the worker) is treated as a crash via the `exit` listener, not a silent hang that leaves
  `indexing: true` forever and swallows every future reindex request. SSE (`sse.ts`) frees a
  client's resources the moment its response stream is cancelled (a real disconnect at the
  `@hono/node-server` layer); verified with 50 concurrent connections opened and then cancelled,
  `clientCount()` returns to 0.
- *Silent request misinterpretation* — `POST /api/reindex` reads its body by content, not by
  trusting a `Content-Length` header to decide whether one is present: that header is absent on a
  chunked-transfer request even though the request is not, in fact, bodyless, which used to
  silently downgrade `{ "full": true }` to a plain rescan with a `200 { started: true }` response
  that gave no indication anything had gone differently than asked.

**Non-goals (by design, given the threat model above):**

- No protection against a local, code-executing attacker on the same machine (they already have
  more direct access than this server exposes) or against the OS user account itself.
- No CSRF token beyond the Host/Origin/Sec-Fetch-Site checks — there is nothing session-scoped to
  forge across users, and a same-site/no-header request already has to originate from this origin
  or from no browser context at all.
- No rate limiting: this is a single local client talking to a local server.
- No TLS: loopback-only, no data leaves the machine (SPEC §1.2), so there is no network path to
  encrypt.
