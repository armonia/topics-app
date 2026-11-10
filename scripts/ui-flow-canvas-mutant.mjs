#!/usr/bin/env node
/**
 * scripts/ui-flow-canvas-mutant.mjs - the planted-defect build of the single
 * flow canvas: ONE break (the strip of lanes stacks them in a column instead
 * of standing them side by side), built apart, and the walk run against it.
 * Check c2 of `ui-flow-canvas-walk.mjs` must turn red.
 *
 * WHY. A check that never goes red proves nothing (Attilio, 08/11). The whole
 * point of the canvas is that the cases of a split stand SIDE BY SIDE; c2
 * measures their boxes. If stacking them leaves c2 green, c2 is blind.
 *
 * WHAT. 1) Checks that the class of the strip is in `FlowCanvas.tsx` exactly
 * once (otherwise exit 2 and nothing is touched). 2) Plants the break.
 * 3) Builds `client/dist-ui-mutant` (vite, same config as build:ui, other
 * outDir). 4) Puts the source back, always (try/finally, on exit and on a
 * signal): only the planted text is reversed, so an edit another hand made
 * to the same file meanwhile survives. 5) Runs
 * `ui-flow-canvas-walk.mjs --dist dist-ui-mutant --expect-red c2`.
 *
 *   node scripts/ui-flow-canvas-mutant.mjs [--only c1,c2] [--keep]
 *
 * `--only` is passed to the walk (to run fewer checks); `--keep` leaves
 * `dist-ui-mutant` for inspection. Exit 0: the walk caught the break (c2 red).
 * Exit 1: c2 stayed green. Exit 2: the text to replace is not there exactly
 * once, the build failed, or the build does not boot.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, arg, flag } from "./ui-app/serve.mjs";

const CLIENT = join(ROOT, "client");
const OUT = "dist-ui-mutant";
const FILE = join(CLIENT, "src/ui/flows/FlowCanvas.tsx");
const FROM = "relative flex min-w-0 overflow-x-auto overscroll-x-contain pb-1";
const TO = "relative flex flex-col min-w-0 overflow-x-auto overscroll-x-contain pb-1";
const count = (text, part) => text.split(part).length - 1;

/* 1. the text is there exactly once, and the break is not already in (a sign that a run before was cut short) */
const original = readFileSync(FILE, "utf8");
if (count(original, FROM) !== 1) {
  console.error(`ui-flow-canvas-mutant: in FlowCanvas.tsx il testo da cambiare compare ${count(original, FROM)} volte, atteso 1: ${FROM}`);
  process.exit(2);
}
if (count(original, TO) > 0) {
  console.error("ui-flow-canvas-mutant: FlowCanvas.tsx contiene già la rottura (un giro precedente interrotto?), non la riapplico");
  process.exit(2);
}

/* 2. plant, 3. build, 4. put it back, whatever happens */
let planted = false;
const restore = () => {
  if (!planted) return;
  planted = false;
  const now = readFileSync(FILE, "utf8");
  if (count(now, TO) === 1) writeFileSync(FILE, now.replace(TO, () => FROM));
  else console.error("ui-flow-canvas-mutant: ATTENZIONE, la rottura non si ritrova in FlowCanvas.tsx: controlla il file a mano");
};
process.on("exit", restore);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(130));

let built;
try {
  const current = readFileSync(FILE, "utf8");
  planted = true;
  writeFileSync(FILE, current.replace(FROM, () => TO));
  console.log(`ui-flow-canvas-mutant: piantata la rottura (i casi in colonna), costruisco ${OUT}`);
  built = spawnSync(process.execPath, [join(CLIENT, "node_modules/vite/bin/vite.js"), "build", "--config", "vite.ui.config.ts", "--outDir", OUT], { cwd: CLIENT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
} finally {
  restore();
}
if (built.status !== 0) {
  console.error(`ui-flow-canvas-mutant: la build del mutante è fallita (exit ${built.status})\n${(built.stdout ?? "").slice(-1500)}${(built.stderr ?? "").slice(-1500)}`);
  process.exit(2);
}
console.log("ui-flow-canvas-mutant: sorgente rimesso come era, build del mutante pronta");

/* 5. the walk against the mutant */
const only = arg("only");
const run = spawnSync(process.execPath, [join(ROOT, "scripts/ui-flow-canvas-walk.mjs"), "--dist", OUT, "--expect-red", "c2", ...(only ? ["--only", only] : [])], { cwd: ROOT, stdio: "inherit" });
if (!flag("keep")) rmSync(join(CLIENT, OUT), { recursive: true, force: true });
process.exit(run.status ?? 1);
