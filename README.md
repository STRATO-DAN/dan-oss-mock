<div align="center">

<img src="assets/dan-mark.svg" alt="[DAN] MOCK" width="84" height="84">

# [DAN] MOCK

**Local-first API mocking — define a response, hit the URL. No backend to deploy.**

[![CI](https://github.com/STRATO-DAN/dan-oss-mock/actions/workflows/ci.yml/badge.svg)](https://github.com/STRATO-DAN/dan-oss-mock/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dan-oss-mock.svg)](https://www.npmjs.com/package/dan-oss-mock)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-2e9e56.svg)](#dependencies)
[![docs](https://img.shields.io/badge/docs-README-blue.svg)](#use)
[![license](https://img.shields.io/badge/license-MIT-informational.svg)](LICENSE)

</div>

> **⚡ Zero install · zero runtime dependencies.** No `npm install`, no build step, no config —
> `npx dan-oss-mock` runs it and `npm test` tests it. Pure Node standard library (Node ≥ 18).
> Full breakdown under [Dependencies](#dependencies).

Local-first API mocking. Define a response, hit the URL — no backend to deploy, nothing to
configure beyond the route itself.

## Use

```bash
npx dan-oss-mock
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
`npx dan-oss-mock`, and from a checkout it's `node bin/dan-oss-mock.js` as shown.

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

A request that matches nothing gets a real, honest 404 naming the method and path that had no
mock — never a silent empty response.

## Configuration

| Env var | Default | What it does |
|---|---|---|
| `DAN_OSS_MOCK_PORT` | `4871` | Local port (serves both the mocked API and the `/_mock` UI) |
| `DAN_OSS_MOCK_DATA` | `.dan-oss-mock.json` in the current directory | Where routes are saved |

## What it never does

- Never listens on anything but `127.0.0.1`.
- Never guesses a response for an unmatched route — a real 404 instead.
- Never loses a route to a crash mid-save — writes are atomic (temp file + rename).

## When to use this

- **Best fit**: local frontend or integration-test development against an API that doesn't exist
  yet, or that you don't want to run for real while iterating — define a route, hit it, done.
- **Best fit**: a quick, zero-backend way to reproduce a specific response (an error code, a slow
  response via `delayMs`, an edge-case payload) without touching the real service.

**Honest flip side**: this isn't a contract-testing framework — there's no schema validation,
no OpenAPI import, no recording/replay of real traffic. Routes live in one local JSON file, so
it's not built for sharing live mock state across a team or CI runners without you wiring that up
yourself (pointing `DAN_OSS_MOCK_DATA` at a shared/committed file works, but isn't automatic).

## Dependencies

The first question is usually *"how much do I have to install?"* — here, **nothing**.

| | |
|---|---|
| **Runtime dependencies** | **0** — Node standard library only (`http`, `fs`, `path`, …) |
| **Install to run** | none — `npx dan-oss-mock` |
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
dependencies to pull. As of this release that's **13 tests, all passing**: six cover the path
matcher (exact vs. trailing-`*` prefix, method matching, disabled routes, and the first-match-wins
order), and seven cover the route store (defaults, atomic-write save/reload round-trip, update,
remove, and recovering from a corrupt data file).

## Contributing

See the org-level [CONTRIBUTING.md](https://github.com/STRATO-DAN/.github/blob/main/CONTRIBUTING.md)
for how to file an issue or submit a PR. Maintainers may use AI tools to help review
contributions — please don't include personal information in an issue, PR, or commit beyond
what's needed to describe the change.

## Releasing

See the org-level [RELEASING.md](https://github.com/STRATO-DAN/.github/blob/main/RELEASING.md) —
the same version-bump/tag/publish process applies to every DAN-OSS tool, this one included.

## License

MIT (code) — see `LICENSE`. The "DAN" name and logo are trademarked and not covered by the MIT
grant — see `TRADEMARK.md`.

---

**[DAN] MEMORY SMASH** — the full codebase-memory engine this tool's mocking capability also lives
inside — is coming soon.
