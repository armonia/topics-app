// AI Bridge client — the ONE server-side socket to the detached ai-bridge
// daemon (server/ai-bridge.mjs). Modeled on the terminal PTY-bridge client
// (server/routes/terminal.ts): a singleton connection, spawn-the-daemon-if-
// absent, reconnect-on-close, ping/pong watchdog. The daemon owns the `claude`
// children, so this client can disconnect (server restart) and a fresh client
// reconnects and re-attaches to the still-running turns.
//
// Purpose-built API (spawn/attach/write/signal/kill + per-session frame
// routing) rather than a literal port — the AI protocol is stream-json over
// offset-addressed `data` frames, not terminal bytes.
import net from "node:net";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { augmentPath } from "../utils/path-env";
import { resolveStateDir } from "./data-dir";

export interface SpawnOpts {
  cliPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
export interface SessionHandlers {
  /** A stdout NDJSON chunk arrived at byte `offset` in the durable store. */
  onData: (chunk: Buffer, offset: number) => void;
  /** A stderr chunk (rate-limit / missing-session detection lives in the provider). */
  onStderr?: (chunk: Buffer) => void;
  /** The child exited (crash/normal). `exitCode` null = signal/error. */
  onExit?: (exitCode: number | null) => void;
}
export interface AttachResult {
  endOffset: number;
  alive: boolean;
  exitCode: number | null;
  /** True when the daemon had no session for this id (nothing to re-attach). */
  missing?: boolean;
}
export interface SessionInfo {
  id: string;
  pid: number;
  alive: boolean;
  exitCode: number | null;
  endOffset: number;
  createdAt: number;
}

const ACK_TIMEOUT_MS = 5_000;
const WATCHDOG_EVERY_MS = 15_000;
const PONG_TIMEOUT_MS = 45_000;

export class AiBridgeClient {
  private socket: net.Socket | null = null;
  private ready = false;
  private connecting = false;
  private readyResolvers: Array<() => void> = [];
  private readonly handlers = new Map<string, SessionHandlers>();
  private readonly waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private readonly reconnectCbs = new Set<() => void>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private disposed = false;

  readonly socketPath: string;
  readonly storeDir: string;

  constructor() {
    this.socketPath = computeSocketPath();
    this.storeDir = join(resolveStateDir(process.cwd()), "ai-bridge");
  }

  // --- connection ---

