// Real tests against a real temp file — RouteStore's own atomic-write persistence, exercised
// with the real filesystem, not a mocked one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RouteStore } from "../src/store.js";

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-mock-test-"));
  const store = new RouteStore(path.join(dir, "routes.json"));
  await store.load();
  try {
    await fn(store, dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("load() on a file that doesn't exist yet starts empty, not an error", () =>
  withStore((store) => {
    assert.deepEqual(store.list(), []);
  }));

test("add() fills in real defaults (method uppercased, status 200, enabled true) and a real id", () =>
  withStore((store) => {
    const route = store.add({ method: "get", path: "/api/users" });
    assert.equal(route.method, "GET");
    assert.equal(route.status, 200);
    assert.equal(route.enabled, true);
    assert.match(route.id, /^[0-9a-f-]{36}$/);
  }));

test("save() then a fresh load() from the same file round-trips the real route list", () =>
  withStore(async (store, dir) => {
    store.add({ method: "GET", path: "/api/users", body: "[]" });
    await store.save();

    const reloaded = new RouteStore(path.join(dir, "routes.json"));
    await reloaded.load();
    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.list()[0].path, "/api/users");
  }));

test("CONCURRENCY: many overlapping save() calls all persist — no rename race, no lost update", () =>
  withStore(async (store, dir) => {
    const N = 30;
    // Fire N overlapping saves, each after adding one more route. Before serialization every save shared
    // ONE `.<pid>.tmp` path → concurrent writes could race the rename (throw) and/or lose an update (the
    // rename that lands last wins the file, even with a staler, shorter route list).
    await Promise.all(
      Array.from({ length: N }, (_, i) => {
        store.add({ method: "GET", path: `/api/r${i}`, body: "[]" });
        return store.save();
      }),
    );
    const reloaded = new RouteStore(path.join(dir, "routes.json"));
    await reloaded.load();
    assert.equal(
      reloaded.list().length,
      N,
      "every concurrently-added route is durably persisted — no update lost to a shared-temp-file collision",
    );
  }));

test("update() patches an existing route by id without letting the id itself be overwritten", () =>
  withStore((store) => {
    const route = store.add({ method: "GET", path: "/api/users" });
    const updated = store.update(route.id, { status: 404, id: "should-not-stick" });
    assert.equal(updated.status, 404);
    assert.equal(updated.id, route.id);
  }));

test("update() on a real nonexistent id returns null, not a thrown error", () =>
  withStore((store) => {
    assert.equal(store.update("no-such-id", { status: 500 }), null);
  }));

test("remove() deletes a real route and reports whether one was actually removed", () =>
  withStore((store) => {
    const route = store.add({ method: "GET", path: "/api/users" });
    assert.equal(store.remove(route.id), true);
    assert.equal(store.list().length, 0);
    assert.equal(store.remove(route.id), false, "removing the same id twice must not report success twice");
  }));

test("a corrupt existing file starts empty rather than crashing, and logs why (ENOENT is not an error)", () =>
  withStore(async (store, dir) => {
    const badPath = path.join(dir, "corrupt.json");
    await fs.writeFile(badPath, "{ not real json");
    const fresh = new RouteStore(badPath);
    const routes = await fresh.load();
    assert.deepEqual(routes, []);
  }));

// ── input validation (M1): a bad field is rejected at add()/update() and never pushed/persisted ──────────

test("VALIDATION: add() rejects a non-string / empty path (would later crash the matcher) and stores nothing", () =>
  withStore((store) => {
    assert.throws(() => store.add({ method: "GET", path: 123 }), /path must be a non-empty string/);
    assert.throws(() => store.add({ method: "GET", path: "" }), /path must be a non-empty string/);
    assert.throws(() => store.add({ method: "GET" }), /path must be a non-empty string/);
    assert.equal(store.list().length, 0, "a rejected route must never be pushed to the in-memory list");
  }));

test("VALIDATION: add() rejects a non-string method (would crash on .toUpperCase())", () =>
  withStore((store) => {
    assert.throws(() => store.add({ method: 123, path: "/x" }), /method must be a non-empty string/);
    assert.equal(store.list().length, 0);
  }));

test("VALIDATION: add() rejects an out-of-range / non-integer status (would crash res.writeHead with RangeError)", () =>
  withStore((store) => {
    assert.throws(() => store.add({ method: "GET", path: "/x", status: 700 }), /status must be an integer between 100 and 599/);
    assert.throws(() => store.add({ method: "GET", path: "/x", status: 99 }), /status must be an integer/);
    assert.throws(() => store.add({ method: "GET", path: "/x", status: "abc" }), /status must be an integer/);
    assert.equal(store.list().length, 0);
    // A valid numeric string still coerces to a real number, and an omitted status still defaults to 200.
    assert.equal(store.add({ method: "GET", path: "/a", status: "201" }).status, 201);
    assert.equal(store.add({ method: "GET", path: "/b" }).status, 200);
  }));

test("VALIDATION: add() rejects an illegal header name or value (would crash res.writeHead with ERR_INVALID_CHAR/TOKEN)", () =>
  withStore((store) => {
    assert.throws(() => store.add({ method: "GET", path: "/x", headers: { "bad name": "v" } }), /illegal header name/);
    assert.throws(() => store.add({ method: "GET", path: "/x", headers: { "X-Bad": "line1\r\nInjected: 1" } }), /illegal header value/);
    assert.equal(store.list().length, 0);
    // A legal header set is accepted unchanged.
    const ok = store.add({ method: "GET", path: "/x", headers: { "X-Ok": "fine" } });
    assert.deepEqual(ok.headers, { "X-Ok": "fine" });
  }));

test("VALIDATION: update() re-validates a patched field and leaves the existing route untouched on rejection", () =>
  withStore((store) => {
    const route = store.add({ method: "GET", path: "/x", status: 200 });
    assert.throws(() => store.update(route.id, { status: 700 }), /status must be an integer/);
    assert.throws(() => store.update(route.id, { path: 42 }), /path must be a non-empty string/);
    assert.throws(() => store.update(route.id, { headers: { "bad\nname": "v" } }), /illegal header name/);
    // None of the rejected patches stuck — the route still has its original valid fields.
    assert.equal(store.list()[0].status, 200);
    assert.equal(store.list()[0].path, "/x");
  }));

// ── delayMs cap (M2): the upper bound, not just the lower one ────────────────────────────────────────────

test("DELAY CAP: an absurd delayMs is capped to 60s (add and update), stopping the socket tie-up / setTimeout overflow", () =>
  withStore((store) => {
    assert.equal(store.add({ method: "GET", path: "/x", delayMs: 10 ** 12 }).delayMs, 60_000);
    const route = store.add({ method: "GET", path: "/y", delayMs: 100 });
    assert.equal(store.update(route.id, { delayMs: 2 ** 40 }).delayMs, 60_000);
    // The existing lower bound still holds.
    assert.equal(store.add({ method: "GET", path: "/z", delayMs: -5 }).delayMs, 0);
  }));

// ── temp-file cleanup (M5): a failed rename must not orphan the temp ─────────────────────────────────────

test("SAVE CLEANUP: a failed rename unlinks its temp file rather than orphaning it on disk", () =>
  withStore(async (store, dir) => {
    // Point a store at a path that is actually a directory — the final rename(tmpFile, dir) can never
    // succeed (EISDIR/ENOTDIR), so save() must reject AND leave no `.tmp` behind.
    const target = path.join(dir, "target-is-a-dir");
    await fs.mkdir(target);
    const s2 = new RouteStore(target);
    s2.add({ method: "GET", path: "/x" });
    await assert.rejects(s2.save(), "a save whose rename fails must reject, not resolve");
    const leftover = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftover, [], "the temp file must be unlinked when the rename fails");
  }));
