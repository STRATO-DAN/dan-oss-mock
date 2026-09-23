<div align="center">

<img src="assets/dan-mark.svg" alt="[DAN] MOCK" width="84" height="84">

# [DAN] MOCK

**Local-first API mocking — define a response, hit the URL. No backend to deploy.**

[![CI](https://github.com/STRATO-DAN/dan-oss-mock/actions/workflows/ci.yml/badge.svg)](https://github.com/STRATO-DAN/dan-oss-mock/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@strato-dan/mock.svg)](https://www.npmjs.com/package/@strato-dan/mock)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-2e9e56.svg)](#dependencies)
[![docs](https://img.shields.io/badge/docs-README-blue.svg)](#use)
[![license](https://img.shields.io/badge/license-MIT-informational.svg)](LICENSE)

</div>

> **⚡ Zero install · zero runtime dependencies.** No `npm install`, no build step, no config —
> `npx @strato-dan/mock` runs it and `npm test` tests it. Pure Node standard library (Node ≥ 18).
> Full breakdown under [Dependencies](#dependencies).

> 🔴 **Split trust model, stated plainly, not left for you to discover.** The management API
> (`/_mock/api/*`) **requires a bearer token** (printed once on stderr at startup, or your own
> 32+ character `DAN_OSS_MOCK_TOKEN`; browser cross-origin management requests are refused).
> The **mocked routes themselves are unauthenticated, by design** — they simulate real backends.
> Localhost is not a security boundary — another local process can reach a loopback port too.
> This is fine for its actual job (a local dev mock), and wrong for anything else: **never**
> bind it beyond `127.0.0.1`, **never** expose it through a reverse proxy or tunnel, and
> **never** point it at real production traffic, secrets, or data.

Local-first API mocking. Define a response, hit the URL — no backend to deploy, nothing to
configure beyond the route itself.

## Use

```bash
npx @strato-dan/mock
```

Opens the management UI at `http://127.0.0.1:4871/_mock` (loopback only). Add a route — method,
path, status, JSON body, optional delay — and it's live immediately at that same origin:

```bash
curl http://127.0.0.1:4871/api/users
```

Routes are saved to `.dan-oss-mock.json` in whatever directory you ran the tool from, so they
survive a restart.

## Worked example

Everything below is real output from a live run on loopback — start the server, define one route
through the management API, hit it, then hit a path that has no mock. `DAN_OSS_MOCK_PORT` here just
picks a non-default port for the demo; from a published install the start command is
`npx @strato-dan/mock`, and from a checkout it's `node bin/dan-oss-mock.js` as shown.

**1. Start it.** Routes persist to `.dan-oss-mock.json` in the directory you launch from, and the
`/_mock` UI opens in your browser automatically:

```console
$ DAN_OSS_MOCK_PORT=4899 node bin/dan-oss-mock.js
[DAN] MOCK running at http://127.0.0.1:4899
Manage routes at: http://127.0.0.1:4899/_mock
Routes saved to: <the directory you launched from>/.dan-oss-mock.json
Ctrl-C to stop.
```

**2. Define a route** through the management API (the same API the UI uses). The response echoes
back the fully-normalized route the store saved — note the generated `id` and `createdAt`:

```console
$ curl -s -X POST http://127.0.0.1:4899/_mock/api/routes \
    -H 'content-type: application/json' \
    -d '{"method":"GET","path":"/api/users","status":200,"body":"[{\"id\":1,\"name\":\"Ada\"}]"}'
{"ok":true,"route":{"id":"82995f70-45bf-49db-8230-e5b2aebdd632","method":"GET","path":"/api/users","status":200,"headers":{},"body":"[{\"id\":1,\"name\":\"Ada\"}]","delayMs":0,"enabled":true,"createdAt":"2026-09-13T17:13:46.404Z"}}
```

**3. Hit the mock** — it's live immediately at the same origin:

```console
$ curl -s -i http://127.0.0.1:4899/api/users
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
Date: Sun, 13 Sep 2026 17:14:00 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked

[{"id":1,"name":"Ada"}]
```

**4. A path with no mock** gets an honest 404 that names the method and path — never a silent
empty 200:

```console
$ curl -s -i http://127.0.0.1:4899/api/nope
HTTP/1.1 404 Not Found
content-type: application/json; charset=utf-8
Date: Sun, 13 Sep 2026 17:14:00 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked

{"ok":false,"reason":"[DAN] MOCK: no real route configured for GET /api/nope. Define one at /_mock."}
```

Stop it with Ctrl-C. (The `Date` header and the generated `id`/`createdAt` naturally differ on
your run; everything else reproduces exactly.)

## Examples

[`examples/programmatic-mock.mjs`](examples/programmatic-mock.mjs) seeds real routes and starts a
real server directly via `RouteStore`/`listen`, without touching the `/_mock` UI at all — useful
for seeding mocks in a test setup. It proves itself with two real requests before shutting down:

```console
$ node examples/programmatic-mock.mjs
Seeded 2 real routes into .../examples/example-routes.json
Mock server listening on http://127.0.0.1:4880
GET /api/users -> 200 [ { id: 1, name: 'Ada' } ]
GET /api/does-not-exist -> 404 {"ok":false,"reason":"[DAN] MOCK: no real route configured for GET /api/does-not-exist. Define one at /_mock."}
```

## Path matching

- `/api/users` — matches that exact path only.
- `/api/users/*` — matches that path as a prefix (anything after `*`).

First enabled, matching route wins, in the order you added them — same "first match wins" rule
any real router uses.

Matching is **literal**, so a trailing slash is significant: `/api/users` and `/api/users/` are
two different paths and will not match each other. This is deliberate (the same honest,
no-surprises exact matching the rest of the tool uses) — if you need both, define both, or use a
trailing-`*` prefix (`/api/users*`).

A request that matches nothing gets a real, honest 404 naming the method and path that had no
mock — never a silent empty response.

## Configuration

| Env var | Default | What it does |
|---|---|---|
| `DAN_OSS_MOCK_PORT` | `4871` | Local port (serves both the mocked API and the `/_mock` UI) |
| `DAN_OSS_MOCK_DATA` | `.dan-oss-mock.json` in the current directory | Where routes are saved |

## Command-line flags

All flags are hand-rolled with the Node standard library — no argument-parsing dependency. The
no-flag invocation is unchanged.

| Flag | What it does |
|---|---|
| `--version` (`-v`) | Print the version and exit `0`. |
| `--help` (`-h`) | Print usage, the env vars above, and the exit-code contract, then exit `0`. |
| `--json` | Start normally, but print the startup banner as **one JSON object** `{url,port,dataFile}` on stdout instead of the human-readable lines — and skip the browser auto-open. Everything else is identical. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean start (or `--version` / `--help`). |
| `1` | Startup failure — the port is already in use, or the data-file path is unusable (missing directory, not writable, or a directory itself). A single-line reason goes to stderr; never a raw stack. |
| `2` | Usage error — an unknown flag. |

The runtime `uncaughtException` / `unhandledRejection` guards that keep the server *alive* after a
bad route are unrelated to these — those are about surviving a bad request, this is about failing a
bad *startup* honestly.

## Scriptable & CI

MOCK is a plain, dependency-free CLI, so it drops straight into a script or CI step. The `--json`
banner is machine-parseable, and the exit codes above mean a failed start actually fails the step:

```bash
# Launch on a chosen port and read the banner back in a script:
DAN_OSS_MOCK_PORT=4899 node bin/dan-oss-mock.js --json
# -> {"url":"http://127.0.0.1:4899","port":4899,"dataFile":".../.dan-oss-mock.json"}
```

A [`Makefile`](Makefile) wraps the common tasks (run `make` on its own for the list):

| Target | What it does |
|---|---|
| `make test` | Run the full unit suite (`node --test`). |
| `make attack` | Run **only** the adversarial/hardening tests — malformed route → `400`, DNS-rebind → `403`, CRLF header-injection reject, corrupt-data-file tolerance, crash-survival of a pre-persisted bad route, and the `delayMs` cap. |
| `make demo` | A reproducible end-to-end run on an ephemeral port and a throwaway data file: define a route, hit it, then show the honest JSON 404. |
| `make bench` | Serving latency and match-cost scaling at 1 / 100 / 1000 routes — see [BENCHMARKS.md](BENCHMARKS.md). |

**Try the attacks:** `make attack` runs the hardening suite on its own so you can see the tool
survive the malformed input it's built to survive.

## What it never does

- Never listens on anything but `127.0.0.1`.
- Never guesses a response for an unmatched route — a real 404 instead.
- Never loses a route to a crash mid-save — writes are atomic (temp file + rename), and a failed
  write cleans up its own temp file rather than orphaning it.
- Never lets a single malformed route take the process down — an invalid field (bad path, out-of-
  range status, illegal header, absurd delay) is rejected with a `400` at define time, and a bad
  route already on disk from an older build is served as a `500` instead of crashing.

## When to use this

- **Best fit**: local frontend or integration-test development against an API that doesn't exist
  yet, or that you don't want to run for real while iterating — define a route, hit it, done.
- **Best fit**: a quick, zero-backend way to reproduce a specific response (an error code, a slow
  response via `delayMs`, an edge-case payload) without touching the real service.

**Honest flip side**: this isn't a contract-testing framework — there's no schema validation,
no OpenAPI import, no recording/replay of real traffic. Routes live in one local JSON file, so
it's not built for sharing live mock state across a team or CI runners without you wiring that up
yourself (pointing `DAN_OSS_MOCK_DATA` at a shared/committed file works, but isn't automatic).

**One writer at a time.** MOCK is a single-process dev tool. Each write to the data file is atomic
(temp file + rename, so a crash mid-write never corrupts it), but the tool does **not** coordinate
between *separate* processes pointed at the *same* file — if two instances edit routes concurrently,
the last save wins and the other's change is silently overwritten. Run one instance per data file.

## Dependencies

The first question is usually *"how much do I have to install?"* — here, **nothing**.

| | |
|---|---|
| **Runtime dependencies** | **0** — Node standard library only (`http`, `fs`, `path`, …) |
| **Install to run** | none — `npx @strato-dan/mock` |
| **Install to test** | none — `npm test` uses Node's built-in test runner |
| **Node** | ≥ 18 |
| **Dev-only** | `husky` — pulled in *only* if you clone to contribute (it wires the git hooks); never needed to use the tool |

`npx` fetches this one package — there's no dependency tree to resolve — and runs it. Nothing is
added to your project, and nothing phones home.

## Project contents

| Path | What it is |
|---|---|
| `bin/dan-oss-mock.js` | The real CLI entry point — starts the server, opens the `/_mock` UI. |
| `src/server.js` | The loopback-only HTTP server: mocked routes + the `/_mock` management API. |
| `src/store.js` | `RouteStore` — the real, atomic-write JSON persistence for routes. |
| `src/matcher.js` | `findMatch` — the real exact/prefix path-matching logic, nothing else. |
| `public/` | The plain HTML/CSS/vanilla-JS management UI served at `/_mock`. |
| `examples/` | Runnable example code seeding routes programmatically, no UI. |
| `test/` | Real unit tests (`npm test`, Node's own built-in test runner). |

## FAQ

**Can I mock a response body that isn't JSON?** Yes — `body` is stored and served exactly as
given; it doesn't have to parse as JSON. The management UI's own editor is JSON-shaped because
that's the common case, not a hard requirement of the store or matcher.

**Can two routes match the same request?** The first enabled, matching route (in the order it was
added) wins — later matching routes are simply never reached. This is deliberate, real
first-match-wins behavior, not a bug; reorder by removing and re-adding if you need a different
priority.

**Does it support wildcards other than a trailing `*`?** Not yet. Path matching is deliberately
just exact-or-prefix — a real, current limitation, not a design decision to rule out real regex
matching forever if there's genuine demand.

**Can routes be shared across machines/CI?** Not directly — `.dan-oss-mock.json` is a local file.
You can commit it to your own project and point `DAN_OSS_MOCK_DATA` at it, which works today, but
there's no built-in export/import or remote-sync feature.

## Tests

```bash
npm test
```

Runs the unit suite on Node's own built-in test runner (`node --test`) — no `npm install`, no
dependencies to pull. As of this release that's **44 tests, all passing**: six cover the path
matcher (exact vs. trailing-`*` prefix, method matching, disabled routes, and first-match-wins
order), fifteen cover the route store (defaults, field validation, the `delayMs` cap, atomic-write
save/reload round-trip and temp-file cleanup on a failed rename, update, remove, and recovering
from a corrupt data file), seventeen exercise the HTTP layer (the `/_mock` management API,
delay-timing accuracy, in-flight route mutation, input validation and content-type over real HTTP,
CRLF header-injection rejection, and resilience — a route persisted by an older build is served as
a 500, never a process crash),
and six cover the launcher CLI (`--version`, `--help`, `--json` banner, an unknown-flag usage error,
and the startup exit-code contract for a port already in use and an unusable data-file path).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)
for how to file an issue or submit a PR. Maintainers may use AI tools to help review
contributions — please don't include personal information in an issue, PR, or commit beyond
what's needed to describe the change.

## Releasing

See [RELEASING.md](RELEASING.md) —
the same version-bump/tag/publish process applies to every DAN-OSS tool, this one included.

## License

MIT (code) — see `LICENSE`. The "DAN" name and logo are trademarked and not covered by the MIT
grant — see `TRADEMARK.md`.

---

**[DAN] MEMORY SMASH** — the full codebase-memory engine this tool's mocking capability also lives
inside — is coming soon.
