/**
 * THE TWO BRAKES OF A PRE-REVIEW ROUND THAT DO NOT LIVE IN THE COMMAND.
 *
 * `slot.ts` holds a command back while another run of the same gate is alive;
 * the governor pauses a run already going. Neither of them could stop a NEW
 * command from starting on a machine out of memory, and nothing stopped a
 * running tree when the server itself went away. Both are here, and
 * `runReviewChecks` (review-checks.ts) consults them around every command.
 */
import { freezableRuns, type FreezableRun } from "./budget-governor";
import { ChecksInterruptedError } from "./checks-gate";
import { killProcessTree } from "../lib/process-tree";
import { swapReasonIt, swapSigns, type HeldMemory, type SwapVerdict } from "./mem-signal";

/**
 * NO NEW CHECK STARTS UNDER THE MEMORY FLOOR, INTO SUSTAINED SWAP, OR IN A HERD.
 *
 * Every brake in front of a check counted something other than free memory:
 * the lanes of the gate (2 on 12 cores), the slots and names of `slot.ts`, the
 * load of the unit runner. The admission cannot price it either: a card is
 * admitted while memory is free and delivers tens of minutes later, and its
 * check tree is a child of the server, not of the session the admission
 * measured. Measured 15/09/2026: `availableMemGB` 5.9 with 9.9 GB of swap.
 *
 * The first version of this waiter released on the first reading over the
 * floor, and that morning typecheck, lint and deadcode were each released by
 * one poll at 5.0-6.0 GB while four commands of different deliveries left on
 * the same poll. So each declared command now waits, before it is spawned, for
 * (`releaseDecision`):
 *  - no sustained swap, with no fail-open: a round restarted after a swap
 *    interruption must not start straight into the thrash that is under way;
 *  - 120 s since a command of ANOTHER round was released, while it still runs:
 *    one release per window across rounds;
 *  - its turn: a round that has been waiting since before this wait began goes
 *    first. The next command of a round asks the moment the previous one exits,
 *    in the same microtask turn, while the other round only reads again at its
 *    next 5 s poll: without the turn a three-command round took the spacing
 *    back every time and the other round waited for its whole local phase
 *    (95 s instead of 35 with three 30 s commands);
 *  - a full 2-minute window whose lowest reading is over the floor.
 * The command's deadline is not running during the wait: it is armed at spawn.
 *
 * THE FLOOR HOLDS, CALM OR SWAPPING; WHAT DEPENDS ON THE VERDICT IS THE VALVE.
 * A first version of this moved the floor INSIDE the sustained branch, so that a
 * calm Mac under the floor started the command. An adversarial check ran it and
 * showed it did not weaken the floor, it deleted it: the sustained branch
 * already returns before the floor is read, so calm was the only state where the
 * floor had any force. Over 160 states (calm/sustained x held 0,1..20 and null x
 * spacing x turn x what the round had spent) `floorGB: 0` and `floorGB: 1000` gave the SAME
 * decision in every one - an unobservable parameter. And the floor still guards
 * somebody: `checksMemoryFloor` is mounted once for the whole server
 * (server.ts), not per board, and board `dancerooms-intq6i` declares
 * `pnpm verify:all --only typecheck,unit` as its only local check - exactly the
 * 4-11 GB tree this brake exists to keep off an empty Mac. On topics-app itself
 * nothing would catch it: `createSwapBrake` only interrupts trees over
 * `SWAP_VICTIM_MIN_GB` = 1 GB, while this file prices tsc at 460 MB and a vite
 * build at 316 MB.
 *
 * IT FAILS OPEN AFTER A BUDGET SPENT ACROSS THE ROUND, whatever holds it - swap
 * included, which it did not do before. A sustained verdict used to be
 * self-limiting: it implied a debt growing by at least 0.5 GB/min, a state no
 * machine holds for long. The ceiling door (`mem-signal.ts`) removes that
 * invariant, and the ceiling is where this Mac LIVES: 566 of the 874 `[memsig]`
 * lines of 15-16/09 sit over 90% of the swap file, and the longest unbroken
 * sustained episode goes from 4 minutes under the old rule to 19 under the new
 * one. A brake with no way out is not a brake: the swap branch sat in front of
 * the budget, so one chronic false positive held every checks round for ever,
 * and a round that never starts records no verdict at all - the delivery just
 * goes round again (`checks-gate.ts`). Memory that cannot be measured (off
 * macOS) never waits.
 *
 * THAT BUDGET IS THREE MINUTES WHEN THE FLOOR HOLDS A CALM MAC, thirty when the
 * Mac is swapping, because the two waits do not buy the same thing. Under thrash
 * the machine is giving memory back and waiting works. On a calm Mac the reading
 * rarely improves on its own, and when it does not it does not for hours: over
 * the 1553 `[memsig]` windows of 16-17/09/2026 (07:27Z to 11:56Z, 28.5 hours)
 * `held2m >= 6 GB` reads 241 times, 15.5% of them, and the longest unbroken
 * stretch UNDER the floor is 854 samples, about fourteen hours. Thirty minutes
 * and three end identically inside a stretch like that, which is where this Mac
 * spends most of its day; the 15.5% is why the floor keeps a budget at all
 * instead of being read once and given up on. Measured on card c4f53a85
 * (23:41:29Z-00:26Z of 16-17/09), the first delivery to go through the CI rows:
 * four local commands, 80 s of execution inside a 32-minute round, `swap=calm`
 * in 40 of the 42 samples that were under the floor - typecheck released by the
 * budget, `check:deadcode` and `static-rails` never waiting at all because the
 * round had already spent it.
 * Not less than three: `swapVerdict` needs a base sample at least
 * `SWAP_WINDOW_MS` (60 s) old, and the ceiling door a further window before it,
 * so a thrash that starts right after a release is invisible for 60-120 s. Three
 * minutes leaves the verdict one full window to see it, and stays clear of the
 * 120 s release spacing, which is not cut short by this budget at all: the short
 * valve applies only when what holds the round is the floor on a calm Mac.
 *
 * AND THE TWO BUDGETS ARE SPENT APART, one clock each. Pooled in a single
 * `spentMs`, the wait of one condition paid for the other: a round that spent ten
 * minutes in sustained swap, with its reading unchanged at 5.2 GB under a 6 GB
 * floor, was released THE INSTANT the verdict turned calm - the ten minutes it
 * had spent waiting for the swap already covered the three-minute valve, so the
 * floor never held it at all. An episode of thrash bought the round its exemption
 * from the floor for the rest of the round, which is the opposite of what either
 * brake is for. What a wait buys is what it waited FOR: time spent on the swap is
 * charged to the thirty-minute budget, time spent under the floor on a calm Mac
 * to the three-minute one, and each command's wait is charged to the condition in
 * force while it elapsed, not to the one it ends on.
 */
