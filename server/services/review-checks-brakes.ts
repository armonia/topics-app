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
 *  - a full 2-minute window whose lowest reading is over the floor, and ONLY
 *    while the swap verdict is sustained: see the paragraph below.
 * The command's deadline is not running during the wait: it is armed at spawn.
 *
 * THE FLOOR IS A NUMBER, "GASPING" IS A VERDICT, and on this Mac only the
 * verdict ever changes. The floor used to hold on its own, and the reading it
 * compares against never comes back: `held2m >= 6 GB` zero times in 1455
 * `[memsig]` lines over 25.7 hours of 16-17/09/2026. So the brake did not brake,
 * it timed out: on the first delivery to go through the CI rows (card c4f53a85,
 * 23:41:29Z-00:26Z of 16-17/09) the four local commands spent the round's WHOLE
 * 30-minute budget waiting against some 195 s of running - typecheck released
 * after 372 s, `check:deadcode` and `static-rails` only by the fail-open, which
 * is why the same "no room after 30 min" line names two commands in a row. Over
 * the 46 `[memsig]` samples of that round `held2m` was under 6 GB in 43, and 41
 * of those 43 read `swap=calm`: the machine was not swapping, which is the
 * problem this brake exists to avoid. So the floor is read INSIDE the sustained
 * branch, where the round is held anyway and the GB tell you how deep it is;
 * with a calm verdict a reading under the floor starts the command. A brake that
 * always fires its own fail-open is a timer in disguise.
 *
 * There is no per-command price: with the unit suite read from the pull request
 * CI (`github-ci:unit`) no delivery command on topics-app holds more than 1 GB
 * (tsc 460 MB, a vite build 316 MB), so the floor alone is the line.
 *
 * IT FAILS OPEN AFTER `maxWaitMs` OF WAITING IN TOTAL, whatever holds the round
 * - swap included, which it did not do before. A sustained verdict used to be
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
 */
export interface MemoryFloor {
  held: () => HeldMemory;
  swap: () => SwapVerdict;
  /** Under this, a new command waits - but only while the swap verdict is
   *  sustained: on a calm Mac the reading holds nothing. */
  floorGB: number;
  /** Total wait of one round before running anyway on room. Default `MEMORY_WAIT_MAX_MS`. */
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
const MEMORY_POLL_MS = 5_000;
/** One release per window across rounds: the herd of 15/09 (four commands on one poll) cannot recur. */
export const RELEASE_SPACING_MS = 120_000;

export type WaitReason = "swap" | "measuring" | "room" | "spacing" | "turn";

type Release = { round: symbol; name: string; at: number; running: boolean };
/** The last command released by any round: the spacing reads it. */
let lastRelease: Release | null = null;
/** Rounds waiting right now, with the moment their current wait began: the turn reads it. */
const waitingSince = new Map<symbol, number>();

export function releaseDecision(i: {
  held: HeldMemory;
  swap: SwapVerdict;
  floorGB: number;
  /** The last release, when it belongs to ANOTHER round. */
  otherRoundRelease: { at: number; running: boolean } | null;
  /** Another round has been waiting since before this wait began. */
  olderWaiter?: boolean;
  now: number;
  spentMs: number;
  maxWaitMs: number;
}): { release: boolean; wait: WaitReason | null; anyway: boolean } {
  if (!i.held.measurable) return { release: true, wait: null, anyway: false };
  // The budget comes FIRST, before every reason to hold: see the fail-open
  // paragraph above. Nothing here can hold a round longer than `maxWaitMs`.
  if (i.spentMs >= i.maxWaitMs) return { release: true, wait: null, anyway: true };
  // The floor lives here, inside the sustained verdict, and nowhere else: a Mac
  // that is not swapping starts the command whatever the reading says. Both
  // reasons hold the round the same, the difference is which line the log gets.
  if (i.swap.sustained) {
    const under = i.held.heldGB != null && i.held.heldGB < i.floorGB;
    return { release: false, wait: under ? "room" : "swap", anyway: false };
  }
  if (i.otherRoundRelease?.running && i.now - i.otherRoundRelease.at < RELEASE_SPACING_MS) {
    return { release: false, wait: "spacing", anyway: false };
  }
  // Still no release on a single reading: an empty window is not a calm one.
  if (i.held.heldGB == null) return { release: false, wait: "measuring", anyway: false };
  return i.olderWaiter ? { release: false, wait: "turn", anyway: false } : { release: true, wait: null, anyway: false };
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
      // The floor only speaks under a sustained verdict, so the line carries
      // both halves: the swap is the condition, the GB say how deep it is.
      return `[review-checks] "${name}" waits: lowest free memory of the last 2 min ${gb(held.heldGB)} GB, under the ${floorGB} GB floor, and the Mac is in sustained swap (${swapSigns(swap)})`;
  }
}

/**
 * One waiter per round: its budget of `maxWaitMs` is spent across the round.
 * The promise resolves with the callback to call when the released command
 * exits, which ends its hold on the spacing.
 */
export function memoryWaiter(floor: MemoryFloor | undefined, signal?: AbortSignal): (name: string) => Promise<() => void> {
  if (!floor) return async () => () => {};
  const maxWaitMs = floor.maxWaitMs ?? MEMORY_WAIT_MAX_MS;
  const pollMs = Math.max(1, floor.pollMs ?? MEMORY_POLL_MS);
  const now = floor.now ?? Date.now;
  const sleep = floor.sleep ?? ((ms: number) => Bun.sleep(ms));
  const round = Symbol("round");
  let spentMs = 0;
  const read = <T>(f: () => T, fallback: T): T => { try { return f(); } catch { return fallback; } };
  const unmeasured: HeldMemory = { measurable: false, latestGB: null, heldGB: null, coveredMs: 0 };
  const calm: SwapVerdict = { sustained: false, pagesReadBackPerS: null, debtGBPerMin: null, swapPct: null, coveredMs: 0 };
  return async (name) => {
    const from = now();
    let said: WaitReason | null = null;
    waitingSince.set(round, from);
    try {
      for (;;) {
        const t = now();
        const held = read(floor.held, unmeasured);
        const swap = read(floor.swap, calm);
        const other = lastRelease && lastRelease.round !== round ? lastRelease : null;
        const olderWaiter = [...waitingSince].some(([r, since]) => r !== round && since < from);
        const d = releaseDecision({ held, swap, floorGB: floor.floorGB, otherRoundRelease: other, olderWaiter, now: t, spentMs: spentMs + (t - from), maxWaitMs });
        // A round being stopped starts nothing, so it holds no release either.
        if (signal?.aborted || stopping) return () => {};
        if (d.release) {
          const waited = t - from;
          spentMs += waited;
          if (d.anyway) console.warn(`[review-checks] ${said === "swap" ? "still in swap" : "no room"} after ${Math.round(maxWaitMs / 60_000)} min: "${name}" starts anyway`);
          else if (said) console.warn(`[review-checks] "${name}" starts after ${Math.round(waited / 1000)} s`);
          const mine: Release = { round, name, at: t, running: true };
          lastRelease = mine;
          return () => { mine.running = false; };
        }
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
          // The second half of this sentence ("and there is memory for the first command")
          // was the floor holding on its own, which no longer happens: the swap is the condition.
          "Nessun verdetto registrato: il giro riparte da solo quando il Mac è fuori dallo swap. " + // allow-italian: board notes are written in Italian like every other service comment
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
