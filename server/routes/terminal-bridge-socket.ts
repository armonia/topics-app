import { dispatchBridgeLine } from "../lib/terminal-guards";
import { withoutGatewayToken } from "../lib/child-env";
import { STANDALONE_NO_PTY_CODE } from "../../shared/terminal-messages";
import { spawn } from "child_process";
import { basename, dirname, join } from "path";
import { createInterface } from "readline";
import { ptyBridgeOverride, resolvePtyBridgeCommand } from "../lib/pty-bridge-selection";
import { createHash } from "crypto";
import net from "net";
import fs from "fs";
import { tmpdir } from "os";
import { augmentPath } from "../utils/path-env";
import { identifyBridgeProcess, withBridgeProcess, type ActiveBridge, type PtyBridgeRuntimeStatus } from "../lib/pty-bridge-process";
import { envDataDir } from "../lib/data-dir";
import { registerFleetSocket } from "../lib/fleet-usage";
import { formatTerminalKillLog } from "../lib/terminal-kill";
// The same verdict the AI bridge already reached for the same question: a late
// pong is not a dead daemon if bytes are still arriving. See `startBridgeWatchdog`.
import { bridgeWatchdogStep } from "../lib/bridge-watchdog";
import { sessions } from "./terminal-state";
import { broadcastTerminalSessions } from "./terminal-shared";

// The bridge's frames are handled in terminal-bridge-messages.ts, which writes
// back through this socket: importing it here would be a cycle, so it installs this hook.
let bridgeMessageHandler: ((msg: any) => void) | null = null;
export function setBridgeMessageHandler(fn: (msg: any) => void): void { bridgeMessageHandler = fn; }
// The reconcile after a reconnect lives in terminal-bridge-roster.ts, which
// connects through this socket: importing it here would be a cycle, so it installs this hook.
let bridgeReconciler: (() => Promise<void>) | null = null;
export function setBridgeReconciler(fn: () => Promise<void>): void { bridgeReconciler = fn; }

// --- Bridge connection (Unix domain socket) ---
export let bridgeSocket: net.Socket | null = null;
export let bridgeReady = false;
/** The socket path of the connection attempt in flight, or null when there is none. */
let bridgeConnecting: string | null = null;
let bridgeReadyResolvers: (() => void)[] = [];
let suppressBridgeReconnectForTest = false;
export let activeBridge: ActiveBridge = { implementation: "unknown", reason: "notConnected", path: null, pid: null, startedAt: null };

export function getPtyBridgeRuntimeStatus(): PtyBridgeRuntimeStatus {
  return { ...activeBridge, connected: bridgeReady && !!bridgeSocket && !bridgeSocket.destroyed };
}

export function _suppressPtyBridgeReconnectForTest(suppress: boolean): void {
  suppressBridgeReconnectForTest = suppress;
}

// Pending buffer requests: sessionId -> callback. `null` = the bridge did not answer.
export const pendingBufferRequests = new Map<string, ((data: Uint8Array | null) => void)[]>();

function getSocketPath(): string {
  // Explicit override — set ONLY by the E2E harness (global-setup.ts) so a
  // test run gets its own isolated bridge. Without this, the socket is derived
  // from cwd, which the test server shares with the dev/prod server: the test
  // reconcile would then see the live server's Claude PTYs as orphans and kill
  // them (the "running a test wipes my sessions" bug). Production leaves this
  // unset, so its socket path is byte-identical to before — same bridge, live
  // sessions reattach across a server reload.
  const override = process.env.TOPICS_PTY_SOCKET;
  if (override) return override;
  // Defense-in-depth: derive the socket from the DATA INSTANCE, not just cwd.
  // Production leaves DATA_DIR unset (→ cwd alone → byte-identical socket as
  // before). Any server with a custom DATA_DIR — i.e. EVERY test server — gets
  // a DISTINCT socket, so a misconfigured test server (e.g. a restart that
  // forgot to set TOPICS_PTY_SOCKET) can NEVER attach to the production bridge
  // and reconcile-kill its live PTYs. cwd stays in the basis so two checkouts
  // never collide.
  const dataDir = envDataDir();
  const basis = dataDir ? `${process.cwd()}\0${dataDir}` : process.cwd();
  const hash = createHash('md5').update(basis).digest('hex').slice(0, 8);
  // On Windows the pipe is NOT a file: `/tmp/...` does not exist and `net.connect`
  // on such a path fails with ENOENT, which the rest of this file reads as "no
  // bridge" — i.e. terminals that never open. The canonical name of a named pipe is
  // `\\.\pipe\<name>`, and the hash sits inside it unchanged, so the per-instance
  // isolation described above holds word for word.
  if (process.platform === 'win32') return `\\\\.\\pipe\\topics-pty-bridge-${hash}`;
  return `/tmp/topics-pty-bridge-${hash}.sock`;
}

