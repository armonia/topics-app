import { encodeExitReason, TERMINAL_WS_CLOSE_DORMANT } from "../../shared/terminal-messages";
import { getDatabase } from "../db";
import { bridgeWriteForSession } from "../lib/terminal-suspend-key";
import { shouldCompressFrame } from "../lib/ws-compression";
import fs from "fs";
// runtime-dep-ok: a static import, not a spawn. The compiled server bundles this
// module like any other, so there is no loose .mjs to miss and no runtime to run it.
import { bridgeOutsideGuiSession, guiSessionName } from "../pty-bridge-platform.mjs";
import { classifyFrame, countsAsActivity, isInputEcho, isResizeRepaint } from "../lib/pty-activity";
import { BridgeCreateAcks } from "../lib/bridge-create-ack";
import { formatTerminalKillLog, recordedExitCode, type TerminalKillReason } from "../lib/terminal-kill";
import { cleanupMcpConfigForSession } from "../providers/claude-code";
import { reportChildEnd } from "../lib/subagent-runtime";
import { promptAsPaste } from "../lib/subagent-seed";
import { terminalExited } from "../attention/terminal-turns";
import { parkedByServer, reloadingSessionIds, sessionSockets, sessions } from "./terminal-state";
import { cascadeKillChildren } from "./terminal-children";
import { awaitingBaselineFrame, clearTerminalActivity, lastInputAt, lastResizeAt, lastVisibleSig, markTerminalActivity } from "./terminal-activity";
import { bridgePidPath, bridgeSocket, dropBridgeSocket, ensureBridge, pendingBufferRequests, setActiveBridgeImplementation } from "./terminal-bridge-socket";
import { disarmBridgeRecycle, handleListResponse, noteBridgePong } from "./terminal-bridge-roster";
import { _tracker, broadcastTerminalSessions, orphanedForTest } from "./terminal-registry";

/**
 * One line per session per silent window, not one per keystroke.
 *
 * Typing during a reconnect produces a burst: the same message repeated dozens
 * of times says nothing the first one did not, and buries the reconnect lines
 * that explain it. The counter is reported when the burst ends.
 */
const droppedInput = new Map<string, { n: number; since: number }>();
export function noteDroppedInput(sessionId: string, err: unknown): void {
  const now = Date.now();
  const prev = droppedInput.get(sessionId);
  if (prev && now - prev.since < 10_000) {
    prev.n++;
    return;
  }
  if (prev) {
    console.warn(`[Terminal] ${prev.n} keystroke(s) dropped for ${sessionId} while the bridge was down`);
  }
  droppedInput.set(sessionId, { n: 1, since: now });
  console.warn(`[Terminal] keystroke dropped for ${sessionId}: ${String((err as Error)?.message ?? err)}`);
}

/**
 * Decision for POST /api/terminal/sessions/:id/send, keyed on the session
 * type: the suspend key that freezes Claude Code never counts as sent. The
 * bridge receives `data`; when that is empty the route answers `dropped`
 * instead of `ok` and writes nothing.
 */
export function resolveTerminalSend(
  sessionType: string | undefined,
  input: string,
): { data: string; sent: number; dropped: boolean; pasted: boolean; enter?: boolean } {
  const data = bridgeWriteForSession(sessionType, input);
  if (data === null) return { data: "", sent: 0, dropped: true, pasted: false };
  const sent = Buffer.byteLength(data, "utf8");
  // Long plain text for a Claude TUI goes as one bracketed paste: a plain write
  // over 1022 bytes reached it without its head (lib/subagent-seed.ts). Keys
  // (Enter, arrows, anything with a control byte) and short text stay raw so
  // dialogs and menus keep reading them as keystrokes.
  const claudeTui = sessionType === "claude-code" || sessionType === "claude-code-team";
  // One trailing Enter (the legacy gateway sends `text + "\r"`) is split off and
  // sent as its own key after the paste.
  const enter = data.endsWith("\r");
  const text = enter ? data.slice(0, -1) : data;
  if (claudeTui && Buffer.byteLength(text, "utf8") > PASTE_MIN_BYTES && isPlainText(text)) {
    return { data: promptAsPaste(text), sent, dropped: false, pasted: true, enter };
  }
  return { data, sent, dropped: false, pasted: false };
}

/** Under this many bytes a write reaches the TUI in one piece (macOS reads 1022 at a time). */
export const PASTE_MIN_BYTES = 1000;

