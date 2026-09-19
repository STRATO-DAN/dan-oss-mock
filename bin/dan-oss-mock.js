#!/usr/bin/env node
// [DAN] MOCK — real CLI entry. Starts the local server (loopback only), opens the management UI,
// exits cleanly on Ctrl-C.
//
// Flags are hand-rolled (zero dependencies, Node stdlib only) and purely additive — the no-flag
// invocation behaves exactly as it always has. Exit-code contract (also printed by --help):
//   0  clean start, --version, or --help
//   1  startup failure (port already in use, unusable data-file path) — one-line stderr, no stack
//   2  usage error (unknown flag)
import { listen } from "../src/server.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printHelp() {
  const v = readVersion();
  process.stdout.write(
    `[DAN] MOCK v${v} — local-first API mocking. Define a response, hit the URL. No backend to deploy.\n` +
      `\n` +
      `Usage:\n` +
      `  dan-oss-mock            Start the loopback mock server and open the /_mock management UI.\n` +
      `  dan-oss-mock --json     Start, but print the startup banner as one JSON object {url,port,dataFile}\n` +
      `                          (no browser auto-open) — for scripts and CI.\n` +
      `  dan-oss-mock --version  Print the version and exit.\n` +
      `  dan-oss-mock --help     Print this help and exit.\n` +
      `\n` +
      `Environment:\n` +
      `  DAN_OSS_MOCK_PORT       Local port for both the mocked API and the /_mock UI (default 4871).\n` +
      `  DAN_OSS_MOCK_DATA       Where routes are saved (default .dan-oss-mock.json in the current dir).\n` +
      `\n` +
      `Exit codes:\n` +
      `  0   clean start, --version, or --help\n` +
      `  1   startup failure (port already in use, unusable data-file path)\n` +
      `  2   usage error (unknown flag)\n` +
      `\n` +
      `Management requires a bearer token, printed on stderr at startup. Set DAN_OSS_MOCK_TOKEN (32+ characters) to supply your own. Mock routes remain unauthenticated.\n`,
  );
}

// --- flag parsing ---------------------------------------------------------------------------------
const args = process.argv.slice(2);
let jsonBanner = false;
for (const arg of args) {
  if (arg === "--version" || arg === "-v") {
    process.stdout.write(`${readVersion()}\n`);
    process.exit(0);
  } else if (arg === "--help" || arg === "-h") {
    printHelp();
    process.exit(0);
  } else if (arg === "--json") {
    jsonBanner = true;
  } else {
    process.stderr.write(`[DAN] MOCK: unknown option ${JSON.stringify(arg)}. Try --help.\n`);
    process.exit(2);
  }
}

const cwd = process.cwd();
const port = Number(process.env.DAN_OSS_MOCK_PORT) || 4871;
const dataFile = process.env.DAN_OSS_MOCK_DATA || path.join(cwd, ".dan-oss-mock.json");

// --- startup preflight: fail fast, with a one-line reason and a non-zero exit, never a raw stack ---
function failStartup(message) {
  process.stderr.write(`[DAN] MOCK: cannot start — ${message}\n`);
  process.exit(1);
}

// The data-file path must be usable before we bind a port. A missing/unwritable parent directory, or a
// path that is itself a directory, would otherwise only surface later as a crash on the first save.
try {
  const dir = path.dirname(dataFile);
  fs.accessSync(dir, fs.constants.W_OK);
  if (fs.existsSync(dataFile)) {
    if (fs.statSync(dataFile).isDirectory()) {
      throw new Error(`data-file path is a directory, not a file: ${dataFile}`);
    }
    fs.accessSync(dataFile, fs.constants.W_OK);
  }
} catch (err) {
  const reason =
    err && err.code === "ENOENT"
      ? `data-file directory does not exist: ${path.dirname(dataFile)}`
      : err && err.code === "EACCES"
        ? `data-file path is not writable: ${dataFile}`
        : (err && err.message) || String(err);
  failStartup(reason);
}

let server;
try {
  server = await listen(port, dataFile);
} catch (err) {
  const reason =
    err && err.code === "EADDRINUSE"
      ? `port ${port} is already in use — set DAN_OSS_MOCK_PORT to choose another`
      : err && err.code === "EACCES"
        ? `port ${port} is not permitted (try a port above 1024)`
        : (err && err.message) || String(err);
  failStartup(reason);
}

const baseUrl = `http://127.0.0.1:${port}`;
const uiUrl = `${baseUrl}/_mock`;
process.stderr.write(`Management token (keep private): ${server.managementToken}\n`);

if (jsonBanner) {
  // Exactly one JSON object on stdout, nothing else — safe to pipe into `jq` or parse in a script.
  process.stdout.write(`${JSON.stringify({ url: baseUrl, port, dataFile })}\n`);
} else {
  console.log(`[DAN] MOCK running at ${baseUrl}`);
  console.log(`Manage routes at: ${uiUrl}`);
  console.log(`Routes saved to: ${dataFile}`);
  console.log("Ctrl-C to stop.\n");

  // execFile (no shell). On Windows `start` is a cmd builtin, so it must run via cmd.exe rather than be
  // exec'd as a binary (otherwise auto-open silently no-ops on Windows). Suppressed under --json so a
  // scripted/CI run never spawns a browser.
  const [openerCmd, openerArgs] =
    process.platform === "darwin" ? ["open", [uiUrl]]
      : process.platform === "win32" ? ["cmd", ["/c", "start", "", uiUrl]]
        : ["xdg-open", [uiUrl]];
  execFile(openerCmd, openerArgs, () => {});
}

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
