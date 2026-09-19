// Real, honest matching — no invented fuzzy logic. Two real match kinds only:
//   exact path                         "/api/users"        matches only that literal path
//   path ending in "*"                 "/api/users/*"      matches that prefix, anything after
// First real, enabled match wins, in the order routes were added — same "first match wins"
// contract every real router (Express, etc.) uses, so behaviour is predictable, not surprising.
export function findMatch(routes, method, pathname) {
  for (const r of routes) {
    if (!r.enabled) continue;
    if (r.method !== "*" && r.method !== method) continue;
    if (typeof r.path !== "string") continue;
    if (r.path.endsWith("*")) {
      const prefix = r.path.slice(0, -1);
      if (pathname.startsWith(prefix)) return r;
    } else if (r.path === pathname) {
      return r;
    }
  }
  return null;
}
