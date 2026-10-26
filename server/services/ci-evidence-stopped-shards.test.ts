/**
 * The e2e reader on a pull request whose shards stopped themselves because unit
 * or gates was red (scripts/e2e-stop-on-red.sh): the failure of the shards is
 * not the red to look at, and the row has to say which job is.
 * @covers KANBAN-86
 */
import { describe, expect, test } from "bun:test";
import { E2E_CI_CHECK } from "../../shared/board";
import { ciCheckRun, readE2eEvidence } from "./ci-evidence";
import { SHA, checkJob, green, job, run, step } from "./ci-evidence.testkit";

describe("readE2eEvidence with shards stopped by a red unit or gates", () => {
  // On a pull request the shards stop themselves when unit or gates is red
  // (scripts/e2e-stop-on-red.sh): their failure is not the red to look at.
  const stopped = green.map((j) => (j.name.startsWith("e2e (") ? { ...j, conclusion: "failure" } : j));
  const unitRed = job("unit", "failure", { steps: [step("Unit + integration tests (one process per file)", "failure")] });
  const going = run({ status: "in_progress", conclusion: null });

  test("shards stopped by a red unit wait for the check job, so the unit row has its verdict first", () => {
    // `check` needs unit AND gates: it is not even listed while gates runs.
    expect(readE2eEvidence(SHA, [going], [unitRed, job("gates", null), ...stopped]).kind).toBe("pending");
    expect(readE2eEvidence(SHA, [going], [unitRed, job("gates", "success"), checkJob(null), ...stopped]).kind).toBe("pending");
  });

  test("then they are a red that names the job to look at, unit here", () => {
    const done = checkJob("failure", { status: "completed", conclusion: "failure" });
    const out = readE2eEvidence(SHA, [going], [unitRed, job("gates", "success"), done, ...stopped]);
    expect(out.kind).toBe("fail");
    if (out.kind !== "fail") return;
    expect(out.redElsewhere).toContain('job unit at the step "Unit + integration tests (one process per file)" (failure)');
    const row = ciCheckRun(E2E_CI_CHECK, out, 1, { repo: "o/r" });
    expect(row.ok).toBe(false);
    expect(row.ciRunRed).toContain("job unit");
    expect(row.tail).toContain("look there first");
    // A run that is over does not wait for a `check` it will never list.
    const over = readE2eEvidence(SHA, [run({ conclusion: "failure" })], [unitRed, ...stopped]);
    expect(over.kind === "fail" && over.redElsewhere).toContain("job unit");
  });

  test("a red shard with unit and gates green is a plain e2e red, with no pointer", () => {
    const jobs = [job("unit", "success"), job("gates", "success"), ...green.map((j) => (j.name === "e2e (2)" ? { ...j, conclusion: "failure" } : j))];
    const out = readE2eEvidence(SHA, [going], jobs);
    expect(out.kind).toBe("fail");
    if (out.kind !== "fail") return;
    expect(out.redElsewhere).toBeUndefined();
    expect(ciCheckRun(E2E_CI_CHECK, out, 1).ciRunRed).toBeUndefined();
  });
});
