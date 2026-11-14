import { TERMINAL_ROSTER_WARMING_CODE, TERMINAL_ROSTER_WARMING_RETRY_AFTER_S } from "../../shared/terminal-messages";
import { getDatabase } from "../db";
import { warnThrottled } from "../lib/warn-throttled";
import fs from "fs";
import { decideOnRestart } from "../lib/terminal-restart-policy";
import { claudeTranscriptPath } from "../lib/claude-transcript-path";
import { restoreSweptTranscript } from "../lib/transcript-keeper";
import { reportChildEnd } from "../lib/subagent-runtime";
import { sessionSockets, sessions } from "./terminal-state";
import { noteTerminalReattached } from "./terminal-activity";
import { ensureBridge, isPtyBridgeDisabled, setBridgeReconciler } from "./terminal-bridge-socket";
import { sendTerminalKill, sendToBridge } from "./terminal-bridge-send";
import { createSession } from "./terminal-session-create";
import { _tracker, broadcastTerminalSessions, setRosterReconciled } from "./terminal-shared";

// --- Session reconciliation ---
let reconcileResolver: ((sessions: { id: string; pid: number }[]) => void) | null = null;

export function handleListResponse(bridgeSessions: { id: string; pid: number }[]) {
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
      nameSource: (row.name_source as 'default' | 'auto' | 'user') || 'default',
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
    noteTerminalReattached(row.id);
    if (row.claude_session_id && (row.type === 'claude-code' || row.type === 'claude-code-team')) {
      _tracker?.registerTerminalSession(row.claude_session_id, { cwd: row.cwd || undefined });
    }
    restored++;
  }
  console.log(`[Terminal] Optimistically restored ${restored} session(s) from DB (bridge unreachable, PTYs preserved)`);
}

/**
 * How many requests the warming gate below turned away during THIS boot window.
 *
 * It exists to leave exactly one line in the log instead of one per request.
 * The whole point of the gate is that the old code wrote 33.246 warnings into
 * the last 60.000 lines of the production error log; answering 503 and logging
 * each of those would only rename the noise. One line at the end of the window
 * says the same thing and can be counted: `grep -c "roster warming"`.
 */
let warmingDeferrals = 0;

/**
 * The roster now matches the truth (the bridge's, or the DB's when the bridge
 * never answered): promote the bit, tell the connected clients, and — if the
 * gate turned anyone away meanwhile — say how many in one line.
 *
 * The three call sites used to write `rosterReconciled = true;
 * broadcastTerminalSessions();` by hand. Three copies of a two-step promotion
 * is how one of them ends up doing only the first step.
 */
function markRosterReconciled(): void {
  setRosterReconciled(true);
  if (warmingDeferrals > 0) {
    console.log(`[Terminal] roster warming finished — ${warmingDeferrals} request(s) answered 503 instead of a false 404`);
    warmingDeferrals = 0;
  }
  broadcastTerminalSessions();
}

/**
 * Test seam — put the roster back to "not yet compared", the way it is at boot.
 *
 * Same reason as `_setPtyBridgeSocketPath` above, and the same shape: under
 * `bun test` every file shares ONE instance of this module, and this bit only
 * ever travels one way (false → true). So the first file that lets a reconcile
 * finish closes the boot window for every file that runs after it, and a test
 * about what happens INSIDE that window would go green against a roster that
 * had already been promoted — the worst kind of green, since it asserts the old
 * behaviour and passes. Nothing in production calls this.
 */
export function _resetRosterReconciled(): void {
  setRosterReconciled(false);
  warmingDeferrals = 0;
}

