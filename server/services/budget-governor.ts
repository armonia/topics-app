/**
 * THE PART THAT ACTS ON WHAT IS ALREADY RUNNING.
 *
 * Refusing the next agent is half a brake. On 2026-09-07 this machine went from
 * load 12 to load 155 with 13.4 GB of swap WITHOUT dispatching anything new: the
 * work that did it had all started earlier, and nothing in the dispatcher could
 * reduce it. The three levers that brought it back (pause the dispatch, lower
 * the cap, stop the cards) were all pulled by hand, at 20:15, by a person.
 *
 * WHAT GETS FROZEN, and it is not the agents. A check runner is a `tsc`, an
 * `eslint`, a `bun test`, a `vite` build or the Chromium of an e2e run: no
 * network peer is waiting on it, nobody is watching it, and the only thing it
 * cares about is its own wall clock, which this module hands back to it (see
 * `onFreeze` / `onThaw`). It survives a pause with nothing lost. That is also
 * where the CPU actually is: measured with eight agents in flight, the agents
 * themselves summed to 5.7% of this machine while their gates ran seven full
 * suites, three `tsc` and an `eslint`.
 *
 * AGENTS ARE NOT SIGSTOPPED, and that is a decision (card 363bbbc8). A `claude`
 * CLI paused in the middle of a streaming response may lose the connection, and
 * how long it survives has not been measured; freezing the cheap thing to risk
 * a broken stream buys nothing. What holds the agents is the admission gate,
 * which stops giving out new ones until the use is back under the budget.
 *
 * NEVER, under any reading: the server, the sidecars, the pty bridge, the
 * user's browser. Only what is in this registry can be frozen, and only check
 * runners ever enter it.
 */
import { EMPTY_FREEZE_STATE, freezePlan, type FreezeState, type FreezeTarget } from "../../shared/board";
import { getDescendantPids } from "../lib/process-tree";

/** A check run that may be paused. Registered by whoever spawned it. */
export interface FreezableRun {
  /** Stable id for the plan and the log. */
  id: string;
  /** Head of the process tree to pause. Its descendants go with it. */
  pid: number;
  /** The check's name ("lint", "typecheck"): it goes in the log line. */
  name: string;
  /** The card this run belongs to, when there is one: the note goes there. */
  taskId?: string;
  startedAt: number;
  /** Called when the run is paused, so its own deadline can stop counting.
   *  A frozen gate that times out would be this module inventing a red. */
  onFreeze?: () => void;
  onThaw?: () => void;
}

const runs = new Map<string, FreezableRun>();

/** Declare a pausable run. Returns the deregistration, which the caller MUST
 *  call when the command ends: a registry that outlives its processes would
 *  send signals to recycled pids. */
export function registerFreezableRun(run: FreezableRun): () => void {
  runs.set(run.id, run);
  return () => { runs.delete(run.id); };
}

/** Test seam and shutdown: forget everything without signalling anything. */
export function _resetFreezableRuns(): void {
  runs.clear();
}

export function freezableRuns(): FreezableRun[] {
  return [...runs.values()];
}

export interface GovernorDeps {
  /** Core-units our own tree is burning now, and the budget it has. `null` =
   *  not measured, and a governor that cannot measure freezes nothing. */
  read: () => { used: number; budget: number } | null;
  /** SIGSTOP / SIGCONT on a whole process tree. */
  signalTree: (pid: number, sig: "SIGSTOP" | "SIGCONT") => Promise<void>;
  log: (message: string) => void;
  /** One line in the card's thread, so the person does not read the pause as a
   *  hung agent. Best effort: a note that fails must not stop the freeze. */
  note?: (taskId: string, text: string) => void;
}

export interface BudgetGovernor {
  /** One sample: decide, and act on at most one target. */
  sampleOnce: () => Promise<void>;
  frozenCount: () => number;
  frozenIds: () => string[];
  /** Continue everything this governor paused. Called on shutdown: leaving a
   *  process STOPped after the server exits is a process nobody will ever
   *  continue. */
  thawAll: () => Promise<void>;
}

export const FROZEN_NOTE = "Congelata per carico: riprende da sola quando la macchina scende.";

export function createBudgetGovernor(deps: GovernorDeps): BudgetGovernor {
  let state: FreezeState = EMPTY_FREEZE_STATE;

  const targets = (): FreezeTarget[] =>
    freezableRuns().map((r) => ({ id: r.id, kind: "check" as const, startedAt: r.startedAt }));

  async function sampleOnce(): Promise<void> {
    const reading = (() => { try { return deps.read(); } catch { return null; } })();
    if (!reading) return;
    const plan = freezePlan({ used: reading.used, budget: reading.budget, targets: targets() }, state);
    state = plan.state;
    if (plan.freeze) await apply(plan.freeze, "SIGSTOP");
    if (plan.thaw) await apply(plan.thaw, "SIGCONT");
  }

  async function apply(id: string, sig: "SIGSTOP" | "SIGCONT"): Promise<void> {
    const run = runs.get(id);
    if (!run) return;
    try {
      await deps.signalTree(run.pid, sig);
    } catch {
      // A signal that cannot be delivered (the process just exited) is not an
      // error worth a line: the next sample will find it gone from the registry.
      return;
    }
    if (sig === "SIGSTOP") {
      try { run.onFreeze?.(); } catch { /* the deadline stays as it was */ }
      deps.log(`congelo "${run.name}" per carico: Topics e' sopra il budget da due letture`);
      if (run.taskId) { try { deps.note?.(run.taskId, FROZEN_NOTE); } catch { /* the freeze holds anyway */ } }
    } else {
      try { run.onThaw?.(); } catch { /* the deadline stays as it was */ }
      deps.log(`scongelo "${run.name}": Topics e' rientrato nel budget`);
    }
  }

  return {
    sampleOnce,
    frozenCount: () => state.frozen.length,
    frozenIds: () => [...state.frozen],
    async thawAll() {
      // Last frozen, first continued, like the ordinary thaw: the order is not
      // observable to a process being continued, but two ways of undoing the
      // same list is how the two start disagreeing.
      const frozen = [...state.frozen].reverse();
      state = { ...state, frozen: [] };
      for (const id of frozen) await apply(id, "SIGCONT");
    },
  };
}

/**
 * SIGSTOP/SIGCONT to a pid and every descendant of it.
 *
 * The whole tree, in both directions, because a check is never one process: it
 * is `/bin/sh`, the runner, and whatever the runner spawned. Pausing only the
 * shell would leave the compiler burning the cores this exists to give back.
 *
 * SIGCONT goes to the same set: a child continued while its parent is still
 * stopped would sit there having lost the pipe reader on the other side.
 */
export async function signalProcessTree(pid: number, sig: "SIGSTOP" | "SIGCONT"): Promise<void> {
  if (!pid || pid <= 0) return;
  const pids = await getDescendantPids(pid, { fresh: true });
  for (const p of pids) {
    try { process.kill(p, sig); } catch { /* already gone */ }
  }
}

/**
 * THE ONE GOVERNOR OF THIS PROCESS, so the capacity endpoint can say how many
 * runs are frozen without the route having to be handed a reference through
 * four layers that do not care. Set once at startup; `null` in tests and in a
 * headless harness, where the answer is simply "none frozen".
 */
let active: BudgetGovernor | null = null;

export function setActiveBudgetGovernor(g: BudgetGovernor | null): void {
  active = g;
}

export function activeFrozenCount(): number {
  try { return active?.frozenCount() ?? 0; } catch { return 0; }
}
