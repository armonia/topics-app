import type { AppContext, RouteHandler } from "../types";
import { spawn, execFile } from "child_process";
import { resolve, join } from "path";
import { createInterface } from "readline";
import { getDatabase } from "../db";
import { tmpdir } from "os";
import { writeFile } from "fs/promises";
import { createHash } from "crypto";
import net from "net";
import fs from "fs";
import { augmentPath } from "../utils/path-env";
import { resolveCodexBin } from "../lib/codex-bin";
import { discoverCodexSessionId, codexRolloutExists } from "../lib/codex-session";
import { classifyFrame, isInputEcho, isResizeRepaint } from "../lib/pty-activity";
import type { ClaudeSessionTracker } from "../lib/claude-session-tracker";
import { writeMcpConfigForSession, cleanupMcpConfigForSession } from "../providers/claude-code";
import { claudeTranscriptPath } from "../lib/claude-transcript-path";
import { parseJsonlLine, splitJsonlChunk } from "../lib/claude-session-state";
import { TOPICS_AGENT_SYSTEM_PROMPT, resolveClaudeEffort } from "../lib/topics-agent-prompt";

interface TerminalSession {
  id: string;
  name: string;
  createdAt: string;
  cwd: string;
  command: string;
  cols: number;
  rows: number;
  topicId?: string;
  type: 'shell' | 'claude-code' | 'claude-code-team' | 'codex';
  skipPermissions: boolean;
  claudeSessionId?: string;
  /** OS pid of the PTY's root process (reported by the bridge on create /
   *  reattach). Used by the process detector to attribute listening ports
   *  started under this session to it. */
  ptyPid?: number;
  /** sessionKey of the orchestrator that spawned this session as a sub-agent
   *  (see routes `/api/sessions/:sessionKey/agents/*`). Undefined for every
   *  human-/chat-created session. The ownership guard keys off this so a parent
   *  can only drive the children it spawned, and the UI nests them under it. */
  parentSessionKey?: string;
}

const sessions = new Map<string, TerminalSession>();
const sessionSockets = new Map<string, Set<any>>();

/**
 * Look up a live terminal session by its id. Used by the browser open-pane
 * endpoint to resolve a terminal-originated `open_browser_pane` call (the MCP
 * bridge passes the terminal id as the session-key) when no chat topic matches.
 */
export function getTerminalSessionById(id: string): TerminalSession | undefined {
  return sessions.get(id);
}

/**
 * Active Claude PTY sessions with a known root pid, for the process detector
 * (routes/processes.ts). It walks each ptyPid's descendant tree to attribute
 * listening ports to the session — so a server Claude starts with a bare shell
 * command still shows up in the Processes panel. Shell sessions are excluded:
 * the feature targets servers Claude launches.
 */
export function getClaudeSessionsForDetection(): { ptyPid: number; cwd: string; sessionId: string; name: string }[] {
  const out: { ptyPid: number; cwd: string; sessionId: string; name: string }[] = [];
  for (const s of sessions.values()) {
    if (s.type !== 'claude-code' && s.type !== 'claude-code-team') continue;
    if (!s.ptyPid || s.ptyPid <= 0) continue;
    out.push({ ptyPid: s.ptyPid, cwd: s.cwd, sessionId: s.id, name: s.name });
  }
  return out;
}

// --- Per-session pty activity tracking ----------------------------------
// All pty output flows through handleBridgeMessage's "data" case, so this is
// the single point where we can tell whether a session (notably claude-code)
// is producing output. We mark a session busy on output and idle after a
// quiet window; the active→idle transition is the "task finished" signal.
// Broadcast over the app WS so every client reacts — independent of whether
// a terminal pane is mounted (the old client-only pty pulse missed those).
const TERMINAL_IDLE_MS = 1500;
interface TerminalActivity { busy: boolean; timer: ReturnType<typeof setTimeout> | null; lastAt: number; }
const terminalActivity = new Map<string, TerminalActivity>();
// Last visible-text signature per session, used to filter cosmetic repaints
// (e.g. the animated "/goal active" statusline) so they don't count as pty
// activity and pin a session "busy" forever. See lib/pty-activity.ts.
const lastVisibleSig = new Map<string, string>();
// Time (ms) of the last keystroke we forwarded to each session's pty. An output
// frame arriving within INPUT_ECHO_WINDOW_MS of this is the user's input being
// echoed/redrawn (typing, an autocomplete menu, prompt reflow) — NOT the
// process working — so it must not mark the session busy or revive it. This is
// the fix for "just typing into a Claude Code prompt raises the loading
// spinner". See lib/pty-activity.ts → isInputEcho.
const lastInputAt = new Map<string, number>();
// Time (ms) of the last resize we forwarded to each session's pty. The SIGWINCH
// repaint that follows changes the screen (lines rewrap at the new width)
// WITHOUT the process doing work, so an output frame arriving within
// RESIZE_REPAINT_WINDOW_MS of a resize must not mark the session busy — the fix
// for "loading a caso al resize / all'apertura tab". A wider window than input
// echo because a full repaint round-trips the bridge and can lag a few frames.
// See lib/pty-activity.ts → isResizeRepaint.
const lastResizeAt = new Map<string, number>();

/** Record that the user just sent input to a session's pty (any write: a typed
 *  char, a paste, Enter, an arrow key). Stamped from every write path so the
 *  data handler can recognise the resulting echo frames. */
function noteTerminalInput(id: string) {
  lastInputAt.set(id, Date.now());
}

/** Record that we just resized a session's pty (window/pane resize, divider
 *  drag, sidebar toggle, tab show, focus regain). The data handler treats the
 *  resulting SIGWINCH repaint as non-work so it doesn't flash the spinner. */
function noteTerminalResize(id: string) {
  lastResizeAt.set(id, Date.now());
}

function markTerminalActivity(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  let a = terminalActivity.get(id);
  if (!a) { a = { busy: false, timer: null, lastAt: 0 }; terminalActivity.set(id, a); }
  a.lastAt = Date.now();
  if (!a.busy) {
    a.busy = true;
    _broadcastToAll?.({ type: 'terminal:activity', id, busy: true, kind: session.type });
  }
  if (a.timer) clearTimeout(a.timer);
  a.timer = setTimeout(() => {
    a!.busy = false;
    a!.timer = null;
    // active→idle = the session stopped producing output → likely finished a
    // turn. `finished:true` lets the client raise a notification (it filters
    // to claude-code). `kind` carries the session type for that decision.
    _broadcastToAll?.({ type: 'terminal:activity', id, busy: false, finished: true, kind: session.type });
  }, TERMINAL_IDLE_MS);
}

function clearTerminalActivity(id: string) {
  const a = terminalActivity.get(id);
  if (a?.timer) clearTimeout(a.timer);
  terminalActivity.delete(id);
  lastVisibleSig.delete(id);
  lastInputAt.delete(id);
  lastResizeAt.delete(id);
  // Tell clients to drop any loading state for this session (no `finished`:
  // an exit isn't a completed turn).
  if (a?.busy) _broadcastToAll?.({ type: 'terminal:activity', id, busy: false });
}

/**
 * How long (ms) the PTY for a claude session has been quiet, or null if we have
 * no activity record for it (unknown session, or one that never emitted). Busy
 * → 0. The phase reaper uses this to demote a `running` session ONLY when its
 * PTY has been genuinely silent (not just because a phase hook was missed).
 * Keyed by claudeSessionId because that's the tracker's key; we map it back to
 * the terminal session id via the `sessions` roster.
 */
export function getClaudeSessionPtyIdleMs(claudeSessionId: string): number | null {
  for (const [id, s] of sessions) {
    if (s.claudeSessionId !== claudeSessionId) continue;
    const a = terminalActivity.get(id);
    if (!a) return null;
    if (a.busy) return 0;
    return a.lastAt ? Date.now() - a.lastAt : null;
  }
  return null;
}

// Idempotency cache for POST /api/terminal/sessions retries.
// Client sends X-Idempotency-Key on reopen (paneId:closedAt) so a transient
// 5xx on the HEAD probe doesn't spawn duplicate pty sessions when the client
// retries the POST. 60 s TTL — long enough to cover any realistic retry.
const IDEMPOTENCY_TTL_MS = 60_000;
const idempotencyCache = new Map<string, { sessionId: string; expiresAt: number }>();

function idempotencyLookup(key: string): string | null {
  const entry = idempotencyCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    idempotencyCache.delete(key);
    return null;
  }
  return entry.sessionId;
}

