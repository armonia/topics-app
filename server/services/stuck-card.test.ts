/**
 * The stuck-card rule: an hour in todo or in progress with no reason on the
 * card earns ONE service note with the reason worked out, and a card pinned to
 * a machine that does not answer goes back to the queue elsewhere.
 * @covers BOARD-UNSTICK-01
 */
import { describe, expect, test } from "bun:test";
import type { Task } from "./task-shapes";
import type { OverflowMachine } from "./dispatch-overflow";
import { diagnoseStuckCard, FULL_REQUEUE_AFTER_MS, STUCK_AFTER_MS, STUCK_NOTE_PREFIX, sweepStuckCards, type StuckContext, type StuckSweepSvc } from "./stuck-card";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function card(over: Partial<Task> = {}): Task {
  return {
    id: "t1", status: "todo", archived: false, updatedAt: ago(90), machineId: null,
    dispatchState: null, dispatchError: null, waitReason: null, queueReason: null,
    ...over,
  } as unknown as Task;
}
const PC: OverflowMachine = { id: "pc", name: "PC", kind: "node", online: true, slots: 2 };
function ctx(over: Partial<StuckContext> = {}): StuckContext {
  return { nowMs: NOW, machines: [PC], loadOf: () => 0, busy: () => false, ...over };
}

describe("diagnoseStuckCard", () => {
  test("an hour in todo with nothing on it gets a note with the minutes", () => {
    const v = diagnoseStuckCard(card(), ctx())!;
    expect(v.note.startsWith(`${STUCK_NOTE_PREFIX} 90 min`)).toBe(true);
    expect(v.requeue).toBe(false);
  });

  test("the queue position goes into the note when it is known", () => {
    const v = diagnoseStuckCard(card({ queueReason: { kind: "slot", tone: "queued", key: "k", params: { ahead: 3 } } }), ctx())!;
    expect(v.note).toContain("3 card davanti");
  });

  test("under the threshold, or with a reason already on the card, nothing is written", () => {
    expect(STUCK_AFTER_MS).toBe(60 * 60_000);
    expect(diagnoseStuckCard(card({ updatedAt: ago(30) }), ctx())).toBeNull();
    expect(diagnoseStuckCard(card({ dispatchError: "memory floor" }), ctx())).toBeNull();
    expect(diagnoseStuckCard(card({ waitReason: "waiting for CI" }), ctx())).toBeNull();
    expect(diagnoseStuckCard(card({ dispatchState: "waiting" }), ctx())).toBeNull();
    expect(diagnoseStuckCard(card({ queueReason: { kind: "spend_cap", tone: "waiting", key: "k" } }), ctx())).toBeNull();
  });

  test("a card a live turn owns is not stuck", () => {
    expect(diagnoseStuckCard(card({ status: "in_progress" }), ctx({ busy: () => true }))).toBeNull();
  });

  test("a full machine is named with its seats", () => {
    const v = diagnoseStuckCard(card({ machineId: "pc" }), ctx({ loadOf: () => 2 }))!;
    expect(v.note).toContain("«PC» è piena (2 card su 2 posti)");
    expect(v.requeue).toBe(false);
  });

  test("this Mac's memory floor does not hide a card pinned to a full node: it still goes back to the queue", () => {
    // The overflow pins cards to nodes exactly while this Mac is under its floor, and every queued card reads that block.
    const stuckSinceMinutes = Math.ceil(FULL_REQUEUE_AFTER_MS / 60_000) + 1;
    const floor = { kind: "resource_floor", tone: "waiting", key: "board.queue.memory.measuring" } as Task["queueReason"];
    const v = diagnoseStuckCard(card({ machineId: "pc", updatedAt: ago(stuckSinceMinutes), queueReason: floor }), ctx({ loadOf: () => 2 }))!;
    expect(v.requeue).toBe(true);
    expect(v.skipMachineId).toBe("pc");
    // A card that waits for THIS Mac (no node) keeps the floor as its reason.
    expect(diagnoseStuckCard(card({ queueReason: floor }), ctx())).toBeNull();
  });

  test("a full machine held THIS long gives up its seat: back to the queue, away from it", () => {
    const stuckSinceMinutes = Math.ceil(FULL_REQUEUE_AFTER_MS / 60_000) + 1;
    const v = diagnoseStuckCard(
      card({ machineId: "pc", updatedAt: ago(stuckSinceMinutes) }),
      ctx({ loadOf: () => 2 }),
    )!;
    expect(v.requeue).toBe(true);
    expect(v.skipMachineId).toBe("pc");
  });

  test("a silent machine sends the card back to the queue, away from it", () => {
    const v = diagnoseStuckCard(card({ machineId: "pc" }), ctx({ machines: [{ ...PC, online: false }] }))!;
    expect(v.requeue).toBe(true);
    expect(v.skipMachineId).toBe("pc");
  });

  test("in progress with a dispatch chip is explained by the chip: nothing is written, nothing moves", () => {
    const stale = card({ status: "in_progress", inProgressAt: ago(300), dispatchState: "working", machineId: "gone" });
    expect(diagnoseStuckCard(stale, ctx())).toBeNull();
  });

  test("in progress without a live turn says so", () => {
    const v = diagnoseStuckCard(card({ status: "in_progress", inProgressAt: ago(120) }), ctx())!;
    expect(v.note).toContain("senza un turno vivo");
  });
});

