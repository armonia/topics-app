/**
 * Admission parity scenarios for the memory floor and first-card exception.
 * @covers KANBAN-75
 */
import { afterAll, afterEach, beforeAll, describe, it, expect, setSystemTime } from "bun:test";
import { budgetShare, capMode, admissionVerdict } from "../../shared/board";
import { currentDispatchBlock } from "./dispatch-block-signal";
import { createMemSignal } from "./mem-signal";
import { createDispatchResourceBlock } from "./dispatch-resource-block";
import type { DispatcherDeps } from "./task-dispatcher";
import { cleanupTestDataDir, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import {
  addLocalReviewCheck, flush, harness, PID, QUIET, SECOND_PID, seedTodo, shutdownDispatchers, THIRD_PID,
} from "./dispatch-admission-parity-helpers";

const STATE_ROOT = testTmpDir("task-dispatcher-admission-parity");
beforeAll(() => setupTestDataDir(`${STATE_ROOT}/data`));
afterAll(() => cleanupTestDataDir(STATE_ROOT));
afterEach(() => {
  setSystemTime();
  shutdownDispatchers();
});

/**
 * THE FLOOR READS THE LOWEST READING OF 2 MINUTES, and the life-of-turn
 * reservation is charged once. The real floor composer fed by a real memory
 * signal over a fake probe; the harness's budget sample reads the same window.
 */
describe("the memory window on the floor and on the budget axis", () => {
  function windowHarness(mode: "resources" | "count", overrides: Partial<DispatcherDeps> = {}, swapUsedMB = 0, share = budgetShare({})) {
    let reading = 20;
    const signal = createMemSignal({
      measurable: true,
      probe: async () => ({ availGB: reading, swapins: 0, compressorPages: 0, pageSize: 16_384, swapUsedMB, swapTotalMB: 16_384, load1: 1 }),
    });
    const h = harness({
      agentMemSamples: () => [],
      agentCostSamples: () => [0.1],
      heldMemory: () => signal.held(),
      isCliRuntime: () => false,
      resourceBlock: createDispatchResourceBlock({
        worktreesPath: () => "/tmp",
        readFreeGB: () => 500,
        heldMemory: () => signal.held(),
        isCliRuntime: () => overrides.isCliRuntime?.() ?? false,
      }),
      ...overrides,
    });
    if (mode === "resources") h.svc.setGlobalCap({ mode: "resources", budgetShare: share });
    else h.svc.setGlobalCap({ auto: false, max: 4 });
    h.machine.sample = () => ({ ...QUIET, availableMemGB: signal.held().heldGB, running: h.startedAt.length });
    const t0 = Date.now();
    let t = t0;
    /** One 10 s beat: the sampler, then the dispatcher's tick. `startedAtSec` of each start, relative to t0. */
    const beat = async (gb: number) => {
      setSystemTime(new Date(t));
      reading = gb;
      await signal.sample();
      await h.dispatcher.tick(PID);
      await flush();
      t += 10_000;
    };
    const beats = async (values: number[]) => { for (const gb of values) await beat(gb); };
    // t0 goes back with the harness: a test that reads its own Date.now() after
    // this one can land a millisecond later, and every start then measures 1 ms
    // early (139.999 instead of 140 on CI, 26/10).
    return { h, beat, beats, t0 };
  }
  const repeat = (gb: number, n: number) => Array<number>(n).fill(gb);
  const mainMemoryReason = (heldGB: number, lineGB: number, reservedGB = 0) => {
    const gb = (n: number) => n.toFixed(1);
    const kept = reservedGB > 0
      ? ` (il pavimento, il prezzo di una card e ${gb(reservedGB)} GB tenuti per l'agente al lavoro)`
      : "";
    return `Memoria in risalita: la lettura più bassa degli ultimi 2 minuti è ${gb(heldGB)} GB, sopra il pavimento di 6 GB ma sotto i ${gb(lineGB)} GB che servono per una card in più${kept}. ` +
      `Con il runtime nativo la sessione pesa 2,3 MB, ma una card nei suoi check si prezza 4.0 GB, e sotto questa riga la macchina va in swap. ` +
      `Parto quando la memoria resta sopra ${gb(lineGB)} GB per 2 minuti di fila: una lettura sola sopra la riga non basta. Niente è andato perso.`;
  };

  // Baseline outcomes were measured on origin/main@1e6ac8b708 in a detached scratch worktree.
  const MAIN = {
    B1: { starts: 1, exemptionLog: 1 },
    B1AtFive: { starts: 1, firstCardLog: 1, noCheckRows: 0 },
    B1Warmup: { starts: 1 },
    B2: { whileChecks: 0, afterChecks: 1, exemptionLog: 1, falseRecoveryLines: 0 },
    B3: { firstStarts: 1, totalStarts: 1, reasonLineGB: 10 },
    B4: { firstStarts: 1, totalStarts: 2, reason: "" },
    // B5 is the one baseline this change moves on purpose (per-board card price,
    // `dispatch-card-price.ts`): on main the no-check turn in flight reserved the
    // checked card's 4 GB and the line was 6 + 4 + 4 = 14; it now reserves its own
    // board's price, 1 GB, so the line is 6 + 4 + 1 = 11.
    B5: { firstStarts: 1, startsAtLine: 2, startsUnderLine: 1, reasonLineGB: 11, reservedGB: 1 },
    B6: { checkedStarts: 1, totalStarts: 1, exemptionLogs: 0 },
    B7: { starts: 2, exemptionLogs: 0, startSeconds: [140, 150] },
  } as const;

  it("B1 idle Mac, board WITH local checks, held2m 1.9 GB", async () => {
    const w = windowHarness("count", {}, 16_384);
    addLocalReviewCheck(w.h.svc);
    await w.beats(repeat(1.9, 14));
    seedTodo(w.h.db, "b1");
    await w.beat(1.9);
    expect(w.h.startedAt.length).toBe(MAIN.B1.starts);
    expect(w.h.lines("per deroga")).toHaveLength(MAIN.B1.exemptionLog);
  });

  it("B1w idle Mac, board WITH local checks, warm-up", async () => {
    const w = windowHarness("count", {}, 16_384);
    addLocalReviewCheck(w.h.svc);
    seedTodo(w.h.db, "b1w");
    await w.beats(repeat(1.5, 3));
    expect(w.h.startedAt.length).toBe(MAIN.B1Warmup.starts);
  });

  it("B1 idle Mac, board WITH local checks, held2m 5 GB", async () => {
    const w = windowHarness("count");
    addLocalReviewCheck(w.h.svc);
    await w.beats(repeat(5, 14));
    seedTodo(w.h.db, "b1-five");
    await w.beat(5);
    expect(w.h.startedAt.length).toBe(MAIN.B1AtFive.starts);
    expect(w.h.commentsFor("b1-five").filter((content) => content.includes("Partenza in esenzione"))).toHaveLength(MAIN.B1AtFive.noCheckRows);
    expect(w.h.lines("per deroga")).toHaveLength(MAIN.B1AtFive.firstCardLog);
  });

  it("B2 hold -> first-card derogation transition log", async () => {
    let checks = 1;
    const w = windowHarness("count", { checksRunning: () => checks });
    addLocalReviewCheck(w.h.svc);
    seedTodo(w.h.db, "b2");
    await w.beats(repeat(4.8, 14));
    expect(w.h.startedAt.length).toBe(MAIN.B2.whileChecks);
    checks = 0;
    await w.beats(repeat(4.8, 2));
    expect(w.h.startedAt.length).toBe(MAIN.B2.afterChecks);
    expect(w.h.lines("per deroga")).toHaveLength(MAIN.B2.exemptionLog);
    expect(w.h.lines("le risorse sono rientrate sopra il pavimento")).toHaveLength(MAIN.B2.falseRecoveryLines);
  });

  for (const gb of [7, 8, 9, 9.5]) {
    it(`B3 resources mode, first card (no-check board) running, checked card at ${gb} GB`, async () => {
      const w = windowHarness("resources");
      await w.beats(repeat(5, 14));
      seedTodo(w.h.db, `b3-first-${gb}`);
      await w.beat(5);
      expect(w.h.startedAt.length).toBe(MAIN.B3.firstStarts);
      await w.beats(repeat(gb, 14));
      w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
      addLocalReviewCheck(w.h.svc, SECOND_PID);
      seedTodo(w.h.db, `b3-checked-${gb}`, SECOND_PID);
      await w.h.dispatcher.tick(SECOND_PID);
      await flush();
      expect(w.h.startedAt.length).toBe(MAIN.B3.totalStarts);
      expect(currentDispatchBlock()?.reason).toBe(mainMemoryReason(gb, MAIN.B3.reasonLineGB));
    });
  }

  for (const gb of [7, 10.5]) {
    it(`B4 count mode, first card (no-check board) parked on CI, checked card at ${gb} GB`, async () => {
      const offLane = new Set<string>();
      const w = windowHarness("count", { checksOffLane: (id) => offLane.has(id) });
      await w.beats(repeat(5, 14));
      seedTodo(w.h.db, `b4-first-${gb}`);
      await w.beat(5);
      expect(w.h.startedAt.length).toBe(MAIN.B4.firstStarts);
      offLane.add(`b4-first-${gb}`);
      await w.beats(repeat(gb, 14));
      w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
      addLocalReviewCheck(w.h.svc, SECOND_PID);
      seedTodo(w.h.db, `b4-checked-${gb}`, SECOND_PID);
      await w.h.dispatcher.tick(SECOND_PID);
      await flush();
      expect(w.h.startedAt.length).toBe(MAIN.B4.totalStarts);
      expect(currentDispatchBlock()?.reason ?? "").toBe(MAIN.B4.reason);
    });
  }

  for (const gb of [10.5, 12, 13.5]) {
    it(`B5 count mode, first card (no-check board) spending here, checked card at ${gb} GB`, async () => {
      const w = windowHarness("count");
      await w.beats(repeat(5, 14));
      seedTodo(w.h.db, `b5-first-${gb}`);
      await w.beat(5);
      expect(w.h.startedAt.length).toBe(MAIN.B5.firstStarts);
      await w.beats(repeat(gb, 14));
      w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
      addLocalReviewCheck(w.h.svc, SECOND_PID);
      seedTodo(w.h.db, `b5-checked-${gb}`, SECOND_PID);
      await w.h.dispatcher.tick(SECOND_PID);
      await flush();
      if (gb >= MAIN.B5.reasonLineGB) {
        expect(w.h.startedAt.length).toBe(MAIN.B5.startsAtLine);
        expect(currentDispatchBlock()?.reason ?? "").toBe("");
      } else {
        expect(w.h.startedAt.length).toBe(MAIN.B5.startsUnderLine);
        expect(currentDispatchBlock()?.reason).toBe(mainMemoryReason(gb, MAIN.B5.reasonLineGB, MAIN.B5.reservedGB));
      }
    });
  }

  it("B6 a checked card in flight keeps both no-check peers queued at 5 GB", async () => {
    const w = windowHarness("count");
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, SECOND_PID);
    await w.beats(repeat(20, 14));
    seedTodo(w.h.db, "b6-checked", SECOND_PID);
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();
    expect(w.h.startedAt.length).toBe(MAIN.B6.checkedStarts);
    await w.beats(repeat(5, 14));
    seedTodo(w.h.db, "b6-nochecks");
    seedTodo(w.h.db, "b6-nochecks-second");
    await w.beat(5);
    await w.beats(repeat(5, 3));
    expect(w.h.startedAt.length).toBe(MAIN.B6.totalStarts);
    expect(w.h.svc.get("b6-nochecks")?.task.dispatchError).toBe("waiting-memory");
    expect(w.h.commentsFor("b6-nochecks").filter((c) => c.includes("Partenza in esenzione"))).toHaveLength(0);
    expect(w.h.commentsFor("b6-nochecks-second").filter((c) => c.includes("Partenza in esenzione"))).toHaveLength(0);
    expect(w.h.svc.get("b6-nochecks-second")?.task.dispatchError).toBe("waiting-memory");
    expect(w.h.db.query<{ status: string }, [string]>("SELECT status FROM tasks WHERE id = ?").get("b6-nochecks-second")?.status).toBe("todo");
  });

  for (const share of [budgetShare({}), 0.8]) {
    it(`budget resources mode keeps the exempt candidate queued below its ${share} quota`, async () => {
      expect(capMode({ mode: "resources" })).toBe("resources");
      expect(budgetShare({})).toBe(0.6);
      const w = windowHarness("resources", { agentMemSamples: () => [4] }, 0, share);
      w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
      addLocalReviewCheck(w.h.svc, SECOND_PID);
      await w.beats(repeat(20, 14));
      seedTodo(w.h.db, `budget-checked-${share}`, SECOND_PID);
      await w.h.dispatcher.tick(SECOND_PID);
      await flush();
      expect(w.h.startedAt.length).toBe(1);
      await w.beats(repeat(5, 14));
      seedTodo(w.h.db, `budget-nocheck-${share}`);
      await w.beat(5);
      expect(w.h.startedAt.length).toBe(1);
      expect(w.h.attempts.getNoLocalChecksReservation?.(`budget-nocheck-${share}`)).toBeNull();
      expect(w.h.svc.get(`budget-nocheck-${share}`)?.task.dispatchError).toBe("waiting-memory");
      expect(JSON.stringify(w.h.svc.get(`budget-nocheck-${share}`)?.task.queueReason)).not.toMatch(/runtime|pavimento|prezza|nativo/i);

      if (share === 0.8) {
        const main = admissionVerdict(
          { ...QUIET, ourMemGB: 2, availableMemGB: 5, reservedMemGB: 4, running: 1 },
          0.8,
          { coreUnits: 0.1, memGB: 1 },
        );
        expect(main.freeQuotaMemGB).toBeCloseTo(0.8);
        expect(main.costMemGB).toBe(1);
        expect(main.admit).toBe(false);
        expect(main.blockedBy).toBe("memory");
      }

      await w.beats(repeat(20, 14));
      const preview = w.h.dispatcher.admissionPreview?.();
      expect(preview?.ourMemGB).toBeCloseTo(2);
    });
  }

  it("B4 the exempt reservation stays off the price list when another card is parked on CI", async () => {
    const offLane = new Set<string>();
    const w = windowHarness("count", { checksOffLane: (id) => offLane.has(id) });
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, SECOND_PID);
    await w.beats(repeat(20, 14));
    seedTodo(w.h.db, "b4-offlane-check", SECOND_PID);
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();
    expect(w.h.startedAt.length).toBe(1);
    offLane.add("b4-offlane-check");

    await w.beats(repeat(5, 14));
    seedTodo(w.h.db, "b4-exempt");
    await w.beat(5);
    expect(w.h.startedAt.length).toBe(1);
    expect(w.h.svc.get("b4-exempt")?.task.dispatchError).toBe("waiting-memory");
    expect(w.h.commentsFor("b4-exempt").some((c) => c.includes("Partenza in esenzione"))).toBe(false);

    await w.beats(repeat(10.5, 14));
    w.h.svc.updateBoardSettings(THIRD_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, THIRD_PID);
    seedTodo(w.h.db, "b4-checked-after-ci", THIRD_PID);
    await w.h.dispatcher.tick(THIRD_PID);
    await flush();
    expect(w.h.startedAt.length).toBe(2);
  });

  it("CLI exemption keeps the measured 0.42 GB price", async () => {
    const w = windowHarness("resources", {
      checksRunning: () => 1,
      isCliRuntime: () => true,
      agentMemSamples: () => [4],
    }, 0, 0.8);
    await w.beats(repeat(3, 14));
    seedTodo(w.h.db, "cli-nocheck");
    await w.beat(3);
    expect(w.h.startedAt.length).toBe(1);
    expect(w.h.commentsFor("cli-nocheck").some((c) => c.includes("prenotati 0.42 GB"))).toBe(true);
    await w.beats(repeat(20, 14));
    expect(w.h.dispatcher.admissionPreview?.()?.ourMemGB).toBeCloseTo(2.42);
  });

  it("heavy local work keeps light and heavy peers queued at 5 GB", async () => {
    const w = windowHarness("count");
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    await w.beats(repeat(20, 14));
    seedTodo(w.h.db, "heavy-running", SECOND_PID);
    w.h.db.run("UPDATE tasks SET dispatch_weight = 'heavy' WHERE id = ?", ["heavy-running"]);
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();
    expect(w.h.startedAt.length).toBe(1);

    await w.beats(repeat(5, 14));
    seedTodo(w.h.db, "light-exempt");
    await w.beat(5);
    expect(w.h.startedAt.length).toBe(1);
    expect(w.h.svc.get("light-exempt")?.task.dispatchError).not.toBe("waiting-memory");
    expect(w.h.commentsFor("light-exempt").some((comment) => /pesante/i.test(comment))).toBe(true);

    w.h.svc.updateBoardSettings(THIRD_PID, { autoDispatch: true, dispatchUseWorktree: false });
    seedTodo(w.h.db, "heavy-candidate", THIRD_PID);
    w.h.db.run("UPDATE tasks SET dispatch_weight = 'heavy' WHERE id = ?", ["heavy-candidate"]);
    await w.h.dispatcher.tick(THIRD_PID);
    await flush();
    expect(w.h.startedAt.length).toBe(1);
    expect(w.h.commentsFor("heavy-candidate").filter((c) => c.includes("Partenza in esenzione"))).toHaveLength(0);
    expect(w.h.db.query<{ status: string }, [string]>("SELECT status FROM tasks WHERE id = ?").get("heavy-candidate")?.status).toBe("todo");
  });

  it("B7 same task requeued twice keeps main's first-card behavior", async () => {
    let finish: (() => void) | null = null;
    const w = windowHarness("count", {
      runTurn: () => new Promise<void>((resolve) => { finish = () => resolve(); }),
    });
    const t0 = w.t0;
    await w.beats(repeat(5, 14));
    seedTodo(w.h.db, "b7");
    await w.beat(5);
    // Turn ends without delivering; put it back to todo as a requeue would.
    w.h.db.run("UPDATE tasks SET status = 'todo', assigned_topic_id = NULL, dispatch_state = NULL WHERE id = ?", ["b7"]);
    finish!();
    await flush(30);
    w.h.db.run("UPDATE tasks SET status = 'todo', assigned_topic_id = NULL, dispatch_state = NULL WHERE id = ?", ["b7"]);
    await w.beat(5);
    await w.beat(5);
    expect(w.h.startedAt.length).toBe(MAIN.B7.starts);
    expect(w.h.startedAt.map((at) => (at - t0) / 1000)).toEqual([...MAIN.B7.startSeconds]);
    expect(w.h.commentsFor("b7").filter((c) => c.includes("Partenza in esenzione"))).toHaveLength(MAIN.B7.exemptionLogs);
  });

  it("a no-check card restarts only after its prior local turn ends", async () => {
    const finishes: (() => void)[] = [];
    const w = windowHarness("count", {
      runTurn: () => new Promise<void>((resolve) => { finishes.push(resolve); }),
    });
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, SECOND_PID);
    await w.beats(repeat(20, 14));
    seedTodo(w.h.db, "restart-check", SECOND_PID);
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();
    await w.beats(repeat(5, 14));
    w.h.db.run("UPDATE tasks SET status = 'done', assigned_topic_id = NULL, dispatch_state = NULL WHERE id = ?", ["restart-check"]);
    finishes[0]!();
    await flush(30);
    expect(w.h.dispatcher.isInFlight("restart-check")).toBe(false);
    seedTodo(w.h.db, "restart-exempt");
    await w.beat(5);
    expect(w.h.startedAt.length).toBe(2);
    w.h.db.run("UPDATE tasks SET status = 'todo', assigned_topic_id = NULL, dispatch_state = NULL WHERE id = ?", ["restart-exempt"]);
    finishes[1]!();
    await flush(30);
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.startedAt.length).toBe(3);
    expect(w.h.attempts.list("restart-exempt").map((attempt) => attempt.idx)).toEqual([1, 2]);
    expect(w.h.commentsFor("restart-exempt").filter((content) => content.includes("Partenza in esenzione"))).toHaveLength(0);
  });
});
describe("extra", () => {
  it("B2n hold -> no-check exempt start transition log", async () => {
    const reading = 4.8;
    let checks = 1;
    const signal = createMemSignal({ measurable: true, probe: async () => ({ availGB: reading, swapins: 0, compressorPages: 0, pageSize: 16_384, swapUsedMB: 0, swapTotalMB: 16_384, load1: 1 }) });
    const h = harness({ agentMemSamples: () => [], agentCostSamples: () => [0.1], checksRunning: () => checks,
      heldMemory: () => signal.held(),
      isCliRuntime: () => false,
      resourceBlock: createDispatchResourceBlock({
        worktreesPath: () => "/tmp",
        readFreeGB: () => 500,
        heldMemory: () => signal.held(),
        isCliRuntime: () => false,
      }) });
    h.svc.setGlobalCap({ auto: false, max: 4 });
    let t = Date.now();
    const beat = async () => { setSystemTime(new Date(t)); await signal.sample(); await h.dispatcher.tick(PID); await flush(); t += 10_000; };
    seedTodo(h.db, "b2n");
    for (let i = 0; i < 14; i++) await beat();
    checks = 0;
    for (let i = 0; i < 2; i++) await beat();
    expect(h.startedAt.length).toBe(1);
    expect(h.attempts.getNoLocalChecksReservation?.("b2n")).toBe(1);
    expect(h.commentsFor("b2n").some((line) => line.includes("Partenza in esenzione"))).toBe(true);
  });
});