function idempotencyRemember(key: string, sessionId: string): void {
  idempotencyCache.set(key, { sessionId, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
  // Opportunistic sweep — keeps the map bounded without a dedicated timer.
  if (idempotencyCache.size > 128) {
    const now = Date.now();
    for (const [k, v] of idempotencyCache) {
      if (v.expiresAt < now) idempotencyCache.delete(k);
    }
  }
}

// --- Bridge connection (Unix domain socket) ---
let bridgeSocket: net.Socket | null = null;
let bridgeReady = false;
let bridgeConnecting = false;
let bridgeReadyResolvers: (() => void)[] = [];

// Pending buffer requests: sessionId -> callback
const pendingBufferRequests = new Map<string, ((data: Uint8Array) => void)[]>();

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
  const dataDir = process.env.DATA_DIR;
  const basis = dataDir ? `${process.cwd()}\0${dataDir}` : process.cwd();
  const hash = createHash('md5').update(basis).digest('hex').slice(0, 8);
  return `/tmp/topics-pty-bridge-${hash}.sock`;
}

const SOCKET_PATH = getSocketPath();

async function ensureBridge(): Promise<void> {
  if (bridgeReady && bridgeSocket && !bridgeSocket.destroyed) return;
  if (bridgeConnecting) {
    // Wait for the in-flight connection attempt
    return new Promise<void>((resolve) => { bridgeReadyResolvers.push(resolve); });
  }

  bridgeConnecting = true;

  try {
    // Try connecting to existing bridge
    const connected = await tryConnect();
    if (connected) {
      bridgeConnecting = false;
      bridgeReadyResolvers.forEach(r => r());
      bridgeReadyResolvers = [];
      return;
    }

    // No bridge running — spawn one
    const bridgePath = resolve(import.meta.dir, "../pty-bridge.mjs");
    const child = spawn("node", [bridgePath, "--socket", SOCKET_PATH], {
      detached: true,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.unref();

    // Wait for bridge to create socket (poll up to 3 seconds)
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
      if (fs.existsSync(SOCKET_PATH)) {
        const ok = await tryConnect();
        if (ok) break;
      }
    }

    if (!bridgeReady) {
      throw new Error("Failed to connect to PTY bridge after spawning");
    }
  } finally {
    bridgeConnecting = false;
    bridgeReadyResolvers.forEach(r => r());
    bridgeReadyResolvers = [];
  }
}

function tryConnect(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(SOCKET_PATH)) { resolve(false); return; }

    const socket = net.connect(SOCKET_PATH, () => {
      bridgeSocket = socket;
      bridgeReady = true;
      lastPongAt = Date.now();
      setupSocketReader(socket);
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
  rl.on("line", (line: string) => {
    try {
      handleBridgeMessage(JSON.parse(line));
    } catch {}
  });

  socket.on('close', () => {
    bridgeReady = false;
    bridgeSocket = null;
    console.log("[Terminal] Bridge socket closed, will reconnect on next use");
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
        .then(() => reconcileSessions())
        .then(() => broadcastTerminalSessions())
        .catch(() => {});
    }, 500);
  });

  socket.on('error', () => {
    bridgeReady = false;
    bridgeSocket = null;
  });
}

function sendToBridge(msg: any) {
  if (!bridgeSocket || bridgeSocket.destroyed) {
    throw new Error("Bridge not connected");
  }
  bridgeSocket.write(JSON.stringify(msg) + "\n");
}

// --- Create-ack tracking ---
// Pending POST /sessions calls park here until the bridge replies with
// {type:'created', id} or {type:'error', error}. Without this gate the
// API returned 200 even when pty.spawn threw inside the bridge — the
// user got an empty terminal pane and no clue why.
const pendingCreates = new Map<string, { resolve: (pid: number) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function awaitBridgeCreate(id: string, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCreates.delete(id);
      reject(new Error(`Bridge did not ack create within ${timeoutMs}ms`));
    }, timeoutMs);
    pendingCreates.set(id, { resolve, reject, timer });
  });
}

// --- Bridge spawn-failure circuit breaker ---
// After N consecutive 'error' replies from the bridge, treat the bridge
// itself as degraded (the posix_spawnp incident: native node-pty can
// stop spawning anything if the process loses its Aqua session).
// Force a respawn so the next create lands on a fresh bridge.
let consecutiveSpawnErrors = 0;
const SPAWN_ERROR_LIMIT = 3;

function recycleBridge(reason: string) {
  console.warn(`[Terminal] Recycling bridge: ${reason}`);
  if (bridgeSocket && !bridgeSocket.destroyed) {
    try { bridgeSocket.destroy(); } catch {}
  }
  bridgeSocket = null;
  bridgeReady = false;
  // Try to send a SIGTERM to whatever owns the pidfile — see bridge
  // checkExistingBridge for the same logic on the bridge side.
  try {
    const pidPath = SOCKET_PATH.replace(/\.sock$/, '.pid');
    if (fs.existsSync(pidPath)) {
      const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    }
  } catch {}
  // ensureBridge will respawn on next demand.
  ensureBridge().catch(() => {});
}

function handleBridgeMessage(msg: any) {
  switch (msg.type) {
    case "created": {
      consecutiveSpawnErrors = 0;
      const pending = pendingCreates.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingCreates.delete(msg.id);
        pending.resolve(msg.pid);
      }
      break;
    }
    case "error": {
      consecutiveSpawnErrors++;
      // Failed creates: surface to whoever was awaiting that id, if
      // any. The bridge sends `{type:'error', error, id?}` from the
      // catch block in handleMessage — but it doesn't know the id, so
      // we fall back to failing every pending create.
      if (msg.id && pendingCreates.has(msg.id)) {
        const pending = pendingCreates.get(msg.id)!;
        clearTimeout(pending.timer);
        pendingCreates.delete(msg.id);
        pending.reject(new Error(msg.error || 'Bridge error'));
      } else {
        for (const [id, pending] of pendingCreates) {
          clearTimeout(pending.timer);
          pending.reject(new Error(msg.error || 'Bridge error'));
          pendingCreates.delete(id);
        }
      }
      if (consecutiveSpawnErrors >= SPAWN_ERROR_LIMIT) {
        consecutiveSpawnErrors = 0;
        recycleBridge(`${SPAWN_ERROR_LIMIT} consecutive spawn errors`);
      }
      break;
    }
    case "data": {
      const session = sessions.get(msg.id);
      if (!session) break;
      // Central activity signal (loading + finished) — independent of whether
      // any client has the terminal pane mounted. Skip two kinds of frame that
      // change the screen without the PROCESS doing work:
      //   1. cosmetic repaints — an animated statusline redraws the same
      //      visible text forever and would otherwise pin the session "busy".
      //   2. input echo — the user typing/pasting/navigating the prompt makes
      //      the TUI echo or redraw the input line within a few ms; counting
      //      that as activity is the "just typing raises the spinner" bug (and
      //      it would revive a dormant session). isInputEcho gates on how long
      //      ago we forwarded a keystroke to this pty. See lib/pty-activity.ts.
      //   3. resize repaint — a window/pane resize (or a tab becoming visible,
      //      which re-fits xterm) sends SIGWINCH; the TUI repaints at the new
      //      width, rewrapping lines so the frame looks non-cosmetic. That
      //      redraw is the user's resize, not the process working — counting it
      //      is the "loading a caso al resize / all'apertura tab" bug.
      const { cosmetic, sig } = classifyFrame(lastVisibleSig.get(msg.id), msg.data);
      lastVisibleSig.set(msg.id, sig);
      const inAt = lastInputAt.get(msg.id);
      const echo = isInputEcho(inAt !== undefined ? Date.now() - inAt : null);
      const rsAt = lastResizeAt.get(msg.id);
      const resizeEcho = isResizeRepaint(rsAt !== undefined ? Date.now() - rsAt : null);
      if (!cosmetic && !echo && !resizeEcho) {
        markTerminalActivity(msg.id);
        // Real output revives a session the reaper demoted to dormant while it
        // was merely silent (missed Stop hook), so the loading dots come back.
        // No-op unless the phase is actually dormant.
        if (session.claudeSessionId && (session.type === 'claude-code' || session.type === 'claude-code-team')) {
          _tracker?.notePtyActivity(session.claudeSessionId);
        }
      }
      // Forward to connected WebSocket clients (buffer is in bridge)
      const sockets = sessionSockets.get(msg.id);
      if (sockets) {
        for (const ws of sockets) {
          try { ws.send(msg.data); } catch { sockets.delete(ws); }
        }
      }
      break;
    }
    case "exit": {
      const exitedSession = sessions.get(msg.id);
      sessions.delete(msg.id);
      clearTerminalActivity(msg.id);
      // Remove the per-session MCP bridge config written at spawn. A resumable
      // (dormant) claude session rewrites it on revive, so clearing it now is
      // safe — claude isn't running between exit and revive. No-op for shells.
      if (exitedSession?.type === 'claude-code' || exitedSession?.type === 'claude-code-team') {
        cleanupMcpConfigForSession(msg.id);
      }
      const sockets = sessionSockets.get(msg.id);
      if (sockets) {
        for (const ws of sockets) {
          try { ws.close(1000, "Session ended"); } catch {}
        }
        sessionSockets.delete(msg.id);
      }
      if (exitedSession) {
        // Preserve claude-code sessions with a claudeSessionId so the user can
        // click "Resume" and relaunch claude with --resume <sessionId>.
        //
        // BUT: a session that exits within a few seconds of creation —
        // especially with a non-zero code — is a launch failure (e.g. the
        // upstream claude session referenced by --resume is gone). Marking
        // such a session as 'dormant' makes the project window auto-revive
        // it on every reload, which immediately exits again, producing the
        // "chat appears then closes" flicker. Treat those as dead: DELETE
        // the row so they stop haunting the UI.
        const ageMs = Date.now() - new Date(exitedSession.createdAt).getTime();
        const failedQuickly = ageMs < 3000 && msg.exitCode !== 0;
        const canResume = (exitedSession.type === 'claude-code' || exitedSession.type === 'claude-code-team')
          && !!exitedSession.claudeSessionId
          && !failedQuickly;
        try {
          if (canResume) {
            getDatabase().run("UPDATE terminal_sessions SET status = 'dormant' WHERE id = ?", [msg.id]);
          } else {
            if (failedQuickly) {
              console.warn(`[Terminal] Session ${msg.id} exited in ${ageMs}ms with code ${msg.exitCode} — deleting (failed launch).`);
            }
            getDatabase().run("DELETE FROM terminal_sessions WHERE id = ?", [msg.id]);
          }
        } catch {}
        // Mirror the lifecycle into the phase tracker so the loading signal
        // clears: dormant (resumable) → not loading; otherwise forget it.
        if (exitedSession.claudeSessionId && (exitedSession.type === 'claude-code' || exitedSession.type === 'claude-code-team')) {
          if (canResume) {
            _tracker?.noteDormant(exitedSession.claudeSessionId);
          } else {
            if (failedQuickly) _tracker?.notePtyCrash(exitedSession.claudeSessionId, msg.exitCode ?? 1);
            _tracker?.dropTerminalSession(exitedSession.claudeSessionId);
          }
        }
      }
      // A dying orchestrator must not leave drivable orphan sub-agents behind.
      cascadeKillChildren(msg.id);
      broadcastTerminalSessions();
      break;
    }
    case "list": {
      // Response to reconciliation request — handled by reconcileSessions
      handleListResponse(msg.sessions || []);
      break;
    }
    case "buffer": {
      // Response to buffer request
      const callbacks = pendingBufferRequests.get(msg.id);
      if (callbacks) {
        const data = msg.data ? Buffer.from(msg.data, 'base64') : new Uint8Array(0);
        for (const cb of callbacks) cb(new Uint8Array(data));
        pendingBufferRequests.delete(msg.id);
      }
      break;
    }
    case "pong": {
      lastPongAt = Date.now();
      break;
    }
  }
}

