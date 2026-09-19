/**
 * What the wait loop CONCLUDES: the rerun of a run that ended with nothing to
 * say, the stop at the first red, the delivery with nothing of its own, and the
 * rule that a card never calls itself green on a commit whose CI is red.
 *
 * @covers KANBAN-93
 * @covers KANBAN-86
 */
import { describe, expect, test } from "bun:test";
import { E2E_CI_CHECK, UNIT_CI_CHECK } from "../../shared/board";
import { CI_E2E_DEADLINE_MS, awaitCiEvidence, runRedElsewhere, UNIT_JOB, UNIT_STEP, type GithubJob } from "./ci-evidence";
import { checkJob, e2eRow, fakeClock, fakePort, green, input, job, run, step } from "./ci-evidence.testkit";

/**
 * A run that ENDED without a verdict is a dead end: the same commit reads the
 * same dead run forever (15 of the last 100 shas measured on 17/09/2026 were
 * already there). One rerun, and if that is refused the row says what unblocks
 * it. @covers KANBAN-93
 */
describe("a terminal run without a verdict", () => {
  test("is re-run once, and the new attempt gives the verdict", async () => {
    let attempt = 1;
    const { port, calls } = fakePort({
      runs: async () => ({ ok: true, value: [run(attempt === 1 ? { conclusion: "cancelled" } : { run_attempt: 2 })] }),
      rerun: async () => { attempt = 2; return { ok: true, value: undefined }; },
    });
    const row = await e2eRow(input, { port, ...fakeClock(), stopping: () => false });
    expect(calls.rerun).toEqual([10]);
    expect(row.ok).toBe(true);
  });

  test("that cannot be re-run says a new commit is needed, and is asked only once", async () => {
    const { port, calls } = fakePort({
      runs: async () => ({ ok: true, value: [run({ conclusion: "cancelled" })] }),
      rerun: async () => ({ ok: false, error: "gh: run not rerunnable" }),
    });
    const row = await e2eRow(input, { port, ...fakeClock(), stopping: () => false });
    expect(row.notMeasured).toBe(true);
    expect(row.tail).toContain("not rerunnable");
    expect(row.tail).toContain("only a new commit can");
    expect(calls.rerun.length).toBe(1);
  });

  test("re-run once and still mute says so, instead of another silent hour", async () => {
    const { port, calls } = fakePort({ runs: async () => ({ ok: true, value: [run({ conclusion: "cancelled" })] }) });
    const row = await e2eRow(input, { port, ...fakeClock(), stopping: () => false });
    expect(calls.rerun.length).toBe(1);
    expect(row.notMeasured).toBe(true);
    expect(row.tail).toContain("re-run once");
    expect(row.tail).toContain("only a new commit can");
    // The grace given to an unobserved rerun is counted in reads, not in the
    // whole hour of the deadline: an attempt that never shows up still answers.
    expect(row.ms).toBeLessThan(CI_E2E_DEADLINE_MS);
  });

  /**
   * The rerun is spent once per RUN, and `run_attempt` is the only place that
   * survives a restart: `rerunTried` is a local of the call, while the delivery
   * is a `pending_deliveries` row re-issued on the same commit at every boot (44
   * restarts in 25.7 hours against a CI wait of 15-25 minutes).
   */
  test("a run already at its second attempt is not re-run again after a restart", async () => {
    const { port, calls } = fakePort({
      runs: async () => ({ ok: true, value: [run({ conclusion: "cancelled", run_attempt: 2 })] }),
    });
    const row = await e2eRow(input, { port, ...fakeClock(), stopping: () => false });
    expect(calls.rerun).toEqual([]);
    expect(row.notMeasured).toBe(true);
    expect(row.tail).toContain("only a new commit can");
  });

  /**
   * `gh run rerun` exits 0 when GitHub accepts the request, not when the new
   * attempt is listed: the read right after it can still be the dead one, and it
   * used to close the round with "only a new commit can" while the attempt that
   * would go green was already running.
   */
  test("a read that still shows the old attempt is not the verdict of the re-run", async () => {
    let reads = 0;
    const { port, calls } = fakePort({
      runs: async () => {
        reads += 1;
        return { ok: true, value: [reads <= 3 ? run({ conclusion: "cancelled" }) : run({ run_attempt: 2 })] };
      },
    });
    const row = await e2eRow(input, { port, ...fakeClock(), stopping: () => false });
    expect(calls.rerun).toEqual([10]);
    expect(row.ok).toBe(true);
    expect(row.tail).not.toContain("only a new commit can");
  });

  /**
   * The third terminal case of KANBAN-93: a run that COMPLETES without the job
   * or the step a row reads. The row falls to NOT MEASURED while the run is
   * still going, and closing it there left nothing open when the run completed,
   * so the rerun never fired and the card got the dead end with no way out.
   */
  test("a row closed while the run was still going is re-opened by the new attempt", async () => {
    let reads = 0;
    const lost = [job("prepare-e2e", "failure"), ...[1, 2, 3, 4].map((n) => job(`e2e (${n})`, "skipped"))];
    const { port, calls } = fakePort({
      runs: async () => {
        reads += 1;
        if (reads === 1) return { ok: true, value: [run({ status: "in_progress", conclusion: null })] };
        return { ok: true, value: [reads === 2 ? run({ conclusion: "failure" }) : run({ run_attempt: 2 })] };
      },
      jobs: async () => ({
        ok: true,
        value: reads === 1
          ? [checkJob(null), ...lost]
          : reads === 2
            ? [checkJob("success", { status: "completed", conclusion: "success" }), ...lost]
            : [checkJob("success", { status: "completed", conclusion: "success" }), ...green],
      }),
    });
    const clock = fakeClock();
    const rows = await awaitCiEvidence({ ...input, checks: [E2E_CI_CHECK, UNIT_CI_CHECK] },
      { port, now: clock.now, sleep: clock.sleep, stopping: () => false });
    expect(calls.rerun).toEqual([10]);
    expect(rows.map((r) => r.ok)).toEqual([true, true]);
    expect(rows[0]!.tail).not.toContain("only a new commit can");
  });

  /**
   * With one row declared, the same row is also the last one open: closing it
   * on the spot ended the whole wait before the run could complete, so the
   * rerun never got its turn. A row with no verdict is not final while its run
   * is still going.
   */
  test("the only row, closed with no verdict while the run goes on, still waits for the rerun", async () => {
    let reads = 0;
    const lost = [job("prepare-e2e", "failure"), ...[1, 2, 3, 4].map((n) => job(`e2e (${n})`, "skipped"))];
    const { port, calls } = fakePort({
      runs: async () => {
        reads += 1;
        if (reads === 1) return { ok: true, value: [run({ status: "in_progress", conclusion: null })] };
        return { ok: true, value: [reads === 2 ? run({ conclusion: "failure" }) : run({ run_attempt: 2 })] };
      },
      jobs: async () => ({ ok: true, value: reads <= 2 ? lost : green }),
    });
    const clock = fakeClock();
    const row = await e2eRow(input, { port, now: clock.now, sleep: clock.sleep, stopping: () => false });
    expect(calls.rerun).toEqual([10]);
    expect(row.ok).toBe(true);
  });

  /**
   * The guard that keeps that rerun from cutting a run that is still measuring:
   * one row already has no verdict, and the other is waiting for a step of the
   * same run. Only `run.status === "completed"` holds it here.
   */
  test("a run still going is not re-run because one row already has no verdict", async () => {
    const { port, calls } = fakePort({
      runs: async () => ({ ok: true, value: [run({ status: "in_progress", conclusion: null })] }),
      jobs: async () => ({ ok: true, value: [checkJob(null), job("prepare-e2e", "failure"), ...[1, 2, 3, 4].map((n) => job(`e2e (${n})`, "skipped"))] }),
    });
    const clock = fakeClock();
    const rows = await awaitCiEvidence({ ...input, checks: [E2E_CI_CHECK, UNIT_CI_CHECK] },
      { port, now: clock.now, sleep: clock.sleep, stopping: () => false });
    expect(calls.rerun).toEqual([]);
    expect(rows.map((r) => r.notMeasured)).toEqual([true, true]);
  });

  /**
   * A RED ALREADY MEASURED IS NOT RE-RUN, and this is the one that turns a red
   * card green. The rerun fires for a run that ended with nothing to say; its
   * `continue` jumps over the loop that closes the rows, so a red read on the
   * first attempt is thrown away and a green second attempt answers in its
   * place. Reachable as it stands: the `check` job dies before its unit step
   * (Setup Bun, typecheck, `cancel-in-progress`) while an e2e shard fails for
   * real.
   */
  test("a red row next to one with no verdict is not re-run, and the red is the answer", async () => {
    let reads = 0;
    const redShard = green.map((j) => (j.name === "e2e (2)" ? { ...j, id: 777, conclusion: "failure" } : j));
    const died: GithubJob = { id: 4242, name: "check", status: "completed", conclusion: "failure", steps: [step("Setup Bun", "failure")] };
    const { port, calls } = fakePort({
      runs: async () => {
        reads += 1;
        return { ok: true, value: [reads <= 1 ? run({ conclusion: "failure" }) : run({ run_attempt: 2 })] };
      },
      // The second attempt would be all green: the round must never see it.
      jobs: async () => ({
        ok: true,
        value: reads <= 1 ? [died, ...redShard] : [checkJob("success", { status: "completed", conclusion: "success" }), ...green],
      }),
    });
    const rows = await awaitCiEvidence({ ...input, checks: [E2E_CI_CHECK, UNIT_CI_CHECK] },
      { port, ...fakeClock(), stopping: () => false });
    expect(calls.rerun).toEqual([]);
    expect(rows[0]!.ok).toBe(false);
    expect(rows[0]!.notMeasured).toBeUndefined();
    expect(rows[0]!.code).toBe(1);
    expect(rows[0]!.tail).toContain("e2e (2)");
    expect(rows[1]!.notMeasured).toBe(true);
  });

  /**
   * The sentence that says a new commit is needed is added when a row is CLOSED,
   * and a row closed on an earlier poll — while the run was still going — was
   * never read again once the rerun turned out to be spent (attempt already
   * above 1: our own rerun from a previous process, since the delivery is
   * re-issued at every boot). The round ended on the plain reason, which is the
   * mute dead end KANBAN-93 exists to remove, and it ended THERE, not an hour later.
   */
  test("a row closed while the run went on still says a new commit is needed when the rerun is spent", async () => {
    let reads = 0;
    const lost = [job("prepare-e2e", "failure"), ...[1, 2, 3, 4].map((n) => job(`e2e (${n})`, "skipped"))];
    const { port, calls } = fakePort({
      runs: async () => {
        reads += 1;
        return {
          ok: true,
          value: [reads === 1 ? run({ status: "in_progress", conclusion: null, run_attempt: 2 }) : run({ conclusion: "failure", run_attempt: 2 })],
        };
      },
      jobs: async () => ({ ok: true, value: lost }),
    });
    const clock = fakeClock();
    const start = clock.now();
    const row = await e2eRow(input, { port, now: clock.now, sleep: clock.sleep, stopping: () => false });
    expect(calls.rerun).toEqual([]);
    expect(row.notMeasured).toBe(true);
    expect(row.tail).toContain("only a new commit can");
    // The wait for a possible rerun is bounded by the run, not by the deadline.
    expect(clock.now() - start).toBeLessThan(CI_E2E_DEADLINE_MS);
  });

  test("a run still in progress for the other row is never re-run under it", async () => {
    const clock = fakeClock();
    const { port, calls } = fakePort({
      runs: async () => ({ ok: true, value: [run({ status: "in_progress", conclusion: null })] }),
      // The unit step is cut short while the e2e shards still run: the e2e row
      // has everything to wait for, and a rerun would kill it.
      jobs: async () => ({ ok: true, value: [checkJob("cancelled"), job("prepare-e2e", "success"), job("e2e (1)", null)] }),
    });
    const rows = await awaitCiEvidence({ ...input, checks: [E2E_CI_CHECK, UNIT_CI_CHECK] }, { port, now: clock.now, sleep: clock.sleep, stopping: () => false });
    expect(calls.rerun.length).toBe(0);
    expect(rows.map((r) => r.notMeasured)).toEqual([true, true]);
    expect(rows[1]!.tail).not.toContain("only a new commit can");
  });
});

