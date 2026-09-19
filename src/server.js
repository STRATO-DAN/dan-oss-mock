// Real local HTTP server, stdlib only — same zero-dependency discipline as DAN-OSS-COMMIT.
// One server, two real jobs, split by a reserved path prefix:
//   /_mock/*   management API + the frontend UI (define/edit/delete routes)
//   anything else   matched against the real configured routes; a real response if one matches,
//                   an honest 404 (never a silent empty 200) if nothing does
//
// 🔴 LOOPBACK ONLY, same reasoning as DAN-OSS-COMMIT: this is a LOCAL dev tool. A mock server
// reachable from the network is a real, avoidable liability for no real benefit to the stated use
// case (a frontend on the same machine calling it during development).
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RouteStore } from "./store.js";
import { findMatch } from "./matcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

// Fail-closed body limits. Per-request cap bounds one body; the global in-flight budget bounds
// ALL concurrently-buffering bodies together (the FINDING 08 gap: N concurrent 10 MiB bodies is
// hundreds of MiB). Both are env-overridable for tests; production defaults never change.
function bodyLimits() {
  const perRequest = Number(process.env.DAN_OSS_MOCK_MAX_BODY) || 10 * 1024 * 1024;
  const inflight = Number(process.env.DAN_OSS_MOCK_MAX_INFLIGHT) || 50 * 1024 * 1024;
  return { perRequest, inflight };
}

/** A body rejection that must surface as 413, not the generic 400. */
class BodyTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = "BodyTooLargeError";
    this.status = 413;
  }
}