// --- Bridge liveness watchdog ---
// Ping every 30 s. If the bridge doesn't pong within 5 s for two
// consecutive intervals, we assume the connection is wedged
// (one-way socket break, daemon hang) and recycle.
let lastPongAt = Date.now();
let watchdogStarted = false;
function startBridgeWatchdog() {
  if (watchdogStarted) return;
  watchdogStarted = true;
  setInterval(() => {
    if (!bridgeReady || !bridgeSocket || bridgeSocket.destroyed) return;
    try { bridgeSocket.write(JSON.stringify({ type: 'ping' }) + '\n'); }
    catch { recycleBridge('ping write failed'); return; }
    setTimeout(() => {
      if (Date.now() - lastPongAt > 60_000) {
        recycleBridge('no pong in 60s');
      }
    }, 5_000);
  }, 30_000).unref();
}

// --- Session reconciliation ---
let reconcileResolver: ((sessions: { id: string; pid: number }[]) => void) | null = null;

function handleListResponse(bridgeSessions: { id: string; pid: number }[]) {
  if (reconcileResolver) {
    reconcileResolver(bridgeSessions);
    reconcileResolver = null;
  }
}

/**
 * Last-resort restore when the bridge never answers `list` (link down). The
 * bridge's PTYs may still be alive, so we must NOT recreate/kill — that's what
 * orphans them. Instead repopulate the in-memory map straight from the DB
 * (without pids) so the client can still attempt to attach to surviving PTYs; a
 * later successful reconcile fills in the pids and prunes anything truly gone.
 */
function restoreDbSessionsOptimistically(): void {
  const db = getDatabase();
  const dbRows = db.query("SELECT * FROM terminal_sessions").all() as any[];
  let restored = 0;
  for (const row of dbRows) {
    if (sessions.has(row.id)) continue;
    sessions.set(row.id, {
      id: row.id,
      name: row.name,
      createdAt: row.created_at || new Date().toISOString(),
      cwd: row.cwd,
      command: row.command,
      cols: row.cols || 120,
      rows: row.rows || 30,
      topicId: row.topic_id || undefined,
      type: row.type || 'shell',
      skipPermissions: row.skip_permissions !== 0,
      claudeSessionId: row.claude_session_id || undefined,
      ptyPid: undefined,
      parentSessionKey: row.parent_session_key || undefined,
    });
    sessionSockets.set(row.id, new Set());
    if (row.claude_session_id && (row.type === 'claude-code' || row.type === 'claude-code-team')) {
      _tracker?.registerTerminalSession(row.claude_session_id);
    }
    restored++;
  }
  console.log(`[Terminal] Optimistically restored ${restored} session(s) from DB (bridge unreachable, PTYs preserved)`);
}

