#!/usr/bin/env bun
/**
 * Runs a heavy command behind the machine-wide queue Topics serves.
 *
 * Usage:  bun run scripts/heavy-slot.ts <label> -- <command...>
 *         bun run scripts/heavy-slot.ts acquire <label> --pid <pid>   prints the lease id once granted
 *         bun run scripts/heavy-slot.ts release <id>
 * Env:    TOPICS_URL            where Topics listens (default: https then http on 127.0.0.1:$PORT or :3333)
 *         TOPICS_HEAVY_MAX_WAIT_MS  longest wait before running anyway (default 10 min; 0 = never queue)
 *
 * Any harness calls this (or the same HTTP endpoints) before tsc, cargo,
 * vitest, ffmpeg and the like. With Topics off or in error the command starts
 * at once: see `heavy-slot-client.ts`. The shell forms (`acquire`, `release`)
 * always exit 0: `acquire` prints nothing when it fails open, and a lease with
 * a pid lives while that pid does, so the hook needs no renewing process.
 */
import { spawn } from "node:child_process";
import { acquireHeavySlot, releaseHeavySlot, resolveHeavyBase } from "./heavy-slot-client.ts";

const argv = process.argv.slice(2);

const raw = process.env.TOPICS_HEAVY_MAX_WAIT_MS;
const parsed = raw == null || raw === "" ? NaN : Number(raw);
const maxWaitMs = Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 10 * 60_000;
const resolveBase = () => resolveHeavyBase({ url: process.env.TOPICS_URL, port: process.env.PORT });

if (argv[0] === "release") {
  const id = argv[1];
  const base = id ? await resolveBase() : null;
  if (id && base) await releaseHeavySlot(base, id);
  process.exit(0);
}

if (argv[0] === "acquire") {
  const pidAt = argv.indexOf("--pid");
  const pid = pidAt >= 0 ? Number(argv[pidAt + 1]) : NaN;
  const label = argv.slice(1, pidAt >= 0 ? pidAt : undefined).join(" ") || "heavy";
  const base = maxWaitMs > 0 && Number.isInteger(pid) && pid > 0 ? await resolveBase() : null;
  const lease = base
    ? await acquireHeavySlot({ base, label, pid, maxWaitMs, renewEveryMs: 0, onWait: (m) => console.error(m) })
    : null;
  if (lease) console.log(lease.id);
  process.exit(0);
}

const sep = argv.indexOf("--");
const label = sep > 0 ? argv.slice(0, sep).join(" ") : "heavy";
const cmd = (sep >= 0 ? argv.slice(sep + 1) : argv).join(" ");
if (!cmd) {
  console.error("usage: bun run scripts/heavy-slot.ts <label> -- <command...>");
  process.exit(2);
}

const base = maxWaitMs > 0 ? await resolveBase() : null;
const lease = base
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