let SOCKET_PATH = getSocketPath();

// The bridge is detached and launchd-reparented, so no ppid walk from the server
// can find it — nor the tree of `claude` CLIs, MCP servers and headless Chromes
// underneath it, which is where most of Topics' RAM actually lives. Declaring the
// socket lets /api/system/status resolve it by command line. See server/lib/fleet-usage.ts.
registerFleetSocket("pty-bridge", SOCKET_PATH);

/**
 * Test seam — puntare il bridge a un altro socket DOPO l'import.
 *
 * Il path si calcola una volta sola, all'import, e in produzione è giusto così
 * (né TOPICS_PTY_SOCKET né DATA_DIR cambiano dopo il boot). Ma sotto `bun test`
 * tutti i file girano nello STESSO processo: il primo che importa questo modulo
 * congela il socket per tutti gli altri, quindi un test con il suo bridge finto
 * non potrebbe mai farsi ascoltare. Cambiare la const in una lettura viva
 * risolveva il test e ne rompeva altri (i file che vengono prima si mettevano a
 * spawnare bridge veri su path nuovi): questa porta la muove solo su richiesta
 * esplicita, e in produzione nessuno la chiama — comportamento identico a prima.
 * `null` ripristina il path derivato dall'ambiente corrente.
 */
export function _setPtyBridgeSocketPath(p: string | null): void {
  SOCKET_PATH = p ?? getSocketPath();
  registerFleetSocket("pty-bridge", SOCKET_PATH);
}

/**
 * Append-only stderr sink for the detached bridge, parked next to its socket so
 * a test/prod instance keeps its own (the socket path already encodes the data
 * instance). Returns null if the file can't be opened — losing the bridge's log
 * is survivable, failing to spawn the bridge is not.
 */
function bridgeLogPath(): string {
  // On Windows the socket is a named pipe: its "name" (`\\.\pipe\...`) is not a
  // filesystem directory, so nothing can be parked next to it. The log goes to TEMP
  // with the pipe's name inside its own, so two instances stay distinct exactly as
  // they do on unix.
  if (process.platform === 'win32') {
    const leaf = SOCKET_PATH.split('\\').pop() || 'topics-pty-bridge';
    return join(tmpdir(), `${leaf}.log`);
  }
  return join(dirname(SOCKET_PATH), `${basename(SOCKET_PATH, ".sock")}.log`);
}

/**
 * The bridge's pidfile. Same story as the log: beside the socket on unix, in TEMP on
 * Windows — and it MUST match the bridge's own `transport::pid_path_for`, which is
 * what writes it. If the two halves pick different paths, `recycleBridge` never finds
 * the owner to retire and a degraded bridge stays there forever.
 */
export function bridgePidPath(): string {
  if (process.platform === 'win32') {
    const leaf = SOCKET_PATH.split('\\').pop() || 'topics-pty-bridge';
    return join(tmpdir(), `${leaf}.pid`);
  }
  return SOCKET_PATH.replace(/\.sock$/, '.pid');
}

/**
 * "Is a bridge already listening?" — a filesystem question on unix (the socket is a
 * file) and not one at all on Windows: `existsSync` on `\\.\pipe\...` ALWAYS answers
 * false, even with a healthy bridge on the other end. Used as a guard before
 * connecting, that answer meant "no bridge, ever" — i.e. terminals that never open.
 * On Windows the question is deferred to the connection attempt, the only thing that
 * actually knows.
 */
function socketMightExist(): boolean {
  if (process.platform === 'win32') return true;
  return fs.existsSync(SOCKET_PATH);
}

/**
 * Why the bridge's log could not be opened, on the occasions it could not.
 *
 * Without this, `stdio` falls back to `'ignore'` and the bridge's stderr goes
 * nowhere: the bridge writes its reason and nobody collects it. The resulting
 * error then says "no log at <path>", which reads as "the bridge said nothing"
 * when what it means is "we were not listening". Those are opposite diagnoses
 * and they send you looking in two different places.
 */
