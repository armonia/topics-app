import type { AppContext, RouteHandler } from "../types";
import type { TerminalSessionType } from "../../shared/terminal-session-types";
import { encodeExitReason, ROSTER_RECONCILED_HEADER, TERMINAL_INPUT_DROPPED, TERMINAL_WS_CLOSE_DORMANT, TERMINAL_WS_CLOSE_REPLAY_UNANSWERED } from "../../shared/terminal-messages";
import { getDatabase } from "../db";
import { warnThrottled } from "../lib/warn-throttled";
import { shouldCompressFrame } from "../lib/ws-compression";
import { createIdempotencyCache } from "../lib/idempotency-cache";
import { agentAuthOk } from "../lib/agent-auth";
import { clientProjectPathRefused } from "../lib/client-project-path";
import { idleParkThresholdMs, thresholdUnderPressure } from "../lib/terminal-idle-park";
import { recordRetirement } from "../services/retirement";
import { renderScreen, screenToText } from "../lib/terminal-screen";
import type { ClaudeSessionTracker } from "../lib/claude-session-tracker";
import { normalizePromptSnippet } from "../lib/claude-subagent-transcript";
import { resolveSubagentLaunch } from "../lib/subagent-launch";
import { endedSubagents, getSubagent, insertSubagent, resumeVerdict, setSubagentState } from "../lib/subagent-store";
import { childRuntimeFor, engineLaunchOf, liveNativeChildren, moveCliChildToEngine, nativeChildPlace, placeableUnderKnownProject, readNativeChildOutput, sendToNativeChild, spawnNativeChild, stopNativeChild } from "../lib/native-subagents";
import { FOREGROUND_WAIT_MS, bootChildSweep, childPhase, holdForeground, noteChildSeeded, noteChildSteered, chatParentModel, parentTranscriptModel, readAgentOutput, releaseForeground, startChildWatch, subagentLimitRefusal, waitForegroundLeg } from "../lib/subagent-runtime";
import { promptAsPaste } from "../lib/subagent-seed";
import { boardSpawnRefusal } from "../services/agent-census";
import { resolveClaudeEffort, topicEffortFor } from "../lib/topics-agent-prompt";
import { isGlobalOrchestratorSession } from "../services/global-orchestrator-session";
import { createAgentWorktree, resolveAgentProject, worktreeReadyMs } from "../services/worktree-for-agent";
import { agentWorkspaceForSession } from "../lib/agent-workspace";
import { type TerminalSession, reloadingSessionIds, revivingSessions, sessionSockets, sessions, terminalMemPressure } from "./terminal-state";
import { agentProfilesFor, boardAgentCap, boardSpawnMode, childrenBeingResumed, endedChildForRead, isCodexBridgeOnlyTopic, liveChildrenOf, resolveOwnedChild, seedAgentPrompt, seedPromptFingerprintForSession, spawnedAgentDepth, stopLiveCliChild, subAgentNotFound } from "./terminal-children";
import { scheduleClaudeSubAgentIdCapture } from "./terminal-subagent-transcript";
import { PASTE_ENTER_DELAY_MS, getTerminalBuffer } from "./terminal-queries";
import { noteTerminalInput, noteTerminalResize, terminalActivity } from "./terminal-activity";
import { ensureBridge, isPtyBridgeDisabled, ptyBridgeUnavailable } from "./terminal-bridge-socket";
import { noteDroppedInput, resolveTerminalSend, sendTerminalKill, sendToBridge } from "./terminal-bridge-messages";
import { NOT_A_SUBAGENT, isRosterDependentRoute, reconcileSessions, requestBuffer, rosterReconciled, rosterWarming } from "./terminal-bridge-roster";
import { createSession } from "./terminal-session-create";
import { setTerminalBroadcast, setTerminalTracker, setTerminalWorktreeStore, branchOfCwd, broadcastTerminalSessions, parkIdleClaudeSessions, reportCeiling, retireTerminalSession } from "./terminal-registry";
export { noteSubAgentStopHook, retireIdleSubAgents, _forgetSubAgentMemory } from "../lib/subagent-runtime";
export { setTerminalBrowserCloser, setTerminalMemPressure } from "./terminal-state";
export type { TerminalSession } from "./terminal-state";
export { setSubAgentExitHandler, boardAgentCap, setChildAdmissionPreview, boardSpawnMode, liveCliChildren, _setAgentProfilesHome, seedPromptForSession, seedPromptFingerprintForSession, _setSeedPromptHandlerForTests } from "./terminal-children";
export { getTerminalSessionById, getAgentPtyCliPids, listTerminalOwners, getClaudeSessionsForDetection, listTerminalSessionSnapshot, listTopicsLiveTerminals, readTopicsTerminalScreen, writeTopicsTerminal, countAttachedTerminalSessions, countBusyAgentTerminals } from "./terminal-queries";
export { getClaudeSessionPtyIdleMs } from "./terminal-activity";
export { getPtyBridgeRuntimeStatus, _suppressPtyBridgeReconnectForTest, _setPtyBridgeSocketPath, bridgeFailureDetail, isPtyBridgeDisabled, ensureBridge, disconnectBridge } from "./terminal-bridge-socket";
export { resolveTerminalSend } from "./terminal-bridge-messages";
export { _resetRosterReconciled } from "./terminal-bridge-roster";
export { autoNameClaudeSession } from "./terminal-session-create";
export { _setTerminalTrackerForTests, _terminalSessionsForTests, noteClaudeHookSession, liveTerminalCwds, retireTerminalSession, parkIdleClaudeSessions, parkOrphanSessions, orphanTerminalSession, parkTerminalSession } from "./terminal-registry";

/** A Claude session id lands straight in an argv (`--resume <id>`): it passes
 *  only with uuid shape, never an arbitrary string from the body. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id to resume when a NEW terminal pane opens, or `undefined` to
 * start from a fresh session.
 *
 * `createSession` already does both (`--resume <id>` when the id is there,
 * `--session-id <new>` otherwise), but the POST handler passed `undefined` and
 * that was it: the client was sending the id (`closedTabRecord.ts`) and the server
 * threw it away. Reopening a closed Claude Code tab thus restarted an
 * EMPTY session looking the same — with no way to say "open THIS
 * session as a terminal pane", though holding its id.
 *
 * Two conditions, neither cosmetic:
 *  • only for claude types — on a shell a session id means
 *    nothing, and passing it would start a `--resume` on a binary that cannot
 *    read it;
 *  • only when a uuid — this value comes from an HTTP body and lands in an
 *    argv.
 */
export function resumeIdForNewSession(
  raw: unknown,
  sessionType: TerminalSessionType,
): string | undefined {
  if (sessionType !== 'claude-code' && sessionType !== 'claude-code-team') return undefined;
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) return undefined;
  if (!UUID_RE.test(id)) {
    console.warn(`[Terminal] claudeSessionId ignorato: non è un uuid`);
    return undefined;
  }
  return id;
}


