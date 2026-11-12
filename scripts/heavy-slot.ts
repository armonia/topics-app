#!/usr/bin/env bun
/**
 * Runs a heavy command behind the machine-wide queue Topics serves.
 *
 * Usage:  bun run scripts/heavy-slot.ts <label> -- <command...>
 * Env:    TOPICS_URL            where Topics listens (default http://127.0.0.1:$PORT or :3333)
 *         TOPICS_HEAVY_MAX_WAIT_MS  longest wait before running anyway (default 10 min; 0 = never queue)
 *
 * Any harness calls this (or the same two HTTP endpoints) before tsc, cargo,
 * vitest, ffmpeg and the like. With Topics off or in error the command starts
 * at once: see `heavy-slot-client.ts`.
 */
import { spawn } from "node:child_process";
import { acquireHeavySlot } from "./heavy-slot-client.ts";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const label = sep > 0 ? argv.slice(0, sep).join(" ") : "heavy";
const cmd = (sep >= 0 ? argv.slice(sep + 1) : argv).join(" ");
if (!cmd) {
  console.error("usage: bun run scripts/heavy-slot.ts <label> -- <command...>");
  process.exit(2);
}

const raw = process.env.TOPICS_HEAVY_MAX_WAIT_MS;
const parsed = raw == null || raw === "" ? NaN : Number(raw);
const maxWaitMs = Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 10 * 60_000;
const base = (process.env.TOPICS_URL || `http://127.0.0.1:${process.env.PORT || 3333}`).replace(/\/$/, "");

const lease = maxWaitMs > 0
  ? await acquireHeavySlot({ base, label, pid: process.pid, maxWaitMs, onWait: (m) => console.error(m) })
  : null;

const child = spawn(cmd, { stdio: "inherit", shell: true });
let freed = false;
const free = async (): Promise<void> => {
  if (freed) return;
  freed = true;
  await lease?.release();
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => { child.kill(sig); });
}
child.on("error", async (e) => { console.error(`[heavy-slot] ${label}: ${e.message}`); await free(); process.exit(1); });
child.on("exit", async (code, signal) => { await free(); process.exit(signal ? 1 : (code ?? 0)); });
