#!/usr/bin/env bun
/**
 * How long a terminal pane stays MUTE after a reload, measured instead of guessed.
 *
 * The pane remounts, the bridge replays the scrollback and the cursor moves, so
 * the terminal looks ready well before it can carry a keystroke. This probe
 * puts numbers on that window, in the two places it can come from:
 *
 *  · the socket itself: creation -> `open` -> `replay-end` (the only frame a
 *    live session sends, and therefore the moment input can be delivered);
 *  · the server's warming gate (`rosterReconciled`), which answers 503 to the
 *    session routes until the roster has been reconciled after a boot.
 *
 * It drives its OWN server on its own port and data dir, never the app the
 * reader is using.
 *
 *   bun run scripts/terminal-attach-latency.ts [--port 3899] [--rounds 5]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const argOf = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const PORT = argOf("port", 3899);
const ROUNDS = argOf("rounds", 5);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "..");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.floor(s.length / 2)]!;
};
const round = (n: number) => Math.round(n * 10) / 10;

function startServer(dataDir: string) {
  const child = spawn("bun", ["run", "start"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), APP_DATA_DIR: dataDir, SERVER_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (b) => { log += String(b); });
  child.stderr?.on("data", (b) => { log += String(b); });
  return { child, readLog: () => log };
}

/** The boot window: from the first answered request to the first one the
 *  warming gate no longer defers. */
async function measureWarming(): Promise<{ firstAnswerMs: number; warmMs: number; deferrals: number }> {
  const t0 = Date.now();
  let firstAnswerMs = NaN;
  let deferrals = 0;
  for (;;) {
    if (Date.now() - t0 > 60_000) throw new Error("server never became reachable");
    try {
      const res = await fetch(`${BASE}/api/terminal/sessions`, { headers: { accept: "application/json" } });
      if (Number.isNaN(firstAnswerMs)) firstAnswerMs = Date.now() - t0;
      if (res.status === 503) { deferrals++; await sleep(25); continue; }
      const reconciled = res.headers.get("x-roster-reconciled");
      if (reconciled === "0" || reconciled === "false") { deferrals++; await sleep(25); continue; }
      return { firstAnswerMs, warmMs: Date.now() - t0, deferrals };
    } catch {
      await sleep(25);
    }
  }
}

async function createSession(): Promise<string> {
  const res = await fetch(`${BASE}/api/terminal/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: ROOT, type: "shell", name: "attach-latency" }),
  });
  if (!res.ok) throw new Error(`create session: ${res.status} ${await res.text()}`);
  const body = await res.json() as { id: string };
  return body.id;
}

/** One attach, the way the pane does it: open the socket, wait for the frame
 *  that proves the session is alive. */
function attachOnce(id: string): Promise<{ openMs: number; replayMs: number }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let openMs = NaN;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal/${id}`);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => { try { ws.close(); } catch { /* already gone */ } reject(new Error("no replay-end within 20 s")); }, 20_000);
    ws.onopen = () => { openMs = performance.now() - t0; };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      if (!ev.data.includes("replay-end")) return;
      clearTimeout(timer);
      const replayMs = performance.now() - t0;
      try { ws.close(); } catch { /* already gone */ }
      resolve({ openMs, replayMs });
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("socket error")); };
  });
}

async function rounds(id: string, n: number) {
  const open: number[] = [];
  const replay: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await attachOnce(id);
    open.push(r.openMs);
    replay.push(r.replayMs);
    await sleep(200);
  }
  return {
    openMedian: round(median(open)),
    openMax: round(Math.max(...open)),
    replayMedian: round(median(replay)),
    replayMax: round(Math.max(...replay)),
  };
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "topics-attach-"));
  let server = startServer(dataDir);
  // Stopping is not "signal sent": the port has to be free again, or the next
  // boot measures the corpse of the previous server answering.
  const stop = async () => {
    server.child.kill("SIGTERM");
    await sleep(500);
    try { server.child.kill("SIGKILL"); } catch { /* already dead */ }
    for (let i = 0; i < 200; i++) {
      try {
        await fetch(`${BASE}/api/terminal/sessions`, { signal: AbortSignal.timeout(300) });
        await sleep(100);
      } catch {
        return;
      }
    }
    throw new Error("port still answering after the server was killed");
  };
  try {
    const coldBoot = await measureWarming();
    const id = await createSession();
    await sleep(1_000);
    const warm = await rounds(id, ROUNDS);

    // Now the case that matters: the server restarts under a live session, the
    // pane remounts and attaches while the roster is still warming.
    await stop();
    server = startServer(dataDir);
    const restartT0 = Date.now();
    const afterRestart = await measureWarming();
    const firstAttach = await attachOnce(id).catch((e: Error) => ({ openMs: NaN, replayMs: NaN, error: e.message }));
    const firstAttachAfterRestartMs = Date.now() - restartT0;
    const afterWarm = await rounds(id, ROUNDS);

    console.log(JSON.stringify({
      port: PORT,
      rounds: ROUNDS,
      coldBoot,
      warmServerAttach: warm,
      restart: { warming: afterRestart, firstAttach, firstAttachFromBootMs: firstAttachAfterRestartMs, afterWarming: afterWarm },
    }, null, 2));
  } finally {
    await stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