  async ensureConnected(): Promise<void> {
    if (this.ready && this.socket && !this.socket.destroyed) return;
    if (this.connecting) return new Promise<void>((r) => this.readyResolvers.push(r));
    this.connecting = true;
    try {
      if (await this.tryConnect()) return;
      // No daemon — spawn one (detached, survives our restart). Bun-native:
      // process.execPath is the same bun the server runs under. augmentPath so a
      // launchd-minimal PATH still resolves `claude` for the children later.
      try { fs.mkdirSync(this.storeDir, { recursive: true }); } catch { /* best effort */ }
      const child = spawn(
        process.execPath,
        [resolve(import.meta.dir, "../ai-bridge.mjs"), "--socket", this.socketPath, "--store-dir", this.storeDir],
        { detached: true, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, PATH: augmentPath() } },
      );
      child.unref();
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        if (fs.existsSync(this.socketPath) && (await this.tryConnect())) break;
      }
      if (!this.ready) throw new Error("ai-bridge: failed to connect after spawning daemon");
    } finally {
      this.connecting = false;
      this.readyResolvers.forEach((r) => r());
      this.readyResolvers = [];
    }
  }

  private tryConnect(): Promise<boolean> {
    return new Promise((res) => {
      if (!fs.existsSync(this.socketPath)) { res(false); return; }
      const socket = net.connect(this.socketPath, () => {
        this.socket = socket;
        this.ready = true;
        this.lastPongAt = Date.now();
        this.setupReader(socket);
        this.startWatchdog();
        console.log("[AI Bridge] Connected to daemon");
        res(true);
      });
      socket.on("error", () => res(false));
      setTimeout(() => { if (!this.ready) { socket.destroy(); res(false); } }, 1000);
    });
  }

  private setupReader(socket: net.Socket): void {
    const rl = createInterface({ input: socket });
    rl.on("line", (line: string) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      this.handleFrame(msg);
    });
    socket.on("close", () => {
      this.ready = false;
      this.socket = null;
      if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
      if (this.disposed) return; // shut down deliberately — do NOT respawn
      console.log("[AI Bridge] socket closed — reconnecting");
      setTimeout(() => {
        this.ensureConnected()
          .then(() => { for (const cb of this.reconnectCbs) { try { cb(); } catch { /* handler own errors */ } } })
          .catch(() => { /* next call retries */ });
      }, 500);
    });
    socket.on("error", () => { /* 'close' follows */ });
  }

  private handleFrame(msg: any): void {
    // Satisfy any ack waiter first (spawned/attached/list/error/pong).
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].pred(msg)) {
        const [w] = this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
    if (msg.type === "pong") { this.lastPongAt = Date.now(); return; }
    const id = msg.id as string | undefined;
    if (!id) return;
    const h = this.handlers.get(id);
    if (!h) return;
    switch (msg.type) {
      case "data": h.onData(Buffer.from(msg.chunk ?? "", "base64"), msg.offset ?? 0); break;
      case "stderr": h.onStderr?.(Buffer.from(msg.chunk ?? "", "base64")); break;
      case "exit": h.onExit?.(typeof msg.exitCode === "number" ? msg.exitCode : null); break;
    }
  }

  private waitFor(pred: (m: any) => boolean, timeoutMs = ACK_TIMEOUT_MS): Promise<any> {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        rej(new Error("ai-bridge: ack timeout"));
      }, timeoutMs);
      this.waiters.push({ pred, resolve: res, reject: rej, timer });
    });
  }

  private send(msg: object): void {
    try { this.socket?.write(JSON.stringify(msg) + "\n"); } catch { /* reconnect will retry */ }
  }

  private startWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (!this.ready) return;
      if (Date.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
        console.warn("[AI Bridge] watchdog: no pong — recycling socket");
        try { this.socket?.destroy(); } catch { /* 'close' handles reconnect */ }
        return;
      }
      this.send({ type: "ping" });
    }, WATCHDOG_EVERY_MS);
    this.watchdog.unref?.();
  }

  // --- session ops ---

  registerHandlers(id: string, handlers: SessionHandlers): void { this.handlers.set(id, handlers); }
  unregister(id: string): void { this.handlers.delete(id); }

  /** Spawn (or, if a live session for `id` already exists, resume) a child. */
  async spawn(id: string, opts: SpawnOpts): Promise<{ pid: number; resumed: boolean }> {
    await this.ensureConnected();
    const ack = this.waitFor((m) => (m.type === "spawned" || m.type === "error") && m.id === id);
    this.send({ type: "spawn", id, cliPath: opts.cliPath, args: opts.args, cwd: opts.cwd, env: opts.env });
    const m = await ack;
    if (m.type === "error") throw new Error(`ai-bridge spawn: ${m.error}`);
    return { pid: m.pid, resumed: m.resumed === true };
  }

  /** Re-attach to an existing session, replaying the store from `fromOffset`. */
  async attach(id: string, fromOffset: number): Promise<AttachResult> {
    await this.ensureConnected();
    const ack = this.waitFor((m) => m.type === "attached" && m.id === id);
    this.send({ type: "attach", id, fromOffset });
    const m = await ack;
    return { endOffset: m.endOffset, alive: m.alive, exitCode: m.exitCode ?? null, missing: m.missing === true };
  }

  write(id: string, data: string): void { this.send({ type: "write", id, data }); }
  detach(id: string): void { this.send({ type: "detach", id }); }
  signal(id: string, sig: string): void { this.send({ type: "signal", id, signal: sig }); }
  kill(id: string): void { this.send({ type: "kill", id }); this.handlers.delete(id); }

  async list(): Promise<SessionInfo[]> {
    await this.ensureConnected();
    const ack = this.waitFor((m) => m.type === "list");
    this.send({ type: "list" });
    const m = await ack;
    return (m.sessions ?? []) as SessionInfo[];
  }

  /** True if the daemon holds a session for `id` whose child is still alive. */
  async hasLiveSession(id: string): Promise<boolean> {
    try { return (await this.list()).some((s) => s.id === id && s.alive); }
    catch { return false; }
  }

  /** Called after a socket reconnect so the provider re-attaches live sessions. */
  onReconnect(cb: () => void): () => void {
    this.reconnectCbs.add(cb);
    return () => this.reconnectCbs.delete(cb);
  }

  /** Tear down the connection WITHOUT triggering the auto-reconnect (which would
   *  otherwise respawn the daemon). For a deliberate shutdown / test teardown. */
  dispose(): void {
    this.disposed = true;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    try { this.socket?.destroy(); } catch { /* already gone */ }
    this.socket = null;
    this.ready = false;
  }
}

/** Socket path: isolated per data-instance so a test server never touches prod's
 *  ai-bridge (mirrors terminal.ts getSocketPath). TOPICS_AI_BRIDGE_SOCKET is the
 *  E2E override. */
function computeSocketPath(): string {
  const override = process.env.TOPICS_AI_BRIDGE_SOCKET;
  if (override) return override;
  const dataDir = process.env.DATA_DIR;
  const basis = dataDir ? `${process.cwd()}\0${dataDir}` : process.cwd();
  const hash = createHash("md5").update(basis).digest("hex").slice(0, 8);
  return `/tmp/topics-ai-bridge-${hash}.sock`;
}

let singleton: AiBridgeClient | null = null;
export function getAiBridgeClient(): AiBridgeClient {
  if (!singleton) singleton = new AiBridgeClient();
  return singleton;
}

/** Test-only: drop the cached singleton so the next getAiBridgeClient() picks up
 *  a fresh socket/store from the current env. Prevents a prior test file's client
 *  (with a different TOPICS_AI_BRIDGE_SOCKET) leaking into a later one when many
 *  broker tests share one `bun test` process. No-op effect in production. */
export function __resetAiBridgeClientForTests(): void {
  try { singleton?.dispose(); } catch { /* best effort */ }
  singleton = null;
}
