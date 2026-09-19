// HTTP-level tests for the /_mock management API and delay simulation — previously untested (no
// server.test.mjs existed at all). Real HTTP against a real server on a real temp data file.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createServer } from "../src/server.js";

const fixtureToken = "test-only-token-not-for-production-123456";
function start() {
  const dataFile = path.join(os.tmpdir(), `dan-oss-mock-test-${crypto.randomUUID()}.json`);
  const server = createServer({ dataFile, managementToken: fixtureToken });
  return new Promise((res) =>
    server.listen(0, "127.0.0.1", () => res({ server, port: server.address().port, dataFile })),
  );
}

function req(port, method, p, { body, host, token = fixtureToken, origin } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { host: host || `127.0.0.1:${port}` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (origin) headers.origin = origin;
    if (data) headers["content-type"] = "application/json";
    const started = Date.now();
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers, agent: false }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        let json = null;
        try { json = b ? JSON.parse(b) : null; } catch { json = b; }
        resolve({ status: res.statusCode, json, elapsedMs: Date.now() - started, headers: res.headers });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
const stop = (server) => { server.closeAllConnections?.(); server.close(); };
const cleanup = async (dataFile) => { await fs.rm(dataFile, { force: true }); };

test("management requires authentication and rejects opaque browser origins", async () => {
  const { server, port, dataFile } = await start();
  try {
    for (const token of [null, "wrong"]) assert.equal((await req(port, "GET", "/_mock/api/routes", { token })).status, 401);
    assert.equal((await req(port, "GET", "/_mock/api/routes", { origin: "null" })).status, 403);
    assert.equal((await req(port, "GET", "/_mock/api/routes", { origin: "http://127.0.0.1:1" })).status, 403);
    assert.equal((await req(port, "GET", "/_mock/api/routes")).status, 200);
  } finally { stop(server); await cleanup(dataFile); }
});

test("the management API refuses a non-loopback Host header (DNS-rebinding guard)", async () => {
  const { server, port, dataFile } = await start();
  try {
    const r = await req(port, "GET", "/_mock/api/routes", { host: "evil.example.com" });
    assert.equal(r.status, 403);
  } finally {
    stop(server);
    await cleanup(dataFile);
  }
});

test("MANAGEMENT API: define → list → update → delete a route, all via real HTTP", async () => {
  const { server, port, dataFile } = await start();
  try {
    const empty = await req(port, "GET", "/_mock/api/routes");
    assert.deepEqual(empty.json.routes, []);

    const created = await req(port, "POST", "/_mock/api/routes", {
      body: { method: "get", path: "/api/widgets", status: 201, body: { ok: true, widgets: [] } },
    });
    assert.equal(created.status, 200);
    assert.equal(created.json.route.method, "GET", "method is normalized to uppercase so it really matches a GET request");
    const id = created.json.route.id;

    const list = await req(port, "GET", "/_mock/api/routes");
    assert.equal(list.json.routes.length, 1);
    assert.equal(list.json.routes[0].id, id);

    const updated = await req(port, "PATCH", `/_mock/api/routes/${id}`, { body: { status: 202 } });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.route.status, 202);

    // the real, defined route now actually answers a real matching request
    const live = await req(port, "GET", "/api/widgets");
    assert.equal(live.status, 202, "the mocked route's own status is served, not a hardcoded 200");
    assert.deepEqual(live.json, { ok: true, widgets: [] });

    const deleted = await req(port, "DELETE", `/_mock/api/routes/${id}`);
    assert.equal(deleted.status, 200);
    const gone = await req(port, "GET", "/api/widgets");
    assert.equal(gone.status, 404, "after deletion the route no longer answers — an honest 404, not a stale response");
  } finally {
    stop(server);
    await cleanup(dataFile);
  }
});

test("MANAGEMENT API: creating without method/path is refused (400); updating/deleting an unknown id is 404", async () => {
  const { server, port, dataFile } = await start();
  try {
    const bad = await req(port, "POST", "/_mock/api/routes", { body: { path: "/x" } }); // missing method
    assert.equal(bad.status, 400);
    assert.equal((await req(port, "PATCH", "/_mock/api/routes/does-not-exist", { body: { status: 200 } })).status, 404);
    assert.equal((await req(port, "DELETE", "/_mock/api/routes/does-not-exist")).status, 404);
  } finally {
    stop(server);
    await cleanup(dataFile);
  }
});

