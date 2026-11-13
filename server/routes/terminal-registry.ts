import type { TerminalSessionType } from "../../shared/terminal-session-types";
import { encodeExitReason, TERMINAL_WS_CLOSE_DORMANT } from "../../shared/terminal-messages";
import { getDatabase } from "../db";
import { warnThrottled } from "../lib/warn-throttled";
import fs from "fs";
import { decidePark, summarizeRefusals } from "../lib/terminal-idle-park";
import { createChangeLogger } from "../lib/log-on-change";
import { createCeilingReporter } from "../lib/park-ceiling-log";
import { type TerminalKillReason } from "../lib/terminal-kill";
import { isSwapFreezeHold } from "../lib/swap-freeze-hold";
import type { ParkRefusal } from "../lib/terminal-idle-park";
import { referencedSessionIdsIn } from "../lib/orphan-sessions";
import { liveClaudeSessionId, panesToFollow } from "../lib/claude-live-session";
import { claudeTranscriptPath } from "../lib/claude-transcript-path";
import { reportChildEnd } from "../lib/subagent-runtime";
import { terminalClosed } from "../attention/terminal-turns";
import { type TerminalSession, parkedByServer, sessionSockets, sessions, terminalActivity, terminalBrowserCloser } from "./terminal-state";
import { clearTerminalActivity } from "./terminal-activity";
import { sendTerminalKill } from "./terminal-bridge-send";
import { _tracker, broadcastTerminalSessions } from "./terminal-shared";

/**
 * Moves each Claude pane's resume id to the conversation its CLI is on now
 * (`lib/claude-live-session.ts`): after a `/clear` the spawn id points at the
 * conversation from before it. `only` checks one pane, before it is parked.
 */
export function followClaudeSessionIds(only?: TerminalSession): void {
  const moves = panesToFollow(only ? [only] : sessions.values(), liveClaudeSessionId);
  for (const { pane, sessionId } of moves) {
    pane.claudeSessionId = sessionId;
    try { getDatabase().run("UPDATE terminal_sessions SET claude_session_id = ? WHERE id = ?", [sessionId, pane.id]); }
    catch (e) { warnThrottled("terminal_sessions:follow", `[Terminal] terminal_sessions: moving ${pane.id} to session ${sessionId} failed:`, e); }
    _tracker?.registerTerminalSession(sessionId, { cwd: pane.cwd });
  }
  if (moves.length > 0) broadcastTerminalSessions();
}

/** A hook from a session id no pane knows is what a `/clear` sends first. */
export function noteClaudeHookSession(claudeSessionId: string): void {
  for (const s of sessions.values()) if (s.claudeSessionId === claudeSessionId) return;
  followClaudeSessionIds();
}
/**
 * The directories a terminal session lives in, for the sweep's guard
 * (WORKTREE-14). No filter on `ptyPid`: after a restart sessions come back from
 * `terminal_sessions` with no pid, and a session with no pid is still a
 * directory somebody is about to return to. This answer can only ever KEEP, so
 * a false positive costs one directory and a false negative costs a child's
 * work.
 */
export function liveTerminalCwds(): string[] {
  const out: string[] = [];
  for (const s of sessions.values()) if (s.cwd) out.push(s.cwd);
  return out;
}
/**
 * Il ritiro di una sessione di terminale, in un posto solo.
 *
 * PERCHE' NON E' PIU' DENTRO LA `DELETE`. Era il corpo del gestore HTTP, quindi
 * l'unico modo di ritirare una sessione era che un client mandasse quella
 * richiesta. Ma il ritiro nasce anche da altre due parti — la cascata di una tab
 * chiusa (`services/pane-retirement-cascade.ts`) e il riconcilio al boot
 * (`services/retirement.ts#reconcile`) — e ognuna che si scrivesse da sola le
 * proprie pulizie e' esattamente il modo in cui questa sottoparte e' arrivata ad
 * avere tre registri. Sette conseguenze, tutte necessarie, tutte facili da
 * dimenticare: la PTY, i socket, la riga, la fase nel tracker, i timer di
 * attivita', i sotto-agenti, il browser che quella sessione aveva aperto.
 *
 * Ritorna `false` se non c'era niente da ritirare (ne' in memoria ne' nel DB):
 * al chiamante HTTP serve per il 404, agli altri due non cambia niente — su un
 * id sconosciuto e' un no-op, che e' la proprieta' che rende sicuro rigirare il
 * riconcilio.
 */
