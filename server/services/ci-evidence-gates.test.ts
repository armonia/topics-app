/**
 * The gates row reads the three static-check steps from the pull-request CI.
 * @covers KANBAN-84
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GATES_CI_CHECK } from "../../shared/board";
import {
  awaitCiEvidence,
  ciCheckRun,
  GATES_JOB,
  GATES_STEPS,
  readCiEvidence,
} from "./ci-evidence";
import { SHA, checkJob, fakeClock, fakePort, input, job, run, step } from "./ci-evidence.testkit";

describe("readGatesEvidence", () => {
  const gateStepNames = Object.values(GATES_STEPS);
  const greenGate = () => job(GATES_JOB, "success", {
    steps: gateStepNames.map((name) => step(name, "success")),
  });

  test("any red typecheck, lint or static guard-rail step fails the row", () => {
    for (const failedName of gateStepNames) {
      const gate = job(GATES_JOB, "failure", {
        steps: gateStepNames.map((name) => step(name, name === failedName ? "failure" : "success")),
      });
      const outcome = readCiEvidence(GATES_CI_CHECK, SHA, [run({ conclusion: "failure" })], [gate]);

      expect(outcome.kind).toBe("fail");
      if (outcome.kind !== "fail") continue;
      const row = ciCheckRun(GATES_CI_CHECK, outcome, 1, { repo: "o/r" });
      expect(row.ok).toBe(false);
      expect(row.code).toBe(1);
      expect(row.tail).toContain(`${failedName} failure`);
    }
  });

  test("a green gates job passes, while an active gates job stays pending", async () => {
    expect(readCiEvidence(GATES_CI_CHECK, SHA, [run()], [greenGate()]).kind).toBe("pass");
    const activeGate = job(GATES_JOB, null, {
      steps: gateStepNames.map((name, index) => step(name, index === 0 ? "failure" : null)),
    });
    expect(readCiEvidence(GATES_CI_CHECK, SHA, [run({ status: "in_progress", conclusion: null })], [activeGate]).kind).toBe("pending");

    let reads = 0;
    const { port } = fakePort({
      jobs: async () => ({ ok: true, value: [reads++ === 0 ? activeGate : greenGate()] }),
    });
    const clock = fakeClock();
    const rows = await awaitCiEvidence({ ...input, checks: [GATES_CI_CHECK] }, {
      port, now: clock.now, sleep: clock.sleep, stopping: () => false,
    });
    expect(rows.map((row) => row.ok)).toEqual([true]);
    expect(reads).toBe(2);
  });

  test("a completed run without the gates job is not measured, never green", () => {
    const outcome = readCiEvidence(GATES_CI_CHECK, SHA, [run()], [checkJob("success")]);
    expect(outcome.kind).toBe("notMeasured");
    if (outcome.kind !== "notMeasured") return;
    expect(outcome.reason).toContain("without the gates job");
    expect(ciCheckRun(GATES_CI_CHECK, outcome, 1).code).toBe(97);
  });

  test("ci.yml still uses the exact steps read from its gates job", () => {
    const ci = readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8");
    const start = ci.search(/^ {2}gates:$/m);
    const end = ci.search(/^ {2}check:$/m);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const gates = ci.slice(start, end);
    const workflowSteps = [...gates.matchAll(/^ {6}- name: (.+)$/gm)].map((match) => match[1]);
    for (const name of gateStepNames) expect(workflowSteps).toContain(name);
  });
});
