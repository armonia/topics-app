#!/usr/bin/env bun
/**
 * scripts/parallel.ts - runs several INDEPENDENT commands together and gives one
 * verdict.
 *
 * WHY. `typecheck` and `lint` were chains `a && b && c && d`: five `tsc` and four
 * eslint passes one after the other, while the machine (4 cores on a CI runner,
 * 4 vCPU on the cloud VM) used one of them. Measured cold on the VM: typecheck
 * 100 s and lint 109 s, 87% of the fast bar. The pieces share nothing (each has
 * its own `tsBuildInfoFile`, its own eslint cache, none writes into the
 * sources), so there is no reason to queue them.
 *
 * WHAT CHANGES COMPARED TO `&&`.
 *  - A chain stopped at the first red; here every piece runs and the verdict
 *    lists ALL the reds: one round says everything there is to fix (the same
 *    rule `qa-gate.sh` already follows, "it does not stop at the first red").
 *  - The exit code is the one of the first red piece in the order they were
 *    written, i.e. the code the chain would have given.
 *  - Each piece's output arrives whole and uninterleaved, one after the other:
 *    greens first, reds last, because the board card keeps only the TAIL of the
 *    output (TAIL_LINES) and the red must be in it.
 *
 * HOW MANY AT ONCE. At most `--jobs N` (default: the cores, never more than the
 * commands). It is ONE logical gate: it sits inside the single `slot.ts` slot
 * that wraps it (the `test:unit` shards do the same), it does not take a slot
 * per piece.
 *
 * Usage:  bun run scripts/parallel.ts [--jobs N] "<command 1>" "<command 2>" ...
 */
import { spawn } from "node:child_process";
import { cpus } from "node:os";

export interface PartResult {
  cmd: string;
  code: number;
  output: string;
  seconds: number;
}

/** The code of the first red piece in the given order, 0 when all are green. */
export function verdictOf(results: readonly Pick<PartResult, "code">[]): number {
  return results.find((r) => r.code !== 0)?.code ?? 0;
}

/** Runs a shell command and collects its whole output (stdout + stderr). */
function runOne(cmd: string): Promise<PartResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const chunks: Buffer[] = [];
    const child = spawn("sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    child.stdout.on("data", (b: Buffer) => chunks.push(b));
    child.stderr.on("data", (b: Buffer) => chunks.push(b));
    const done = (code: number, extra = "") =>
      resolve({ cmd, code, output: Buffer.concat(chunks).toString("utf8") + extra, seconds: (Date.now() - t0) / 1000 });
    child.on("error", (e) => done(127, `${e.message}\n`));
    child.on("close", (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

/** Runs `cmds` with at most `jobs` in flight; results come back in the commands' order. */
export async function runAll(cmds: readonly string[], jobs: number): Promise<PartResult[]> {
  const results: PartResult[] = new Array(cmds.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= cmds.length) return;
      results[i] = await runOne(cmds[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, cmds.length)) }, worker));
  return results;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let jobs = cpus().length;
  const cmds: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--jobs") {
      jobs = Number(args[++i]);
      if (!Number.isInteger(jobs) || jobs < 1) {
        console.error("parallel: --jobs wants an integer >= 1");
        process.exit(2);
      }
    } else cmds.push(args[i]!);
  }
  if (cmds.length === 0) {
    console.error('usage: bun run scripts/parallel.ts [--jobs N] "<command>" ...');
    process.exit(2);
  }

  const results = await runAll(cmds, jobs);
  const green = results.filter((r) => r.code === 0);
  const red = results.filter((r) => r.code !== 0);
  for (const r of [...green, ...red]) {
    console.log(`\n== ${r.code === 0 ? "green" : `RED (${r.code})`} ${r.seconds.toFixed(0)}s: ${r.cmd}`);
    process.stdout.write(r.output.endsWith("\n") || r.output === "" ? r.output : r.output + "\n");
  }
  if (red.length > 0) {
    console.error(`\nparallel: ${red.length} of ${results.length} piece(s) red:`);
    for (const r of red) console.error(`  - ${r.cmd} (exit ${r.code})`);
  }
  process.exit(verdictOf(results));
}
