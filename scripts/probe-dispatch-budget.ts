#!/usr/bin/env bun
/**
 * THE SYNTHETIC BENCH OF THE CPU BUDGET, on real processes.
 *
 *   bun run probe:budget
 *
 * WHY IT EXISTS. The unit tests drive the controller with a table of numbers,
 * which proves the arithmetic and nothing about the machine: that a real
 * process tree is measured where it burns, that SIGSTOP actually lands on the
 * whole tree, and that a stopped process really shows up as `T` in `ps`. This
 * probe answers those three, in about half a minute, with a burner it starts
 * and kills itself.
 *
 * WHAT IT REPRODUCES. The evening of 2026-09-07 (card 363bbbc8): a machine
 * already busy, cards in Todo, and a brake that admitted all of them in one
 * tick. Here five burner processes take the machine, three fake cards are
 * queued, and the budget is set just above what the burner really took.
 *
 *   BEFORE (the control arm, `--no-budget`): all three start on the first tick.
 *   AFTER:  one starts, the second waits, and nothing else moves that tick.
 *   THEN:   the budget is halved under the live burner, and the two fake check
 *           runners are frozen one at a time (`ps -o stat` says `T`); when the
 *           burner dies they are continued again.
 *
 * THE BUDGET IS DERIVED FROM THE MEASUREMENT, not written as "50% of twelve
 * cores", and that is deliberate. A burner does not get the cores it asks for
 * on a machine that is already working: run while four agents were delivering,
 * five spinning processes took 2.3 core-units, not five. Pinning the budget to
 * a nominal share would make the bench pass or fail on how busy the machine
 * happens to be, which is the one thing it must not measure. What it measures
 * is the controller against a load that is really there.
 *
 * IT IS A PROBE, NOT A GATE, and the `probe:` prefix is where this repository
 * writes that distinction down: it starts a real load, so its numbers describe
 * THIS machine at THIS moment. It still exits non-zero when an expectation
 * fails, so it can be read from a script.
 */
import { spawn } from "node:child_process";
import {
  EMPTY_FREEZE_STATE,
  admissionVerdict,
  estimatedAgentCost,
  freezePlan,
  type BudgetGateState,
  type FreezeState,
  type MachineBudgetSample,
} from "../shared/board";
import { machineCores } from "../server/lib/machine-cores";
import { parseCpuTimeSeconds } from "../server/lib/fleet-summary";

const CORES = machineCores();
/** How many spinning processes take the machine. Five is the shape the card
 *  asked for; what they actually get is measured, not assumed. */
const BURNERS = 5;
/** How long a CPU sample looks at the tree. Shorter than this and a scheduler
 *  hiccup is the whole reading; longer and the probe stops being half a minute. */
const SAMPLE_MS = 1500;

let failures = 0;
const check = (ok: boolean, line: string): void => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
};

