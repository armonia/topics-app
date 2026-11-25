#!/usr/bin/env node
/**
 * scripts/ui-org-bar.mjs - the whole bar of the two demos (ORBIT and the
 * Consorzio di Nocera) in one command, the same every time: static gates, the
 * two word/native gates with a mutation that must turn each of them red, then
 * the browser suites on both entries, one browser at a time. It was
 * `ui-orbit-bar.mjs`, which now forwards here.
 *
 * WHY. Attilio (08/11) asked for a bar with numbers, not a list of claims; on
 * 09/11 the preview became two demos on the same screens, and the nine points
 * of round 3 each got a named check. A gate that never fails proves nothing,
 * so each new gate is also run against a planted file that must make it exit
 * 1 (and the nine checks against a build with nine planted defects); a suite
 * run "most of the time" is not a bar, so every step runs even when one
 * before it failed, and the summary says which ones are red.
 *
 * WHAT. Runs STEPS in order, each with its output in test-results/ui-org-bar/
 * <name>.log, and prints one line per step: exit code, seconds, last line.
 * The nine checks of round 3 save their captures and a video of the whole
 * walk in test-results/giro3/<entry>/.
 *
 *   node scripts/ui-org-bar.mjs [--only static|browsers] [--skip build,phone-orbit] [--with-app] [--jobs N]
 *
 * `--jobs N` runs the browser steps N at a time (each has its own server on a
 * free port and its own browser): the six crawler shards alone take two hours
 * one after the other. Static steps stay one at a time, since some plant a
 * file the next must not see.
 *
 * `--only browsers` assumes the build is possible where it runs (the build
 * step runs in both groups unless skipped). The crawler of the old multi-
 * organization `app.html` is not one of the two demos: it runs only with
 * `--with-app`. Exit 0: every step as expected. Exit 1: the red steps, by name.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./ui-app/serve.mjs";

const argAfter = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const only = argAfter("only");
const skip = new Set((argAfter("skip") ?? "").split(",").filter(Boolean));
const LOGS = join(ROOT, "test-results/ui-org-bar");
const withApp = process.argv.includes("--with-app");
mkdirSync(LOGS, { recursive: true });

/* A planted file that a gate must reject: written before the run, removed after, whatever happens. */
const planted = (file, body) => ({
  before: () => writeFileSync(join(ROOT, file), body),
  after: () => rmSync(join(ROOT, file), { force: true }),
});

const STEPS = [
  { name: "typecheck", group: "static", posix: true, cmd: "bun run typecheck" },
  { name: "lint", group: "static", posix: true, cmd: "bun run lint" },
  { name: "ui-isolation", group: "static", cmd: "node scripts/check-ui-isolation.mjs" },
  { name: "build", group: "both", cmd: "bun run build:ui" },
  { name: "native", group: "static", cmd: "node scripts/check-ui-native.mjs" },
  {
    name: "native-mutation", group: "static", expect: 1, cmd: "node scripts/check-ui-native.mjs --src-only",
    ...planted("client/src/ui-gallery/BarMutation.tsx", "export const BarMutation = () => <select aria-label=\"x\" />;\n"),
  },
  { name: "words", group: "static", cmd: "node scripts/check-orbit-words.mjs" },
  {
    name: "words-mutation", group: "static", expect: 1, cmd: "node scripts/check-orbit-words.mjs --src-only",
    ...planted("client/src/ui-gallery/barMutation.ts", `export const ${"fun"}${"nel"}Count = 1;\n`),
  },
  { name: "crawl-orbit-1", group: "browsers", cmd: "node scripts/ui-app-crawl.mjs --entry orbit --shard 1/3" },
  { name: "crawl-orbit-2", group: "browsers", cmd: "node scripts/ui-app-crawl.mjs --entry orbit --shard 2/3" },
  { name: "crawl-orbit-3", group: "browsers", cmd: "node scripts/ui-app-crawl.mjs --entry orbit --shard 3/3" },
  { name: "crawl-consorzio-1", group: "browsers", cmd: "node scripts/ui-app-crawl.mjs --entry consorzio --shard 1/3" },
  { name: "crawl-consorzio-2", group: "browsers", cmd: "node scripts/ui-app-crawl.mjs --entry consorzio --shard 2/3" },
  { name: "crawl-consorzio-3", group: "browsers", cmd: "node scripts/ui-app-crawl.mjs --entry consorzio --shard 3/3" },
  { name: "crawl-app-1", group: "browsers", optional: true, cmd: "node scripts/ui-app-crawl.mjs --shard 1/3" },
  { name: "crawl-app-2", group: "browsers", optional: true, cmd: "node scripts/ui-app-crawl.mjs --shard 2/3" },
  { name: "crawl-app-3", group: "browsers", optional: true, cmd: "node scripts/ui-app-crawl.mjs --shard 3/3" },
  { name: "walk", group: "browsers", cmd: "node scripts/ui-orbit-walk.mjs" },
  { name: "giro3-orbit", group: "browsers", cmd: "node scripts/ui-giro3-walk.mjs --entry orbit --shots test-results/giro3/orbit --video test-results/giro3/orbit/giro.webm" },
  { name: "giro3-consorzio", group: "browsers", cmd: "node scripts/ui-giro3-walk.mjs --entry consorzio --shots test-results/giro3/consorzio --video test-results/giro3/consorzio/giro.webm" },
  { name: "giro3-mutant", group: "browsers", cmd: "node scripts/ui-giro3-mutant.mjs" },
  { name: "phone-orbit", group: "browsers", cmd: "node scripts/ui-orbit-phone.mjs" },
  { name: "phone-consorzio", group: "browsers", cmd: "node scripts/ui-orbit-phone.mjs --entry consorzio" },
  { name: "stability-orbit", group: "browsers", cmd: "node scripts/ui-orbit-stability.mjs" },
  { name: "stability-consorzio", group: "browsers", cmd: "node scripts/ui-orbit-stability.mjs --entry consorzio" },
];

