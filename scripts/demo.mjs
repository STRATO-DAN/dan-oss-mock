#!/usr/bin/env node
// `make demo` — a real, reproducible end-to-end run against the actual launcher, on an ephemeral port
// and a throwaway data file so it leaves nothing behind. It boots the CLI with --json (so the banner is
// machine-parseable and no browser opens), defines one route through the management API, then curls both
// a mocked path and an unmocked one to show the honest 404. Zero dependencies — Node stdlib + curl only.
import { spawn, execFile } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "bin", "dan-oss-mock.js");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function curl(args) {
  return new Promise((resolve, reject) => {
    execFile("curl", args, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

function line() {
  console.log("─".repeat(78));
}

const dataFile = path.join(os.tmpdir(), `dan-oss-mock-demo-${crypto.randomUUID()}.json`);
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, [CLI, "--json"], {
  env: { ...process.env, DAN_OSS_MOCK_PORT: String(port), DAN_OSS_MOCK_DATA: dataFile },
  stdio: ["ignore", "pipe", "inherit"],
});

// Wait for the one-line JSON startup banner, then confirm the port is actually accepting connections.
const banner = await new Promise((resolve, reject) => {
  let buf = "";
  const timer = setTimeout(() => reject(new Error("server did not print its startup banner in time")), 8000);
  child.stdout.on("data", (c) => {
    buf += c.toString();
    const nl = buf.indexOf("\n");
    if (nl !== -1) {
      clearTimeout(timer);
      resolve(buf.slice(0, nl));
    }
  });
  child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited early (code ${code})`)); });
});

let failed = false;
try {
  console.log("[DAN] MOCK — make demo (real output, ephemeral port, throwaway data file)");
  line();
  console.log("1. Booted the launcher with --json on an ephemeral port. Its startup banner:");
  console.log(`   ${banner.trim()}`);
  console.log();

  console.log(`2. Define a route (GET /hello -> JSON body) via the management API:`);
  const post = await curl([
    "-s", "-X", "POST", `${base}/_mock/api/routes`,
    "-H", "content-type: application/json",
    "-d", JSON.stringify({ method: "GET", path: "/hello", status: 200, body: { hello: "world", from: "[DAN] MOCK" } }),
  ]);
  console.log(`   $ curl -s -X POST ${base}/_mock/api/routes -d '{"method":"GET","path":"/hello",...}'`);
  console.log(`   ${post.trim()}`);
  console.log();

  console.log("3. Hit the mock — it is live immediately at the same origin:");
  const hello = await curl(["-s", "-i", `${base}/hello`]);
  for (const l of hello.trim().split(/\r?\n/)) console.log(`   ${l}`);
  console.log();

  console.log("4. Hit a path with no mock — an honest JSON 404, never a silent empty 200:");
  const nope = await curl(["-s", "-i", `${base}/nope`]);
  for (const l of nope.trim().split(/\r?\n/)) console.log(`   ${l}`);
  line();
  console.log("Demo complete — server stopped, temp data file removed.");
} catch (err) {
  failed = true;
  console.error(`demo failed: ${err.message}`);
} finally {
  child.kill("SIGINT");
  await new Promise((r) => child.once("exit", r)).catch(() => {});
  await fs.rm(dataFile, { force: true }).catch(() => {});
}

process.exit(failed ? 1 : 0);
