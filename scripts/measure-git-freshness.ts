#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "node:net";
import { freshnessExitCode, isMatchingGitStatus, median, percentile95 } from "./git-freshness-metrics";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PORT_BASE = 15300;
const PORT_SPAN = 100;
const DEFAULT_SAMPLES = 8;
const DEFAULT_BUDGET_MS = 150;
const FIXTURE_FILES = 256;

interface RunStats {
  mode: "native-on" | "native-off";
  samples: number[];
}

function parseArgs(args: string[]): { samples: number; burners: number; budgetMs: number } {
  const read = (name: string, fallback: number) => {
    const arg = args.find((item) => item.startsWith(`--${name}=`) || item === `--${name}`);
    if (!arg) return fallback;
    const raw = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[args.indexOf(arg) + 1];
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`);
    return value;
  };
  const samples = read("samples", DEFAULT_SAMPLES);
  const burners = read("burners", 0);
  const budgetMs = read("budget-ms", DEFAULT_BUDGET_MS);
  if (samples < 2 || samples > 100) throw new Error("--samples must be between 2 and 100");
  if (budgetMs < 1) throw new Error("--budget-ms must be at least 1");
  return { samples, burners, budgetMs };
}

function portFor(path: string): number {
  let hash = 0x811c9dc5;
  for (const character of path.replace(/\/+$/, "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PORT_BASE + (hash % PORT_SPAN);
}

async function waitForPort(port: number, timeoutMs: number, expectFree = false): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolveOpen) => {
      const socket = connect({ host: "127.0.0.1", port }, () => { socket.destroy(); resolveOpen(true); });
      socket.on("error", () => resolveOpen(false));
      socket.setTimeout(500, () => { socket.destroy(); resolveOpen(false); });
    });
    if (open === !expectFree) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return false;
}

async function api<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${response.status}: ${body.slice(0, 240)}`);
  return (body ? JSON.parse(body) : null) as T;
}

function runGit(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function makeFixture(path: string, samples: number): void {
  mkdirSync(path, { recursive: true });
  runGit(["init", "-q"], path);
  runGit(["config", "user.name", "Freshness Bench"], path);
  runGit(["config", "user.email", "freshness-bench@example.invalid"], path);
  const tracked = join(path, "tracked");
  mkdirSync(tracked);
  for (let index = 0; index < FIXTURE_FILES; index++) {
    writeFileSync(join(tracked, `file-${String(index).padStart(4, "0")}.txt`), `baseline ${index}\n`);
  }
  // Unique paths prevent an earlier broadcast from satisfying a later sample.
  for (let index = 0; index < samples; index++) {
    writeFileSync(join(tracked, `measure-${String(index).padStart(3, "0")}.txt`), `baseline measure ${index}\n`);
  }
  runGit(["add", "."], path);
  runGit(["commit", "-qm", "fixture"], path);
}

function openSocket(url: string): { socket: WebSocket; ready: Promise<void>; close: () => void } {
  const socket = new WebSocket(url);
  let rejectOpen: (error: Error) => void = () => {};
  const opened = new Promise<void>((resolveOpen, reject) => {
    rejectOpen = reject;
    socket.addEventListener("open", () => resolveOpen(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
  const close = () => { try { socket.close(); } catch {} };
  socket.addEventListener("close", () => rejectOpen(new Error("WebSocket closed before opening")), { once: true });
  return { socket, close, ready: opened };
}

function waitForStatus(socket: WebSocket, projectPath: string, filePath: string, serverLog: () => string = () => "", timeoutMs = 10_000): Promise<number> {
  return new Promise((resolveSample, reject) => {
    const startedAt = performance.now();
    const timeout = setTimeout(() => {
      const log = serverLog();
      finish(new Error(`timed out waiting for git:status containing ${filePath}${log ? `\n${log}` : ""}`));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(String(event.data)) as unknown;
        if (isMatchingGitStatus(message, projectPath, filePath)) finish();
      } catch { /* Initial non-JSON frames are not status updates. */ }
    };
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      if (error) reject(error);
      else resolveSample(performance.now() - startedAt);
    };
    socket.addEventListener("message", onMessage);
  });
}

async function setNativeMode(base: string, enabled: boolean): Promise<void> {
  const envelope = await api<{ value?: Record<string, unknown> }>(base, "/api/ui-state/settings");
  const value = envelope?.value && typeof envelope.value === "object" ? envelope.value : {};
  await api(base, "/api/ui-state/settings", {
    method: "PUT",
    body: JSON.stringify({ ...value, nativeGitStatusEnabled: enabled }),
  });
}

async function waitUntilFileStatus(socket: WebSocket, projectPath: string, filePath: string, present: boolean): Promise<void> {
  await new Promise<void>((resolveWait, reject) => {
    const timeout = setTimeout(() => finish(new Error(`timed out waiting for status to ${present ? "include" : "drop"} ${filePath}`)), 10_000);
    const onMessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string; projectPath?: string; status?: { files?: Array<{ path?: string }> } };
        if (message.type !== "git:status" || message.projectPath !== projectPath || !Array.isArray(message.status?.files)) return;
        if (message.status.files.some((file) => file.path === filePath) === present) finish();
      } catch { /* Ignore unrelated frames. */ }
    };
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      if (error) reject(error);
      else resolveWait();
    };
    socket.addEventListener("message", onMessage);
  });
}

