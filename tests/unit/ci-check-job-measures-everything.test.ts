/**
 * The `check` job must run EVERY measurement, even when one of them is red.
 *
 * WHY THIS TEST EXISTS. Until 2026-08-21 the job was 23 steps in a row with no
 * conditions, and `Unit + integration tests` was the fifteenth. Any red gate
 * before it aborted the job, so the unit suite and all eight performance
 * budgets never ran at all. Measured: CI red from 2026-08-16 15:40, 27 runs and
 * a single green one, and through that whole window nothing downstream was
 * measured. On those steps "green" meant "not executed", which is how a test
 * that only failed on Linux stayed invisible for days.
 *
 * The invariant, in one line: everything after the setup block carries the
 * guard, and everything inside the setup block does not. Setup must still fail
 * fast, because measuring on a broken install produces fifteen identical reds
 * that bury the one line that matters.
 *
 * This is a text scan and not a YAML parse on purpose: the repo has no YAML
 * dependency, the surrounding tests read this file the same way, and the shape
 * being asserted is exactly the shape a person sees when editing it.
  * @covers E2E-GATE-08
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const CI = join(import.meta.dir, "../..", ".github/workflows/ci.yml");

type Step = { name: string; line: number; body: string };

/** The steps of one job, in order, as they appear in the file. */
function stepsOfJob(job: string): Step[] {
  const lines = readFileSync(CI, "utf8").split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) throw new Error(`job ${job} not found in ci.yml`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[a-z][\w-]*:/.test(lines[i]!)) { end = i; break; }
  }
  const out: Step[] = [];
  for (let i = start; i < end; i++) {
    const m = /^ {6}- name: (.+)$/.exec(lines[i]!);
    if (!m) continue;
    let j = i + 1;
    while (j < end && !/^ {6}- name: /.test(lines[j]!)) j++;
    out.push({ name: m[1]!.trim(), line: i + 1, body: lines.slice(i, j).join("\n") });
  }
  return out;
}

const GUARD = /!cancelled\(\)\s*&&\s*steps\.setup\.outcome == 'success'/;

describe("il job `check` misura tutto anche quando qualcosa e' rosso", () => {
  const steps = stepsOfJob("check");

  it("ha uno step di preparazione marcato `id: setup`", () => {
    const setup = steps.filter((s) => /^\s*id: setup$/m.test(s.body));
    expect(setup.length).toBe(1);
  });

  it("ogni misura DOPO la preparazione porta la guardia", () => {
    const i = steps.findIndex((s) => /^\s*id: setup$/m.test(s.body));
    expect(i).toBeGreaterThanOrEqual(0);
    const senza = steps.slice(i + 1).filter((s) => !GUARD.test(s.body));
    expect(
      senza.map((s) => `ci.yml:${s.line} ${s.name}`),
    ).toEqual([]);
  });

  it("e' una misura vera: ci sono almeno dieci passi protetti", () => {
    // Without this line the test above would stay green on an emptied job,
    // which is an assertion that cannot fail.
    const i = steps.findIndex((s) => /^\s*id: setup$/m.test(s.body));
    expect(steps.slice(i + 1).length).toBeGreaterThanOrEqual(10);
  });

  it("la PREPARAZIONE resta fail-fast: nessuna guardia prima di `setup`", () => {
    const i = steps.findIndex((s) => /^\s*id: setup$/m.test(s.body));
    const armati = steps.slice(0, i).filter((s) => GUARD.test(s.body));
    expect(armati.map((s) => s.name)).toEqual([]);
  });

  it("i passi che avevano gia' una condizione la conservano", () => {
    const conCondizionePropria = steps.filter((s) =>
      /hashFiles\(|github\.event_name/.test(s.body),
    );
    expect(conCondizionePropria.length).toBeGreaterThan(0);
    for (const s of conCondizionePropria) {
      expect(GUARD.test(s.body)).toBe(true);
    }
  });
});
