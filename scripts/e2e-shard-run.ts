#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, lstatSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { canonicalTmpRoot } from "../tests/e2e/helpers/test-server";
import { acquireSlot, alreadyHeld, GATE_HELD_ENV, slotAcquiredLine, slotCount } from "./gate-slot";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
if (args.some(arg => arg === "--output" || arg.startsWith("--output="))) {
  console.error("[e2e-shards] --output is reserved for isolated shard artifacts. Set E2E_SHARD_OUT_DIR to choose the run directory.");
  process.exit(2);
}
const shards = /^\d+$/.test(args[0] ?? "") ? Number(args[0]) : 2;
const base = Number(process.env.E2E_SHARD_BASE_PORT || 13910);
if (!Number.isInteger(base) || base < 1 || !Number.isInteger(shards) || shards < 1 || shards > 1000 || base + shards - 1 + 1000 > 65535) {
  console.error("[e2e-shards] Invalid shard count or port range (including tunnel ports).");
  process.exit(2);
}

// This lease protects all shard invocations, even when the CPU throttle is off.
// Tests override its path; ordinary runs share the canonical scratch root.
const lease = process.env.TOPICS_E2E_SHARD_LOCK_PATH || join(canonicalTmpRoot(), "topics-e2e-shards.lock");
let releaseSlot: (() => void) | null = null;
let ownsLease = false;
function release(): void {
  releaseSlot?.();
  releaseSlot = null;
  if (ownsLease) {
    ownsLease = false;
    unlinkSync(lease);
  }
}

// Slot acquisition blocks synchronously. Queue before owning any E2E lease,
// so the default signal action remains responsive while no shards exist yet.
const queued = Date.now();
if (!alreadyHeld() && slotCount() > 0) releaseSlot = acquireSlot(slotCount(), "e2e");
console.error(slotAcquiredLine("e2e", Date.now() - queued));

let child: ChildProcess | undefined;
let signalCode = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
function signalGroup(signal: NodeJS.Signals): void {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch { /* The process group has already exited. */ }
}
const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => {
  const handler = () => {
    if (signalCode) return;
    signalCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
    if (!child) {
      release();
      process.exit(signalCode);
    }
    // Playwright's detached test server is cleaned up on INT/TERM, not HUP.
    signalGroup(signal === "SIGHUP" ? "SIGTERM" : signal);
    timer = setTimeout(() => signalGroup("SIGKILL"), 10_000);
  };
  process.on(signal, handler);
  return { signal, handler };
});

try {
  const fd = openSync(lease, "wx", 0o600);
  ownsLease = true;
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, cwd: root, base, shards })); }
  finally { closeSync(fd); }
} catch (error) {
  release();
  let holder = "unreadable lease";
  try { holder = readFileSync(lease, "utf8"); } catch { /* Report the original filesystem error too. */ }
  console.error(`[e2e-shards] Cannot acquire run lease ${lease}: ${String(error)}\nHolder: ${holder}\n` +
    "Inspect before recovering an abandoned lease: ps -axo pid,ppid,command; lsof -nP -iTCP -sTCP:LISTEN.\n" +
    "Wait for the active run. A stale lease is not removed automatically because its shards may still be alive.");
  process.exit(1);
}

try {
  const requested = process.env.E2E_SHARD_OUT_DIR;
  const out = requested ? resolve(requested) : mkdtempSync(join(tmpdir(), "topics-e2e-shards-"));
  if (requested) {
    mkdirSync(out, { recursive: true });
    if (lstatSync(out).isSymbolicLink() || readdirSync(out).length !== 0) {
      throw new Error(`Output directory must be empty and must not be a symlink: ${out}`);
    }
  }
  child = spawn("bash", [join(root, "scripts/e2e-shards.sh"), ...args], {
    cwd: root, stdio: "inherit", detached: true,
    env: { ...process.env, [GATE_HELD_ENV]: alreadyHeld() ? process.env[GATE_HELD_ENV] : "e2e", TOPICS_E2E_SHARD_CHILD: "1", E2E_SHARD_OUT_DIR: out },
  });
  child.on("error", (error) => console.error(`[e2e-shards] ${error.message}`));
  const running = child;
  const code = await new Promise<number>((done) => {
    running.once("error", () => done(1));
    running.once("exit", (status, signal) => done(signalCode || (signal ? 1 : status ?? 1)));
  });
  if (timer) clearTimeout(timer);
  // The shell waits for every shard. On cancellation, remove any descendants
  // left after that wait before making the next invocation eligible to start.
  if (signalCode) signalGroup("SIGKILL");
  for (const { signal, handler } of handlers) process.off(signal, handler);
  release();
  process.exitCode = code;
} catch (error) {
  console.error(`[e2e-shards] ${String(error)}`);
  release();
  process.exitCode = 1;
}
