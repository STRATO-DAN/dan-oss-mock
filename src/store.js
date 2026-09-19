// Real persistence — a plain JSON file next to wherever the tool is run, so routes survive a
// restart without needing a real database for a tool whose whole pitch is "no backend to
// deploy". Every write is atomic (temp file + rename), so a crash mid-write can never leave a
// half-written, corrupt route file behind — the estate-wide "atomic writes" discipline, applied
// here because it's the correct thing to do, not borrowed for its own sake.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// Cap a route's simulated delay. A `delayMs` was only lower-bounded (Math.max(0, …)), so an absurd value
// could tie a socket up effectively forever and, past ~2^31 ms, overflow setTimeout's 32-bit signed delay
// and misfire immediately. 60s is far longer than any real "slow response" a dev mock needs to simulate.
const MAX_DELAY_MS = 60_000;
// FINDING 06 fix: aggregate management state is bounded — per-route creation without a global cap
// is a local resource-exhaustion primitive. 200 routes is far beyond real dev-mock use.
const MAX_ROUTES = 200;
const MAX_STATE_BYTES = 5 * 1024 * 1024;

// RFC 7230 header field-name = token; reject anything else so an illegal name never reaches res.writeHead
// (which would throw ERR_INVALID_HTTP_TOKEN and take the process down).
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Node's own checkInvalidHeaderChar set: tab, space–tilde, and high-bit bytes are legal in a value; a
// CR/LF/NUL or other control char is not (it would throw ERR_INVALID_CHAR — and CR/LF is header injection).
const HEADER_VALUE_ILLEGAL = /[^\t\x20-\x7e\x80-\xff]/;

// add()/update() previously validated nothing: a non-string path later crashed the matcher (TypeError), an
// out-of-range status crashed res.writeHead (RangeError), and an illegal header name/value crashed it too —
// and the bad route was PERSISTED, so a restart re-loaded it and re-crashed (a self-reinflicting DoS). These
// helpers reject a bad field by THROWING, which the management API's existing try/catch turns into a clean
// 400 before anything is pushed to the in-memory list or written to disk.
function validateMethod(method) {
  if (typeof method !== "string" || method.trim() === "") {
    throw new Error("route.method must be a non-empty string");
  }
  return method.toUpperCase();
}

function validatePath(routePath) {
  if (typeof routePath !== "string" || routePath === "") {
    throw new Error("route.path must be a non-empty string");
  }
  return routePath;
}

function normalizeStatus(status) {
  if (status === undefined || status === null || status === "") return 200;
  const n = Number(status);
  if (!Number.isInteger(n) || n < 100 || n > 599) {
    throw new Error(`route.status must be an integer between 100 and 599 (got ${JSON.stringify(status)})`);
  }
  return n;
}

function normalizeDelay(delayMs) {
  const n = Number(delayMs) || 0;
  return Math.min(MAX_DELAY_MS, Math.max(0, n));
}

// Lenient on the container (a non-object coerces to {}, matching the prior behavior), strict on its contents:
// every name must be a valid HTTP token and every value free of control/newline chars, or reject.
function validateHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HTTP_TOKEN.test(name)) {
      throw new Error(`illegal header name ${JSON.stringify(name)} — header names must be valid HTTP tokens`);
    }
    if (HEADER_VALUE_ILLEGAL.test(String(value))) {
      throw new Error(`illegal header value for ${JSON.stringify(name)} — contains a control character or newline`);
    }
  }
  return headers;
}