async function reconcileSessions(attempt = 0): Promise<void> {
  // Ask the bridge which PTYs are still alive. CRITICAL: distinguish a real
  // answer (even an empty list) from NO answer (a timeout). The old code
  // resolved a timed-out `list` to `[]` and then ran the destructive branch
  // below (recreate every DB session with --resume, kill "orphans"). So if a
  // server reload reconciled BEFORE the bridge link was ready, it silently
  // orphaned the user's live Claude PTYs — the "This terminal session has
  // expired" bug that appeared after an update. On no-answer we reconnect +
  // retry, and NEVER touch state we can't see.
  const answered = await new Promise<{ ok: boolean; sessions: { id: string; pid: number }[] }>((resolve) => {
    let settled = false;
    reconcileResolver = (s) => { if (!settled) { settled = true; resolve({ ok: true, sessions: s }); } };
    try { sendToBridge({ type: "list" }); } catch { /* not connected yet — let the timeout drive a retry */ }
    setTimeout(() => {
      if (!settled) { settled = true; reconcileResolver = null; resolve({ ok: false, sessions: [] }); }
    }, 2000);
  });

  if (!answered.ok) {
    if (attempt < 8) {
      console.warn(`[Terminal] bridge 'list' unanswered (attempt ${attempt + 1}/8) — reconnecting + retrying; live PTYs left untouched`);
      await ensureBridge().catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
      return reconcileSessions(attempt + 1);
    }
    // ~8s of silence: bridge link is down but its PTYs may still be alive. Do
    // NOT recreate/kill (that orphans them) — restore from DB optimistically.
    console.error("[Terminal] bridge 'list' never answered after retries — restoring DB sessions WITHOUT reconcile to preserve live PTYs");
    restoreDbSessionsOptimistically();
    return;
  }

  const bridgeSessions = answered.sessions;
  const bridgeIds = new Set(bridgeSessions.map(s => s.id));

  // Get DB sessions
  const db = getDatabase();
  const dbRows = db.query("SELECT * FROM terminal_sessions").all() as any[];
  const dbIds = new Set(dbRows.map((r: any) => r.id));
  // pid the bridge reported for each surviving PTY — used to repopulate
  // session.ptyPid after a reload (in-memory state was reset) so the process
  // detector can keep attributing listening ports to the right session.
  const bridgePidById = new Map(bridgeSessions.map(s => [s.id, s.pid]));

  // Bridge has session + DB has it → restore in-memory entry
  for (const row of dbRows) {
    if (bridgeIds.has(row.id)) {
      // Session is alive in bridge — just add to in-memory map
      if (!sessions.has(row.id)) {
        sessions.set(row.id, {
          id: row.id,
          name: row.name,
          createdAt: row.created_at || new Date().toISOString(),
          cwd: row.cwd,
          command: row.command,
          cols: row.cols || 120,
          rows: row.rows || 30,
          topicId: row.topic_id || undefined,
          type: row.type || 'shell',
          skipPermissions: row.skip_permissions !== 0,
          claudeSessionId: row.claude_session_id || undefined,
          ptyPid: bridgePidById.get(row.id),
          parentSessionKey: row.parent_session_key || undefined,
        });
        sessionSockets.set(row.id, new Set());
        // Re-register with the phase tracker (in-memory state was lost on
        // restart). The next hook re-establishes the live phase; until then
        // the client falls back to the pty heuristic.
        if (row.claude_session_id && (row.type === 'claude-code' || row.type === 'claude-code-team')) {
          _tracker?.registerTerminalSession(row.claude_session_id);
        }
        console.log(`[Terminal] Reattached to surviving session ${row.id} (${row.type})`);
      }
    }
  }

  // Bridge has session, DB doesn't → orphaned, kill it
  for (const bs of bridgeSessions) {
    if (!dbIds.has(bs.id)) {
      console.log(`[Terminal] Killing orphaned bridge session ${bs.id}`);
      sendToBridge({ type: "kill", id: bs.id });
    }
  }

  // DB has session, bridge doesn't → recreate or remove
  for (const row of dbRows) {
    if (!bridgeIds.has(row.id)) {
      if ((row.type === 'claude-code' || row.type === 'claude-code-team') && row.claude_session_id) {
        // Claude Code (or team-mode) session — recreate with --resume
        console.log(`[Terminal] Recreating ${row.type} session ${row.id} with --resume`);
        try {
          await createSession(
            row.id, row.name, row.cwd, undefined,
            row.cols || 120, row.rows || 30,
            row.topic_id || undefined, row.type as 'claude-code' | 'claude-code-team',
            row.skip_permissions !== 0, row.claude_session_id,
            row.parent_session_key || undefined,
          );
        } catch (err: any) {
          console.warn(`[Terminal] Failed to recreate session ${row.id}: ${err.message}`);
          // Don't lose a resumable session over a transient boot failure (bridge
          // not ready, momentary spawn error). If its transcript is still on
          // disk it can be revived later, so park it as dormant rather than
          // deleting. Only when the transcript is GONE (truly unrevivable — a
          // --resume would fail forever and re-trigger the "appears then closes"
          // flicker) do we drop the row.
          try {
            const hasTranscript = fs.existsSync(claudeTranscriptPath(row.cwd, row.claude_session_id));
            if (hasTranscript) {
              db.run("UPDATE terminal_sessions SET status = 'dormant' WHERE id = ?", [row.id]);
            } else {
              db.run("DELETE FROM terminal_sessions WHERE id = ?", [row.id]);
            }
          } catch { /* swallow */ }
        }
      } else if (row.type === 'codex') {
        // Codex — RECREATE (don't park dormant) so the pane re-enters the live
        // roster and the client reattaches, exactly like claude-code does with
        // --resume. createSession resumes the prior conversation when we
        // captured a rollout id (row.claude_session_id) and its rollout still
        // exists, else relaunches a fresh codex in the same cwd.
        //
        // Why recreate instead of dormant: a dormant row is only auto-revived
        // by the PROJECT layout (GET /sessions/dormant?cwd=); a STANDALONE
        // (non-project) codex pane has no revive path, so parking it dormant
        // stranded it as "[Session expired]". Recreating here gives standalone
        // AND project codex the same restart-survival, with no client changes.
        console.log(`[Terminal] Recreating codex session ${row.id}${row.claude_session_id ? ' with resume' : ' (fresh)'}`);
        try {
          await createSession(
            row.id, row.name, row.cwd, undefined,
            row.cols || 120, row.rows || 30,
            row.topic_id || undefined, 'codex',
            row.skip_permissions !== 0, row.claude_session_id || undefined,
            row.parent_session_key || undefined,
          );
        } catch (err: any) {
          // Transient boot failure (bridge not ready, spawn error): park dormant
          // so a later project-window /revive can retry, rather than losing the
          // row. The 1h sweep is shell-only (type='shell'), so a dormant codex
          // row survives until then.
          console.warn(`[Terminal] Failed to recreate codex session ${row.id}: ${err.message} — parking dormant`);
          try { db.run("UPDATE terminal_sessions SET status = 'dormant' WHERE id = ?", [row.id]); } catch {}
        }
      } else {
        // Shell session — mark dormant instead of deleting.
        // Client can revive it (creates new PTY in same cwd) or it gets cleaned up after 1h.
        console.log(`[Terminal] Marking shell session ${row.id} as dormant`);
        try { db.run("UPDATE terminal_sessions SET status = 'dormant' WHERE id = ?", [row.id]); } catch {}
      }
    }
  }
}

// --- Buffer request from bridge ---
function requestBuffer(sessionId: string): Promise<Uint8Array> {
  return new Promise((resolve) => {
    if (!bridgeReady) { resolve(new Uint8Array(0)); return; }
    const existing = pendingBufferRequests.get(sessionId) || [];
    existing.push(resolve);
    pendingBufferRequests.set(sessionId, existing);
    sendToBridge({ type: "buffer", id: sessionId });
    // Timeout after 1 second
    setTimeout(() => {
      const cbs = pendingBufferRequests.get(sessionId);
      if (cbs) {
        for (const cb of cbs) cb(new Uint8Array(0));
        pendingBufferRequests.delete(sessionId);
      }
    }, 1000);
  });
}

/**
 * Read a terminal session's scrollback buffer as decoded text.
 * Used by the Master proposal ingest (interactive-claude-primitive AD-2):
 * scrape the human-driven `claude` PTY's output — NOT a model call, so it
 * stays on the subscription. Returns "" if the bridge is down or times out.
 */
export async function getTerminalBuffer(sessionId: string): Promise<string> {
  const bytes = await requestBuffer(sessionId);
  return new TextDecoder().decode(bytes);
}