export function retireTerminalSession(
  id: string,
  ending: 'closed' | 'swept' = 'closed',
  caller: string = ending === 'swept' ? 'orphan-child-sweep' : 'terminal-delete',
): boolean {
  const session = sessions.get(id);
  const db = getDatabase();
  const dbRow = db.query("SELECT id, claude_session_id, type FROM terminal_sessions WHERE id = ?").get(id) as any;
  if (!session && !dbRow) return false;
  // L'id della sessione claude va preso PRIMA di cancellare riga e mappa,
  // altrimenti la fase nel tracker resta appesa per la vita del server (la
  // mappa `terminalStates` si svuota solo da qui).
  const claudeSessionId: string | undefined = session?.claudeSessionId || dbRow?.claude_session_id || undefined;
  const sessionType: string | undefined = session?.type || dbRow?.type;
  if (session) {
    const reason: TerminalKillReason = ending === 'swept' ? 'retirement-sweep' : 'user-close';
    sendTerminalKill(id, reason, caller);
    sessions.delete(id);
    const sockets = sessionSockets.get(id);
    if (sockets) {
      for (const ws of sockets) {
        try { ws.close(1000, "Session killed"); } catch { /* the websocket may already be closed */ }
      }
    }
    sessionSockets.delete(id);
  }
  try { db.run("DELETE FROM terminal_sessions WHERE id = ?", [id]); }
  catch (e) { warnThrottled("terminal_sessions:retire", `[Terminal] terminal_sessions: deleting the row of retired ${id} failed:`, e); }
  if (claudeSessionId && (sessionType === 'claude-code' || sessionType === 'claude-code-team')) {
    _tracker?.dropTerminalSession(claudeSessionId);
  }
  // Il bookkeeping per-sessione (timer busy + lastVisibleSig + lastInputAt). Il
  // percorso di uscita della PTY lo fa gia', ma un ritiro esplicito non ci
  // passa: senza questa riga quelle mappe crescevano per la vita del server.
  clearTerminalActivity(id);
  // I sotto-agenti che questa sessione ha generato: nessuna PTY orfana e
  // pilotabile resta dietro.
  cascadeKillChildren(id, ending === 'swept' ? 'retirement-sweep' : 'parent-delete');
  // A sub-agent retired here (its tab closed, the orphan sweep) is gone from
  // the map before the bridge's `exit` frame arrives, so that frame cannot
  // report it: the parent chat got nothing at all. Report it from here.
  if (session) reportChildEnd(session, null, ending);
  // Il browser che questo terminale puo' aver aperto (contextId `term-<id>`).
  // Best-effort: nessun contesto = no-op innocuo.
  terminalBrowserCloser?.(`term-${id}`);
  terminalClosed(id);
  broadcastTerminalSessions();
  return true;
}

/**
 * Parcheggia le sessioni Claude ferme da troppo: uccide la PTY, la riga resta.
 *
 * Le chat hanno un reaper di inattività (15 min) e un tetto di vita (2 ore); i
 * terminali agente non avevano né l'uno né l'altro. Misurate il 2026-08-02:
 * tredici `claude --resume` vive da tre giorni e cinque ore, ~15% di CPU e
 * 0,9 GB per sessioni ferme a un prompt.
 *
 * Non serve inventare il ripristino: uccidere la PTY fa scattare il percorso di
 * uscita qui sopra (caso "exit"), che per una sessione claude con un
 * `claude_session_id` marca la riga `dormant` e chiama `noteDormant` invece di
 * cancellarla. Da lì `POST /sessions/:id/revive` la rilancia con `--resume`, e
 * il client la rianima da solo quando la pane torna attiva.
 *
 * CHI si parcheggia lo decide `lib/terminal-idle-park.ts`, che è puro e ha 28
 * test: un reaper su questo sottosistema ha già ucciso turni vivi una volta.
 * Qui si raccolgono i fatti e si esegue.
 */
