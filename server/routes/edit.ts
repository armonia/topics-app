import type { AppContext, RouteHandler, Topic } from "../types";
import type { AIProvider, ChatMessage } from "../providers";
import { adaptEnvelope, assembleTopicContext } from "../context";
import { autoreDaIdentita } from "../lib/message-author";
import { makeGatewaySseProcessor } from "../lib/gateway-sse-consumer";
import { regenerationPromptBlock, type EvidenceToolCall } from "./regenerate-evidence";

export interface EditDeps {
  resolveProvider: (topic?: Topic | null) => AIProvider;
  updateUnreadCount: (topicId: string) => void;
}

/**
 * Message-edit / branch-create endpoint (POST /api/messages/:id/edit): forks a
 * new sibling user message and streams the assistant reply over SSE. Split out
 * of the topics.ts god-file together with its ~200-line streamEditResponse SSE
 * helper. Mostly ctx (the message/stream stores, ctx.db) + two injected closure
 * helpers (resolveProvider, updateUnreadCount) — the autoname/history
 * dep-injection pattern, instantiated inside createTopicsRouter. The streaming
 * pipeline is a verbatim move; only the route dispatch changed.
 */
export function createEditRouter(ctx: AppContext, deps: EditDeps): RouteHandler {
  const {
    json, readJSON, matchRoute, getMessageById, getMessageSessionKey, createBranchMessage,
    getTopicBySessionKey, loadActiveThread, broadcastToAll, broadcastToTopicSubscribers,
    createBranchPartialMessage, startStream, updateLastMessage, endStream, updateStreamContent, isStreaming,
    addToolCallToLastMessage, updateToolCallResult,
  } = ctx;
  const { resolveProvider, updateUnreadCount } = deps;

  async function streamEditResponse(
    sessionKey: string,
    newUserMsgId: string,
    userContent: string,
    opts?: {
      /**
       * REGENERATE path: the anchor is an EXISTING user message whose active
       * child (the old assistant reply) is still on the active thread — the
       * model must not see its previous answer, so the prompt is truncated
       * right after the anchor. The EDIT path needs no truncation: its anchor
       * is a brand-new user message that IS the thread's tail.
       */
      truncateAfterAnchor?: boolean;
      /**
       * Le tool call della risposta che si sta RIscrivendo. Diventano le prove
       * su cui il modello può appoggiarsi in un passaggio che non ha strumenti:
       * vedi `regenerate-evidence.ts`. Assenti sul percorso di modifica, dove non
       * c'è un turno precedente da riscrivere — lì resta solo la dichiarazione
       * del vincolo, che serve comunque.
       */
      evidenceCalls?: EvidenceToolCall[] | null;
    },
  ): Promise<Response> {
    // O(1) lookup via UNIQUE index on session_key — replaces a full-table
    // scan that paid for every queued edit-stream.
    const matchedTopic = getTopicBySessionKey(sessionKey);
    const topicProvider = resolveProvider(matchedTopic);

    // Il ramo del prompt su cui rigenerare. Per REGENERATE va tagliato all'ancora:
    // il modello non deve vedere la risposta che sta rimpiazzando.
    let activeThread = loadActiveThread(sessionKey);
    if (opts?.truncateAfterAnchor) {
      const anchorIdx = activeThread.findIndex(m => m.id === newUserMsgId);
      if (anchorIdx >= 0) activeThread = activeThread.slice(0, anchorIdx + 1);
    }

    // Contesto dall'envelope canonico, non ricostruito a mano.
    //
    // Fino al 29/07 queste righe erano una SECONDA implementazione del preambolo:
    // system prompt, file di contesto e template ricopiati da `assemble.ts` con
    // le stesse stringhe («Context files for this topic:») e destinati a divergere
    // — mentre `envelope.ts` dichiarava che di ricostruzioni indipendenti non ce
    // n'erano. Ne mancavano SETTE blocchi: project-awareness (il cwd, che è
    // load-bearing), istruzioni browser, project-markers, topic-switch, memoria,
    // pinned e goal. E i template non passavano da `disabledContextSources`, così
    // un CLAUDE.md spento nell'inspector rientrava dalla finestra a ogni Rigenera.
    //
    // Strategia `history-aware` SEMPRE, qualunque sia il provider: questo percorso
    // non parla con la sessione CLI residente — chiama `streamHTTP`/`complete`,
    // che sono stateless e vogliono l'intero thread. Per la stessa ragione NON
    // partecipa alla deduplicazione del preambolo: non c'è una sessione che se lo
    // ricordi, e ogni chiamata deve essere autosufficiente.
    /**
     * QUESTO PASSAGGIO NON HA LE MANI, E VA DETTO.
     *
     * `complete()` gira senza strumenti su entrambi i runtime — la CLI passa
     * `--tools ""` (providers/claude/args.ts), il nativo `tools: []`. È giusto
     * così: la stessa funzione serve all'auto-naming e ai digest. Ma l'inviluppo
     * del topic, qui sotto, continua a descrivere al modello il progetto, il
     * browser e i tool: gli si dice «hai Bash» e poi gli si tolgono le mani.
     *
     * Il 2026-08-18 il risultato è stato una risposta con dentro
     * `<invoke name="Bash">…</invoke>` scritto come TESTO e gli output dei
     * comandi inventati, mentre `tool_calls` restava vuoto e la sessione ferma.
     * Sembrava un rapporto; non era mai girato niente.
     *
     * Il blocco dichiara il vincolo e, su una rigenerazione, porta le misure che
     * quel turno aveva DAVVERO raccolto. Così «rigenera» vuol dire «riscrivi la
     * stessa risposta dalle stesse misure» — le parole si rifanno, gli effetti
     * collaterali no. Vale anche sul percorso di modifica, dove prove non ce ne
     * sono: lì resta il vincolo da solo, che è comunque ciò che mancava.
     */
    const promptBlock = regenerationPromptBlock(opts?.evidenceCalls);

    let finalMessages: ChatMessage[];
    if (matchedTopic) {
      const envelope = assembleTopicContext(ctx, {
        sessionKey,
        providerName: topicProvider.name,
        providerStrategy: "history-aware",
        userMessageOverride: { content: userContent, messageId: newUserMsgId },
        includeLastUserInHistory: false,
        historyOverride: activeThread,
      });
      const payload = adaptEnvelope(envelope);
      finalMessages = [...(payload.history ?? []), { role: "user", content: `${payload.userContent}\n\n${promptBlock}` }];
    } else {
      // Nessun topic su questa sessione: non c'è contesto da assemblare, resta il
      // thread nudo (era il comportamento anche prima, per la guardia `if (matchedTopic)`).
      finalMessages = activeThread.map(m => ({ role: m.role, content: m.content }));
      finalMessages.push({ role: "user", content: promptBlock });
    }

    try {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 300000);

      let resp: Response;
      if (topicProvider.streamHTTP) {
        resp = await topicProvider.streamHTTP(finalMessages, { sessionKey, signal: abortController.signal });
      } else {
        // Fallback: use complete() and synthesize an SSE response
        const result = await topicProvider.complete(finalMessages);
        clearTimeout(timeoutId);
        // FRATELLO dell'ancora, non coda del thread. `appendLocalMessage` aggancia
        // in fondo al ramo attivo con branchIndex 0: su REGENERATE la risposta nuova
        // diventava FIGLIA di quella che doveva sostituire, quindi le frecce non la
        // mostravano come alternativa e la vecchia restava l'unica raggiungibile.
        // `createBranchPartialMessage` alloca l'indice giusto sotto l'ancora e attiva
        // il ramo nuovo — è quello che fa già il percorso in streaming qui sotto.
        const storedAssistant = createBranchPartialMessage(sessionKey, newUserMsgId);
        updateLastMessage(sessionKey, { content: result.content, partial: undefined, streamedAt: undefined });
        if (matchedTopic) broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: storedAssistant.id, content: result.content, preview: result.content.slice(0, 100) });
        const ssePayload = `data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(result.content)}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
        return new Response(ssePayload, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
      }
      clearTimeout(timeoutId);

      if (!resp.ok) {
        const text = await resp.text();
        return new Response(text, { status: resp.status, headers: { "Content-Type": "application/json" } });
      }

      // Create partial assistant message as child of the new user message
      const partialMsg = createBranchPartialMessage(sessionKey, newUserMsgId);
      startStream(sessionKey, partialMsg.id, abortController);
      broadcastToAll({ type: "stream:start", sessionKey, topicId: matchedTopic?.id, messageId: partialMsg.id });

      const originalBody = resp.body!;
      const SAVE_INTERVAL = 10;

      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      let clientDisconnected = false;

      const forwardToClient = async (chunk: Uint8Array) => {
        if (clientDisconnected) return;
        try { await writer.write(chunk); } catch { clientDisconnected = true; }
      };
      const closeClient = async () => {
        if (clientDisconnected) return;
        try { await writer.close(); } catch { clientDisconnected = true; }
      };

      const encoder = new TextEncoder();
      const contentRef = { value: "" };
      const thinkingRef = { value: "" };
      const inThinkingRef = { value: false };
      const chunkCountRef = { value: 0 };

      const { consumeGateway } = makeGatewaySseProcessor({
        sessionKey,
        matchedTopic,
        partialMsgId: partialMsg.id,
        contentRef,
        thinkingRef,
        inThinkingRef,
        chunkCountRef,
        forwardToClient,
        closeClient,
        isClientDisconnected: () => clientDisconnected,
        encoder,
        writeExtra: (payload: string) => {
          if (!clientDisconnected) {
            try { writer.write(encoder.encode(payload)); } catch { clientDisconnected = true; }
          }
        },
        broadcastToAll,
        broadcastToTopicSubscribers,
        updateStreamContent,
        updateLastMessage,
        endStream,
        isStreaming,
        addToolCallToLastMessage,
        updateToolCallResult: (sk, id, result) => updateToolCallResult(sk, id, result),
        saveInterval: SAVE_INTERVAL,
        onDone: (msgId: string) => {
          // edit.ts-specific: broadcast stream:end and update unread count
          broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic?.id, messageId: msgId });
          if (matchedTopic) updateUnreadCount(matchedTopic.id);
        },
        onStreamEnd: () => {
          // edit.ts-specific: update unread count for the topic (abrupt end,
          // stream:end already broadcast by the shared module's finally block).
          if (matchedTopic) updateUnreadCount(matchedTopic.id);
        },
        logTag: "[Stream:Edit]",
        abortController,
      });

      consumeGateway(originalBody).catch(err => console.error('[consumeGateway:edit] error:', err));

      return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
    } catch (err: any) {
      if (err.name === "AbortError") return json({ error: "Request timeout" }, 504);
      return json({ error: "Gateway unreachable: " + err.message }, 502);
    }
  }

  return async function editRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    const params = matchRoute(pathname, "/api/messages/:id/edit");
    if (params && method === "POST") {
      const body = await readJSON(req);
      if (!body?.content) return json({ error: "content required" }, 400);

      const originalMsg = getMessageById(params.id);
      if (!originalMsg) return json({ error: "message not found" }, 404);

      const sessionKey = getMessageSessionKey(params.id);
      if (!sessionKey) return json({ error: "session not found" }, 404);

      // L'autore (095). Questa rotta è la SECONDA porta da cui un prompt umano
      // entra — la prima è `POST /api/chat` — e riscrivere una domanda invece di
      // ribatterla non deve costare l'attribuzione: senza questa riga chi
      // corregge i propri prompt sparisce dai conteggi del suo profilo.
      const autore = autoreDaIdentita(ctx.db as never, ctx.requestIdentity?.(req) ?? null);

      const parentId = originalMsg.parentId || null;
      if (!parentId) {
        // Root message edit: create a new root message (sibling).
        // For simplicity, we treat root messages as having parent_id = null
        // and create a sibling with a different branch_index.
        const maxOrder = (ctx.db.prepare(`SELECT COALESCE(MAX(sort_order), -1) as max_order FROM messages WHERE session_key = ?`).get(sessionKey) as any).max_order;
        const maxBranch = (ctx.db.prepare(`SELECT COALESCE(MAX(branch_index), -1) as max_idx FROM messages WHERE session_key = ? AND parent_id IS NULL`).get(sessionKey) as any).max_idx;
        const branchIndex = maxBranch + 1;
        const newMsg: any = {
          id: crypto.randomUUID(),
          role: originalMsg.role,
          content: body.content,
          timestamp: new Date().toISOString(),
          parentId: null,
          branchIndex,
        };
        ctx.db.prepare(`
          INSERT INTO messages (id, session_key, role, content, timestamp, sort_order, parent_id, branch_index, partial, plan_status,
                                author_person_id, author_device_id)
          VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, ?, ?)
        `).run(
          newMsg.id, sessionKey, newMsg.role, newMsg.content, newMsg.timestamp, maxOrder + 1, branchIndex,
          // Solo su una riga UTENTE: la radice riscritta conserva il `role`
          // dell'originale, e su una risposta l'autore è un modello.
          newMsg.role === "user" ? autore.authorPersonId : null,
          newMsg.role === "user" ? autore.authorDeviceId : null,
        );
        // Set active branch to this new sibling — use a special key for root siblings
        ctx.db.prepare(`INSERT OR REPLACE INTO active_branches (parent_id, session_key, active_branch_index) VALUES ('__root__', ?, ?)`).run(sessionKey, branchIndex);

        // Now stream a response — reuse the gateway streaming logic
        return await streamEditResponse(sessionKey, newMsg.id, body.content);
      }

      // Create sibling user message under the same parent
      const newUserMsg = createBranchMessage(sessionKey, parentId, "user", body.content, autore);

      // Now stream the assistant response under the new user message
      return await streamEditResponse(sessionKey, newUserMsg.id, body.content);
    }

    // Regenerate: fork a NEW assistant sibling under the same user message and
    // re-stream — the general "try again" every LLM chat has, not just the
    // ⚠️-error retry. Reuses the whole edit streaming pipeline; the only
    // differences are (a) no new user message is created (the anchor is the
    // regenerated reply's own parent) and (b) the prompt thread is truncated
    // at the anchor so the model never sees the answer it's replacing.
    // createBranchPartialMessage allocates the next branch index + activates
    // it, so the old reply stays reachable via the sibling arrows.
    const regenParams = matchRoute(pathname, "/api/messages/:id/regenerate");
    if (regenParams && method === "POST") {
      const msg = getMessageById(regenParams.id);
      if (!msg) return json({ error: "message not found" }, 404);
      if (msg.role !== "assistant") return json({ error: "only assistant messages can be regenerated" }, 400);
      const sessionKey = getMessageSessionKey(regenParams.id);
      if (!sessionKey) return json({ error: "session not found" }, 404);
      if (isStreaming(sessionKey)) return json({ error: "a response is already streaming for this session" }, 409);
      const anchorId = msg.parentId;
      if (!anchorId) return json({ error: "message has no parent user message" }, 400);
      const anchor = getMessageById(anchorId);
      if (!anchor) return json({ error: "parent message not found" }, 404);
      // Le misure del turno che stiamo sostituendo viaggiano col prompt: il
      // modello riscrive le parole sugli stessi dati invece di rifare — o
      // fingere di rifare — il lavoro. Vedi `regenerate-evidence.ts`.
      return await streamEditResponse(sessionKey, anchorId, anchor.content, {
        truncateAfterAnchor: true,
        evidenceCalls: (msg.toolCalls ?? null) as EvidenceToolCall[] | null,
      });
    }

    return null;
  };
}
