// Real tests for the launcher CLI flags and the startup exit-code contract — the hand-rolled flag
// parsing and fail-fast startup added in 0.2.0. Each spawns the real bin as a child process, exactly
// as a user (or a script) would run it, and asserts on its stdout/stderr and exit code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "bin", "dan-oss-mock.js");
const PKG = JSON.parse(await fs.readFile(path.join(__dirname, "..", "package.json"), "utf8"));

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

// Run the CLI to completion (for the flags that exit on their own) and collect its output + exit code.
function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

// Boot the CLI as a long-running server, wait for its first line of stdout (the banner), then return a
// handle that can read that banner and stop the process.
function boot(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`no banner in time; stderr=${stderr}`)); }, 8000);
    child.stderr.on("data", (c) => (stderr += c));
    child.stdout.on("data", (c) => {
      stdout += c.toString();
      if (stdout.includes("\n")) {
        clearTimeout(timer);
        resolve({
          firstLine: stdout.slice(0, stdout.indexOf("\n")),
          stop: () => new Promise((r) => { child.once("exit", r); child.kill("SIGINT"); setTimeout(() => child.kill("SIGKILL"), 2000); }),
        });
      }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`exited early (code ${code}); stderr=${stderr}`)); });
  });
}

test("--version prints the package version and exits 0", async () => {
  const { code, stdout } = await run(["--version"]);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), PKG.version);
});

test("--help prints usage, env vars, and the exit-code contract, and exits 0", async () => {
  const { code, stdout } = await run(["--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /DAN_OSS_MOCK_PORT/);
  assert.match(stdout, /DAN_OSS_MOCK_DATA/);
  assert.match(stdout, /Exit codes:/);
});

test("an unknown flag is a usage error: one-line stderr and exit 2", async () => {
  const { code, stdout, stderr } = await run(["--nope"]);
  assert.equal(code, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /unknown option/);
  assert.equal(stderr.trim().split("\n").length, 1, "usage error is a single line, not a stack");
});

test("--json prints exactly one JSON object {url,port,dataFile} and the server really serves", async () => {
  const port = await freePort();
  const dataFile = path.join(os.tmpdir(), `dan-oss-mock-bin-${crypto.randomUUID()}.json`);
  const managementToken = "test-launcher-management-token-123456789";
  const srv = await boot(["--json"], { DAN_OSS_MOCK_PORT: String(port), DAN_OSS_MOCK_DATA: dataFile, DAN_OSS_MOCK_TOKEN: managementToken });
  try {
    const banner = JSON.parse(srv.firstLine); // must parse as one object
    assert.equal(banner.port, port);
    assert.equal(banner.url, `http://127.0.0.1:${port}`);
    assert.equal(banner.dataFile, dataFile);
    // the server is genuinely up on that port
    const res = await fetch(`http://127.0.0.1:${port}/_mock/api/routes`, { headers: { authorization: `Bearer ${managementToken}` } });
    assert.equal(res.status, 200);
  } finally {
    await srv.stop();
    await fs.rm(dataFile, { force: true }).catch(() => {});
  }
});

test("startup failure on a port already in use: one-line stderr, no stack, exit 1", async () => {
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(port, "127.0.0.1", r));
  try {
    const { code, stderr, stdout } = await run([], { DAN_OSS_MOCK_PORT: String(port) });
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /already in use/);
    assert.doesNotMatch(stderr, /\bat .*:\d+:\d+/, "a one-line reason, never a raw stack trace");
    assert.equal(stderr.trim().split("\n").length, 1);
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

test("startup failure on an unusable data-file path: one-line stderr, exit 1", async () => {
  const bad = path.join(os.tmpdir(), `no-such-dir-${crypto.randomUUID()}`, "routes.json");
  const { code, stderr } = await run([], { DAN_OSS_MOCK_DATA: bad });
  assert.equal(code, 1);
  assert.match(stderr, /data-file directory does not exist/);
  assert.equal(stderr.trim().split("\n").length, 1);
});