/**
 * The five routes that decide "does this session exist?" on the IN-MEMORY map,
 * and therefore lie while that map is still the empty one from boot.
 *
 * `sessions` is repopulated by `reconcileSessions`, which the HTTP layer does
 * not wait for. So between the HTTP layer accepting connections and the bridge
 * answering `list` — up to ~24s when the bridge is slow to come up — every one
 * of these answers "Terminal session not found" about PTYs that are alive.
 * That window is what the client's reconnect loops land in right after a server
 * reload, and it is the single biggest writer in the production error log.
 *
 * Listed here rather than guarded five times inside the handlers: five copies
 * of the same precondition is five chances for the sixth route to forget it.
 * `/revive` is deliberately absent — it reads the DB (`status = 'dormant'`),
 * not the map, so it is already right during the window and its 404 ("Dormant
 * session not found") is a different, truthful sentence.
 */
export function isRosterDependentRoute(pathname: string, method: string): boolean {
  const parts = pathname.split("/");
  // /api/terminal/sessions/:id/<verb>  → 6 parts, or /api/terminal/:id/resize → 5
  const tail = parts[parts.length - 1];
  const underSessions = parts.length === 6 && parts[1] === "api" && parts[2] === "terminal" && parts[3] === "sessions";
  const underTerminal = parts.length === 5 && parts[1] === "api" && parts[2] === "terminal";
  if (method === "POST" && underSessions && (tail === "send" || tail === "resize" || tail === "reload")) return true;
  if (method === "POST" && underTerminal && tail === "resize") return true;
  // DELETE/PATCH /api/terminal/sessions/:id  → 5 parts; DELETE /api/terminal/:id → 4.
  // `/api/terminal/sessions/dormant` is a GET, so it can never reach here.
  const sessionById = parts.length === 5 && parts[1] === "api" && parts[2] === "terminal" && parts[3] === "sessions";
  const terminalById = parts.length === 4 && parts[1] === "api" && parts[2] === "terminal" && parts[3] !== "sessions";
  if ((method === "DELETE" || method === "PATCH") && sessionById) return true;
  if (method === "DELETE" && terminalById) return true;
  return false;
}

/**
 * "Ask me again in a moment", not "it does not exist".
 *
 * Built by hand instead of through `errorResponse` for two reasons: it must
 * carry `Retry-After`, and it must NOT log. A per-request warning here would
 * swap 33k false 404 lines for 33k 503 lines and cure nothing — the count goes
 * out once, in `markRosterReconciled`.
 */
/** The rows of a person's terminals, not of sub-agents. */
export const NOT_A_SUBAGENT = "(parent_session_key IS NULL OR parent_session_key = '')";

export function rosterWarming(): Response {
  warmingDeferrals++;
  return new Response(
    JSON.stringify({ error: "terminal roster is still reconciling", code: TERMINAL_ROSTER_WARMING_CODE }),
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        "Retry-After": String(TERMINAL_ROSTER_WARMING_RETRY_AFTER_S),
      },
    },
  );
}

