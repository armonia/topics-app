import { classifyTurnError, isAcpStopReason, type TurnEndInfo } from "../providers/stop-reason";
import { stripSlowAnnotation } from "./stream-markers";
import { logStreamAborted, logStreamComplete, logStreamError, logStreamRecovered } from "../db/activity-log";
import { recordTurnEnd } from "../providers/turn-end-registry";
import { isMachineStop } from "../lib/abort-cause";
import { abortLogTitle, avvisoPerTurno, outageCutNotResent, resumesByItself } from "../lib/cancelled-notice";
import { rowCarriesWork } from "./crashedTurnNotice";
import { findPlanAwaitingApproval, planApprovalSchema, shouldAskPlanApproval } from "../lib/plan-approval";
import { permissionModeForAutonomy } from "../lib/autonomy-mode";
import { planApprovalOpened } from "../attention/wire";
import { toolOutcomeAtTurnEnd } from "../lib/tool-finalize-status";
import { mergeReattachedRow } from "./reattachMerge";
import type { ContentBlock } from "../types";
import { backgroundOfTurn, type TurnEndInfo as GoalTurnEnd } from "../services/goal-continuation";
import { sessionHasOpenQuestion } from "../lib/question-outlives-asker";
import { decodeCol } from "../../shared/message-blob";
import { commandWakeState } from "./processes";
import { subagentWakeState } from "../lib/subagent-runtime";
import { type TurnToolTrace } from "../lib/media-ownership";
import { attachMediaOfTurn } from "../lib/attach-media-of-turn";
import { resolveTurnCheckpointsEnabled } from "../services/app-settings";
import { captureTurnCheckpoint } from "../services/turn-checkpoints";
import type { ChatTurnScope } from "./chat-turn-scope";

