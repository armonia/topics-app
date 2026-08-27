/**
 * WebRTC bridge broker — the server half of the shared-session WebRTC transport.
 *
 * Spawns the Rust `webrtc-bridge` sidecar (desktop-tauri/webrtc-bridge) and relays
 * SDP/ICE between each browser pane's `/ws/browser/:ctx` WebSocket and the sidecar over
 * a Unix socket (NDJSON). The sidecar attaches to the pane's CDP target and streams it
 * as an H.264 WebRTC track to N peers (Mac + mobile = the SAME live session).
 *
 * Lazy + fail-safe: the sidecar spawns on the first offer; if its binary is missing or
 * disabled, `available()` is false and offers are dropped so the client transparently
 * falls back to the JPEG-over-WS stream. No effect on any existing browser path.
 *
 * Binary resolution: `TOPICS_WEBRTC_BRIDGE_BIN` (set by the Tauri shell, like
 * TOPICS_PTY_BRIDGE_BIN) → else the dev build under desktop-tauri/. Kill switch:
 * `TOPICS_DISABLE_WEBRTC_BRIDGE=1`.
 */
import { spawn, spawnSync, type ChildProcess } from "child_process";
import net from "net";
import { createInterface } from "readline";
import { createHash } from "crypto";
import { existsSync, openSync, closeSync, statSync } from "fs";
import { resolve, dirname, basename, join } from "path";
import { registerFleetSocket } from "./lib/fleet-usage";
import { envDataDir } from "./lib/data-dir";

/** Callbacks for one peer (one RTCPeerConnection), routed back to its WS. */
export interface PeerHandlers {
  onAnswer: (sdp: string) => void;
  onIce: (candidate: string, sdpMid: string | null, sdpMLineIndex: number | null) => void;
  onError: (message: string) => void;
}

export interface WebrtcBridge {
  /** True when the sidecar binary exists and isn't disabled — gate offers on this. */
  available(): boolean;
  /** Relay a viewer's SDP offer for `targetId`; answer/ice/error arrive via handlers. */
  offer(peerId: string, targetId: string, sdp: string, handlers: PeerHandlers): void;
  /** Relay a trickle ICE candidate from the viewer to the sidecar. */
  ice(peerId: string, candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): void;
  /** Tear a peer down (on WS close or explicit stop). */
  close(peerId: string): void;
  /** Shut the sidecar + socket down (server shutdown). */
  shutdown(): Promise<void>;
}

function socketPath(): string {
  const override = process.env.TOPICS_WEBRTC_SOCKET;
  if (override) return override;
  // Same isolation basis as the PTY bridge: cwd (+ DATA_DIR for test servers) so a
  // test/dev server never shares the production sidecar's socket.
  const dataDir = envDataDir();
  const basis = dataDir ? `${process.cwd()}\0${dataDir}` : process.cwd();
  const hash = createHash("md5").update(basis).digest("hex").slice(0, 8);
  return `/tmp/topics-webrtc-${hash}.sock`;
}

/** The sidecar binary: shell-provided (packaged) or the dev release build. */
function resolveBin(): string | null {
  const env = process.env.TOPICS_WEBRTC_BRIDGE_BIN;
  if (env && existsSync(env)) return env;
  const dev = resolve(import.meta.dir, "../desktop-tauri/webrtc-bridge/target/release/webrtc-bridge");
  if (existsSync(dev)) return dev;
  return null;
}

/** mtime in ms del binario: l'identità della build che ci aspettiamo dal sidecar. */
function binStamp(path: string): number {
  try { return Math.floor(statSync(path).mtimeMs); } catch { return 0; }
}

