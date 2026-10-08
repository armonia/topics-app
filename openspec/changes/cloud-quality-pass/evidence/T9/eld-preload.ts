// Event loop delay of the server process, measured from inside it.
// Preloaded with BUN_OPTIONS="--preload <this file>". Inert unless ELD_OUT is set.
// Discards ELD_WARMUP_MS after boot, then writes p50/p90/p99/max (ms) over ELD_WINDOW_MS.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { writeFileSync } from "node:fs";

const out = process.env.ELD_OUT;
if (out) {
  const warmup = Number(process.env.ELD_WARMUP_MS || 20000);
  const window = Number(process.env.ELD_WINDOW_MS || 60000);
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  const ms = (ns: number) => Math.round(ns / 1e4) / 100;
  // Wall-clock time of every gap over 6 ms, to tell what was running then.
  const stalls = process.env.ELD_STALLS;
  if (stalls) {
    let last = performance.now();
    const lines: string[] = [];
    setInterval(() => {
      const now = performance.now();
      if (now - last > 7) lines.push(`${Date.now()} gap ${Math.round(now - last)}`);
      last = now;
    }, 1).unref?.();
    setInterval(() => { if (lines.length) { require("node:fs").appendFileSync(stalls, lines.splice(0).join("\n") + "\n"); } }, 5000).unref?.();
  }
  setTimeout(() => {
    h.reset();
    const startedAt = Date.now();
    setTimeout(() => {
      writeFileSync(out, JSON.stringify({
        windowMs: Date.now() - startedAt, count: h.count,
        p50: ms(h.percentile(50)), p90: ms(h.percentile(90)), p99: ms(h.percentile(99)),
        max: ms(h.max), mean: ms(h.mean),
      }) + "\n");
    }, window).unref?.();
  }, warmup).unref?.();
}