/** Builds `finalizeStream`, the one place a streamed turn ends. */
export function createFinalizeStream(turn: ChatTurnScope): void {
  const { WORKSPACE_DIR, appendLocalMessage, autoBindProject, backgroundForAttention, blocks, boardAgentTurn, body, broadcastToAll, broadcastTurnFrame, clearAllTimers, closeClient, ctx, db, directAnswer, discardIfEmptyTurn, dispatched, endStreamAndAnnounce, endTurnAttention, finalizeTurnActivity, findNewMediaFiles, globalOrchestrator, goalLoop, hooks, humanWait, isReattach, isWoken, matchedTopic, ownMirrored, ownRow, partialMsg, readRowForNotice, reattachSnapshot, releaseTurnBodyFlush, requestStartMs, reusedRow, sentByPerson, sessionKey, trackedToolCallIds, turnBody, turnId, updateBlockTool, updateLastMessage, updateLastMessageWithMedia, updateToolCallFields, updateToolCallResult, updateUnreadCount, watchSessionForSubagents, writeSSE, writeToolResultSSE, writeTurnEnd } = turn;
  // Helper: finalize the stream (called on done/error/abort)
  const finalizeStream = async (
    reason: "done" | "error" | "aborted",
    errorMsg?: string,
    /**
     * PERCHÉ il turno è finito, quando il provider lo sa. Manca solo
     * quando finalizza un timer nostro (soft/hard watchdog): lì la
     * ragione la conosce il chiamante e la passa esplicitamente.
     */
    turnEnd?: TurnEndInfo,
  ) => {
    // Idempotent. A timeout path (handleGraceExpiry/handleHardTimeout) may
    // have already finalized and aborted this stream; a late provider
    // callback — `onDone` from an orphaned turn, or `onAborted` from the
    // abort() those handlers now issue — must not re-persist content or
    // re-broadcast to clients that already closed the stream out.
    if (turn.streamState === "finalized") return;
    // Always cancel pending timers — the stream is over.
    clearAllTimers();
    // Recovery path: if the provider succeeded after the soft
    // timeout fired, we want the user to see the real content,
    // not the "[stream slow]" annotation. Strip it and emit a
    // recovered log entry so we have telemetry on near-misses.
    if (turn.streamState === "soft-timed-out") {
      const beforeStrip = turn.fullContent;
      turn.fullContent = stripSlowAnnotation(turn.fullContent);
      if (beforeStrip !== turn.fullContent && matchedTopic) {
        broadcastToAll({
          type: "stream:resumed",
          sessionKey,
          topicId: matchedTopic.id,
          messageId: partialMsg.id,
        });
      }
      logStreamRecovered({
        sessionKey,
        topicId: matchedTopic?.id,
        durationMs: turn.softTimedOutAtMs ? Date.now() - turn.softTimedOutAtMs : undefined,
        extra: { finalizeReason: reason },
      });
    }
    turn.streamState = "finalized";
    // THE NOTICE THIS TURN LEAVES IN THE CHAT, if it died. Set wherever
    // an error block is written below (provider error, empty reply, a
    // cancel that was not the user's) and put on the `stream:end` wire
    // as `reason: "error"` + `error`, which is what the failure push
    // (push-triggers, `chat-error`) reads. Without it the push had no
    // way to tell a dead turn from a stopped one and stayed quiet.
    let turnError: string | undefined;

    // La ragione della fine, decisa UNA volta. Se il provider non l'ha
    // detta si ricava da com'è finito lo stream: `error` porta con sé il
    // testo, che è l'unico posto dove un limite di token o un rifiuto
    // possono ancora essere riconosciuti.
    const endInfo: TurnEndInfo = turnEnd
      ?? (reason === "error"
        ? classifyTurnError(errorMsg ?? "", "provider-error")
        : reason === "aborted"
        ? { end: "cancelled" }
        : { end: "end_turn" });
    // Depositata PRIMA di chiudere l'SSE: chi guida un turno headless la
    // ritira appena il drain finisce, e il drain finisce con `[DONE]`.
    recordTurnEnd(sessionKey, { ...endInfo, turnId });
    // A land, a delegation's deadline, the stall judge (lib/abort-cause.ts).
    // The silence cap shares `wall-clock` but ends through `onError`.
    const wantedByMachine = reason === "aborted" && isMachineStop(endInfo.cause);

    if (reason === "error" && errorMsg) {
      // Il verdetto entra nei BLOCCHI, che sono ciò che il client rende.
      // Il testo in `fullContent` NON si decide qui: su una riadozione
      // `fullContent` è ancora vuoto (il replay è muto) e lo diventa solo
      // dopo la rifusione dello snapshot, più in basso. Deciderlo adesso
      // vorrebbe dire scrivere il cartello su un turno che c'è.
      // A saturated API (`rate-limit`) gets the notice the resume
      // recognises instead of the raw "API 429 ..." text: that text
      // is in the server log, and in the chat it was the one error
      // nobody ever resumed (2026-09-04, two chats stuck for hours).
      const shown = avvisoPerTurno(endInfo, { haProdotto: true, riprendeDaSolo: !outageCutNotResent(endInfo.cause, blocks, directAnswer) }) ?? errorMsg;
      blocks.push({ kind: "error", text: shown.replace(/^⚠️\s*/, "") });
      turnError = shown;
      if (matchedTopic) {
        broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: shown });
      }
    }

    // «Nessuna risposta» solo se davvero non è arrivato NIENTE — e
    // "niente" si misura sulla RIGA, non su questa gamba HTTP.
    //
    // `trackedToolCallIds` conta i tool visti da QUESTO handler: su una
    // riadozione dopo un hot-reload il replay è muto, quindi resta vuoto
    // anche quando la riga in DB porta un turno intero di tool. Bastava
    // quello per riscrivere il messaggio col cartello di guasto: è così
    // che un pannello `ask_user_question` ancora a schermo è sparito,
    // sostituito da «No response received» (topic:ed2070df, 4 agosto).
    // La riga sa la verità: se ha dei tool O dei blocchi, il turno ha
    // prodotto qualcosa.
    //
    // `blocks` è stato aggiunto il 7 agosto, su una prova dal vivo:
    // topic:d04325fa portava DUE righe col cartello «Nessuna risposta:
    // il turno si è chiuso senza produrre niente» sopra 20 KB e 46 KB di
    // blocchi. Guardare i soli `tool_calls` non bastava — un turno di
    // solo testo e ragionamento non ha tool — e per giunta la rifusione
    // dello snapshot di riadozione, che è ciò che rimette quei blocchi,
    // gira DOPO questa decisione: qui `fullContent` è ancora vuoto e
    // `trackedToolCallIds` ancora vuoto, quindi il cartello si scriveva
    // su un turno intero. Finché viveva sepolto in `content` non si
    // vedeva; ora che il verdetto si legge, si leggerebbe una falsità.
    // La domanda è la STESSA che si fa la guardia dei cartelli d'errore,
    // e si pone con la stessa funzione: `content` qui è già misurato a
    // parte (`!fullContent.trim()`), quindi si passa vuoto e contano
    // solo tool e blocchi.
    // Valutata come FUNZIONE, non come valore: va chiamata dopo la
    // rifusione dello snapshot, quando `blocks` e la riga dicono la
    // verità. `content` è misurato a parte (`!fullContent.trim()`),
    // quindi qui si passa vuoto e contano solo tool e blocchi.
    const rowHasWorkAfterMerge = () => trackedToolCallIds.length > 0
      || blocks.length > 0
      || rowCarriesWork({ ...(readRowForNotice(partialMsg.id) ?? { toolCallsJson: null, blocksJson: null }), content: "" });
    // Il turno che ha PROPOSTO e non ha potuto consegnare.
    //
    // In plan mode la CLI 2.1.223 non espone più `ExitPlanMode`, quindi
    // il modello scrive il piano in `~/.claude/plans/` e resta fermo:
    // non può agire e non può chiedere l'approvazione. Se la CLI non ha
    // più il tool per chiederla, la chiede l'applicazione — con lo
    // STESSO pannello di `AskUserQuestion`, che è già il modo in cui
    // questa chat dice «tocca a te». Senza, il turno si chiudeva col
    // cartello «non ha prodotto niente» sopra una colonna di azioni
    // riuscite e un piano che nessuno vedeva.
    const pendingPlan = findPlanAwaitingApproval(blocks);
    const askingPlanApproval = shouldAskPlanApproval({
      reason,
      permissionMode: permissionModeForAutonomy(matchedTopic?.autonomyLevel),
      plan: pendingPlan,
    });
    if (askingPlanApproval && pendingPlan) {
      const schema = planApprovalSchema();
      updateToolCallFields(sessionKey, pendingPlan.toolCallId, {
        status: "waiting_for_input",
        userInputSchema: schema,
      }, ownRow);
      updateBlockTool(pendingPlan.toolCallId, { status: "waiting_for_input", userInputSchema: schema });
      broadcastToAll({
        type: "stream:tool_user_input_required",
        sessionKey,
        topicId: matchedTopic?.id,
        toolCallId: pendingPlan.toolCallId,
        schema,
      });
      // A plan to approve is a wait on the person, `needs-you(plan)`,
      // never "Claude ha finito di rispondere" (defect D8).
      planApprovalOpened(sessionKey, pendingPlan.toolCallId, pendingPlan.text);
    }

    // Finalize any tool calls that the provider started but never
    // emitted a result for. Three failure modes share this loop:
    //   - "done":     fire-and-forget tools (ExitPlanMode, tools that
    //                 don't return a result). Mark as success but with
    //                 NO result string — the previous code passed
    //                 'success' as the result, which persisted the
    //                 literal "success" into the row's body.
    //   - "error":    a stream-level error. Tool was probably mid-run
    //                 when things broke — mark as error.
    //   - "aborted":  user clicked stop. Tools did not complete; mark
    //                 as error with reason so the UI doesn't show a
    //                 misleading green ✓.
    // A CUT TURN LEAVES NO SUCCESSFUL TOOLS BEHIND.
    //
    // `reason === 'done'` alone said "success" even when the round had
    // ended because the model blew through the output cap halfway into
    // the call: the tool had NEVER run, and it stayed on screen with a
    // green tick and an empty result. Measured on 2026-08-28 on
    // topic:4c935add, three times out of three: `Tool start: write_file`
    // in the log, ZERO `Tool result`, and no file on disk. A green tick on
    // a write that never happened is worse than an error, because whoever
    // reads it stops looking.
    const outcome = toolOutcomeAtTurnEnd(reason, turnEnd, errorMsg);
    const finalizeStatus: 'success' | 'error' = outcome.status;
    const finalizeError = outcome.error;
    const finalizeEndedAt = Date.now();
    for (const tcId of trackedToolCallIds) {
      // The plan just put to the person (above) is not a fire-and-forget
      // tool: marked `success` here, its panel vanished a moment after
      // it appeared, the plan read as approved, and the queue behind it
      // had nothing left to wait for (an `ExitPlanMode` with no result).
      if (askingPlanApproval && pendingPlan?.toolCallId === tcId) continue;
      if (finalizeStatus === 'error') {
        // updateToolCallResult sets status='error' when error is provided.
        updateToolCallResult(sessionKey, tcId, '', finalizeError, { endedAt: finalizeEndedAt }, ownMirrored);
        updateBlockTool(tcId, { status: 'error', error: finalizeError, endedAt: finalizeEndedAt });
        broadcastTurnFrame({ type: "stream:tool_result", sessionKey, topicId: matchedTopic?.id, toolCallId: tcId, status: 'error', result: '', error: finalizeError, endedAt: finalizeEndedAt }, matchedTopic?.id);
        writeToolResultSSE({ id: tcId, status: 'error', error: finalizeError, endedAt: finalizeEndedAt });
      } else {
        // Fire-and-forget success. Empty result so the UI shows just
        // the green ✓ without a literal "success" body.
        updateToolCallResult(sessionKey, tcId, '', undefined, { endedAt: finalizeEndedAt }, ownMirrored);
        updateBlockTool(tcId, { status: 'success', endedAt: finalizeEndedAt });
        broadcastTurnFrame({ type: "stream:tool_result", sessionKey, topicId: matchedTopic?.id, toolCallId: tcId, status: 'success', endedAt: finalizeEndedAt }, matchedTopic?.id);
        writeToolResultSSE({ id: tcId, status: 'success', endedAt: finalizeEndedAt });
      }
    }

    // Una domanda ancora aperta a fine turno (tipico dello «ferma»
    // premuto col pannello a schermo) è attesa fino all'ultimo istante.
    humanWait.closeAll(Date.now());
    // La durata che resterà scritta sotto il messaggio è il LAVORO, non
    // il tempo che ci ha messo una persona a rispondere: un turno da otto
    // secondi non deve essere archiviato come «43m» perché la domanda è
    // arrivata durante il pranzo. Vedi lib/human-wait.ts.
    // Riadozione: quello che il replay NON ha ri-emesso torna dov'era.
    // Senza questo, un replay muto (coda chiusa nello store del broker)
    // lasciava la riga col solo testo finale e senza i tool — compreso
    // un `ask_user_question` ancora a schermo, che spariva a ogni
    // ricarica del server.
    if (isReattach && reattachSnapshot) {
      const merged = mergeReattachedRow(reattachSnapshot, {
        content: turn.fullContent,
        thinking: turn.fullThinking || undefined,
        trackedTools: trackedToolCallIds.length,
        blocks,
      });
      turn.fullContent = merged.content;
      if (merged.thinking !== undefined) turn.fullThinking = merged.thinking;
      if (merged.blocks && merged.blocks !== blocks) {
        blocks.length = 0;
        blocks.push(...(merged.blocks as ContentBlock[]));
      }
      if (merged.toolCallsJson !== undefined) {
        try { db.run("UPDATE messages SET tool_calls = ? WHERE id = ?", [merged.toolCallsJson, partialMsg.id]); }
        catch (err) { console.warn(`[chat-reattach] tool non ripristinati su ${sessionKey}:`, err); }
      }
      if (merged.nothingNew) {
        console.log(`[chat-reattach] ${sessionKey}: il riattacco non ha aggiunto niente — la riga resta com'era`);
      }
    }

    // Il cartello nel TESTO si decide qui, non prima: su una riadozione
    // `fullContent` diventa vero solo dopo la rifusione appena sopra, e
    // deciderlo a monte significava scriverlo su un turno che c'era.
    // Serve solo alla riga altrimenti vuota — `content` è l'unica colonna
    // che la ricerca ⌘K interroga, e i client vecchi (senza il blocco
    // `error`) leggono ancora da lì. Chi ha del testo se lo tiene: il
    // verdetto lo porta già il blocco.
    if (reason === "error" && errorMsg && !turn.fullContent.trim()) {
      turn.fullContent = `⚠️ ${errorMsg}`;
    }

    // «Nessuna risposta» si decide QUI, dopo la rifusione, per la stessa
    // ragione del cartello d'errore qui sopra — e per una ragione in
    // più, imparata dal vivo il 7 agosto.
    //
    // Su una riadozione la riga è già stata SVUOTATA per essere riusata
    // (`reuseOrCreatePartialForReattach`), e ciò che la riempiva torna
    // solo con il merge. Deciderlo prima significa guardare una riga che
    // qualcuno ha appena azzerato e concludere che il turno non ha
    // prodotto niente: è successo su un turno con 54 tool e 14 blocchi
    // di testo, riadottato dopo un hot-reload del server. Il fix
    // precedente guardava le colonne giuste ma nel momento sbagliato.
    // UNA COMPATTAZIONE NON È UNA RISPOSTA MANCATA.
    //
    // `/compact` chiude con `result: ""` per costruzione: la CLI non
    // produce testo, perché l'esito della compattazione è il divider
    // «Contesto compattato» che è già stato disegnato dal suo
    // `compact_boundary`. Senza questa esclusione, il turno che ora si
    // chiude correttamente (vedi il commento sul `result` vuoto in
    // `providers/claude-code.ts`) si prenderebbe subito il cartello
    // «Nessuna risposta: il turno si è chiuso senza produrre niente» —
    // cioè scambieremmo un successo per un guasto, che è esattamente il
    // modo in cui il vecchio bug si sarebbe ripresentato con un'altra
    // faccia.
    const onlyCompaction = turn.compactedThisTurn || turn.answeredAsCommand;
    // A TURN CUT BY THE OUTPUT CAP ENDS ON THE `done` LEG.
    //
    // The native loop exits a `max_tokens` round through `onDone`, not
    // `onError` (agent-loop.ts: only `end === "error"` goes to the error
    // handler), and the only place that wrote the cut-turn notice
    // was the `aborted` branch below. So the notice shipped on
    // 08-28 for topic:4c935add was unreachable: the tool half of that
    // fix worked (`toolOutcomeAtTurnEnd`), the prose stopped
    // mid-sentence with no explanation, three times out of three.
    //
    // Decided BEFORE the empty-turn check on purpose: a turn
    // that spent the whole cap on thinking produces no text, and
    // a retry would be the wrong advice for it (the same message
    // blows through the same cap). Only the `done` leg: `error` already
    // writes its own error block, and its `max_tokens` classification
    // also covers input-side context overflow, where advice about a
    // single turn's length is wrong.
    //
    // A REFUSAL TAKES THE SAME LEG, for the same reason: the API
    // answers 200 with no content at all, so without this it fell into
    // the empty-turn notice below and the verdict — which the API does
    // explain — was never shown. See `native/agent-loop.ts:roundEnd`.
    // And a CLI that gave up on the API (`api-unavailable`): its row kept
    // "Request timed out" and no verdict, and no sweep resent it (25/09).
    // «Riprendo da solo» only where the sweep will resend: read off the
    // blocks after the reattach merge, which carry a wake's mark, and
    // for an outage off the row's place in the thread (`directAnswer`).
    const resumesOnItsOwn = resumesByItself(endInfo.cause, blocks, directAnswer);
    const cutNotice = reason === "done" && (endInfo.end === "max_tokens" || endInfo.end === "refusal" || endInfo.end === "error")
      ? avvisoPerTurno(endInfo, { haProdotto: turn.fullContent.trim().length > 0 || rowHasWorkAfterMerge(), riprendeDaSolo: resumesOnItsOwn })
      : null;
    if (reason === "done" && !cutNotice && !turn.fullContent.trim() && !rowHasWorkAfterMerge() && !askingPlanApproval && !onlyCompaction && !(isReattach && !reusedRow)) {
      const emptyErrorMsg = "⚠️ Nessuna risposta: il turno si è chiuso senza produrre niente. Il tuo messaggio è ancora qui: «Riprova» lo rimanda.";
      turn.fullContent = emptyErrorMsg;
      blocks.push({ kind: "error", text: "Nessuna risposta: il turno si è chiuso senza produrre niente." });
      turnError = emptyErrorMsg;
      console.warn(`[StreamWS] Empty response for ${sessionKey}`);
      if (matchedTopic) {
        broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: emptyErrorMsg });
      }
    }
    if (cutNotice) {
      // Same shape as the cancelled notice below: the verdict goes in
      // the BLOCKS, and in the text only when there is no text.
      //
      // THE CAUSE TRAVELS WITH THE NOTICE, otherwise it stays hidden.
      //
      // The banner above the composer renders only blocks carrying a
      // `cause`. Without it, the verdict remains buried after the
      // tool-call stack even though the explanation exists.
      //
      // `max_tokens` has no cause because it is a length limit, not an
      // attributed termination. Its notice already explains recovery.
      // An `error` end carries its own: it is what the resume reads.
      const cutCause = endInfo.end === "refusal" ? ("refusal" as const) : endInfo.end === "error" ? endInfo.cause : undefined;
      blocks.push({
        kind: "error",
        text: cutNotice.replace(/^⚠️\s*/, ""),
        ...(cutCause ? { cause: cutCause, at: new Date().toISOString() } : {}),
      });
      if (!turn.fullContent.trim()) turn.fullContent = cutNotice;
      // AND THE END MUST SAY IT WENT WRONG, or `stream:end` carries no
      // `reason: "error"` and the push gate mutes the cut turn.
      turnError = cutNotice;
      console.warn(
        `[StreamWS] ${sessionKey}: ${endInfo.end === "refusal" ? "turn refused by the API" : endInfo.end === "error" ? `turn ended by ${endInfo.cause}` : "turn cut by the output cap"}`,
      );
      if (matchedTopic) {
        broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: cutNotice });
      }
    }
    // UN TURNO ANNULLATO NON DALL'UTENTE DEVE DIRLO.
    //
    // `aborted` è sempre stato muto, e per l'unico caso che esisteva
    // quando fu scritto — l'umano preme Ferma — è giusto: sa già cos'ha
    // premuto, e la riga vuota che lascia viene buttata poco sotto.
    //
    // Ma ad annullare non è solo l'umano. Il 20/08 su topic:9f9e9629 è
    // stato lo SPEGNIMENTO del server (salvataggio in `server/` →
    // fswatch → SIGTERM), e il silenzio pensato per lo stop a mano è
    // finito sopra un turno che nessuno aveva fermato: risposta
    // troncata a metà e nessuna spiegazione. Regola in
    // `lib/cancelled-notice.ts`, provata a parte.
    //
    // Il cartello va nei BLOCCHI — ciò che il client disegna — e nel
    // TESTO solo se il testo è vuoto: chi ha già scritto della prosa se
    // la tiene, il verdetto lo porta il blocco.
    if (reason === "aborted") {
      // «Ha prodotto» decide la coda del cartello, perché decide se il
      // bottone «Riprova» esiste (`turnIsOnlyError`): prometterlo a chi
      // non ce l'ha era la bugia segnalata il 20/08.
      const hasProduced = turn.fullContent.trim().length > 0 || blocks.some((b) => b.kind === "tool");
      // «RIPRENDO DA SOLO» SI PROMETTE SOLO DOVE E' VERO, e la causa
      // riprendibile e' UNA delle tre.
      //
      // `riprendiTurniInterrotti` e' una funzione di BOOT (server.ts, in
      // coda al giro di riadozione). Su `server-shutdown` un boot segue
      // per definizione — il processo sta morendo mentre scriviamo il
      // cartello — quindi la promessa si mantiene da se'. Su `watchdog`
      // e `wall-clock` il server RESTA SU: quella funzione non gira, e
      // nessuno riprende niente.
      //
      // Prometterlo li' sarebbe il verso peggiore dell'errore: oggi
      // l'utente vede «Riprova» e spende un turno di troppo (spreco
      // VISIBILE), con la promessa vedrebbe «non serve che tu faccia
      // niente» e il turno resterebbe perso in SILENZIO. Vale la regola
      // che `isResumableCause` gia' dichiara: nel dubbio si
      // lascia il cartello, che e' reversibile.
      //
      // Senza questa riga il campo non veniva passato da nessuno: la
      // coda «Riprendo da solo» esisteva nel codice e non e' mai
      // comparsa a schermo, nemmeno sui turni che il boot riprendeva
      // davvero.
      // Every cause the resume acts on, not only the restart: the
      // sweep (`riprendiTurniInterrotti`, every 5 min) reads the same
      // predicate off the block, so a notice saying "Riprendo da solo"
      // is a promise the same code keeps (`resumesOnItsOwn`, above).
      // A stop the machine wanted explains nothing and resumes nothing,
      // as a route stop did before (lib/abort-cause.ts).
      const turnNotice = wantedByMachine ? null : avvisoPerTurno(endInfo, { haProdotto: hasProduced, riprendeDaSolo: resumesOnItsOwn });
      if (turnNotice) {
        // An `error` end here is an outage outside the turn: its cause
        // goes on the block, for the resume and the banner.
        const cause = endInfo.end === "error" ? endInfo.cause : undefined;
        blocks.push({ kind: "error", text: turnNotice.replace(/^⚠️\s*/, ""), ...(cause ? { cause, at: new Date().toISOString() } : {}) });
        turnError = turnNotice;
        if (!turn.fullContent.trim()) turn.fullContent = turnNotice;
        if (matchedTopic) {
          broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: turnNotice });
        }
      }
    }

    const latencyMs = Math.max(0, Date.now() - turn.turnStartMs - humanWait.totalMs());
    const finalizedMsg = updateLastMessage(sessionKey, {
      content: turn.fullContent,
      thinking: turn.fullThinking || undefined,
      blocks: blocks.length > 0 ? blocks : undefined,
      partial: undefined, streamedAt: undefined,
      // From the END, not from the leg that carried it: an outage
      // (the CLI giving up on the API, the watchdog on an API retry,
      // a dead ai-bridge daemon) closes through `done` or `aborted`,
      // and the column read 'done' or 'stopped' for a turn that failed.
      endReason: endInfo.end === "error" ? "error" : reason === "aborted" ? "stopped" : reason,
      latencyMs,
      usagePromptTokens: turn.usagePromptTokens,
      usageCompletionTokens: turn.usageCompletionTokens,
      costCents: turn.costCents,
      model: turn.usageModel,
      cacheReadTokens: turn.cacheReadTokens,
      cacheCreationTokens: turn.cacheCreationTokens,
      cacheCreation1hTokens: turn.cacheCreation1hTokens,
    }, ownRow);
    // THE ROW IS NOW WHOLE: nothing may still owe it a write.
    // `clearAllTimers` runs at the TOP of this function, and everything
    // between there and here keeps touching the timeline (every tool
    // still tracked is closed through `updateBlockTool`), so the
    // throttle schedules a fresh deferred write DURING the finalize --
    // one that fires a second later and rewrites what the line above
    // has just written whole. Harmless while the server is up, not
    // harmless when the turn is the last thing that happens: measured
    // on 2026-09-07 (card 9ef72908) as a write landing on an already
    // closed database, in a test file that had ended.
    turnBody.dispose();
    releaseTurnBodyFlush();
    // "Un turno che non ha prodotto niente non lascia niente": stop
    // premuto prima che il modello dicesse qualsiasi cosa. Il segnaposto
    // creato all'inizio dello stream restava in chat finalizzato vuoto —
    // e rientrava nella history rimandata al modello a ogni turno dopo.
    // Solo su `aborted`: `done` ed `error` scrivono comunque il loro ⚠️,
    // quindi vuoti non sono mai. Vedi shared/empty-turn.ts.
    // …e la riga vuota che quel turno lascia non deve restare in chat.
    // `/compact` non ha prodotto nulla di mostrabile — il divider vive
    // in una tabella sua — quindi il segnaposto dell'assistente è una
    // bolla vuota, che oltre a sporcare il trascritto rientrerebbe nella
    // history rimandata al modello a ogni turno successivo. Stessa
    // regola dello stop-prima-di-qualsiasi-cosa, stesso predicato
    // (`shared/empty-turn.ts`): se non c'è NIENTE dentro, non resta.
    //
    // E il RISVEGLIO A MANI VUOTE: un Monitor che si chiude sveglia un
    // turno per dirlo, e quello spesso tace (sentinella della CLI, vedi
    // shared/empty-turn.ts). Solo per `woken`: un turno CHIESTO che
    // finisce vuoto è un guasto, e il suo ⚠️ resta. The same for a
    // reattach that opened its own row: nobody asked it, and the «no
    // answer» with Retry went under a reply already there (a57e6d4d).
    const discardedMessageId = (reason === "aborted" || (reason === "done" && (turn.compactedThisTurn || turn.answeredAsCommand || isWoken || (isReattach && !reusedRow))))
      ? discardIfEmptyTurn(sessionKey, finalizedMsg)
      : null;
    if (discardedMessageId) console.log(`[StreamWS] ${sessionKey}: turno vuoto scartato (${discardedMessageId})`);
    // This CANCELS every tool still awaiting a human (the turn is over,
    // a click would reach nobody) and announces the list, which is what
    // switches those panels off on a screen that is already open: see
    // `endStreamAndAnnounce`. The plan approval is the one ask exempted:
    // this same function installed it a few hundred lines above, its
    // answer opens a NEW turn, and no provider will ever send a result
    // for that id. Without the exemption the panel was `error` in the
    // database before anyone saw it, and after a reload even the bar
    // above the composer was gone (`findPendingAsk` looks for
    // `waiting_for_input`).
    const interrupted = endStreamAndAnnounce(
      askingPlanApproval && pendingPlan ? { keepAwaiting: [pendingPlan.toolCallId] } : undefined,
    );
    turn.topicProvider.unregisterStreamHandler?.(sessionKey, turn.handler);

    // Detect sub-agent launches
    if (!globalOrchestrator && matchedTopic && /sub.?agent|subagent|lanciato|spawned|sessions_spawn/i.test(turn.fullContent)) {
      watchSessionForSubagents(matchedTopic.id, sessionKey);
    }

    if (matchedTopic) {
      // Niente `message:new` per un turno scartato: annuncerebbe agli
      // altri client un messaggio assistente vuoto — cioè ricreerebbe in
      // pagina la bolla che il DB non ha più.
      // Same for a row that is gone: `/clear` in the middle of this turn
      // deleted it, and the turn it killed ends here afterwards.
      if (!discardedMessageId && finalizedMsg) {
        broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: partialMsg.id, content: turn.fullContent, preview: turn.fullContent.slice(0, 100) });
      }
      // What the chat waits on as this turn ends, read BEFORE the frame
      // (design section 5.2): a turn that leaves work running is not a
      // finished turn, and the frame says so.
      const attentionWork = backgroundForAttention(turn.topicProvider, sessionKey, body.processExit?.processId);
      const endFrame = {
        type: "stream:end" as const,
        sessionKey,
        topicId: matchedTopic?.id,
        messageId: partialMsg.id,
        ...(discardedMessageId ? { discardedMessageId } : {}),
        latencyMs,
        usagePromptTokens: turn.usagePromptTokens,
        usageCompletionTokens: turn.usageCompletionTokens,
        costCents: turn.costCents,
        ...(turn.usageModel ? { model: turn.usageModel } : {}),
        // Lo scorporo della cache va anche sul filo, non solo nella riga
        // salvata: la UI mostra il piede del messaggio appena il turno
        // finisce, senza rileggere la history.
        cacheReadTokens: turn.cacheReadTokens,
        cacheCreationTokens: turn.cacheCreationTokens,
        cacheCreation1hTokens: turn.cacheCreation1hTokens,
        // Vocabolario ACP sul filo. `error` NON è una ragione ACP: resta
        // fuori da `stopReason` e viaggia come `reason` dello stream.
        ...(isAcpStopReason(endInfo.end) ? { stopReason: endInfo.end } : {}),
        // Not for a stop the machine wanted: the row carries no notice
        // for it, and the client draws its live banner (and caches it)
        // from this cause. The abort route's own end omits it too.
        ...(endInfo.cause && !wantedByMachine ? { stopCause: endInfo.cause } : {}),
        // Marcatore POSITIVo di fine pulita, letto SOLO dalla push di
        // fine risposta (push-triggers): `end_turn` = il modello ha
        // chiuso da solo. Su max_tokens/refusal/cancelled/error resta
        // assente, così un turno morto non annuncia "risposta pronta"; e
        // nemmeno un turno VUOTO (segnaposto scartato = nessuna risposta).
        // `dispatched` esclude i turni d'agente guidati dalla board.
        completed: endInfo.end === "end_turn" && !discardedMessageId,
        ...(dispatched ? { dispatched: true } : {}),
        // The death and its notice. See `turnError`.
        ...(turnError ? { reason: "error", error: turnError } : {}),
        // The work the turn left running, counted as the attention state
        // counts it (`attentionBackground`, not the goal loop's reading).
        ...(attentionWork ? { background: { count: attentionWork.count, kinds: attentionWork.kinds } } : {}),
      };
      broadcastToAll(endFrame);
      endTurnAttention(matchedTopic, { ...endFrame, dispatched: boardAgentTurn }, { ...(attentionWork ? { background: attentionWork.tasks } : {}), preview: turn.fullContent });
      finalizeTurnActivity(matchedTopic, { visible: !discardedMessageId && !!finalizedMsg });

      // THE TURN IS OVER, THE OBJECTIVE MAY NOT BE.
      //
      // A goal that is still `active` here gets one verdict from a
      // cheap judge and, if the work is unfinished, one continuation
      // sent back through this same route (`services/goal-loop.ts` for
      // the rule and its brakes). Before this, a chat with an open goal
      // simply stopped, and the objective sat on the bar with nobody
      // pursuing it.
      //
      // Deferred and never awaited: this runs inside the finalization
      // of the stream that just ended, and the continuation is a WHOLE
      // new turn. Awaiting it here would hold the SSE response open for
      // as long as the loop lasts. `setTimeout(0)` also puts it after
      // `endStream` has settled, so the resend does not meet its own
      // turn on the 409 gate.
      const goalTurn: GoalTurnEnd = {
        sessionKey,
        topicId: matchedTopic.id,
        dispatched,
        end: endInfo.end,
        // The cause tells OUR tool budget (`tool-budget`) from a fault:
        // the loop continues the former and leaves the latter alone.
        cause: endInfo.cause,
        discarded: !!discardedMessageId,
        // A turn parked on a question is not a turn that decided to
        // stop: `interrupted` carries the tools still awaiting a human,
        // and the plan approval is kept out of it on purpose above.
        // A question this turn (or an earlier one) left open outlives
        // the turn and is not in `interrupted`: the rows say it.
        pendingAsk: askingPlanApproval || interrupted.length > 0 || sessionHasOpenQuestion(ctx, sessionKey, decodeCol),
        ...backgroundOfTurn(turn.topicProvider, sessionKey, commandWakeState(sessionKey, body.processExit?.processId), subagentWakeState(sessionKey)), // a wake's turn skips its own: see commandWakeState
        fromHuman: sentByPerson,
        woken: isWoken || !!body.processExit || !!body.subagentResults, // a command's or a sub-agent's wake is news, like the CLI's own
        usedTools: turn.toolsStartedThisTurn > 0,
        lastAssistantText: turn.fullContent,
      };
      setTimeout(() => {
        goalLoop.onTurnEnd(goalTurn).catch((err) => console.warn("[goal] end-of-turn hook failed:", err));
        // THE USER'S TURN-END HOOK, in the same deferred slot and for
        // the same reason: the SSE is already closed, and nothing here
        // waits. It cannot block (HOOKS-02): a non-zero exit only
        // writes its stderr into the chat as an assistant line, the
        // way the system-message verb does, so it is read where the
        // turn was read. Native runtime alone; the CLI providers carry
        // their own hook systems.
        if (hooks && turn.topicProvider?.name === "topics") {
          hooks.run("turn-end", {
            hook_event_name: "turn-end",
            session_id: sessionKey,
            cwd: matchedTopic.projectPath ?? WORKSPACE_DIR,
          }).then((verdict) => {
            if (verdict.ok) return;
            const stored = appendLocalMessage(sessionKey, "assistant", verdict.reason);
            broadcastToAll({ type: "message", sessionKey, message: { id: stored.id, role: "assistant", content: verdict.reason, timestamp: stored.timestamp } });
            broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: stored.id, content: verdict.reason, preview: verdict.reason.slice(0, 100) });
            updateUnreadCount(matchedTopic.id);
          }).catch((err) => console.warn("[lifecycle-hooks] turn-end hook failed:", err));
        }
      }, 0);
    }

    // Activity log (Fix E): one row per stream lifecycle event so
    // future timeouts/aborts/errors leave a queryable trail. The
    // helper swallows DB errors so a logging failure can never
    // break the stream finalization path.
    const logCtx = {
      sessionKey,
      topicId: matchedTopic?.id,
      durationMs: latencyMs,
      toolCallCount: trackedToolCallIds.length,
      promptTokens: turn.usagePromptTokens,
      completionTokens: turn.usageCompletionTokens,
      costCents: turn.costCents,
    };
    if (reason === "done") logStreamComplete(logCtx);
    // Il titolo dice CHI ha annullato, non «l'utente» sempre. Un
    // registro che attribuisce a una persona ciò che ha fatto una
    // macchina manda a cercare dalla parte sbagliata: il 20/08 la riga
    // «stream aborted by user» era l'unica traccia di uno spegnimento
    // del server, e diceva il contrario di quello che era successo.
    // Only the title: the durable record of a machine stop, with its
    // cause and row, is written by `/api/chat/abort` (`logMachineStop`).
    else if (reason === "aborted") logStreamAborted({ ...logCtx, title: abortLogTitle(endInfo) });
    else if (reason === "error") logStreamError({ ...logCtx, errorMessage: errorMsg });

    // (Topic switching is now a tool — `switch_topic`/`new_topic` —
    // which switches the UI mid-turn; the old marker path's message
    // migration to the target topic was removed with the markers.)

    // I media prodotti da QUESTO turno.
    //
    // `findNewMediaFiles` sa solo QUANDO un file è cambiato, e la
    // cartella è condivisa per contratto (il dispatcher dice a ogni
    // agente di depositare lì). Da sola, quella lista è «tutto ciò che
    // chiunque ha scritto mentre lavoravo» — e più il turno è lungo,
    // più larga è la rete. Il 7 agosto un turno da 11 minuti si è
    // portato in fondo due screenshot di una spec E2E che girava in
    // un'altra sessione. Qui passa dal cancello dell'attribuzione: è
    // suo solo ciò che ha nominato in una sua chiamata.
    const toolsOfTurn: TurnToolTrace[] = blocks
      .filter((b): b is Extract<ContentBlock, { kind: "tool" }> => b.kind === "tool")
      .map((b) => ({ name: b.toolCall.name, args: b.toolCall.args, result: b.toolCall.result }));
    setTimeout(() => void attachMediaOfTurn({
      sessionKey,
      topicId: matchedTopic?.id,
      requestStartMs,
      toolsOfTurn,
      ownRow,
      findNewMediaFiles,
      updateLastMessageWithMedia,
      broadcast: broadcastToAll,
    }), 1000);

    if (matchedTopic && !matchedTopic.projectPath && !globalOrchestrator) {
      setTimeout(() => {
        try {
          autoBindProject(matchedTopic!);
        } catch (err) {
          console.error("[AutoBind] failed:", err);
        }
      }, 500);
    }

    // Close SSE response. An end_turn that left an error verdict (an empty reply) failed all the same.
    await writeTurnEnd(turnError && endInfo.end === "end_turn" ? { end: "error" } : endInfo);
    await writeSSE("[DONE]");
    await closeClient();

    // THE END-OF-TURN MARK, the other half of the automatic checkpoint.
    //
    // A restore touches only the paths THIS turn changed, and it learns
    // them from `git diff <before> <after>` (see
    // services/checkpoint-restore-plan.ts). Without the `after` the
    // session's newest snapshot IS the `before`, the manifest is empty,
    // and a rewind cannot tell the turn's own writes from everybody
    // else's: it would restore nothing and say nothing. So every turn
    // that took a `before` closes with an `after`, on `done`, `error`
    // AND `aborted` alike: a turn that died halfway still wrote files.
    //
    // Once per turn: `finalizeStream` already returns early when the
    // stream is finalized, and the mark is consumed here so a second
    // pass has nothing to snapshot. After the SSE is closed and NOT
    // awaited, so a slow git never delays the teardown; its failure is
    // logged and touches nothing of the stream's outcome.
    if (turn.turnCheckpointMark && resolveTurnCheckpointsEnabled()) {
      const mark = turn.turnCheckpointMark;
      turn.turnCheckpointMark = null;
      captureTurnCheckpoint(mark.projectPath, sessionKey, mark.label, "after").catch((err: unknown) => {
        console.warn(`[Chat] end-of-turn checkpoint failed for ${sessionKey}:`, err);
      });
    }
  };
  turn.finalizeStream = finalizeStream;
}
