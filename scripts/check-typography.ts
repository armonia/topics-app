#!/usr/bin/env bun
/**
 * THE GATE UNDER THE TYPE SCALE.
 *
 * WHAT IT PROTECTS. The scale lives in ONE place, the `@theme` block at the top
 * of `client/src/index.css`: twelve named steps, font-size only. Before it
 * existed the client held 1550 font sizes written as arbitrary values over 24
 * distinct sizes, six of them at half a pixel (9.5 10.5 11.5 12.5 13.5, 88
 * uses) and two below the readable floor (7px and 8px, nine uses). Nobody
 * decided that: it is what a codebase converges to when the size of a new
 * component is chosen by looking at the neighbour and adding half a pixel.
 *
 * So the defect this refuses is not ugliness, it is the ABSENCE OF A SOURCE.
 * Three questions, all answered from the same parse of index.css.
 *
 *   1. A SIZE WRITTEN IN A COMPONENT. `text-[13px]`, `text-[12.5px]`,
 *      `text-[0.8rem]`: an absolute length in an arbitrary value is a size that
 *      exists outside the scale, which is how 24 of them appeared. Red.
 *      A RELATIVE length is not (`text-[0.92em]` on a chip inside prose says
 *      "whatever my parent is, a bit smaller", which no fixed step can say).
 *
 *   2. A DEAD SIZE CLASS. The scale RESETS Tailwind's namespace
 *      (`--text-*: initial`), so `text-xs`, `text-sm`, `text-base`, `text-lg`,
 *      `text-2xl` no longer generate anything at all. That failure is silent:
 *      the class is in the DOM, the element renders at the inherited size, and
 *      nothing in the build complains. This is the branch worth the most, since
 *      it is the one a person cannot see by reading the diff.
 *
 *   3. A STEP THAT IS NOT A SIZE. Adding a step is allowed, and it is exactly
 *      where a half pixel would come back in: this refuses a step that is not a
 *      whole number of pixels, and one under the 9px floor.
 *
 * WHAT IT DOES NOT LOOK AT, said out loud so nobody mistakes silence for
 * coverage: `style={{ fontSize }}` written in JavaScript. The editor and the
 * terminal size their text from a user setting, inline, and they must; a rule
 * covering inline sizes would need a list of the components allowed to do it,
 * which is a second list to keep aligned for a route nobody takes by accident.
 *
 * HOW TO SEE IT RED:
 *   bun run scripts/check-typography.ts --self-test
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");
const THEME_FILE = "client/src/index.css";

/** The smallest size this UI is allowed to render. Under it, text is decoration. */
const FLOOR_PX = 9;

/** Tailwind's own font-size steps, which the `@theme` reset deletes. */
const TAILWIND_STEPS = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"];

export interface Step {
  name: string;
  value: string;
}

export interface Problem {
  file: string;
  line: number;
  found: string;
  why: string;
}

/** The steps declared in the `@theme` block: `--text-mini: 11px` gives `mini`. */
export function parseScale(css: string): Step[] {
  const start = css.indexOf("@theme");
  if (start < 0) return [];
  let depth = 0;
  let end = start;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = css.slice(start, end);
  const out: Step[] = [];
  for (const m of body.matchAll(/^\s*--text-([a-z0-9-]+)\s*:\s*([^;]+);/gm)) {
    out.push({ name: m[1]!, value: m[2]!.trim() });
  }
  return out;
}

/** A step is a size only if it is a whole number of pixels, at or above the floor. */
export function badSteps(steps: Step[]): Problem[] {
  const out: Problem[] = [];
  for (const s of steps) {
    const m = /^(\d+(?:\.\d+)?)px$/.exec(s.value);
    if (!m) {
      out.push({ file: THEME_FILE, line: 0, found: `--text-${s.name}: ${s.value}`, why: "a step is a whole number of pixels, nothing else" });
      continue;
    }
    const px = Number(m[1]);
    if (!Number.isInteger(px)) {
      out.push({ file: THEME_FILE, line: 0, found: `--text-${s.name}: ${s.value}`, why: "half a pixel is not a size: the rasteriser rounds it, and which way depends on the platform and the zoom" });
    } else if (px < FLOOR_PX) {
      out.push({ file: THEME_FILE, line: 0, found: `--text-${s.name}: ${s.value}`, why: `under ${FLOOR_PX}px text stops being readable` });
    }
  }
  return out;
}

