/**
 * No job of ci.yml waits for another one unless it reads its result, and the
 * small `check` job still turns every result into the run's verdict.
 *
 * WHY THIS TEST EXISTS. The measuring job was `check`, with `needs: unit`,
 * although only its last step read `needs.unit.result`: typecheck, lint, the
 * guard rails and the budgets measure the checkout and nothing the unit jobs
 * produce. So it started when the unit suite ended, and on 27 green runs the
 * run ended 6.7 min (push) and 2.6 min (pull request) after every other job.
 * The measurements now run in `gates` from the first second, and `check` holds
 * the two verdicts. The step the board reads (UNIT_JOB / UNIT_STEP) keeps its
 * job and its name.
 *
 * The verdict steps are RUN under bash with every result GitHub can hand them,
 * because a regex on a body does not say what the body does with the result.
 *
 * Text scan and not a YAML parse, like the other tests that read ci.yml.
 * @covers GATE-12
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UNIT_JOB, UNIT_STEP } from "../../server/services/ci-evidence";

const CI = readFileSync(join(import.meta.dir, "../..", ".github/workflows/ci.yml"), "utf8");

/** The body of one job, from its `  name:` line to the next job. */
function jobBody(name: string): string {
  const from = CI.search(new RegExp(`^ {2}${name}:$`, "m"));
  if (from < 0) throw new Error(`job ${name} not found in ci.yml`);
  const rest = CI.slice(from + 1);
  const next = rest.search(/^ {2}[\w-]+:$/m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

const jobNames = [...CI.slice(CI.search(/^jobs:$/m)).matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]!);

/** The `needs:` of a job as a list, empty when it has none. */
function needsOf(name: string): string[] {
  const line = jobBody(name).match(/^ {4}needs: (.+)$/m)?.[1];
  if (!line) return [];
  return line.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
}

type Step = { name: string; body: string };

function stepsOf(name: string): Step[] {
  const lines = jobBody(name).split("\n").filter((l) => !/^\s*#/.test(l));
  const out: Step[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {6}- name: (.+)$/.exec(lines[i]!);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !/^ {6}- /.test(lines[j]!)) j++;
    out.push({ name: m[1]!.trim(), body: lines.slice(i, j).join("\n") });
  }
  return out;
}

/** Run the `run: |` block of a step with `env`, as the runner's bash would. */
function runStep(step: Step, env: Record<string, string>): number {
  const lines = step.body.split("\n");
  const at = lines.findIndex((l) => /^\s*run: \|\s*$/.test(l));
  if (at < 0) throw new Error(`step ${step.name} has no run: block`);
  const body = lines.slice(at + 1);
  const indent = body.find((l) => l.trim().length > 0)?.match(/^\s*/)?.[0] ?? "";
  const script = body.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join("\n");
  const run = spawnSync("bash", ["-e", "-c", script], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
  return run.status ?? -1;
}

const RESULTS = ["success", "failure", "cancelled", "skipped"] as const;

describe("ci.yml: a job waits only for the jobs whose result it reads", () => {
  it("every `needs:` of every job is read by that job as `needs.<job>`", () => {
    const idle: string[] = [];
    for (const job of jobNames) {
      for (const need of needsOf(job)) {
        if (!jobBody(job).includes(`needs.${need}.`)) idle.push(`${job} needs ${need} and never reads it`);
      }
    }
    expect(idle).toEqual([]);
  });

  it("the measuring job starts with the run: it needs nothing", () => {
    expect(needsOf("gates")).toEqual([]);
    expect(stepsOf("gates").length).toBeGreaterThanOrEqual(10);
  });

  it(`the board's job \`${UNIT_JOB}\` needs the unit jobs and the gates, and runs even when they are red`, () => {
    expect(needsOf(UNIT_JOB).sort()).toEqual(["gates", "unit"]);
    expect(jobBody(UNIT_JOB)).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) \}\}$/m);
  });

  it(`\`${UNIT_JOB}\` runs nothing: no checkout, no install, only verdicts`, () => {
    expect(jobBody(UNIT_JOB)).not.toMatch(/^\s+(- )?uses: /m);
    expect(stepsOf(UNIT_JOB)).toHaveLength(2);
    expect(stepsOf(UNIT_JOB)[0]?.name).toBe(UNIT_STEP);
  });

  it("the gates verdict runs even when the unit verdict is red", () => {
    const [, gates] = stepsOf(UNIT_JOB);
    expect(gates?.body).toMatch(/^ {8}if: \$\{\{ !cancelled\(\) \}\}$/m);
  });

  for (const unit of RESULTS) {
    it(`EXECUTED: the unit step with the unit jobs ${unit} exits ${unit === "success" ? 0 : 1}`, () => {
      const step = stepsOf(UNIT_JOB).find((s) => s.name === UNIT_STEP)!;
      expect(step.body).toContain("UNIT_RESULT: ${{ needs.unit.result }}");
      expect(runStep(step, { UNIT_RESULT: unit })).toBe(unit === "success" ? 0 : 1);
    });
  }

  for (const gates of RESULTS) {
    it(`EXECUTED: the gates step with the gates job ${gates} exits ${gates === "success" ? 0 : 1}`, () => {
      const step = stepsOf(UNIT_JOB)[1]!;
      expect(step.body).toContain("GATES_RESULT: ${{ needs.gates.result }}");
      expect(runStep(step, { GATES_RESULT: gates })).toBe(gates === "success" ? 0 : 1);
    });
  }
});
