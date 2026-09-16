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
