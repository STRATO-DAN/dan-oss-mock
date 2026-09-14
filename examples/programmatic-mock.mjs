// Real, runnable example — defines mock routes and starts a real server programmatically,
// without ever touching the /_mock management UI. Useful for seeding routes in a test setup.
//
//   node examples/programmatic-mock.mjs
//
import { listen } from "../src/server.js";
import { RouteStore } from "../src/store.js";
import { fileURLToPath } from "node:url";

// fileURLToPath (not .pathname) so a real filesystem path with spaces (e.g. "/Users/me/My Projects/…")
// is decoded correctly instead of arriving URL-encoded (%20) and pointing at a path that doesn't exist.
const dataFile = fileURLToPath(new URL("./example-routes.json", import.meta.url));

// Seed real routes directly via the same RouteStore class the /_mock UI uses.
const store = new RouteStore(dataFile);
await store.load();
if (store.list().length === 0) {
  store.add({ method: "GET", path: "/api/users", status: 200, body: JSON.stringify([{ id: 1, name: "Ada" }]) });
  store.add({ method: "GET", path: "/api/users/*", status: 404, body: JSON.stringify({ error: "not found" }) });
  await store.save();
  console.log(`Seeded 2 real routes into ${dataFile}`);
}

const server = await listen(4880, dataFile);
console.log("Mock server listening on http://127.0.0.1:4880");

// Prove it actually works with two real requests, then shut down.
const hit = await fetch("http://127.0.0.1:4880/api/users");
console.log("GET /api/users ->", hit.status, await hit.json());

const miss = await fetch("http://127.0.0.1:4880/api/does-not-exist");
console.log("GET /api/does-not-exist ->", miss.status, await miss.text());

server.close(() => process.exit(0));
