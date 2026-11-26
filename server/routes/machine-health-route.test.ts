/**
 * GET /api/machines/health hands the client the last health round per machine,
 * through the real machines router, rebuilt field by field.
 * @covers MACHINE-09
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MACHINES_HEALTH_FILE } from "../boot/machine-health";
import { createMachinesRouter } from "./machines";
import type { AppContext } from "../types";

let dir: string;
let prevDir: string | undefined;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "health-route-"));
  prevDir = process.env.TOPICS_TOOLING_DIR;
  process.env.TOPICS_TOOLING_DIR = dir;
});
afterAll(() => {
  if (prevDir === undefined) delete process.env.TOPICS_TOOLING_DIR; else process.env.TOPICS_TOOLING_DIR = prevDir;
  rmSync(dir, { recursive: true, force: true });
});

// The router asks its context for a few helpers before it reaches this route.
const stubs = {
  json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
  errorResponse: (status: number, error: string) => new Response(JSON.stringify({ error }), { status }),
  readJSON: async () => null,
  matchRoute: (path: string, pattern: string) => {
    const m = path.match(new RegExp(`^${pattern.replace(/:\w+/g, "([^/]+)")}$`));
    return m ? { id: m[1] } : null;
  },
  machineStore: { get: () => null, list: () => [] },
  broadcastToAll: () => {},
  requestIdentity: () => ({ role: "owner", deviceId: null }),
};

async function get(path = "/api/machines/health", method = "GET"): Promise<Response | null> {
  const url = new URL(`http://x${path}`);
  return createMachinesRouter({ ...stubs, STATE_DIR: dir, APP_DATA_DIR: dir } as unknown as AppContext)(new Request(url, { method }), url, url.pathname, method);
}

const history = { step_s: 300, from: 0, cpu: [1], mem: [2] };
const security = { checked_at: 90, status: "warn", checks: [{ key: "updates", status: "warn", detail: "1 update waiting", msgs: [{ code: "updates.pending", params: { n: 1 } }] }] };

test("serves id, name, kind and security only, through the real router", async () => {
  writeFileSync(join(dir, MACHINES_HEALTH_FILE), JSON.stringify({
    at: 100,
    machines: [
      { id: "m1", name: "One", kind: "local", security, history, cards_today: [0] },
      { id: "ssh:root@203.0.113.9:22", name: "203.0.113.9", kind: "remote", security, history, cards_today: [] },
    ],
  }));
  const body = await (await get())!.json();
  expect(body).toEqual({ at: 100, machines: [{ id: "m1", name: "One", kind: "local", security }] });
  expect(JSON.stringify(body)).not.toContain("203.0.113.9");
});

test("a malformed element or an unknown status is dropped, not served", async () => {
  writeFileSync(join(dir, MACHINES_HEALTH_FILE), JSON.stringify({
    at: 1,
    machines: [null, 7, { id: "a", name: "A", kind: "local", security: null }, { id: "b", name: "B", kind: "local", security: { checked_at: 1, status: "great", checks: [] } },
      { id: "c", name: "C", kind: "remote", security: { checked_at: 1, status: "ok", checks: [null, { key: "disk", status: "ok", detail: "x" }, { key: "nope", status: "ok", detail: "y" }] } }],
  }));
  const body = await (await get())!.json();
  expect(body.machines).toEqual([{ id: "c", name: "C", kind: "remote", security: { checked_at: 1, status: "ok", checks: [{ key: "disk", status: "ok", detail: "x" }] } }]);
});

test("a missing or broken file is an empty round, not an error", async () => {
  writeFileSync(join(dir, MACHINES_HEALTH_FILE), "{nope");
  const res = await get();
  expect(res!.status).toBe(200);
  expect(await res!.json()).toEqual({ at: 0, machines: [] });
  rmSync(join(dir, MACHINES_HEALTH_FILE));
  expect(await (await get())!.json()).toEqual({ at: 0, machines: [] });
});

test("only GET on its path is its business", async () => {
  const res = await get("/api/machines/health", "POST");
  expect(res === null || res.status !== 200).toBe(true);
});