const chosen = STEPS.filter((s) => !skip.has(s.name) && (withApp || !s.optional) && (!only || s.group === only || s.group === "both"));
const jobs = Math.max(1, Number(argAfter("jobs") ?? 1));
const rows = [];
const report = (step, code, out, started) => {
  writeFileSync(join(LOGS, `${step.name}.log`), out);
  const expected = step.expect ?? 0;
  const last = out.trim().split(/\r?\n/).filter((l) => l.trim()).at(-1) ?? "";
  const seconds = Math.round((Date.now() - started) / 1000);
  rows.push({ name: step.name, ok: code === expected, code, expected, seconds, last });
  console.log(`${code === expected ? "ok  " : "RED "} ${step.name.padEnd(20)} exit ${code}${expected ? ` (atteso ${expected})` : ""}  ${String(seconds).padStart(4)} s  ${last.slice(0, 160)}`);
};
const runOne = (step) => new Promise((done) => {
  const started = Date.now();
  const child = spawn(step.cmd, { cwd: ROOT, shell: true });
  let out = "";
  child.stdout.on("data", (b) => { out += b; });
  child.stderr.on("data", (b) => { out += b; });
  child.on("close", (code) => { report(step, code ?? 1, out, started); done(); });
});
const pool = [];
/* The repo's typecheck and lint go through /bin/sh (scripts/slot.ts): on the Windows PC they cannot start, so there they are named as not run and the Mac runs them. */
const skippedHere = chosen.filter((s) => s.posix && process.platform === "win32");
for (const step of skippedHere) console.log(`skip ${step.name.padEnd(20)} non gira su Windows (passa da /bin/sh): va lanciato sul Mac`);
for (const step of chosen) {
  if (skippedHere.includes(step)) continue;
  if (step.group === "browsers" && jobs > 1) {
    pool.push(step);
    continue;
  }
  const started = Date.now();
  step.before?.();
  let run;
  try {
    run = spawnSync(step.cmd, { cwd: ROOT, shell: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } finally {
    step.after?.();
  }
  report(step, run.status ?? 1, `${run.stdout ?? ""}${run.stderr ?? ""}`, started);
}
/* Browser steps, `jobs` at a time, after every static step and the build. */
let next = 0;
await Promise.all(Array.from({ length: Math.min(jobs, pool.length) }, async () => {
  while (next < pool.length) await runOne(pool[next++]);
}));
const red = rows.filter((r) => !r.ok);
writeFileSync(join(LOGS, "summary.json"), `${JSON.stringify(rows, null, 1)}\n`);
if (red.length) {
  console.error(`ui-org-bar: ${red.length} rossi su ${rows.length}: ${red.map((r) => r.name).join(", ")}`);
  process.exit(1);
}
console.log(`ui-org-bar: ok, ${rows.length} passi come attesi`);
