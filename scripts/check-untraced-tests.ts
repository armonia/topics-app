#!/usr/bin/env bun
/**
 * R6 - A TEST THAT DOES NOT DECLARE WHAT IT COVERS.
 *
 * THE HOLE IT CLOSES, and it is not theoretical: in one night the same shape
 * turned up THREE times - the sidebar status line (8 test files, zero
 * requirements), the rendering of tool calls, and the memory-leak bench (bench
 * and gate both working, and no requirement naming them). Every time: a live
 * feature, covered by tests, and the reference document silent. Whoever reads
 * the specs believes the feature does not exist; whoever looks at the tests
 * believes it is described; and the two cannot notice each other.
 *
 * WHY `check-spec-coverage` could not see it. That gate verifies that every
 * REQUIREMENT has a test (R2) and that every declared id exists (R1). Both start
 * from the specs and look towards the tests. The opposite direction - from the
 * tests towards the specs - was checked by nothing, and it is exactly the
 * direction in which a feature gets lost.
 *
 * WHY A RATCHET AND NOT A BAN. At the first measurement, 1,043 test files out
 * of 1,166 declare nothing: 89%. A gate that accuses them all is red from day
 * one, and a gate that is red by default stops being read within a month - the
 * same reason the other gates in this repository carry tolerances. So the
 * baseline absorbs what exists and this check answers ONE question, the one
 * that matters:
 *
 *     does a NEW test file declare what it covers?
 *
 * The baseline only goes down. A file that gains a declaration leaves it and
 * cannot come back.
 *
 *   bun run scripts/check-untraced-tests.ts
 *   bun run scripts/check-untraced-tests.ts --update-baseline
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BASELINE = join(ROOT, "scripts", "untraced-tests-baseline.json");

/**
 * The two channels a test may declare a requirement through.
 *
 * The ID SHAPE is part of the rule, not decoration. This gate used to accept the mere FORM
 * (`type: "spec"` anywhere in the file), while `check-spec-coverage` only counts ids matching
 * `^[A-Z][A-Z0-9-]*-\d+[a-z]?$` and silently drops the rest. A file annotating
 * `description: "SIDEBAR-AC1"` therefore passed HERE as "declares" and vanished THERE as
 * "declares nothing" — traced by one gate, invisible to the other, and nobody sees the hole
 * because neither gate is red. Measured on 2026-08-26: nine such annotations across five files.
 *
 * The two regexes must keep reading the same vocabulary. If one changes, the other changes.
 */
const DECLARES = /@covers\s+[A-Z][A-Z0-9-]*-\d+|type:\s*["']spec["']\s*,\s*description:\s*["'`][^"'`]*\b[A-Z][A-Z0-9-]*-\d+/;

function testFiles(): string[] {
  // `--others --exclude-standard` includes files that are NOT YET tracked, and
  // that is the case that matters: a test just written and not yet committed is
  // exactly what this gate exists to catch. With plain `ls-files` the check was
  // blind right before the commit - measured, by creating a probe file that it
  // did not see.
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  return out
    .split("\n")
    .filter((f) => /\.(test|spec)\.tsx?$/.test(f))
    // Helpers and fixtures are not tests and have nothing to declare.
    .filter((f) => !/\/(helpers|fixtures|setup)\//.test(f));
}

const untraced = testFiles().filter((f) => {
  try {
    return !DECLARES.test(readFileSync(join(ROOT, f), "utf8"));
  } catch {
    return false;
  }
});

const base: string[] = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")).files ?? []) : [];
const known = new Set(base);

if (process.argv.includes("--update-baseline")) {
  writeFileSync(
    BASELINE,
    `${JSON.stringify(
      {
        $schema: "untraced-tests-v1",
        _comment: [
          "File di test che non dichiarano quale requisito coprono, tollerati.",
          "SCENDE SOLTANTO: un file che guadagna un `@covers` (o l'annotazione",
          "Playwright `type: \"spec\"`) esce da qui e non puo' rientrare.",
          "Un file NUOVO senza dichiarazione e' rosso, e la cura non e' aggiungerlo",
          "a questa lista: e' scrivere il requisito che quel test prova gia'.",
        ],
        count: untraced.length,
        files: untraced.sort(),
      },
      null,
      1,
    )}\n`,
  );
  console.log(`[untraced-tests] baseline scritta: ${untraced.length} file.`);
  process.exit(0);
}

const fresh = untraced.filter((f) => !known.has(f));
const cleared = base.filter((f) => !untraced.includes(f));

if (fresh.length > 0) {
  console.log(`[untraced-tests] FAIL: ${fresh.length} file di test NUOVI non dichiarano cosa coprono:\n`);
  for (const f of fresh.slice(0, 20)) console.log(`  ${f}`);
  if (fresh.length > 20) console.log(`  … e altri ${fresh.length - 20}`);
  console.log(`
Un test che non nomina il requisito che prova e' copertura che le spec non
vedono. E' successo tre volte in una notte: la fascia della sidebar, la resa
dei tool e il banco sui leak erano tutti coperti e tutti invisibili.

La cura NON e' aggiungere il file alla linea di partenza. E' una riga:
  ·  test in bun:    \`@covers <ID>\` nel docblock in testa
  ·  spec Playwright: test.info().annotations.push({ type: "spec", description: "<ID>" })
Se il requisito non esiste ancora, scrivilo: il test lo prova gia'.`);
  process.exit(1);
}

if (cleared.length > 0) {
  console.log(`[untraced-tests] debito sceso di ${cleared.length}, rilancia con --update-baseline per fissarlo:`);
  for (const f of cleared.slice(0, 12)) console.log(`    ${f}`);
  process.exit(1);
}

console.log(`[untraced-tests] OK: ${untraced.length} file senza dichiarazione (linea di partenza ${base.length}), nessuno nuovo.`);