describe("the round stops at the first red, like the local commands", () => {
  test("a red unit row ends the wait, and the e2e row is NOT MEASURED naming it", async () => {
    const clock = fakeClock();
    const start = clock.now();
    const { port } = fakePort({
      runs: async () => ({ ok: true, value: [run({ status: "in_progress", conclusion: null })] }),
      jobs: async () => ({ ok: true, value: [checkJob("failure", { status: "completed", conclusion: "failure" }), job("prepare-e2e", "success"), job("e2e (1)", null)] }),
    });
    const rows = await awaitCiEvidence({ ...input, checks: [E2E_CI_CHECK, UNIT_CI_CHECK] }, { port, now: clock.now, sleep: clock.sleep, stopping: () => false });
    expect(rows[1]!.ok).toBe(false);
    expect(rows[1]!.notMeasured).toBeUndefined();
    expect(rows[0]!.notMeasured).toBe(true);
    expect(rows[0]!.tail).toContain(UNIT_CI_CHECK.name);
    // The red was actionable at the first poll: it used to arrive an hour later.
    expect(clock.now() - start).toBeLessThan(5 * 60_000);
  });
});

/**
 * NOT MEASURED, and the reason names the way out a PERSON takes first. Weighed
 * again on 17/09/2026: three real cards of that night had this shape (work
 * already in main, nothing to land) and this verdict bounces them back to their
 * agent. Kept, because from here the shape is the same as a commit made on the
 * wrong branch or a branch a rebase emptied, and two greens on an input where
 * nothing was measured is the lie these rows exist not to tell.
 */
