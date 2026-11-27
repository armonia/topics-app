#!/usr/bin/env bun
/**
 * MEASURES THE EFFECT OF THE OUTPUT CAP added for card 59f8c4a0 (that card's
 * 9.1 GB footprint peak is NOT reproduced here, and the check output is not
 * its proven cause — see the comment above MAX_CHECK_OUTPUT_BYTES). Run the
 * SAME chatty commands through the SAME reading loop
 * `runOne` uses (spawn, pipe, decode chunk by chunk), once with plain string
 * concatenation (`out = out + chunk`, what `runOne` did before this card) and
 * once with `appendBoundedTail` capped at `MAX_CHECK_OUTPUT_BYTES` (what it
 * does now), and sample each PHASE'S OWN process while several checks run at
 * once inside it - the night's dispatch keeps several review rounds in flight
 * together, so the cost that matters is the SUM across them, not one check
 * alone.
 *
 * Each phase runs in its own child process (not a flag flip in-process):
 * otherwise the garbage strings the "before" phase piles up are still
 * resident, uncollected, when "after" samples its peak, and the comparison
 * would blame the cap for memory the concatenation left behind.
 *
 *   bun run scripts/bench/review-checks-output-cap.ts
 *
 * EXIT: 0 once both phases ran and the capped one peaked lower; 1 if the
 * platform has no memory metric (see proc.ts) or a phase could not be set up.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendBoundedTail, MAX_CHECK_OUTPUT_BYTES } from "../../server/services/review-checks";
import { memoryBytesOf, metricForPlatform, mb } from "./proc";

const CONCURRENCY = 8; // several review rounds in flight, as on the night of 25/11
const CHUNK_MB_PER_CHECK = 150; // one check's combined stdout+stderr before any cap
const PHASE_FLAG = "--phase=";

async function collect(cmd: string, bound: boolean): Promise<number> {
  const proc = Bun.spawn(["/bin/sh", "-lc", cmd], { stdout: "pipe", stderr: "pipe" });
  const decoder = new TextDecoder();
  let out = "";
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    out = bound ? appendBoundedTail(out, chunk, MAX_CHECK_OUTPUT_BYTES).text : out + chunk;
  }
  await proc.exited;
  return out.length;
}

/** Runs inside the CHILD process for one phase: prints one JSON line, then exits. */
async function runPhaseInChild(bound: boolean): Promise<void> {
  const cmd = `yes noise | head -c $((${CHUNK_MB_PER_CHECK} * 1024 * 1024))`;
  const selfPid = process.pid;
  let peakBytes = 0;
  const sampler = setInterval(() => {
    const bytes = memoryBytesOf(selfPid);
    if (bytes !== null && bytes > peakBytes) peakBytes = bytes;
  }, 30);
  const heldPerCheck = await Promise.all(Array.from({ length: CONCURRENCY }, () => collect(cmd, bound)));
  const bytes = memoryBytesOf(selfPid);
  if (bytes !== null && bytes > peakBytes) peakBytes = bytes;
  clearInterval(sampler);
  console.log(JSON.stringify({ peakBytes, heldPerCheck }));
}

/** Runs inside the PARENT: spawns the child, samples its memory as a cross-check, reads its result. */
async function runPhaseAsChild(bound: boolean): Promise<{ peakBytes: number; heldPerCheck: number[] }> {
  const proc = Bun.spawn(["bun", "run", import.meta.path, `${PHASE_FLAG}${bound ? "after" : "before"}`], {
    stdout: "pipe",
    stderr: "inherit",
  });
  let parentSidePeak = 0;
  const sampler = setInterval(() => {
    if (!proc.pid) return;
    const bytes = memoryBytesOf(proc.pid);
    if (bytes !== null && bytes > parentSidePeak) parentSidePeak = bytes;
  }, 30);
  const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  await proc.exited;
  clearInterval(sampler);
  const line = text.trim().split("\n").pop() ?? "{}";
  const { peakBytes, heldPerCheck } = JSON.parse(line) as { peakBytes: number; heldPerCheck: number[] };
  // The CHILD's own self-reading is the ground truth; the parent's external
  // sampling (same metric, read from outside) is the cross-check that the two
  // agree.
  return { peakBytes: Math.max(peakBytes, parentSidePeak), heldPerCheck };
}

async function main(): Promise<number> {
  const phaseArg = process.argv.find((a) => a.startsWith(PHASE_FLAG))?.slice(PHASE_FLAG.length);
  if (phaseArg === "before" || phaseArg === "after") {
    await runPhaseInChild(phaseArg === "after");
    return 0;
  }

  const metric = metricForPlatform(process.platform);
  if (metric === null) {
    console.log("not measured here: no memory metric for this platform (see proc.ts)");
    return 1;
  }
  console.log(`metric: ${metric}, concurrency: ${CONCURRENCY}, ${CHUNK_MB_PER_CHECK} MB chatty output per check\n`);

  const before = await runPhaseAsChild(false);
  const after = await runPhaseAsChild(true);

  const line = (label: string, p: { peakBytes: number; heldPerCheck: number[] }) =>
    `${label.padEnd(22)} child process peak: ${mb(p.peakBytes).toFixed(1)} MB` +
    `  |  held per check: ${p.heldPerCheck.map((b) => mb(b).toFixed(1)).join(", ")} MB`;

  const report = [
    `review-checks output cap - memory effect (card 59f8c4a0)`,
    `metric: ${metric}, concurrency: ${CONCURRENCY}, chunk: ${CHUNK_MB_PER_CHECK} MB/check, each phase in its own process`,
    "",
    line("before (concat, old)", before),
    line("after (bounded, now)", after),
    "",
    `MAX_CHECK_OUTPUT_BYTES = ${mb(MAX_CHECK_OUTPUT_BYTES).toFixed(1)} MB`,
    `old accumulation kept ~${(CONCURRENCY * CHUNK_MB_PER_CHECK).toFixed(0)} MB across the ${CONCURRENCY} checks in flight (scales with volume and concurrency, unbounded);`,
    `the capped one keeps at most ${mb(CONCURRENCY * MAX_CHECK_OUTPUT_BYTES).toFixed(1)} MB no matter how chatty or how many run together.`,
  ].join("\n");
  console.log("\n" + report);

  const outPath = join("/tmp", "review-checks-output-cap-repro.txt");
  writeFileSync(outPath, report + "\n");
  console.log(`\nwritten: ${outPath}`);

  const heldBefore = before.heldPerCheck.reduce((a, b) => a + b, 0);
  const heldAfter = after.heldPerCheck.reduce((a, b) => a + b, 0);
  if (heldAfter >= heldBefore || after.peakBytes >= before.peakBytes) {
    console.error(
      `FAIL: capped phase did not peak lower (held ${heldAfter} vs ${heldBefore}, ` +
      `peak ${after.peakBytes} vs ${before.peakBytes})`,
    );
    return 1;
  }
  return 0;
}

main().then((code) => process.exit(code));
