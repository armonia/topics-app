/**
 * @covers MACHINE-01
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrimaryRole, PRIMARY_EPOCH_HEADER, PRIMARY_ID_HEADER, STALE_EPOCH_CODE } from "./primary-role";
import { createModelProxyHandler } from "../services/model-proxy";
import { createTaskDispatcher } from "../services/task-dispatcher";

const migration = readFileSync(join(import.meta.dir, "../db/migrations/20261118110000-primary-state.sql"), "utf-8");

function fixture(localId = "m-local") {
  const dir = mkdtempSync(join(tmpdir(), "primary-role-"));
  const db = new Database(":memory:");
  db.exec(migration);
  const stateFile = join(dir, "primary-state.json");
  const make = (id = localId) => createPrimaryRole({ db, stateFile, localMachineId: () => id });
  return { dir, db, stateFile, make, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const withEpoch = (n: number) => new Request("http://x/api/nodes/runs", { headers: { [PRIMARY_EPOCH_HEADER]: String(n) } });

describe("primary role", () => {
  test("nobody chosen: this install is its own primary at epoch 0", () => {
    const f = fixture();
    const role = f.make();
    expect(role.isPrimary()).toBe(true);
    expect(role.epoch()).toBe(0);
    f.done();
  });

  test("another machine chosen: this server is secondary", () => {
    const f = fixture("m-local");
    const role = f.make();
    role.adopt({ primaryMachineId: "m-other", epoch: 1 });
    expect(role.isPrimary()).toBe(false);
    f.done();
  });

  test("the state file is written and the higher epoch wins at boot", () => {
    const f = fixture();
    f.make().adopt({ primaryMachineId: "m-local", epoch: 3 });
    expect(JSON.parse(readFileSync(f.stateFile, "utf-8")).epoch).toBe(3);
    // The DB is restored from an older copy: the file still says 3.
    f.db.query("UPDATE primary_state SET epoch = 1, primary_machine_id = 'm-old'").run();
    const after = f.make();
    expect(after.epoch()).toBe(3);
    expect(after.state().primaryMachineId).toBe("m-local");
    expect((f.db.query("SELECT epoch FROM primary_state").get() as { epoch: number }).epoch).toBe(3);
    f.done();
  });

  test("a corrupt state file falls back to the DB", () => {
    const f = fixture();
    f.make().adopt({ primaryMachineId: "m-local", epoch: 2 });
    writeFileSync(f.stateFile, "{nope");
    expect(f.make().epoch()).toBe(2);
    f.done();
  });

  test("adopt refuses a lower epoch and a second owner of the same epoch", () => {
    const f = fixture();
    const role = f.make();
    role.adopt({ primaryMachineId: "m-a", epoch: 5 });
    expect(() => role.adopt({ primaryMachineId: "m-a", epoch: 4 })).toThrow();
    expect(() => role.adopt({ primaryMachineId: "m-b", epoch: 5 })).toThrow();
    f.done();
  });

  test("the old primary writes after the switch and is refused with its own code", async () => {
    const f = fixture();
    const role = f.make();
    role.adopt({ primaryMachineId: "m-local", epoch: 4 });
    const res = role.rejectStale(withEpoch(3));
    expect(res?.status).toBe(409);
    const body = await res!.json() as { code: string; epoch: number };
    expect(body.code).toBe(STALE_EPOCH_CODE);
    expect(body.epoch).toBe(4);
    expect(role.rejectStale(withEpoch(4))).toBeNull();
    expect(role.rejectStale(withEpoch(9))).toBeNull();
    expect(role.rejectStale(new Request("http://x/"))).toBeNull();
    f.done();
  });

  test("the model proxy refuses a stale epoch before looking at the token", async () => {
    const f = fixture();
    const role = f.make();
    role.adopt({ primaryMachineId: "m-local", epoch: 2 });
    const handler = createModelProxyHandler({
      stateDir: f.dir,
      machineExists: () => true,
      getAccessToken: async () => null,
      recoverAfter401: async () => null,
      rejectStale: (r) => role.rejectStale(r),
    });
    const res = await handler(new Request("http://x/v1/messages", { method: "POST", headers: { [PRIMARY_EPOCH_HEADER]: "1" }, body: "{}" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(STALE_EPOCH_CODE);
    f.done();
  });

  test("a dispatcher on a secondary server assigns no card", async () => {
    let touched = 0;
    const svc = new Proxy({}, { get: () => () => { touched++; return []; } }) as never;
    const dispatcher = createTaskDispatcher({ svc, isActive: () => false } as never);
    await dispatcher.tick("p1");
    dispatcher.onEnterTodo("p1", "t1");
    await dispatcher.reconcile({ reason: "poll" });
    expect(touched).toBe(0);
  });
  test("an empty or garbled epoch header means not declared, never 0", () => {
    const f = fixture();
    const role = f.make();
    role.adopt({ primaryMachineId: "m-local", epoch: 2 });
    for (const v of ["", " ", "abc", "-1", "1.5"]) {
      expect(role.rejectStale(new Request("http://x/", { headers: { [PRIMARY_EPOCH_HEADER]: v } }))).toBeNull();
    }
    f.done();
  });

  test("two servers: the replaced primary sends its epoch, the receiver adopts the higher one and refuses the lower", () => {
    const a = fixture("m-a");
    const b = fixture("m-b");
    const oldPrimary = a.make();
    const newPrimary = b.make();
    oldPrimary.adopt({ primaryMachineId: "m-a", epoch: 1 });
    newPrimary.adopt({ primaryMachineId: "m-b", epoch: 2 });
    // The old primary calls the new one with its own epoch: refused.
    const fromOld = new Request("http://b/api/nodes/runs", { headers: oldPrimary.outgoingHeaders() });
    expect(newPrimary.rejectStale(fromOld)?.status).toBe(409);
    // The new primary calls the old one: it adopts, becomes secondary, and refuses epoch 1 afterwards.
    const fromNew = new Request("http://a/api/nodes/runs", { headers: newPrimary.outgoingHeaders() });
    expect(oldPrimary.rejectStale(fromNew)).toBeNull();
    expect(oldPrimary.epoch()).toBe(2);
    expect(oldPrimary.isPrimary()).toBe(false);
    expect(oldPrimary.rejectStale(withEpoch(1))?.status).toBe(409);
    // A higher epoch without a machine id is not adopted.
    const anon = fixture("m-c").make();
    anon.rejectStale(new Request("http://c/", { headers: { [PRIMARY_EPOCH_HEADER]: "9" } }));
    expect(anon.epoch()).toBe(0);
    expect(newPrimary.outgoingHeaders()[PRIMARY_ID_HEADER]).toBe("m-b");
    a.done();
    b.done();
  });

  test("the machine id is read once and a missing state folder is created", () => {
    const f = fixture();
    let reads = 0;
    const nested = join(f.dir, "deeper", "primary-state.json");
    const role = createPrimaryRole({ db: f.db, stateFile: nested, localMachineId: () => { reads++; return "m-local"; } });
    role.adopt({ primaryMachineId: "m-local", epoch: 1 });
    role.isPrimary();
    role.isPrimary();
    expect(reads).toBe(1);
    expect(readFileSync(nested, "utf-8")).toContain("m-local");
    f.done();
  });

  test("a blocker finishing on a secondary server does not wake the tick after the grace", async () => {
    const touched: string[] = [];
    const dependent = { id: "t2", projectId: "p1", status: "todo", parentTaskId: null };
    const svc = new Proxy({}, {
      get: (_t, name) => (...args: unknown[]) => {
        touched.push(String(name));
        return name === "listBlockedBy" ? [dependent] : name === "getBoardSettings" ? { autoDispatch: true } : name === "get" || name === "isDispatchBlocked" || args.length === 0 ? null : [];
      },
    }) as never;
    const dispatcher = createTaskDispatcher({ svc, isActive: () => false, graceMs: 1 } as never);
    dispatcher.onBlockerDone("t1");
    await new Promise((r) => setTimeout(r, 400));
    // The tick reads the board settings a second time: that read would mean the gate let it through.
    expect(touched.filter((n) => n === "getBoardSettings")).toHaveLength(1);
  });

});
