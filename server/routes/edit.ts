import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AppContext, RouteHandler, Topic } from "../types";
import type { AIProvider, ChatMessage } from "../providers";

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
    getTopicBySessionKey, loadActiveThread, resolveTopicCwd, appendLocalMessage, broadcastToAll, broadcastToTopicSubscribers,
    createBranchPartialMessage, startStream, updateLastMessage, endStream, updateStreamContent, isStreaming,
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
    },
  ): Promise<Response> {
    // O(1) lookup via UNIQUE index on session_key — replaces a full-table
    // scan that paid for every queued edit-stream.
    const matchedTopic = getTopicBySessionKey(sessionKey);
    const topicProvider = resolveProvider(matchedTopic);

    // Build the messages array from the active thread up to (and including) the new user message
    let activeThread = loadActiveThread(sessionKey);
    if (opts?.truncateAfterAnchor) {
      const anchorIdx = activeThread.findIndex(m => m.id === newUserMsgId);
      if (anchorIdx >= 0) activeThread = activeThread.slice(0, anchorIdx + 1);
    }
    const finalMessages: ChatMessage[] = activeThread.map(m => ({
      role: m.role,
      content: m.content,
    }));

    // Add system messages (system prompt, context files, etc.)
    if (matchedTopic) {
      const disabled = matchedTopic.disabledContextSources || [];
      const isSourceEnabled = (id: string) => !disabled.includes(id);
      if (matchedTopic.systemPrompt && isSourceEnabled("prompt:system")) {
        finalMessages.unshift({ role: "system", content: matchedTopic.systemPrompt });
      }
      if (matchedTopic.contextFiles && matchedTopic.contextFiles.length > 0) {
        const contextParts: string[] = [];
        for (const filePath of matchedTopic.contextFiles) {
          if (!isSourceEnabled(`file:${filePath}`)) continue;
          if (existsSync(filePath)) {
            try {
              const content = readFileSync(filePath, "utf-8");
              const fileName = filePath.split("/").pop() || filePath;
              contextParts.push(`--- File: ${fileName} ---\n${content}`);
            } catch {}
          }
        }
        if (contextParts.length > 0) {
          const insertIdx = (matchedTopic.systemPrompt && isSourceEnabled("prompt:system")) ? 1 : 0;
          finalMessages.splice(insertIdx, 0, { role: "system", content: `Context files for this topic:\n\n${contextParts.join("\n\n")}` });
        }
      }
      // Phase A: prefer the bound worktree's directory for template auto-
      // loading (CLAUDE.md, README.md, …). Falls back to projectPath for
      // unbound (legacy) topics. The system-message label still cites the
      // project's logical path so the agent's mental model stays project-
      // centric, not worktree-centric.
      {
        const projectDir = resolveTopicCwd(matchedTopic);
        const projectLabel = matchedTopic.projectPath || projectDir || null;
        if (projectDir && existsSync(projectDir)) {
          const TEMPLATE_FILES = ["CLAUDE.md", "README.md", ".cursorrules", "AGENTS.md"];
          const templateParts: string[] = [];
          for (const name of TEMPLATE_FILES) {
            let filePath = join(projectDir, name);
            if (!existsSync(filePath) && name === "CLAUDE.md") {
              const altPath = join(projectDir, ".claude", "CLAUDE.md");
              if (existsSync(altPath)) filePath = altPath;
            }
            if (existsSync(filePath)) {
              try { templateParts.push(`--- Project file: ${name} ---\n${readFileSync(filePath, "utf-8")}`); } catch {}
            }
          }
          if (templateParts.length > 0 && projectLabel) {
            const insertIdx = finalMessages.findIndex(m => m.role !== "system");
            finalMessages.splice(insertIdx >= 0 ? insertIdx : finalMessages.length, 0, {
              role: "system", content: `Project context files (from ${projectLabel}):\n\n${templateParts.join("\n\n")}`,
            });
          }
        }
      }
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
        const storedAssistant = appendLocalMessage(sessionKey, "assistant", result.content);
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
      let fullContent = "";
      let fullThinking = "";
      let isInThinking = false;
      let chunkCount = 0;
      let lastSaveChunk = 0;
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

      const processLine = (line: string) => {
        if (!line.startsWith("data: ")) return;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          updateLastMessage(sessionKey, { content: fullContent, thinking: fullThinking || undefined, partial: undefined, streamedAt: undefined });
          endStream(sessionKey);
          if (matchedTopic) {
            broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: partialMsg.id });
            updateUnreadCount(matchedTopic.id);
          }
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            const content = delta.content;
            if (content.includes('<thinking>')) { isInThinking = true; broadcastToAll({ type: "stream:thinking_start", sessionKey, topicId: matchedTopic?.id }); }
            if (content.includes('</thinking>')) { isInThinking = false; broadcastToAll({ type: "stream:thinking_end", sessionKey, topicId: matchedTopic?.id }); }
            if (isInThinking) {
              const cleaned = content.replace(/<\/?thinking>/g, '');
              fullThinking += cleaned;
              const tc = { type: "stream:thinking_chunk" as const, sessionKey, topicId: matchedTopic?.id, content: cleaned };
              if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, tc);
              else broadcastToAll(tc);
            } else {
              const cleaned = content.replace(/<\/?thinking>/g, '');
              if (cleaned) {
                fullContent += cleaned;
                const cc = { type: "stream:content_chunk" as const, sessionKey, topicId: matchedTopic?.id, content: cleaned };
                if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, cc);
                else broadcastToAll(cc);
              }
            }
            chunkCount++;
            updateStreamContent(sessionKey, fullContent, fullThinking);
            if (chunkCount - lastSaveChunk >= SAVE_INTERVAL) {
              lastSaveChunk = chunkCount;
              updateLastMessage(sessionKey, { content: fullContent, thinking: fullThinking || undefined });
            }
          }
        } catch {}
      };

      const consumeGateway = async () => {
        const reader = originalBody.getReader();
        const onAbort = () => reader.cancel();
        abortController.signal.addEventListener("abort", onAbort, { once: true });
        const decoder = new TextDecoder();
        let sseBuffer = "";
        // Inactivity timeout (60s per chunk) — mirrors chat.ts consumeGateway.
        // Without it a gateway that stalls mid-stream (partial data then silence
        // without closing the socket) leaves reader.read() blocked forever:
        // isStreaming stays true, the partial message never finalizes, and
        // stream:end never broadcasts. The abort flows through to the finally.
        const INACTIVITY_TIMEOUT_MS = 60000;
        let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
        const resetInactivityTimer = () => {
          if (inactivityTimer) clearTimeout(inactivityTimer);
          inactivityTimer = setTimeout(() => {
            console.warn(`[Stream:Edit] Inactivity timeout (${INACTIVITY_TIMEOUT_MS / 1000}s) for ${sessionKey}`);
            abortController.abort();
          }, INACTIVITY_TIMEOUT_MS);
        };
        resetInactivityTimer();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            resetInactivityTimer();
            await forwardToClient(value);
            sseBuffer += decoder.decode(value, { stream: true });
            const lines = sseBuffer.split("\n");
            sseBuffer = lines.pop() || "";
            for (const line of lines) processLine(line);
          }
          if (sseBuffer.trim()) processLine(sseBuffer);
        } catch (err) {
          console.warn(`[Stream:Edit] Gateway read error for ${sessionKey}:`, err);
        } finally {
          if (inactivityTimer) clearTimeout(inactivityTimer);
          abortController.signal.removeEventListener("abort", onAbort);
          reader.releaseLock();
          await closeClient();
          if (isStreaming(sessionKey)) {
            updateLastMessage(sessionKey, { content: fullContent, thinking: fullThinking || undefined, partial: undefined, streamedAt: undefined });
            endStream(sessionKey);
            broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic?.id, messageId: partialMsg.id });
            if (matchedTopic) updateUnreadCount(matchedTopic.id);
          }
        }
      };

      consumeGateway().catch(err => console.error('[consumeGateway:edit] error:', err));

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
          INSERT INTO messages (id, session_key, role, content, timestamp, sort_order, parent_id, branch_index, partial, plan_status)
          VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL)
        `).run(newMsg.id, sessionKey, newMsg.role, newMsg.content, newMsg.timestamp, maxOrder + 1, branchIndex);
        // Set active branch to this new sibling — use a special key for root siblings
        ctx.db.prepare(`INSERT OR REPLACE INTO active_branches (parent_id, session_key, active_branch_index) VALUES ('__root__', ?, ?)`).run(sessionKey, branchIndex);

        // Now stream a response — reuse the gateway streaming logic
        return await streamEditResponse(sessionKey, newMsg.id, body.content);
      }

      // Create sibling user message under the same parent
      const newUserMsg = createBranchMessage(sessionKey, parentId, "user", body.content);

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
      return await streamEditResponse(sessionKey, anchorId, anchor.content, { truncateAfterAnchor: true });
    }

    return null;
  };
}
