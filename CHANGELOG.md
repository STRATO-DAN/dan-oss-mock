# Changelog

All notable changes to `@strato-dan/mock` are documented here.
This project uses [semantic versioning](https://semver.org/).

## [0.3.1] — 2026-09-21

### Fixed

- **Global in-flight body budget actually wired in.** `MAX_INFLIGHT_BYTES` existed but wasn't
  charged against per-request reads — many concurrent bodies just under the per-request cap could
  still add up to hundreds of MiB with no aggregate limit enforced. `readBody` now charges/releases
  against the real global budget (settle-once, env-overridable via `DAN_OSS_MOCK_MAX_INFLIGHT`),
  tripping a 413 instead of buffering unbounded.
- **Content-Length pre-check.** A declared-oversize body is now refused (413) before reading a
  single byte, instead of only after buffering up to the per-request cap.
- README/SECURITY now describe the real split trust model explicitly: bearer-authed management
  API, unauthenticated mock surface by design (matches the 0.3.0 change, docs hadn't caught up).

## [0.3.0] — 2026-09-19

### Security — breaking

- **The management API now requires a bearer token.** Previously any local process/browser page
  could add, edit, or delete mocked routes with no credential at all. A random 32+ byte token
  (or `DAN_OSS_MOCK_TOKEN`) is now printed on stderr at startup and required (constant-time
  checked) on every `/_mock/api/*` call, plus a same-origin/`Sec-Fetch-Site` cross-site guard and a
  content-type gate on writes. **Mocked routes themselves remain unauthenticated, by design,
  unchanged.**
- Concurrently-held artificial response delays are now capped (`DAN_OSS_MOCK_MAX_DELAYS`, default
  20; over it, 503) instead of unbounded concurrent sleeping sockets.
- Total routes/state size is now bounded (`MAX_ROUTES` 200, `MAX_STATE_BYTES` 5MB).
- The persisted state file is now 0600 (owner-only).

## [0.2.0] — 2026-09-17

Cross-cutting polish. All additive — no behavior change to existing routes, and still **zero runtime
dependencies** (Node standard library only).

### Added
- **Launcher flags (hand-rolled, no dependency).** `--version` (`-v`) prints the version and exits
  `0`; `--help` (`-h`) prints usage, the environment variables, and the exit-code contract, then
  exits `0`; `--json` prints the startup banner as one JSON object `{url,port,dataFile}` (and skips
  the browser auto-open) for scripts and CI. The no-flag invocation is unchanged.
- **Honest startup exit codes.** A startup failure — port already in use (`EADDRINUSE`), or an
  unusable data-file path (missing directory, not writable, or a directory itself) — now prints a
  single-line reason to stderr and exits `1`, never a raw stack. An unknown flag is a usage error and
  exits `2`. A clean start (or `--version`/`--help`) is `0`. Documented in the README. The runtime
  `uncaughtException`/`unhandledRejection` guards that keep the server *alive* after a bad request are
  untouched — this is only about failing a bad *startup* honestly.
- **`Makefile` with `make help`.** `make test` (full suite), `make attack` (only the adversarial
  hardening tests — malformed route → `400`, DNS-rebind → `403`, CRLF header-injection reject,
  corrupt-data-file tolerance, crash-survival of a pre-persisted bad route, the `delayMs` cap),
  `make demo` (a reproducible end-to-end run on an ephemeral port and a throwaway data file), and
  `make bench`.
- **`make bench` + [BENCHMARKS.md](BENCHMARKS.md).** Real, reproducible measurements: serving latency
  over live loopback HTTP, and `findMatch()` cost scaling at 1 / 100 / 1000 configured routes
  (worst-case full scan). Node stdlib only; runs in well under a second.
- **README: Command-line flags, Exit codes, and a Scriptable & CI section**, plus a "Try the attacks:
  `make attack`" pointer and a link to the benchmarks.
- **Six launcher-CLI regression tests** covering the flags and the startup exit-code contract.

### Notes / honest limits
- Still **no authn/authz by design** — a local dev tool bound to `127.0.0.1`. Nothing here adds a
  trust boundary; it is CLI ergonomics, tooling, and docs.
- 35 → 41 tests.

## [0.1.2] — 2026-09-17

### Fixed
- **Self-reinflicting crash from an unvalidated route (M1, high).** `add()`/`update()` validated
  nothing and the serve path had no error isolation, so a single bad field could crash the process
  — and because the bad route was *persisted*, a restart re-loaded it and re-crashed (a
  self-reinflicting DoS). A non-string `path` threw in the matcher, an out-of-range `status` threw
  in `res.writeHead`, and an illegal header name/value threw `ERR_INVALID_CHAR`/`ERR_INVALID_HTTP_TOKEN`.
  Now: `add()`/`update()` **validate every field** (path is a non-empty string, status an integer
  100–599, header names/values legal) and reject a bad one with a clean `400` before anything is
  stored; the mocked-route serve block is wrapped so a route **already on disk** from an older build
  is served as an honest `500` instead of crashing; and a top-level `uncaughtException`/
  `unhandledRejection` guard keeps the dev server alive as a last resort. Regression tests cover each
  bad-field vector and a persisted-bad-route reload that must not crash.
- **Unbounded `delayMs` (M2, medium).** `delayMs` was only lower-bounded, so an absurd value could
  tie a socket up effectively forever and, past ~2³¹ ms, overflow `setTimeout`'s 32-bit delay and
  misfire immediately. It is now capped at 60s (add and update). Regression added.
- **String bodies mislabeled as JSON (M4, low).** The mocked-route response forced
  `application/json` even for a plain-string body. It now defaults to `text/plain` for a string body
  and `application/json` for an object/array, while a `content-type` the route sets itself (any
  casing) still wins. Regression added.
- **Orphaned temp file on a failed save (M5, low).** A failed `writeFile`/`rename` left the atomic
  temp file behind. The temp is now unlinked (best-effort) on failure before the error is rethrown.
  Regression added.

### Documented
- **Trailing-slash matching (M3).** Matching is literal; `/api/users` and `/api/users/` are distinct
  paths and do not match each other. Documented in *Path matching* (kept literal by design rather
  than silently normalized).
- **Multi-process last-write-wins (M6).** MOCK is a single-process tool; two instances on the same
  data file do not coordinate and the last save wins. Documented under *When to use this*.

### Notes / honest limits
- Still zero runtime dependencies, and still **no authn/authz by design** — these are input-
  validation and error-isolation fixes that harden the tool against a bad route (including its own
  self-inflicted one), not a new trust boundary. Localhost remains the only supported binding.
- 24 → 35 tests.

## [0.1.1] — 2026-09-16

### Fixed
- **Concurrent-persistence hazard (V3 review).** `save()` used one per-process temp path
  (`.<file>.<pid>.tmp`), so overlapping saves shared it and could race the rename — the rename that
  lands last wins the file, even if it reflects a staler route set. Atomic replacement is not atomic
  *concurrent* persistence. Saves are now **serialized** (each waits for the previous, so the last
  write reflects the latest routes) and use a **per-write unique temp name**, so two in-flight
  writers never collide on the temp path. New concurrency regression: 30 overlapping `add()` +
  `save()` calls, then reload from disk — all 30 persist, none lost to a temp collision.

### Added
- **HTTP-level coverage for the `/_mock` management API and delay simulation** — previously zero.
  Full CRUD round-trip, disabled-route enforcement, delay-timing accuracy (measured, not just
  stored), negative-`delayMs` normalization, and route mutation (delete/update) while a delayed
  response is in flight. 13 → 23 tests.

### Notes / honest limits
- This is a robustness fix, not a new trust boundary. MOCK's local management API has no
  authn/authz by design for a dev mock — localhost is not the security boundary here, and nothing
  in 0.1.1 claims otherwise.

## [0.1.0]
- Initial release: local-first API mocking — define a response, hit the URL. No backend to
  deploy. Loopback-only, zero runtime dependencies.
