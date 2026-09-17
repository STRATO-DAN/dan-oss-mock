# Changelog

All notable changes to `@strato-dan/mock` are documented here.
This project uses [semantic versioning](https://semver.org/).

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