/** Anything that sets a font size outside the scale, in one source file. */
export function findOffScale(src: string, file: string, steps: Step[]): Problem[] {
  const known = new Set(steps.map((s) => s.name));
  const out: Problem[] = [];
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const m of line.matchAll(/text-\[(-?\d*\.?\d+)(px|pt|rem|cm|mm|in|pc)\]/g)) {
      out.push({ file, line: i + 1, found: m[0]!, why: `an absolute size outside the scale (declare a step in ${THEME_FILE}, or use the nearest one)` });
    }
    for (const step of TAILWIND_STEPS) {
      if (known.has(step)) continue;
      const re = new RegExp(`(?:^|[\\s"'\`{(\\[])(?:[^\\s"'\`]*:)?text-${step}\\b(?![-\\w])`, "g");
      for (const m of line.matchAll(re)) {
        out.push({ file, line: i + 1, found: m[0]!.trim(), why: "Tailwind's own scale is switched off, so this class generates nothing and the text falls back to the inherited size" });
      }
    }
  }
  return out;
}

function trackedSources(): string[] {
  const r = spawnSync(
    "git",
    ["ls-files", "client/src/*.ts", "client/src/*.tsx", "client/src/*.css", "client/src/**/*.ts", "client/src/**/*.tsx", "client/src/**/*.css"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git ls-files exited ${r.status}`);
  return [...new Set(r.stdout.split("\n").map((s) => s.trim()).filter(Boolean))];
}

if (import.meta.main) {
  const scale = parseScale(readFileSync(resolve(ROOT, THEME_FILE), "utf8"));

  if (process.argv.includes("--self-test")) {
    const fakeScale: Step[] = [{ name: "mini", value: "11px" }, { name: "body", value: "13px" }];
    const bad = findOffScale('<p className="text-[12.5px] text-xs">x</p>', "fake.tsx", fakeScale);
    const good = findOffScale('<p className="text-mini text-app-text-muted text-center text-[0.92em]">x</p>', "fake.tsx", fakeScale);
    const steps = badSteps([{ name: "half", value: "10.5px" }, { name: "tiny", value: "7px" }, { name: "ok", value: "11px" }]);
    const ok = bad.length === 2 && good.length === 0 && steps.length === 2;
    console.log(ok
      ? "[typography] self-test OK: catches the arbitrary size and the dead class, spares colours and relative sizes."
      : `[typography] self-test FAILED: bad=${bad.length} (want 2), good=${good.length} (want 0), steps=${steps.length} (want 2)`);
    process.exit(ok ? 0 : 1);
  }

  if (scale.length === 0) {
    console.error(`[typography] FAIL - no @theme scale found in ${THEME_FILE}. The scale IS the source: without it every component invents its own size again.`);
    process.exit(1);
  }

  const problems = badSteps(scale);
  let scanned = 0;
  for (const f of trackedSources()) {
    scanned++;
    problems.push(...findOffScale(readFileSync(resolve(ROOT, f), "utf8"), f, scale));
  }

  if (problems.length === 0) {
    console.log(`[typography] OK - ${scale.length} steps, ${scanned} files, no size outside the scale.`);
    process.exit(0);
  }

  console.error(`[typography] FAIL - ${problems.length} sizes outside the scale:`);
  for (const p of problems.slice(0, 40)) {
    console.error(`  ${p.file}${p.line ? `:${p.line}` : ""}  ${p.found}  ${p.why}`);
  }
  if (problems.length > 40) console.error(`  ... and ${problems.length - 40} more`);
  console.error(
    `\nThe scale is the twelve named steps in ${THEME_FILE} (text-nano ... text-display-xl),\n` +
      "font-size only: a line box goes on an explicit `leading-*` next to it.\n" +
      "A size the scale does not have is a DECISION: add the step there, with the line\n" +
      "saying what it is for, and every surface gets it.",
  );
  process.exit(1);
}