describe("a delivery with nothing of its own beyond main", () => {
  test("is NOT MEASURED, nothing is pushed or opened, and both exits are named", async () => {
    const { port, calls } = fakePort({ ownCommits: async () => ({ ok: true, value: 0 }) });
    const rows = await awaitCiEvidence({ ...input, checks: [E2E_CI_CHECK, UNIT_CI_CHECK] }, { port, ...fakeClock(), stopping: () => false });
    expect(rows.map((r) => [r.ok, r.code, r.notMeasured])).toEqual([[false, 97, true], [false, 97, true]]);
    expect(rows[0]!.tail).toContain("no commit of its own");
    // The exit an agent cannot take is not the only one on offer any more: a
    // card whose work is already merged has no new commit to make.
    expect(rows[0]!.tail).toContain("already in main");
    expect(rows[0]!.tail).toContain("a person closes it");
    expect(rows[0]!.tail).toContain("only a new commit can");
    expect(calls.push.length).toBe(0);
    expect(calls.pr).toBe(0);
  });
});

/**
 * KANBAN-86. The rows read a SLICE of the proof, which is the right slice for
 * what they measure; the card then writes a sentence wider than what they know.
 * Measured on 17/09/2026 on two of the three real deliveries of that night
 * (`topics/clumsy-wren` run 35168540957, `topics/imperial-canal` run 35169547221):
 * `checks_state = 'pass'` and a green chip while the run of their own pull
 * request was `completed/failure` at the step "Bundle size budget" of `check`.
 * @covers KANBAN-86
 */