// --- Session management ---
async function createSession(id: string, name: string, cwd: string, command?: string, cols = 120, rows = 30, topicId?: string, sessionType: 'shell' | 'claude-code' | 'claude-code-team' | 'codex' = 'shell', skipPermissions = true, claudeSessionId?: string, parentSessionKey?: string): Promise<TerminalSession> {
  let file: string;
  let args: string[];
  const isClaudeKind = sessionType === 'claude-code' || sessionType === 'claude-code-team';

  let resolvedClaudeSessionId = claudeSessionId;
  if (isClaudeKind && !resolvedClaudeSessionId) {
    resolvedClaudeSessionId = crypto.randomUUID();
  }

  if (isClaudeKind) {
    file = 'claude';
    args = [];
    if (claudeSessionId) {
      args.push('--resume', claudeSessionId);
    } else if (resolvedClaudeSessionId) {
      args.push('--session-id', resolvedClaudeSessionId);
    }
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    // Nudge the agent to launch servers via the Topics MCP (run_script) so they
    // show up in the Processes panel instead of leaking into the bare shell.
    // --append-system-prompt works in interactive mode and is additive to the
    // project's own CLAUDE.md.
    args.push('--append-system-prompt', TOPICS_AGENT_SYSTEM_PROMPT);
    // Start the interactive session at the same effort tier a Warp shell would
    // ("ultracode" = xhigh). The server runs under launchd with no CLAUDE_EFFORT
    // in its env, and the user's global effortLevel defaults to low, so without
    // an explicit flag every Topics PTY would start at low effort. Tunable via
    // TOPICS_CLAUDE_EFFORT (set "off" to defer to the CLI's own settings).
    const claudeEffort = resolveClaudeEffort();
    if (claudeEffort) args.push('--effort', claudeEffort);
    // Bridge the Topics MCP server into the interactive CLI so a terminal
    // Claude Code can surface a browser pane next to itself (the chat path
    // does the same in providers/claude-code.ts). We key the config by the
    // terminal session id — the MCP tool POSTs to
    // /api/sessions/<id>/browser/open-pane, which the endpoint resolves to
    // THIS terminal (not a chat topic) and opens the browser in the same
    // group as the terminal pane, for both standalone and project layouts.
    // The generated config carries the `topics` bridge plus a curated set of
    // the user's global MCP servers; when scoped we add `--strict-mcp-config`
    // so the CLI uses ONLY that set (otherwise it stays additive and nothing
    // the user had is lost). Policy lives in writeMcpConfigForSession and is
    // env-tunable (TOPICS_SESSION_MCP_ALLOW/DENY/INHERIT_ALL). Cleaned up in
    // the `exit` handler below.
    try {
      const { path: mcpPath, strict } = writeMcpConfigForSession(id);
      args.push('--mcp-config', mcpPath);
      if (strict) args.push('--strict-mcp-config');
    } catch (err) {
      // Non-fatal: a missing bridge just means no open_browser_pane tool.
      console.warn(`[Terminal] MCP config write failed for ${id}:`, err);
    }
  } else if (sessionType === 'codex') {
    // Codex (OpenAI CLI) — spawned the same interactive-PTY way as `claude`,
    // with none of the Claude-specific plumbing (no session-id/--resume, no
    // MCP bridge config, no tracker registration, no skip-permissions flag).
    // Codex sessions carry no claude_session_id, so the dormant sweep treats
    // them like shells (no resumable pointer we track).
    //
    // Resolve the ABSOLUTE path: Codex ships inside Codex.app (not on PATH),
    // and under launchd the server's PATH excludes both Homebrew and the app
    // bundle — a bare `codex` ENOENTs silently, leaving a blank pane. The
    // shared resolver (used by the chat provider too) finds the bundle binary.
    file = resolveCodexBin() ?? 'codex';
    // RESUME the prior conversation when we captured a rollout id for this row
    // AND codex's rollout file still exists on disk (the codex analogue of the
    // claude `--resume` + transcript-exists guard). `claudeSessionId` here is
    // the generic resumable-pointer slot — NOT a claude id; for codex it holds
    // the UUID codex minted for its ~/.codex/sessions rollout, captured
    // post-spawn by scheduleCodexIdCapture (see lib/codex-session.ts). Codex
    // mints its own id, so we never pass --session-id; on a fresh launch
    // claudeSessionId is undefined and we start clean, then capture the id.
    if (claudeSessionId && codexRolloutExists(claudeSessionId)) {
      args = ['resume', claudeSessionId];
    } else {
      args = [];
    }
  } else if (command) {
    const parts = command.split(" ");
    file = parts[0];
    args = parts.slice(1);
  } else {
    file = process.env.SHELL || "/bin/zsh";
    args = ["-l"];
  }

  let env: Record<string, string | null> | undefined;
  if (isClaudeKind) {
    env = { CLAUDECODE: null, PATH: augmentPath() };
    // Master Topic mode: enable Claude Code Agent Teams (experimental).
    // Sub-safe pattern — `claude` runs interactive in PTY, lead delegates
    // to teammates via shared task list (see spec MASTER-01).
    if (sessionType === 'claude-code-team') {
      env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    }
  } else if (sessionType === 'codex') {
    // Same PATH augmentation as claude: under launchd the server has a
    // minimal PATH (no Homebrew), so a bare `codex` would ENOENT silently.
    env = { PATH: augmentPath() };
  }

  // Await the bridge's ack before populating in-memory + DB. If the
  // bridge can't actually spawn (broken native addon, missing
  // binary, lost session context), throw — the API handler returns
  // 502 and the user sees a real error instead of an empty xterm
  // pane that silently never produces output.
  const ackPromise = awaitBridgeCreate(id);
  let ptyPid: number | undefined;
  // Stamp the spawn instant so the codex rollout-id discovery (below) only
  // considers a rollout written at/after this launch, not a stale one.
  const spawnTimeMs = Date.now();
  try {
    sendToBridge({ type: "create", id, shell: file, args, cwd, cols, rows, ...(env ? { env } : {}) });
    ptyPid = await ackPromise; // bridge resolves the create-ack with the PTY pid
  } catch (err) {
    pendingCreates.delete(id);
    throw err;
  }

  const session: TerminalSession = {
    id,
    name,
    createdAt: new Date().toISOString(),
    cwd,
    command: sessionType === 'claude-code' ? 'claude' : (command || file),
    cols,
    rows,
    topicId,
    type: sessionType,
    skipPermissions,
    claudeSessionId: resolvedClaudeSessionId,
    ptyPid,
    parentSessionKey,
  };

  sessions.set(id, session);
  sessionSockets.set(id, new Set());

  try {
    getDatabase().run(
      `INSERT OR REPLACE INTO terminal_sessions (id, name, cwd, command, type, topic_id, cols, rows, skip_permissions, created_at, claude_session_id, parent_session_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, cwd, session.command, sessionType, topicId || null, cols, rows, skipPermissions ? 1 : 0, session.createdAt, resolvedClaudeSessionId || null, parentSessionKey || null]
    );
  } catch (err) {
    // NEVER swallow silently: a failed persist means the session won't survive a
    // server/bridge restart (reconcileSessions has no DB row to reattach or
    // revive). A swallowed CHECK-constraint violation on `type` is exactly how
    // codex/claude-code-team panes vanished on restart before migration 029
    // widened the constraint — log loudly so the next such mismatch is obvious.
    console.error(`[Terminal] FAILED to persist session ${id} (type=${sessionType}) — it will NOT survive a restart:`, err);
  }

  // Register topic-less claude sessions with the tracker so their hooks resolve
  // and drive the authoritative phase signal. Topic-bound ones already have a
  // claude_code_sessions row owned by the chat provider — registerTerminalSession
  // is a no-op for those.
  if (isClaudeKind && resolvedClaudeSessionId) {
    _tracker?.registerTerminalSession(resolvedClaudeSessionId);
  }

  // Codex mints its session UUID itself (no --session-id to pre-assign), so we
  // discover it from the rollout codex writes shortly after start and persist
  // it as the resumable pointer. Runs for BOTH a fresh launch and a resume:
  // resuming may append to the same rollout or spawn a child, and either way we
  // want the pointer to track the latest so the NEXT restart resumes current
  // state. Best-effort + async — failure just leaves the pane non-resumable.
  if (sessionType === 'codex') {
    scheduleCodexIdCapture(id, cwd, spawnTimeMs);
  }

  return session;
}

/**
 * After a codex PTY launches, poll ~/.codex/sessions for the rollout it just
 * wrote (matched by cwd + recency) and stash its UUID on the terminal_sessions
 * row's resumable-pointer slot (`claude_session_id`) + the in-memory session,
 * then rebroadcast so the roster carries it. Bounded, self-cancelling (stops if
 * the pane is closed), and `unref`'d so it never holds the process open.
 */
function scheduleCodexIdCapture(sessionId: string, cwd: string, sinceMs: number): void {
  let attempts = 0;
  const poll = () => {
    if (!sessions.has(sessionId)) return; // pane closed before we captured it
    const found = discoverCodexSessionId({ cwd, sinceMs });
    if (found) {
      const s = sessions.get(sessionId);
      if (s && s.claudeSessionId !== found) {
        s.claudeSessionId = found;
        try {
          getDatabase().run("UPDATE terminal_sessions SET claude_session_id = ? WHERE id = ?", [found, sessionId]);
        } catch (e) {
          console.warn(`[Terminal] codex session-id persist failed for ${sessionId}:`, e);
        }
        broadcastTerminalSessions();
      }
      return;
    }
    if (++attempts < 12) {
      const t = setTimeout(poll, 1000);
      t.unref?.();
    }
  };
  const t = setTimeout(poll, 800);
  t.unref?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-agent orchestrator
// ─────────────────────────────────────────────────────────────────────────────
// Lets ONE Claude session (the parent/orchestrator) spawn and drive other
// interactive `claude` sessions (children) as sub-agents. Everything reuses the
// existing primitives: createSession (interactive PTY = subscription billing,
// NOT --print/SDK), the bridge write, getTerminalBuffer scrape, and the durable
// .jsonl transcript. The ownership guard is the security control — a parent can
// only touch children whose parentSessionKey == its own sessionKey — so the raw
// by-id /send and /buffer routes stay OFF-limits to the model; only these
// /agents/* routes are exposed via MCP.

/** Max spawned-agent ancestry depth (a top-level orchestrator's child = 1). */
const MAX_AGENT_DEPTH = 3;
/** Max live children per parent — a runaway parent can't fork unbounded PTYs. */
const MAX_CHILDREN_PER_PARENT = 5;

/** Count how many spawned-agent ancestors `sessionKey` has (0 = a top-level
 *  orchestrator that was not itself spawned). Walks parentSessionKey chains that
 *  point at known terminal sessions; a chat-topic parent ("topic:..") isn't in
 *  the map, so the walk simply stops there. */
function spawnedAgentDepth(sessionKey: string): number {
  let depth = 0;
  let cur = sessions.get(sessionKey);
  const seen = new Set<string>();
  while (cur?.parentSessionKey && !seen.has(cur.id)) {
    seen.add(cur.id);
    depth++;
    cur = sessions.get(cur.parentSessionKey);
  }
  return depth;
}

/** Live children of a parent (present in the in-memory `sessions` map). */
function liveChildrenOf(parentSessionKey: string): TerminalSession[] {
  return Array.from(sessions.values()).filter(s => s.parentSessionKey === parentSessionKey);
}

/** Resolve a child the caller is allowed to drive, or null. The caller MUST be
 *  the child's recorded parent — this is the orchestrator's whole auth model. */
function resolveOwnedChild(parentSessionKey: string, agentId: string): TerminalSession | null {
  const child = sessions.get(agentId);
  if (!child || child.parentSessionKey !== parentSessionKey) return null;
  return child;
}

/** Hard-gate the /agents/* routes on the gateway token, exactly like the
 *  import-chrome / ref-based browser-bridge endpoints (topics.ts:1554,1600).
 *  spawn_agent launches `claude --dangerously-skip-permissions` with a
 *  caller-supplied prompt — arbitrary code execution — and the server binds
 *  0.0.0.0, so an UNGUARDED route would be unauthenticated RCE for any LAN
 *  peer / local process. The MCP bridge always forwards the token (it's spawned
 *  with --gateway-token whenever the server has one), so the legit path keeps
 *  working. When GATEWAY_TOKEN is unset the whole surface is DISABLED (401) —
 *  the orchestrator is off rather than open, the same trade-off the other
 *  sensitive MCP-bridge endpoints already make. The ownership guard on
 *  send/read/stop is defence-in-depth ON TOP of this, never instead of it. */
function agentAuthOk(req: Request): boolean {
  const expected = process.env.GATEWAY_TOKEN;
  if (!expected) return false;
  return (req.headers.get("x-gateway-token") || "") === expected;
}

/** Kill every live child of a parent that just exited/was deleted. Children are
 *  model-spawned ephemerals, so orphaning them (leaving drivable PTYs with a
 *  dead owner) is worse than reaping them. */
function cascadeKillChildren(parentSessionKey: string) {
  for (const child of liveChildrenOf(parentSessionKey)) {
    try { sendToBridge({ type: "kill", id: child.id }); } catch {}
    // The bridge's `exit` frame will clean up maps/DB/tracker for each child.
  }
}

/** Seed a freshly-spawned `claude` TUI with its first prompt. The TUI isn't
 *  ready to accept input the instant the PTY spawns, and Enter must arrive as a
 *  separate frame to submit — so we bounded-poll the scrollback for a readiness
 *  signal, then write the prompt and (after a beat) a lone CR. Fire-and-forget:
 *  the child runs async; the parent reads its output via read_agent. */
async function seedAgentPrompt(childId: string, prompt: string): Promise<void> {
  const READY_HINTS = ["for shortcuts", "│ >", "╭─", "Bypassing", "Welcome to Claude"];
  let lastLen = -1;
  let stableCount = 0;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (!sessions.has(childId)) return; // child died before we could seed
    const buf = await getTerminalBuffer(childId);
    if (buf && READY_HINTS.some(h => buf.includes(h))) { ready = true; break; }
    // Fallback readiness: output present and length stable across 2 polls.
    if (buf.length > 0 && buf.length === lastLen) {
      if (++stableCount >= 2) { ready = true; break; }
    } else {
      stableCount = 0;
    }
    lastLen = buf.length;
  }
  if (!sessions.has(childId)) return;
  // Even if we never detected a hint, send anyway after the cap — better to try
  // than to silently strand the sub-agent with no prompt.
  void ready;
  noteTerminalInput(childId);
  sendToBridge({ type: "write", id: childId, data: prompt });
  await new Promise(r => setTimeout(r, 150));
  if (!sessions.has(childId)) return;
  noteTerminalInput(childId);
  sendToBridge({ type: "write", id: childId, data: "\r" });
}

interface AgentReadEvent { type: 'assistant' | 'tool_use'; text?: string; name?: string; input?: unknown; }

/** Pull the visible text out of an assistant transcript line. */
function assistantTextFromRaw(raw: any): string {
  const content = raw?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("");
  }
  return "";
}

/** Read a child's structured output from its durable .jsonl transcript (clean
 *  assistant text + tool calls, no ANSI/TUI noise), paging from a byte offset.
 *  Falls back to a raw scrollback scrape when the transcript hasn't been
 *  flushed yet (the first second of a session). */
async function readAgentOutput(
  child: TerminalSession,
  since: number,
): Promise<{ events: AgentReadEvent[]; nextOffset: number; source: "jsonl" | "buffer"; buffer?: string }> {
  if (child.claudeSessionId) {
    const path = claudeTranscriptPath(child.cwd, child.claudeSessionId);
    try {
      const size = fs.statSync(path).size;
      let start = Number.isFinite(since) && since >= 0 ? since : 0;
      if (start > size) start = 0; // file truncated/rotated — re-read from top
      if (start === size) return { events: [], nextOffset: size, source: "jsonl" };
      const fd = fs.openSync(path, "r");
      try {
        const len = size - start;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        const chunk = buf.toString("utf-8");
        const { lines, remainder } = splitJsonlChunk(chunk);
        // Re-read the partial last line next call by stopping the offset before it.
        const nextOffset = size - Buffer.byteLength(remainder, "utf-8");
        const events: AgentReadEvent[] = [];
        for (const line of lines) {
          const ev = parseJsonlLine(line);
          if (!ev) continue;
          if (ev.type === "assistant") {
            const text = assistantTextFromRaw(ev.raw);
            if (text) events.push({ type: "assistant", text });
          } else if (ev.type === "tool_use") {
            events.push({ type: "tool_use", name: ev.name, input: ev.input });
          }
          // user / tool_result / summary / other are intentionally skipped.
        }
        return { events, nextOffset, source: "jsonl" };
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // No transcript yet → fall through to the raw buffer.
    }
  }
  const buffer = await getTerminalBuffer(child.id);
  return { events: [], nextOffset: Number.isFinite(since) ? since : 0, source: "buffer", buffer };
}

// Broadcast current terminal sessions list via WS
let _broadcastToAll: ((msg: any) => void) | null = null;
// Claude session tracker — the authoritative phase machine. Terminal claude
// sessions register here so their hook-driven phase (running/tool-running)
// becomes the solid "is it working" signal, instead of fragile pty bytes.
let _tracker: ClaudeSessionTracker | null = null;
function broadcastTerminalSessions() {
  if (!_broadcastToAll) return;
  const list = Array.from(sessions.values()).map(s => ({
    id: s.id, name: s.name, createdAt: s.createdAt, cwd: s.cwd,
    command: s.command, clients: sessionSockets.get(s.id)?.size || 0,
    topicId: s.topicId, type: s.type,
    // claudeSessionId lets the client map a claude-code pane to its phase in
    // the tracker (the authoritative loading signal).
    claudeSessionId: s.claudeSessionId || null,
    // Sub-agent parentage: lets the roster nest children under the orchestrator
    // that spawned them. null for human-/chat-created sessions.
    parentSessionKey: s.parentSessionKey || null,
    // Authoritative busy snapshot. Lets clients reconcile loading state from
    // the roster instead of relying solely on incremental terminal:activity
    // deltas (which are lost on server restart, WS reconnect, or a dropped
    // message → otherwise a finished session spins forever).
    busy: terminalActivity.get(s.id)?.busy ?? false,
  }));
  _broadcastToAll({ type: 'terminal:sessions', sessions: list });
}

export function createTerminalRouter(ctx: AppContext, tracker?: ClaudeSessionTracker): RouteHandler {
  const { json, readJSON, errorResponse, matchRoute } = ctx;
  _broadcastToAll = ctx.broadcastToAll;
  if (tracker) _tracker = tracker;

  // Connect to bridge and reconcile sessions (async, fire-and-forget)
  ensureBridge()
    .then(() => reconcileSessions())
    .then(() => broadcastTerminalSessions())
    .catch((err) => console.error("[Terminal] Bridge init failed:", err.message));

  return async function terminalRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    if (method === "GET" && pathname === "/api/terminal/sessions") {
      // Lazy cleanup: delete dormant SHELL sessions older than 1 hour.
      //
      // Claude-code sessions (those with a `claude_session_id`) are NEVER
      // auto-deleted: their transcript lives forever under ~/.claude/projects
      // and the row is just a resumable pointer to it. Deleting it by age —
      // as this query used to, keyed on `created_at` — silently lost a user's
      // long-running Claude work the moment it went dormant >1h after creation,
      // even if they used it 30s ago. Those sessions must survive indefinitely
      // (and across restarts) so they stay revivable. Only shells, which carry
      // no resumable state, are swept.
      //
      // The `type = 'shell'` guard is load-bearing, NOT cosmetic: codex rows
      // also carry a NULL claude_session_id (codex has no server-tracked resume
      // pointer — see the codex branch in createSession), so the old
      // `claude_session_id IS NULL` predicate ALONE swept codex too. A codex
      // pane parked dormant by a server restart (reconcileSessions' shell-like
      // else branch) was then hard-deleted after 1h, so the project-layout
      // auto-revive (/sessions/dormant?cwd=) could no longer relaunch it — the
      // "codex disappears" bug. Scoping to type='shell' keeps the original
      // shell sweep while letting dormant codex rows persist as revivable.
      try {
        const db = getDatabase();
        db.run("DELETE FROM terminal_sessions WHERE status = 'dormant' AND claude_session_id IS NULL AND type = 'shell' AND datetime(created_at) < datetime('now', '-1 hour')");
      } catch {}

      const filterTopicId = url.searchParams.get('topicId');
      let values = Array.from(sessions.values());
      if (filterTopicId) {
        values = values.filter(s => s.topicId === filterTopicId);
      }
      const list = values.map(s => ({
        id: s.id, name: s.name, createdAt: s.createdAt, cwd: s.cwd,
        command: s.command, clients: sessionSockets.get(s.id)?.size || 0,
        topicId: s.topicId, type: s.type,
        claudeSessionId: s.claudeSessionId || null,
        parentSessionKey: s.parentSessionKey || null,
        // Authoritative busy snapshot — see broadcastTerminalSessions.
        busy: terminalActivity.get(s.id)?.busy ?? false,
      }));
      return json(list);
    }

    if (method === "POST" && (pathname === "/api/terminal/sessions" || pathname === "/api/terminal/create")) {
      // Honor X-Idempotency-Key so the client can safely retry this POST after
      // a transient failure without spawning a duplicate pty. See the matching
      // logic in client/src/state/pane/adapters/closedTabRecord.ts.
      const idemKey = req.headers.get("x-idempotency-key");
      if (idemKey) {
        const existingId = idempotencyLookup(idemKey);
        if (existingId) {
          const existing = sessions.get(existingId);
          if (existing) {
            return json({
              id: existing.id,
              name: existing.name,
              cwd: existing.cwd,
              command: existing.command,
              createdAt: existing.createdAt,
              topicId: existing.topicId,
              type: existing.type,
              claudeSessionId: existing.claudeSessionId || null,
            });
          }
        }
      }

      const body = await readJSON(req).catch(() => ({}));
      const cwd = body.cwd || process.env.HOME || "/";
      const id = crypto.randomUUID();
      const name = body.name || `Terminal ${sessions.size + 1}`;
      const command = body.command || undefined;
      const cols = body.cols || 120;
      const rows = body.rows || 30;
      const topicId = body.topicId || undefined;
      // Backward-compatible agent choice: absent/unknown `type` = shell, and
      // the pre-existing types behave exactly as before. 'codex' spawns the
      // OpenAI CLI interactively (see createSession).
      const sessionType: 'shell' | 'claude-code' | 'claude-code-team' | 'codex' =
        body.type === 'claude-code-team' ? 'claude-code-team' :
        body.type === 'claude-code' ? 'claude-code' :
        body.type === 'codex' ? 'codex' : 'shell';
      const skipPermissions = body.skipPermissions !== false;

      try {
        await ensureBridge();
        const session = await createSession(id, name, cwd, command, cols, rows, topicId, sessionType, skipPermissions, undefined);
        if (idemKey) idempotencyRemember(idemKey, id);
        broadcastTerminalSessions();
        return json({ id, name, cwd, command: session.command, createdAt: session.createdAt, topicId: session.topicId, type: session.type, claudeSessionId: session.claudeSessionId || null });
      } catch (err: any) {
        // Bridge couldn't spawn — return 502 so the client knows the
        // terminal really didn't start, instead of opening an empty
        // pane against a phantom session id.
        return errorResponse(502, `Failed to create terminal: ${err.message}`);
      }
    }

    // READ a session's scrollback as text (interactive-claude-primitive AD-2).
    // Backs the Master's `read_session` MCP tool + proposal scraping. Reading
    // on-screen output is not a model call → stays on the subscription.
    const bufferMatch = matchRoute(pathname, "/api/terminal/sessions/:id/buffer");
    if (method === "GET" && bufferMatch) {
      const buffer = await getTerminalBuffer(bufferMatch.id);
      return json({ id: bufferMatch.id, buffer });
    }

    const sendMatch = matchRoute(pathname, "/api/terminal/sessions/:id/send");
    if (method === "POST" && sendMatch) {
      const session = sessions.get(sendMatch.id);
      if (!session) return errorResponse(404, "Terminal session not found");
      const body = await readJSON(req).catch(() => ({}));
      const input = body.input || body.text || body.data || "";
      if (!input) return errorResponse(400, "No input provided");
      noteTerminalInput(sendMatch.id);
      sendToBridge({ type: "write", id: sendMatch.id, data: input });
      return json({ ok: true, sent: input.length });
    }

    const resizeMatch = matchRoute(pathname, "/api/terminal/sessions/:id/resize") || matchRoute(pathname, "/api/terminal/:id/resize");
    if (method === "POST" && resizeMatch) {
      const session = sessions.get(resizeMatch.id);
      if (!session) return errorResponse(404, "Terminal session not found");
      const body = await readJSON(req).catch(() => ({}));
      const { cols, rows } = body;
      if (cols && rows) {
        session.cols = cols;
        session.rows = rows;
        // Stamp BEFORE forwarding so the SIGWINCH repaint this provokes is
        // recognised as resize-driven (not process work) by the data handler.
        noteTerminalResize(resizeMatch.id);
        sendToBridge({ type: "resize", id: resizeMatch.id, cols, rows });
      }
      return json({ ok: true });
    }

    const deleteMatch = matchRoute(pathname, "/api/terminal/sessions/:id") || matchRoute(pathname, "/api/terminal/:id");
    if (method === "DELETE" && deleteMatch) {
      const session = sessions.get(deleteMatch.id);
      // Always try to clean up the DB row — the session may be dormant (PTY exited
      // but row kept alive for Resume), in which case `session` is not in memory.
      const db = getDatabase();
      const dbRow = db.query("SELECT id, claude_session_id, type FROM terminal_sessions WHERE id = ?").get(deleteMatch.id) as any;
      if (!session && !dbRow) return errorResponse(404, "Terminal session not found");
      // Capture the claude session id BEFORE we delete the row/map entry so we
      // can forget its tracker phase entry below. The tracker's in-memory
      // `terminalStates` map is ONLY ever dropped here, so without this a deleted
      // claude terminal session leaks its phase entry for the life of the server.
      const claudeSessionId: string | undefined = session?.claudeSessionId || dbRow?.claude_session_id || undefined;
      const sessionType: string | undefined = session?.type || dbRow?.type;
      if (session) {
        sendToBridge({ type: "kill", id: deleteMatch.id });
        sessions.delete(deleteMatch.id);
        const sockets = sessionSockets.get(deleteMatch.id);
        if (sockets) {
          for (const ws of sockets) {
            try { ws.close(1000, "Session killed"); } catch {}
          }
        }
        sessionSockets.delete(deleteMatch.id);
      }
      try { db.run("DELETE FROM terminal_sessions WHERE id = ?", [deleteMatch.id]); } catch {}
      if (claudeSessionId && (sessionType === 'claude-code' || sessionType === 'claude-code-team')) {
        _tracker?.dropTerminalSession(claudeSessionId);
      }
      // Drop the per-session activity bookkeeping (busy timer + lastVisibleSig +
      // lastInputAt). The session-exit path (case "exit") already does this, but
      // an explicit DELETE never hit it, so these Maps grew unbounded across the
      // server's life. Safe (no-op) when there's no entry, e.g. a dormant row.
      clearTerminalActivity(deleteMatch.id);
      // Reap any sub-agents this session spawned (no orphaned drivable PTYs).
      cascadeKillChildren(deleteMatch.id);
      broadcastTerminalSessions();
      return json({ ok: true });
    }

    // --- Dormant sessions: list and revive ---

    if (method === "GET" && pathname === "/api/terminal/sessions/dormant") {
      const db = getDatabase();
      const cwd = url.searchParams.get('cwd');
      const rows = cwd
        ? db.query("SELECT * FROM terminal_sessions WHERE status = 'dormant' AND cwd = ?").all(cwd) as any[]
        : db.query("SELECT * FROM terminal_sessions WHERE status = 'dormant'").all() as any[];
      const list = rows.map((r: any) => ({
        id: r.id, name: r.name, cwd: r.cwd, command: r.command,
        type: r.type, createdAt: r.created_at,
        claudeSessionId: r.claude_session_id || null,
        skipPermissions: r.skip_permissions !== 0,
      }));
      return json(list);
    }

    const reviveMatch = matchRoute(pathname, "/api/terminal/sessions/:id/revive");
    if (method === "POST" && reviveMatch) {
      const db = getDatabase();
      const row = db.query("SELECT * FROM terminal_sessions WHERE id = ? AND status = 'dormant'").get(reviveMatch.id) as any;
      if (!row) return errorResponse(404, "Dormant session not found");
      try {
        await ensureBridge();
        const session = await createSession(
          row.id, row.name, row.cwd, undefined,
          row.cols || 120, row.rows || 30,
          row.topic_id || undefined,
          row.type || 'shell',
          row.skip_permissions !== 0,
          row.claude_session_id || undefined,
          row.parent_session_key || undefined,
        );
        // Mark as active
        try { db.run("UPDATE terminal_sessions SET status = 'active' WHERE id = ?", [row.id]); } catch {}
        broadcastTerminalSessions();
        return json({
          id: session.id, name: session.name, cwd: session.cwd,
          command: session.command, type: session.type,
          claudeSessionId: session.claudeSessionId || null,
        });
      } catch (err: any) {
        return errorResponse(500, `Failed to revive session: ${err.message}`);
      }
    }

    // Cleanup: delete dormant sessions older than 1 hour (lazy, on each GET sessions call)
    // (This runs in the GET /api/terminal/sessions handler above, no separate endpoint needed)

    // Paste image: save to temp file and copy to macOS system clipboard
    if (method === "POST" && pathname === "/api/terminal/paste-image") {
      const body = await readJSON(req).catch(() => ({}));
      const { dataUrl, sessionId } = body;
      if (!dataUrl || !sessionId) return errorResponse(400, "Missing dataUrl or sessionId");

      const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!match) return errorResponse(400, "Invalid data URL");
      const mimeType = match[1];
      const ext = mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : "png";
      const buffer = Buffer.from(match[2], "base64");

      const filename = `claude-paste-${Date.now()}.${ext}`;
      const filePath = join(tmpdir(), filename);
      await writeFile(filePath, buffer);

      if (process.platform === "darwin") {
        const appleClass = ext === "png" ? "PNGf" : "JPEG";
        const script = `set the clipboard to (read (POSIX file "${filePath}") as «class ${appleClass}»)`;
        try {
          await new Promise<void>((resolve, reject) => {
            execFile("osascript", ["-e", script], (err) => err ? reject(err) : resolve());
          });
        } catch (e) {}
      }

      return json({ ok: true, filePath });
    }

    // --- Sub-agent orchestrator: /api/sessions/:sessionKey/agents/* ----------
    // :sessionKey is the CALLER (parent) — the MCP bridge passes the caller's
    // own sessionKey. spawn stamps it as the child's parentSessionKey; send/read/
    // stop are ownership-guarded against it. Token-gated when GATEWAY_TOKEN is
    // set. These are the ONLY cross-session control surface exposed to a model;
    // the raw by-id /send and /buffer routes above remain human/legacy-only.
    {
      const spawnM = matchRoute(pathname, "/api/sessions/:sessionKey/agents/spawn");
      const listM = matchRoute(pathname, "/api/sessions/:sessionKey/agents");
      const sendM = matchRoute(pathname, "/api/sessions/:sessionKey/agents/:agentId/send");
      const readM = matchRoute(pathname, "/api/sessions/:sessionKey/agents/:agentId/read");
      const stopM = matchRoute(pathname, "/api/sessions/:sessionKey/agents/:agentId/stop");

      if (spawnM && method === "POST") {
        if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
        const parentKey = decodeURIComponent(spawnM.sessionKey);
        const body = await readJSON(req).catch(() => ({}));
        const prompt = typeof body.prompt === "string" ? body.prompt : "";
        if (!prompt) return errorResponse(400, "prompt (string) is required");
        if (spawnedAgentDepth(parentKey) + 1 > MAX_AGENT_DEPTH) {
          return errorResponse(429, `sub-agent depth limit (${MAX_AGENT_DEPTH}) reached`);
        }
        if (liveChildrenOf(parentKey).length >= MAX_CHILDREN_PER_PARENT) {
          return errorResponse(429, `max ${MAX_CHILDREN_PER_PARENT} live sub-agents per session`);
        }
        const parent = sessions.get(parentKey);
        const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : (parent?.cwd || process.env.HOME || "/");
        const id = crypto.randomUUID();
        const name = typeof body.name === "string" && body.name ? body.name : `agent ${id.slice(0, 8)}`;
        try {
          await ensureBridge();
          const session = await createSession(id, name, cwd, undefined, 120, 30, undefined, "claude-code", true, undefined, parentKey);
          // The roster broadcast carries parentSessionKey, so the sub-agent
          // immediately appears nested under its parent in the sidebar tree.
          broadcastTerminalSessions();
          // Seed the first prompt once the TUI is ready (async, non-blocking).
          void seedAgentPrompt(id, prompt);
          return json({ agentId: id, name: session.name, cwd: session.cwd });
        } catch (err: any) {
          return errorResponse(502, `Failed to spawn sub-agent: ${err.message}`);
        }
      }

      if (listM && method === "GET") {
        if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
        const parentKey = decodeURIComponent(listM.sessionKey);
        const agents = liveChildrenOf(parentKey).map(s => ({
          agentId: s.id,
          name: s.name,
          cwd: s.cwd,
          claudeSessionId: s.claudeSessionId || null,
          busy: terminalActivity.get(s.id)?.busy ?? false,
        }));
        return json({ agents });
      }

      if (sendM && method === "POST") {
        if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
        const parentKey = decodeURIComponent(sendM.sessionKey);
        const child = resolveOwnedChild(parentKey, decodeURIComponent(sendM.agentId));
        if (!child) return errorResponse(404, "sub-agent not found");
        const body = await readJSON(req).catch(() => ({}));
        const input = typeof body.input === "string" ? body.input : (typeof body.text === "string" ? body.text : "");
        if (!input) return errorResponse(400, "input (string) is required");
        noteTerminalInput(child.id);
        sendToBridge({ type: "write", id: child.id, data: input });
        // Submit it: Enter as a separate frame so the TUI acts on the line.
        await new Promise(r => setTimeout(r, 120));
        noteTerminalInput(child.id);
        sendToBridge({ type: "write", id: child.id, data: "\r" });
        return json({ ok: true, sent: input.length });
      }

      if (readM && method === "GET") {
        if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
        const parentKey = decodeURIComponent(readM.sessionKey);
        const child = resolveOwnedChild(parentKey, decodeURIComponent(readM.agentId));
        if (!child) return errorResponse(404, "sub-agent not found");
        const since = Number(url.searchParams.get("since") || "0");
        const result = await readAgentOutput(child, since);
        return json(result);
      }

      if (stopM && method === "POST") {
        if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
        const parentKey = decodeURIComponent(stopM.sessionKey);
        const child = resolveOwnedChild(parentKey, decodeURIComponent(stopM.agentId));
        if (!child) return errorResponse(404, "sub-agent not found");
        const childClaudeId = child.claudeSessionId;
        sendToBridge({ type: "kill", id: child.id });
        sessions.delete(child.id);
        const sockets = sessionSockets.get(child.id);
        if (sockets) {
          for (const ws of sockets) { try { ws.close(1000, "Sub-agent stopped"); } catch {} }
          sessionSockets.delete(child.id);
        }
        try { getDatabase().run("DELETE FROM terminal_sessions WHERE id = ?", [child.id]); } catch {}
        if (childClaudeId) _tracker?.dropTerminalSession(childClaudeId);
        clearTerminalActivity(child.id);
        broadcastTerminalSessions();
        return json({ ok: true });
      }
    }

    return null;
  };
}

export function handleTerminalWebSocket(ws: any, sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) {
    ws.close(1008, "Session not found");
    return;
  }

  const sockets = sessionSockets.get(sessionId);
  if (sockets) sockets.add(ws);

  // Request output buffer from bridge (async). The buffered scrollback is
  // delivered as ONE binary frame, then we follow it with a `replay-end`
  // control frame (text/JSON) so the client knows where the historical
  // replay ends and live output begins. Without this signal the tab-bar
  // "in-progress" spinner lights up for ~1.5 s on every focus of an idle
  // Claude Code session, just from the backlog being flushed.
  requestBuffer(sessionId).then((buffered) => {
    try {
      if (buffered.byteLength > 0) ws.send(buffered);
      // Always send the marker, even on empty backlog — the client uses
      // it as the gate to start broadcasting `terminal:activity` pulses.
      ws.send(JSON.stringify({ type: "replay-end" }));
    } catch {}
  });

  return {
    message(data: string | Buffer | ArrayBuffer) {
      const input = typeof data === "string" ? data : new TextDecoder().decode(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      noteTerminalInput(sessionId);
      sendToBridge({ type: "write", id: sessionId, data: input });
    },
    close() {
      const s = sessionSockets.get(sessionId);
      if (s) s.delete(ws);
    },
  };
}

// Exported for graceful shutdown — disconnects from bridge without killing it
export function disconnectBridge() {
  if (bridgeSocket && !bridgeSocket.destroyed) {
    bridgeSocket.destroy();
  }
  bridgeSocket = null;
  bridgeReady = false;
}