/** Printable text, newlines and tabs only: no ESC sequences, no Enter, no other control byte. */
export function isPlainText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || c === 0x7f) return false;
  }
  return true;
}

export function sendToBridge(msg: any) {
  if (!bridgeSocket || bridgeSocket.destroyed) {
    throw new Error("Bridge not connected");
  }
  // Every byte bound for a PTY passes here (keyboard, /send, live-terminals,
  // sub-agent prompts): the one place the ctrl+z that freezes Claude Code
  // cannot slip past the filter. The why is in terminal-suspend-key.
  if (msg.type === "write") {
    const data = bridgeWriteForSession(sessions.get(msg.id)?.type, msg.data);
    if (data === null) return;
    if (data !== msg.data) msg = { ...msg, data };
  }
  bridgeSocket.write(JSON.stringify(msg) + "\n");
}

export function sendTerminalKill(id: string, reason: TerminalKillReason, caller: string): void {
  sendToBridge({ type: "kill", id, reason, caller });
  console.log(formatTerminalKillLog({ sessionId: id, reason, caller }));
}

// --- Create-ack tracking ---
// Pending POST /sessions calls park here until the bridge replies with
// {type:'created', id} or {type:'error', error}. Without this gate the
// API returned 200 even when pty.spawn threw inside the bridge — the
// user got an empty terminal pane and no clue why.
//
// The register lives in server/lib/bridge-create-ack.ts, where its own header
// explains why: an ack that arrives AFTER the caller gave up used to be an
// unhandled rejection, and an unhandled rejection kills the whole server.
export const pendingCreates = new BridgeCreateAcks();

// --- Bridge spawn-failure circuit breaker ---
// After N consecutive 'error' replies from the bridge, treat the bridge
// itself as degraded (the posix_spawnp incident: native node-pty can
// stop spawning anything if the process loses its Aqua session).
// Force a respawn so the next create lands on a fresh bridge.
let consecutiveSpawnErrors = 0;
const SPAWN_ERROR_LIMIT = 3;

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

