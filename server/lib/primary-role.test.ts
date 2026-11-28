/**
 * @covers MACHINE-01
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrimaryRole, LOCAL_MACHINE_ID_FILE, writeLocalMachineId, PAIRING_MACHINE_HEADER, PRIMARY_EPOCH_HEADER, STALE_EPOCH_CODE } from "./primary-role";
import { createModelProxyHandler, mintModelToken } from "../services/model-proxy";
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
  test("the local machine id is published next to the state file for outside readers", () => {
    const f = fixture();
    writeLocalMachineId(f.dir, "m-local");
    expect(JSON.parse(readFileSync(join(f.dir, LOCAL_MACHINE_ID_FILE), "utf-8"))).toEqual({ machineId: "m-local" });
    f.done();
  });

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

  test("a dispatcher on a secondary server assigns no card of its own board, but works a mirror card", async () => {
    const touched: string[] = [];
    const normal = { id: "t-normal", status: "todo", claudeTaskId: null } as never;
    const mirror = { id: "t-mirror", status: "todo", claudeTaskId: "node-run:origin-1" } as never;
    const svc = new Proxy({}, {
      get: (_t, name) => name === "list"
        ? () => [normal, mirror]
        : name === "getBoardSettings"
          ? () => ({ autoDispatch: true, dispatchPaused: false, nightMode: false, dispatchRetryCap: 3 })
          : name === "isDispatchBlocked"
            ? (id: string) => { touched.push(`blocked? ${id}`); return false; }
            : (...args: unknown[]) => { touched.push(`${String(name)} ${JSON.stringify(args)}`); return []; },
    }) as never;
    const dispatcher = createTaskDispatcher({
      svc, isActive: () => false,
      resolveProject: () => ({ path: "/tmp/x", projectStoreId: null }),
      log: (m: string) => { touched.push(`log ${m}`); },
    } as never);
    await dispatcher.tick("p1").catch(() => {});
    expect(touched.some((m) => m.includes("t-mirror")), "the mirror card is worked").toBe(true);
    expect(touched.some((m) => m.includes("t-normal")), "the card of the own board is left alone").toBe(false);
  });
  test("a secondary does not take back a card of its own board on restart, nor on a resume", async () => {
    const touched: string[] = [];
    const normal = { id: "t-normal", status: "in_progress", claudeTaskId: null, assignedTopicId: "topic-n" } as never;
    const svc = new Proxy({}, {
      get: (_t, name) => name === "list"
        ? () => [normal]
        : name === "get"
          ? (id: string) => { touched.push(`get ${id}`); return { task: normal }; }
          : (...args: unknown[]) => { touched.push(`${String(name)} ${JSON.stringify(args)}`); return []; },
    }) as never;
    const dispatcher = createTaskDispatcher({
      svc, isActive: () => false,
      resolveProject: () => ({ path: "/tmp/x", projectStoreId: null }),
      log: (m: string) => { touched.push(`log ${m}`); },
    } as never);
    await dispatcher.reconcile({ reason: "boot" } as never).catch(() => {});
    await dispatcher.resume("t-normal", "continue").catch(() => {});
    const afterRead = touched.filter((m) => m.includes("t-normal") && !m.startsWith("get "));
    expect(afterRead, "nothing is done to the card of the own board").toEqual([]);
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
    // The new primary paired the old one: its device there is the channel.
    oldPrimary.recordChannel({ deviceId: "dev-b", machineId: "m-b" });
    const fromNew = new Request("http://a/api/nodes/runs", { headers: newPrimary.outgoingHeaders() });
    expect(oldPrimary.rejectStale(fromNew)).toBeNull();
    expect(oldPrimary.epoch(), "the refusal check alone never adopts").toBe(1);
    expect(oldPrimary.adoptFrom(fromNew, { deviceId: "dev-b" })).toBe(true);
    expect(oldPrimary.state()).toMatchObject({ primaryMachineId: "m-b", epoch: 2 });
    expect(oldPrimary.isPrimary()).toBe(false);
    expect(oldPrimary.rejectStale(withEpoch(1))?.status).toBe(409);
    // A server that is no longer the primary stops sending its epoch.
    expect(oldPrimary.outgoingHeaders()).toEqual({});
    a.done();
    b.done();
  });

  test("a secondary sends no pairing header, and a channel already recorded refuses a different machine", () => {
    const f = fixture("m-local");
    const role = f.make();
    // Nothing chosen yet: a virgin install is its own primary and can pair its first devices.
    expect(role.pairingHeaders()).toEqual({ [PAIRING_MACHINE_HEADER]: "m-local" });
    role.recordChannel({ deviceId: "dev-a", machineId: "m-a" });
    expect(role.channel()).toEqual({ deviceId: "dev-a", machineId: "m-a" });
    // Demoted to secondary: it must stop declaring itself at pairing, same as `outgoingHeaders`.
    role.adopt({ primaryMachineId: "m-a", epoch: 5 });
    expect(role.pairingHeaders()).toEqual({});
    // Even if a secondary's declared id slipped through, the channel does not change hands
    // for a machine that is not the one this server already recognizes as primary.
    role.recordChannel({ deviceId: "dev-d", machineId: "m-d" });
    expect(role.channel(), "the rogue pairing left the channel alone").toEqual({ deviceId: "dev-a", machineId: "m-a" });
    // Same server, an epoch that is not above this one: still no takeover.
    role.recordChannel({ deviceId: "dev-d2", machineId: "m-d", epoch: 5 });
    expect(role.channel(), "an equal epoch takes nothing").toEqual({ deviceId: "dev-a", machineId: "m-a" });
    // The real primary re-pairing (a new device row for the same machine) still wins.
    role.recordChannel({ deviceId: "dev-a2", machineId: "m-a" });
    expect(role.channel()).toEqual({ deviceId: "dev-a2", machineId: "m-a" });
    f.done();
  });

  test("a primary chosen later takes the channel over with a higher epoch, and the chosen primary declares it at pairing", () => {
    const f = fixture("m-local");
    const role = f.make();
    role.recordChannel({ deviceId: "dev-a", machineId: "m-a" });
    role.adopt({ primaryMachineId: "m-a", epoch: 5 });
    // The fleet replaced m-a with m-d at epoch 6, and m-d paired this node: the
    // owner of this machine approved it, and the epoch says who is current.
    role.recordChannel({ deviceId: "dev-d", machineId: "m-d", epoch: 6 });
    expect(role.channel()).toEqual({ deviceId: "dev-d", machineId: "m-d" });
    // Only the new channel's device moves the epoch, and under m-d's id.
    const from = (epoch: number) => new Request("http://x/api/nodes/runs", { headers: { [PRIMARY_EPOCH_HEADER]: String(epoch) } });
    expect(role.adoptFrom(from(6), { deviceId: "dev-a" }), "the replaced primary is no longer the channel").toBe(false);
    expect(role.adoptFrom(from(6), { deviceId: "dev-d" })).toBe(true);
    expect(role.state()).toMatchObject({ primaryMachineId: "m-d", epoch: 6 });
    // The machine that holds the channel keeps it when it pairs a new device, with no epoch to declare.
    role.recordChannel({ deviceId: "dev-d2", machineId: "m-d" });
    expect(role.channel()).toEqual({ deviceId: "dev-d2", machineId: "m-d" });
    // A chosen primary declares both headers at pairing; a secondary declares neither.
    const own = fixture("m-own");
    const chosen = own.make();
    chosen.adopt({ primaryMachineId: "m-own", epoch: 4 });
    expect(chosen.pairingHeaders()).toEqual({ [PAIRING_MACHINE_HEADER]: "m-own", [PRIMARY_EPOCH_HEADER]: "4" });
    chosen.adopt({ primaryMachineId: "m-other", epoch: 9 });
    expect(chosen.pairingHeaders()).toEqual({});
    own.done();
    f.done();
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


  test("the model proxy never adopts: no token, a fake token or a valid node token with a huge epoch leave the role as it was", async () => {
    const f = fixture("m-local");
    const role = f.make();
    role.adopt({ primaryMachineId: "m-local", epoch: 2 });
    const token = mintModelToken(f.dir, "m-node");
    const handler = createModelProxyHandler({
      stateDir: f.dir,
      machineExists: (id) => id === "m-node",
      getAccessToken: async () => null,
      recoverAfter401: async () => null,
      rejectStale: (r) => role.rejectStale(r),
      log: () => {},
    });
    const claim = (headers: Record<string, string>) => handler(new Request("http://x/v1/messages/count_tokens", {
      method: "POST", headers: { [PRIMARY_EPOCH_HEADER]: "9007199254740991", ...headers }, body: "{}",
    }));
    expect((await claim({})).status).toBe(401);
    expect((await claim({ authorization: "Bearer tmt_forged" })).status).toBe(401);
    // The node's own token: authenticated, and still no adoption.
    expect((await claim({ authorization: `Bearer ${token}` })).status).not.toBe(401);
    expect(role.state()).toMatchObject({ primaryMachineId: "m-local", epoch: 2 });
    expect(role.isPrimary()).toBe(true);
    expect(JSON.parse(readFileSync(f.stateFile, "utf-8"))).toMatchObject({ primaryMachineId: "m-local", epoch: 2 });
    f.done();
  });

  test("only the channel device adopts, any higher epoch, under the channel's machine id, and every adoption is logged", () => {
    const f = fixture("m-node");
    const lines: string[] = [];
    const role = createPrimaryRole({ db: f.db, stateFile: f.stateFile, localMachineId: () => "m-node", log: (l) => lines.push(l) });
    const from = (epoch: string) => new Request("http://x/api/nodes/runs", { headers: { [PRIMARY_EPOCH_HEADER]: epoch } });
    // No channel yet: nobody adopts, not even an authenticated device.
    expect(role.adoptFrom(from("2"), { deviceId: "dev-a" })).toBe(false);
    role.recordChannel({ deviceId: "dev-a", machineId: "m-a" });
    // Loopback (no device), anonymous and another device: nothing moves.
    expect(role.adoptFrom(from("2"), { deviceId: null })).toBe(false);
    expect(role.adoptFrom(from("2"), null)).toBe(false);
    expect(role.adoptFrom(from("2"), { deviceId: "dev-other" })).toBe(false);
    expect(role.state()).toMatchObject({ primaryMachineId: null, epoch: 0 });
    // The channel: a node at 0 adopts 2 directly, with no ceiling.
    expect(role.adoptFrom(from("2"), { deviceId: "dev-a" })).toBe(true);
    expect(role.state()).toMatchObject({ primaryMachineId: "m-a", epoch: 2 });
    expect(role.adoptFrom(from("40"), { deviceId: "dev-a" })).toBe(true);
    expect(role.state()).toMatchObject({ primaryMachineId: "m-a", epoch: 40 });
    expect(role.isPrimary()).toBe(false);
    expect(lines.filter((l) => l.startsWith("[primary] adopted"))).toHaveLength(2);
    expect(lines.at(-1)).toContain("adopted epoch 40 from m-a");
    f.done();
  });

  test("a failed write leaves the role unchanged in memory too", () => {
    const f = fixture("m-local");
    const blocker = join(f.dir, "not-a-folder");
    writeFileSync(blocker, "");
    const lines: string[] = [];
    const role = createPrimaryRole({ db: f.db, stateFile: join(blocker, "primary-state.json"), localMachineId: () => "m-local", log: (l) => lines.push(l) });
    expect(() => role.adopt({ primaryMachineId: "m-local", epoch: 1 })).toThrow();
    expect(role.state()).toMatchObject({ primaryMachineId: null, epoch: 0 });
    role.recordChannel({ deviceId: "dev-other", machineId: "m-other" });
    const from = new Request("http://x/api/nodes/runs", { headers: { [PRIMARY_EPOCH_HEADER]: "1" } });
    expect(role.adoptFrom(from, { deviceId: "dev-other" })).toBe(false);
    expect(lines.join(" ")).toContain("not adopted");
    expect(role.state()).toMatchObject({ primaryMachineId: null, epoch: 0 });
    expect(role.isPrimary(), "a write that failed must not turn this server into a secondary").toBe(true);
    f.done();
  });

  test("nothing chosen: boot writes no state file", () => {
    const f = fixture();
    f.make();
    expect(existsSync(f.stateFile)).toBe(false);
    f.done();
  });

  test("a state file that cannot be written does not stop the boot", () => {
    const f = fixture();
    f.db.query("UPDATE primary_state SET primary_machine_id = 'm-local', epoch = 3 WHERE id = 1").run();
    // The state file's folder is a regular file: every write fails, as on a read-only or full disk.
    const blocker = join(f.dir, "not-a-folder");
    writeFileSync(blocker, "");
    const lines: string[] = [];
    const role = createPrimaryRole({ db: f.db, stateFile: join(blocker, "primary-state.json"), localMachineId: () => "m-local", log: (l) => lines.push(l) });
    expect(role.isPrimary()).toBe(true);
    expect(role.epoch()).toBe(3);
    expect(lines.join(" ")).toContain("could not write the primary state");
    f.done();
  });
});
