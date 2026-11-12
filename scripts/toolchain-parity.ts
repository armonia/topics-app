#!/usr/bin/env bun
/**
 * TS 5 vs TS 7 PARITY BAR.
 *
 * The typecheck gates run TypeScript 7 (native, `typescript7` alias) while
 * `typescript` stays on 5.9 for typescript-eslint. This bar runs both compilers
 * on every project listed in `spec-flow.toolchain.json` and fails when the two
 * report different errors: a gate that silently changed meaning with the
 * compiler swap is exactly what it exists to catch.
 *
 * `barra:toolchain` used to point at `spec-flow/scripts/toolchain/ts-parity.mjs`,
 * a file that never existed in any spec-flow clone: the bar could not run at all.
 * It now lives here, versioned with the config it reads.
 *
 * Exit codes: 0 identical, 1 different, 97 a compiler could not run (not measured
 * is never green, see GATE-04).
 *
 *   bun run barra:toolchain
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CONFIG = join(ROOT, "spec-flow.toolchain.json");

export interface ParityRun {
  name: string;
  cwd?: string;
  args: string[];
}

export interface ParityConfig {
  nodeModules: string;
  runs: ParityRun[];
}

/** Exit code for "a compiler did not run": distinct from green and from red. */
export const EXIT_NOT_MEASURED = 97;

/**
 * Parses the `typecheck` section of the config, rejecting a wrong shape instead of
 * comparing nothing and calling it identical.
 */
export function parseConfig(raw: unknown): ParityConfig {
  const tc = (raw as { typecheck?: unknown } | null)?.typecheck as Partial<ParityConfig> | undefined;
  if (!tc || typeof tc.nodeModules !== "string" || !Array.isArray(tc.runs) || tc.runs.length === 0) {
    throw new Error("spec-flow.toolchain.json: serve typecheck.nodeModules (stringa) e typecheck.runs (non vuoto)");
  }
  for (const r of tc.runs) {
    if (!r || typeof r.name !== "string" || !Array.isArray(r.args) || !r.args.every((a) => typeof a === "string")) {
      throw new Error(`spec-flow.toolchain.json: run malformato ${JSON.stringify(r)}`);
    }
    if (r.cwd !== undefined && typeof r.cwd !== "string") {
      throw new Error(`spec-flow.toolchain.json: cwd non stringa in «${r.name}»`);
    }
  }
  return { nodeModules: tc.nodeModules, runs: tc.runs };
}

/**
 * Error identities from a `--pretty false` tsc output: `file(line,col): TSnnnn`,
 * sorted. The message text is left out on purpose: TS 7 rewords some messages,
 * and a reworded message is the same error.
 */
export function parseErrors(out: string): string[] {
  const keys: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/.exec(line.trim());
    if (m) keys.push(`${m[1]!.replace(/\\/g, "/")}(${m[2]},${m[3]}): ${m[4]}`);
    else {
      // Errors without a location (config problems): keep the code alone.
      const g = /^error (TS\d+):/.exec(line.trim());
      if (g) keys.push(`<global>: ${g[1]}`);
    }
  }
  return keys.sort();
}

/** Multiset difference both ways: what only one compiler reports. */
export function diffErrors(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
  const count = new Map<string, number>();
  for (const k of a) count.set(k, (count.get(k) ?? 0) + 1);
  for (const k of b) count.set(k, (count.get(k) ?? 0) - 1);
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (const [k, n] of count) {
    for (let i = 0; i < n; i++) onlyA.push(k);
    for (let i = 0; i < -n; i++) onlyB.push(k);
  }
  return { onlyA: onlyA.sort(), onlyB: onlyB.sort() };
}

/**
 * True when the compiler output says it never really ran: TS 7's launcher prints
 * this when its native package for the platform is missing.
 */
export function compilerDidNotRun(out: string): boolean {
  return /Unable to resolve @typescript\//.test(out);
}

interface Compiler {
  label: string;
  bin: string;
}

function runTsc(c: Compiler, run: ParityRun): { ok: true; errors: string[] } | { ok: false; why: string } {
  const res = spawnSync(process.execPath, [c.bin, ...run.args, "--pretty", "false"], {
    cwd: join(ROOT, run.cwd ?? ""),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (res.error || res.status === null) return { ok: false, why: res.error?.message ?? `segnale ${res.signal}` };
  if (compilerDidNotRun(out)) return { ok: false, why: "pacchetto nativo mancante" };
  const errors = parseErrors(out);
  // A non-zero exit with no parsed error is output we cannot read, not a clean run.
  if (res.status !== 0 && errors.length === 0) return { ok: false, why: `exit ${res.status} senza errori leggibili: ${out.slice(0, 300)}` };
  return { ok: true, errors };
}

function main(): number {
  const cfg = parseConfig(JSON.parse(readFileSync(CONFIG, "utf8")));
  const nm = join(ROOT, cfg.nodeModules);
  const compilers: [Compiler, Compiler] = [
    { label: "TS 5", bin: join(nm, "typescript", "bin", "tsc") },
    { label: "TS 7", bin: join(nm, "typescript7", "bin", "tsc") },
  ];
  for (const c of compilers) {
    if (!existsSync(c.bin)) {
      console.error(`✗ ${c.label} non trovato in ${c.bin}: bun install in client/ e rilancia.`);
      return EXIT_NOT_MEASURED;
    }
  }

  let different = 0;
  for (const run of cfg.runs) {
    const [r5, r7] = compilers.map((c) => runTsc(c, run));
    if (!r5!.ok || !r7!.ok) {
      const why = !r5!.ok ? `TS 5: ${r5!.why}` : `TS 7: ${(r7 as { why: string }).why}`;
      console.error(`✗ ${run.name}: non misurato (${why})`);
      return EXIT_NOT_MEASURED;
    }
    const { onlyA, onlyB } = diffErrors(r5!.errors, r7!.errors);
    if (onlyA.length === 0 && onlyB.length === 0) {
      console.log(`✓ ${run.name}: ${r5!.errors.length} errori, identici`);
      continue;
    }
    different++;
    console.log(`✗ ${run.name}: TS 5 ${r5!.errors.length}, TS 7 ${r7!.errors.length}`);
    for (const k of onlyA.slice(0, 20)) console.log(`   solo TS 5  ${k}`);
    for (const k of onlyB.slice(0, 20)) console.log(`   solo TS 7  ${k}`);
  }
  console.log(different === 0 ? "\nparità: identici" : `\nparità: ${different} progetti diversi`);
  return different === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main());