export interface MemoryFloor {
  held: () => HeldMemory;
  swap: () => SwapVerdict;
  /** Under this, a new command waits, calm or swapping. */
  floorGB: number;
  /** What one round may wait on anything but the floor of a calm Mac, before
   *  running anyway. Default `MEMORY_WAIT_MAX_MS`; the calm floor's own budget is
   *  `MEMORY_WAIT_CALM_MAX_MS`, or this one when this one is shorter. */
  maxWaitMs?: number;
  /** How often the signal is read again while waiting. */
  pollMs?: number;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Thirty minutes, the same limit as a gate waiting for another run of itself
 *  (`defaultNameMaxWaitMs`). Added up, the waits of one round can outlast the 50
 *  minutes `update_task` polls; the verdict still lands, re-issued by the route
 *  (`pendingDeliveries`) once the client has given up. */
const MEMORY_WAIT_MAX_MS = 30 * 60_000;
/** The budget while the floor alone holds a Mac that is NOT swapping: see the
 *  third paragraph of the header. */
const MEMORY_WAIT_CALM_MAX_MS = 3 * 60_000;
const MEMORY_POLL_MS = 5_000;
/** One release per window across rounds: the herd of 15/09 (four commands on one poll) cannot recur. */
export const RELEASE_SPACING_MS = 120_000;

export type WaitReason = "swap" | "measuring" | "room" | "spacing" | "turn";

/**
 * The two budgets, and the two clocks that spend them. `calmFloor` is the floor
 * on a Mac that is not swapping - the only state the short valve is for; `other`
 * is every other reason to hold, the swap included. Separate because a wait buys
 * what it waited FOR: see the last paragraph of the header.
 */
export type WaitBudget = "calmFloor" | "other";

/** Which of the two a reason spends. `room` reaches here only on a calm Mac:
 *  `holdReason` answers "swap" first, so a sustained verdict is never the floor. */
function budgetOf(reason: WaitReason | null): WaitBudget {
  return reason === "room" ? "calmFloor" : "other";
}

type Release = { round: symbol; name: string; at: number; running: boolean };
/** The last command released by any round: the spacing reads it. */
let lastRelease: Release | null = null;
/** Rounds waiting right now, with the moment their current wait began: the turn reads it. */
const waitingSince = new Map<symbol, number>();

interface DecisionInput {
  held: HeldMemory;
  swap: SwapVerdict;
  floorGB: number;
  /** The last release, when it belongs to ANOTHER round. */
  otherRoundRelease: { at: number; running: boolean } | null;
  /** Another round has been waiting since before this wait began. */
  olderWaiter?: boolean;
  now: number;
  /**
   * What this round has already waited, ONE CLOCK PER BUDGET. Pooled in a single
   * number the clocks paid for each other, and ten minutes of swap released the
   * next command from a floor it had never waited a second for.
   */
  spent: Record<WaitBudget, number>;
  maxWaitMs: number;
}

/** What holds the round back right now, budget aside - null = nothing does. */
function holdReason(i: DecisionInput): WaitReason | null {
  if (i.swap.sustained) return "swap";
  if (i.otherRoundRelease?.running && i.now - i.otherRoundRelease.at < RELEASE_SPACING_MS) return "spacing";
  // Still no release on a single reading: an empty window is not a roomy one.
  if (i.held.heldGB == null) return "measuring";
  if (i.held.heldGB < i.floorGB) return "room";
  return i.olderWaiter ? "turn" : null;
}

export function releaseDecision(i: DecisionInput): {
  release: boolean;
  wait: WaitReason | null;
  anyway: boolean;
  /** What was holding the round when the budget let it go: the fail-open line
   *  names it instead of guessing from the last reason it logged. */
  heldBy: WaitReason | null;
  /** The budget that applied to this decision, for that same line. */
  budgetMs: number;
  /** And what the round had spent OF THAT budget, the other half of the line. */
  spentMs: number;
} {
  const held = holdReason(i);
  // The short valve is for the floor on a calm Mac and for nothing else: the
  // spacing and the turn resolve by themselves within 120 s, and cutting them
  // short would bring back the herd of four commands on one poll (15/09).
  const budget = budgetOf(held);
  const budgetMs = budget === "calmFloor"
    ? Math.min(MEMORY_WAIT_CALM_MAX_MS, i.maxWaitMs)
    : i.maxWaitMs;
  // Each budget answers to its own clock: what the round spent waiting for
  // something else is not spent here.
  const spentMs = i.spent[budget];
  if (!i.held.measurable) return { release: true, wait: null, anyway: false, heldBy: null, budgetMs, spentMs };
  // The budget comes before every reason to hold: see the fail-open paragraph
  // above. Nothing here can hold a round longer than its budget.
  if (spentMs >= budgetMs) return { release: true, wait: null, anyway: held != null, heldBy: held, budgetMs, spentMs };
  if (!held) return { release: true, wait: null, anyway: false, heldBy: null, budgetMs, spentMs };
  return { release: false, wait: held, anyway: false, heldBy: held, budgetMs, spentMs };
}

function waitLine(name: string, reason: WaitReason, held: HeldMemory, swap: SwapVerdict, floorGB: number, now: number): string {
  const gb = (n: number | null) => (n == null ? "?" : n.toFixed(1));
  switch (reason) {
    case "swap":
      return `[review-checks] "${name}" waits: the Mac is in sustained swap (${swapSigns(swap)})`;
    case "spacing":
      return `[review-checks] "${name}" waits: "${lastRelease?.name ?? "?"}" of another delivery started ${Math.round((now - (lastRelease?.at ?? now)) / 1000)} s ago, one release per 2 min`;
    case "turn":
      return `[review-checks] "${name}" waits: another delivery has been waiting longer, it starts first`;
    case "measuring":
      return `[review-checks] "${name}" waits: free memory measured for ${Math.round(held.coveredMs / 1000)} s of the 120 s window`;
    case "room":
      return `[review-checks] "${name}" waits: lowest free memory of the last 2 min ${gb(held.heldGB)} GB, under the ${floorGB} GB floor`;
  }
}

/** Seconds up to 90, minutes above: a command that waited nothing must not read
 *  as "0 min", which is what a budget printed as a duration made it say. */
const duration = (ms: number): string =>
  (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/**
 * The fail-open line says which condition held the command AND HOW LONG THIS
 * COMMAND ACTUALLY WAITED, both read from the state at that instant. It used to
 * read the last reason THIS command had logged, which is null for a command that
 * never waited, and to print the round's BUDGET where the duration goes: on
 * 17/09 the round of card c4f53a85 printed "no room after 30 min" for
 * `check:deadcode` and again for `static-rails`, neither of which had waited a
 * poll. The error log carries no timestamp, so that line is the only trace left
 * of the round: it says what this command waited, and then what the round had
 * spent of the budget that let it go - which is how a wait of 0 s explains
 * itself.
 */
function failOpenLine(name: string, heldBy: WaitReason, waitedMs: number, spentMs: number, budgetMs: number): string {
  const said: Record<WaitReason, string> = {
    swap: "still in swap",
    room: "no room",
    measuring: "still measuring free memory",
    spacing: "still spaced from another delivery",
    turn: "still waiting its turn",
  };
  return `[review-checks] ${said[heldBy]} after ${duration(waitedMs)} (round: ${duration(spentMs)} of a ${duration(budgetMs)} budget): "${name}" starts anyway`;
}

/**
 * One waiter per round: its two budgets are spent across the round, a clock
 * each, and every stretch of wait is charged to the condition that was in force
 * while it elapsed. The promise resolves with the callback to call when the
 * released command exits, which ends its hold on the spacing.
 */
export function memoryWaiter(floor: MemoryFloor | undefined, signal?: AbortSignal): (name: string) => Promise<() => void> {
  if (!floor) return async () => () => {};
  const maxWaitMs = floor.maxWaitMs ?? MEMORY_WAIT_MAX_MS;
  const pollMs = Math.max(1, floor.pollMs ?? MEMORY_POLL_MS);
  const now = floor.now ?? Date.now;
  const sleep = floor.sleep ?? ((ms: number) => Bun.sleep(ms));
  const round = Symbol("round");
  const spent: Record<WaitBudget, number> = { calmFloor: 0, other: 0 };
  const read = <T>(f: () => T, fallback: T): T => { try { return f(); } catch { return fallback; } };
  const unmeasured: HeldMemory = { measurable: false, latestGB: null, heldGB: null, coveredMs: 0 };
  const calm: SwapVerdict = { sustained: false, pagesReadBackPerS: null, debtGBPerMin: null, swapPct: null, coveredMs: 0 };
  return async (name) => {
    const from = now();
    let said: WaitReason | null = null;
    /** The start of the stretch not yet charged, and the budget it is spending. */
    let sinceAt = from;
    let spending: WaitBudget | null = null;
    waitingSince.set(round, from);
    try {
      for (;;) {
        const t = now();
        // The stretch that just elapsed belongs to the condition in force WHILE
        // it elapsed, not to the one read now: a wait that begins in sustained
        // swap and ends on a calm Mac pays the swap, and the floor's three
        // minutes start from zero the moment the verdict turns.
        if (spending) spent[spending] += t - sinceAt;
        sinceAt = t;
        const held = read(floor.held, unmeasured);
        const swap = read(floor.swap, calm);
        const other = lastRelease && lastRelease.round !== round ? lastRelease : null;
        const olderWaiter = [...waitingSince].some(([r, since]) => r !== round && since < from);
        const d = releaseDecision({ held, swap, floorGB: floor.floorGB, otherRoundRelease: other, olderWaiter, now: t, spent, maxWaitMs });
        // A round being stopped starts nothing, so it holds no release either.
        if (signal?.aborted || stopping) return () => {};
        if (d.release) {
          const waited = t - from;
          if (d.anyway && d.heldBy) console.warn(failOpenLine(name, d.heldBy, waited, d.spentMs, d.budgetMs));
          else if (said) console.warn(`[review-checks] "${name}" starts after ${Math.round(waited / 1000)} s`);
          const mine: Release = { round, name, at: t, running: true };
          lastRelease = mine;
          return () => { mine.running = false; };
        }
        spending = budgetOf(d.wait);
        if (d.wait !== said) {
          said = d.wait;
          console.warn(waitLine(name, d.wait!, held, swap, floor.floorGB, t));
        }
        await sleep(pollMs);
      }
    } finally {
      waitingSince.delete(round);
    }
  };
}

/** Test seam: the spacing is process-wide, a test file is not. */
export function _resetReleaseSpacing(): void {
  lastRelease = null;
  waitingSince.clear();
}

/**
 * A SERVER THAT STOPS TAKES ITS CHECK TREES WITH IT, and records no verdict.
 *
 * `slot.ts` spawns the command in a process group of its own, and nothing
 * killed it when the server exited: after a reload the whole tree was
 * reparented to pid 1 and ran to the end, holding its memory, with nobody left
 * to read the verdict. Seen live on 15/09/2026 at 02:04: four
 * `test:unit:shards` trees at once, two of them orphans of the server that had
 * restarted at 01:51, beside the two the new server had started for the same
 * cards.
 *
 * A run killed here is not a red: the code was never measured. So after the
 * kill the round throws `ChecksInterruptedError` instead of returning the
 * killed run, and the gate turns it into an INTERRUPTED outcome (checks-gate.ts):
 * nothing is recorded, the delivery waiting on the round answers like a leg
 * still in flight without moving the card, and the client's next leg, retried
 * across the restart, measures it again. The same flag stops any command that
 * has not started yet.
 */
let stopping = false;

export function throwIfStopping(): void {
  if (stopping) throw new ChecksInterruptedError();
}

/** The server is on its way out: a delivery that would start a new round (and
 *  realign its branch first) is held for its leg instead. */
export function reviewChecksStopping(): boolean {
  return stopping;
}

/** A check command is spawned `detached` (review-checks.ts `runOne`): its kill
 *  signals the process group too, which holds what the shell forked after the
 *  descendants snapshot or reparented to pid 1 before it. */
export const killCheckTree = (pid: number): Promise<void> => killProcessTree(pid, undefined, { group: true });

/** Kills every running check tree and stops the rounds from starting another
 *  command. Resolves once the SIGTERMs are sent; returns how many trees. */
export async function stopReviewChecks(kill: (pid: number) => Promise<void> = killCheckTree): Promise<number> {
  stopping = true;
  const live = freezableRuns();
  await Promise.all(live.map((run) => kill(run.pid).catch(() => { /* already gone */ })));
  return live.length;
}

/** Test seam: a stop is for the life of the process, a test file is not. */
export function _resetReviewChecksStop(): void {
  stopping = false;
}

/**
 * UNDER SUSTAINED SWAP TOPICS INTERRUPTS THE YOUNGEST HEAVY CHECK ROUND BY ITSELF.
 *
 * The owner's answer (15/09/2026): a round already running on a Mac in swap is
 * interrupted by Topics, as interrupted and never red, and restarts by itself.
 * Nothing else takes memory back from work in flight: the governor freezes for
 * CPU only, and a SIGSTOP gives no memory back.
 *
 * On each 10 s beat, after the memory signal is sampled:
 *  - not sustained: nothing (the end of an episode is logged once);
 *  - less than 120 s since the last interruption: nothing, to see its effect
 *    (5 s SIGKILL grace, a beat, and a 60 s swap window still holding the
 *    samples from before the kill);
 *  - candidates: registered runs of a card whose tree holds >= 1 GB, interrupted
 *    fewer than 2 times on their delivery `taskId@commit`. Killing a tsc (460 MB),
 *    a vite build (316 MB) or the static rails gives nothing back and costs a
 *    round; a delivery interrupted twice runs to the end, or it could be killed
 *    forever;
 *  - victim: the youngest round, whose rerun wastes the least.
 * The round throws `ChecksInterruptedError("swap")` before the killed command
 * becomes a run, so no verdict and no card peak are recorded; the route re-issues
 * the delivery, which waits in `memoryWaiter` until the swap is over.
 */
export const SWAP_INTERRUPT_SPACING_MS = 120_000;
export const SWAP_INTERRUPTS_PER_DELIVERY = 2;
export const SWAP_VICTIM_MIN_GB = 1;

/** Interruptions per delivery `taskId@commit`, forgotten when a verdict is recorded. */
const interruptionsByDelivery = new Map<string, number>();
/** Cards whose running command was just killed by the brake: their round throws once. */
const interruptedTasks = new Set<string>();

const deliveryKey = (taskId: string, commit: string | null | undefined) => `${taskId}@${commit ?? ""}`;
const treeGB = (run: FreezableRun) => ((run.treeKB ?? 0) * 1024) / 1e9;

export function swapVictim(i: {
  sustained: boolean;
  runs: readonly FreezableRun[];
  now: number;
  /**
   * The last moment ANY swap lever acted, not just this one. The freezer
   * (`services/swap-freeze.ts`) stops an agent's heaviest background command on
   * the same 60 s window this brake reads: with a clock each, the second lever
   * would act ten seconds after the first and then measure the first one's
   * effect as its own.
   */
  lastActionAt: number;
  interruptions: (delivery: string) => number;
}): { victim: FreezableRun | null; skipped: "spacing" | "noHeavyRun" | "exhausted" | null } {
  if (!i.sustained) return { victim: null, skipped: null };
  if (i.now - i.lastActionAt < SWAP_INTERRUPT_SPACING_MS) return { victim: null, skipped: "spacing" };
  const heavy = i.runs.filter((r) => r.taskId && treeGB(r) >= SWAP_VICTIM_MIN_GB);
  if (heavy.length === 0) return { victim: null, skipped: "noHeavyRun" };
  const open = heavy.filter((r) => i.interruptions(deliveryKey(r.taskId!, r.commit)) < SWAP_INTERRUPTS_PER_DELIVERY);
  if (open.length === 0) return { victim: null, skipped: "exhausted" };
  const victim = open.reduce((a, b) => ((b.roundStartedAt ?? b.startedAt) > (a.roundStartedAt ?? a.startedAt) ? b : a));
  return { victim, skipped: null };
}

/**
 * What the brake did on this beat, read by the swap freezer: it acts only when
 * the brake found nothing to interrupt, so the lever that gives memory back is
 * always tried first.
 */
export interface SwapBrakeOutcome {
  interrupted: boolean;
  skipped: "spacing" | "noHeavyRun" | "exhausted" | null;
}

export function createSwapBrake(deps: {
  kill: (pid: number) => Promise<void>;
  note: (taskId: string, text: string) => void;
  log: (line: string) => void;
  now?: () => number;
}): { tick(v: SwapVerdict, runs: readonly FreezableRun[], lastForeignActionAt?: number): SwapBrakeOutcome } {
  const now = deps.now ?? Date.now;
  let lastInterruptAt = Number.NEGATIVE_INFINITY;
  let episodeSince: number | null = null;
  let saidNothing = false;
  let saidExhausted = false;
  const gb = (n: number | null) => (n == null ? "?" : n.toFixed(1));
  return {
    tick(v, runs, lastForeignActionAt = Number.NEGATIVE_INFINITY) {
      const t = now();
      if (!v.sustained) {
        if (episodeSince != null) deps.log(`[checks-swap] swap no longer sustained after ${Math.round((t - episodeSince) / 1000)} s`);
        episodeSince = null;
        saidNothing = false;
        saidExhausted = false;
        return { interrupted: false, skipped: null };
      }
      episodeSince ??= t;
      const signs = swapSigns(v);
      const { victim, skipped } = swapVictim({
        sustained: true, runs, now: t,
        lastActionAt: Math.max(lastInterruptAt, lastForeignActionAt),
        interruptions: (key) => interruptionsByDelivery.get(key) ?? 0,
      });
      if (!victim) {
        if (skipped === "noHeavyRun" && !saidNothing) {
          saidNothing = true;
          deps.log(`[checks-swap] swap sustained (${signs}) and no Topics check tree holds >= ${SWAP_VICTIM_MIN_GB} GB: nothing to interrupt`);
        }
        if (skipped === "exhausted" && !saidExhausted) {
          saidExhausted = true;
          for (const r of runs.filter((x) => x.taskId && treeGB(x) >= SWAP_VICTIM_MIN_GB)) {
            deps.log(`[checks-swap] "${r.name}" of ${r.taskId!.slice(0, 8)} not interrupted: already interrupted ${SWAP_INTERRUPTS_PER_DELIVERY} times on this commit, it runs to the end`);
          }
        }
        return { interrupted: false, skipped };
      }
      const taskId = victim.taskId!;
      const key = deliveryKey(taskId, victim.commit);
      const n = (interruptionsByDelivery.get(key) ?? 0) + 1;
      lastInterruptAt = t;
      interruptionsByDelivery.set(key, n);
      interruptedTasks.add(taskId);
      void deps.kill(victim.pid).catch(() => { /* already gone */ });
      const roundAge = Math.round((t - (victim.roundStartedAt ?? victim.startedAt)) / 1000);
      deps.log(`[checks-swap] interrupted "${victim.name}" of ${taskId.slice(0, 8)} (round started ${roundAge} s ago, tree ${gb(treeGB(victim))} GB): ${signs}; interruption ${n} of ${SWAP_INTERRUPTS_PER_DELIVERY}`);
      try {
        deps.note(taskId,
          `Check interrotti, non rossi: ${swapReasonIt(v)} e \`${victim.name}\` teneva ${gb(treeGB(victim))} GB. ` + // allow-italian: board notes are written in Italian like every other service comment
          "Nessun verdetto registrato: il giro riparte da solo quando il Mac è fuori dallo swap e c'è memoria per il primo comando da 2 minuti. " + // allow-italian: board notes are written in Italian like every other service comment
          `Interruzione ${n} di ${SWAP_INTERRUPTS_PER_DELIVERY}: dopo la seconda il giro va fino in fondo comunque.`); // allow-italian: board notes are written in Italian like every other service comment
      } catch { /* a note that cannot be written must not stop the brake */ }
      return { interrupted: true, skipped: null };
    },
  };
}

/** Right after each command (and before the next one): a round whose tree the brake killed stops, once. */
export function throwIfInterrupted(taskId: string | undefined): void {
  if (taskId && interruptedTasks.delete(taskId)) throw new ChecksInterruptedError("swap");
}

/** The delivery on this commit was interrupted by the brake and has no verdict yet:
 *  its restart is the same delivery, and does not realign on main again. */
export function swapInterruptedDelivery(taskId: string, commit: string | null): boolean {
  return (interruptionsByDelivery.get(deliveryKey(taskId, commit)) ?? 0) > 0;
}

/** A verdict was recorded for the card: its interruptions are over. */
export function forgetDelivery(taskId: string): void {
  interruptedTasks.delete(taskId);
  for (const key of [...interruptionsByDelivery.keys()]) if (key.startsWith(`${taskId}@`)) interruptionsByDelivery.delete(key);
}

/** Test seam: the counts are process-wide, a test file is not. */
export function _resetSwapBrake(): void {
  interruptionsByDelivery.clear();
  interruptedTasks.clear();
}
