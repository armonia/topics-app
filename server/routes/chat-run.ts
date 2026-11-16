import { adaptEnvelope, type ContextEnvelope, getInlineSentState, getProviderStrategy, inlineScope, markInlineSent, pushSnapshot, rekeyInlineSent } from "../context";
import { nativeWorkingDir, recallMemoryContext } from "../lib/native-parity";
import { isKnownSlashCommand } from "../lib/slash-command-source";
import type { ChatMessage, StreamHandler } from "../providers";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { isPassthroughProvider } from "../browser-tools-adapters";
import { browserTools } from "../browser-tools";
import { controlTools } from "../control-tools";
import type { ChatTurnScope } from "./chat-turn-scope";

/** Sends the turn to the provider and drives it until it ends or throws. */
export async function runProviderTurn(turn: ChatTurnScope): Promise<Response | undefined> {
  const { browserService, carried, closeClient, closeTurnWithFailure, countCompactions, ctx, discardIfEmptyTurn, endStream, envelope, fastModeActive, globalOrchestrator, handler, isReattach, isWoken, matchedTopic, overrideModel, ownRow, partialMsg, readClaudeSessionId, readable, sessionKey, turnId, undoInlineMark, updateLastMessage, writeSSE, writeTurnEnd } = turn;
  // Send chat via WS
  try {
    // Re-shape the canonical envelope for the actual provider strategy.
    // The system blocks and history were already assembled in one
    // pass by `assembleTopicContext` above (with a placeholder
    // strategy); `adaptEnvelope` is a pure function so the second
    // call is essentially free.
    //
    // The dual-output here mirrors what the legacy supportsHistory
    // branch produced:
    //   - history-aware (claude, openai, codex):
    //       payload.history = [composed system msgs..., ...stripped DB history]
    //       payload.userContent = the new user turn verbatim
    //   - inline-system (claude-code):
    //       payload.userContent = "<context>...</context>\n\n${user}"
    //       payload.history = undefined (CLI session keeps its own state)
    let envForProvider: ContextEnvelope = {
      ...envelope,
      providerName: turn.topicProvider.name,
      providerStrategy: getProviderStrategy(turn.topicProvider),
    };
    // Claude Code's memory recall for THIS prompt, native runtime only:
    // `claude` and `codex` run the same `memrecall` as their own hook.
    // It goes AFTER the person's words, not in the preamble: a per-prompt
    // suggestion is not a document, and as a deduplicated slot a turn
    // with no hits would tell the model the memory is "no longer in effect".
    if (turn.topicProvider.name === "topics") {
      const recall = await recallMemoryContext(
        envelope.userMessage.content,
        nativeWorkingDir(envelope.sessionMeta?.workingDir),
      );
      if (recall) {
        envForProvider = {
          ...envForProvider,
          userMessage: {
            ...envelope.userMessage,
            content: `${envelope.userMessage.content}\n\n<memory-recall>\n${recall}\n</memory-recall>`,
          },
        };
      }
    }
    // Push the envelope to the in-memory snapshot ring BEFORE the
    // adapter so what the inspector shows is exactly what we hand
    // to the provider. Best-effort — never throws.
    try { pushSnapshot(envForProvider); } catch (e) { console.warn("[Context] pushSnapshot failed:", e); }

    // Deduplicazione del preambolo inline: la CLI process-resident ha
    // già in conversazione ciò che le abbiamo detto ai turni scorsi, e
    // riappenderlo costa in modo COMPOSTO (i token del turno k li
    // rilegge ogni chiamata successiva). Lo scope lega la memoria a UNA
    // conversazione CLI: sessione nuova o compattazione ⇒ mappa vuota ⇒
    // il contesto completo riparte da solo.
    const dedupOff = process.env.TOPICS_INLINE_CONTEXT_DEDUP === "0";
    turn.sentEpoch = dedupOff ? undefined : turn.topicProvider.contextEpoch?.(sessionKey);
    const sentScope = dedupOff ? null : inlineScope(
      readClaudeSessionId(ctx, sessionKey),
      countCompactions(ctx, sessionKey),
      turn.sentEpoch,
    );
    // A skill invocation (`/recap`) reaches the CLI bare, its context comes back apart
    // (`payload.slashContext`). Known skills: the CLI's own list (claude-code only), then the topic's cwd.
    const slashCwd = matchedTopic ? ctx.resolveTopicCwd(matchedTopic) : null;
    const cliSessionKey = turn.topicProvider.name === "claude-code" ? sessionKey : null;
    const isSlashCommand = (name: string) => isKnownSlashCommand(name, { cwd: slashCwd, cliSessionKey });
    const payload = adaptEnvelope(
      envForProvider,
      sentScope ? { alreadySent: getInlineSentState(sessionKey, sentScope), isSlashCommand } : { isSlashCommand },
    );
    // Marcatura OTTIMISTICA: `sendChat` risolve a turno avviato, e un
    // secondo messaggio accodato prima di allora si comporrebbe con la
    // mappa vecchia, riemettendo tutto. Il caso speculare — marcato ma mai
    // arrivato — lo chiude `undoInlineMark`, chiamato da `onError` (dove
    // finiscono TIMEOUT, RATE_LIMIT, PROCESS_DEAD: `sendChat` non rigetta
    // su nessuno di quelli) e dal `.catch` per i throw sincroni.
    turn.rollbackInlineSent = (sentScope && payload.inlineSlots)
      ? markInlineSent(sessionKey, sentScope, payload.inlineSlots)
      : null;
    const userContent = payload.userContent;
    const historyForProvider = payload.history;

    // Register handler BEFORE sendChat so tool events arriving during the await aren't lost.
    // Use undefined runId initially: the turn has no run id yet.
    turn.topicProvider.registerStreamHandler?.(sessionKey, undefined, handler);
    const sendOptions: { model?: string; history?: ChatMessage[]; tools?: Tool[]; resetFallbackContent?: string; slashContext?: string; resetFallbackSlashContext?: string; fastMode?: boolean; rowId?: string; messageRows?: number; turnId?: string } = { rowId: partialMsg.id, ...(turnId ? { turnId } : {}) };
    if (payload.slashContext !== undefined) sendOptions.slashContext = payload.slashContext;
    if (overrideModel) sendOptions.model = overrideModel;
    // The answers carried in front of the person's words are rows of
    // their own, and part of THIS message: a provider that rebuilds its
    // history from the rows leaves them out with it.
    if (carried.length > 0) sendOptions.messageRows = carried.length + 1;
    // La richiesta di fast mode viaggia COME richiesta: decide il
    // provider, che la gira alla CLI solo se la CLI ha detto di poterla
    // servire. Qui non si sceglie nessun modello al posto suo.
    if (fastModeActive) sendOptions.fastMode = true;
    // Se abbiamo deduplicato, diamo al provider anche la versione integra:
    // gli serve se la sessione CLI muore e deve rispedire su una appena
    // coniata, che il preambolo non l'ha mai visto. `adaptEnvelope` è pura,
    // quindi ricomporlo senza `alreadySent` costa quanto una join di stringhe.
    if (sentScope && payload.inlineSlots) {
      const full = adaptEnvelope(envForProvider, { isSlashCommand });
      if (full.userContent !== userContent) sendOptions.resetFallbackContent = full.userContent;
      if (full.slashContext !== payload.slashContext) sendOptions.resetFallbackSlashContext = full.slashContext;
    }
    if (historyForProvider) sendOptions.history = historyForProvider;
    // Phase 30 BROWSER-CHAT-04 — register browserTools for SDK-driven providers.
    // CLI providers (codex, claude-code) ignore this field
    // (their tool surfaces are managed upstream).
    //
    // Also register the control tools (open/create-project, switch/new-topic
    // — the tool-shaped successors to the {{PROJECT_*}}/{{TOPIC_*}} markers;
    // spec: replace-markers-with-tools). Unlike browserTools these don't need
    // browserService, so a passthrough provider always gets AI-initiated
    // control even in a build without the browser pane.
    if (isPassthroughProvider(turn.topicProvider.name) && !globalOrchestrator) {
      sendOptions.tools = [
        ...(browserService ? browserTools : []),
        ...controlTools,
      ];
    }
    // Fire-and-forget: kick off sendChat WITHOUT awaiting so the
    // Response can be returned immediately. The provider's stream
    // for-await loop drives handler callbacks → writeSSE → flushes
    // deltas live to the client. Awaiting here would buffer the
    // whole stream into the TransformStream and release it all at
    // once when the Response is finally returned.
    // Reattach mode (ai-bridge restart recovery): adopt the turn still
    // running in the broker and drive it to completion, instead of
    // starting a new one. No user message is sent; everything else
    // (handler, partial row, SSE, finalize) is reused.
    //
    // NIENTE RIPIEGO SU `sendChat`. Qui c'era un ternario che, se il
    // provider non sapeva riattaccarsi, mandava un turno normale — e su
    // un riattacco `userContent` è il solo preambolo `<context>` con
    // NESSUNA domanda (`messages: []` è il suo formato). Non era un
    // degrado, era un turno fabbricato: una chiamata pagata al modello
    // che rispondeva «Ciao! Come posso aiutarti con <nome del topic>?»
    // e finiva in chat al posto della risposta vera, su una sessione
    // che aveva già un turno in volo (il cancello 409 è disattivato per
    // i riattacchi, ed è giusto così). Il caso ora è respinto a monte,
    // prima della riga parziale e di qualunque stream: vedi la guardia
    // `reattach_unsupported` alla risoluzione del provider. `!` qui è
    // sostenuto da quella guardia, non da un'assunzione.
    const reattachFn = (turn.topicProvider as unknown as { reattach?: (sk: string, h: StreamHandler, o?: { rowId?: string }) => Promise<string> }).reattach;
    // Il risveglio si adotta in modo SINCRONO (gli eventi sono già nel
    // provider). `false` = l'ha preso qualcun altro, o il figlio è morto.
    const adoptWake = (turn.topicProvider as unknown as { adoptWokenTurn?: (sk: string, h: StreamHandler, rowId?: string) => boolean }).adoptWokenTurn;
    const drive = isWoken
      ? (adoptWake!.call(turn.topicProvider, sessionKey, handler, partialMsg.id)
          ? Promise.resolve({ runId: "woken" })
          : Promise.reject(new Error("WOKEN_TURN_GONE")))
      : isReattach
      ? reattachFn!.call(turn.topicProvider, sessionKey, handler, { rowId: partialMsg.id }).then((outcome) => ({ runId: outcome }))
      : turn.topicProvider.sendChat(
          sessionKey,
          userContent,
          handler,
          Object.keys(sendOptions).length > 0 ? sendOptions : undefined,
        );
    drive.then((result) => {
      // Stopped in the provider's queue before anything was written: the
      // inline context marked as sent above never reached the session,
      // so the next message must carry it again. Whoever stopped it has
      // closed this stream already.
      if ((result as { notSent?: boolean }).notSent) {
        undoInlineMark();
        console.log(`[StreamWS] ${sessionKey}: send stopped in the queue, nothing written`);
        return;
      }
      // SOLO SE IL TURNO È ANCORA VIVO. `sendChat` risolve quando il
      // turno è FINITO, non quando parte: qui si arrivava dopo `onDone`
      // e si reinstallava un handler morto, dopo di che ogni risveglio
      // trovava la sessione «occupata» — cinque sveglie, zero risposte.
      if (turn.streamState !== "finalized") {
        turn.topicProvider.registerStreamHandler?.(sessionKey, result.runId, handler);
      }
      // Il primo turno di una sessione CLI ha composto lo scope quando la
      // riga di `claude_code_sessions` non esisteva ancora — la crea lo
      // spawn, dentro questa stessa sendChat. Ora l'id c'è: sposta lo stato
      // sotto lo scope definitivo, invece di lasciarlo sotto `(none)#N` e
      // farlo buttare al turno successivo (un preambolo intero in più,
      // inchiodato nella conversazione e riletto per sempre).
      // Solo a pari conteggio di compattazioni: se ne è arrivata una, il
      // preambolo se l'è portato via e rimandarlo è l'esito corretto.
      if (sentScope && payload.inlineSlots) {
        try {
          const settled = inlineScope(
            readClaudeSessionId(ctx, sessionKey),
            countCompactions(ctx, sessionKey),
            turn.topicProvider.contextEpoch?.(sessionKey),
          );
          rekeyInlineSent(sessionKey, sentScope, settled);
        } catch { /* best-effort: al peggio si rimanda il contesto */ }
      }
      console.log(`[StreamWS] chat.send OK for ${sessionKey}, runId: ${result.runId}`);
    }).catch(async (err: any) => {
      // «IL RISVEGLIO NON È PIÙ MIO» NON È UN GUASTO.
      // `adoptWokenTurn` torna `false` quando qualcun altro ha preso la
      // sessione (tipicamente l'utente che scrive mentre il Monitor
      // consegna) o il figlio è morto. Nel primo caso la risposta arriva
      // sull'ALTRO turno: un «⚠️ Non sono riuscito ad avviare il turno»
      // sarebbe un allarme in mezzo a una chat che funziona, per un
      // turno che nessuno ha chiesto. Si chiude in silenzio — la riga
      // aperta è sempre vuota qui — e ogni ALTRO errore resta rumoroso.
      if (isWoken && err?.message === "WOKEN_TURN_GONE") {
        console.log(`[StreamWS] ${sessionKey}: il turno spontaneo era già stato preso da qualcun altro — chiudo senza scrivere niente`);
        undoInlineMark();
        turn.topicProvider.unregisterStreamHandler?.(sessionKey, handler);
        endStream(sessionKey, { rowId: partialMsg.id });
        turn.streamState = "finalized";
        // `discardIfEmptyTurn` vuole la RIGA, non un id, e verifica in
        // SQL che non ci siano blocchi o tool (una riga di soli tool non
        // è vuota). Qui non è arrivato un byte: la riga sparisce.
        try {
          const emptyRow = updateLastMessage(sessionKey, { partial: undefined, streamedAt: undefined }, ownRow);
          const discarded = discardIfEmptyTurn(sessionKey, emptyRow);
          if (discarded) console.log(`[StreamWS] ${sessionKey}: riga del risveglio non adottato scartata (${discarded})`);
        } catch (e) { console.warn(`[StreamWS] ${sessionKey}: riga del risveglio non ripulita:`, e); }
        await writeSSE("[DONE]");
        await closeClient();
        return;
      }
      console.error(`[StreamWS] chat.send failed for ${sessionKey}:`, err);
      // Il turno non è mai arrivato alla CLI: quel preambolo non è in
      // sessione, e il prossimo messaggio deve tornare a portarlo. Qui
      // restano i throw sincroni; la classe grossa passa da `onError`.
      undoInlineMark();
      turn.topicProvider.unregisterStreamHandler?.(sessionKey);
      // Il turno è chiuso: un `onDone` in ritardo non deve riaprirlo e
      // riscrivere la riga da `finalizeStream`. Mancava, ed era un buco
      // — non una decisione.
      turn.streamState = "finalized";
      const errorMsg = closeTurnWithFailure(err, partialMsg.id);
      await writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { content: errorMsg }, finish_reason: "stop" }] }));
      await writeTurnEnd({ end: "error" });
      await writeSSE("[DONE]");
      await closeClient();
    });
  } catch (err: any) {
    console.error(`[StreamWS] sync setup error for ${sessionKey}:`, err);
    turn.topicProvider.unregisterStreamHandler?.(sessionKey);
    // Come il gemello asincrono: il turno è chiuso, e i timer del
    // watchdog sono ancora armati.
    turn.streamState = "finalized";
    const errorMsg = closeTurnWithFailure(err, partialMsg.id);
    // Not awaited: no reader before the Response below, and a write with no reader waits for ever.
    writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { content: errorMsg }, finish_reason: "stop" }] }))
      .then(() => writeTurnEnd({ end: "error" })).then(() => writeSSE("[DONE]")).then(() => closeClient())
      .catch((e) => console.warn(`[StreamWS] error/close on sync setup error failed:`, e));
    return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
  }
}