describe("a card does not call itself green on a commit whose CI run is red", () => {
  const BUDGET = "Bundle size budget";
  const budgetRed: GithubJob = {
    id: 4242, name: "check", status: "completed", conclusion: "failure",
    steps: [step("Setup Bun", "success"), step(UNIT_STEP, "success"), step(BUDGET, "failure")],
  };

  test("the unit step green, the shards green, the check job red at a later step: no row closes green", async () => {
    const { port } = fakePort({
      runs: async () => ({ ok: true, value: [run({ conclusion: "failure" })] }),
      jobs: async () => ({ ok: true, value: [budgetRed, ...green] }),
    });
    const rows = await awaitCiEvidence({ ...input, checks: [E2E_CI_CHECK, UNIT_CI_CHECK] }, { port, ...fakeClock(), stopping: () => false });
    expect(rows.map((r) => r.ok)).toEqual([false, false]);
    // A real red, not a NOT MEASURED: the run said `failure` and named where.
    expect(rows.map((r) => r.notMeasured)).toEqual([undefined, undefined]);
    // And the exit code moves with `ok`. Left at 0 the row is red and labelled
    // "exit 0" in the drawer, which reads as a gate that passed and stopped
    // anyway - a second small lie inside the row that exists to stop one.
    expect(rows.map((r) => r.code)).toEqual([1, 1]);
    for (const row of rows) {
      expect(row.ciRunRed).toContain(BUDGET);
      expect(row.tail).toContain("job check");
      expect(row.tail).toContain("actions/runs/10");
    }
    // Each row still says, word for word, what it did measure.
    expect(rows[0]!.tail).toContain("e2e green on the pull request CI");
    expect(rows[1]!.tail).toContain(`step "${UNIT_STEP}" of job ${UNIT_JOB}: success`);
  });

  /**
   * THE ANSWER IS IN `jobs` BEFORE IT IS IN `run`. The all-green close does not
   * wait for the run: it fires when the last declared row has a verdict, and
   * reading `run.conclusion` there asks a field that is still null. Probed on
   * 17/09/2026 against the guard that only read the run: `check` already
   * `completed/failure` at "Bundle size budget", unit step green, four shards
   * green, one job of the run still alive, run `in_progress` gave
   * `rows.ok = [true, true]` and `ciRunRed = [null, null]`. The likelier shape
   * is the same close with every job finished and the run not yet flipped
   * between the `runs()` and the `jobs()` of the same poll.
   */
  test("the check job already red while the run still says in_progress is enough: no row closes green", async () => {
    const { port } = fakePort({
      runs: async () => ({ ok: true, value: [run({ status: "in_progress", conclusion: null })] }),
      // One job of the run is still alive, and it is none of the five the rows read.
      jobs: async () => ({ ok: true, value: [budgetRed, ...green, job("tauri (macos-latest)", null)] }),
    });
    const rows = await awaitCiEvidence({ ...input, checks: [E2E_CI_CHECK, UNIT_CI_CHECK] }, { port, ...fakeClock(), stopping: () => false });
    expect(rows.map((r) => r.ok)).toEqual([false, false]);
    for (const row of rows) expect(row.ciRunRed).toContain(BUDGET);
  });

  test("the same run concluded success closes green, and no row carries the note", async () => {
    const { port } = fakePort({ jobs: async () => ({ ok: true, value: [checkJob("success", { status: "completed", conclusion: "success" }), ...green] }) });
    const rows = await awaitCiEvidence({ ...input, checks: [E2E_CI_CHECK, UNIT_CI_CHECK] }, { port, ...fakeClock(), stopping: () => false });
    expect(rows.map((r) => r.ok)).toEqual([true, true]);
    expect(rows.map((r) => r.ciRunRed)).toEqual([undefined, undefined]);
  });

  test("the reader names the failing job and step, and says nothing while the run is still going and whole", () => {
    // A run still going with nothing red in it yet is not an accusation.
    expect(runRedElsewhere(run({ status: "in_progress", conclusion: null }), green)).toBeNull();
    expect(runRedElsewhere(run(), green)).toBeNull();
    expect(runRedElsewhere(null, [])).toBeNull();
    // Still going, and one job of it already red: that IS the answer.
    const early = runRedElsewhere(run({ status: "in_progress", conclusion: null }), [budgetRed, ...green]);
    expect(early).toContain("already red while it is still going");
    expect(early).toContain(`job check at the step "${BUDGET}"`);
    const why = runRedElsewhere(run({ conclusion: "failure" }), [budgetRed, ...green]);
    expect(why).toContain("concluded failure");
    expect(why).toContain(`job check at the step "${BUDGET}"`);
    // A skipped job is not where a run broke, and a run red with no job to blame
    // still says it is red instead of claiming a step it cannot see.
    const mute = runRedElsewhere(run({ conclusion: "failure" }), [job("e2e (1)", "skipped")]);
    expect(mute).toContain("concluded failure");
    expect(mute).not.toContain("e2e (1)");
    // A run that concluded success is trusted over a stray job conclusion:
    // GitHub computed it over every job, `continue-on-error` included.
    expect(runRedElsewhere(run(), [budgetRed, ...green])).toBeNull();
  });
});