export async function reconcileSessions(attempt = 0): Promise<void> {
  // Standalone bundle: no bridge to reconcile against. Short-circuit so we don't
  // burn the 8× reconnect-retry cycle against a socket that will never answer.
  // Niente da riconciliare ⇒ il roster è autorevole da subito, non "mai".
  if (isPtyBridgeDisabled()) {
    markRosterReconciled();
    return;
  }
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
    // Il bridge non ha risposto, ma il roster ora contiene ciò che il DB sa: è la
    // migliore verità disponibile, e tenerlo "non autorevole" per sempre
    // lascerebbe i client senza un vuoto di cui fidarsi mai più.
    markRosterReconciled();
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
          nameSource: (row.name_source as 'default' | 'auto' | 'user') || 'default',
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
        noteTerminalReattached(row.id);
        // Re-register with the phase tracker (in-memory state was lost on
        // restart). The next hook OR the transcript tail (cwd-derived path)
        // re-establishes the live phase; until then il client resta su una fase
        // a RIPOSO (`dormant` per una riattaccata), non sull'euristica pty.
        if (row.claude_session_id && (row.type === 'claude-code' || row.type === 'claude-code-team')) {
          _tracker?.registerTerminalSession(row.claude_session_id, { cwd: row.cwd || undefined });
        }
        console.log(`[Terminal] Reattached to surviving session ${row.id} (${row.type})`);
      }
    }
  }

  // Bridge has session, DB doesn't → orphaned, kill it
  for (const bs of bridgeSessions) {
    if (!dbIds.has(bs.id)) {
      sendTerminalKill(bs.id, 'orphan-cleanup', 'startup-reconcile');
    }
  }

  // DB has session, bridge doesn't → parcheggia, rilancia o rimuovi.
  // CHI fa cosa lo decide `lib/terminal-restart-policy.ts`, che è puro e ha i
  // suoi test: qui restano solo gli effetti.
  for (const row of dbRows) {
    if (!bridgeIds.has(row.id)) {
      const isClaude = row.type === 'claude-code' || row.type === 'claude-code-team';
      // Il transcript si guarda solo dove conta (tipi claude con un id di
      // ripresa): è l'unico caso in cui la sua assenza cambia la decisione, e
      // uno `stat` per riga a ogni avvio non si regala.
      // A transcript the CLI's cleanup swept is put back from the kept link
      // before the decision: without it the row is dropped and the tab is gone.
      if (isClaude && row.claude_session_id) restoreSweptTranscript(db, row.cwd, row.claude_session_id, `tab ${row.id}`);
      const hasTranscript = isClaude && row.claude_session_id
        ? (() => { try { return fs.existsSync(claudeTranscriptPath(row.cwd, row.claude_session_id)); } catch { return false; } })()
        : false;
      const decision = decideOnRestart({
        type: row.type || 'shell',
        claudeSessionId: row.claude_session_id,
        hasTranscript,
      });
      // A chat's sub-agent whose PTY did not survive: no `exit` frame will ever
      // come for it, so its parent was never told and `read_agent` answers 404.
      // Report it once, while the row is still `active` (it is parked or
      // dropped right below, so the next boot does not report it again).
      if (row.status !== 'dormant' && typeof row.parent_session_key === 'string' && row.parent_session_key) {
        reportChildEnd(sessions.get(row.id) ?? {
          id: row.id, name: row.name, cwd: row.cwd, createdAt: row.created_at || new Date().toISOString(),
          claudeSessionId: row.claude_session_id || undefined, parentSessionKey: row.parent_session_key,
        }, null, 'lost');
      }

      if (decision.action === 'drop') {
        console.log(`[Terminal] Rimossa ${row.type} ${row.id}: transcript assente, non ripristinabile`);
        try { db.run("DELETE FROM terminal_sessions WHERE id = ?", [row.id]); } catch { /* swallow */ }
      } else if (decision.action === 'park') {
        console.log(`[Terminal] Parcheggiata ${row.type} ${row.id} (dormiente, si rianima al focus)`);
        try { db.run("UPDATE terminal_sessions SET status = 'dormant' WHERE id = ?", [row.id]); } catch { /* swallow */ }
      } else {
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
            (row.name_source as 'default' | 'auto' | 'user') || 'default',
          );
        } catch (err: any) {
          // Transient boot failure (bridge not ready, spawn error): park dormant
          // so a later project-window /revive can retry, rather than losing the
          // row. The 1h sweep is shell-only (type='shell'), so a dormant codex
          // row survives until then.
          console.warn(`[Terminal] Failed to recreate codex session ${row.id}: ${err.message} — parking dormant`);
          try { db.run("UPDATE terminal_sessions SET status = 'dormant' WHERE id = ?", [row.id]); }
          catch (e) { warnThrottled("terminal_sessions:park-after-recreate", `[Terminal] terminal_sessions: marking ${row.id} dormant after a failed recreate failed:`, e); }
        }
      }
    }
  }

  // Da qui il roster è confrontato con la verità del bridge: un vuoto ora
  // significa davvero "nessuna sessione". Il broadcast porta la promozione ai
  // client già connessi, che altrimenti resterebbero con l'ultimo roster
  // ricevuto e senza sapere che ora può essere creduto.
  markRosterReconciled();
}

// A hook, not an import from the socket: the socket importing this module would be a cycle.
setBridgeReconciler(reconcileSessions);
