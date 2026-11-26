/**
 * A card pinned to a machine that cannot run it (zero slots, or offline with no
 * way to wake it) moves to an allowed machine instead of waiting for ever.
 * Card b2b33bf0.
 *
 * @covers KANBAN-76
 */
import { describe, it, expect } from "bun:test";
import { harness, dispatch, flush } from "./task-dispatcher-remote-node-test-support";
import { machineForbidden, overflowMachinesFrom, pickOverflowMachine, pickReassignTarget, type OverflowMachine } from "./dispatch-overflow";
import { wakeBreaker } from "./wake-breaker";

const FORBIDDEN = "node-1";
const ALLOWED = "node-2";

function machines(over: Partial<Record<string, Partial<OverflowMachine>>> = {}): OverflowMachine[] {
  return [
    { id: FORBIDDEN, name: "first", kind: "node", online: false, wakeable: false, slots: 0, ...over[FORBIDDEN] },
    { id: ALLOWED, name: "second", kind: "node", online: true, wakeable: false, slots: 2, ...over[ALLOWED] },
  ];
}

function setup(list: OverflowMachine[]) {
  const h = harness({}, { overflowMachines: () => list });
  h.db.run("INSERT INTO machines (id) VALUES (?)", [ALLOWED]);
  return h;
}

describe("machineForbidden, cloud row", () => {
  it("a cloud whose account is refused forbids a card pinned there; a merely offline one does not", () => {
    expect(machineForbidden({ id: "c", name: "c", kind: "cloud", online: false, refused: true })).toBe(true);
    expect(machineForbidden({ id: "c", name: "c", kind: "cloud", online: false })).toBe(false);
  });
  it("overflowMachinesFrom marks the cloud refused only on a definite `false`", () => {
    const rows = [{ id: "c", name: "c", baseUrl: "claude-cloud://", status: "online" }];
    const mk = (environmentOk: boolean | null) => overflowMachinesFrom({ rows, isCloud: () => true, cloudEnabled: true, environmentOk, wakeable: false })[0]!;
    expect(mk(false)).toMatchObject({ online: false, refused: true });
    expect(mk(null).refused).toBeUndefined();
    expect(mk(true).online).toBe(true);
  });
});

describe("machineForbidden", () => {
  it("zero slots, or offline with nothing to wake it, is forbidden", () => {
    const [zero, ok] = machines();
    expect(machineForbidden(zero!)).toBe(true);
    expect(machineForbidden(ok!)).toBe(false);
    expect(machineForbidden({ id: "x", name: "x", kind: "node", online: false })).toBe(true);
    expect(machineForbidden({ id: "x", name: "x", kind: "node", online: false, wakeable: true })).toBe(false);
    expect(machineForbidden({ id: "x", name: "x", kind: "node", online: false, wakeable: true }, () => true)).toBe(true);
    expect(machineForbidden({ id: "x", name: "x", kind: "cloud", online: false })).toBe(false);
  });

  it("an ONLINE node with its wake breaker open is forbidden and never chosen", () => {
    const node: OverflowMachine = { id: "x", name: "x", kind: "node", online: true, slots: 2 };
    expect(machineForbidden(node)).toBe(false);
    expect(machineForbidden(node, () => true)).toBe(true);
    const opts = { cloudCredit: false, githubOrigin: false, model: null, load: () => 0 };
    expect(pickOverflowMachine([node], { ...opts, wakeBlocked: () => true })).toBeNull();
    expect(pickOverflowMachine([node], { ...opts, wakeBlocked: () => false })?.id).toBe("x");
  });

  it("an online cloud with a breaker open is not chosen either: the overflow or the reassignment falls to the node", () => {
    const cloud: OverflowMachine = { id: "c", name: "c", kind: "cloud", online: true };
    const node: OverflowMachine = { id: "x", name: "x", kind: "node", online: true, slots: 2 };
    const opts = { cloudCredit: true, githubOrigin: true, model: null, load: () => 0 };
    expect(pickOverflowMachine([cloud, node], opts)?.id).toBe("c");
    expect(pickOverflowMachine([cloud, node], { ...opts, wakeBlocked: (id) => id === "c" })?.id).toBe("x");
    expect(pickOverflowMachine([cloud], { ...opts, wakeBlocked: () => true })).toBeNull();
    expect(pickReassignTarget([cloud, node, ...machines()], FORBIDDEN, { ...opts, wakeBlocked: (id) => id === "c" })?.id).toBe("x");
  });

  it("the target skips the forbidden machine and one with no room", () => {
    const opts = { cloudCredit: false, githubOrigin: false, model: null };
    expect(pickReassignTarget(machines(), FORBIDDEN, { ...opts, load: () => 0 })?.id).toBe(ALLOWED);
    expect(pickReassignTarget(machines(), FORBIDDEN, { ...opts, load: () => 2 })).toBeNull();
  });
});

describe("dispatcher: card pinned to a forbidden machine", () => {
  it("moves to the online machine with free slots", async () => {
    const h = setup(machines());
    h.seed();
    await dispatch(h);
    expect(h.task().machineId).toBe(ALLOWED);
    expect(h.comments().some((c) => c.kind === "service" && c.content.includes("first") && c.content.includes("second"))).toBe(true);
    await dispatch(h);
    expect(h.task().dispatchError).not.toBe("node_unreachable");
    expect(h.calls).toContain("create");
  });

  it("goes back to this machine when no allowed machine has room", async () => {
    const h = setup(machines({ [ALLOWED]: { slots: 0 } }));
    h.seed();
    await dispatch(h);
    await flush();
    expect(h.task().machineId).toBeNull();
  });

  it("a card pinned to an ONLINE node whose breaker is open moves to the allowed machine", async () => {
    const h = setup(machines({ [FORBIDDEN]: { online: true, slots: 2 } }));
    h.seed();
    wakeBreaker.success(FORBIDDEN);
    wakeBreaker.failure(FORBIDDEN);
    wakeBreaker.failure(FORBIDDEN);
    try {
      await dispatch(h);
      expect(h.task().machineId).toBe(ALLOWED);
    } finally { wakeBreaker.success(FORBIDDEN); }
  });

  it("an offline node that can be woken keeps its card", async () => {
    const h = setup(machines({ [FORBIDDEN]: { slots: undefined, wakeable: true } }));
    h.seed();
    await dispatch(h);
    expect(h.task().machineId).toBe(FORBIDDEN);
  });
});