describe("sweepStuckCards", () => {
  function fakeSvc(cards: Task[]) {
    const comments = new Map<string, Array<{ kind: string; content: string }>>();
    const svc: StuckSweepSvc = {
      list: ({ status }) => cards.filter((c) => c.status === status),
      get: (id) => { const task = cards.find((c) => c.id === id); return task ? { task, comments: comments.get(id) ?? [] } : null; },
      addComment: ({ taskId, content }) => { comments.set(taskId, [...(comments.get(taskId) ?? []), { kind: "service", content }]); },
    };
    return { svc, comments };
  }

  test("one note per card, however many passes run", () => {
    const { svc, comments } = fakeSvc([card()]);
    const run = () => sweepStuckCards({ ...ctx(), svc, requeue: () => true });
    expect(run()).toHaveLength(1);
    expect(run()).toHaveLength(0);
    expect(comments.get("t1")).toHaveLength(1);
  });

  test("a card on a silent machine is requeued once, with the note", () => {
    const { svc } = fakeSvc([card({ machineId: "pc" })]);
    const seen: Array<[string, string | null, string]> = [];
    const out = sweepStuckCards({
      ...ctx({ machines: [{ ...PC, online: false }] }), svc,
      requeue: (id, skip, note) => { seen.push([id, skip, note]); return true; },
    });
    expect(out).toEqual([{ id: "t1", requeued: true }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]![1]).toBe("pc");
  });

  test("a card already told 'machine full' still escalates to a requeue once the cap passes", () => {
    const stuckSinceMinutes = Math.ceil(FULL_REQUEUE_AFTER_MS / 60_000) + 1;
    const { svc } = fakeSvc([card({ machineId: "pc", updatedAt: ago(stuckSinceMinutes) })]);
    svc.addComment({ taskId: "t1", author: "system", kind: "service", content: `${STUCK_NOTE_PREFIX} 70 min: la macchina è piena.` });
    const seen: Array<[string, string | null]> = [];
    const out = sweepStuckCards({
      ...ctx({ loadOf: () => 2 }), svc,
      requeue: (id, skip) => { seen.push([id, skip]); return true; },
    });
    expect(out).toEqual([{ id: "t1", requeued: true }]);
    expect(seen).toEqual([["t1", "pc"]]);
  });

  test("a requeue that fails writes nothing and is tried again next pass", () => {
    const { svc, comments } = fakeSvc([card({ machineId: "pc" })]);
    const out = sweepStuckCards({ ...ctx({ machines: [{ ...PC, online: false }] }), svc, requeue: () => false });
    expect(out).toEqual([]);
    expect(comments.size).toBe(0);
  });
});
