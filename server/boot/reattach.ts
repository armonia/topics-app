/**
 * What survives a restart: reattach turns, reconcile phases, transcripts and archived sessions, the resume sweep and provider holds.
 */
import { join } from "path";
import { wakeVerdict, runningTaskOwnsTopic, stoppedSubagentChat, launchingChatCanWake } from "../lib/wake-adoption";
import { riprendiTurniInterrotti, type CtxRipresa } from "../lib/ripresa-boot";
import { holdUntilLabel, onProviderHold, configureProviderHoldStore, onPlanUsage, isProviderHeld } from "../lib/provider-hold";
import { wireHoldToResume } from "../lib/provider-hold-broadcast";
import { resolveStateDir } from "../lib/data-dir";
import { existsSync } from "fs";
import { startCardOutcomeWake } from "../services/card-outcome-wake";
import { endReattachLeg } from "../lib/closed-outside";
import { getDefaultProviderName, tryGetProvider, sessionHasPendingSend } from "../providers";
import { sessionHasBackgroundWork, sessionsWithBackgroundWork } from "../providers/background-probes";
import { aiBridgeEnabled, ClaudeCodeProvider } from "../providers/claude-code";
import { sessionKeyOfBrokerId, nativeDetachedEnabled } from "../providers/native/detached-turn";
import { describeTurnEnd } from "../providers/stop-reason";
import { getAiBridgeClient } from "../lib/ai-bridge-client";
import { commandBackgroundWork, commandWakeState, sessionsAwaitingCommandWake } from "../routes/processes";
import { subagentWakeState } from "../lib/subagent-runtime";
import { startProcessExitWakes } from "../lib/process-exit-wake";
import { chatWake } from "../mail/waits/chat-wake";
import { startSubagentWakes } from "../services/subagent-wake";
import { abandonCutTurn, adoptNativeChildrenAtBoot } from "../lib/native-subagents";
import { recomposeAttentionOnBoot } from "../attention/store";
import { attentionBootReader } from "../attention/boot-reader";
import { chatSubjectOfSession, configureAttentionWire, wireHumanHolds } from "../attention/wire";
import { BUSY_SPINNER_PHASES } from "../lib/claude-session-state";
import { findClaudeTranscript, isTranscriptOrphaned } from "../lib/claude-transcript-path";
import { keepLiveTranscripts, restoreSweptTranscript } from "../lib/transcript-keeper";
import { pendingForkSessions } from "../lib/chat-fork-store";
import { decodeCol } from "../../shared/message-blob";
import { postBackgroundNotice } from "../lib/background-notice";
import type { AfterGovernor } from "./scope";
import { late } from "./late";