export function handleBridgeMessage(msg: any) {
  switch (msg.type) {
    case "created": {
      consecutiveSpawnErrors = 0;
      pendingCreates.settle(msg.id, msg.pid);
      break;
    }
    case "error": {
      // `exists` is the bridge refusing a SECOND create for an id it already
      // has (the double /revive). Its PTY layer is perfectly healthy, so it
      // must not feed the circuit breaker: three of these would recycle the
      // bridge and take every live terminal down with it.
      if (msg.code !== "exists") consecutiveSpawnErrors++;
      // Failed creates: surface to whoever was awaiting that id, if
      // any. The bridge sends `{type:'error', error, id?}` from the
      // catch block in handleMessage — but it doesn't know the id, so
      // we fall back to failing every pending create.
      if (msg.id && pendingCreates.has(msg.id)) {
        pendingCreates.fail(msg.id, new Error(msg.error || 'Bridge error'));
      } else {
        pendingCreates.failAll(new Error(msg.error || 'Bridge error'));
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
      //   4. primo frame dopo una RIATTACCATA — il ridisegno dello schermo che
      //      c'era già. `lastVisibleSig` è appena stato seminato qui sopra, che
      //      è tutto ciò che serve; contarlo come attività produce un
      //      `finished` fasullo e una revive fasulla. Vedi awaitingBaselineFrame.
      // La somma delle quattro sta in `countsAsActivity` (lib/pty-activity.ts),
      // pura e testata: qui restano solo i segnali.
      const baseline = awaitingBaselineFrame.delete(msg.id);
      if (countsAsActivity({ baseline, cosmetic, inputEcho: echo, resizeEcho })) {
        markTerminalActivity(msg.id);
        // Real output revives a session the reaper demoted to dormant while it
        // was merely silent (missed Stop hook), so the loading dots come back.
        // No-op unless the phase is actually dormant.
        if (session.claudeSessionId && (session.type === 'claude-code' || session.type === 'claude-code-team')) {
          _tracker?.notePtyActivity(session.claudeSessionId);
        }
      }
      // Forward to connected WebSocket clients (buffer is in bridge).
      //
      // The compress flag is decided per write, and for PTY output the size rule
      // is what does the work: a keystroke echo is 1 B, a cursor move 7 B, a
      // line of output 73 B, so nothing latency critical ever reaches the
      // compressor. What DOES cross one MTU here is a full screen redraw or a
      // scrollback flush, and that is the most compressible traffic on this
      // server: 1,927 B of redraw gzip to 41 B. See server/lib/ws-compression.ts.
      const sockets = sessionSockets.get(msg.id);
      if (sockets) {
        const bytes = typeof msg.data === "string" ? msg.data.length : msg.data.byteLength;
        for (const ws of sockets) {
          const compress = shouldCompressFrame({ type: null, bytes, remote: ws.data.remote === true });
          try { ws.send(msg.data, compress); } catch { sockets.delete(ws); }
        }
      }
      break;
    }
    case "exit": {
      // The e2e orphan fixture: the PTY was killed to reproduce a restart, and
      // the row must survive it. See `orphanTerminalSession`.
      if (orphanedForTest.delete(msg.id)) return;
      const exitedSession = sessions.get(msg.id);
      sessions.delete(msg.id);
      clearTerminalActivity(msg.id);
      // Remove the per-session MCP bridge config written at spawn. A resumable
      // (dormant) claude session rewrites it on revive, so clearing it now is
      // safe — claude isn't running between exit and revive. No-op for shells.
      if (exitedSession?.type === 'claude-code' || exitedSession?.type === 'claude-code-team') {
        cleanupMcpConfigForSession(msg.id);
      }
      const ageMs = exitedSession ? Date.now() - new Date(exitedSession.createdAt).getTime() : 0;
      const failedQuickly = !!exitedSession && ageMs < 3000 && msg.exitCode !== 0;
      const canResume = !!exitedSession
        && (exitedSession.type === 'claude-code' || exitedSession.type === 'claude-code-team')
        && !!exitedSession.claudeSessionId
        && !failedQuickly;
      const reloading = reloadingSessionIds.has(msg.id);
      const exitCode = recordedExitCode(msg.exitCode, parkedByServer.delete(msg.id));
      const sockets = sessionSockets.get(msg.id);
      if (sockets) {
        // A resumable exit is a verdict the client can act on without retrying
        // attach or sending resizes to a PTY that has already gone away.
        const restingVerdict = canResume && !reloading;
        const reason = encodeExitReason(restingVerdict ? 'dormant' : 'ended', exitCode);
        for (const ws of sockets) {
          try { ws.close(restingVerdict ? TERMINAL_WS_CLOSE_DORMANT : 1000, reason); } catch { /* the websocket may already be closed */ }
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
        try {
          if (canResume) {
            // The code is kept WITH the parked row, so a pane opened after the
            // fact reads it too. NULL when the bridge gave none: an unknown
            // code is not a zero.
            getDatabase().run("UPDATE terminal_sessions SET status = 'dormant', exit_code = ? WHERE id = ?", [exitCode, msg.id]);
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
      cascadeKillChildren(msg.id, 'parent-exit');
      broadcastTerminalSessions();
      // Wake the parent CHAT when a sub-agent it spawned exits on its own (or via
      // cascade). The explicit /stop reap path can't reach here — it pre-deletes
      // the session so `exitedSession` would be null — so /stop calls the helper
      // itself. Guarded to topic-parented children inside the helper.
      // A Reload kills the PTY to relaunch it under the SAME id: not the
      // child's end, but the end of the turn it was in, which `--resume` does
      // not go on with.
      if (exitedSession) {
        reportChildEnd(exitedSession, typeof msg.exitCode === 'number' ? msg.exitCode : null, reloadingSessionIds.has(msg.id) ? 'reloaded' : 'exited');
        terminalExited(msg.id, msg.exitCode === 0 || reloadingSessionIds.has(msg.id));
      }
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
      noteBridgePong();
      if (msg.implementation === "rust" || msg.implementation === "node") {
        setActiveBridgeImplementation(msg.implementation);
      }
      // A real pong is the only thing that disarms the escalation: a reconnect
      // must not, or a daemon that accepts connections and answers nothing
      // would loop through soft resets forever and never be SIGTERMed.
      disarmBridgeRecycle();
      // Ponte sopravvissuto alla sessione grafica (logout, crash di WindowServer):
      // i terminali che fa nascere non hanno Portachiavi, appunti né browser.
      // Rifatto, nasce dal server; reconcile riprende le sessioni claude con --resume.
      if (bridgeOutsideGuiSession(msg.session, guiSessionName)) {
        recycleBridge(`bridge outside the GUI session (launchctl managername: ${JSON.stringify(msg.session)})`);
      }
      break;
    }
  }
}