function readBody(req, account) {
  const { perRequest, inflight } = bodyLimits();
  return new Promise((resolve, reject) => {
    // Fast Content-Length pre-check: when the client declares its size up front, refuse an
    // oversized body BEFORE buffering a single byte into RAM. A missing/garbled header falls
    // through to chunk accounting below (never trusted, never a bypass — just no fast path).
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > perRequest) {
      // Declared oversize: refuse WITHOUT consuming the body — but do NOT destroy the socket
      // here (that races and tears down the connection before our 413 is written). Pause the
      // stream; the handler answers 413 + Connection: close, which frees the socket cleanly.
      req.pause();
      reject(new BodyTooLargeError(`request body too large (declared ${declared} bytes, max ${perRequest})`));
      return;
    }
    let chunks = [];
    let size = 0;
    let charged = 0;
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      if (charged > 0 && account) account(-charged);
      fn();
    };
    req.on("data", (c) => {
      size += c.length;
      if (size > perRequest) {
        req.pause();
        settle(() => reject(new BodyTooLargeError(`request body too large (max ${perRequest} bytes)`)));
        return;
      }
      if (account && !account(c.length)) {
        req.pause();
        settle(() => reject(new BodyTooLargeError(`server busy — too many concurrent request bodies (global cap ${inflight} bytes)`)));
        return;
      }
      charged += c.length;
      chunks.push(c);
    });
    req.on("end", () => {
      settle(() => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("invalid JSON body"));
        }
      });
    });
    req.on("error", (err) => settle(() => reject(err)));
    req.on("close", () => settle(() => reject(new Error("request closed while reading body"))));
  });
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === "/_mock" || urlPath === "/_mock/" ? "index.html" : urlPath.replace(/^\/_mock\/?/, "");
  const resolved = path.resolve(PUBLIC_DIR, rel || "index.html");
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await fs.readFile(resolved);
    res.writeHead(200, { "content-type": MIME[path.extname(resolved)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 🔴 DNS-rebinding guard — this is a loopback-only server; refuse any request whose Host isn't loopback so a
// web page the user visits can't rebind a hostname to 127.0.0.1 and drive the mock's management API.
function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  let host = String(hostHeader).trim().toLowerCase();
  if (host.startsWith("[")) {
    host = host.slice(1, host.indexOf("]"));
  } else {
    host = host.replace(/:\d+$/, "");
  }
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// Last-resort backstop so a single bad route (or any stray async error) can never take the whole dev server
// down — the primary defenses are per-route validation (store.js) and the try/catch around the serve block
// below; this only catches whatever slips past both. Installed once per process, no matter how many servers
// are created (tests create many), so it never leaks EventEmitter listeners.
let processGuardsInstalled = false;
function installProcessGuards() {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;
  process.on("uncaughtException", (err) => {
    console.error(`[DAN] MOCK: uncaught exception (server kept alive): ${(err && err.stack) || err}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[DAN] MOCK: unhandled rejection (server kept alive): ${(reason && reason.stack) || reason}`);
  });
}

export function createServer({ dataFile, managementToken = process.env.DAN_OSS_MOCK_TOKEN || randomBytes(32).toString("hex") }) {
  if (typeof managementToken !== "string" || managementToken.length < 32) throw new Error("Management token must contain at least 32 characters");
  installProcessGuards();
  const store = new RouteStore(dataFile);
  const loadPromise = store.load();
  // FINDING 07/08 fix: bound total consumption — concurrent artificial delays hold sockets +
  // event loop; concurrent bodies hold memory. Fail closed with 503/413 instead of unbounded.
  const MAX_CONCURRENT_DELAYS = Number(process.env.DAN_OSS_MOCK_MAX_DELAYS) || 20;
  const MAX_INFLIGHT_BYTES = Number(process.env.DAN_OSS_MOCK_MAX_INFLIGHT) || 50 * 1024 * 1024;
  let activeDelays = 0;
  let inflightBytes = 0;
  // Global in-flight body budget: charge per chunk, release on settle. Returns false when the
  // charge would exceed the cap — the caller refuses with 413 instead of buffering.
  const chargeBody = (delta) => {
    if (delta < 0) {
      inflightBytes = Math.max(0, inflightBytes + delta);
      return true;
    }
    if (inflightBytes + delta > MAX_INFLIGHT_BYTES) return false;
    inflightBytes += delta;
    return true;
  };

  const server = http.createServer(async (req, res) => {
    await loadPromise;
    const url = new URL(req.url, "http://127.0.0.1");
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const p = url.pathname;

    if (p.startsWith("/_mock")) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
    }
    if (p.startsWith("/_mock/api/")) {
      if ((req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site") {
        return sendJson(res, 403, { ok: false, reason: "Cross-origin management is forbidden" });
      }
      res.setHeader("Vary", "Origin");
      const supplied = Buffer.from(req.headers.authorization || "");
      const expected = Buffer.from(`Bearer ${managementToken}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return sendJson(res, 401, { ok: false, reason: "Enter the management token from the server terminal" });
      }
      if (["POST", "PATCH"].includes(req.method) && req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
        return sendJson(res, 415, { ok: false, reason: "application/json is required" });
      }
    }

    // --- management API -------------------------------------------------------------------
    if (p === "/_mock/api/routes" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, routes: store.list() });
    }
    if (p === "/_mock/api/routes" && req.method === "POST") {
      try {
        const body = await readBody(req, chargeBody);
        if (!body.method || !body.path) {
          return sendJson(res, 400, { ok: false, reason: "method and path are required" });
        }
        const route = store.add(body);
        await store.save();
        return sendJson(res, 200, { ok: true, route });
      } catch (err) {
        // Body-budget rejections are 413 (resource policy) + Connection: close so the
        // paused (partially unread) request stream can't poison a reused socket.
        // Everything else stays 400.
        if (err instanceof BodyTooLargeError) {
          res.setHeader("Connection", "close");
          return sendJson(res, err.status, { ok: false, reason: err.message });
        }
        return sendJson(res, 400, { ok: false, reason: err.message });
      }
    }
    const routeIdMatch = p.match(/^\/_mock\/api\/routes\/([^/]+)$/);
    if (routeIdMatch && req.method === "PATCH") {
      try {
        const body = await readBody(req, chargeBody);
        const route = store.update(routeIdMatch[1], body);
        if (!route) return sendJson(res, 404, { ok: false, reason: "no such route" });
        await store.save();
        return sendJson(res, 200, { ok: true, route });
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          res.setHeader("Connection", "close");
          return sendJson(res, err.status, { ok: false, reason: err.message });
        }
        return sendJson(res, 400, { ok: false, reason: err.message });
      }
    }
    if (routeIdMatch && req.method === "DELETE") {
      const removed = store.remove(routeIdMatch[1]);
      if (!removed) return sendJson(res, 404, { ok: false, reason: "no such route" });
      await store.save();
      return sendJson(res, 200, { ok: true });
    }

    // --- management UI (static) -------------------------------------------------------------
    if (p === "/_mock" || p === "/_mock/" || p.startsWith("/_mock/")) {
      if (req.method === "GET") return serveStatic(res, p);
      res.writeHead(404).end("not found");
      return;
    }

    // --- the actual mocked API --------------------------------------------------------------
    // Everything from the match onward is wrapped: a route persisted by an OLDER build (before add()/update()
    // validated) can still carry a non-string path (matcher TypeError), an out-of-range status (writeHead
    // RangeError), or an illegal header (ERR_INVALID_CHAR) — serve it as a clean 500 instead of crashing the
    // process (which, with the bad route on disk, would re-crash on every restart).
    try {
      const match = findMatch(store.list(), req.method, p);
      if (!match) {
        return sendJson(res, 404, {
          ok: false,
          reason: `[DAN] MOCK: no real route configured for ${req.method} ${p}. Define one at /_mock.`,
        });
      }
      if (match.delayMs) {
        if (activeDelays >= MAX_CONCURRENT_DELAYS) {
          return sendJson(res, 503, { ok: false, reason: "server busy — too many delayed responses" });
        }
        activeDelays += 1;
        try {
          await sleep(match.delayMs);
        } finally {
          activeDelays -= 1;
        }
      }
      // Default content-type by body shape: a string is served as text/plain, an object/array as JSON — never
      // mislabel a plain string as application/json. A content-type the route sets itself (any casing) wins.
      const bodyIsString = typeof match.body === "string";
      const routeSetsContentType =
        match.headers && Object.keys(match.headers).some((k) => k.toLowerCase() === "content-type");
      const headers = { ...match.headers };
      if (!routeSetsContentType) {
        headers["content-type"] = bodyIsString ? "text/plain; charset=utf-8" : "application/json; charset=utf-8";
      }
      res.writeHead(match.status, headers);
      res.end(bodyIsString ? match.body : JSON.stringify(match.body));
    } catch (err) {
      console.error(`[DAN] MOCK: failed serving ${req.method} ${p}: ${err.message}`);
      if (!res.headersSent) {
        sendJson(res, 500, {
          ok: false,
          reason: `[DAN] MOCK: route is misconfigured and could not be served: ${err.message}`,
        });
      } else {
        res.end();
      }
    }
  });

  server._store = store; // exposed for tests only
  server.managementToken = managementToken;
  return server;
}

export function listen(port, dataFile) {
  const server = createServer({ dataFile });
  return new Promise((resolve, reject) => {
    // Reject on a bind failure (EADDRINUSE, EACCES, …) so the launcher can report a one-line startup
    // error and exit non-zero instead of surfacing an unhandled 'error' event. The listener is removed
    // once we're listening, so this never catches a runtime error after a successful start.
    const onError = (err) => reject(err);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve(server);
    });
  });
}