export function bootReattach(scope: AfterGovernor) {
  const { SERVER_STARTED_AT, activeStreams, broadcastToAll, brokerBootHolds, claudeSessionTracker, ctx, midTurnAtBoot, nativeEndedWhileDown, nudgeResumeSweep, releaseAnswersOwedAtBoot, releaseBootHold, resumeBootHolds, resumeSweepClock, runHeadlessReattach, runHeadlessWoken, taskDispatcher, topicsRouter, turnLedger } = scope;
  // Chat reload-resilience: adopt broker-surviving CHAT turns after a restart.
  // A graceful shutdown/hot-reload DETACHES chat children into the ai-bridge
  // daemon instead of killing them (claude-code stop()); this sweep re-adopts
  // any that were MID-TURN (a partial assistant message exists) so the turn
  // streams on as if nothing happened. Everything else alive in the daemon is
  // REAPED: an idle child costs RAM forever and loses nothing when killed —
  // the next sendChat respawns it with --resume on the same claude_session_id.
  // Without the reap, detach-on-shutdown would leak one orphan child per chat
  // per lifetime (observed: dispatch children from July 18-19 still alive).
  // The dispatcher's reconcile above already REATTACHes the turns of
  // in_progress board tasks — those sessionKeys are left strictly alone so two
  // handlers never race over one child.
  async function reattachSurvivingChatTurns(): Promise<void> {
    // An adopted turn keeps its hold until its leg ends (the route holds it from
    // `startStream` on); every other broker session is decided when this returns.
    const adopted = new Set<string>();
    try { await reattachSurvivors(adopted); }
    finally { for (const sk of [...brokerBootHolds]) if (!adopted.has(sk)) releaseBootHold(sk); }
  }

  async function reattachSurvivors(adopted: Set<string>): Promise<void> {
    if (!aiBridgeEnabled()) return;
    const client = getAiBridgeClient();
    let sessions: Awaited<ReturnType<typeof client.list>>;
    try { sessions = await client.list(); } catch { return; } // no daemon → nothing survived
    const live = sessions.filter((s) => s.alive && s.id.startsWith("topic:"));
    // Native turns: one process per turn under `native:<session key>`. Alive =
    // still working; dead with a journal and a row still open = it ended while
    // no server listened, and the reattach reads its ending from the store.
    const native = sessions
      .map((s) => ({ s, sk: sessionKeyOfBrokerId(s.id) }))
      .filter((x): x is { s: typeof sessions[number]; sk: string } => !!x.sk && nativeDetachedEnabled() && (x.s.alive || (nativeEndedWhileDown.has(x.sk) && midTurnAtBoot.has(x.sk))));
    if (live.length === 0 && native.length === 0) return;
    const dispatcherClaimed = new Set<string>();
    try {
      const rows = ctx.db.query(
        "SELECT assigned_topic_id AS t FROM tasks WHERE status = 'in_progress' AND assigned_topic_id IS NOT NULL",
      ).all() as Array<{ t: string }>;
      for (const row of rows) dispatcherClaimed.add(`topic:${row.t.slice(0, 8)}`);
    } catch (err) {
      console.warn("[chat-reattach] dispatcher claim query failed (skipping reap for safety):", err);
      return;
    }
    for (const { s, sk } of native) {
      if (dispatcherClaimed.has(sk)) continue; // the dispatcher's reconcile owns it
      const topic = ctx.getTopicBySessionKey(sk);
      if (!topic || topic.archived) {
        // A dead store too: left behind, a later turn of the same key took it for its own.
        console.log(`[chat-reattach] ending native turn ${sk}: ${topic ? "archived topic" : "topic gone"}`);
        try { client.kill(s.id); } catch { /* daemon hiccup: its orphan grace collects it */ }
        continue;
      }
      console.log(`[chat-reattach] adopting native turn ${sk} (${s.alive ? "still running" : "ended while the server was down"})`);
      adopted.add(sk);
      runHeadlessReattach(sk, { timeoutMs: 30 * 60_000 }, "topics")
        .then((end) => { if (end.end !== "end_turn") console.warn(`[chat-reattach] ${sk}: ${describeTurnEnd(end)}`); })
        .catch((err) => console.warn(`[chat-reattach] ${sk} failed:`, err?.message ?? err))
        // The leg lasts the whole turn here: the native reattach follows the
        // journal to its end, a question on screen included.
        .finally(() => releaseBootHold(sk));
    }
    // Mid-turn signal captured BEFORE the startup partial-reset above wiped it.
    for (const s of live) {
      if (dispatcherClaimed.has(s.id)) continue; // the dispatcher's reconcile owns it
      const topic = ctx.getTopicBySessionKey(s.id);
      const adoptable = !!topic && !topic.archived;
      // Il DB dice «nessun turno»? Non basta per uccidere. `partial` è l'OMBRA
      // del turno, non il turno: si perde in tutti i modi (finalizzazioni,
      // riattacchi, la route della storia), e quando si perde su una sessione
      // ferma su una DOMANDA il reap ammazza la domanda — pannello vivo che
      // diventa un bottone Retry, osservato su topic:ed2070df. Lo store del
      // broker sa la verità: prima di uccidere, gliela si chiede.
      let brokerSays: "open" | "idle" | "unknown" = "unknown";
      if (adoptable && !midTurnAtBoot.has(s.id)) {
        try {
          const prov = tryGetProvider("claude-code") as { brokerTurnState?: (sk: string, opts?: { park?: boolean }) => Promise<"open" | "idle" | "unknown"> } | undefined;
          // `park: true` è la promessa che qui sotto manteniamo davvero: se la
          // risposta è «open» si riadotta, nella riga dopo. Senza, ogni sessione
          // si faceva spedire l'intero store DUE volte al boot — una per questa
          // sonda e una per la fase 1 della riadozione, tutte sull'unico socket
          // del ponte e tutte prima che l'utente veda qualcosa.
          brokerSays = (await prov?.brokerTurnState?.(s.id, { park: true })) ?? "unknown";
        } catch (err) {
          console.warn(`[chat-reattach] broker turn probe failed for ${s.id} (skipping reap for safety):`, err);
          brokerSays = "unknown";
        }
        if (brokerSays === "unknown") {
          // Nessuna prova di inattività: si lascia stare. Costa un figlio vivo
          // fino al prossimo boot, che è incomparabilmente meno di un turno vivo
          // ucciso per un dubbio.
          console.warn(`[chat-reattach] leaving ${s.id} alone: the broker could not tell whether a turn is in flight`);
          continue;
        }
      }
      if (adoptable && (midTurnAtBoot.has(s.id) || brokerSays === "open")) {
        const why = midTurnAtBoot.has(s.id) ? "partial in DB" : "store del broker aperto";
        console.log(`[chat-reattach] adopting surviving mid-turn broker session ${s.id} (${why})`);
        adopted.add(s.id);
        runHeadlessReattach(s.id, { timeoutMs: 30 * 60_000 })
          // Il turno adottato finisce comunque: se non è finito bene, il log dice
          // PERCHÉ invece di tacere (0.4).
          .then((end) => {
            if (end.end !== "end_turn") console.warn(`[chat-reattach] ${s.id}: ${describeTurnEnd(end)}`);
          })
          .catch((err) => console.warn(`[chat-reattach] ${s.id} failed:`, err?.message ?? err))
          // The leg is over, the TURN may not be: a child parked on
          // `ask_user_question` stays open for hours, and the mute replay that
          // reattaches to it lasts a moment. `endReattachLeg` asks the broker,
          // then lights the leg's row again, or closes what is still open,
          // explains it and tells the open windows.
          .finally(() => { releaseBootHold(s.id); return endReattachLeg(ctx, s.id, tryGetProvider("claude-code")); });
        continue;
      }
      // Idle / archived / deleted-topic session: reap. Guard against a send
      // that raced in during boot and already owns the child.
      try {
        const prov = tryGetProvider("claude-code") as { isTurnProcessAlive?: (sk: string) => boolean } | undefined;
        if (prov?.isTurnProcessAlive?.(s.id)) continue; // adopted by a live turn — hands off
      } catch { /* provider not up yet — reap anyway, a turn can't be running */ }
      // No turn, but the probe above found the work its last turn left running
      // and kept the session attached as its process: reaping it would kill that
      // work, and leave a process in the map for a child that no longer exists.
      try {
        const prov = tryGetProvider("claude-code") as { ownsSession?: (sk: string) => boolean } | undefined;
        if (adoptable && prov?.ownsSession?.(s.id)) {
          console.log(`[chat-reattach] keeping ${s.id}: no turn in flight, but its background work is still running`);
          continue;
        }
      } catch { /* provider not up yet: nothing was kept */ }
      // Il motivo va scritto con le PROVE che l'hanno deciso: quando questo reap
      // si rivelerà di nuovo sbagliato, il log deve dire da quale delle due fonti
      // è arrivata la bugia, non solo che qualcuno è stato ucciso.
      const why = topic
        ? (topic.archived ? "archived topic" : `no in-flight turn (DB partial=no, broker=${brokerSays})`)
        : "topic gone";
      console.log(`[chat-reattach] reaping idle broker session ${s.id} (${why})`);
      // Its background work past the bound (listed tasks, armed crons) dies with it: the chat says so.
      const silent = (tryGetProvider("claude-code") as { takeSilentBackground?: (sk: string) => Array<{ tasks: string[]; why: "silent"; cron?: true }> } | undefined)?.takeSilentBackground?.(s.id) ?? [];
      if (topic) for (const closed of silent) postBackgroundNotice(ctx, { sessionKey: s.id, topicId: topic.id }, { kind: "background-notice", event: "closed", ...closed });
      try { client.kill(s.id); } catch { /* daemon hiccup — next boot retries */ }
    }
  }

  // Boot reconcile of ORPHANED "working" phases — the keystone of "no chat sits
  // stuck spinning for an hour". A hard outage (a launchd bootout, a crash) kills
  // the ai-bridge child MID-TURN; `claude_code_sessions.phase` stays frozen on a
  // busy-spinner phase (starting/running/tool-running) that never returns to
  // terminal, so the loading dots spin forever. The reaper DOES clear it — but a
  // chat session has no PTY idle signal, so the running→dormant demote only fires
  // after `abandonedTimeoutMs` (~60 min of frozen updatedAt): exactly the "fermo
  // 1h55m" the user saw. This closes that window to ~0 by demoting, at boot, every
  // busy-phase topic session the broker CONFIRMS has no live child.
  //
  // Load-bearing safety (mirrors the partial-sweep invariant above): we ONLY act
  // on a CONFIRMED alive-set. If the broker list is unavailable after retries we
  // do NOTHING — a genuinely long turn (a live child the daemon just hasn't
  // answered for yet) must never be wrongly demoted; the 60-min reaper stays as
  // the backstop. Dispatcher-claimed sessions (in_progress board tasks) are left
  // to the dispatcher's own reconcile so the two never race over one session.
  async function reconcileOrphanedBusyPhases(): Promise<void> {
    // 1) Authoritative alive-set (same retry/confirm contract as the partial sweep).
    let aliveSet = new Set<string>();
    let listConfirmed = false;
    if (aiBridgeEnabled()) {
      const client = getAiBridgeClient();
      for (let attempt = 0; attempt < 4 && !listConfirmed; attempt++) {
        try {
          await client.ensureConnected();
          const sessions = await client.list();
          aliveSet = new Set(sessions.filter((s) => s.alive && s.id.startsWith("topic:")).map((s) => s.id));
          listConfirmed = true;
        } catch {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (!listConfirmed) {
        console.warn("[busy-reconcile] broker list unavailable after retries — skipping (60-min reaper remains the backstop); refusing to demote possibly-live turns");
        return;
      }
    } else {
      listConfirmed = true; // no daemon → no live child possible → every busy phase is orphaned
    }

    // 2) Dispatcher-claimed sessions are owned by taskDispatcher.reconcile() — hands off.
    const dispatcherClaimed = new Set<string>();
    try {
      const rows = ctx.db.query(
        "SELECT assigned_topic_id AS t FROM tasks WHERE status = 'in_progress' AND assigned_topic_id IS NOT NULL",
      ).all() as Array<{ t: string }>;
      for (const row of rows) dispatcherClaimed.add(`topic:${row.t.slice(0, 8)}`);
    } catch (err) {
      console.warn("[busy-reconcile] dispatcher claim query failed — skipping for safety:", err);
      return;
    }

    // 3) Every non-archived topic session pinned on a busy-spinner phase.
    const placeholders = BUSY_SPINNER_PHASES.map(() => "?").join(",");
    let busyRows: Array<{ sk: string; csid: string | null; phase: string }> = [];
    try {
      busyRows = ctx.db.query(
        `SELECT s.session_key AS sk, s.claude_session_id AS csid, s.phase AS phase
       FROM claude_code_sessions s
       JOIN topics t ON t.session_key = s.session_key
       WHERE s.phase IN (${placeholders}) AND (t.archived IS NULL OR t.archived = 0)`,
      ).all(...BUSY_SPINNER_PHASES) as Array<{ sk: string; csid: string | null; phase: string }>;
    } catch (err) {
      console.warn("[busy-reconcile] busy-phase query failed:", err);
      return;
    }

    let demoted = 0;
    for (const row of busyRows) {
      if (aliveSet.has(row.sk)) continue;            // live child → real turn, leave it
      if (dispatcherClaimed.has(row.sk)) continue;   // dispatcher owns it
      if (!row.csid) continue;                       // can't address the tracker without a claude_session_id
      // Provably orphaned: demote phase→dormant (persists + broadcasts session:state,
      // stopping the spinner on every live client without a reload).
      const changed = claudeSessionTracker.noteDormant(row.csid);
      if (!changed) continue;
      demoted++;
      console.log(`[busy-reconcile] demoted orphaned ${row.phase} session ${row.sk} (csid ${row.csid.slice(0, 8)}) → dormant`);
      // Nudge any client still holding a local stream view (the server has no
      // in-RAM stream after a restart, so this is idempotent/harmless).
      const topicId = ctx.getTopicBySessionKey(row.sk)?.id;
      broadcastToAll({ type: "stream:end", sessionKey: row.sk, topicId, reason: "server_restart_reconcile" });
    }
    if (busyRows.length > 0) {
      console.log(`[busy-reconcile] scanned ${busyRows.length} busy-phase session(s), demoted ${demoted} orphaned (aliveSet ${aliveSet.size}, listConfirmed=${listConfirmed})`);
    }
  }


  // ── Orphaned-transcript reconcile — un-stick topics whose session can't resume ──
  // A topic runs its Claude session in a cwd (its project, or a bound worktree);
  // Claude stores the transcript under ~/.claude/projects/<encoded-cwd>/<id>.jsonl.
  // When a bound worktree is later reaped the topic degrades to its base project
  // path (the FK nulls worktree_id) but its claude_code_sessions row still points
  // at a claude_session_id whose transcript lived under the *worktree* dir — gone
  // with the checkout. `--resume` in the base cwd then looks where the transcript
  // ISN'T and fails; the topic sits frozen on its last turn (the "quadra" freeze).
  // worktree-store.delete now forgets those sessions at reap time, but topics
  // orphaned BEFORE that fix — or by any other path that moves a cwd out from under
  // a session — still carry a doomed pointer. This boot sweep forgets any topic
  // session whose transcript is missing at the cwd the provider will actually use,
  // so its next turn spawns fresh in the base project (seeded with the DB history
  // recap). Visible chat + any on-disk transcript are untouched.
  const ORPHAN_TRANSCRIPT_GRACE_MS = 5 * 60 * 1000;

  function reconcileOrphanedTranscripts(): void {
    // Never disturb a session a dispatched task is actively running.
    const dispatcherClaimed = new Set<string>();
    try {
      const rows = ctx.db
        .query(
          "SELECT assigned_topic_id AS t FROM tasks WHERE status = 'in_progress' AND assigned_topic_id IS NOT NULL",
        )
        .all() as Array<{ t: string }>;
      for (const row of rows) dispatcherClaimed.add(`topic:${row.t.slice(0, 8)}`);
    } catch (err) {
      console.warn("[orphan-transcript] dispatcher claim query failed — skipping for safety:", err);
      return;
    }

    // A branch waiting for its first turn has no transcript yet, by design.
    let pendingForks: Set<string>;
    try {
      pendingForks = pendingForkSessions(ctx.db);
    } catch (err) {
      console.warn("[orphan-transcript] pending fork query failed — skipping for safety:", err);
      return;
    }

    let rows: Array<{ sk: string; csid: string | null; updated_at: string | null }> = [];
    try {
      rows = ctx.db
        .query(
          `SELECT s.session_key AS sk, s.claude_session_id AS csid, s.updated_at AS updated_at
         FROM claude_code_sessions s
         JOIN topics t ON t.session_key = s.session_key
         WHERE s.claude_session_id IS NOT NULL AND (t.archived IS NULL OR t.archived = 0)`,
        )
        .all() as Array<{ sk: string; csid: string | null; updated_at: string | null }>;
    } catch (err) {
      console.warn("[orphan-transcript] query failed:", err);
      return;
    }

    const now = Date.now();
    let forgotten = 0;
    for (const row of rows) {
      if (!row.csid) continue;
      if (dispatcherClaimed.has(row.sk)) continue;
      if (pendingForks.has(row.csid)) continue;
      const topic = ctx.getTopicBySessionKey(row.sk);
      const cwd = ctx.resolveTopicCwd(topic);
      // Missing because the CLI's 30-day cleanup deleted it is not dead: the kept
      // link puts it back, and the session resumes (lib/transcript-keeper.ts).
      restoreSweptTranscript(ctx.db, cwd, row.csid, `boot ${row.sk}`);
      if (
        !isTranscriptOrphaned({
          cwd,
          claudeSessionId: row.csid,
          updatedAtMs: row.updated_at ? Date.parse(row.updated_at) : 0,
          nowMs: now,
          graceMs: ORPHAN_TRANSCRIPT_GRACE_MS,
          transcriptExists: existsSync,
          // Moved, not gone: `--resume` finds it by id from any folder.
          findAnywhere: (id) => findClaudeTranscript(cwd ?? "/", id),
        })
      )
        continue;
      // Provably unresumable: the transcript isn't where `--resume` will look.
      // Broadcast a terminal `session:state` (dormant) BEFORE deleting the row —
      // noteDormant reads the row from the DB, so it must run while it still
      // exists. This is what clears the PHANTOM in a long-lived client: `stream:end`
      // only quiets the in-chat streaming spinner (signals.ts); the sidebar/tab
      // phase (running / "your turn" fill) lives in the session-state map and is
      // cleared only by a fresh `session:state` or a re-bootstrap. Without this a
      // client that missed the terminating frame shows the topic "stuck working"
      // until it happens to reload — exactly the quadra symptom. dormant renders as
      // no-fill/no-spinner (idle), and the row is deleted right after so the next
      // bootstrap drops the session entirely and the next turn spawns fresh.
      claudeSessionTracker.noteDormant(row.csid);
      try {
        ctx.db.run("DELETE FROM claude_code_sessions WHERE session_key = ?", [row.sk]);
      } catch (err) {
        console.warn(`[orphan-transcript] failed to forget ${row.sk}:`, err);
        continue;
      }
      claudeSessionTracker.dropTerminalSession(row.csid); // drop the in-mem cache copy
      forgotten++;
      console.log(
        `[orphan-transcript] forgot unresumable session ${row.sk} (csid ${row.csid.slice(0, 8)}) — transcript gone at ${cwd}; next turn spawns fresh`,
      );
      // Nudge any client still holding a spinner/stream view (idempotent).
      broadcastToAll({ type: "stream:end", sessionKey: row.sk, topicId: topic?.id, reason: "orphan_transcript_reconcile" });
    }
    if (rows.length > 0) {
      console.log(`[orphan-transcript] scanned ${rows.length} topic session(s), forgot ${forgotten} unresumable`);
    }
  }


  // ── Transcript keeper ── a second name for every resumable session's CLI
  // transcript, so the CLI's own 30-day cleanup cannot take a session Topics
  // still resumes (lib/transcript-keeper.ts). At boot, after the sweeps above, and
  // every six hours: the cleanup needs thirty idle days, any pass in between holds.
  const TRANSCRIPT_KEEP_EVERY_MS = 6 * 60 * 60 * 1000;

  function keepTranscriptsNow(why: string): void {
    try {
      const { kept, pruned } = keepLiveTranscripts(ctx.db);
      if (kept || pruned) console.log(`[transcript-keeper] ${why}: ${kept} kept, ${pruned} dropped`);
    } catch (err) {
      console.warn(`[transcript-keeper] ${why}: pass failed:`, err);
    }
  }

  setInterval(() => keepTranscriptsNow("periodic"), TRANSCRIPT_KEEP_EVERY_MS).unref?.();


  // ── Archived-topic reconcile — le fasi che nessuna superficie può spegnere ──
  // Il gemello di riparazione di `parkTopicSession` (lib/session-parking.ts): il
  // parcheggio all'archiviazione tiene pulito da qui in avanti, ma le sessioni
  // GIÀ trapelate non le ri-archivierà nessuno. Al 2026-08-09 erano 28 — 20 ferme
  // su `awaiting-user`, ultima attività a metà luglio — servite dentro le 206 di
  // `/api/claude-sessions` a ogni bootstrap del client.
  //
  // Diversamente dai due sweep qui sopra, questo NON consulta il broker: una fase
  // viva su un topic archiviato è sbagliata comunque, anche se un figlio fosse
  // vivo (nessuna superficie la mostra, nessun gesto la spegne). Resta però la
  // stessa cortesia verso il dispatcher: un task in corso possiede la sua
  // sessione, e un topic dei tentativi archiviato mentre il task lavora non va
  // toccato sotto i piedi. `noteDormant` è soft — non uccide niente, e il primo
  // hook o riga di transcript rianima.
  function reconcileArchivedTopicSessions(): void {
    const dispatcherClaimed = new Set<string>();
    try {
      const rows = ctx.db.query(
        "SELECT assigned_topic_id AS t FROM tasks WHERE status = 'in_progress' AND assigned_topic_id IS NOT NULL",
      ).all() as Array<{ t: string }>;
      for (const row of rows) dispatcherClaimed.add(`topic:${row.t.slice(0, 8)}`);
    } catch (err) {
      console.warn("[archived-sessions] dispatcher claim query failed — skipping for safety:", err);
      return;
    }

    let rows: Array<{ sk: string; csid: string | null; phase: string }> = [];
    try {
      rows = ctx.db.query(
        `SELECT s.session_key AS sk, s.claude_session_id AS csid, s.phase AS phase
       FROM claude_code_sessions s
       JOIN topics t ON t.session_key = s.session_key
       WHERE t.archived = 1 AND s.phase NOT IN ('dormant', 'completed', 'error')`,
      ).all() as Array<{ sk: string; csid: string | null; phase: string }>;
    } catch (err) {
      console.warn("[archived-sessions] query failed:", err);
      return;
    }

    let parked = 0;
    for (const row of rows) {
      if (!row.csid) continue;
      if (dispatcherClaimed.has(row.sk)) continue;
      if (claudeSessionTracker.noteDormant(row.csid)) parked += 1;
    }
    if (rows.length > 0) {
      console.log(`[archived-sessions] ${rows.length} sessione/i viva/e su topic archiviati, ${parked} parcheggiata/e → dormant`);
    }
  }


  // ── IL TURNO CHE NASCE DA SOLO ────────────────────────────────────────────
  //
  // Un `Monitor` armato dall'agente («avvisami quando il build finisce») consegna
  // il suo evento aprendo un TURNO NUOVO: la CLI risveglia il figlio da sola e
  // produce una risposta vera, senza che nessuno abbia scritto niente. Misurato il
  // 20/08/2026 (CLI 2.1.237, stessa argv di Topics) — la traccia sta accanto a
  // `onWokenTurn` in providers/claude-code.ts.
  //
  // Fino a qui quella risposta si perdeva: nasce dopo un `result`, e dopo un
  // `result` nessuno ascolta più quella sessione. Il tool funzionava, la sua
  // risposta era invisibile — ed è per questo che il Monitor sembrava «perso».
  //
  // La cura riusa la macchina che già esiste. Un turno risvegliato è, per tutto
  // ciò che viene dopo, identico a uno riadottato dopo un riavvio: nessun
  // messaggio da mandare, una riga da riempire, uno stream da finalizzare. Quindi
  // si passa dalla STESSA route, con `mode: "woken"`, e non da una seconda copia
  // della finalizzazione.
  //
  // Fire-and-forget con la sua rete: se l'adozione fallisce (il turno è finito
  // mentre aprivamo la riga, o l'utente ha scritto e ha vinto lui) il log lo dice
  // e la sessione resta esattamente com'era.
  function adottaTurniRisvegliati(): void {
    // Si arma sulla CLASSE, non su un'istanza. Al boot `claude-code` non è ancora
    // registrato — `initProvider` lancia `initProviders()` fire-and-forget, ed è
    // quella a sondare il PATH e a registrarlo — quindi un `tryGetProvider` qui
    // troverebbe `undefined` e uscirebbe zitto: la sveglia sarebbe cablata e mai
    // collegata. Vedi `ClaudeCodeProvider.observeWokenTurns`.
    ClaudeCodeProvider.observeWokenTurns((sessionKey, source, abandon) => {
      const topic = ctx.getTopicBySessionKey(sessionKey);
      // A task agent's topic is born archived yet is alive while its task runs:
      // the rule, and the 8 wakes it used to drop, in `lib/wake-adoption.ts`.
      const verdict = wakeVerdict(topic, (id) => runningTaskOwnsTopic(ctx.db, id), (id) => stoppedSubagentChat(ctx.db, id));
      if (verdict !== "adopt") {
        // Nessuna chat dove metterlo: adottarlo vorrebbe dire scrivere una riga
        // in un posto che l'utente non ha. `false` tells the provider to drop
        // the turn, so it never lands in the next turn somebody asks for.
        console.log(`[woken] ${sessionKey}: turno spontaneo su una topic assente o archiviata — lasciato cadere`);
        return false;
      }
      console.log(`[woken] ${sessionKey}: la CLI ha aperto un turno da sola (Monitor o simile) — lo adotto`);
      // L'ATTESA È FINITA, e va detto PRIMA di guidare il turno.
      //
      // `monitorArmed` è ciò che tiene la sessione in `watching` attraverso lo
      // `Stop` di fine turno (vedi `applyHook`): serviva a non far sembrare
      // inattiva una chat che stava sorvegliando un build. Adesso il Monitor ha
      // consegnato, quindi la sorveglianza è chiusa — e se il flag restasse
      // acceso, lo `Stop` di QUESTO turno rimetterebbe la chat in `watching` con
      // nessuno che guarda più niente: una spia accesa per sempre, che è peggio
      // di una spia che non si accende mai.
      try { claudeSessionTracker.noteWatchDelivered(sessionKey); }
      catch (err) { console.warn(`[woken] ${sessionKey}: attesa non disarmata:`, err); }
      // Whatever the outcome, give the held turn up once the route is done with
      // it. After a real adoption the buffer is already drained and `abandon`
      // does nothing; when the route refused before adopting (a 4xx/5xx, a
      // throw) it drops the turn instead of leaving it for the next sender.
      void runHeadlessWoken(sessionKey, source)
        .then((end) => {
          if (end.end !== "end_turn") console.warn(`[woken] ${sessionKey}: ${describeTurnEnd(end)}`);
        })
        .catch((err) => console.warn(`[woken] ${sessionKey} non adottato:`, err?.message ?? err))
        .finally(abandon);
      return true;
    });
  }

  adottaTurniRisvegliati();


  // One context for every sweep. Beyond the live stream, the sweep asks the
  // providers whether a send is still queued (topic 3019832f, 24/09: resent four
  // times behind a send the watchdog had orphaned), and dates each row against
  // this boot so a notice blames a restart only when one happened.
  const resumeCtx: CtxRipresa = {
    // The sessions held at boot for the resume are free once it has decided about them.
    decided: (resuming) => { for (const sk of [...resumeBootHolds]) if (!resuming.includes(sk)) releaseBootHold(sk); },
    resendStarted: (sk) => releaseBootHold(sk),
    db: ctx.db,
    getTopicBySessionKey: (sk) => ctx.getTopicBySessionKey(sk),
    defaultProvider: getDefaultProviderName,
    isStreaming: (sk) => ctx.isStreaming(sk),
    // The resend carries `ripresa`, so the route's gate ignores the boot hold too.
    turnOpen: (sk) => turnLedger.isOpen(sk, { ignore: ["boot"] }),
    providerBusy: sessionHasPendingSend,
    bootedAtMs: SERVER_STARTED_AT,
    broadcast: (msg) => ctx.broadcastToAll(msg),
    backgroundCommands: (sk) => commandBackgroundWork.tasks(sk).flatMap((t) => (t.processId ? [{ description: t.description, processId: t.processId }] : [])),
    abandonCut: abandonCutTurn,
  };
  late.resumeCtx = resumeCtx;


  // Chain reconcile AFTER reattach: reattach adopts survivors (keeps their broker
  // child alive → they stay in the alive-set → reconcile skips them) and reaps
  // idle children (so reconcile's fresh list sees them dead → demotes their
  // phantom phase). Running it after avoids a race where a just-reaped session is
  // still listed alive. The orphaned-transcript sweep runs last: reattach has by
  // then re-homed every survivor, so a missing transcript is proof of a dead cwd.
  // In coda `riprendiTurniInterrotti`: rimanda i turni uccisi dal riavvio che
  // nessuno riadotterà (`lib/ripresa-boot.ts`).
  const survivingTurnsAdopted = reattachSurvivingChatTurns();

  // The ends of `run_command` processes reach their topics once the surviving
  // turns are adopted (before, a session could look free mid-turn), in a branch
  // of their own: a sweep below that throws skips the rest of its chain, and the
  // wakes would have waited for the next boot without a word in the log.
  void survivingTurnsAdopted
    .catch(() => { /* logged by the chain below */ })
    .then(() => releaseAnswersOwedAtBoot?.());

  void survivingTurnsAdopted
    .catch(() => { /* logged by the chain below */ })
    .then(() => startProcessExitWakes({
      db: ctx.db, getTopicById: ctx.getTopicById, defaultProvider: getDefaultProviderName,
      ownedByRunningTask: (id) => runningTaskOwnsTopic(ctx.db, id),
      isBusy: (sk) => activeStreams.has(sk), route: topicsRouter,
      log: (m) => console.log(`[process-exit] ${m}`),
    }));

  // A chat that waits for a mail is woken through the same route, once the surviving turns are adopted.
  void survivingTurnsAdopted
    .catch(() => { /* logged by the chain below */ })
    .then(() => {
      late.mailWakeChat = chatWake({
        route: topicsRouter, isBusy: (sk) => activeStreams.has(sk),
        chatOpen: (sk) => { const topic = ctx.getTopicBySessionKey(sk); return !!topic && !topic.archived; },
        providerHeld: (sk) => isProviderHeld(ctx.getTopicBySessionKey(sk)?.provider || getDefaultProviderName() || "claude-code"),
        log: (m) => console.log(`[mail-wait] ${m}`),
      });
    });

  // One answer for the wakes that return the outcome of work a chat
  // launched (sub-agent result, card outcome): an archived
  // chat that launched THAT work after a person archived it is alive
  // (`lib/wake-adoption.ts`).
  const canWakeLaunchingChat = launchingChatCanWake({
    db: ctx.db,
    getTopicBySessionKey: (sk) => ctx.getTopicBySessionKey(sk),
    isProviderHeld,
    defaultProvider: () => getDefaultProviderName() ?? undefined,
  });

  // The results of `spawn_agent` children wake their parent chats on the same
  // condition, and for the same reason (SUBAGENT-12).
  void survivingTurnsAdopted
    .catch(() => { /* logged by the chain below */ })
    .then(() => startSubagentWakes({
      route: topicsRouter,
      isBusy: (sk) => activeStreams.has(sk),
      canWake: canWakeLaunchingChat,
      log: (m) => console.log(`[subagent-wake] ${m}`),
    }));

  // A card a chat sent to work wakes that chat when it reaches review or done,
  // or fails, on the same condition as the wakes above.
  void survivingTurnsAdopted
    .catch(() => { /* logged by the chain below */ })
    .then(() => startCardOutcomeWake({
      route: topicsRouter,
      isBusy: (sk) => activeStreams.has(sk),
      sessionKeyOfTopic: (id) => ctx.getTopicById(id)?.sessionKey ?? null,
      canWake: canWakeLaunchingChat,
      log: (m) => console.log(`[card-outcome] ${m}`),
    }));

  // Native children still `running` after the restart: their turn may have been
  // resumed with their chat, or lost with the process. Watched, then reported.
  void survivingTurnsAdopted
    .catch(() => { /* logged by the chain below */ })
    .then(() => adoptNativeChildrenAtBoot())
    .catch((err) => console.warn("[subagent-native] boot adoption failed:", err));

  // THE ATTENTION STATE AT EVERY START (notifications-redesign, section 7):
  // once the surviving turns and their children are adopted, the store reads
  // its table again, the re-read inputs from where they live, ends the subjects
  // whose process is gone, and recomposes everything with no epoch and no
  // announce. The waits of the bridges are wired from here on.
  configureAttentionWire({ cardForSession: (sk) => taskDispatcher.taskForSession(sk) });

  wireHumanHolds();

  void survivingTurnsAdopted
    .catch(() => { /* logged by the chain below */ })
    .then(() => {
      try {
        recomposeAttentionOnBoot(attentionBootReader({
          db: ctx.db,
          loadActiveThread: ctx.loadActiveThread,
          getTopicById: ctx.getTopicById,
          cliHasWork: sessionHasBackgroundWork,
          commandOwesWake: (sk) => commandWakeState(sk) !== "none",
          subagentOwesWake: (sk) => subagentWakeState(sk) !== "none",
          dispatchedSubjects: () => taskDispatcher.sessionsInFlight().map((sk) => chatSubjectOfSession(sk)).filter((x): x is string => !!x),
          decode: decodeCol,
        }));
      } catch (err) {
        console.error("[attention] boot recomposition failed:", err);
      }
    });

  survivingTurnsAdopted
    .then(() => reconcileOrphanedBusyPhases())
    .then(() => reconcileOrphanedTranscripts())
    .then(() => keepTranscriptsNow("boot"))
    .then(() => reconcileArchivedTopicSessions())
    .then(() => riprendiTurniInterrotti(resumeCtx, topicsRouter))
    // The sessions the reattach kept for their background work, and those a
    // `run_command` still owes a wake: their goals wait again.
    .then(() => late.goalLoop?.resumeAfterBoot([...new Set([...sessionsWithBackgroundWork(), ...sessionsAwaitingCommandWake()])]))
    .catch((err) => console.error("[chat-reattach] boot sweep failed", err))
    .finally(() => {
      // Whatever the chain decided or failed to: no session stays held past it.
      for (const sk of [...brokerBootHolds, ...resumeBootHolds]) releaseBootHold(sk);
      resumeSweepClock.start();
    });


  // The hold is news for every open chat, and a lift nudges the resume sweep
  // (lib/provider-hold-broadcast.ts).
  wireHoldToResume(onProviderHold, { broadcast: broadcastToAll, nudge: nudgeResumeSweep });


  // And the reading on the way there: how full the window is, said whenever
  // either source speaks (the CLI event, or a usage read the retry loop already
  // made). The status bar shows it long before anything stops.
  onPlanUsage((usage) => {
    broadcastToAll(usage
      ? { type: "provider:usage", fiveHour: usage.fiveHour, sevenDay: usage.sevenDay, observedAtMs: usage.observedAtMs }
      : { type: "provider:usage", fiveHour: null, sevenDay: null, observedAtMs: Date.now() });
  });


  // A HOLD MUST BE ABLE TO END ON ITS OWN. The memo is cleared by a successful
  // NATIVE turn (`agent-loop.ts` calls `releaseHoldIfFreed`), and by nothing else.
  // But the dispatcher and the resume sweep both WAIT on the hold, so while it is
  // in force no card turn starts, and on a machine whose board runs claude-code a
  // native turn may never run at all. And when the person switches account
  // (`claude /login` → a fresh, unspent window) the old hold has no reason left.
  // Measured 2026-09-04: a hold set from the OLD account's spent week (reset
  // 2026-09-09) froze the whole board for days while the NEW account sat at 73%,
  // because the only release path could not fire behind the wall it created. So
  // while a hold is in force we re-read the usage endpoint with the CURRENT
  // credential on a short timer and lift it the instant no window is spent — an
  // account switch or a silent free heals within one tick, not on the next boot.
  const HOLD_RECHECK_MS = 90_000;

  // THE MEMO OUTLIVES THE PROCESS. Mirrored in the state dir (next to the
  // ai-bridge store), adopted here if a previous process left one that has not
  // ended: a hot reload in a spent window no longer forgets the wall.
  {
    const restored = configureProviderHoldStore(join(resolveStateDir(process.cwd()), "provider-hold.json"));
    if (restored) console.log(`[provider-hold] restored from disk: ${restored.reason}, until ${holdUntilLabel(restored)}`);
  }

  return { HOLD_RECHECK_MS, resumeCtx };
}
