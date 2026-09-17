# Benchmarks

Real numbers from `make bench`, which runs [`scripts/bench.mjs`](scripts/bench.mjs) — Node standard
library only, no dependencies. Two measurements:

1. **Serving latency** — real HTTP round-trips against a live loopback server serving one matched
   route (warm-up excluded), reported as mean / p50 / p99 and sequential throughput.
2. **Match scaling** — the cost of `findMatch()` with 1 / 100 / 1000 configured routes, measured on
   the **worst case** for first-enabled-match-wins: the sought route is placed **last**, so the
   matcher scans the entire list. This isolates match cost from HTTP/socket overhead.

## Reproduce

```bash
make bench
```

Runs in well under a second here; the target ceiling is ~15s. Numbers vary by machine and load — the
shape (constant-ish serving latency; match cost linear in route count) is the point, not the exact
figures.

## Results

Recorded on: **Darwin 25.6.0 arm64, Apple M5 Max, 18 cores, Node v22.23.1.**

### Serving latency — live loopback HTTP, one matched route

| Metric | Value |
|---|---|
| requests | 3000 |
| mean | 0.107 ms |
| p50 | 0.089 ms |
| p99 | 0.322 ms |
| throughput | ~9,300 req/s (sequential, one connection at a time) |

Throughput is measured single-connection, one request at a time — it is a floor, not a
concurrency-tuned ceiling. A local dev mock is latency-bound, and sub-millisecond per request is far
below anything you'd notice while iterating on a frontend.

### Match scaling — `findMatch()`, target route last (full scan)

| Routes | ns / match | matches / sec |
|---|---|---|
| 1 | 10.1 | ~98,800,000 |
| 100 | 336.4 | ~2,970,000 |
| 1000 | 2,137.6 | ~468,000 |

Match cost is linear in the number of configured routes (first-match-wins scans in order), as
expected — and even at 1000 routes a worst-case lookup is ~2 µs, negligible next to the HTTP round
trip. There is no index or precompiled structure by design: the matcher stays simple and honest
(exact-or-trailing-`*`), and the route counts a local dev mock actually holds are small.
