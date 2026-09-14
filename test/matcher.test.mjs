// Real tests for the real, honest matching logic — no fuzzy/regex behavior to test because
// there isn't any; these confirm the two real match kinds and the first-match-wins contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findMatch } from "../src/matcher.js";

test("an exact path matches only that literal path, not a prefix of it", () => {
  const routes = [{ method: "GET", path: "/api/users", enabled: true }];
  assert.equal(findMatch(routes, "GET", "/api/users"), routes[0]);
  assert.equal(findMatch(routes, "GET", "/api/users/1"), null);
});

test("a trailing '*' matches as a real prefix, anything after", () => {
  const routes = [{ method: "GET", path: "/api/users/*", enabled: true }];
  assert.equal(findMatch(routes, "GET", "/api/users/1"), routes[0]);
  assert.equal(findMatch(routes, "GET", "/api/users/1/posts"), routes[0]);
  assert.equal(findMatch(routes, "GET", "/api/other"), null);
});

test("method must match unless the route is a real wildcard ('*') method", () => {
  const routes = [{ method: "POST", path: "/api/users", enabled: true }];
  assert.equal(findMatch(routes, "GET", "/api/users"), null);
  assert.equal(findMatch(routes, "POST", "/api/users"), routes[0]);

  const wildcard = [{ method: "*", path: "/api/users", enabled: true }];
  assert.equal(findMatch(wildcard, "DELETE", "/api/users"), wildcard[0]);
});

test("a disabled route is never matched, even if its path/method otherwise fits", () => {
  const routes = [{ method: "GET", path: "/api/users", enabled: false }];
  assert.equal(findMatch(routes, "GET", "/api/users"), null);
});

test("the first enabled matching route wins, in the order given — not the most specific one", () => {
  const routes = [
    { method: "GET", path: "/api/*", enabled: true, id: "generic" },
    { method: "GET", path: "/api/users", enabled: true, id: "specific" },
  ];
  const match = findMatch(routes, "GET", "/api/users");
  assert.equal(match.id, "generic", "the earlier, less specific route should win — real first-match-wins, not smart routing");
});

test("no routes at all, or no matching one, returns null rather than throwing", () => {
  assert.equal(findMatch([], "GET", "/api/users"), null);
  assert.equal(findMatch([{ method: "GET", path: "/other", enabled: true }], "GET", "/api/users"), null);
});
