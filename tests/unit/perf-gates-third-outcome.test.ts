/**
 * "I DID NOT MEASURE" IS A THIRD OUTCOME, and it must survive in the shape of
 * the files, not in someone's memory.
 *
 * WHY THIS TEST EXISTS. On 2026-08-27 the job `check` was red in 3 of the 7
 * finished runs GitHub still kept, for three DIFFERENT reasons, and only one of
 * them was a performance budget: run 33027396174 died on "Click-to-ink budget"
 * with no ink number anywhere in the log. The bench had not measured, and the
 * gate had no way to say so: it either passed or accused. A gate that goes
 * non-zero for a reason nobody can act on is the gate somebody comments out
 * within a month.
 *
 * TWO HALVES, and neither is worth anything alone:
 *  · the SCRIPT has to be able to answer 2 ("no number, no verdict");
 *  · the CI STEP has to turn that 2 into an annotated warning, not into a
 *    silent green. A `|| test $? -eq 2` is a green identical to the green of a
 *    measurement that went well, which is how a real regression lived behind a
 *    tick on 2026-08-21.
 *
 * Text scan and not a YAML parse, on purpose: the repo has no YAML dependency,
 * the neighbouring CI tests read the file exactly this way, and the shape being
 * asserted is the shape a person sees when editing it.
 * @covers GATE-04
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");
const CI = join(ROOT, ".github/workflows/ci.yml");
const SPEC = join(ROOT, "performance/spec.md");

/** The five TIME budgets: they measure a machine, so they can fail to measure. */
const ABSTAINING_GATES = [
  "check:route-latency",
  "check:ink",
  "check:scroll-fluidity",
  "check:drag",
  "check:growth",
] as const;

/** The step of the `check` job that runs this script, body included. */
function stepRunning(script: string): string {
  const lines = readFileSync(CI, "utf8").split("\n");
  const start = lines.findIndex((l) => l === "  check:");
  if (start < 0) throw new Error("job check not found in ci.yml");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[a-z][\w-]*:/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const bodies: string[] = [];
  for (let i = start; i < end; i++) {
    if (!/^ {6}- name: /.test(lines[i]!)) continue;
    let j = i + 1;
    while (j < end && !/^ {6}- name: /.test(lines[j]!)) j++;
    const body = lines.slice(i, j).join("\n");
    // Only the step that RUNS it, not the one that records its baseline.
    if (new RegExp(`bun run ${script}\\s*$`, "m").test(body)) bodies.push(body);
  }
  if (bodies.length !== 1) {
    throw new Error(`expected exactly one step running \`${script}\`, found ${bodies.length}`);
  }
  return bodies[0]!;
}

describe("i cancelli di performance hanno un terzo esito, e si vede", () => {
  for (const script of ABSTAINING_GATES) {
    it(`${script}: l'uscita 2 non ferma la run ma lascia un warning annotato`, () => {
      const body = stepRunning(script);
      expect(body).toMatch(/if \[ "\$rc" -eq 2 \]; then/);
      expect(body).toMatch(/echo "::warning title=/);
      expect(body).toMatch(/exit "\$rc"/);
    });

    it(`${script}: l'astensione non e' piu' ingoiata in silenzio`, () => {
      // `|| test $? -eq 2` passes the step with no trace: indistinguishable
      // from a measurement that went well.
      expect(stepRunning(script)).not.toMatch(/\|\| test \$\? -eq 2/);
    });
  }

  it("check:bundle NON si astiene: e' deterministico, e blocca sempre", () => {
    // Same bytes on any machine, so "not measurable" does not exist for it.
    // Giving it an exit 2 would be handing it an excuse it cannot have.
    expect(stepRunning("check:bundle")).not.toMatch(/-eq 2/);
  });
});

describe("check:ink sa dire «non ho misurato»", () => {
  const src = readFileSync(join(ROOT, "scripts/check-ink-latency.ts"), "utf8");

  it("dichiara i due esiti non-verdi con un nome", () => {
    expect(src).toMatch(/const OVER_BUDGET = 1;/);
    expect(src).toMatch(/const NOT_MEASURED = 2;/);
  });

  it("la misura che non parte e' un'astensione, non una regressione", () => {
    // The Playwright run failing means nothing was measured. The app being
    // broken is judged by the E2E job, which runs this same spec.
    const branch = /playwright exit \$\{run\.status\}[\s\S]{0,400}?return (\w+);/.exec(src);
    expect(branch?.[1]).toBe("NOT_MEASURED");
  });

  it("uno sforo MISURATO resta rosso: l'astensione non lo copre", () => {
    const branch = /if \(failures\.length > 0\) \{[\s\S]{0,300}?return (\w+);/.exec(src);
    expect(branch?.[1]).toBe("OVER_BUDGET");
  });
});

describe("performance/spec.md dice quali budget bloccano", () => {
  const spec = readFileSync(SPEC, "utf8");

  it("non si dichiara piu' senza applicazione mentre sei cancelli girano", () => {
    expect(spec).not.toMatch(/automated enforcement are future work/);
  });

  it("nomina tutti e sei i cancelli", () => {
    for (const script of [...ABSTAINING_GATES, "check:bundle"]) {
      expect(spec).toContain(script);
    }
  });

  it("scrive la regola dei due esiti non-verdi", () => {
    expect(spec).toMatch(/exit 1 = measured, and over budget/i);
    expect(spec).toMatch(/exit 2 = not measured/i);
  });
});