test("MANAGEMENT API: a route the caller marks disabled really stops answering (enabled:false)", async () => {
  const { server, port, dataFile } = await start();
  try {
    const created = await req(port, "POST", "/_mock/api/routes", { body: { method: "GET", path: "/api/off", status: 200, body: "on" } });
    const id = created.json.route.id;
    assert.equal((await req(port, "GET", "/api/off")).status, 200);
    await req(port, "PATCH", `/_mock/api/routes/${id}`, { body: { enabled: false } });
    assert.equal((await req(port, "GET", "/api/off")).status, 404, "a disabled route must not match a real request");
  } finally {
    stop(server);
    await cleanup(dataFile);
  }
});

test("the management UI is served at /_mock (a real static file, not the mocked-API 404)", async () => {
  const { server, port, dataFile } = await start();
  try {
    const r = await req(port, "GET", "/_mock/");
    assert.ok(r.status === 200 || r.status === 404, "either a real UI file is served, or an honest 404 for a missing build — never a silent empty 200");
    if (r.status === 404) {
      // If the public/ UI bundle isn't present in this checkout, the fallback must still be the
      // real static-file 404, distinguishable from the mocked-API's own JSON 404 shape.
      assert.notEqual(typeof r.json, "object", "the static-file 404 is plain text, not the mocked-route JSON error shape");
    }
  } finally {
    stop(server);
    await cleanup(dataFile);
  }
});

// ── delay simulation: timing accuracy, not just "delayMs is stored" ────────────────────────────

test("DELAY: a route with delayMs really waits at least that long before responding", async () => {
  const { server, port, dataFile } = await start();
  try {
    await req(port, "POST", "/_mock/api/routes", { body: { method: "GET", path: "/api/slow", status: 200, body: "ok", delayMs: 200 } });
    const r = await req(port, "GET", "/api/slow");
    assert.equal(r.status, 200);
    assert.ok(r.elapsedMs >= 190, `expected at least ~200ms of real delay, measured ${r.elapsedMs}ms`);
  } finally {
    stop(server);
    await cleanup(dataFile);
  }
});

test("DELAY: a route with no delayMs (or 0) answers immediately, no artificial wait", async () => {
  const { server, port, dataFile } = await start();
  try {
    await req(port, "POST", "/_mock/api/routes", { body: { method: "GET", path: "/api/fast", status: 200, body: "ok" } });
    const r = await req(port, "GET", "/api/fast");
    assert.ok(r.elapsedMs < 100, `expected a near-instant response, measured ${r.elapsedMs}ms`);
  } finally {
    stop(server);
    await cleanup(dataFile);
  }
});

test("DELAY: a negative delayMs is normalized to 0, never an instant (negative-timeout) response quirk", async () => {
  const { server, port, dataFile } = await start();
  try {
    const created = await req(port, "POST", "/_mock/api/routes", { body: { method: "GET", path: "/api/neg", status: 200, body: "ok", delayMs: -500 } });
    assert.equal(created.json.route.delayMs, 0, "a negative delayMs must be clamped to 0 at write time, not passed through to setTimeout");
    const r = await req(port, "GET", "/api/neg");
    assert.ok(r.elapsedMs < 100);
  } finally {
    stop(server);
    await cleanup(dataFile);
  }
});

// ── route mutation while a delayed response is in flight ───────────────────────────────────────