async function measureMode(
  base: string,
  socket: WebSocket,
  projectPath: string,
  fixturePath: string,
  samples: number,
  mode: RunStats["mode"],
  serverLog: () => string,
): Promise<RunStats> {
  await setNativeMode(base, mode === "native-on");
  const values: number[] = [];
  for (let index = 0; index < samples; index++) {
    const relPath = index % 2 === 0
      ? `tracked/measure-${String(index).padStart(3, "0")}.txt`
      : `added-${mode}-${String(index).padStart(3, "0")}.txt`;
    const absolutePath = join(fixturePath, relPath);
    const sample = waitForStatus(socket, projectPath, relPath, serverLog);
    writeFileSync(absolutePath, `sample ${mode} ${index} ${process.hrtime.bigint()}\n`);
    values.push(await sample);
    if (index % 2 === 1) {
      const removal = waitUntilFileStatus(socket, projectPath, relPath, false);
      rmSync(absolutePath);
      await removal;
    }
  }
  return { mode, samples: values };
}

function spawnBurners(count: number): ReturnType<typeof spawn>[] {
  return Array.from({ length: count }, () => spawn("bash", ["-c", "while :; do :; done"], {
    detached: true,
    stdio: "ignore",
  }));
}

async function main(): Promise<void> {
  const { samples, burners, budgetMs } = parseArgs(process.argv.slice(2));
  const tempRoot = mkdtempSync(join(tmpdir(), "topics-git-freshness-"));
  const fixturePath = join(tempRoot, "fixture");
  const dataDir = join(tempRoot, "server-data");
  const port = portFor(REPO_ROOT);
  if (port === 3333) throw new Error("refusing to use the production server port 3333");

  let server: ReturnType<typeof spawn> | null = null;
  let serverLog = "";
  let socket: WebSocket | null = null;
  const burnerProcesses = spawnBurners(burners);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { socket?.close(); } catch {}
    for (const child of burnerProcesses) {
      try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch {}
    }
    try { if (server?.pid) process.kill(-server.pid, "SIGTERM"); } catch {}
    rmSync(tempRoot, { recursive: true, force: true });
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  try {
    if (!(await waitForPort(port, 1000, true))) throw new Error(`isolated port ${port} is already in use`);
    makeFixture(fixturePath, samples);
    server = spawn("bash", [join(REPO_ROOT, "scripts/start-test-server.sh")], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        BUN_PORT: String(port),
        DATA_DIR: dataDir,
        TOPICS_HOME: join(dataDir, ".topics-home"),
        OPENCLAW_DIR: join(dataDir, ".openclaw"),
        TOPICS_PTY_SOCKET: join(tempRoot, "pty.sock"),
        TOPICS_AI_BRIDGE_SOCKET: join(tempRoot, "ai.sock"),
        NO_TLS: "1",
        TOPICS_E2E: "1",
      },
    });
    server.stdout?.on("data", (chunk: Buffer) => { serverLog = `${serverLog}${chunk}`.slice(-4000); });
    server.stderr?.on("data", (chunk: Buffer) => { serverLog = `${serverLog}${chunk}`.slice(-4000); });
    if (!(await waitForPort(port, 40_000))) throw new Error(`isolated server did not start on ${port}`);
    const base = `http://127.0.0.1:${port}`;
    await api(base, "/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Git freshness bench", slug: "git-freshness-bench", path: fixturePath }),
    });
    await api(base, `/api/files?path=${encodeURIComponent(fixturePath)}&depth=1`);
    await api(base, `/api/git/status?path=${encodeURIComponent(fixturePath)}`);
    const ws = openSocket(`ws://127.0.0.1:${port}/ws`);
    socket = ws.socket;
    await ws.ready;
    const runtime = await api<{ nativeGit?: { loaded?: boolean } }>(base, "/api/system/status");
    const nativeAvailable = runtime.nativeGit?.loaded === true;

    console.log(`git freshness · ${samples} campioni/modalità · ${FIXTURE_FILES + samples} file tracked · burners ${burners} · addon nativo ${nativeAvailable ? "caricato" : "assente"} · budget p95 ${budgetMs} ms`);
    const native = await measureMode(base, socket, fixturePath, fixturePath, samples, "native-on", () => serverLog);
    const fallback = await measureMode(base, socket, fixturePath, fixturePath, samples, "native-off", () => serverLog);
    for (const result of [native, fallback]) {
      console.log(`${result.mode} · mediana ${median(result.samples).toFixed(1)} ms · p95 ${percentile95(result.samples).toFixed(1)} ms · massimo ${Math.max(...result.samples).toFixed(1)} ms · n=${result.samples.length}`);
    }
    const exitCode = nativeAvailable ? freshnessExitCode(percentile95(native.samples), budgetMs) : 2;
    console.log(nativeAvailable
      ? `budget nativo ${percentile95(native.samples).toFixed(1)} ms ${exitCode === 0 ? "PASS" : "FAIL"} (≤ ${budgetMs} ms)`
      : "budget nativo NON MISURATO: addon assente, entrambi i modi usano git CLI");
    process.exitCode = exitCode;
  } finally {
    cleanup();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`git freshness measurement failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
