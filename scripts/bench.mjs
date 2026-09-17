#!/usr/bin/env node
// `make bench` — two real, fast measurements, printed as plain numbers. Zero dependencies (Node stdlib).
//
//   1. Serving latency: real HTTP round-trips against a live loopback server serving one matched route.
//   2. Match scaling:   the cost of findMatch() with 1 / 100 / 1000 configured routes, measured on the
//                       worst case for first-enabled-match-wins — the sought route sits LAST, so the
//                       matcher scans the whole list. This isolates match cost from HTTP/socket overhead.
//
// Kept well under ~15s: warm-up + a few thousand HTTP requests and a tight in-process match loop.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createServer } from "../src/server.js";
import { findMatch } from "../src/matcher.js";

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const r = http.request(
      { host: "127.0.0.1", port, method: "GET", path: p, headers: { host: `127.0.0.1:${port}` }, agent: false },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(Number(process.hrtime.bigint() - started) / 1e6));
      },
    );
    r.on("error", reject);
    r.end();
  });
}

async function benchServingLatency() {
  const dataFile = path.join(os.tmpdir(), `dan-oss-mock-bench-${crypto.randomUUID()}.json`);
  const server = createServer({ dataFile });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  // Define one route through the store the server already loaded.
  server._store.add({ method: "GET", path: "/bench", status: 200, body: { ok: true } });

  const WARMUP = 200;
  const N = 3000;
  for (let i = 0; i < WARMUP; i++) await get(port, "/bench");
  const samples = [];
  const wallStart = process.hrtime.bigint();
  for (let i = 0; i < N; i++) samples.push(await get(port, "/bench"));
  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;
  samples.sort((a, b) => a - b);

  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));

  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    requests: N,
    meanMs: mean,
    p50Ms: percentile(samples, 50),
    p99Ms: percentile(samples, 99),
    reqPerSec: (N / wallMs) * 1000,
  };
}

function makeRoutes(n) {
  // n routes; the one we will query is LAST, so a lookup scans all n (worst case for first-match-wins).
  const routes = [];
  for (let i = 0; i < n - 1; i++) routes.push({ method: "GET", path: `/pad/${i}`, enabled: true });
  routes.push({ method: "GET", path: "/target", enabled: true, id: "target" });
  return routes;
}

function benchMatchScaling() {
  const ITERS = 200_000;
  const results = [];
  for (const n of [1, 100, 1000]) {
    const routes = makeRoutes(n);
    // warm up the JIT for this array shape
    for (let i = 0; i < 10_000; i++) findMatch(routes, "GET", "/target");
    const start = process.hrtime.bigint();
    for (let i = 0; i < ITERS; i++) findMatch(routes, "GET", "/target");
    const totalMs = Number(process.hrtime.bigint() - start) / 1e6;
    results.push({ routes: n, iters: ITERS, nsPerMatch: (totalMs * 1e6) / ITERS, matchesPerSec: (ITERS / totalMs) * 1000 });
  }
  return results;
}

function fmt(n, digits = 3) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

const t0 = process.hrtime.bigint();
console.log("[DAN] MOCK — make bench (real numbers, this machine)");
console.log("─".repeat(78));

const serving = await benchServingLatency();
console.log("Serving latency — live loopback HTTP, one matched route:");
console.log(`  requests            ${serving.requests}`);
console.log(`  mean                ${fmt(serving.meanMs)} ms`);
console.log(`  p50                 ${fmt(serving.p50Ms)} ms`);
console.log(`  p99                 ${fmt(serving.p99Ms)} ms`);
console.log(`  throughput          ${fmt(serving.reqPerSec, 0)} req/s (sequential, one connection at a time)`);
console.log();

const scaling = benchMatchScaling();
console.log("Match scaling — findMatch() cost, target route LAST (full scan, first-match-wins worst case):");
console.log("  routes      ns / match      matches / sec");
for (const r of scaling) {
  console.log(`  ${String(r.routes).padEnd(10)}  ${fmt(r.nsPerMatch, 1).padStart(10)}    ${fmt(r.matchesPerSec, 0).padStart(15)}`);
}
console.log("─".repeat(78));
console.log(`Total bench wall time: ${fmt(Number(process.hrtime.bigint() - t0) / 1e6, 0)} ms`);