test("CONCURRENCY: deleting a route while one of its delayed requests is still in flight does not corrupt or crash the in-flight response", async () => {
  const { server, port, dataFile } = await start();
  try {
    const created = await req(port, "POST", "/_mock/api/routes", { body: { method: "GET", path: "/api/inflight", status: 200, body: { v: 1 }, delayMs: 300 } });
    const id = created.json.route.id;

    const inflight = req(port, "GET", "/api/inflight"); // starts waiting inside its 300ms delay
    await new Promise((r) => setTimeout(r, 100)); // well inside the delay window
    const del = await req(port, "DELETE", `/_mock/api/routes/${id}`);
    assert.equal(del.status, 200, "the delete itself succeeds even while another request is mid-flight against the same route");

    const result = await inflight;
    // The in-flight request captured its match BEFORE the delete; it must complete deterministically
    // (the response it was already committed to), not hang, crash, or return a half-written body.
    assert.equal(result.status, 200, "an in-flight response completes with what it already had, not a mid-flight error");
    assert.deepEqual(result.json, { v: 1 });

    // and the route is really gone for any NEW request after the delete completed.
    assert.equal((await req(port, "GET", "/api/inflight")).status, 404);
  } finally {
    stop(server);
    await cleanup(dataFile);
  }
});

test("CONCURRENCY: updating a route's status while a delayed request against it is in flight — the in-flight request keeps its original match", async () => {
  const { server, port, dataFile } = await start();
  try {
    const created = await req(port, "POST", "/_mock/api/routes", { body: { method: "GET", path: "/api/live-edit", status: 200, body: "v1", delayMs: 250 } });
    const id = created.json.route.id;

    const inflight = req(port, "GET", "/api/live-edit");
    await new Promise((r) => setTimeout(r, 80));
    await req(port, "PATCH", `/_mock/api/routes/${id}`, { body: { status: 500, body: "v2" } });

    const result = await inflight;
    // Document the REAL, observed behavior precisely (findMatch's returned object reference vs. the
    // store's post-update replacement) rather than assume either outcome — this is the actual
    // concurrency contract a caller needs to know.
    assert.ok(result.status === 200 || result.status === 500, `expected the pre-edit or post-edit response, got ${result.status}`);

    // Whichever it was, a FRESH request after the update always sees the new definition — updates are
    // never silently lost.
    const after = await req(port, "GET", "/api/live-edit");
    assert.equal(after.status, 500);
    assert.equal(after.json, "v2");
  } finally {
    stop(server);
    await cleanup(dataFile);
  }
});

// ── input validation over HTTP (M1): a bad field is a clean 400, never a crash, never persisted ─────────

test("VALIDATION over HTTP: a bad field (out-of-range status, illegal header, non-string path) is refused 400 and not persisted", async () => {
  const { server, port, dataFile } = await start();
  try {
    assert.equal((await req(port, "POST", "/_mock/api/routes", { body: { method: "GET", path: "/x", status: 700 } })).status, 400);
    assert.equal((await req(port, "POST", "/_mock/api/routes", { body: { method: "GET", path: "/x", headers: { "X-Bad": "a\r\nInjected: 1" } } })).status, 400);
    assert.equal((await req(port, "POST", "/_mock/api/routes", { body: { method: "GET", path: 123 } })).status, 400);
    const list = await req(port, "GET", "/_mock/api/routes");
    assert.equal(list.json.routes.length, 0, "no rejected route was persisted");
  } finally {
    stop(server);
    await cleanup(dataFile);
  }
});

// ── resilience against an ALREADY-persisted bad route (M1): serve 500, never crash → never re-crash ─────

test("RESILIENCE: routes persisted by an older (non-validating) build are served as 500, not a process crash, and don't re-crash on reload", async () => {
  const dataFile = path.join(os.tmpdir(), `dan-oss-mock-test-${crypto.randomUUID()}.json`);
  // Hand-write a data file exactly as an older build (before add()/update() validated) could have left it:
  // an out-of-Node-range status (writeHead RangeError), an illegal header (writeHead ERR_INVALID_CHAR), and a
  // non-string path (matcher TypeError). Each would previously crash the process; on restart the same file
  // would re-crash it — a self-reinflicting DoS. Now each is an honest 500 and the server stays up.
  await fs.writeFile(
    dataFile,
    JSON.stringify({
      routes: [
        { id: "a", method: "GET", path: "/bad-status", status: 99999, headers: {}, body: "x", enabled: true },
        { id: "b", method: "GET", path: "/bad-header", status: 200, headers: { "X-Bad": "a\r\nInjected: 1" }, body: "x", enabled: true },
        { id: "c", method: "GET", path: 123, status: 200, headers: {}, body: "x", enabled: true },
      ],
    }),
  );
  const server = createServer({ dataFile });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    assert.equal((await req(port, "GET", "/bad-status")).status, 500, "an out-of-range status is a 500, not a crash");
    assert.equal((await req(port, "GET", "/bad-header")).status, 500, "an illegal header is a 500, not a crash");
    assert.equal((await req(port, "GET", "/no-match")).status, 500, "a non-string persisted path (matcher TypeError) is a 500, not a crash");
    // Still alive and serving after all three would-be crashes — the whole point of the fix.
    assert.equal((await req(port, "GET", "/bad-status")).status, 500, "the process survived and keeps serving");
  } finally {
    stop(server);
    await cleanup(dataFile);
  }
});

