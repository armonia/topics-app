import type { AppContext, RouteHandler, Topic } from "../types";
import { getProvider, type AIProvider } from "../providers";
import { stopBackgroundOnly } from "../providers/background-probes";
import { type ChatGoalLoop } from "../services/goal-continuation";
import { turnEnded } from "../attention/store";
import { topicSubject } from "../../shared/attention";
import { logMachineStop, logStopPressed } from "../db/activity-log";
import { isMachineStop, machineStopToolError, stopCauseOf, stopReachesSubagents } from "../lib/abort-cause";
import { leaveMachineStopNotice } from "../lib/machine-stop-notice";
import { isEligibleGlobalOrchestratorSession, isGlobalOrchestratorSession } from "../services/global-orchestrator-session";
import { shouldHonorClearMessages } from "../../shared/clear-messages-policy";
import { clearActionFor } from "./clearPolicy";
import { writeQueuedWakesAsRows } from "../services/subagent-wake";
import { stopNativeChildrenOf } from "../lib/native-subagents";
import { releaseHumanHold } from "../lib/human-hold";
import { recordTurnEnd } from "../providers/turn-end-registry";
import { cancelled } from "../providers/stop-reason";

/** POST /api/chat/abort. */
export function createChatAbortRoutes(
  ctx: AppContext,
  deps: {
    resolveProvider: (topic?: Topic | null) => AIProvider;
    goalLoop: ChatGoalLoop;
  },
): RouteHandler {
  const { resolveProvider, goalLoop } = deps;
  const { broadcastToAll, getTopicBySessionKey, loadLocalMessages, countMessagesBySession, saveLocalMessages, appendLocalMessage, updateLastMessage, discardIfEmptyTurn, endStream, readJSON, json, activeStreams, db } = ctx;

  return async function chatAbortRoutes(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    // --- Abort streaming ---
    if (method === "POST" && pathname === "/api/chat/abort") {
      const body = await readJSON(req);
      const sessionKey = body?.sessionKey;
      if (!sessionKey) return json({ error: "sessionKey required" }, 400);
      const rawGlobalAbort = isGlobalOrchestratorSession(db, sessionKey);
      if (rawGlobalAbort && !isEligibleGlobalOrchestratorSession(db, sessionKey)) {
        return json({
          error: "the global coordinator topic invariant is violated",
          code: "orchestrator_topic_invariant",
        }, 409);
      }

      const streamAtStop = activeStreams.get(sessionKey);

      // Resolve topic and provider for abort — O(1) UNIQUE-index lookup
      // instead of a full topics scan per /api/chat/abort hit.
      const abortTopic = getTopicBySessionKey(sessionKey);
      const topicId: string | undefined = abortTopic?.id;
      let abortProvider: AIProvider;
      try {
        // A healthy coordinator may be stopped, but never through a mutable
        // provider/default resolution. A corrupt one exited above before any
        // provider operation could reach any runtime.
        abortProvider = rawGlobalAbort ? getProvider("codex") : resolveProvider(abortTopic);
      } catch (err) {
        return json({ error: `provider unavailable: ${err instanceof Error ? err.message : String(err)}` }, 503);
      }

      // `clearMessages` è una PROPOSTA del client, non un ordine, e la risposta
      // — il campo `cleared` — è ciò che autorizza il client a svuotare la
      // pagina, chiudere la pane e archiviare il topic. Prima il client non la
      // leggeva e decideva da solo: il 10 agosto 2026 una chat viva è sparita
      // dalla vista mentre qui il wipe veniva rifiutato.
      const decideClear = (): boolean => {
        if (!body?.clearMessages) return false;
        const stored = loadLocalMessages(sessionKey);
        // Il conteggio della sessione INTERA, non del solo ramo attivo: è la
        // cancellazione che colpisce tutta la session_key, quindi è su quella
        // che si deve decidere.
        const decision = shouldHonorClearMessages(stored, countMessagesBySession(sessionKey));
        if (!decision.shouldWipe) {
          console.warn(
            `[Abort] Ignored clearMessages=true for ${sessionKey} — DB has ${decision.userCount} user / ${decision.assistantCount} assistant messages` +
            (decision.assistantDidWork ? ", e il turno aveva già prodotto lavoro"
             : decision.hiddenRows > 0 ? `, e la sessione ha ${decision.hiddenRows} righe fuori dal ramo attivo`
             : ", not first-message")
          );
          return false;
        }
        // Si scrive PRIMA di cancellare, e sul ramo che cancella. Finora il
        // log parlava solo quando RIFIUTAVA: la distruzione di una chat non
        // lasciava una riga che la nominasse, e nell'incidente dell'8 agosto
        // l'unica traccia era un `resetSession` a due righe di distanza.
        console.log(
          `[Abort] ${sessionKey}: chat cancellata su clearMessages=true — ${decision.userCount} utente / ${decision.assistantCount} assistente, nessun lavoro prodotto`
        );
        saveLocalMessages(sessionKey, []);
        // Stesso taglio di `/clear`, per la stessa ragione: qui la chat viene
        // buttata via INTERA (era il primo messaggio, fermato prima della
        // risposta). Senza questo la riga `claude_code_sessions` resta, e la
        // chat "nuova" che l'utente riapre riprende con `--resume` su una
        // sessione che ricorda il messaggio appena annullato.
        if (clearActionFor(abortProvider).kind === "reset") {
          abortProvider.resetSession!(sessionKey).catch((err: any) =>
            console.warn(`[Abort] resetSession failed:`, err),
          );
        }
        return true;
      };

      // A person's Stop reaches the sub-agents working for this chat too
      // (subagent-nativi): left running, a child woke the parent just stopped.
      // «Send now» stops only the turn (`stopReachesSubagents`). The results
      // already queued to wake this chat land as rows: woken by them, the chat
      // just stopped started again at once.
      const fullStop = stopReachesSubagents(req, body?.cause);
      if (fullStop) writeQueuedWakesAsRows(sessionKey);
      const stoppedChildren = fullStop ? await stopNativeChildrenOf(sessionKey) : 0;
      // Read again after the children's stop: the turn this Stop was for may
      // have ended meanwhile, and a turn opened since (a wake) is not its own.
      const stream = activeStreams.get(sessionKey) === streamAtStop ? streamAtStop : undefined;
      if (!stream) {
        const background = await stopBackgroundOnly(sessionKey, stopCauseOf(req, body?.cause), () => goalLoop.stopWaiting(sessionKey));
        if (background) return json(background); // only background work was left: the Stop was for it
        if (stoppedChildren > 0) return json({ ok: true, stoppedSubagents: stoppedChildren, cleared: false });
        // Niente da fermare: turno già finito, oppure una finestra che stava
        // solo guardando quello di un'altra. Nessun effetto — né sul provider
        // (un `abort` alla cieca taglierebbe un turno headless che questo
        // server non ha in `activeStreams`) né sulle righe: `cleared: false`
        // esplicito, così il client sa che non deve buttare via niente.
        // Il prezzo è al più una chat usa-e-getta che resta aperta; il prezzo
        // opposto sarebbe cancellare la domanda di un turno ancora vivo.
        return json({ ok: false, reason: "no_active_stream", cleared: false });
      }

      // CHI ha fermato il turno si DEPOSITA, prima di qualunque altra cosa.
      //
      // Chi guida un turno headless (`runHeadlessTurn` in server.ts) legge la
      // fine da `takeTurnEnd`, e quando non la trova assume `end_turn`. Da qui
      // non ci passava mai: `stream.abortController.abort()` fa scattare il
      // listener della route di chat, che latcha `streamState = "finalized"`, e
      // da quel momento `finalizeStream` esce alla prima riga — quindi il suo
      // `recordTurnEnd` non gira. Uno stop premuto da una persona arrivava al
      // dispatcher come una consegna RIUSCITA: bruciava un tentativo e
      // rilanciava l'agente all'istante, sul task che l'umano aveva appena
      // fermato.
      //
      // `cancelled("user")` è quello che il provider stesso depositerebbe: se la
      // sua finalizzazione arriva comunque, riscrive lo stesso verdetto.
      //
      // WHO stopped it is said by the caller (lib/abort-cause.ts, card C9): a
      // request from outside is the person; the server's own callers (the
      // stall judge, the board, the dispatcher's clocks) name theirs.
      const cause = stopCauseOf(req, body?.cause);
      // Named after the turn it stops (`recordTurnStart` in chat.ts): the user row it answers.
      recordTurnEnd(sessionKey, { ...cancelled(cause, "POST /api/chat/abort"), turnId: (stream.messageId ? ctx.getMessageById(stream.messageId)?.parentId : null) ?? undefined });
      // Said BEFORE anything below can close the turn: the close of the ledger
      // (`endStream` here, the provider's own finalize, the CLI's exit) reaches
      // every window before this route's `stream:end`, and must itself say that
      // a person stopped it, or another device drains its queue into the Stop.
      if (cause === "user") ctx.turnLedger?.noteEnd(sessionKey, { stopped: true });
      // The registry above is memory, and the server reloads on every save: the
      // durable trace is what keeps the resume sweep from resending a stopped
      // message after the next restart (topic c5d57a41, 24/09). A person's
      // Stop only: a machine's recycle recorded here was never resumed.
      if (cause === "user") logStopPressed({ sessionKey, topicId });
      else if (stream.messageId) logMachineStop({ sessionKey, topicId, cause, messageId: stream.messageId });
      // The message this turn was answering, read NOW: the provider's abort
      // below can finalize and discard the turn's row synchronously (claude-code),
      // and after that nothing says which message it hung from.
      const answeredMessageId = isMachineStop(cause) && stream.messageId
        ? ctx.getMessageById(stream.messageId)?.parentId ?? null
        : null;

      // PRIMA il provider, POI il controller dell'SSE. L'ordine conta: l'abort
      // del controller chiude la macchina a stati della route, quindi tutto ciò
      // che il provider ha ancora da dire su questo turno (il suo `onAborted`,
      // con la ragione autorevole) troverebbe un `finalizeStream` già spento.
      // A stop the machine wanted takes the same path, with its true cause: the
      // finalize knows it and writes no notice for it (lib/abort-cause.ts).
      if (cause !== "user") console.log(`[Abort] ${sessionKey}: stopped by the machine (${cause})`);
      if (abortProvider.connected) {
        abortProvider.abort?.(sessionKey, undefined, cause)?.catch((err: any) => console.warn(`[Abort] Provider abort failed:`, err));
        abortProvider.unregisterStreamHandler?.(sessionKey);
      }

      // Abort the gateway request (HTTP fallback)
      if (stream.abortController) {
        try { stream.abortController.abort(); } catch { /* the controller may already be aborted */ }
      }

      // If a `mcp__topics__ask_user_question` bridge handler is blocked waiting
      // for this session's human answer, unblock it with an error so the CLI
      // turn tears down now instead of hanging on the 10-min ask timeout.
      releaseHumanHold(sessionKey, "turn aborted");

      // Fermare un turno PRIMA che il modello dica qualcosa lasciava in chat il
      // segnaposto creato all'inizio dello stream, finalizzato vuoto: una bolla
      // senza niente dentro, che poi rientra nella history rimandata al modello
      // a ogni turno successivo. Ne contiamo a decine nei giorni di dispatch.
      // Ora un turno che non ha prodotto niente non lascia niente — mezza frase
      // o una tool call sono invece lavoro fatto e restano (vedi shared/empty-turn.ts).
      let discardedMessageId: string | null = null;
      const finalizeAborted = () => {
        // ON THIS TURN'S ROW, by id, never on "the last row": a row born after
        // the turn (a resend's user row, a sweep notice) took the partial
        // answer over its own text, or was blanked by a Stop before the first
        // token (card 1046df0b). A row the provider's own finalize already
        // discarded (`onAborted` -> finalizeStream in chat.ts) is not found,
        // and then nothing is written and nothing is discarded.
        if (!stream.messageId) return;
        const finalized = updateLastMessage(
          sessionKey,
          { content: stream.content, thinking: stream.thinking || undefined, partial: undefined, streamedAt: undefined, endReason: "stopped" },
          { rowId: stream.messageId },
        );
        // An empty placeholder with rows under it is kept by the discard itself
        // (`discardIfEmptyTurn`): what hangs from it was born during the turn.
        discardedMessageId = discardIfEmptyTurn(sessionKey, finalized);
        if (discardedMessageId) console.log(`[Abort] ${sessionKey}: turno vuoto scartato (${discardedMessageId})`);
      };
      const clearedForReal = decideClear();
      // Rifiutata (o mai proposta): si passa dalla finalize normale, così non si
      // perde il contenuto parziale che l'utente stava per fermare.
      if (!clearedForReal) finalizeAborted();

      // The tools still open are closed and announced, as the watchdogs do
      // (chat.ts `endStreamAndAnnounce`): a provider whose abort ends the turn
      // later (ACP, Codex) never reaches the finalize that told the screens.
      // A machine's stop says so on them, not "Interrotto…", which the boot's
      // repair pass would take for a turn to resume.
      const closedBecause = isMachineStop(cause) ? machineStopToolError(cause) : undefined;
      // A Stop ends the question on screen too: it is the one explicit cancel
      // a person has, and the panel then says so (`askEnded: 'cancelled'`).
      for (const tc of endStream(sessionKey, { ...(closedBecause ? { closedBecause } : {}), cancelQuestions: true })) {
        broadcastToAll({
          type: "stream:tool_result", sessionKey, topicId, toolCallId: tc.id, status: "error",
          result: tc.result, error: tc.error, endedAt: tc.endedAt,
          ...(tc.askEnded ? { askEnded: tc.askEnded } : {}),
          ...(stream.messageId ? { messageId: stream.messageId } : {}),
        });
      }
      // An empty turn the machine stopped leaves one service row, so the chat
      // does not end on the unanswered envelope and no Retry is offered for it.
      // Here, after both finalizes: whichever ran first discarded the row.
      if (isMachineStop(cause) && answeredMessageId && topicId) {
        leaveMachineStopNotice({ getMessageById: ctx.getMessageById, loadLocalMessages, appendLocalMessage, broadcastToAll }, { sessionKey, topicId, cause, answeredMessageId });
      }

      // user_abort: user explicitly clicked stop — they are present in the tab,
      // so we intentionally do NOT increment unread count. This is a design
      // choice, not an omission. A machine's stop says it was cancelled, with
      // no cause: a cause would paint the live banner the row does not carry.
      broadcastToAll({
        type: "stream:end", sessionKey, topicId,
        ...(cause === "user" ? { reason: "user_abort" } : { reason: "aborted", stopReason: "cancelled" }),
        ...(discardedMessageId ? { discardedMessageId } : {}),
      });
      // A stop closes the turn with nothing to announce (T12).
      if (topicId) turnEnded(topicSubject(topicId), {});

      return json({ ok: true, cleared: clearedForReal });
    }

    return null;
  };
}
