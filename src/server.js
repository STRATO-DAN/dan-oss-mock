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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
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

export function createServer({ dataFile }) {
  installProcessGuards();
  const store = new RouteStore(dataFile);
  const loadPromise = store.load();

  const server = http.createServer(async (req, res) => {
    await loadPromise;
    const url = new URL(req.url, "http://127.0.0.1");
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const p = url.pathname;

    // --- management API -------------------------------------------------------------------
    if (p === "/_mock/api/routes" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, routes: store.list() });
    }
    if (p === "/_mock/api/routes" && req.method === "POST") {
      try {
        const body = await readBody(req);
        if (!body.method || !body.path) {
          return sendJson(res, 400, { ok: false, reason: "method and path are required" });
        }
        const route = store.add(body);
        await store.save();
        return sendJson(res, 200, { ok: true, route });
      } catch (err) {
        return sendJson(res, 400, { ok: false, reason: err.message });
      }
    }
    const routeIdMatch = p.match(/^\/_mock\/api\/routes\/([^/]+)$/);
    if (routeIdMatch && req.method === "PATCH") {
      try {
        const body = await readBody(req);
        const route = store.update(routeIdMatch[1], body);
        if (!route) return sendJson(res, 404, { ok: false, reason: "no such route" });
        await store.save();
        return sendJson(res, 200, { ok: true, route });
      } catch (err) {
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
      if (match.delayMs) await sleep(match.delayMs);
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