export interface ParkSweepResult {
  parked: string[];
  /** Chi NON e' stato parcheggiato e perche'. Un parcheggio che non si spiega e' un parcheggio che nessuno puo' smentire. */
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Il parcheggio di UNA sessione: raccoglie i fatti, chiede a `decidePark`, e se
 * il permesso c'è uccide la PTY.
 *
 * Estratta perche' i chiamanti sono due — il giro di inattivita' e quello delle
 * ORFANE (`motivo`) — e devono passare per gli STESSI cancelli. Un secondo
 * percorso con la sua copia dei controlli e' esattamente il modo in cui, fra sei
 * mesi, una condizione viene aggiunta da una parte sola.
 */
export function tryParkSession(
  id: string,
  s: TerminalSession,
  thresholdMs: number,
  motivo: string,
  /** Retiring a finished sub-agent is the one park a child admits; `turnEnded`: its own transcript says so, and the tracker's phase (which can miss a turn end) does not veto it. `beforeKill`: runs only once every gate said yes. */
  opts: { allowSubAgent?: boolean; turnEnded?: boolean; beforeKill?: () => void; caller?: string; hasOpenTab?: boolean } = {},
): { parked: true } | { parked: false; reason: ParkRefusal } {
  // The park resumes from this id: it must be the conversation the CLI is on.
  followClaudeSessionIds(s);
  const activity = terminalActivity.get(id);
  const state = s.claudeSessionId ? _tracker?.getSession(s.claudeSessionId) : undefined;
  const phase = opts.turnEnded ? null : state?.phase ?? null;
  const decision = decidePark(
    {
      id,
      type: s.type,
      claudeSessionId: s.claudeSessionId,
      busy: activity?.busy ?? false,
      // Nessuna misura di attività = non lo sappiamo. `decidePark` rifiuta, ed
      // è voluto: trattare "mai visto" come "ferma da sempre" è il modo
      // classico di reapare qualcosa di vivo.
      idleMs: activity?.lastAt ? Date.now() - activity.lastAt : null,
      attachedClients: sessionSockets.get(id)?.size ?? 0,
      hasOpenTab: opts.hasOpenTab,
      hasTranscript:
        !!s.claudeSessionId && fs.existsSync(claudeTranscriptPath(s.cwd, s.claudeSessionId)),
      phase,
      // Topics is holding one of this session's commands STOPped: killing the
      // PTY now would strand it (`lib/swap-freeze-hold.ts`). The freeze lasts
      // ten minutes at most, so the park is postponed, not cancelled.
      hasFrozenTree: isSwapFreezeHold(id),
      // A prompt still open in the TUI, whatever phase the reaper demoted it to.
      awaitingHuman: !!state?.pendingApproval,
    },
    thresholdMs,
  );
  if (!decision.park) return { parked: false, reason: decision.reason };

  // Un sotto-agente non si parcheggia da solo: lo governa il suo orchestratore
  // (cascadeKillChildren), e farlo sparire da sotto cambierebbe il conteggio
  // dei figli vivi senza che nessuno l'abbia chiesto.
  // The exception is a child whose turn was reported and which has sat idle
  // since (choice 5 of subagent-tool-standard): its orchestrator has its
  // result, and the row keeps what `send_to_agent` needs to resume it.
  if (s.parentSessionKey && !opts.allowSubAgent) return { parked: false, reason: "sub-agent" };

  console.log(
    `[Terminal] Parcheggio ${id} (${s.type}) — ${motivo}, ferma da ` +
      `${Math.round((Date.now() - (activity?.lastAt ?? 0)) / 60_000)} min, nessun client attaccato. ` +
      `Torna con --resume alla prossima apertura.`,
  );
  opts.beforeKill?.();
  parkedByServer.add(id);
  sendTerminalKill(id, 'park', opts.caller ?? 'idle-reaper');
  // Il resto — riga a `dormant`, `noteDormant`, chiusura dei socket, broadcast
  // — lo fa il percorso di uscita quando il bridge conferma la morte della
  // PTY. Non lo si anticipa qui: due strade che scrivono lo stesso stato sono
  // due strade che possono divergere.
  return { parked: true };
}

/**
 * Session ids some Topics tab shows, read from `ui_state` with the same
 * extractor the orphan census uses. `null` when the read fails: the caller
 * treats that as "every session has a tab", since not knowing is not a
 * licence to kill.
 */
function openTabSessionIds(): ReadonlySet<string> | null {
  try {
    const ids = new Set<string>();
    const rows = getDatabase().query("SELECT value FROM ui_state").all() as Array<{ value?: string }>;
    for (const row of rows) for (const id of referencedSessionIdsIn(row.value ?? "")) ids.add(id);
    return ids;
  } catch (e) {
    warnThrottled("terminal:open-tabs", "[Terminal] lettura delle tab aperte fallita, niente parcheggio in questa passata:", e);
    return null;
  }
}

// Module-level on purpose: the sweep runs from a timer, and its memory of the
// last printed line must survive between ticks.
const logSweepChange = createChangeLogger();
export const reportCeiling = createCeilingReporter();

export function parkIdleClaudeSessions(thresholdMs: number): ParkSweepResult {
  const parked: string[] = [];
  // `ParkRefusal` e non `string`: il motivo finisce in un log che lo traduce in
  // prosa (`refusalLabel`), e con `string` un motivo nuovo scritto a mano si
  // stamperebbe come `undefined` invece di rompere la compilazione.
  const skipped: Array<{ id: string; reason: ParkRefusal }> = [];
  const openTabs = openTabSessionIds();
  for (const [id, s] of sessions) {
    const r = tryParkSession(id, s, thresholdMs, "nessuna attività", {
      caller: 'idle-reaper',
      hasOpenTab: openTabs === null || openTabs.has(id),
    });
    if (r.parked) parked.push(id);
    else skipped.push({ id, reason: r.reason });
  }
  // A pass that parks nothing says why: the reasons were only returned, and in
  // the log a sweep that refused and a sweep that never ran read the same. The
  // line is printed when the picture changes, plus a heartbeat every 30 min, so
  // a sweep that stopped still shows. An empty pass passes null, which forgets
  // the last line, so the next refusal prints again.
  logSweepChange("park-sweep", skipped.length > 0 ? `[Terminal] Passata di parcheggio: ${summarizeRefusals(skipped)}.` : null);
  return { parked, skipped };
}

/**
 * Parcheggia le sessioni che il censimento ha giudicato ORFANE — quelle che
 * nessuna struttura di `ui_state` referenzia, cioè che nessuna finestra mostra e
 * che quindi nessun gesto umano può chiudere.
 *
 * PASSA DAGLI STESSI CANCELLI del giro di inattività, e non è prudenza
 * decorativa: «orfana» è un giudizio su ciò che è scritto in `ui_state`, e da
 * solo non sa niente di un turno in corso, di una PTY che sta scrivendo adesso o
 * di un transcript sparito dal disco. La soglia di inattività resta perché resta
 * il suo motivo — una sessione che ha appena stampato qualcosa non è ferma,
 * qualunque cosa dica il registro delle pane.
 *
 * Chi decide QUANDO si arriva qui (due censimenti consecutivi, `ui_state` non
 * vuoto, interruttore acceso) è `lib/orphan-park-policy.ts`. Qui si esegue.
 */
export function parkOrphanSessions(ids: readonly string[], thresholdMs: number): ParkSweepResult {
  const parked: string[] = [];
  const skipped: Array<{ id: string; reason: ParkRefusal }> = [];
  for (const id of ids) {
    const s = sessions.get(id);
    // Sparita fra il censimento e adesso: non c'è più niente da parcheggiare.
    if (!s) continue;
    const r = tryParkSession(id, s, thresholdMs, "nessuna interfaccia la mostra", { caller: 'orphan-sweep' });
    if (r.parked) parked.push(id);
    else skipped.push({ id, reason: r.reason });
  }
  if (skipped.length > 0) {
    console.log(`[Terminal] Orfane non parcheggiate: ${summarizeRefusals(skipped)}.`);
  }
  return { parked, skipped };
}

/**
 * The ids whose PTY was dropped on purpose by the e2e fixture below. The `exit`
 * event they are about to raise must NOT unlist them: keeping the row in the
 * roster with no process behind it is the whole point of the fixture.
 *
 * Populated only through `orphanTerminalSession`, which only the e2e router
 * calls, and that router answers nothing unless TOPICS_E2E=1.
 */
export const orphanedForTest = new Set<string>();

/**
 * E2E fixture: the state a SERVER RESTART leaves on a resumable pane - still
 * listed in the roster, nothing running behind it. The attach then replays zero
 * bytes and the pane draws its "session ended" overlay, which is the surface
 * under test (`dormantCause`).
 *
 * Not reachable from the public API by any other road: the roster is built from
 * the live map, and every ordinary way of losing a PTY (exit, park, delete)
 * also takes the entry out of that map. Three stamps, and each one is a fact of
 * the state being reproduced, not a convenience:
 *  - the PTY is killed and the entry stays;
 *  - `type` becomes a resumable one, because a shell is deliberately excluded
 *    from the overlay (it has no frame to replay and cannot be resumed) and the
 *    agent CLIs a real card runs are not installed on a test box;
 *  - `createdAt` moves back, because a finished session is by definition old and
 *    the pane refuses to call a young one dead.
 */
export function orphanTerminalSession(id: string, type: TerminalSessionType = "claude-code"): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  orphanedForTest.add(id);
  try { sendTerminalKill(id, 'test-orphan-fixture', 'e2e-fixture'); } catch { /* bridge down: the PTY is already gone */ }
  s.type = type;
  s.createdAt = new Date(Date.now() - 60_000).toISOString();
  broadcastTerminalSessions();
  return true;
}

