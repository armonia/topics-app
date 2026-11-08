/**
 * Declared slots: the column, the store, the PATCH route and the overflow
 * that reads them (card cbf3b91d).
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { EMBEDDED_MIGRATIONS } from "../db/migrations-embedded";
import { createMachineStore } from "./machine-store";
import { createMachinesRouter } from "../routes/machines";
import { effectiveSlots, overflowMachinesFrom, pickOverflowMachine, type OverflowMachine } from "./dispatch-overflow";
import type { AppContext } from "../types";

function store() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  for (const m of EMBEDDED_MIGRATIONS) db.run(m.sql);
  return createMachineStore(db, process.cwd());
}

describe("machine slots", () => {
  it("a node starts without a declaration and keeps the one set", () => {
    const machines = store();
    const node = machines.upsertNode({ hostname: "pc:1", name: "PC", baseUrl: "http://pc.test" });
    expect(node.slots).toBeNull();
    expect(machines.setSlots(node.id, 4)!.slots).toBe(4);
    expect(machines.touchNode(node.id)!.slots).toBe(4);
    expect(machines.setSlots(node.id, null)!.slots).toBeNull();
    expect(machines.setSlots("gone", 3)).toBeNull();
  });

  it("the overflow list carries the declaration and a card fits up to it", () => {
    const rows = [{ id: "pc", name: "PC", baseUrl: "http://pc.test", status: "online", slots: 4 }];
    const [pc] = overflowMachinesFrom({ rows, isCloud: () => false, cloudEnabled: false, environmentOk: null, wakeable: false });
    expect(pc!.slots).toBe(4);
    const ok = { cloudCredit: false, githubOrigin: false, model: null };
    expect(pickOverflowMachine([pc!], { ...ok, load: () => 3 })?.id).toBe("pc");
    expect(pickOverflowMachine([pc!], { ...ok, load: () => 4 })).toBeNull();
  });

  it("reported free RAM caps the declaration: min(slots, (free - 4 GB) / 1.7 GB)", () => {
    const node: OverflowMachine = { id: "pc", name: "PC", kind: "node", online: true, slots: 6 };
    expect(effectiveSlots(node)).toBe(6);
    expect(effectiveSlots({ ...node, freeMemoryMb: 12 * 1024 })).toBe(4);
    expect(effectiveSlots({ ...node, freeMemoryMb: 8 * 1024 })).toBe(2);
    expect(effectiveSlots({ ...node, freeMemoryMb: 3 * 1024 })).toBe(0);
    expect(effectiveSlots({ ...node, slots: 2, freeMemoryMb: 30 * 1024 })).toBe(2);
  });
});

describe("PATCH /api/machines/:id with slots", () => {
  function patch(machines: ReturnType<typeof store>, id: string, body: unknown): Promise<Response | null> {
    const ctx = {
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      errorResponse: (status: number, error: string) => new Response(JSON.stringify({ error }), { status }),
      readJSON: async () => body,
      matchRoute: (path: string, pattern: string) => {
        const m = path.match(new RegExp(`^${pattern.replace(":id", "([^/]+)")}$`));
        return m ? { id: m[1] } : null;
      },
      machineStore: machines,
      broadcastToAll: () => {},
      requestIdentity: () => ({ kind: "owner" }),
    } as unknown as AppContext;
    const req = new Request(`http://localhost/api/machines/${id}`, { method: "PATCH" });
    const url = new URL(req.url);
    return Promise.resolve(createMachinesRouter(ctx)(req, url, url.pathname, "PATCH"));
  }

  it("accepts 1-8 and null, refuses the rest", async () => {
    const machines = store();
    const node = machines.upsertNode({ hostname: "pc:1", name: "PC", baseUrl: "http://pc.test" });
    const ok = await patch(machines, node.id, { slots: 4 });
    expect(ok!.status).toBe(200);
    expect(((await ok!.json()) as { slots: number }).slots).toBe(4);
    for (const bad of [0, 9, 2.5, "4"]) expect((await patch(machines, node.id, { slots: bad }))!.status).toBe(400);
    expect((await patch(machines, "gone", { slots: 2 }))!.status).toBe(404);
    expect(machines.get(node.id)!.slots).toBe(4);
  });
});