let bridgeLogOpenError: string | null = null;

/** The message of a failed `spawn`, when it failed. See the note at the call. */
let bridgeSpawnError: string | null = null;

function openBridgeLog(): number | null {
  try {
    fs.mkdirSync(dirname(bridgeLogPath()), { recursive: true });
    bridgeLogOpenError = null;
    return fs.openSync(bridgeLogPath(), "a");
  } catch (e) {
    bridgeLogOpenError = e instanceof Error ? e.message : String(e);
    return null;
  }
}

/**
 * L'ultima riga di stderr del ponte, per METTERLA nell'errore.
 *
 * «Failed to connect to PTY bridge after spawning» dice che è andata male, non
 * PERCHÉ: il motivo il ponte l'ha scritto nel suo log, e nessuno lo leggeva. È
 * costato un'indagine intera — le spec E2E del terminale erano rosse da
 * settimane con un timeout su `.xterm-rows` («il terminale non compare»), e la
 * causa era una riga già scritta qui dentro: «Self-test failed: posix_spawnp
 * failed.», cioè `spawn-helper` di node-pty senza bit di esecuzione (vedi
 * scripts/fix-node-pty-exec-bit.ts). Un errore che si porta dietro la sua
 * ragione vale un pomeriggio.
 */
function lastBridgeLogLine(): string | null {
  try {
    const lines = fs.readFileSync(bridgeLogPath(), "utf-8").trim().split("\n");
    return lines[lines.length - 1]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * WHY THE BRIDGE DID NOT ANSWER, in the words that send you to the right place.
 *
 * Pure on purpose: this is the only part of bridge startup worth asserting on,
 * and reaching it through `initBridge` would mean spawning a real process and
 * waiting three seconds for it not to appear. Same cut as `routes/sessionStatus.ts`
 * and `routes/clearPolicy.ts` - the decision moves to where a test can reach it,
 * the caller keeps the plumbing.
 *
 * The four cases are ordered by how early they happen, and that order is the
 * point. A spawn that failed explains everything after it, so it wins over a
 * stale line left in the log by a PREVIOUS bridge - the log is append-only and
 * outlives the process that wrote it, so trusting it first would report the
 * last death instead of this one.
 */
export function bridgeFailureDetail(i: {
  /** `error` from the spawn: the bridge was never born. */
  spawnError?: string | null;
  /** Last stderr line: it was born and said why it died. */
  logLine?: string | null;
  /** Why its log could not be opened: it may have said why, and we discarded it. */
  logOpenError?: string | null;
  logPath: string;
}): string {
  if (i.spawnError) return ` Lo spawn e' fallito: ${i.spawnError}.`;
  if (i.logLine) return ` Il ponte dice: ${i.logLine}`;
  if (i.logOpenError) {
    return (
      ` Il suo log non si e' potuto aprire (${i.logPath}): ${i.logOpenError}.` +
      " Lo stderr del ponte e' stato scartato, quindi questo messaggio non sa perche' sia morto."
    );
  }
  return ` Nessun log in ${i.logPath}: il ponte e' partito e non ha scritto niente prima di sparire.`;
}

/**
 * A bundled PTY bridge the compiled sidecar can spawn on a virgin install (where
 * there's no external bridge and Bun itself can't run node-pty): a self-contained
 * **Rust** bridge binary shipped as a Tauri sidecar, pointed at via
 * TOPICS_PTY_BRIDGE_BIN (desktop-tauri lib.rs). ~0.5 MB, zero Node dependency;
 * a wire-compatible port of pty-bridge.mjs.
 *
 * (A legacy bundled-Node flavour — TOPICS_NODE_BIN + TOPICS_PTY_BRIDGE_PATH — was
 * removed in the 2026-07 env audit; every shipped bundle uses the Rust sidecar.)
 *
 * The DATA_DIR-derived short socket (getSocketPath) keeps this sidecar's bridge from
 * ever touching a real server's — the 2026-07-02 isolation invariant holds either way.
 * Returns the command to spawn (`cmd` + leading `args`), or null when none is bundled
 * so the plain standalone kill-switch path is unchanged.
 */
function bundledBridge(): { cmd: string; args: string[] } | null {
  const rustBin = ptyBridgeOverride();
  if (rustBin) return { cmd: rustBin, args: [] };
  return null;
}

/**
 * Self-contained / standalone mode: the app runs from a compiled sidecar bundle
 * with no external PTY bridge (set by the Tauri shell — desktop-tauri lib.rs
 * decide_upstream_and_spawn). When set, the server NEVER connects to or spawns the
 * bridge: on a virgin machine there is none, the compiled binary can't spawn one
 * (pty-bridge.mjs resolves to a virtualized path), and — critically — a sidecar that
 * accidentally shares a checkout's cwd must be STRUCTURALLY unable to reconcile-kill
 * a real server's live PTYs (the 2026-07-02 incident). Terminal endpoints answer 503.
 *
 * EXCEPTION: a bundledBridge() (the shell-provided Rust bridge binary) re-enables
 * terminals — the sidecar spawns it against its OWN isolated socket, so the
 * standalone concerns above no longer apply.
 *
 * Read LIVE (not a module-const) so a test can flip the env per-case, and accept two
 * spellings: TOPICS_DISABLE_PTY_BRIDGE (precise) and TOPICS_EMBEDDED (the broader
 * "self-contained bundle" flag) — either enables standalone mode.
 */
export function isPtyBridgeDisabled(bridge = bundledBridge()): boolean {
  if (bridge) return false;
  return process.env.TOPICS_DISABLE_PTY_BRIDGE === "1" || process.env.TOPICS_EMBEDDED === "1";
}

/**
 * 503 body for terminal endpoints when the PTY bridge is disabled (standalone).
 *
 * It carries a `code` because 503 is ambiguous on these very routes: the reload
 * endpoint answers 503 too when a session refuses to stop in time, and that one
 * IS worth retrying while this one never is (a standalone shell, a sidecar, and
 * every Windows build have no bridge at all). The client reads the code to pick
 * between "not available in this installation" and "try again".
 */
export function ptyBridgeUnavailable(): Response {
  return new Response(
    JSON.stringify({ error: "terminals not available in standalone mode", code: STANDALONE_NO_PTY_CODE }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

// Exported ONLY for the standalone-gate unit test (assert no connect/spawn when the
// flag is set). Not part of the router's public surface otherwise.
export async function ensureBridge(): Promise<void> {
  const bundled = bundledBridge();
  // Standalone bundle: no external bridge, ever. Returning here makes every call
  // site inert (startup reconcile, reconnect handlers, per-request ensures), so no
  // socket is ever opened and reconcileSessions can never send a `kill`.
  if (isPtyBridgeDisabled(bundled)) return;
  if (bridgeReady && bridgeSocket && !bridgeSocket.destroyed) return;
  if (bridgeConnecting) {
    // Wait for the in-flight connection attempt. One started for another path
    // (`_setPtyBridgeSocketPath` moved it since) connected nothing this caller
    // can use, so it tries again on the path in force now.
    const attemptPath = bridgeConnecting;
    await new Promise<void>((resolve) => { bridgeReadyResolvers.push(resolve); });
    if (attemptPath !== SOCKET_PATH) return ensureBridge();
    return;
  }

  const path = SOCKET_PATH;
  bridgeConnecting = path;

  try {
    // Try connecting to existing bridge
    const connected = await tryConnect();
    if (connected) {
      activeBridge = { implementation: "unknown", reason: "reused", path: null, pid: null, startedAt: null };
      noteBridgeProcess();
      bridgeConnecting = null;
      bridgeReadyResolvers.forEach(r => r());
      bridgeReadyResolvers = [];
      return;
    }
    // The path moved while that connect was in flight. This attempt was for the
    // old one: spawning a bridge on the new one is up to whoever asks for it there.
    if (path !== SOCKET_PATH) return;

    // No bridge running — use the explicit shell bridge, a built checkout Rust
    // binary, or the Node fallback. augmentPath() gives the child the same
    // PATH-hardening every PTY spawn gets, so launchd's minimal PATH still resolves deps.
    // runtime-dep-ok: the `node` branch is UNREACHABLE in an installed app, and
    // structurally so, not by luck. The Tauri shell sets TOPICS_EMBEDDED=1, and
    // isPtyBridgeDisabled() returns early for every embedded run that has no
    // bundledBridge() - so a bundle either uses the Rust sidecar it ships or has
    // no terminals at all (503, with a code the client explains). This line only
    // ever runs from a checkout, where the sibling script and its runtime are
    // both by definition present.
    const selection = bundled
      ? { ...bundled, implementation: "rust" as const, reason: "override" as const, path: bundled.cmd }
      : resolvePtyBridgeCommand();
    const { cmd, args: baseArgs } = selection;
    activeBridge = { implementation: "unknown", reason: selection.reason, path: selection.path, pid: null, startedAt: null };
    // Bridge stderr goes to a LOG FILE, never 'inherit'. Inheriting makes
    // `detached` a lie: the bridge outlives us still holding OUR stderr open,
    // so anything reading this process through a pipe (`| tee`, a test runner)
    // never sees EOF and hangs until killed. A file fd is ours to close the
    // moment the child has it.
    bridgeSpawnError = null;
    const logFd = openBridgeLog();
    // `--parent-pid` is how the bridge decides it has been abandoned. Without it
    // it can only guess from its own ppid, and a server that dies while the
    // bridge is still booting used to leave it immortal (see the orphan monitor
    // in pty-bridge.mjs). An older bundled bridge ignores the extra flag.
    const child = spawn(cmd, [...baseArgs, "--socket", SOCKET_PATH, "--parent-pid", String(process.pid)], {
      detached: true,
      stdio: ['ignore', 'ignore', logFd ?? 'ignore'],
      // No gateway token: the bridge merges its own env into every terminal it opens.
      env: { ...withoutGatewayToken(), PATH: augmentPath() },
    });
    /**
     * THE SPAWN ERROR HAS TO BE COLLECTED, or it is lost by construction.
     *
     * `detached` + `unref()` detach the child from this process, but they do
     * not change the fact that a failed spawn emits `error` on THIS object:
     * ENOENT when the command is not there, EACCES when it is there and is not
     * executable. With no listener that event has no recipient, and on an
     * `EventEmitter` an unheard `error` is worse than lost: Node rethrows it.
     *
     * EACCES is the concrete case, not a hypothesis. It is node-pty's
     * `spawn-helper` without its exec bit, the same fault the note on
     * `lastBridgeLogLine` records as having cost a whole investigation. That
     * time the bridge did start and did write its reason to the log; when it
     * never starts there is no log to read, and the final error said "no log
     * at ...". That accused the bridge of being mute when it was never born.
     */
    child.once("error", (e: Error) => { bridgeSpawnError = e.message; });
    child.unref();
    if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* already closed */ } }

    // Wait for bridge to create socket (poll up to 3 seconds)
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
      // A bridge that never started will not start during the remaining wait.
      // Without this, every terminal opened on a broken install pays the full
      // three seconds to learn something already known at the first tick.
      if (bridgeSpawnError) break;
      if (socketMightExist()) {
        const ok = await tryConnect();
        if (ok) break;
      }
    }

    if (!bridgeReady) {
      // Three possible reasons, and they must be told apart because each
      // sends you to a different place: the bridge was never BORN (spawn
      // failed), it was born and said why it died (the log), or we were not
      // listening (log could not be opened). Before, every case wore the
      // third one's words.
      const detail = bridgeFailureDetail({
        spawnError: bridgeSpawnError,
        logLine: lastBridgeLogLine(),
        logOpenError: bridgeLogOpenError,
        logPath: bridgeLogPath(),
      });
      throw new Error(
        `Failed to connect to PTY bridge after spawning (${cmd} --socket ${SOCKET_PATH})` + detail,
      );
    }
    noteBridgeProcess();
  } finally {
    bridgeConnecting = null;
    bridgeReadyResolvers.forEach(r => r());
    bridgeReadyResolvers = [];
  }
}

/** Which bridge holds the socket and since when, read from the OS once per connection (TERM-13). */
function noteBridgeProcess(): void {
  const socket = bridgeSocket;
  void identifyBridgeProcess(SOCKET_PATH).then((info) => {
    if (info && bridgeSocket === socket) activeBridge = withBridgeProcess(activeBridge, info);
  });
}

function tryConnect(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!socketMightExist()) { resolve(false); return; }

    const path = SOCKET_PATH;
    const socket = net.connect(path, () => {
      // `_setPtyBridgeSocketPath` moved the bridge while this connect was in
      // flight. Adopting the socket would send every frame, `create` included,
      // to a bridge on the old path, which is not the one anybody asks for now.
      if (path !== SOCKET_PATH) { socket.destroy(); resolve(false); return; }
      bridgeSocket = socket;
      bridgeReady = true;
      noteBridgePong();
      setupSocketReader(socket);
      socket.write(JSON.stringify({ type: 'ping' }) + '\n');
      startBridgeWatchdog();
      console.log("[Terminal] Connected to PTY bridge daemon");
      resolve(true);
    });

    socket.on('error', () => {
      resolve(false);
    });

    // Timeout after 1 second
    setTimeout(() => {
      if (!bridgeReady) {
        socket.destroy();
        resolve(false);
      }
    }, 1000);
  });
}