export class RouteStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.routes = [];
    this.loaded = false;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      // FINDING 09/14 note: the persistence file is a second API. Legacy files may contain
      // pre-validation routes (bad status/header/non-string path) — they are kept verbatim so
      // the serve path returns an honest 500 (resilience contract) instead of crashing; NEW
      // writes via add()/update() are strictly validated. Count and cap to MAX_ROUTES.
      const rawRoutes = Array.isArray(parsed.routes) ? parsed.routes : [];
      this.routes = rawRoutes.slice(0, MAX_ROUTES);
    } catch (err) {
      if (err.code !== "ENOENT") {
        // A real parse/read failure on an EXISTING file is not the same as "no file yet" — start
        // empty but say so loudly rather than silently discarding whatever was really on disk.
        console.error(`[DAN] MOCK: could not read ${this.filePath}, starting empty: ${err.message}`);
      }
      this.routes = [];
    }
    this.loaded = true;
    return this.routes;
  }

  async save() {
    // Serialize saves. Two concurrent writers previously shared ONE temp path (`.<pid>.tmp`) and could
    // race the rename AND lose an update (last rename wins the file). Each save now waits for the previous
    // one (ordered writes → the last reflects the latest routes) and uses a per-write unique temp name so
    // two in-flight writers never collide. Atomic replacement is not atomic concurrent persistence.
    const dir = path.dirname(this.filePath);
    const prev = this._saveChain || Promise.resolve();
    const mine = prev.catch(() => {}).then(async () => {
      const tmp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
      try {
        await fs.writeFile(tmp, JSON.stringify({ routes: this.routes }, null, 2), { encoding: "utf8", mode: 0o600 });
        // FINDING 09 fix: owner-only persistence — the file is outside the HTTP auth boundary.
        try { await fs.chmod(tmp, 0o600); } catch {}
        await fs.rename(tmp, this.filePath);
        try { await fs.chmod(this.filePath, 0o600); } catch {}
      } catch (err) {
        // A write or rename failure must not leave the half-written temp orphaned on disk. Best-effort
        // unlink (ignore its own failure / a temp that never got created), then rethrow the real error.
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    });
    this._saveChain = mine;
    return mine;
  }

  list() {
    return this.routes;
  }

  add(route) {
    // FINDING 06 fix: fail-closed global budget — 413-style throw (management API maps to 400/413).
    if (this.routes.length >= MAX_ROUTES) {
      throw new Error(`route limit reached (max ${MAX_ROUTES} routes)`);
    }
    // Validate every field BEFORE pushing, so a bad route is rejected (throws → 400) and never persisted.
    const real = {
      id: crypto.randomUUID(),
      method: validateMethod(route.method),
      path: validatePath(route.path),
      status: normalizeStatus(route.status),
      headers: validateHeaders(route.headers),
      body: route.body ?? "",
      delayMs: normalizeDelay(route.delayMs),
      enabled: route.enabled !== false,
      createdAt: new Date().toISOString(),
    };
    const approx = JSON.stringify([...this.routes, real]).length;
    if (approx > MAX_STATE_BYTES) {
      throw new Error(`mock state too large (max ${MAX_STATE_BYTES} bytes)`);
    }
    this.routes.push(real);
    return real;
  }

  update(id, patch) {
    const i = this.routes.findIndex((r) => r.id === id);
    if (i === -1) return null;
    const merged = { ...this.routes[i], ...patch, id };
    // Re-apply the same validation/normalization add() enforces, so a PATCH can't set an unbounded delay,
    // an out-of-range status, a non-string path, an illegal header, or a lowercase method that then never
    // matches an uppercased request. Validate BEFORE committing to this.routes[i] so a bad patch throws
    // (→ 400) and the existing route is left untouched, never half-overwritten with an invalid field.
    if (patch.method !== undefined) merged.method = validateMethod(merged.method);
    if (patch.path !== undefined) merged.path = validatePath(merged.path);
    if (patch.status !== undefined) merged.status = normalizeStatus(merged.status);
    if (patch.headers !== undefined) merged.headers = validateHeaders(merged.headers);
    if (patch.delayMs !== undefined) merged.delayMs = normalizeDelay(merged.delayMs);
    const candidate = this.routes.map((r, idx) => (idx === i ? merged : r));
    const approx = JSON.stringify(candidate).length;
    if (approx > MAX_STATE_BYTES) {
      throw new Error(`mock state too large (max ${MAX_STATE_BYTES} bytes)`);
    }
    this.routes[i] = merged;
    return this.routes[i];
  }

  remove(id) {
    const before = this.routes.length;
    this.routes = this.routes.filter((r) => r.id !== id);
    return this.routes.length < before;
  }
}