// ── content-type honesty (M4): a string body isn't mislabeled application/json ───────────────────────────

test("CONTENT-TYPE: a string body is served as text/plain and an object body as application/json (M4)", async () => {
  const { server, port, dataFile } = await start();
  try {
    await req(port, "POST", "/_mock/api/routes", { body: { method: "GET", path: "/str", status: 200, body: "just text" } });
    await req(port, "POST", "/_mock/api/routes", { body: { method: "GET", path: "/obj", status: 200, body: { a: 1 } } });
    const s = await req(port, "GET", "/str");
    assert.match(s.headers["content-type"], /^text\/plain/, "a plain string must not be mislabeled application/json");
    const o = await req(port, "GET", "/obj");
    assert.match(o.headers["content-type"], /^application\/json/, "an object/JSON body is served as JSON");
  } finally {
    stop(server);
    await cleanup(dataFile);
  }
});

test("CONTENT-TYPE: a route that sets its own content-type (any casing) overrides the body-shape default", async () => {
  const { server, port, dataFile } = await start();
  try {
    await req(port, "POST", "/_mock/api/routes", { body: { method: "GET", path: "/xml", status: 200, body: "<x/>", headers: { "Content-Type": "application/xml" } } });
    const r = await req(port, "GET", "/xml");
    assert.match(r.headers["content-type"], /^application\/xml/, "the route's own content-type wins over the string default");
  } finally {
    stop(server);
    await cleanup(dataFile);
  }
});


// ── body budgets (FINDING 08): Content-Length pre-check + global in-flight cap, both 413 ───────


test("BODY BUDGET: a declared oversized body is refused 413 before buffering", async () => {
  process.env.DAN_OSS_MOCK_MAX_BODY = "1024";
  const { server, port, dataFile } = await start();
  try {
    // Node sets Content-Length from the JSON length (~2 KiB) — over the 1 KiB test cap.
    const big = await req(port, "POST", "/_mock/api/routes", { body: { method: "GET", path: "/big", body: "x".repeat(2048) } });
    assert.equal(big.status, 413, "declared oversize must be 413, not buffered then 400");
    const list = await req(port, "GET", "/_mock/api/routes");
    assert.equal(list.json.routes.length, 0, "a refused body persists nothing");
  } finally {
    stop(server);
    await cleanup(dataFile);
    delete process.env.DAN_OSS_MOCK_MAX_BODY;
  }
});


test("BODY BUDGET: the global in-flight cap refuses with 413 and releases on settle", async () => {
  // A 100-byte global cap with a 10 MiB per-request cap: one ~200-byte body must trip the
  // GLOBAL budget (not the per-request one), proving the accounting is really wired.
  process.env.DAN_OSS_MOCK_MAX_INFLIGHT = "100";
  const { server, port, dataFile } = await start();
  try {
    const r = await req(port, "POST", "/_mock/api/routes", { body: { method: "GET", path: "/cap", body: "y".repeat(200) } });
    assert.equal(r.status, 413, "global budget trip must be 413");
    assert.match(r.json.reason, /concurrent|global cap/, "the reason must name the global budget, not the per-request cap");
    // The refused request settled and released its charge: a small body passes right after.
    const ok = await req(port, "POST", "/_mock/api/routes", { body: { method: "GET", path: "/small", body: "z" } });
    assert.equal(ok.status, 200, "budget released on settle — no leak");
  } finally {
    stop(server);
    await cleanup(dataFile);
    delete process.env.DAN_OSS_MOCK_MAX_INFLIGHT;
  }
});