function setupSocketReader(socket: net.Socket) {
  const rl = createInterface({ input: socket });
  /**
   * THE READLINE RE-EMITS THE SOCKET'S ERROR, AND NOBODY WAS LISTENING.
   *
   * Node (since v20) and Bun from 1.4 forward every `error` of the input
   * stream onto the `Interface` itself. The socket's own handler below does
   * the real work; this listener is there so the copy has a recipient, because
   * an `error` with no listener is rethrown from `emit`, and this process has
   * no `uncaughtException` handler: one `write EPIPE` on the bridge socket,
   * i.e. the bridge hanging up while a `buffer`/`create` is in flight, would
   * take the whole server down instead of scheduling the reconnect. Bun 1.3
   * did not forward, which is why the Mac never saw it and the Linux CI
   * (`bun-version: latest`) did — `terminal-input-dropped.test.ts`.
   */
  rl.on("error", () => { /* handled on the socket itself, see below */ });
  rl.on("line", (line: string) => {
    // Any line at all is proof of life, even one we cannot parse. The watchdog
    // reads this, not just the pong.
    noteBridgeByte();
    if (bridgeMessageHandler) dispatchBridgeLine(line, bridgeMessageHandler);
  });

  socket.on('close', () => {
    bridgeReady = false;
    bridgeSocket = null;
    activeBridge = { implementation: "unknown", reason: "disconnected", path: null, pid: null, startedAt: null };
    console.log(suppressBridgeReconnectForTest
      ? "[Terminal] Bridge socket closed"
      : "[Terminal] Bridge socket closed, will reconnect on next use");
    if (suppressBridgeReconnectForTest) return;
    // Auto-reconnect after a short delay, then RECONCILE. If the bridge process
    // itself died (not just a socket blip), `ensureBridge` spawns a FRESH, empty
    // bridge — its PTYs are gone. Without reconciling, the surviving claude-code
    // sessions stay in our in-memory/DB map advertised as alive, but the new
    // bridge has no PTY for them, so every terminal WS connect replays an empty
    // buffer → permanently blank Claude tabs until a full server restart. Re-
    // running reconcileSessions re-spawns each survivor with `--resume` (and
    // parks the unrevivable ones as dormant), exactly like boot does. It is
    // idempotent: if we reconnected to a bridge that still owns the PTYs, the
    // bridge's `list` reports them and reconcile only reattaches — no double
    // spawn. broadcastTerminalSessions afterwards pushes the refreshed list.
    setTimeout(() => {
      ensureBridge()
        .then(() => bridgeReconciler?.())
        .then(() => broadcastTerminalSessions())
        // Not swallowed: a bridge that cannot be respawned here (ENOENT, EACCES,
        // a dead sidecar) is otherwise the one failure with no line in the log,
        // and nothing retries until a route calls ensureBridge again.
        .catch((e: unknown) => console.warn("[Terminal] reconnect after bridge close failed:", e instanceof Error ? e.message : String(e)));
    }, 500);
  });

  socket.on('error', (err: NodeJS.ErrnoException) => {
    bridgeReady = false;
    bridgeSocket = null;
    // 'close' follows and schedules the reconnect; this line is the only place
    // the REASON is written (EPIPE = the bridge hung up mid-write, ECONNRESET
    // = it died), and "Bridge socket closed" alone said nothing about it.
    console.warn(`[Terminal] Bridge socket error: ${err.code ?? err.message}`);
  });
}


