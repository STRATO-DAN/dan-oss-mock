#!/usr/bin/env node
// [DAN] MOCK — real CLI entry. Starts the local server (loopback only), opens the management UI,
// exits cleanly on Ctrl-C.
import { listen } from "../src/server.js";
import { execFile } from "node:child_process";
import path from "node:path";

const cwd = process.cwd();
const port = Number(process.env.DAN_OSS_MOCK_PORT) || 4871;
const dataFile = process.env.DAN_OSS_MOCK_DATA || path.join(cwd, ".dan-oss-mock.json");

const server = await listen(port, dataFile);
const uiUrl = `http://127.0.0.1:${port}/_mock`;

console.log(`[DAN] MOCK running at http://127.0.0.1:${port}`);
console.log(`Manage routes at: ${uiUrl}`);
console.log(`Routes saved to: ${dataFile}`);
console.log("Ctrl-C to stop.\n");

// execFile (no shell). On Windows `start` is a cmd builtin, so it must run via cmd.exe rather than be
// exec'd as a binary (otherwise auto-open silently no-ops on Windows).
const [openerCmd, openerArgs] =
  process.platform === "darwin" ? ["open", [uiUrl]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", uiUrl]]
      : ["xdg-open", [uiUrl]];
execFile(openerCmd, openerArgs, () => {});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
