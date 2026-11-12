import { useCallback } from 'react';
import type { ChatMessage, CompactionMarker, ToolCall, WSFrameRow, WSMessage } from '../types';
// "Un turno che non ha prodotto niente non lascia niente" — la STESSA regola che
// applica il server prima di cancellare la riga. Due definizioni di "vuoto"
// vorrebbero dire bolla via da una parte e ancora lì dall'altra.
import { liveInterruptionBlock } from '../components/Chat/turnError';
import { COMMAND_ANSWER_EVENT } from '../lib/commandAnswer';
import {
getQueue as getTurnQueue,
removeTurn,
storedQueueSessions
} from '../state/chatQueue';
import {
// Importata con l'alias storico: e' una funzione di MODULO, quindi stabile per
// definizione — ed e' anche il motivo per cui non compare in nessuna lista di
// dipendenze, mentre il vecchio `setMessages` di `useState` ci compariva.
updateMessages as setMessages
} from '../state/messageStore';
import { noteServerTurn, noteStopHeard, noteTurnSnapshot } from '../state/serverTurn';
import {
finishStreamTokenRate
} from '../state/streamTokenRate';
import { cacheMessages } from './chatMessageCache';
import { cleanInvisibleMarkers, generateMessageId, setStreaming, setThinking } from './chatShared';
import { HeldToolFacts, patchToolCallOrHold, withPermissionAsked, withPermissionResolved, withQuestionAsked } from './heldToolFacts';
import { LiveTurnIds, carryLateStart, liveAssistantIndex, type LateDelta } from './liveTurn';
import { adoptDurableMessageId } from './ownBubble';
import { senderAlsoSeesFrame } from './senderAlsoSees';
import { mergeCatchupIntoPartial } from './streamCatchupMerge';
import { clearPartialForReattach, reviveClosedBubble } from './streamReattachReset';
import { TextPaintGate } from './textPaintGate';
import { toolUpdatePatch, withToolUpdate, type ToolUpdateEvent } from './toolUpdatePatch';
import { useRefMirror } from './useRefMirror';









export interface StreamEventsCtx {
  heldBehindEndRef: React.RefObject<Map<string, WSMessage[]>>;
  flushLiveDeltas: (sessionKey?: string) => void;
  flushToolUpdates: (sessionKey?: string) => void;
  localSSESessionsRef: React.RefObject<Set<string>>;
  ownReplyClosedRef: React.RefObject<Set<string>>;
  swallowedAfterReplyRef: React.RefObject<Set<string>>;
  endedDuringOwnSseRef: React.RefObject<Set<string>>;
  scheduleSSEFailsafe: (sessionKey: string) => void;
  textPaintGateRef: React.RefObject<TextPaintGate>;
  beginStreaming: (sessionKey: string) => void;
  resetStreamTimeout: (sessionKey: string) => void;
  streamMessageIdRef: React.RefObject<LiveTurnIds>;
  liveDeltaBufferRef: React.RefObject<Map<string, { content: string; thinking: string; }>>;
  reserveThinkingRow: (sessionKey: string) => void;
  bufferLiveDelta: (sessionKey: string, contentDelta?: string, thinkingDelta?: string, late?: LateDelta["frame"]) => void;
  pendingLateStartRef: React.RefObject<Set<string>>;
  relightSettledTurn: (sessionKey: string, messageId?: string) => void;
  upsertMarker: (sessionKey: string, marker: CompactionMarker) => void;
  addToolCallToLastMessage: (sessionKey: string, toolCall: ToolCall, frame?: WSFrameRow) => void;
  applyToolPatch: (sessionKey: string, toolCallId: string, patch: (tc: ToolCall) => ToolCall) => void;
  bufferToolUpdate: (sessionKey: string, toolCallId: string, partialResult: string) => void;
  heldToolFactsRef: React.RefObject<HeldToolFacts>;
  updateLastMessage: (sessionKey: string, updates: Partial<ChatMessage>) => void;
  clearStreamTimeout: (sessionKey: string) => void;
  turnEndsRef: React.RefObject<Map<string, number>>;
  dropEmptyTurn: (sessionKey: string, messageId?: string) => boolean;
  discardedRowsRef: React.RefObject<Map<string, Set<string>>>;
  settleTurn: (sessionKey: string) => void;
  wsHandlersRef: React.RefObject<Set<(event: WSMessage) => void>>;
  setGatewayConnected: (value: React.SetStateAction<boolean>) => void;
  drainTurnQueueRef: React.RefObject<((sk: string, attempt?: number) => void) | null>;
}