// Exported for graceful shutdown — disconnects from bridge without killing it
export function disconnectBridge() {
  if (bridgeSocket && !bridgeSocket.destroyed) {
    bridgeSocket.destroy();
  }
  bridgeSocket = null;
  bridgeReady = false;
}


/** Forget the socket and the ready flag (a recycle, a soft reset): the next
 *  `ensureBridge` connects afresh. */
export function dropBridgeSocket(): void {
  bridgeSocket = null;
  bridgeReady = false;
}

export function setActiveBridgeImplementation(implementation: "rust" | "node"): void {
  activeBridge = { ...activeBridge, implementation };
}

// --- Bridge liveness watchdog ---
/*
 * Ping every 30s. A bridge that is genuinely wedged (one-way socket break,
 * hung daemon) has to be recycled, because nothing else will unstick it.
 *
 * A LATE PONG IS NOT A DEAD BRIDGE, and treating it as one is expensive here in
 * a way it is not elsewhere: `recycleBridge` SIGTERMs the daemon, whose
 * `shutdown()` walks every session and calls `s.pty.kill()`. Every terminal on
 * the machine dies, including the ones that were mid-turn. Measured in
 * `topics-server.log` on 2026-08-21: 31 recycles, 31 of them for `no pong in
 * 60s`, and two of those are sandwiched between the OTHER bridge's watchdog
 * lines, i.e. it was the SERVER that was stalled, not the daemon. The loss is
 * on the record: one recycle is followed by ten `Failed to recreate session
 * <uuid>: Bridge not connected`.
 *
 * So the verdict is the one `ai-bridge-client.ts` already reached for the same
 * question: `shouldRecycleSocket` is only true when the pong is late AND no
 * BYTES have arrived either. A pong rides the same queue as everything else and
 * can sit behind tens of MB of replay; a byte in that window proves the daemon
 * is alive and talking.
 *
 * And when it is true, it escalates in two steps instead of one. First a plain
 * socket reset, which costs nothing (the `close` handler reconnects and
 * reconciles) and cures the one-way break. The SIGTERM, which is the one that
 * kills PTYs, only fires if the bridge is STILL mute after that, so the case
 * the watchdog was born for is still covered.
 */