/**
 * Park ONE live session the way a restart does when the bridge no longer holds
 * its PTY (`reconcileSessions` -> `decideOnRestart` -> `park`): the live entry
 * goes, the PTY is killed, the row STAYS with `status = 'dormant'`.
 *
 * No gate, on purpose: this is not the idle sweep (`tryParkSession` asks
 * `decidePark`, and a shell never passes it). It exists for the e2e seam
 * `POST /api/test/terminal/:id/park`, which needs the STATE a restart leaves
 * behind without restarting the server - the bridge is a separate daemon that
 * survives a restart, so a restart inside a test would REATTACH the shell, not
 * park it. The live entry is removed BEFORE the kill goes out: the bridge's
 * `exit` handler deletes the row of a shell it still finds in the map, and a
 * deleted row is a different state from a dormant one (1008, not the verdict).
 *
 * Returns `false` when there was nothing live to park.
 */
export function parkTerminalSession(id: string, exitCode: number | null = null): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  const resumable = !!session.claudeSessionId;
  sessions.delete(id);
  const sockets = sessionSockets.get(id);
  if (sockets) {
    for (const ws of sockets) {
      try {
        ws.close(
          resumable ? TERMINAL_WS_CLOSE_DORMANT : 1000,
          resumable ? encodeExitReason('dormant', exitCode) : 'Session parked',
        );
      } catch { /* the websocket may already be closed */ }
    }
    sessionSockets.delete(id);
  }
  clearTerminalActivity(id);
  // `exitCode` is what the bridge would have reported had the process quit by
  // itself: NULL for a park (a restart kills, it does not diagnose).
  try { getDatabase().run("UPDATE terminal_sessions SET status = 'dormant', exit_code = ? WHERE id = ?", [exitCode, id]); }
  catch (e) { warnThrottled("terminal_sessions:park", `[Terminal] terminal_sessions: marking parked ${id} dormant failed:`, e); }
  try { sendTerminalKill(id, 'test-park-fixture', 'e2e-fixture'); } catch { /* bridge down: the PTY is already gone */ }
  broadcastTerminalSessions();
  return true;
}

/** Live children of a parent (present in the in-memory `sessions` map). */
export function liveChildrenOf(parentSessionKey: string): TerminalSession[] {
  return Array.from(sessions.values()).filter(s => s.parentSessionKey === parentSessionKey);
}

/** Kill every live child of a parent that just exited/was deleted. Children are
 *  model-spawned ephemerals, so orphaning them (leaving drivable PTYs with a
 *  dead owner) is worse than reaping them. */
export function cascadeKillChildren(parentSessionKey: string, caller: string) {
  for (const child of liveChildrenOf(parentSessionKey)) {
    try { sendTerminalKill(child.id, 'subagent-cascade', caller); } catch {}
    // The bridge's `exit` frame will clean up maps/DB/tracker for each child.
  }
}

