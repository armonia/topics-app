/**
 * Memory seat and reservation lifecycle regressions.
 * @covers KANBAN-75
 */
import { afterAll, afterEach, beforeAll, describe, it, expect, setSystemTime } from "bun:test";
import { budgetShare, E2E_CI_CHECK, UNIT_CI_CHECK } from "../../shared/board";
import { setActiveBudgetGovernor, type BudgetGovernor } from "./budget-governor";
import { createMemSignal } from "./mem-signal";
import { createDispatchResourceBlock } from "./dispatch-resource-block";
import type { TurnEndInfo } from "../providers/stop-reason";
import { boardHasNoLocalChecks, canStartNoCheckExemption, NoCheckExemptionLedger } from "./dispatch-no-check-exemption";
import { encodeMemoryQueueRef } from "./dispatch-memory-reference";
import { cleanupTestDataDir, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import {
  addLocalReviewCheck, flush, harness, PID, QUIET, SECOND_PID, seedCutTurn, seedTodo,
  sharedWindowHarness, repeatMemoryReading, shutdownDispatchers,
} from "./dispatch-admission-parity-helpers";

const STATE_ROOT = testTmpDir("task-dispatcher-no-local-checks");
beforeAll(() => setupTestDataDir(`${STATE_ROOT}/data`));
afterAll(() => cleanupTestDataDir(STATE_ROOT));
afterEach(() => {
  setSystemTime();
  shutdownDispatchers();
});

describe("no-local-check exception lifecycle", () => {
  it("uses only the emergency floor for an empty or CI-only board", () => {
    expect(boardHasNoLocalChecks([])).toBe(true);
    expect(boardHasNoLocalChecks([UNIT_CI_CHECK, E2E_CI_CHECK])).toBe(true);
    expect(boardHasNoLocalChecks([{ name: "local", cmd: "bun test" }])).toBe(false);
  });

  it("shares one idle memory seat across a no-check queue", async () => {
    const w = sharedWindowHarness("count", { checksRunning: () => 0 });
    await w.beats(repeatMemoryReading(4.8, 14));
    seedTodo(w.h.db, "idle-seat-first");
    seedTodo(w.h.db, "idle-seat-second");
    seedTodo(w.h.db, "idle-seat-third");

    await w.h.dispatcher.tick(PID);
    await flush();

    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.dispatcher.isInFlight("idle-seat-first")).toBe(true);
    expect(w.h.svc.get("idle-seat-second")?.task.dispatchError).toBe("waiting-memory");
    expect(w.h.svc.get("idle-seat-third")?.task.dispatchError).toBe("waiting-memory");
    expect(w.h.dispatcher.memoryQueueSnapshot().queue.map(({ position, total }) => ({ position, total })))
      .toEqual([{ position: 2, total: 3 }, { position: 3, total: 3 }]);
  });

  it("holds the emergency threshold at 2 GB when 2.9 GB minus the native reservation leaves 1.9 GB", () => {
    expect(canStartNoCheckExemption({
      boardHasNoLocalChecks: true,
      heldGB: 2.9,
      reservationGB: 1,
    })).toBe(false);
  });

  it("keeps a no-check card below the 2 GB remainder even when another card is running", async () => {
    let reading = 20;
    const signal = createMemSignal({
      measurable: true,
      probe: async () => ({ availGB: reading, swapins: 0, compressorPages: 0, pageSize: 16_384, swapUsedMB: 0, swapTotalMB: 16_384, load1: 1 }),
    });
    const w = harness({
      heldMemory: () => signal.held(),
      isCliRuntime: () => false,
      resourceBlock: createDispatchResourceBlock({
        worktreesPath: () => "/tmp",
        readFreeGB: () => 500,
        heldMemory: () => signal.held(),
        isCliRuntime: () => false,
      }),
    });
    w.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.svc, SECOND_PID);
    let now = Date.now();
    const beat = async (gb: number) => {
      reading = gb;
      setSystemTime(new Date(now));
      await signal.sample();
      await w.dispatcher.tick(PID);
      await flush();
      now += 10_000;
    };
    for (let i = 0; i < 14; i++) await beat(20);
    seedTodo(w.db, "floor-checked", SECOND_PID);
    await w.dispatcher.tick(SECOND_PID);
    await flush();
    expect(w.startedAt.length).toBe(1);
    for (let i = 0; i < 14; i++) await beat(2.9);
    seedTodo(w.db, "floor-no-checks");
    await beat(2.9);
    expect(w.startedAt.length).toBe(1);
    expect(w.commentsFor("floor-no-checks").filter((content) => content.includes("Partenza in esenzione"))).toHaveLength(0);
    expect(w.svc.get("floor-no-checks")?.task.dispatchError).toBe("waiting-memory");
  });

  it("reattaches a live exempt attempt without duplicating its start line, then frees the slot", async () => {
    let finish: (() => void) | null = null;
    const h = harness({
      heldMemory: () => ({ measurable: true, latestGB: 20, heldGB: 20, coveredMs: 120_000 }),
      isCliRuntime: () => false,
      resourceBlock: () => ({ reason: null, kind: null, memoryFirstCardExempt: false }),
      budgetSample: () => ({ ...QUIET, availableMemGB: 20, running: 1 }),
      hasLiveSession: async () => true,
      reattach: () => new Promise<void>((resolve) => { finish = resolve; }),
    });
    h.svc.setGlobalCap({ mode: "resources", budgetShare: budgetShare({}) });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    seedCutTurn(h.db, "reattach-exempt");
    const attempt = h.attempts.create({ taskId: "reattach-exempt", idx: 1, model: null });
    h.attempts.bind(attempt.id, { topicId: "topic-reattach-exempt", worktreeId: null, branch: null });
    h.attempts.setNoLocalChecksReservation?.("reattach-exempt", 1);
    const note = `Partenza in esenzione senza check locali, tentativo ${attempt.id}: prenotati 1.00 GB (stima nativa).`;
    const start = Date.now();
    setSystemTime(new Date(start - 11_000));
    h.svc.addComment({ taskId: "reattach-exempt", author: "system", kind: "service", content: note });
    setSystemTime(new Date(start));

    await h.dispatcher.reconcile({ reason: "boot" });
    await flush();
    expect(h.dispatcher.isInFlight("reattach-exempt")).toBe(true);
    expect(h.attempts.getNoLocalChecksReservation?.("reattach-exempt")).toBe(1);
    expect(h.commentsFor("reattach-exempt").filter((content) => content === note)).toHaveLength(1);
    expect(h.dispatcher.admissionPreview?.()?.ourMemGB).toBeCloseTo(3);

    finish!();
    await flush(30);
    expect(h.attempts.getNoLocalChecksReservation?.("reattach-exempt")).toBeNull();
    expect(h.dispatcher.admissionPreview?.()?.ourMemGB).toBeCloseTo(2);
  });

  it("clears a persisted reservation when reattach finds local checks", async () => {
    const h = harness({
      hasLiveSession: async () => true,
      reattach: () => new Promise<void>(() => {}),
    });
    h.svc.setGlobalCap({ mode: "resources", budgetShare: budgetShare({}) });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(h.svc);
    seedCutTurn(h.db, "reattach-checked");
    const attempt = h.attempts.create({ taskId: "reattach-checked", idx: 1, model: null });
    h.attempts.bind(attempt.id, { topicId: "topic-reattach-checked", worktreeId: null, branch: null });
    h.attempts.setNoLocalChecksReservation?.("reattach-checked", 1);
    await h.dispatcher.reconcile({ reason: "boot" });
    await flush();
    expect(h.dispatcher.isInFlight("reattach-checked")).toBe(true);
    expect(h.attempts.getNoLocalChecksReservation?.("reattach-checked")).toBeNull();
    expect(h.commentsFor("reattach-checked").filter((content) => content.includes("Partenza in esenzione"))).toHaveLength(0);
  });

  it("keeps only the first persisted reservation when two live cards reattach", async () => {
    const h = harness({
      hasLiveSession: async () => true,
      reattach: () => new Promise<void>(() => {}),
    });
    h.svc.setGlobalCap({ mode: "resources", budgetShare: budgetShare({}) });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    for (const [id, topicId] of [["reattach-first", "topic-reattach-first"], ["reattach-second", "topic-reattach-second"]]) {
      seedCutTurn(h.db, id);
      const attempt = h.attempts.create({ taskId: id, idx: 1, model: null });
      h.attempts.bind(attempt.id, { topicId, worktreeId: null, branch: null });
      h.attempts.setNoLocalChecksReservation?.(id, 1);
    }
    await h.dispatcher.reconcile({ reason: "boot" });
    await flush();
    const restored = [
      h.attempts.getNoLocalChecksReservation?.("reattach-first"),
      h.attempts.getNoLocalChecksReservation?.("reattach-second"),
    ];
    expect(restored.filter((reservation) => reservation === 1)).toHaveLength(1);
    expect(restored.filter((reservation) => reservation === null)).toHaveLength(1);
  });

  it("uses the server resource composer for memory, runtime, and one reservation", () => {
    let cliRuntime = false;
    const memory = { measurable: true, latestGB: 6.5, heldGB: 6.5, coveredMs: 120_000 };
    const block = createDispatchResourceBlock({
      worktreesPath: () => "/tmp",
      readFreeGB: () => 500,
      heldMemory: () => memory,
      isCliRuntime: () => cliRuntime,
    });
    const hold = { cardGB: 0, reservedGB: 0, reservedCards: 0, spendingHere: false, ourWorkRunning: true };

    expect(block(hold).reason).toBeNull();
    cliRuntime = true;
    expect(block(hold).reason).toContain("6.5 GB");
    cliRuntime = false;
    expect(block({ ...hold, cardGB: 4, reservedGB: 1, reservedCards: 1, spendingHere: true }).reason).toContain("6.5 GB");
  });

  it("admits the reserved no-check cost at the quota minimum", async () => {
    const w = sharedWindowHarness("resources", { checksRunning: () => 1 }, 0, 0.8);
    await w.beats(repeatMemoryReading(20, 14));
    await w.beats(repeatMemoryReading(4.8, 14));
    w.h.machine.sample = () => ({ ...QUIET, availableMemGB: 1.25, ourMemGB: 2, running: 1 });
    seedTodo(w.h.db, "quota-at-reservation");

    await w.h.dispatcher.tick(PID);
    await flush();

    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.attempts.getNoLocalChecksReservation?.("quota-at-reservation")).toBe(1);
    expect(w.h.commentsFor("quota-at-reservation").some((line) => line.includes("Partenza in esenzione"))).toBe(true);
  });

  for (const [label, availableMemGB, reading] of [["quota minimum", 1.25, 4.8], ["memory floor", 4.8, 4.8]] as const) {
    it(`card 10469e3e: frozen checks hold the no-check exemption at the ${label}`, async () => {
      const frozen = 1;
      setActiveBudgetGovernor({ frozenCount: () => frozen } as unknown as BudgetGovernor);
      try {
        const w = sharedWindowHarness("resources", { checksRunning: () => 1 }, 0, 0.8);
        await w.beats(repeatMemoryReading(20, 14));
        await w.beats(repeatMemoryReading(reading, 14));
        w.h.machine.sample = () => ({ ...QUIET, availableMemGB, ourMemGB: 2, running: 1 });
        seedTodo(w.h.db, "frozen-exempt");
        await w.h.dispatcher.tick(PID);
        await flush();
        expect(w.h.startedAt).toHaveLength(0);
        expect(w.h.commentsFor("frozen-exempt").some((line) => line.includes("Partenza in esenzione"))).toBe(false);
      } finally { setActiveBudgetGovernor(null); }
    });
  }

  it("holds the no-check start when free quota is below its reservation", async () => {
    const w = sharedWindowHarness("resources", { checksRunning: () => 1 }, 0, 0.8);
    await w.beats(repeatMemoryReading(20, 14));
    await w.beats(repeatMemoryReading(4.8, 14));
    w.h.machine.sample = () => ({ ...QUIET, availableMemGB: 1.24, ourMemGB: 2, running: 1 });
    seedTodo(w.h.db, "quota-below-reservation");

    await w.h.dispatcher.tick(PID);
    await flush();

    expect(w.h.startedAt).toHaveLength(0);
    expect(w.h.attempts.getNoLocalChecksReservation?.("quota-below-reservation")).toBeNull();
    expect(w.h.svc.get("quota-below-reservation")?.task.dispatchError).toBe("waiting-memory");
  });

  it("charges an occupied exempt seat once in resources mode", async () => {
    let checks = 1;
    const w = sharedWindowHarness("resources", { checksRunning: () => checks }, 0, 0.8);
    await w.beats(repeatMemoryReading(20, 14));
    await w.beats(repeatMemoryReading(4.8, 14));
    seedTodo(w.h.db, "s3-exempt");
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.attempts.getNoLocalChecksReservation?.("s3-exempt")).toBe(1);

    checks = 0;
    await w.beats(repeatMemoryReading(6.5, 14));
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, SECOND_PID);
    seedTodo(w.h.db, "s3-checked", SECOND_PID);
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();

    expect(w.h.dispatcher.isInFlight("s3-checked")).toBe(false);
    expect(w.h.svc.get("s3-checked")?.task.dispatchError).toBe("waiting-memory");
    expect(w.h.startedAt).toHaveLength(1);
  });

  it("keeps the real memory reading in a resources-mode queue reason", async () => {
    const checks = 1;
    let samples: number[] = [];
    const w = sharedWindowHarness("resources", {
      checksRunning: () => checks,
      agentMemSamples: () => samples,
    }, 0, 0.8);
    await w.beats(repeatMemoryReading(20, 14));
    await w.beats(repeatMemoryReading(4.8, 14));
    seedTodo(w.h.db, "resources-reason-exempt");
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.attempts.getNoLocalChecksReservation?.("resources-reason-exempt")).toBe(1);

    samples = [5.5];
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, SECOND_PID);
    await w.beats(repeatMemoryReading(6.5, 14));
    seedTodo(w.h.db, "resources-reading", SECOND_PID);
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();

    const snapshot = w.h.dispatcher.memoryQueueSnapshot();
    expect(snapshot.reading.freeGB).toBe(6.5);
    expect(w.h.svc.get("resources-reading")?.task.dispatchError).toBe("waiting-memory");
    expect(w.h.dispatcher.isInFlight("resources-reading")).toBe(false);
  });

  it("keeps the only low-memory seat until a heavy local turn ends", async () => {
    let finish: ((end?: TurnEndInfo) => void) | null = null;
    const w = sharedWindowHarness("count", {
      checksRunning: () => 0,
      runTurn: () => new Promise<TurnEndInfo | void>((resolve) => { finish = resolve; }),
    });
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    await w.beats(repeatMemoryReading(20, 14));
    seedTodo(w.h.db, "seat-heavy", SECOND_PID);
    w.h.db.run("UPDATE tasks SET dispatch_weight = 'heavy' WHERE id = 'seat-heavy'");
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();
    expect(w.h.startedAt).toHaveLength(1);

    await w.beats(repeatMemoryReading(5, 14));
    expect(boardHasNoLocalChecks(w.h.svc.getBoardSettings(PID).reviewChecks)).toBe(true);
    seedTodo(w.h.db, "seat-one");
    seedTodo(w.h.db, "seat-two");
    await w.h.dispatcher.tick(PID);
    await flush();

    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.attempts.getNoLocalChecksReservation?.("seat-one")).toBeNull();
    expect(w.h.attempts.getNoLocalChecksReservation?.("seat-two")).toBeNull();
    expect(w.h.status("seat-two")).toBe("todo");
    expect(w.h.dispatcher.isInFlight("seat-one")).toBe(false);
    expect(w.h.dispatcher.isInFlight("seat-two")).toBe(false);

    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: false, dispatchUseWorktree: false });
    w.h.db.run("UPDATE tasks SET status = 'done', dispatch_state = NULL WHERE id = 'seat-heavy'");
    finish!({ end: "end_turn" });
    await flush(30);
    expect(w.h.dispatcher.isInFlight("seat-heavy")).toBe(false);

    w.h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.startedAt).toHaveLength(2);
    expect(w.h.dispatcher.isInFlight("seat-one")).toBe(true);
    expect(w.h.dispatcher.isInFlight("seat-two")).toBe(false);
  });

  it("releases the exempt seat after a topic setup failure", async () => {
    let topicStarts = 0;
    const w = sharedWindowHarness("count", {
      checksRunning: () => 1,
      createTopic: () => {
        topicStarts++;
        if (topicStarts === 1) throw new Error("topic setup failed");
        return { topicId: "setup-retry-topic", sessionKey: "topic:setup-retry-topic" };
      },
      runTurn: () => new Promise<TurnEndInfo | void>(() => {}),
    });
    w.h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 1, dispatchUseWorktree: false });
    w.h.db.run("INSERT INTO topics (id) VALUES (?)", ["setup-retry-topic"]);
    await w.beats(repeatMemoryReading(20, 14));
    await w.beats(repeatMemoryReading(4.8, 14));
    seedTodo(w.h.db, "setup-fails");
    seedTodo(w.h.db, "setup-next");

    await w.h.dispatcher.tick(PID);
    await flush(30);
    expect(topicStarts).toBe(2);
    expect(w.h.status("setup-fails")).toBe("backlog");
    expect(w.h.dispatcher.isInFlight("setup-fails")).toBe(false);
    expect(w.h.attempts.getNoLocalChecksReservation?.("setup-fails")).toBeNull();
    expect(w.h.dispatcher.isInFlight("setup-next")).toBe(true);
    expect(w.h.attempts.getNoLocalChecksReservation?.("setup-next")).toBe(1);
  });

  it("keeps a checked-board card held while an untracked reservation exists", async () => {
    const orphan = new NoCheckExemptionLedger();
    orphan.reserve("restored-but-not-attached", 1);
    const prototype = NoCheckExemptionLedger.prototype;
    const original = prototype.untrackedCount;
    prototype.untrackedCount = function (tracked) {
      const existing = original.call(this, tracked);
      const orphaned = orphan.taskIds().filter((taskId) => !tracked.has(taskId)).length;
      return existing + orphaned;
    };
    try {
      const w = sharedWindowHarness("count", { checksRunning: () => 0 });
      addLocalReviewCheck(w.h.svc);
      await w.beats(repeatMemoryReading(4.7, 14));
      seedTodo(w.h.db, "checked-behind-orphan");
      await w.h.dispatcher.tick(PID);
      await flush();

      expect(w.h.startedAt).toHaveLength(0);
      expect(w.h.svc.get("checked-behind-orphan")?.task.dispatchError).toBe("waiting-memory");
    } finally {
      prototype.untrackedCount = original;
    }
  });

  it("includes an untracked reservation when deciding the quota-minimum exception", async () => {
    const orphan = new NoCheckExemptionLedger();
    orphan.reserve("restored-but-not-attached", 1);
    const prototype = NoCheckExemptionLedger.prototype;
    const original = prototype.untrackedCount;
    prototype.untrackedCount = function (tracked) {
      const existing = original.call(this, tracked);
      const orphaned = orphan.taskIds().filter((taskId) => !tracked.has(taskId)).length;
      return existing + orphaned;
    };
    try {
      const w = sharedWindowHarness("resources", { checksRunning: () => 0 }, 0, 0.8);
      await w.beats(repeatMemoryReading(20, 14));
      w.h.machine.sample = () => ({ ...QUIET, availableMemGB: 1, ourMemGB: 2, running: 0 });
      seedTodo(w.h.db, "quota-after-orphan");
      await w.h.dispatcher.tick(PID);
      await flush();

      expect(w.h.startedAt).toHaveLength(0);
      expect(w.h.attempts.getNoLocalChecksReservation?.("quota-after-orphan")).toBeNull();
    } finally {
      prototype.untrackedCount = original;
    }
  });

  it("charges an occupied exempt seat once in count mode and reports the effective reading", async () => {
    let checks = 1;
    const w = sharedWindowHarness("count", { checksRunning: () => checks });
    await w.beats(repeatMemoryReading(20, 14));
    await w.beats(repeatMemoryReading(4.8, 14));
    seedTodo(w.h.db, "count-exempt");
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.attempts.getNoLocalChecksReservation?.("count-exempt")).toBe(1);

    checks = 0;
    await w.beats(repeatMemoryReading(6.5, 14));
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, SECOND_PID);
    seedTodo(w.h.db, "count-checked", SECOND_PID);
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();

    const snapshot = w.h.dispatcher.memoryQueueSnapshot();
    expect(snapshot.reading.freeGB).toBeCloseTo(6.5);
    expect(snapshot.threshold.startGB).toBeGreaterThan(6);
    expect(snapshot.queue).toContainEqual({
      taskId: encodeMemoryQueueRef("count-checked"),
      boardId: encodeMemoryQueueRef(SECOND_PID),
      reason: "waiting-memory",
      position: 2,
      total: 2,
      costGB: 4,
    });
    expect(w.h.svc.get("count-checked")?.task.dispatchError).toBe("waiting-memory");
    expect(w.h.startedAt).toHaveLength(1);
  });

  it("shares the 4.8 GB idle-floor seat with the quota exemption", async () => {
    const w = sharedWindowHarness("resources", { checksRunning: () => 0 }, 0, 0.8);
    await w.beats(repeatMemoryReading(20, 14));
    await w.beats(repeatMemoryReading(4.8, 14));
    w.h.machine.sample = () => ({ ...QUIET, availableMemGB: 1.25, ourMemGB: 2, running: 1 });
    seedTodo(w.h.db, "shared-seat-first");
    seedTodo(w.h.db, "shared-seat-second");
    seedTodo(w.h.db, "shared-seat-third");

    await w.h.dispatcher.tick(PID);
    await flush();

    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.dispatcher.isInFlight("shared-seat-first")).toBe(true);
    expect(w.h.attempts.getNoLocalChecksReservation?.("shared-seat-first")).toBe(1);
    expect(w.h.svc.get("shared-seat-second")?.task.dispatchError).toBe("waiting-memory");
    expect(w.h.svc.get("shared-seat-third")?.task.dispatchError).toBe("waiting-memory");
    expect(w.h.dispatcher.memoryQueueSnapshot().queue.map(({ position, total }) => ({ position, total })))
      .toEqual([{ position: 2, total: 3 }, { position: 3, total: 3 }]);
  });

  for (const outcome of ["finished", "closed manually", "errored", "died"] as const) {
    it(`releases the one exempt seat after the first card ${outcome}`, async () => {
      let checks = 1;
      let finish: ((end?: TurnEndInfo) => void) | null = null;
      const w = sharedWindowHarness("count", {
        checksRunning: () => checks,
        livenessGraceMs: 0,
        isTurnAlive: outcome === "died" ? () => false : undefined,
        runTurn: () => new Promise<TurnEndInfo | void>((resolve) => { finish = resolve; }),
      });
      w.h.svc.updateBoardSettings(PID, { autoDispatch: false, dispatchRetryCap: 1 });
      await w.beats(repeatMemoryReading(20, 14));
      await w.beats(repeatMemoryReading(4.8, 14));
      w.h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 1 });
      seedTodo(w.h.db, "seat-first");
      seedTodo(w.h.db, "seat-second");
      await w.h.dispatcher.tick(PID);
      await flush();

      expect(w.h.startedAt).toHaveLength(1);
      expect(w.h.attempts.getNoLocalChecksReservation?.("seat-first")).toBe(1);
      expect(w.h.status("seat-second")).toBe("todo");
      expect(w.h.svc.get("seat-second")?.task.dispatchError).toBe("waiting-memory");

      if (outcome === "finished") {
        w.h.db.run("UPDATE tasks SET status = 'review' WHERE id = 'seat-first'");
        w.h.svc.updateBoardSettings(PID, { autoDispatch: false });
        finish!({ end: "end_turn" });
      } else if (outcome === "closed manually") {
        w.h.db.run("UPDATE tasks SET status = 'done' WHERE id = 'seat-first'");
        w.h.svc.updateBoardSettings(PID, { autoDispatch: false });
        w.h.dispatcher.onBlockerDone("seat-first");
        expect(w.h.attempts.getNoLocalChecksReservation?.("seat-first")).toBe(1);
        finish!({ end: "end_turn" });
      } else if (outcome === "errored") {
        w.h.svc.updateBoardSettings(PID, { autoDispatch: false });
        finish!({ end: "error", cause: "process-died" });
      } else {
        w.h.svc.updateBoardSettings(PID, { autoDispatch: false });
        setSystemTime(new Date(Date.now() + 1_000));
        await w.h.dispatcher.reconcile({ reason: "poll" });
        setSystemTime(new Date(Date.now() + 1_000));
        await w.h.dispatcher.reconcile({ reason: "poll" });
      }
      checks = 0;
      await flush(30);
      expect(w.h.dispatcher.isInFlight("seat-first")).toBe(false);
      expect(w.h.attempts.getNoLocalChecksReservation?.("seat-first")).toBeNull();

      w.h.svc.updateBoardSettings(PID, { autoDispatch: true });
      await w.h.dispatcher.tick(PID);
      await flush();
      expect(w.h.startedAt).toHaveLength(2);
      expect(w.h.dispatcher.isInFlight("seat-second")).toBe(true);
    });
  }

  it("reopening the released card as heavy starts without inheriting its exempt note", async () => {
    const memory = { measurable: true, latestGB: 20, heldGB: 20, coveredMs: 120_000 };
    const w = harness({
      heldMemory: () => memory,
      isCliRuntime: () => false,
      resourceBlock: createDispatchResourceBlock({
        worktreesPath: () => "/tmp",
        readFreeGB: () => 500,
        heldMemory: () => memory,
        isCliRuntime: () => false,
      }),
    });
    w.svc.updateBoardSettings(PID, { autoDispatch: false, dispatchUseWorktree: false });
    seedCutTurn(w.db, "reopened-heavy");
    const attempt = w.attempts.create({ taskId: "reopened-heavy", idx: 1, model: null });
    w.attempts.bind(attempt.id, { topicId: "topic-reopened-heavy", worktreeId: null, branch: null });
    w.attempts.setNoLocalChecksReservation?.("reopened-heavy", 1);
    await w.dispatcher.reconcile({ reason: "boot" });
    await flush();
    expect(w.attempts.getNoLocalChecksReservation?.("reopened-heavy")).toBe(1);
    w.db.run("UPDATE tasks SET status = 'done', dispatch_state = NULL WHERE id = 'reopened-heavy'");
    w.dispatcher.onBlockerDone("reopened-heavy");
    expect(w.attempts.getNoLocalChecksReservation?.("reopened-heavy")).toBeNull();
    w.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    w.db.run("UPDATE tasks SET status = 'todo', assigned_topic_id = NULL WHERE id = 'reopened-heavy'");
    w.db.run("UPDATE tasks SET dispatch_weight = 'heavy' WHERE id = 'reopened-heavy'");

    await w.dispatcher.tick(PID);
    await flush();

    expect(w.dispatcher.isInFlight("reopened-heavy")).toBe(true);
    expect(w.attempts.getNoLocalChecksReservation?.("reopened-heavy")).toBeNull();
    expect(w.commentsFor("reopened-heavy").filter((line) => line.includes("Partenza in esenzione"))).toHaveLength(0);
  });

  it("keeps the persisted seat out of memory until dispatch allows a live reattach", async () => {
    const h = harness({ hasLiveSession: async () => true, reattach: () => new Promise<void>(() => {}) });
    h.svc.updateBoardSettings(PID, { autoDispatch: false, dispatchUseWorktree: false });
    h.svc.setGlobalCap({ mode: "resources", budgetShare: budgetShare({}) });
    seedCutTurn(h.db, "held-off-exempt");
    const attempt = h.attempts.create({ taskId: "held-off-exempt", idx: 1, model: null });
    h.attempts.bind(attempt.id, { topicId: "topic-held-off-exempt", worktreeId: null, branch: null });
    h.attempts.setNoLocalChecksReservation?.("held-off-exempt", 1);
    await h.dispatcher.reconcile({ reason: "boot" });
    await flush();
    expect(h.attempts.getNoLocalChecksReservation?.("held-off-exempt")).toBe(1);
    expect(h.dispatcher.isInFlight("held-off-exempt")).toBe(false);
    expect(h.dispatcher.admissionPreview?.()?.ourMemGB).toBeCloseTo(2);
    expect(h.svc.get("held-off-exempt")?.comments.some((comment) => comment.content.includes("Dispatch spento"))).toBe(true);

    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    await h.dispatcher.reconcile({ reason: "poll" });
    await flush();
    expect(h.dispatcher.isInFlight("held-off-exempt")).toBe(true);
    expect(h.attempts.getNoLocalChecksReservation?.("held-off-exempt")).toBe(1);
    expect(h.dispatcher.admissionPreview?.()?.ourMemGB).toBeCloseTo(3);
  });
});
