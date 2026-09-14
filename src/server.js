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

export function createServer({ dataFile }) {
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
    const match = findMatch(store.list(), req.method, p);
    if (!match) {
      return sendJson(res, 404, {
        ok: false,
        reason: `[DAN] MOCK: no real route configured for ${req.method} ${p}. Define one at /_mock.`,
      });
    }
    if (match.delayMs) await sleep(match.delayMs);
    const headers = { "content-type": "application/json; charset=utf-8", ...match.headers };
    res.writeHead(match.status, headers);
    const body = typeof match.body === "string" ? match.body : JSON.stringify(match.body);
    res.end(body);
  });

  server._store = store; // exposed for tests only
  return server;
}

export function listen(port, dataFile) {
  const server = createServer({ dataFile });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
