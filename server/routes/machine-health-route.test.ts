/**
 * GET /api/machines/health hands the client the last health round per machine.
 * @covers MACHINE-06
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMachineHealthRoute } from "./machine-health";
import type { MachinesHealthFile } from "../../shared/machine-health";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "health-route-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const call = (route: ReturnType<typeof createMachineHealthRoute>, path = "/api/machines/health", method = "GET") =>
  route(new Request(`http://x${path}`, { method }), new URL(`http://x${path}`), path, method);

test("serves the machines of the last round", async () => {
  const file = join(dir, "h.json");
  const body: MachinesHealthFile = {
    at: 100,
    machines: [{
      id: "m1", name: "One", kind: "local",
      security: { checked_at: 90, status: "warn", checks: [{ key: "updates", status: "warn", detail: "1 update waiting" }] },
      history: { step_s: 300, from: 0, cpu: [], mem: [] }, cards_today: [],
    }],
  };
  writeFileSync(file, JSON.stringify(body));
  const res = await call(createMachineHealthRoute(file));
  expect(await res!.json()).toEqual(body);
});

test("a missing or broken file is an empty round, not an error", async () => {
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{nope");
  for (const file of [join(dir, "absent.json"), bad]) {
    const res = await call(createMachineHealthRoute(file));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ at: 0, machines: [] });
  }
});

test("other paths and methods are not its business", async () => {
  const route = createMachineHealthRoute(join(dir, "h.json"));
  expect(await call(route, "/api/machines/other")).toBeNull();
  expect(await call(route, "/api/machines/health", "POST")).toBeNull();
});