export function createWebrtcBridge(): WebrtcBridge {
  const disabled = process.env.TOPICS_DISABLE_WEBRTC_BRIDGE === "1";
  const bin = disabled ? null : resolveBin();
  const SOCK = socketPath();
  // Detached e reparentato a launchd come gli altri sidecar, e tutt'altro che
  // gratis (misurato ~530 MB / ~29% di CPU mentre streamma una pane): dichiararlo
  // e' cio' che lo fa entrare nella cifra della status bar invece di restare
  // invisibile. Vedi lib/fleet-usage.ts.
  registerFleetSocket("webrtc-bridge", SOCK);
  const BIN_STAMP = bin ? binStamp(bin) : 0;

  let child: ChildProcess | null = null;
  let sock: net.Socket | null = null;
  let ready = false;
  let connecting = false;
  let staleReaped = false; // già mietuto un sidecar di build sbagliata? (vedi case "ready")
  const outQueue: string[] = []; // lines buffered until the socket is ready
  const peers = new Map<string, PeerHandlers>();

  function send(obj: unknown) {
    const line = JSON.stringify(obj) + "\n";
    if (ready && sock && !sock.destroyed) sock.write(line);
    else outQueue.push(line);
  }

  function flush() {
    if (!(ready && sock && !sock.destroyed)) return;
    for (const line of outQueue.splice(0)) sock.write(line);
  }

  let lastActivityAt = 0; // ms of the last inbound line — wedge detector for the watchdog

  function onLine(line: string) {
    lastActivityAt = Date.now();
    line = line.trim();
    if (!line) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    switch (msg.t) {
      case "ready": {
        // Il sidecar dichiara l'mtime del proprio eseguibile. Se non è quello del
        // binario che spedirebbe questo server, abbiamo adottato un ORFANO di una
        // build precedente — che è il caso che `reapOrphanBridges()` da solo non
        // prende mai: l'orfano risponde al socket, quindi `tryConnect()` riesce e
        // la mietitura non viene nemmeno tentata. Così un sidecar con un bug
        // sopravvive a ogni riavvio del server, per giorni. Lo mietiamo qui.
        const stamp = Number(msg.build ?? 0);
        if (BIN_STAMP && stamp !== BIN_STAMP) {
          if (!staleReaped) {
            staleReaped = true; // una volta sola: meglio un sidecar vecchio che un ciclo di kill
            console.warn(`[webrtc] sidecar orfano di build ${stamp || "ignota"} (attesa ${BIN_STAMP}) — lo rimpiazzo`);
            resetBridge();
            reapOrphanBridges();
            return;
          }
        } else {
          staleReaped = false;
        }
        ready = true;
        flush();
        break;
      }
      case "answer": {
        peers.get(msg.peer)?.onAnswer(String(msg.sdp ?? ""));
        break;
      }
      case "ice": {
        peers.get(msg.peer)?.onIce(String(msg.candidate ?? ""), msg.sdpMid ?? null, msg.sdpMLineIndex ?? null);
        break;
      }
      case "error": {
        peers.get(msg.peer)?.onError(String(msg.message ?? "webrtc error"));
        break;
      }
    }
  }

  function attach(s: net.Socket) {
    sock = s;
    ready = false;
    s.on("error", () => {}); // handled by 'close'
    s.once("close", () => {
      ready = false;
      if (sock === s) sock = null;
      // Notify every open peer so the client can fall back / retry.
      for (const [, h] of peers) h.onError("webrtc bridge disconnected");
      peers.clear();
    });
    const rl = createInterface({ input: s });
    rl.on("line", onLine);
    // The sidecar emits {"t":"ready"} itself, but mark connected so the queue can
    // flush even if that line is missed after a reconnect.
    ready = true;
    flush();
  }

  async function tryConnect(): Promise<boolean> {
    return new Promise((res) => {
      const s = net.connect(SOCK);
      const onErr = () => {
        s.removeListener("connect", onOk);
        s.destroy();
        res(false);
      };
      const onOk = () => {
        s.removeListener("error", onErr);
        attach(s);
        res(true);
      };
      s.once("error", onErr);
      s.once("connect", onOk);
    });
  }

  /** Kill any orphaned sidecar bound to OUR socket (leftover from a previous
   *  server incarnation). POSIX-only, best-effort; the unique socket-hash in the
   *  pattern keeps this from matching any other process. Synchronous so the reap
   *  finishes before the caller spawns the replacement (no self-kill race). */
  function reapOrphanBridges(): void {
    if (process.platform === "win32") return;
    try { spawnSync("pkill", ["-f", `webrtc-bridge --socket ${SOCK}`], { stdio: "ignore" }); }
    catch { /* pkill missing — best effort */ }
  }

  async function ensure(): Promise<boolean> {
    if (!bin) return false;
    if (ready && sock && !sock.destroyed) return true;
    if (connecting) {
      // brief wait for the in-flight attempt
      await new Promise((r) => setTimeout(r, 150));
      return ready;
    }
    connecting = true;
    try {
      if (await tryConnect()) return true;
      // Nothing is answering the socket → the sidecar is dead (crashed, OOM-killed,
      // or orphaned by a previous server that exited). Respawn it. The old `child`
      // handle may still be non-null with `.killed` false (external death doesn't set
      // it), so we must NOT gate on `!child || child.killed` — that leaves the bridge
      // permanently down until a full server restart. Detect real liveness via the
      // exit/signal codes and always (re)spawn when there's no live process.
      const dead = !child || child.exitCode !== null || child.signalCode !== null;
      if (dead) {
        try { child?.kill("SIGKILL"); } catch { /* already gone */ }
        // Reap any ORPHAN sidecar bound to our socket before spawning a new one.
        // The bridge is spawned detached+unref'd (survives a server --watch
        // reload), so a server that EXITS leaves it running, reparented to PID 1.
        // The next server computes the same socket path and spawns again —
        // main.rs unlinks+rebinds, so the orphan keeps running forever with no
        // viewer (observed: one orphan at 42% CPU). Sync reap (blocks until pkill
        // exits) so it can't race — and can't hit the process we're about to spawn.
        reapOrphanBridges();
        // The sidecar removes a stale socket file before binding (main.rs), so no unlink here.
        // stderr → log file, never "inherit": the sidecar is detached and outlives
        // us, and an inherited fd would keep OUR stderr open in it — a piped parent
        // would then never see EOF. Our copy of the fd closes right after the spawn.
        let logFd: number | null = null;
        try { logFd = openSync(join(dirname(SOCK), `${basename(SOCK, ".sock")}.log`), "a"); } catch { /* log is optional */ }
        child = spawn(bin, ["--socket", SOCK], { detached: true, stdio: ["ignore", "ignore", logFd ?? "ignore"] });
        child.on("exit", () => { child = null; });
        child.on("error", () => { child = null; });
        child.unref();
        if (logFd !== null) { try { closeSync(logFd); } catch { /* already closed */ } }
      }
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (await tryConnect()) return true;
      }
      return false;
    } finally {
      connecting = false;
    }
  }

  /** Force a full reconnect: tear the socket + kill the sidecar so the next offer
   *  respawns a fresh one. Used when the sidecar is alive but wedged (accepts the
   *  socket but stops answering) — the watchdog below trips this. */
  function resetBridge() {
    try { sock?.destroy(); } catch { /* ignore */ }
    sock = null;
    ready = false;
    try { child?.kill("SIGKILL"); } catch { /* ignore */ }
    child = null;
  }

  // Probe d'avvio. NON genera niente — il sidecar resta lazy: si limita a vedere
  // se al nostro socket risponde già qualcuno, cioè un sidecar sopravvissuto al
  // server precedente. Se la sua build non è la nostra, il gestore di `ready` lo
  // mieta subito, senza aspettare che qualcuno apra una pane browser: un orfano
  // stantìo brucia CPU H24 (osservato: sei giorni al 42%) e finché nessuno fa un
  // offer `ensure()` — l'unico posto da cui passava la mietitura — non gira mai.
  if (bin) void tryConnect();

  return {
    available() {
      return !!bin;
    },
    offer(peerId, targetId, sdp, handlers) {
      // Watchdog: the sidecar answers within ~1s of a healthy offer. If nothing comes
      // back in ANSWER_TIMEOUT_MS this peer is stuck — fail it, and if the socket has
      // been silent overall (wedged sidecar, not just a bad target) force a reconnect
      // so the next offer gets a fresh sidecar. Without this a wedged sidecar (alive,
      // accepts the socket, never answers) keeps every viewer at ice=new forever.
      const ANSWER_TIMEOUT_MS = 9000;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (peers.get(peerId) === wrapped) peers.delete(peerId);
        handlers.onError("webrtc bridge timeout");
        // Force a reconnect only when NOBODY else is on the bridge (safe for fan-out —
        // never kill the sidecar while other panes are mid-negotiation) and the socket
        // has gone globally silent (a wedged sidecar, not just this one bad target).
        if (peers.size === 0 && Date.now() - lastActivityAt >= ANSWER_TIMEOUT_MS) resetBridge();
      }, ANSWER_TIMEOUT_MS);
      const wrapped: PeerHandlers = {
        onAnswer: (s) => { if (!settled) { settled = true; clearTimeout(timer); } handlers.onAnswer(s); },
        onIce: handlers.onIce,
        onError: (m) => { if (!settled) { settled = true; clearTimeout(timer); } handlers.onError(m); },
      };
      peers.set(peerId, wrapped);
      void ensure().then((ok) => {
        if (!ok) {
          if (!settled) { settled = true; clearTimeout(timer); }
          if (peers.get(peerId) === wrapped) peers.delete(peerId);
          handlers.onError("webrtc bridge unavailable");
          return;
        }
        send({ t: "offer", peer: peerId, target: targetId, sdp });
      });
    },
    ice(peerId, candidate, sdpMid, sdpMLineIndex) {
      if (!peers.has(peerId)) return;
      send({ t: "ice", peer: peerId, candidate, sdpMid, sdpMLineIndex });
    },
    close(peerId) {
      if (peers.delete(peerId)) send({ t: "close", peer: peerId });
    },
    async shutdown() {
      try {
        sock?.destroy();
      } catch {}
      try {
        child?.kill();
      } catch {}
      sock = null;
      child = null;
      ready = false;
    },
  };
}