export function useStreamEvents(ctx: StreamEventsCtx) {
  const { heldBehindEndRef, flushLiveDeltas, flushToolUpdates, localSSESessionsRef, ownReplyClosedRef, swallowedAfterReplyRef, endedDuringOwnSseRef, scheduleSSEFailsafe, textPaintGateRef, beginStreaming, resetStreamTimeout, streamMessageIdRef, liveDeltaBufferRef, reserveThinkingRow, bufferLiveDelta, pendingLateStartRef, relightSettledTurn, upsertMarker, addToolCallToLastMessage, applyToolPatch, bufferToolUpdate, heldToolFactsRef, updateLastMessage, clearStreamTimeout, turnEndsRef, dropEmptyTurn, discardedRowsRef, settleTurn, wsHandlersRef, setGatewayConnected, drainTurnQueueRef } = ctx;


  const handleStreamEvent = useCallback((event: WSMessage) => {
    // Every stream:* and message:media variant carries a sessionKey, but the
    // dispatcher upstream accepts the full WSMessage union (which includes
    // events that don't). Narrow via `in` so the rest of this function can
    // use `sessionKey` without per-case re-narrowing on each switch arm.
    const sessionKey = 'sessionKey' in event ? (event as { sessionKey?: string }).sessionKey : undefined;
    if (!sessionKey) return;
    // An end is waiting for its last words to be painted: what follows it waits too.
    const heldBehindEnd = heldBehindEndRef.current.get(sessionKey);
    if (heldBehindEnd) { heldBehindEnd.push(event); return; }

    // Ordering guarantee: a non-delta event must see buffered text already
    // committed before it reads/mutates the last message (blocks timeline).
    if (event.type !== 'stream:content_chunk' && event.type !== 'stream:thinking_chunk') {
      flushLiveDeltas(sessionKey);
    }
    // Stessa regola per gli output di tool bufferati: qualunque evento che NON
    // sia un altro `tool_update` deve vedere l'ultimo parziale già applicato. Il
    // caso che conta è `stream:tool_result`, che scrive l'esito definitivo sulla
    // stessa riga: se un parziale in coda atterrasse dopo, lo sovrascriverebbe
    // con del testo vecchio.
    if (event.type !== 'stream:tool_update') {
      flushToolUpdates(sessionKey);
    }

    // Skip WS stream events for sessions with an active local SSE stream
    // (sendMessage already processes these via HTTP response — avoid double content).
    //
    // `stream:usage` NON è fra i saltati, ed è il motivo per cui la finestra da
    // cui parte il turno vedeva i token fermi a zero.
    //
    // Questo cancello esiste contro il DOPPIONE: ciò che l'SSE della nostra
    // POST /api/chat già porta non va riprocessato dal filo. Il consumo però
    // sull'SSE non viaggia — il server lo emette SOLO come broadcast WS
    // (routes/chat.ts, `onUsage`) — e da quando i numeri vivono sulla riga del
    // messaggio invece che in uno stato dentro la striscia (676b9e28, «I numeri
    // del turno vivono sul messaggio»), passano di qui: prima
    // `TurnActivityIndicator` si iscriveva al filo per conto suo e questo
    // cancello non lo toccava. Risultato: la finestra che stai guardando —
    // quella che ha mandato il messaggio — era l'UNICA a non vedere crescere il
    // consumo, mentre le altre sì.
    //
    // Farlo passare non può duplicare niente: il server manda TOTALI già
    // accumulati e il gestore li SCRIVE (non li somma) sull'ultima riga, quindi
    // riceverlo due volte darebbe lo stesso numero. Gli eventi TERMINALI
    // restano scartati — processarli qui duplicherebbe la finalizzazione — ma
    // non li buttiamo del tutto: dicono che il server ha chiuso il turno, e se
    // il nostro SSE non chiude dietro sono l'unico modo per accorgersene. Vedi
    // scheduleSSEFailsafe.
    // `stream:tool_permission_required` passa per la STESSA ragione di
    // `stream:usage`, ed è il caso peggiore della stessa famiglia: il pannello
    // del permesso viaggia SOLO su WebSocket (`server/routes/topics.ts:2057`) e
    // sull'SSE non c'è. Scartandolo, la finestra che possiede l'SSE — cioè
    // proprio quella da cui hai mandato il messaggio — era strutturalmente
    // CIECA al pannello che stava aspettando: restava a girare, mentre il
    // telefono, che l'SSE non ce l'ha, lo mostrava. E un refresh «lo faceva
    // comparire» perché ricaricava dallo snapshot invece che dal filo.
    //
    // Non può duplicare niente, per lo stesso motivo dell'usage: il gestore
    // SCRIVE uno stato fisso sulla tool call (`awaiting_permission` + la
    // richiesta), non accumula — riceverlo due volte lascia lo stesso stato.
    // The list itself now lives in `senderAlsoSees.ts`, with the rule for
    // adding to it and a test that counts it: it turned out to be incomplete
    // twice, and here it could not fail in a test.
    // A late frame of a turn the server closed is let through too: this SSE
    // is the next turn's, and it never carries it.
    const passaAncheAlMittente = senderAlsoSeesFrame(event);
    if (localSSESessionsRef.current.has(sessionKey) && !passaAncheAlMittente) {
      if (ownReplyClosedRef.current.has(sessionKey)) swallowedAfterReplyRef.current.add(sessionKey);
      if (event.type === 'stream:end') {
        finishStreamTokenRate(sessionKey, event.usageCompletionTokens);
        endedDuringOwnSseRef.current.add(sessionKey);
        scheduleSSEFailsafe(sessionKey);
      } else if (event.type === 'stream:error') {
        finishStreamTokenRate(sessionKey);
        endedDuringOwnSseRef.current.add(sessionKey);
        scheduleSSEFailsafe(sessionKey);
      }
      return;
    }

    // THE LAST WORDS ARE DRAWN BEFORE THE TURN CLOSES (`textPaintGate.ts`).
    // A reply that ends right behind its text brings the last chunk and the
    // end a millisecond apart: closed in the same commit, the text grew the
    // bubble in the frame the loader went and the turn jumped 27 px (card
    // 40ea050c). The end, and every frame of the session after it, waits for
    // the frame that shows those words.
    // An end that draws an interruption banner (the watchdog, the reaper) is
    // not the still end this protects: the banner grows the turn anyway, and
    // the person watching must see why it stopped in the frame it stopped.
    if (
      event.type === 'stream:end'
      && textPaintGateRef.current.isPending(sessionKey)
      && !liveInterruptionBlock({ stopCause: event.stopCause, error: event.error })
    ) {
      const queue: WSMessage[] = [event];
      heldBehindEndRef.current.set(sessionKey, queue);
      textPaintGateRef.current.afterPaint(sessionKey, () => {
        heldBehindEndRef.current.delete(sessionKey);
        for (const held of queue) handleStreamEventRef.current(held);
      });
      return;
    }

    switch (event.type) {
      case 'stream:start':
        beginStreaming(sessionKey);
        resetStreamTimeout(sessionKey); // Start timeout watchdog
        // Il nome DUREVOLE della bolla in volo, tenuto per sessione finché il
        // turno non finisce. Serve a `addMessage`: un `message:new` che arriva a
        // turno aperto con un id DIVERSO da questo non è la fine del turno, è
        // un'altra riga (l'uscita di un sotto-agente), e non deve fondersi nel
        // segnaposto vivo. Vedi il ramo di fusione in `addMessage`.
        if (event.messageId) streamMessageIdRef.current.begin(sessionKey, event.messageId);
        // Le delta del turno di PRIMA non devono atterrare dopo l'azzeramento:
        // sono già dentro la bolla che stiamo per svuotare, e ricomparirebbero
        // in testa al replay.
        if (event.reattached) liveDeltaBufferRef.current.delete(sessionKey);
        // Only create assistant placeholder if there isn't already a partial one
        // (sendMessage creates one via SSE, so WS broadcast to OTHER windows only)
        setMessages(prev => {
          const sessionMessages = prev[sessionKey] || [];
          const lastMsg = sessionMessages[sessionMessages.length - 1];
          if (lastMsg?.role === 'assistant' && lastMsg.partial) {
            // A woken turn's banner reaches a bubble already opened by another frame.
            if (event.banners?.length && lastMsg.id === event.messageId && !(lastMsg.blocks ?? []).some((b) => b.kind === 'woken')) {
              return { ...prev, [sessionKey]: [...sessionMessages.slice(0, -1), { ...lastMsg, blocks: [...event.banners, ...(lastMsg.blocks ?? [])] }] };
            }
            // Riadozione dopo un riavvio del server: la bolla c'è già ed è
            // PIENA di quello che il turno aveva scritto prima. Il replay sta
            // per ridettarlo tutto in delta, che qui si appendono: senza questo
            // azzeramento il turno uscirebbe doppio. Vedi streamReattachReset.ts.
            if (event.reattached) {
              const cleared = clearPartialForReattach(sessionMessages);
              return cleared === sessionMessages ? prev : { ...prev, [sessionKey]: cleared };
            }
            // Already have a partial assistant message — skip duplicate
            return prev;
          }
          // The server can hand this turn the id of a bubble we ALREADY have,
          // finished: a spontaneous turn picking up the «no answer» headstone
          // left by a task-notification turn. Reopen that bubble where it is,
          // or the fallback below would append a twin with the same id — the
          // false notice still on screen with the answer under it.
          if (event.messageId) {
            const revived = reviveClosedBubble(sessionMessages, event.messageId);
            if (revived !== sessionMessages) return { ...prev, [sessionKey]: revived };
          }
          // No partial assistant msg — this is from another window, create placeholder
          //
          // L'id è QUELLO DEL SERVER quando ce lo dice, e ce lo dice sempre
          // (`shared/ws-outbound.ts`: `messageId` è obbligatorio su
          // `stream:start`). Coniarne uno locale significava che la riga in DB e
          // la bolla a schermo avevano due nomi diversi: un `loadHistory` a metà
          // turno riportava indietro la stessa risposta sotto il nome vero, non
          // riconosceva il segnaposto e la disegnava DUE VOLTE.
          return {
            ...prev,
            [sessionKey]: [...sessionMessages, {
              // NIENTE RIPIEGO: `messageId` e' obbligatorio sul filo e non vuoto
              // (`shared/ws-outbound.ts`, `z.string().min(1)`), quindi un id
              // coniato qui sarebbe solo il ramo rotto preso in silenzio.
              id: event.messageId,
              role: 'assistant' as const,
              content: '',
              timestamp: new Date().toISOString(),
              partial: true,
              // What woke this turn: no live frame carries it, and a short
              // wake used to show its banner only after a reload (BGVIS-06).
              ...(event.banners?.length ? { blocks: event.banners } : {}),
            }],
          };
        });
        break;

      case 'stream:thinking_start':
        reserveThinkingRow(sessionKey);
        break;

      case 'stream:thinking_chunk':
        // A closed turn's late answer names its bubble, and waits apart from
        // the live buffer, which belongs to the turn in flight.
        if (event.content) bufferLiveDelta(sessionKey, undefined, event.content, event.late ? { messageId: event.messageId, late: true } : undefined);
        break;

      case 'stream:thinking_end':
        setThinking(prev => ({ ...prev, [sessionKey]: false }));
        break;

      case 'stream:content_chunk':
        if (event.content) {
          const cleanedChunk = cleanInvisibleMarkers(event.content);
          if (event.late) {
            // Same as the thinking above; and no watchdog reset, it guards the
            // turn in flight, not this one.
            const opens = carryLateStart(pendingLateStartRef.current, event, !!cleanedChunk);
            if (cleanedChunk) bufferLiveDelta(sessionKey, cleanedChunk, undefined, { messageId: event.messageId, late: true, ...(opens ? { lateStart: true as const } : {}) });
            break;
          }
          if (cleanedChunk) bufferLiveDelta(sessionKey, cleanedChunk, undefined);
          relightSettledTurn(sessionKey);
          resetStreamTimeout(sessionKey); // Reset watchdog on each chunk (immediate, not deferred)
        }
        break;

      case 'stream:compaction':
        // Context compaction boundary (CHAT-COMPACT-01) — display-only divider.
        // Render-only: no message mutation, no model resume.
        upsertMarker(sessionKey, {
          id: event.markerId,
          sessionKey,
          topicId: event.topicId ?? null,
          afterMessageId: event.afterMessageId ?? null,
          trigger: event.trigger,
          ...(typeof event.preTokens === 'number' ? { preTokens: event.preTokens } : {}),
          ...(typeof event.postTokens === 'number' ? { postTokens: event.postTokens } : {}),
          createdAt: event.createdAt,
        });
        break;

      case 'stream:command-answer':
        // The answer of a command (CMDUI-04) is the pane's card, not a
        // message: handed to the chat that shows this session, never stored.
        window.dispatchEvent(new CustomEvent(COMMAND_ANSWER_EVENT, {
          detail: { sessionKey, command: event.command, text: event.text, ...(event.outcome ? { outcome: event.outcome } : {}) },
        }));
        break;

      case 'stream:tool_call':
        if (event.toolCall) {
          if (!event.late) relightSettledTurn(sessionKey, event.messageId);
          addToolCallToLastMessage(sessionKey, event.toolCall as ToolCall, event);
        }
        break;

      case 'stream:tool_result':
        // Replace the ToolCall with a new instance so React.memo on
        // MessageContent sees a real prop change. `patchToolCallInMessages`
        // mirrors it into both the legacy `toolCalls` bucket and the
        // chronological `blocks` timeline — e restituisce l'array com'era se la
        // riga non c'è, così un id sconosciuto non ridisegna la chat.
        if (event.toolCallId) {
          applyToolPatch(sessionKey, event.toolCallId, oldTc => ({
            ...oldTc,
            status: ((event.status as ToolCall['status']) || 'success'),
            result: event.result as string | undefined,
            error: (event.error as string | undefined) ?? oldTc.error,
            detail: (event.detail as ToolCall['detail']) ?? oldTc.detail,
            // Server stamps the real-usage close on the result event;
            // durations render from endedAt - startedAt.
            endedAt: (typeof event.endedAt === 'number' ? event.endedAt : undefined) ?? oldTc.endedAt,
            ...(event.askEnded === 'cancelled' || event.askEnded === 'superseded' ? { askEnded: event.askEnded } : {}), // how a person ended a question
          }));
        }
        break;

      case 'stream:tool_usage':
        // Costo/token di UNA azione, attribuiti dalla chiamata che l'ha decisa
        // (server onToolUsage). Patcha la riga del tool per id, come
        // stream:tool_result — nuova istanza ToolCall così React.memo vede il
        // cambio. Arriva mentre il tool è ancora running: non tocca status.
        if (event.toolCallId) {
          applyToolPatch(sessionKey, event.toolCallId, oldTc => ({
            ...oldTc,
            ...(typeof event.tokens === 'number' ? { tokens: event.tokens } : {}),
            ...(typeof event.costCents === 'number' ? { costCents: event.costCents } : {}),
          }));
        }
        break;

      case 'stream:tool_update':
        // Live partial result from a long-running tool (e.g. a Bash that
        // streams output). The native runtime, codex and acp emit
        // these; the `cli` runtime cannot (its stream carries only heartbeats,
        // no output). Patch the running tool's `result` field with
        // the partial so the user sees output flowing in instead of staring
        // at a spinner. Status stays 'running' — the terminal status comes
        // later via stream:tool_result.
        //
        // Passa dal buffer a frame: ne arriva uno per riga stampata, e la patch
        // SOSTITUISCE `result`, quindi tenere solo l'ultimo del frame lascia lo
        // stesso stato. Vedi `bufferToolUpdate`.
        if (event.toolCallId && typeof event.partialResult === 'string') {
          bufferToolUpdate(sessionKey, event.toolCallId, event.partialResult);
        }
        // AND THE STATUS, which is this event's other half. A `tool_update`
        // with no partial announces a transition - an answered question going
        // back to `running` - and it used to be dropped, so the panel stayed on
        // its spinner. The whole account is in `toolUpdatePatch`.
        {
          const patch = toolUpdatePatch(event as ToolUpdateEvent);
          if (patch && event.toolCallId) {
            applyToolPatch(sessionKey, event.toolCallId, (tc) => withToolUpdate(tc, patch));
          }
        }
        break;

      case 'stream:tool_detail':
        // Sub-agent (Task) snapshot update from the server's SidechainTracker.
        // Patches the parent Task tool's `detail` field with the latest
        // actions[] log so the renderer's <SubAgentCard> can show live progress.
        // Snapshot, not delta — replace the whole detail.
        if (event.toolCallId && event.detail) {
          const detail = event.detail as ToolCall['detail'];
          applyToolPatch(sessionKey, event.toolCallId, oldTc => ({ ...oldTc, detail }));
        }
        break;

      case 'stream:tool_permission_resolved':
        // Qualcuno ha deciso — magari su un altro dispositivo. La riga torna a
        // girare e l'esito RESTA visibile: senza questo evento il pannello
        // spariva e della decisione non restava traccia fino al reload,
        // perché `stream:tool_update` porta solo `partialResult`.
        if (event.toolCallId) {
          applyToolPatch(sessionKey, event.toolCallId, withPermissionResolved(event.outcome));
        }
        break;

      case 'stream:tool_permission_required':
        // La CLI chiede se questo strumento può partire. Stesso trattamento del
        // pannello delle domande per ciò che riguarda il turno (resta in volo,
        // lo Stop resta disponibile), stato diverso per ciò che riguarda la
        // riga: `awaiting_permission` + una richiesta tipizzata.
        if (event.toolCallId) {
          resetStreamTimeout(sessionKey);
          // Held when the row is not born yet: the panel travels only on WS (`heldToolFacts.ts`).
          const asked = withPermissionAsked(event.request);
          const toolCallId = event.toolCallId;
          setMessages(prev => {
            const cur = prev[sessionKey] ?? [];
            const next = patchToolCallOrHold(cur, heldToolFactsRef.current, sessionKey, toolCallId, asked);
            return next === cur ? prev : { ...prev, [sessionKey]: next };
          });
        }
        break;

      case 'stream:tool_user_input_required':
        // The provider paused the stream waiting for a human answer.
        // Patch the matching ToolCall on the last assistant message so
        // <ToolCallRow> can swap its spinner for <ToolInputForm>. We
        // intentionally do NOT clear the streaming flag — the turn is
        // still in flight; the composer's unified Stop button must stay
        // available as an escape hatch (see composerAction.ts). The
        // soft-timeout watchdog is reset because we just heard from the
        // provider, but it won't fire as long as a tool is open.
        if (event.toolCallId) {
          resetStreamTimeout(sessionKey);
          // When the row is not born yet in this window (its SSE burst still
          // held by WebKit), the question waits for it (`heldToolFacts.ts`).
          const asked = withQuestionAsked(event.schema);
          const toolCallId = event.toolCallId;
          setMessages(prev => {
            const cur = prev[sessionKey] ?? [];
            const next = patchToolCallOrHold(cur, heldToolFactsRef.current, sessionKey, toolCallId, asked);
            return next === cur ? prev : { ...prev, [sessionKey]: next };
          });
        }
        break;

      // I numeri del turno MENTRE cresce — token, scorporo della cache, costo.
      //
      // Vivevano dentro `TurnActivityIndicator`, che si iscriveva al filo per
      // conto suo e li teneva in uno stato locale. Il frame passa UNA volta e
      // nessuno lo conserva: chi montava dopo — una pane aperta a turno già in
      // corso, un cambio di tab, qualunque remount della riga — non li vedeva
      // comparire mai più, e in chat restava un turno che macina senza dire
      // quanto sta costando. Qui finiscono sul MESSAGGIO, che è lo stato che
      // sopravvive ai remount: da lì li legge la striscia viva e, a turno
      // fermo su una domanda, la stessa striscia di chiusura di un messaggio
      // finito. Il server manda i TOTALI già accumulati: qui non si somma.
      case 'stream:usage': {
        const u = event as unknown as {
          promptTokens?: number; completionTokens?: number; costCents?: number;
          cacheReadTokens?: number; cacheCreationTokens?: number; cacheCreation1hTokens?: number;
          model?: string;
        };
        // Ogni campo si scrive SOLO se c'è davvero.
        //
        // Scriverli tutti significava che un frame senza uno di quei numeri —
        // il provider non li manda sempre tutti — lo azzerava a `undefined`, e
        // la striscia di fine turno spariva: `MessageMetaFooter` non disegna
        // niente quando non ha né durata né token né costo. Un aggiornamento
        // non deve poter CANCELLARE quello che sapevamo già.
        const patch: Partial<ChatMessage> = {};
        if (u.promptTokens != null) patch.usagePromptTokens = u.promptTokens;
        if (u.completionTokens != null) patch.usageCompletionTokens = u.completionTokens;
        if (u.costCents != null) patch.costCents = u.costCents;
        if (u.cacheReadTokens != null) patch.cacheReadTokens = u.cacheReadTokens;
        if (u.cacheCreationTokens != null) patch.cacheCreationTokens = u.cacheCreationTokens;
        if (u.cacheCreation1hTokens != null) patch.cacheCreation1hTokens = u.cacheCreation1hTokens;
        if (u.model) patch.model = u.model;
        if (Object.keys(patch).length > 0) updateLastMessage(sessionKey, patch);
        break;
      }

      case 'stream:error':
        heldToolFactsRef.current.clear(sessionKey);
        finishStreamTokenRate(sessionKey);
        clearStreamTimeout(sessionKey);
        streamMessageIdRef.current.end(sessionKey);
        setStreaming(prev => ({ ...prev, [sessionKey]: false }));
        setThinking(prev => ({ ...prev, [sessionKey]: false }));
        if (event.error) {
          updateLastMessage(sessionKey, { partial: false });
        }
        break;

      case 'stream:end':
        heldToolFactsRef.current.clear(sessionKey);
        turnEndsRef.current.set(sessionKey, (turnEndsRef.current.get(sessionKey) ?? 0) + 1);
        finishStreamTokenRate(sessionKey, event.usageCompletionTokens);
        clearStreamTimeout(sessionKey); // Clear watchdog
        setStreaming(prev => ({ ...prev, [sessionKey]: false }));
        setThinking(prev => ({ ...prev, [sessionKey]: false }));
        // Il turno è stato fermato prima che il modello producesse qualcosa: il
        // server ha CANCELLATO la riga, non finalizzata. Toglierla anche qui, o
        // questa finestra resta con una bolla vuota che il DB non ha più (e che
        // sparirebbe solo al reload).
        if (event.discardedMessageId) {
          dropEmptyTurn(sessionKey, event.discardedMessageId);
          const gone = discardedRowsRef.current.get(sessionKey) ?? new Set<string>();
          discardedRowsRef.current.set(sessionKey, gone.add(event.discardedMessageId));
        }
        // Strip any remaining browser markers (handles split-across-chunks case)
        //
        // La scrittura in cache sta FUORI dall'updater. Un updater di `setState`
        // deve essere puro: React lo esegue due volte in StrictMode e puo'
        // rieseguirlo quando gli pare. Dentro c'era una `cacheMessages`, cioe'
        // una serializzazione dell'intera conversazione piu' una scrittura su
        // localStorage — che a quota piena scandisce anche tutte le altre voci
        // per fare spazio. Il pattern "mitigazione dentro il percorso caldo" e'
        // esattamente quello che oggi, sul tetto delle pane, ha fatto crescere
        // la memoria dodici volte.
        {
        const cacheOnEnd: { msgs: ChatMessage[] | null } = { msgs: null };
        setMessages(prev => {
          const msgs = prev[sessionKey] || [];
          // La bolla del TURNO, non «l'ultima»: a turno con sotto-agenti in coda
          // può esserci il rapporto di uno di loro. Vedi `liveAssistantIndex`.
          const at = liveAssistantIndex(msgs, streamMessageIdRef.current.get(sessionKey));
          const last = at >= 0 ? msgs[at] : undefined;
          if (last) {
            // Always run through the centralized cleaner so detection tracks the
            // full marker set; only rewrite if it actually changed something.
            const cleaned = cleanInvisibleMarkers(last.content);
            // WHY THE TURN ENDED, ONTO THE ROW WE ARE ALREADY HOLDING.
            // The server just wrote this same block in the DB, but this page
            // has the message in memory: without applying it here the banner
            // showed up only after a reload, which is to say it did not show up
            // to the person who was sitting there watching. See
            // `liveInterruptionBlock` for which ends qualify.
            const verdict = liveInterruptionBlock({
              stopCause: event.stopCause,
              error: event.error,
              blocks: last.blocks,
            });
            if (cleaned !== last.content || verdict) {
              const updated = [...msgs];
              updated[at] = {
                ...last,
                content: cleaned,
                partial: false,
                ...(verdict ? { blocks: [...(last.blocks ?? []), verdict] } : {}),
              };
              cacheOnEnd.msgs = updated;
              return { ...prev, [sessionKey]: updated };
            }
          }
          cacheOnEnd.msgs = msgs;
          return prev;
        });
        // Cache after stream finishes
        if (cacheOnEnd.msgs) cacheMessages(sessionKey, cacheOnEnd.msgs);
        }
        {
          // Persist latency / token usage / cost from the stream:end payload
          // onto the last message so the footer can render them. All four
          // fields are optional on `WSStreamEndMessage` — only patch the
          // ones the server actually included on this turn.
          const finalPatch: Partial<ChatMessage> = { partial: false };
          if (typeof event.latencyMs === 'number') finalPatch.latencyMs = event.latencyMs;
          if (typeof event.usagePromptTokens === 'number') finalPatch.usagePromptTokens = event.usagePromptTokens;
          if (typeof event.usageCompletionTokens === 'number') finalPatch.usageCompletionTokens = event.usageCompletionTokens;
          if (typeof event.costCents === 'number') finalPatch.costCents = event.costCents;
          if (typeof event.model === 'string' && event.model) finalPatch.model = event.model;
          // Lo scorporo della cache, sullo stesso principio degli altri: si applica
          // SOLO se il server l'ha mandato. Un `?? 0` qui scriverebbe "misurato,
          // nessuna cache" su un turno di cui non sappiamo la composizione.
          if (typeof event.cacheReadTokens === 'number') finalPatch.cacheReadTokens = event.cacheReadTokens;
          if (typeof event.cacheCreationTokens === 'number') finalPatch.cacheCreationTokens = event.cacheCreationTokens;
          if (typeof event.cacheCreation1hTokens === 'number') finalPatch.cacheCreation1hTokens = event.cacheCreation1hTokens;
          updateLastMessage(sessionKey, finalPatch);
        }
        // Il turno è finito: se c'è una coda, tocca a lei — a meno che il turno
        // sia finito perché QUALCUNO L'HA FERMATO. Lo `stream:end` di un abort
        // è indistinguibile da quello di un turno arrivato in fondo, ed è
        // esattamente per questo che il freno è una bandiera a sé
        // (`holdQueue`): senza, premere «ferma» faceva PARTIRE il messaggio in
        // coda. Vedi `state/chatQueue.ts`.
        // Il nome della riga in volo si dimentica QUI, non in cima al caso: la
        // finalizzazione qui sopra (`partial:false`, durata, token, costo) deve
        // ancora trovare la bolla giusta, e senza il nome ricadrebbe sull'ultimo
        // messaggio — che a turno con sotto-agenti non è più lui.
        // A Stop pressed on ANOTHER device (or a window of another profile)
        // stops this queue too: the hold is local storage, and that window's
        // hold never reached this one, which read the stop as a plain end and
        // sent what was queued. The close of the turn says it as well
        // (`stopped`); either word goes through the drain's own rule
        // (`decideDrain`, `hold-stop`), which knows a Stop already lifted.
        if (event.reason === 'user_abort' || event.stopCause === 'user') noteStopHeard(sessionKey);
        settleTurn(sessionKey);
        break;

      case 'stream:alive':
        // The server's stale-stream sweep asked this turn's child, and it is alive.
        relightSettledTurn(sessionKey, event.messageId);
        break;

      case 'stream:catchup':
        // Full buffer catch-up from server on WS connect — set streaming
        // state and create/update the assistant message with accumulated
        // state. The merge logic (which carries toolCalls + blocks from
        // the DB partial row through to the client) lives in
        // `streamCatchupMerge.ts` so it can be unit-tested without React.
        beginStreaming(sessionKey);
        resetStreamTimeout(sessionKey);
        // Chi si attacca a turno già iniziato non ha visto `stream:start`: il
        // nome della riga in volo glielo dice il catchup, ed è lo stesso.
        if (event.messageId) streamMessageIdRef.current.begin(sessionKey, event.messageId);
        if (event.isThinking) {
          setThinking(prev => ({ ...prev, [sessionKey]: true }));
        }
        setMessages(prev => {
          const sessionMessages = prev[sessionKey] || [];
          const lastMsg = sessionMessages[sessionMessages.length - 1];
          const merged = mergeCatchupIntoPartial(
            {
              messageId: event.messageId,
              content: event.content,
              thinking: event.thinking,
              toolCalls: event.toolCalls,
              blocks: event.blocks,
            },
            lastMsg,
            generateMessageId,
            new Date().toISOString(),
          );
          if (lastMsg?.role === 'assistant' && lastMsg.partial) {
            const updated = [...sessionMessages];
            updated[updated.length - 1] = merged;
            return { ...prev, [sessionKey]: updated };
          }
          return { ...prev, [sessionKey]: [...sessionMessages, merged] };
        });
        break;

      case 'message:media':
        if (event.media?.length > 0) {
          updateLastMessage(sessionKey, {
            media: event.media,
            ...(event.mediaSizes ? { mediaSizes: event.mediaSizes } : {}),
          });
        }
        break;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- handleStreamEventRef is a stable ref mirror declared right after this callback
  }, [addToolCallToLastMessage, updateLastMessage, dropEmptyTurn, resetStreamTimeout, clearStreamTimeout, scheduleSSEFailsafe, bufferLiveDelta, flushLiveDeltas, bufferToolUpdate, flushToolUpdates, applyToolPatch, upsertMarker, beginStreaming, settleTurn, relightSettledTurn, reserveThinkingRow]);
  // The held frames run through the handler of the moment they are released.
  const handleStreamEventRef = useRefMirror(handleStreamEvent);

  // Register WebSocket handler
  const registerWSHandler = useCallback((handler: (event: WSMessage) => void) => {
    wsHandlersRef.current.add(handler);
    return () => wsHandlersRef.current.delete(handler);
  }, [wsHandlersRef]);

  // Expose handler for App to connect
  const onWSMessage = useCallback((event: WSMessage) => {
    // Handle gateway connection status
    if (event.type === 'gateway:status') {
      setGatewayConnected(!!event.connected);
    }
    // The server's word on which turns are open: the only signal the turn
    // queue leaves on (`state/serverTurn.ts`, `decideDrain`).
    if (event.type === 'turn:state') {
      // A person's Stop, on this device or another, travels WITH the close
      // (`stopped`): the server sends the close before its `stream:end`, and a
      // queue drained on the close had already left when the `user_abort`
      // came. The drain holds on it (`hold-stop`), unless the person has
      // already lifted that Stop in some window of this profile: a second
      // window used to hold again on the same close after the first had sent,
      // and the next queued message stayed there for good.
      if (noteServerTurn(event.sessionKey, event) && !event.open) drainTurnQueueRef.current?.(event.sessionKey);
    } else if (event.type === 'turn:snapshot') {
      // A socket that (re)opens: every queue may have been waiting for a turn
      // that ended while this window was not listening, including queues of
      // chats not open here.
      noteTurnSnapshot(event);
      for (const sk of storedQueueSessions()) drainTurnQueueRef.current?.(sk);
    }
    // Handle stream events directly
    if (event.type?.startsWith('stream:') || event.type === 'message:media') {
      handleStreamEvent(event);
    }
    // The durable name of a message this window sent: the row the server
    // stored with a bubble's key takes that bubble's place, whether this
    // window still streams the turn or the send already ended (a 500, a Stop,
    // a network error). Never another row with the same words, and it never
    // ADDS anything (`hooks/ownBubble.ts`).
    if (event.type === 'message:new' && event.role === 'user' && event.sessionKey && event.messageId && event.clientMessageId) {
      const { sessionKey: sk, clientMessageId: key, messageId: durableId } = event;
      setMessages(prev => {
        const rows = prev[sk];
        if (!rows) return prev;
        const next = adoptDurableMessageId(rows, key, durableId);
        return next === rows ? prev : { ...prev, [sk]: next };
      });
      // A queued item under this key went back after an error the server had
      // already stored it through (`QueuedTurn.sent`): this row is it.
      if (getTurnQueue(sk).some((item) => item.id === key)) removeTurn(sk, key);
    }
    // Forward to registered handlers
    for (const handler of wsHandlersRef.current) {
      try { handler(event); } catch {}
    }
  }, [handleStreamEvent, drainTurnQueueRef, setGatewayConnected, wsHandlersRef]);

  return { onWSMessage, registerWSHandler };
}