export let lastPongAt = Date.now();
/** Last byte received from the daemon, whoever it was for. See `setupSocketReader`. */
export let lastByteAt = Date.now();
/** When the soft stage fired. Cleared by a real pong, never by a reconnect. */
export let recycleArmedAt = 0;
let watchdogStarted = false;
export function startBridgeWatchdog() {
  if (watchdogStarted) return;
  watchdogStarted = true;
  setInterval(() => {
    if (!bridgeReady || !bridgeSocket || bridgeSocket.destroyed) return;
    try { bridgeSocket.write(JSON.stringify({ type: 'ping' }) + '\n'); }
    catch { recycleBridge('ping write failed'); return; }
    setTimeout(() => {
      const now = Date.now();
      const action = bridgeWatchdogStep(now, lastPongAt, lastByteAt, recycleArmedAt);
      if (action === 'ok') return;
      if (action === 'soft-reset') {
        recycleArmedAt = now;
        console.warn('[Terminal] Bridge mute for 60s (no pong, no bytes): resetting the socket, PTYs untouched');
        if (bridgeSocket && !bridgeSocket.destroyed) {
          try { bridgeSocket.destroy(); } catch { /* the socket may already be destroyed */ }
        }
        dropBridgeSocket();
        return;
      }
      recycleArmedAt = 0;
      recycleBridge('still mute 30s after a socket reset');
    }, 5_000);
  }, 30_000).unref();
}

export function recycleBridge(reason: string) {
  console.warn(`[Terminal] Recycling bridge: ${reason}`);
  if (bridgeSocket && !bridgeSocket.destroyed) {
    try { bridgeSocket.destroy(); } catch { /* the socket may already be destroyed */ }
  }
  dropBridgeSocket();
  // Try to send a SIGTERM to whatever owns the pidfile — see bridge
  // checkExistingBridge for the same logic on the bridge side.
  try {
    const pidPath = bridgePidPath();
    if (fs.existsSync(pidPath)) {
      const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 'SIGTERM');
          for (const session of sessions.values()) {
            console.warn(formatTerminalKillLog({
              sessionId: session.id,
              reason: 'bridge-recycle',
              caller: 'recycleBridge',
              detail: reason,
            }));
          }
        } catch { /* the old bridge may already be gone; the respawn below replaces it */ }
      }
    }
  } catch { /* an unreadable or missing pidfile means no old bridge to stop */ }
  // ensureBridge will respawn on next demand.
  ensureBridge().catch(() => {});
}

export function noteBridgePong(): void { lastPongAt = Date.now(); }
export function noteBridgeByte(): void { lastByteAt = Date.now(); }
export function disarmBridgeRecycle(): void { recycleArmedAt = 0; }
