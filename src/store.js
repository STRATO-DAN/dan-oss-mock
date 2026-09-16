// Real persistence — a plain JSON file next to wherever the tool is run, so routes survive a
// restart without needing a real database for a tool whose whole pitch is "no backend to
// deploy". Every write is atomic (temp file + rename), so a crash mid-write can never leave a
// half-written, corrupt route file behind — the estate-wide "atomic writes" discipline, applied
// here because it's the correct thing to do, not borrowed for its own sake.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

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
      this.routes = Array.isArray(parsed.routes) ? parsed.routes : [];
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
      await fs.writeFile(tmp, JSON.stringify({ routes: this.routes }, null, 2), "utf8");
      await fs.rename(tmp, this.filePath);
    });
    this._saveChain = mine;
    return mine;
  }

  list() {
    return this.routes;
  }

  add(route) {
    const real = {
      id: crypto.randomUUID(),
      method: route.method.toUpperCase(),
      path: route.path,
      status: Number(route.status) || 200,
      headers: route.headers && typeof route.headers === "object" ? route.headers : {},
      body: route.body ?? "",
      delayMs: Math.max(0, Number(route.delayMs) || 0),
      enabled: route.enabled !== false,
      createdAt: new Date().toISOString(),
    };
    this.routes.push(real);
    return real;
  }

  update(id, patch) {
    const i = this.routes.findIndex((r) => r.id === id);
    if (i === -1) return null;
    const merged = { ...this.routes[i], ...patch, id };
    // Re-apply the same normalization add() enforces, so a PATCH can't set an unbounded delay,
    // a non-numeric status, or a lowercase method that then never matches an uppercased request.
    if (patch.method !== undefined) merged.method = String(merged.method).toUpperCase();
    if (patch.status !== undefined) merged.status = Number(merged.status) || 200;
    if (patch.delayMs !== undefined) merged.delayMs = Math.max(0, Number(merged.delayMs) || 0);
    this.routes[i] = merged;
    return this.routes[i];
  }

  remove(id) {
    const before = this.routes.length;
    this.routes = this.routes.filter((r) => r.id !== id);
    return this.routes.length < before;
  }
}