// Idempotency cache for POST /api/terminal/sessions retries.
// Client sends X-Idempotency-Key on reopen (paneId:closedAt) so a transient
// 5xx on the HEAD probe doesn't spawn duplicate pty sessions when the client
// retries the POST. 60 s TTL — long enough to cover any realistic retry.
// Logic + tests live in ../lib/idempotency-cache; this is the route's singleton.
const idempotencyCache = createIdempotencyCache();


export function createTerminalRouter(ctx: AppContext, tracker?: ClaudeSessionTracker): RouteHandler {
  const { json, readJSON, errorResponse, matchRoute } = ctx;
  setTerminalBroadcast(ctx.broadcastToAll);
  setTerminalWorktreeStore(ctx.worktreeStore);
  if (tracker) setTerminalTracker(tracker);

  // Connect to bridge and reconcile sessions (async, fire-and-forget).
  //
  // THE RECONCILE RUNS EVEN WHEN THE FIRST CONNECT FAILS. It used to hang off
  // `.then` of `ensureBridge()`, so a rejection skipped it, and the reconcile is
  // the only thing that promotes `rosterReconciled`. A bridge that needs more
  // than the 3s spawn deadline - a cold CI runner - rejects here and then comes
  // up anyway: the next POST connects to it lazily and creates sessions, but
  // the warming gate keeps answering 503 to every DELETE, resize, send and
  // rename on them for the life of the process. Measured in CI: run 34799985301
  // shard 1, one "Bridge init failed" at boot, then 9.282 `DELETE ... 503` from
  // the e2e teardown and every later file red at 0 ms; "roster warming finished
  // - 9299 request(s)" only appeared when the bridge socket closed at teardown.
  // Same signature on main in runs 34669019794 and 34675029755 (shard 4).
  //
  // `reconcileSessions` already owns the slow-bridge case: an unanswered `list`
  // reconnects and retries, and after eight tries it restores from the DB and
  // promotes. It just has to be reached.
  ensureBridge()
    .catch((err) => console.error("[Terminal] Bridge init failed:", err.message))
    .then(() => reconcileSessions())
    .then(() => broadcastTerminalSessions())
    .then(() => bootChildSweep())
    .catch((err) => console.error("[Terminal] boot reconcile failed:", err instanceof Error ? err.message : String(err)));

  // The turns of the live sub-agents, and their retirement (SUBAGENT-11, 14):
  // a Claude TUI never exits at the end of a turn, so the end is read from the
  // transcript on this tick. One timer for the module, however many routers.
  startChildWatch();

  // Parcheggio delle sessioni ferme. SPENTO se `TOPICS_TERMINAL_IDLE_PARK_MS`
  // non c'è, che è il default: vedi `idleParkThresholdMs` per il perché (una
  // sessione parcheggiata si vede, finché la pane non la rianima).
  const parkThresholdMs = idleParkThresholdMs(process.env);
  if (parkThresholdMs !== null) {
    // Si guarda ogni minuto, non ogni soglia: la soglia è quanto una sessione
    // dev'essere ferma, non ogni quanto la si controlla.
    const timer = setInterval(() => {
      try {
        // The threshold tightens when the machine is at the ceiling: an idle
        // session costs swap by then, not just RAM. See `thresholdUnderPressure`.
        let pressure: { atCeiling: boolean } | null = null;
        try { pressure = terminalMemPressure?.() ?? null; }
        catch { pressure = null; } // a broken probe must not speed up the reaper
        const threshold = thresholdUnderPressure(parkThresholdMs, pressure);
        // An unknown reading is no news about the ceiling: it must not print an exit.
        reportCeiling(parkThresholdMs, pressure ? threshold : null);
        parkIdleClaudeSessions(threshold);
      }
      catch (err) { console.warn(`[Terminal] sweep di parcheggio fallito:`, (err as Error).message); }
    }, 60_000);
    timer.unref?.();
    console.log(
      `[Terminal] Parcheggio sessioni ferme attivo: soglia ${Math.round(parkThresholdMs / 60_000)} min.`,
    );
  }

  return async function terminalRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // Standalone bundle (no PTY bridge): the terminal endpoints answer 503 with a
    // clear reason rather than trying to reach a bridge that isn't there. Scoped
    // TIGHTLY to the routes THIS router owns — the terminal API and the sub-agent
    // orchestrator (/api/sessions/:key/agents/*). NOT the whole /api/sessions/
    // prefix: processes.ts owns /api/sessions/:key/scripts/* (the process registry),
    // which is bridge-independent and must keep working standalone. Returning null
    // for anything else preserves the dispatcher's fall-through.
    if (isPtyBridgeDisabled() && (
      pathname === "/api/terminal" ||
      pathname.startsWith("/api/terminal/") ||
      /^\/api\/sessions\/[^/]+\/agents(\/|$)/.test(pathname)
    )) {
      return ptyBridgeUnavailable();
    }

    // The boot window, refused honestly. Until `reconcileSessions` has compared
    // the in-memory roster with the bridge, `sessions` is the empty map from
    // boot: the five routes listed in `isRosterDependentRoute` would answer
    // "Terminal session not found" about PTYs that are alive and on screen. A
    // 404 is a VERDICT — the client is entitled to prune the pane on it — so
    // spending it on a question we cannot answer yet is what turned this one
    // warning into 55% of the production error log (33.246 lines out of the
    // last 60.000, measured 2026-09-10).
    //
    // It sits ahead of the token gate on `/send` for the same reason the
    // standalone gate above does: both REFUSE, neither admits, so ordering them
    // before the auth check cannot let anything through. What an unauthorized
    // caller learns from the 503 is that the server restarted in the last few
    // seconds — which the standalone 503 already tells anyone who asks.
    if (!rosterReconciled && isRosterDependentRoute(pathname, method)) {
      return rosterWarming();
    }

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
      } catch (e) { warnThrottled("terminal_sessions:sweep", "[Terminal] terminal_sessions: sweeping dormant shells older than 1h failed:", e); }

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
        ...(s.parentSessionKey ? { subAgentPhase: childPhase(s.id) } : {}),
        // Authoritative busy snapshot — see broadcastTerminalSessions.
        busy: terminalActivity.get(s.id)?.busy ?? false,
      }));
      // `reconciled` also travels over REST, as a HEADER: the body stays a bare
      // array (MCP, mobile and the tests read it that way), but a client can now
      // tell "there is no session" from "I asked too early". Without it a client
      // that only ever reads REST never promotes an empty roster to
      // authoritative, so an orphaned terminal pane never declares itself
      // expired and retries its attach forever.
      const res = json(list);
      if (rosterReconciled) res.headers.set(ROSTER_RECONCILED_HEADER, "1");
      return res;
    }

    if (method === "POST" && (pathname === "/api/terminal/sessions" || pathname === "/api/terminal/create")) {
      // Honor X-Idempotency-Key so the client can safely retry this POST after
      // a transient failure without spawning a duplicate pty. See the matching
      // logic in client/src/state/pane/adapters/closedTabRecord.ts.
      const idemKey = req.headers.get("x-idempotency-key");
      if (idemKey) {
        const existingId = idempotencyCache.lookup(idemKey);
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
      // `cwdOf: <sessionKey>`: the folder the agent of that chat works in, resolved
      // here so the client does not need to know a worktree's path (Open in
      // terminal under a code block, CHAT-RUN-05). The paired-device gate below
      // applies to the resolved folder exactly as to one sent by hand.
      const cwdOf = typeof body.cwdOf === "string" && body.cwdOf ? body.cwdOf : null;
      const suppliedCwd = typeof body.cwd === "string" && body.cwd ? body.cwd : cwdOf ? agentWorkspaceForSession(cwdOf) : null;
      // A cwd sent by a PAIRED DEVICE must sit inside a known project (or be
      // the broad default). The cwd of every terminal session becomes a root
      // of the file-route allowlist (`services/known-project-dirs.ts`, source
      // 4), so without this a phone with an owner cookie could open a shell in
      // `~/.ssh` and read it back through `/api/files/content`. The exemptions
      // (loopback, agents with the daemon token) live in the predicate, which
      // the three other doors into the same allowlist share.
      if (suppliedCwd && clientProjectPathRefused(req, suppliedCwd, ctx)) {
        return errorResponse(400, "cwd must be inside a known project");
      }
      const cwd = suppliedCwd || process.env.HOME || "/";
      const id = crypto.randomUUID();
      const name = body.name || `Terminal ${sessions.size + 1}`;
      const command = body.command || undefined;
      const cols = body.cols || 120;
      const rows = body.rows || 30;
      const topicId = body.topicId || undefined;
      // Backward-compatible agent choice: absent/unknown `type` = shell, and
      // the pre-existing types behave exactly as before. 'codex' spawns the
      // OpenAI CLI interactively (see createSession).
      const sessionType: TerminalSessionType =
        body.type === 'claude-code-team' ? 'claude-code-team' :
        body.type === 'claude-code' ? 'claude-code' :
        body.type === 'codex' ? 'codex' :
        body.type === 'opencode' ? 'opencode' :
        body.type === 'kimi-code' ? 'kimi-code' :
        body.type === 'muse' ? 'muse' : 'shell';
      const skipPermissions = body.skipPermissions !== false;
      const claudeSessionId = resumeIdForNewSession(body.claudeSessionId, sessionType);
      // `command` E' ESECUZIONE ARBITRARIA: createSession lo spezza e lo passa
      // al bridge come file + argv. Questa rotta non aveva nessun cancello,
      // mentre ogni rotta che si limita a LEGGERE lo scrollback ne ha uno; e il
      // server ascolta su 0.0.0.0, quindi era una shell per chiunque fosse sulla
      // LAN. Il cancello e' sul `command` e non sulla rotta intera perche' la UI
      // apre le sue tab senza (una shell di login, `claude`, `codex`) e chiuderla
      // del tutto vorrebbe dire un token nel client.
      if (command && !agentAuthOk(req)) return errorResponse(401, "unauthorized");

      try {
        await ensureBridge();
        // The add-menu always assigns a generic label (Shell / Claude Code /
        // Codex, see client terminalAgents.ts) or "Terminal N" — never a
        // user-typed name — so a fresh session is born 'default' (createSession's
        // default) and auto-naming may relabel it. Only a PATCH rename → 'user'.
        const session = await createSession(id, name, cwd, command, cols, rows, topicId, sessionType, skipPermissions, claudeSessionId);
        if (idemKey) idempotencyCache.remember(idemKey, id);
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
    // Token-gated like every /agents/* route: the buffer leaks the full terminal
    // scrollback (secrets, command output, model reasoning) and the server binds
    // 0.0.0.0, so an ungated read is a LAN data-exfil hole. agentAuthOk checks the
    // shared GATEWAY_TOKEN — the in-app/MCP callers already present it; the human
    // UI never hits this route (terminal I/O is over the WebSocket bridge).
    const bufferMatch = matchRoute(pathname, "/api/terminal/sessions/:id/buffer");
    if (method === "GET" && bufferMatch) {
      if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
      const buffer = await getTerminalBuffer(bufferMatch.id);
      return json({ id: bufferMatch.id, buffer });
    }

    // GET /api/terminal/sessions/:id/screen — lo SCHERMO, non lo scrollback.
    //
    // `/buffer` restituisce i byte scritti dalla PTY: su un programma che
    // ridisegna in place (un menu con le frecce, una barra) contiene TUTTE le
    // versioni della stessa riga e non dice quale è quella attuale. Un agente
    // che lo legge vede la storia e non lo stato: non sa quale voce è
    // evidenziata, ne' se il tasto che ha premuto e' arrivato.
    //
    // Qui il flusso viene rigiocato su un emulatore headless e si restituisce
    // la griglia. Stesso gate di `/buffer`: e' la stessa informazione, resa
    // leggibile — se una e' un buco di esfiltrazione sulla LAN lo e' anche
    // l'altra.
    const screenMatch = matchRoute(pathname, "/api/terminal/sessions/:id/screen");
    if (method === "GET" && screenMatch) {
      if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
      const stream = await getTerminalBuffer(screenMatch.id);
      // Le dimensioni VERE della sessione: rigiocare a una larghezza diversa
      // manda a capo dove il programma non l'aveva fatto, e il risultato
      // somiglia allo schermo senza esserlo.
      const sess = sessions.get(screenMatch.id);
      const screen = await renderScreen(stream, {
        cols: sess?.cols,
        rows: sess?.rows,
        trimTrailingBlank: url.searchParams.get("full") !== "1",
      });
      return json({
        id: screenMatch.id,
        lines: screen.lines,
        text: screenToText(screen),
        cursor: screen.cursor,
        cols: screen.cols,
        rows: screen.rows,
      });
    }

    // WRITE raw input straight into the PTY. On these
    // `claude --dangerously-skip-permissions` sessions that is arbitrary code
    // execution, and the server binds 0.0.0.0 — so an ungated /send is
    // unauthenticated LAN RCE. Gate on the shared GATEWAY_TOKEN exactly like the
    // /agents/* write routes (the human UI types over the WebSocket bridge, not here).
    const sendMatch = matchRoute(pathname, "/api/terminal/sessions/:id/send");
    if (method === "POST" && sendMatch) {
      if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
      const session = sessions.get(sendMatch.id);
      if (!session) return errorResponse(404, "Terminal session not found");
      const body = await readJSON(req).catch(() => ({}));
      const input = body.input || body.text || body.data || "";
      // Text only: an array of bytes reached the node bridge intact (node-pty
      // does `Buffer.from`) and slipped past any content filter, ctrl+z included.
      if (typeof input !== "string" || !input) return errorResponse(400, "No input provided");
      const send = resolveTerminalSend(session?.type, input);
      if (send.dropped) return json({ ok: false, dropped: true, sent: 0 });
      noteTerminalInput(sendMatch.id);
      sendToBridge({ type: "write", id: sendMatch.id, data: send.data });
      if (send.enter) {
        const sid = sendMatch.id;
        setTimeout(() => {
          try { if (sessions.has(sid)) sendToBridge({ type: "write", id: sid, data: "\r" }); } catch { /* bridge went away */ }
        }, PASTE_ENTER_DELAY_MS);
      }
      return json({ ok: true, sent: send.sent, pasted: send.pasted });
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
      // Il fatto PRIMA delle conseguenze: se il processo muore a meta' ritiro,
      // il riconcilio al boot sa che quella sessione andava ritirata e finisce
      // il lavoro. Timbrare dopo avrebbe lasciato lo stato esattamente dove il
      // guasto lo lasciava — riga viva, nessuno che sa perche'.
      recordRetirement(getDatabase(), "terminal", deleteMatch.id, new Date().toISOString(), "tab-close");
      if (!retireTerminalSession(deleteMatch.id)) return errorResponse(404, "Terminal session not found");
      return json({ ok: true });
    }

    // --- Rename a terminal session (PATCH name) ---
    // Lets the user give a started Claude Code session a meaningful label for
    // organisation. Marks the name 'user' so the auto-namer leaves it alone.
    // Updates the live in-memory session (if mounted) AND the persisted row (so
    // the name survives a restart / applies to a dormant session), then
    // re-broadcasts the roster so every client tab relabels.
    const renameMatch = matchRoute(pathname, "/api/terminal/sessions/:id");
    if (method === "PATCH" && renameMatch) {
      let body: any;
      try { body = await readJSON(req); } catch { return errorResponse(400, "Body must be JSON"); }
      if (!body || typeof body.name !== "string") {
        return errorResponse(400, "name (string) is required");
      }
      // Collapse internal whitespace/newlines and cap the length so a pasted
      // blob can't break the tab strip.
      const name = body.name.replace(/\s+/g, " ").trim().slice(0, 120);
      if (!name) return errorResponse(400, "name must not be empty");

      const session = sessions.get(renameMatch.id);
      const db = getDatabase();
      const dbRow = db.query("SELECT id FROM terminal_sessions WHERE id = ?").get(renameMatch.id) as any;
      if (!session && !dbRow) return errorResponse(404, "Terminal session not found");

      if (session) { session.name = name; session.nameSource = 'user'; }
      try { db.run("UPDATE terminal_sessions SET name = ?, name_source = 'user' WHERE id = ?", [name, renameMatch.id]); }
      catch (e) { warnThrottled("terminal_sessions:rename", `[Terminal] terminal_sessions: saving the new name of ${renameMatch.id} failed:`, e); }

      broadcastTerminalSessions();
      return json({ ok: true, id: renameMatch.id, name });
    }

    // --- Dormant sessions: list and revive ---

    // A retired sub-agent is not a tab to reopen: its tab relit it as Claude
    // Code with `--resume`, while now the parent resumes it with
    // `send_to_agent`, on the Topics engine (subagent-nativi). Left out of
    // this list, the client closes the tab instead of keeping it.
    if (method === "GET" && pathname === "/api/terminal/sessions/dormant") {
      const db = getDatabase();
      const cwd = url.searchParams.get('cwd');
      const rows = cwd
        ? db.query(`SELECT * FROM terminal_sessions WHERE status = 'dormant' AND ${NOT_A_SUBAGENT} AND cwd = ?`).all(cwd) as any[]
        : db.query(`SELECT * FROM terminal_sessions WHERE status = 'dormant' AND ${NOT_A_SUBAGENT}`).all() as any[];
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
      // Already awake: answer with the live session instead of building a second
      // PTY over it. A revive is idempotent from the caller's point of view, and
      // the losing client of a double-click must not be told "not found" for a
      // tab that is right there.
      const revivedShape = (s: TerminalSession) => ({
        id: s.id, name: s.name, cwd: s.cwd,
        command: s.command, type: s.type,
        claudeSessionId: s.claudeSessionId || null,
      });
      const already = sessions.get(reviveMatch.id);
      if (already) return json(revivedShape(already));

      // Serialize on the id: see `revivingSessions`. The loser does NOT get a
      // 409 — it awaits the winner and answers with the same session. One
      // double-click must produce ONE terminal, and the scrollback is the
      // winner's PTY, not a fresh one.
      const inFlight = revivingSessions.get(reviveMatch.id);
      if (inFlight) {
        try {
          return json(revivedShape(await inFlight));
        } catch (err: any) {
          return errorResponse(500, `Failed to revive session: ${err.message}`);
        }
      }
      const row = db.query("SELECT * FROM terminal_sessions WHERE id = ? AND status = 'dormant'").get(reviveMatch.id) as any;
      if (!row) return errorResponse(404, "Dormant session not found");
      // Registered BEFORE the first await: between here and the bridge ack there
      // is nothing to serialise on otherwise, and that window is exactly where
      // the double click lands.
      const revival = (async (): Promise<TerminalSession> => {
        await ensureBridge();
        const session = await createSession(
          row.id, row.name, row.cwd, undefined,
          row.cols || 120, row.rows || 30,
          row.topic_id || undefined,
          row.type || 'shell',
          row.skip_permissions !== 0,
          row.claude_session_id || undefined,
          row.parent_session_key || undefined,
          (row.name_source as 'default' | 'auto' | 'user') || 'default',
        );
        // Mark as active
        try { db.run("UPDATE terminal_sessions SET status = 'active' WHERE id = ?", [row.id]); }
        catch (e) { warnThrottled("terminal_sessions:revive", `[Terminal] terminal_sessions: marking revived ${row.id} active failed:`, e); }
        broadcastTerminalSessions();
        return session;
      })();
      revivingSessions.set(reviveMatch.id, revival);
      try {
        return json(revivedShape(await revival));
      } catch (err: any) {
        return errorResponse(500, `Failed to revive session: ${err.message}`);
      } finally {
        revivingSessions.delete(reviveMatch.id);
      }
    }

    // Restart a LIVE (or dormant) session in place, preserving its id. For
    // claude-code/codex with a claude_session_id this relaunches with --resume
    // (conversation preserved); for shell it starts a fresh PTY in the same cwd.
    // Used by the tab right-click "Ricarica" to unstick a wedged session (e.g. a
    // claude CLI latched on "Not logged in" after a transient proxy auth gap)
    // without CLI surgery or restarting the app.
    const reloadMatch = matchRoute(pathname, "/api/terminal/sessions/:id/reload");
    if (method === "POST" && reloadMatch) {
      const id = reloadMatch.id;
      // Serialize: a concurrent reload of the same id would race the kill→recreate.
      if (reloadingSessionIds.has(id)) {
        return errorResponse(409, "Reload already in progress for this session");
      }
      reloadingSessionIds.add(id);
      try {
        const db = getDatabase();
        const live = sessions.get(id);
        const dbRow = db.query("SELECT * FROM terminal_sessions WHERE id = ?").get(id) as any;
        if (!live && !dbRow) return errorResponse(404, "Terminal session not found");
        // Capture the recreation snapshot BEFORE the kill — the exit handler may
        // DELETE the row (shell) or mark it dormant (claude), so we must not rely
        // on the DB row surviving the kill.
        const snap = {
          id,
          name: live?.name ?? dbRow?.name ?? "Terminal",
          cwd: live?.cwd ?? dbRow?.cwd ?? process.cwd(),
          cols: live?.cols ?? dbRow?.cols ?? 120,
          rows: live?.rows ?? dbRow?.rows ?? 30,
          topicId: (live?.topicId ?? dbRow?.topic_id ?? undefined) as string | undefined,
          type: (live?.type ?? dbRow?.type ?? 'shell') as TerminalSessionType,
          skipPermissions: live ? live.skipPermissions : (dbRow?.skip_permissions !== 0),
          claudeSessionId: (live?.claudeSessionId ?? dbRow?.claude_session_id ?? undefined) as string | undefined,
          parentSessionKey: (live?.parentSessionKey ?? dbRow?.parent_session_key ?? undefined) as string | undefined,
        };
        // Kill the live PTY and wait for it to ACTUALLY exit before recreating.
        // We must not recreate while the old PTY may still die later: the bridge
        // 'exit' event is keyed by id only (no pid/generation), so a late exit of
        // the old PTY would tear down the freshly recreated session (close its
        // sockets + delete its row). So: recreate ONLY once the old PTY is gone;
        // if it refuses to die in time, bail with 503 rather than risk that race.
        if (sessions.has(id)) {
          sendTerminalKill(id, 'reload', 'POST /sessions/:id/reload');
          for (let i = 0; i < 24 && sessions.has(id); i++) {
            await new Promise((r) => setTimeout(r, 250));
          }
          if (sessions.has(id)) {
            return errorResponse(503, "Session did not stop in time. Please retry.");
          }
        }
        await ensureBridge();
        // command=undefined (like the revive endpoint): a shell re-resolves to
        // `$SHELL -l`; claude/codex build their command from `type` + claudeSessionId
        // (--resume). Forwarding the stored, already-resolved shell path would drop
        // the login-shell (-l) flag.
        const session = await createSession(
          snap.id, snap.name, snap.cwd, undefined,
          snap.cols, snap.rows, snap.topicId, snap.type,
          snap.skipPermissions, snap.claudeSessionId, snap.parentSessionKey,
        );
        try { db.run("UPDATE terminal_sessions SET status = 'active' WHERE id = ?", [snap.id]); }
        catch (e) { warnThrottled("terminal_sessions:reload", `[Terminal] terminal_sessions: marking reloaded ${snap.id} active failed:`, e); }
        broadcastTerminalSessions();
        return json({ id: session.id, type: session.type, claudeSessionId: session.claudeSessionId || null });
      } catch (err: any) {
        return errorResponse(500, `Failed to reload session: ${err.message}`);
      } finally {
        reloadingSessionIds.delete(id);
      }
    }

    // Cleanup: delete dormant sessions older than 1 hour (lazy, on each GET sessions call)
    // (This runs in the GET /api/terminal/sessions handler above, no separate endpoint needed)

    // (Image paste is now handled entirely client-side: the terminal pane writes
    // the pasted image to the system clipboard natively — NSPasteboard under
    // Tauri, the browser Clipboard API on the web — then sends Ctrl+V. The old
    // server endpoint used `osascript`, which triggered a macOS "control
    // iTunes/Music" Automation prompt; it has been removed.)

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
      const waitM = matchRoute(pathname, "/api/sessions/:sessionKey/agents/:agentId/wait");

      const agentRoute = spawnM ?? listM ?? sendM ?? readM ?? stopM ?? waitM;
      if (agentRoute) {
        const parentKey = decodeURIComponent(agentRoute.sessionKey);
        // Profile filtering keeps these tools out of the model context; this
        // route check makes direct HTTP calls fail too. The global coordinator
        // coordinates only through durable board operations, never a hidden
        // fan-out of agent processes.
        if (isGlobalOrchestratorSession(ctx.db, parentKey)) {
          return errorResponse(403, "global coordinator sessions cannot spawn, send to, read, or stop sub-agents");
        }
      }

      if (spawnM && method === "POST") {
        if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
        const parentKey = decodeURIComponent(spawnM.sessionKey);
        if (isCodexBridgeOnlyTopic(ctx, parentKey)) {
          return errorResponse(403, "Codex bridge-only sessions cannot spawn Claude sub-agents");
        }
        const body = await readJSON(req).catch(() => ({}));
        const prompt = typeof body.prompt === "string" ? body.prompt : "";
        if (!prompt) return errorResponse(400, "prompt (string) is required");
        const parent = sessions.get(parentKey);
        // A chat parent is not in `sessions` (its sessionKey is `topic:<id>`):
        // without the topic's cwd the project lookup would land on `$HOME`,
        // which is nobody's project.
        const parentTopic = parentKey.startsWith("topic:") ? ctx.getTopicBySessionKey(parentKey) : null;
        const topicCwd = ctx.resolveTopicCwd(parentTopic);
        // "It inherits this session's working directory", says the tool. For a
        // chat parent `parent` is always undefined, so this fell through to
        // `$HOME` for every chat: 55 children out of 55 spawned without `cwd`
        // landed there, projects and card worktrees included.
        let cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : (parent?.cwd || topicCwd || process.env.HOME || "/");
        // Model, profile and effort (SUBAGENT-08/09/10), refused BEFORE any
        // process or worktree exists. The profiles are those of the directory
        // the child is asked to start from; an isolated child's worktree is a
        // checkout of the same project, with the same `.claude/agents`.
        const resolved = resolveSubagentLaunch({
          call: { model: body.model, agentType: body.agent_type ?? body.agentType, effort: body.effort },
          profiles: agentProfilesFor(cwd),
          parent: {
            model: parentTopic ? chatParentModel(parentTopic) : parentTranscriptModel(parent),
            effort: resolveClaudeEffort(topicEffortFor(getDatabase(), parentTopic?.id ?? parent?.topicId)),
          },
        });
        if (!resolved.ok) return errorResponse(400, resolved.error);
        const launch = resolved.launch;
        const refusal = subagentLimitRefusal(parentKey, { depth: spawnedAgentDepth(parentKey), childIds: liveChildrenOf(parentKey).map((c) => c.id) });
        if (refusal) return errorResponse(429, refusal);
        // Il governo della board, e vale SOLO per chi appartiene a un task: una
        // chat dell'umano passa di qui senza che questo blocco la veda. Chi
        // invece è la sessione di un task dispatchato spende il tetto di
        // concorrenza della board come chiunque altro, e una figlia non apre
        // nipoti. Vedi `agent-census.ts` per il perché di entrambi.
        {
          const boardRefusal = boardSpawnRefusal(getDatabase(), { parentSessionKey: parentKey, cap: boardAgentCap(), ...boardSpawnMode() });
          if (!boardRefusal.ok) {
            if (boardRefusal.code === "depth") return errorResponse(429, "sub-agent depth limit (1) reached: a board sub-agent cannot spawn its own");
            if (boardRefusal.code === "machine") return errorResponse(429, `machine budget reached${boardRefusal.blockedBy ? ` (${boardRefusal.blockedBy})` : ""}: no room for another sub-agent`);
            return errorResponse(429, `board concurrency cap reached (${boardRefusal.live}/${boardRefusal.cap} live agents)`);
          }
        }
        // WORKTREE-14, and the opt-in IS the point: without `isolation` the
        // child inherits the parent's directory exactly as it always has. A
        // checkout is ~600 MB and MAX_CHILDREN_PER_PARENT allows five of them,
        // so a worktree default would bill that to every chat that delegates.
        const isolation = body.isolation === "worktree" ? "worktree" : "inherit";
        // subagent-nativi: the engine, unless the call asks for the CLI or the engine cannot take it.
        const choice = childRuntimeFor(body.runtime, () => isolation === "worktree"
          ? { ok: true, projectPath: null, worktreeId: null } // decided once the worktree exists
          : nativeChildPlace({
            explicitCwd: typeof body.cwd === "string" && body.cwd ? body.cwd : null,
            parentTopic,
            parentCwd: parent?.cwd ?? null,
            knownProject: (p) => placeableUnderKnownProject(p, (x) => !!ctx.projectStore.getByPath(x)),
          }));
        if (!choice.ok) return errorResponse(choice.status, choice.error);
        let nativePlace = choice.runtime === "topics" ? choice.place : null;
        const runtimeNote = choice.runtime === "claude-code" ? choice.note : null;
        let branch: string | null = null;
        if (isolation === "worktree") {
          const project = resolveAgentProject(
            { cwd: typeof body.cwd === "string" ? body.cwd : null, parentCwd: parent?.cwd, topicCwd },
            {
              getByPath: (path) => ctx.projectStore.getByPath(path),
              getByAbsPath: (absPath) => ctx.worktreeStore.getByAbsPath(absPath),
            },
          );
          if (!project.ok) return errorResponse(400, project.refusal);
          try {
            const worktreeId = await createAgentWorktree(
              {
                projectPath: (projectStoreId) => ctx.projectStore.get(projectStoreId)?.path,
                create: (input) => ctx.worktreeManager.create(input),
                awaitMaterialisation: (wtId, timeoutMs) => ctx.worktreeManager.awaitMaterialisation(wtId, timeoutMs),
                warn: (reason) => console.warn(`[spawn] ${reason}`),
              },
              project.projectStoreId,
              worktreeReadyMs(),
            );
            const wt = ctx.worktreeStore.get(worktreeId);
            if (!wt) return errorResponse(502, `worktree ${worktreeId} created but not readable`);
            cwd = wt.absPath;
            branch = wt.branchName;
            // The native child's chat keeps the project for the sidebar and works in the checkout.
            if (nativePlace) nativePlace = { projectPath: ctx.projectStore.get(project.projectStoreId)?.path ?? null, worktreeId };
          } catch (err: any) {
            return errorResponse(502, `Failed to create worktree for sub-agent: ${err?.message ?? err}`);
          }
        }
        const id = crypto.randomUUID();
        const chosenName = typeof body.name === "string" && body.name ? body.name : null;
        const name = chosenName ?? `agent ${id.slice(0, 8)}`;
        const foreground = body.run_in_background === false || body.runInBackground === false;
        if (nativePlace) {
          const engine = engineLaunchOf(launch.agent ? agentProfilesFor(cwd).get(launch.agent) ?? null : null, launch.model);
          try {
            if (foreground) holdForeground(id, parentKey, FOREGROUND_WAIT_MS + 60_000);
            const child = spawnNativeChild({
              id, parentSessionKey: parentKey, name, prompt, cwd,
              parentTopic, projectPath: nativePlace.projectPath, worktreeId: nativePlace.worktreeId, branch,
              ...engine, effort: launch.effort, agentType: launch.agent,
              promptSnippet: normalizePromptSnippet(prompt),
              runtimeReason: body.runtime === "topics" ? "asked" : "default",
            });
            return json({
              agentId: id, name, cwd, branch, runtime: "topics", sessionKey: child.sessionKey, topicId: child.topic.id,
              model: engine.model, modelSource: launch.modelSource, ...(launch.modelNote ? { modelNote: launch.modelNote } : {}),
              agentType: launch.agent, effort: launch.effort,
              notify: parentKey.startsWith("topic:") ? "chat" : "read_agent",
              runInBackground: !foreground,
            });
          } catch (err) {
            releaseForeground(id);
            return errorResponse(502, `Failed to spawn sub-agent: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        try {
          await ensureBridge();
          // A name the parent chose is owned like a user's rename: the
          // auto-namer rewrote it from the transcript, and the parent then read
          // its report under a title it had never given ("foglio-tab" arrived
          // as the title the auto-namer derived from its first answer).
          const session = await createSession(id, name, cwd, undefined, 120, 30, undefined, "claude-code", true, undefined, parentKey, chosenName ? "user" : "default", launch);
          // Fingerprint the opening prompt so transcript-discovery can find the
          // .jsonl claude actually writes (it ignores our pre-assigned
          // --session-id for sub-agents — see resolveChildTranscriptSessionId).
          session.spawnPromptSnippet = seedPromptFingerprintForSession(session.type, prompt);
          // The row that outlives the terminal: launch, name, limits, resume.
          insertSubagent(getDatabase(), {
            id, parentSessionKey: parentKey, name, model: launch.model, agentType: launch.agent, effort: launch.effort,
            promptSnippet: session.spawnPromptSnippet, cwd: session.cwd, branch,
            claudeSessionId: session.claudeSessionId ?? null, createdAt: session.createdAt,
            // Only a CLI the call asked for stays on the CLI when resumed.
            runtimeReason: body.runtime === "claude-code" ? "asked" : runtimeNote ? "fallback" : "default",
          });
          noteChildSeeded(id);
          if (foreground) holdForeground(id, parentKey, FOREGROUND_WAIT_MS + 60_000);
          // The roster broadcast carries parentSessionKey, so the sub-agent
          // immediately appears nested under its parent in the sidebar tree.
          broadcastTerminalSessions();
          // Seed the first prompt once the TUI is ready (async, non-blocking).
          seedAgentPrompt(id, prompt)
            .catch((err) => console.warn(`[Terminal] seedAgentPrompt failed for ${id}:`, err));
          // Discover + adopt the child's REAL transcript id shortly after start,
          // so the wake/read paths deliver its actual final result (not "senza
          // output") even when the orchestrator never polls it.
          scheduleClaudeSubAgentIdCapture(id);
          return json({
            agentId: id, name: session.name, cwd: session.cwd, branch,
            runtime: "claude-code", ...(runtimeNote ? { runtimeNote } : {}),
            model: launch.model, modelSource: launch.modelSource, ...(launch.modelNote ? { modelNote: launch.modelNote } : {}),
            agentType: launch.agent, effort: launch.effort,
            // How the parent hears of the result: a chat is woken, a terminal reads.
            notify: parentKey.startsWith("topic:") ? "chat" : "read_agent",
            runInBackground: !foreground,
          });
        } catch (err: any) {
          return errorResponse(502, `Failed to spawn sub-agent: ${err.message}`);
        }
      }

      if (listM && method === "GET") {
        if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
        const parentKey = decodeURIComponent(listM.sessionKey);
        const live = liveChildrenOf(parentKey).map(s => ({
          agentId: s.id,
          name: getSubagent(getDatabase(), s.id)?.name ?? s.name,
          cwd: s.cwd,
          // An isolated child's branch, re-read from its directory: the parent
          // must be able to name it in a list asked for after a restart too.
          branch: branchOfCwd(s.cwd),
          claudeSessionId: s.claudeSessionId || null,
          busy: terminalActivity.get(s.id)?.busy ?? false,
          state: "running",
          phase: childPhase(s.id),
        }));
        live.push(...(liveNativeChildren(parentKey) as typeof live));
        // Ended children stay listed for 24 hours: `send_to_agent` brings them back.
        const liveIds = new Set(live.map((a) => a.agentId));
        const ended = endedSubagents(getDatabase(), parentKey)
          .filter((r) => !liveIds.has(r.id))
          .map((r) => ({ agentId: r.id, name: r.name, cwd: r.cwd, branch: r.branch, claudeSessionId: r.claudeSessionId, busy: false, state: r.state, phase: null }));
        return json({ agents: [...live, ...ended] });
      }

      if (sendM && method === "POST") {
        if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
        const parentKey = decodeURIComponent(sendM.sessionKey);
        const agentId = decodeURIComponent(sendM.agentId);
        const body = await readJSON(req).catch(() => ({}));
        const input = typeof body.input === "string" ? body.input : (typeof body.text === "string" ? body.text : "");
        {
          // A native child: the next turn of its chat, whatever its state.
          const row = getSubagent(getDatabase(), agentId);
          if (row?.runtime === "topics") {
            if (row.parentSessionKey !== parentKey) return errorResponse(404, subAgentNotFound(agentId));
            if (!input) return errorResponse(400, "input (string) is required");
            if (row.state !== "running") {
              const verdict = resumeVerdict(row);
              if (!verdict.ok) return errorResponse(verdict.status, `cannot resume sub-agent "${row.name}": ${verdict.reason}`);
              const refusal = subagentLimitRefusal(parentKey, { depth: spawnedAgentDepth(parentKey), childIds: liveChildrenOf(parentKey).map((c) => c.id) });
              if (refusal) return errorResponse(429, refusal);
            }
            const sent = await sendToNativeChild(row, input);
            if (!sent.ok) return errorResponse(sent.status, sent.error);
            return json({ ok: true, sent: Buffer.byteLength(input, "utf8"), ...(sent.resumed ? { resumed: true } : {}) });
          }
        }
        const child = resolveOwnedChild(parentKey, agentId);
        if (!child) {
          // Not running: a retired, stopped or lost child of this parent comes
          // back with `--resume`, from its row (SUBAGENT-14).
          const row = getSubagent(getDatabase(), agentId);
          if (!row || row.parentSessionKey !== parentKey) return errorResponse(404, subAgentNotFound(agentId));
          if (!input) return errorResponse(400, "input (string) is required");
          const cliSend = resolveTerminalSend("claude-code", input);
          if (cliSend.dropped) return json({ ok: false, dropped: true, sent: 0 });
          const verdict = resumeVerdict(row);
          if (!verdict.ok) return errorResponse(verdict.status, `cannot resume sub-agent "${row.name}": ${verdict.reason}`);
          const refusal = subagentLimitRefusal(parentKey, { depth: spawnedAgentDepth(parentKey), childIds: liveChildrenOf(parentKey).map((c) => c.id) });
          if (refusal) return errorResponse(429, refusal);
          // One resume at a time: two `send_to_agent` racing here both read the
          // row as ended and migrated (or relit) the child twice.
          if (childrenBeingResumed.has(row.id)) return errorResponse(409, `sub-agent "${row.name}" is already being resumed: its result will arrive by itself`);
          childrenBeingResumed.add(row.id);
          try {
            // subagent-nativi: a child born on the CLI comes back on the engine when it can.
            const moved = await moveCliChildToEngine(row, cliSend.data, {
              parentTopic: parentKey.startsWith("topic:") ? ctx.getTopicBySessionKey(parentKey) : null,
              parentCwd: sessions.get(parentKey)?.cwd ?? null,
              knownProject: (p) => placeableUnderKnownProject(p, (x) => !!ctx.projectStore.getByPath(x)),
              profileOf: (cwd, agentType) => agentProfilesFor(cwd).get(agentType) ?? null,
            });
            if (moved) return json({ ok: true, sent: cliSend.sent, resumed: true, runtime: "topics", sessionKey: moved.sessionKey });
            try {
              await ensureBridge();
              const session = await createSession(row.id, row.name, row.cwd, undefined, 120, 30, undefined, "claude-code", true, row.claudeSessionId!, parentKey, "user");
              session.spawnPromptSnippet = row.promptSnippet ?? undefined;
              try { getDatabase().run("UPDATE terminal_sessions SET status = 'active' WHERE id = ?", [row.id]); } catch { /* the row was just written */ }
              noteChildSeeded(row.id, { working: true });
              broadcastTerminalSessions();
              seedAgentPrompt(row.id, cliSend.data, seedPromptFingerprintForSession("claude-code", input))
                .catch((err) => console.warn(`[Terminal] seedAgentPrompt failed for resumed ${row.id}:`, err));
              return json({ ok: true, sent: cliSend.sent, resumed: true });
            } catch (err) {
              return errorResponse(502, `Failed to resume sub-agent: ${err instanceof Error ? err.message : String(err)}`);
            }
          } finally {
            childrenBeingResumed.delete(row.id);
          }
        }
        if (!input) return errorResponse(400, "input (string) is required");
        const send = resolveTerminalSend(child.type, input);
        if (send.dropped) return json({ ok: false, dropped: true, sent: 0 });
        noteTerminalInput(child.id);
        // As a paste into a Claude TUI, like the seed: a plain write over 1022
        // bytes reached it without its head (lib/subagent-seed.ts).
        const claudeTui = child.type === "claude-code" || child.type === "claude-code-team";
        sendToBridge({ type: "write", id: child.id, data: claudeTui ? promptAsPaste(send.data) : send.data });
        // Submit it: Enter as a separate frame so the TUI acts on the line.
        await new Promise(r => setTimeout(r, 120));
        noteTerminalInput(child.id);
        sendToBridge({ type: "write", id: child.id, data: "\r" });
        noteChildSteered(child.id);
        return json({ ok: true, sent: send.sent });
      }

      if (readM && method === "GET") {
        if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
        const parentKey = decodeURIComponent(readM.sessionKey);
        const agentId = decodeURIComponent(readM.agentId);
        {
          const row = getSubagent(getDatabase(), agentId);
          if (row?.runtime === "topics") {
            if (row.parentSessionKey !== parentKey) return errorResponse(404, subAgentNotFound(agentId));
            return json(readNativeChildOutput(row, Number(url.searchParams.get("since") || "0")));
          }
        }
        const child = resolveOwnedChild(parentKey, agentId) ?? endedChildForRead(parentKey, agentId);
        if (!child) return errorResponse(404, subAgentNotFound(agentId));
        const since = Number(url.searchParams.get("since") || "0");
        const result = await readAgentOutput(child, since, getTerminalBuffer);
        return json(result);
      }

      if (waitM && method === "GET") {
        if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
        const parentKey = decodeURIComponent(waitM.sessionKey);
        const agentId = decodeURIComponent(waitM.agentId);
        const row = getSubagent(getDatabase(), agentId);
        if (!resolveOwnedChild(parentKey, agentId) && row?.parentSessionKey !== parentKey) return errorResponse(404, subAgentNotFound(agentId));
        if (url.searchParams.get("release") === "1") {
          releaseForeground(agentId);
          return json({ status: "running", agentId });
        }
        const legMs = Math.min(Math.max(Number(url.searchParams.get("legMs") || "25000"), 100), 60_000);
        return json({ agentId, ...(await waitForegroundLeg(agentId, legMs, req.signal)) });
      }

      if (stopM && method === "POST") {
        if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
        const parentKey = decodeURIComponent(stopM.sessionKey);
        const agentId = decodeURIComponent(stopM.agentId);
        {
          const row = getSubagent(getDatabase(), agentId);
          if (row?.runtime === "topics") {
            if (row.parentSessionKey !== parentKey) return errorResponse(404, subAgentNotFound(agentId));
            await stopNativeChild(row, { archive: true });
            return json({ ok: true, branch: row.branch });
          }
        }
        const child = resolveOwnedChild(parentKey, agentId);
        if (!child) {
          // A retired child has no process: stopping it only closes its row.
          const row = getSubagent(getDatabase(), agentId);
          if (row?.parentSessionKey === parentKey && row.state === "retired") {
            setSubagentState(getDatabase(), agentId, "stopped");
            return json({ ok: true, branch: row.branch });
          }
          return errorResponse(404, subAgentNotFound(agentId));
        }
        return json({ ok: true, branch: stopLiveCliChild(child, 'stop_agent') });
      }
    }

    return null;
  };
}


export function handleTerminalWebSocket(ws: any, sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) {
    // A dormant row is a distinct verdict: the revive door brings it back (a
    // claude with --resume, a shell as a fresh one in the same cwd), so the
    // client offers Resume and stops resizing a PTY that no longer exists.
    // Everything else stays 1008 so a row the reconcile may reattach, or a
    // missing row, gets the normal connection grace.
    let dormant = false;
    let dormantExitCode: number | null = null;
    try {
      const row = getDatabase()
        .query("SELECT status, exit_code FROM terminal_sessions WHERE id = ?")
        .get(sessionId) as { status?: string; exit_code?: number | null } | null;
      dormant = row?.status === "dormant";
      dormantExitCode = typeof row?.exit_code === "number" ? row.exit_code : null;
    } catch { /* no row readable: the not-found answer below is still right */ }
    if (dormant) ws.close(TERMINAL_WS_CLOSE_DORMANT, encodeExitReason('dormant', dormantExitCode));
    else ws.close(1008, "Session not found");
    return;
  }

  let sockets = sessionSockets.get(sessionId);
  if (!sockets) {
    console.warn(`[Terminal] session ${sessionId} not initialized; creating socket set`);
    sockets = new Set();
    sessionSockets.set(sessionId, sockets);
  }
  sockets.add(ws);

  // Request output buffer from bridge (async). The buffered scrollback is
  // delivered as ONE binary frame, then we follow it with a `replay-end`
  // control frame (text/JSON) so the client knows where the historical
  // replay ends and live output begins. Without this signal the tab-bar
  // "in-progress" spinner lights up for ~1.5 s on every focus of an idle
  // Claude Code session, just from the backlog being flushed.
  requestBuffer(sessionId).then((buffered) => {
    try {
      // No answer from the bridge is not an empty scrollback. A `replay-end`
      // after zero bytes tells the client a claude PTY is gone (the resume
      // veil), so it goes out only after a real answer; otherwise the attach
      // ends with a code the client retries like any other dropped socket.
      if (buffered === null) {
        ws.close(TERMINAL_WS_CLOSE_REPLAY_UNANSWERED, "Replay unanswered");
        return;
      }
      // The scrollback is the single most compressible frame this server sends:
      // it is a screen of repeated escape sequences, and it goes out once per
      // focus of a terminal tab.
      if (buffered.byteLength > 0) {
        ws.send(buffered, shouldCompressFrame({ type: null, bytes: buffered.byteLength, remote: ws.data.remote === true }));
      }
      // Always send the marker, even on empty backlog — the client uses
      // it as the gate to start broadcasting `terminal:activity` pulses.
      ws.send(JSON.stringify({ type: "replay-end" }));
    } catch { /* the websocket closed mid-replay: nothing left to deliver */ }
  });

  return {
    message(data: string | Buffer | ArrayBuffer) {
      const input = typeof data === "string" ? data : new TextDecoder().decode(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      noteTerminalInput(sessionId);
      /* A KEYSTROKE MUST NOT THROW OUT OF A SOCKET HANDLER.
       *
       * `sendToBridge` throws `Bridge not connected`, and this is the keyboard
       * path: the exception escapes into the WS handler while the bridge is
       * reconnecting. Measured on 2026-08-21: 432 `Bridge not connected` lines
       * in `topics-server.log`, 213 with a `sendToBridge` stack, around 51 of
       * them on this path.
       *
       * The key is dropped, and that is the correct outcome: it is NOT buffered
       * across the reconnect. The PTY on the other side is not the same one any
       * more, it is a freshly `--resume`d process, and replaying a `2\r` that
       * answered a prompt which no longer exists injects input into a program
       * in a different state. Better a lost keystroke than a wrong one.
       */
      try {
        sendToBridge({ type: "write", id: sessionId, data: input });
      } catch (err) {
        noteDroppedInput(sessionId, err);
        // AND TELL THE PERSON TYPING. The `console.warn` above is on the SERVER:
        // on the other end the socket is still open, the cursor still blinks and
        // xterm does no local echo, so a keyboard going nowhere looked exactly
        // like a keyboard working. This control frame is what the pane turns
        // into a band; it disappears at the first real output, i.e. when the
        // bridge answers again.
        try { ws.send(JSON.stringify({ type: TERMINAL_INPUT_DROPPED })); } catch { /* socket already gone */ }
      }
    },
    close() {
      const s = sessionSockets.get(sessionId);
      if (s) s.delete(ws);
    },
  };
}