/** One process that eats one core until it is killed. */
function burner(): { pid: number; stop: () => void } {
  const child = spawn(
    process.execPath,
    ["-e", "for (;;) { Math.sqrt(Math.random()); }"],
    { stdio: "ignore", detached: true },
  );
  return {
    pid: child.pid ?? 0,
    stop: () => { try { process.kill(-(child.pid ?? 0), "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } },
  };
}

/** A stand-in for a check runner: a tree that sleeps, so freezing it is visible
 *  in `ps` and costs nothing. Detached, so the whole group can be signalled. */
function fakeCheck(): { pid: number; stop: () => void } {
  const child = spawn("/bin/sh", ["-c", "sleep 600"], { stdio: "ignore", detached: true });
  return {
    pid: child.pid ?? 0,
    stop: () => { try { process.kill(-(child.pid ?? 0), "SIGKILL"); } catch { /* gone */ } },
  };
}

const ps = async (args: string[]): Promise<string> => {
  const proc = Bun.spawn(["ps", ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
};

/** CPU of a set of pids in core-units, measured by DIFFERENCE over `SAMPLE_MS`.
 *  The same method `fleet-usage.ts` uses, and for the same reason: `ps pcpu` is
 *  an average over the whole life of a process, so a burner that has just
 *  started reads low and one that has been running reads high forever. */
async function coreUnitsOf(pids: number[]): Promise<number> {
  if (!pids.length) return 0;
  const read = async (): Promise<Map<number, number>> => {
    const out = await ps(["-o", "pid=,time=", "-p", pids.join(",")]);
    const m = new Map<number, number>();
    for (const line of out.split("\n")) {
      const hit = line.trim().match(/^(\d+)\s+(\S+)$/);
      if (hit) m.set(Number(hit[1]), parseCpuTimeSeconds(hit[2]!));
    }
    return m;
  };
  const before = await read();
  const at = Date.now();
  await Bun.sleep(SAMPLE_MS);
  const after = await read();
  const dt = (Date.now() - at) / 1000;
  let total = 0;
  for (const [pid, secs] of after) total += Math.max(0, secs - (before.get(pid) ?? secs));
  return total / dt;
}

/** `ps -o stat` for one pid: `T` is a stopped process, and that is the whole
 *  point of the freeze half of this probe. */
async function stateOf(pid: number): Promise<string> {
  const out = await ps(["-o", "stat=", "-p", String(pid)]);
  return out.trim().split(/\s+/)[0] ?? "";
}

const sample = (used: number, running: number): MachineBudgetSample => ({
  cores: CORES,
  totalMemGB: 32,
  ourCoreUnits: used,
  // The burner IS ours in this bench: nobody else is being simulated, and a
  // machine measured as busy by others would shrink the budget under the very
  // arithmetic the probe is checking.
  otherCoreUnits: 0,
  ourMemGB: 1,
  availableMemGB: 20,
  running,
});

async function main(): Promise<void> {
  const noBudget = process.argv.includes("--no-budget");
  const cost = estimatedAgentCost([1, 1, 1]);
  console.log(`macchina: ${CORES} core, costo stimato di un agente ${cost.toFixed(1)} core-unita'`);

  const burners = Array.from({ length: BURNERS }, () => burner());
  try {
    const measured = await coreUnitsOf(burners.map((b) => b.pid));
    // The budget: what the burner is taking, plus room for exactly one agent.
    // With it, admitting one is right and admitting two is not, whatever the
    // machine was doing when the burner started.
    const budgetCoreUnits = measured + cost * 1.5;
    const share = budgetCoreUnits / CORES;
    console.log(
      `bruciatore acceso: ${measured.toFixed(1)} core-unita' misurate su ${BURNERS} processi; ` +
      `budget ${budgetCoreUnits.toFixed(1)} core-unita' = ${Math.round(share * 100)}% del PC`,
    );
    check(measured > 0.5, `la misura vede il bruciatore (${measured.toFixed(1)} core-unita')`);

    // THE QUEUE: three cards, ten ticks, one measure that grows with what has
    // been admitted (an agent that starts costs, and the next tick sees it).
    let state: BudgetGateState = "admitting";
    let started = 0;
    let firstTickStarts = 0;
    for (let tick = 0; tick < 3 && started < 3; tick++) {
      const used = measured + started * cost;
      if (noBudget) {
        // The control arm: no budget, no ramp. This is what the evening of
        // 2026-09-07 did, and it is here so the probe can show both.
        const before = started;
        started = 3;
        if (tick === 0) firstTickStarts = 3 - before;
        break;
      }
      const v = admissionVerdict(sample(used, started), share, cost, state);
      state = v.state;
      if (v.admit) { started++; if (tick === 0) firstTickStarts++; }
    }
    check(
      noBudget ? firstTickStarts === 3 : firstTickStarts === 1,
      noBudget
        ? `senza budget partono tutte e tre nello stesso tick (${firstTickStarts})`
        : `col budget parte UNA card per tick (${firstTickStarts}), le altre aspettano`,
    );
    if (!noBudget) {
      check(started === 1, `con il bruciatore vivo ne parte una sola (${started} su 3), le altre restano in coda`);
    }

    // THE FREEZE: two fake check runners, and a burner that goes over the top.
    const checks = [fakeCheck(), fakeCheck()];
    try {
      // The same burner, against half the budget: the state the governor exists
      // for, without asking the machine for cores it may not have to give.
      const tightBudget = budgetCoreUnits / 2;
      const targets = checks.map((c, i) => ({ id: `check-${i}`, kind: "check" as const, startedAt: 1000 + i, pid: c.pid }));
      let freezeState: FreezeState = EMPTY_FREEZE_STATE;
      const over = measured;
      console.log(`uso ${over.toFixed(1)} core-unita' contro un budget stretto a ${tightBudget.toFixed(1)}`);

      let frozenPid = 0;
      for (let i = 0; i < 2; i++) {
        const plan = freezePlan({ used: over, budget: tightBudget, targets }, freezeState);
        freezeState = plan.state;
        if (plan.freeze) {
          const victim = targets.find((t) => t.id === plan.freeze)!;
          frozenPid = victim.pid;
          try { process.kill(-victim.pid, "SIGSTOP"); } catch { /* gone */ }
        }
      }
      check(frozenPid !== 0, "sopra il budget, dopo due letture, un check viene congelato");
      const stopped = frozenPid ? await stateOf(frozenPid) : "";
      check(stopped.startsWith("T"), `il processo congelato e' fermo davvero (ps stat = "${stopped}")`);
      const other = targets.find((t) => t.pid !== frozenPid);
      const otherState = other ? await stateOf(other.pid) : "";
      check(!otherState.startsWith("T"), `l'altro check resta vivo (ps stat = "${otherState}")`);

      // The burner dies: two readings under 70% of the budget and it is
      // continued, which is the half nobody would notice if it were missing.
      for (const b of burners) b.stop();
      let thawed = "";
      for (let i = 0; i < 2; i++) {
        const plan = freezePlan({ used: 0, budget: tightBudget, targets }, freezeState);
        freezeState = plan.state;
        if (plan.thaw) {
          const victim = targets.find((t) => t.id === plan.thaw)!;
          try { process.kill(-victim.pid, "SIGCONT"); } catch { /* gone */ }
          thawed = await stateOf(victim.pid);
        }
      }
      check(thawed !== "" && !thawed.startsWith("T"), `sceso il carico il check riparte da solo (ps stat = "${thawed}")`);
    } finally {
      for (const c of checks) { try { process.kill(-c.pid, "SIGCONT"); } catch { /* gone */ } c.stop(); }
    }
  } finally {
    for (const b of burners) b.stop();
  }

  console.log(failures === 0 ? "\nbanco verde" : `\n${failures} attese non rispettate`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
