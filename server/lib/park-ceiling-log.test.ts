/**
 * @covers TERM-04
 *
 * At the memory ceiling the sweep tightens its threshold for as long as the
 * machine stays there, and it used to say so on every 60 s tick: 2,218 lines
 * in six days for only ~590 real entries into the ceiling. The line belongs to
 * the ENTRY (and to a change of the tightened threshold), and the way out gets
 * a line of its own. The memory lives in this small factory so it can be tested
 * without the sweep timer.
 *
 * Kept apart from the pressure tests on purpose: the factory does not exist
 * yet, and a missing import fails the whole file it sits in.
 */
import { expect, test } from "bun:test";
import { createCeilingReporter } from "./park-ceiling-log";

const PARK_MS = 30 * 60_000;

function reporter(): { report: (parkMs: number, threshold: number | null) => void; lines: string[] } {
  const lines: string[] = [];
  return { report: createCeilingReporter((line) => lines.push(line)), lines };
}

test("staying at the ceiling prints the entry once, not on every tick", () => {
  const { report, lines } = reporter();
  for (let i = 0; i < 5; i++) report(PARK_MS, 8 * 60_000);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("soffitto");
  expect(lines[0]).toContain("8");
});

test("a different tightened threshold is a new fact and prints again", () => {
  const { report, lines } = reporter();
  report(PARK_MS, 8 * 60_000);
  report(PARK_MS, 8 * 60_000);
  report(PARK_MS, 5 * 60_000);
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("5");
});

test("leaving the ceiling prints one exit line with the restored threshold, then goes quiet", () => {
  const { report, lines } = reporter();
  report(PARK_MS, 8 * 60_000);
  report(PARK_MS, PARK_MS);
  report(PARK_MS, PARK_MS);
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("30");
  expect(lines[1]).not.toBe(lines[0]);
});

test("a machine that never reached the ceiling prints nothing", () => {
  const { report, lines } = reporter();
  for (let i = 0; i < 3; i++) report(PARK_MS, PARK_MS);
  expect(lines).toEqual([]);
});

test("entering the ceiling again after an exit prints the entry again", () => {
  const { report, lines } = reporter();
  report(PARK_MS, 8 * 60_000);
  report(PARK_MS, PARK_MS);
  report(PARK_MS, 8 * 60_000);
  expect(lines).toHaveLength(3);
});

test("an unknown pressure reading is no news: no exit line, no second entry", () => {
  // A probe that throws (or is missing) gives no reading. Read as "back to the
  // normal threshold", one such tick printed an exit and then the entry again
  // for a machine that never left the ceiling.
  const { report, lines } = reporter();
  report(PARK_MS, 8 * 60_000);
  report(PARK_MS, null);
  report(PARK_MS, 8 * 60_000);
  expect(lines).toHaveLength(1);
  report(PARK_MS, PARK_MS);
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("rientrata");
});
