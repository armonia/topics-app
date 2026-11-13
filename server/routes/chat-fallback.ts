import { appendUsageRecord } from "../usage/store";
import { calculateCost } from "../usage/pricing";
import { providerSurvivesRestart, turnSurvivesRestart } from "../lib/quiescence";
import { makeGatewaySseProcessor } from "../lib/gateway-sse-consumer";
import type { ChatTurnScope } from "./chat-turn-scope";

/** The HTTP path for a provider without streaming support. */
export async function runHttpFallback(turn: ChatTurnScope): Promise<Response | undefined> {
  const { addToolCallToLastMessage, appendLocalMessage, autoBindProject, boardAgentTurn, broadcastStreamToTopic, broadcastToAll, broadcastToTopicSubscribers, createPartialMessage, deps, detectLocalhostAutoNav, dispatched, endStream, endTurnAttention, finalMessages, finalizeTurnActivity, globalOrchestrator, isStreaming, matchedTopic, resumeAttempt, sessionKey, startStream, startTurnAttention, updateLastMessage, updateStreamContent, updateToolCallResult } = turn;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 300000);

  let resp: Response;
  if (turn.topicProvider.streamHTTP) {
    resp = await turn.topicProvider.streamHTTP(finalMessages, { sessionKey, signal: abortController.signal });
  } else {
    // Provider doesn't support streamHTTP — use complete() as fallback
    const result = await turn.topicProvider.complete(finalMessages, { userFacing: true, purpose: "chat-reply", sessionKey });
    clearTimeout(timeoutId);
    if (turn.carry) deps.answerRelay?.heard(turn.carry);
    const content = result.content;
    const storedFallback = appendLocalMessage(sessionKey, "assistant", content);
    if (matchedTopic) {
      broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: storedFallback.id, content, preview: content.slice(0, 100) });
    }
    const ssePayload = `data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(content)}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
    return new Response(ssePayload, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  }
  clearTimeout(timeoutId);
  if (resp.ok && turn.carry) deps.answerRelay?.heard(turn.carry);

  if (!resp.ok) {
    const text = await resp.text();
    const isRateLimit = resp.status === 429 || /rate.?limit/i.test(text);
    const errorMsg = isRateLimit
      ? "⚠️ Rate limit reached. The AI service is temporarily overloaded. Please wait a moment and try again."
      : `⚠️ AI service error (${resp.status}). Please try again.`;
    const errorPartial = createPartialMessage(sessionKey, "assistant");
    updateLastMessage(sessionKey, { content: errorMsg, partial: undefined, streamedAt: undefined, endReason: "error" }, { rowId: errorPartial.id });
    if (matchedTopic) {
      broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: errorMsg });
      broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: errorPartial.id, content: errorMsg, preview: errorMsg.slice(0, 100) });
      broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: errorPartial.id, reason: "error", error: errorMsg, ...(dispatched ? { dispatched: true } : {}) });
      startTurnAttention(matchedTopic, boardAgentTurn);
      endTurnAttention(matchedTopic, { messageId: errorPartial.id, reason: "error", error: errorMsg, dispatched: boardAgentTurn });
      finalizeTurnActivity(matchedTopic);
    }
    return new Response(
      `data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(errorMsg)}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }
    );
  }

  const contentType = resp.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await resp.json() as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;
    const content = data?.choices?.[0]?.message?.content || "";
    if (!globalOrchestrator) detectLocalhostAutoNav(content, matchedTopic);
    if (data?.usage) {
      const model = data.model || "unknown";
      const inputTokens = data.usage.prompt_tokens || 0;
      const outputTokens = data.usage.completion_tokens || 0;
      appendUsageRecord({
        timestamp: Date.now(), sessionKey, topicId: matchedTopic?.id, model, inputTokens, outputTokens,
        totalTokens: inputTokens + outputTokens, costUsd: calculateCost(model, inputTokens, outputTokens),
      }).catch(err => console.warn("[Usage] Failed to record usage:", err));
    }
    // Only broadcast message:new when we actually persisted the
    // assistant turn — otherwise receivers would see a row with no
    // messageId AND no content (current dedupe falls back to
    // last-of-role/content matching, which would silently dedupe
    // against an unrelated previous message). Empty completions are
    // recoverable on next turn; a phantom broadcast is not.
    const storedJsonAssistant = content ? appendLocalMessage(sessionKey, "assistant", content) : null;
    if (matchedTopic && storedJsonAssistant) {
      broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: storedJsonAssistant.id, content, preview: content.slice(0, 100) });
      startTurnAttention(matchedTopic, boardAgentTurn);
      endTurnAttention(matchedTopic, { messageId: storedJsonAssistant.id, completed: true, dispatched: boardAgentTurn }, { preview: content });
      finalizeTurnActivity(matchedTopic);
    }
    if (matchedTopic && !matchedTopic.projectPath && !globalOrchestrator) setTimeout(() => autoBindProject(matchedTopic!), 100);
    const ssePayload = `data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(content)}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
    return new Response(ssePayload, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  }

  // Streaming fallback — simplified version (no tool visibility)
  const originalBody = resp.body!;
  const SAVE_INTERVAL = 10;
  const partialMsg = createPartialMessage(sessionKey, "assistant");
  startStream(sessionKey, partialMsg.id, abortController, turnSurvivesRestart({ providerReattaches: providerSurvivesRestart(turn.topicProvider), boardCard: !!dispatched }), providerSurvivesRestart(turn.topicProvider));
  startTurnAttention(matchedTopic, boardAgentTurn);
  broadcastToAll({
    type: "stream:start", sessionKey, topicId: matchedTopic?.id, messageId: partialMsg.id,
    ...(resumeAttempt > 0 ? { resumedBy: "server" as const } : {}),
  });

  // Mutable state via refs so that both the WS onToolStart callback and
  // the shared SSE processor read from the same up-to-date value.
  const contentRef = { value: "" };
  const thinkingRef = { value: "" };
  const inThinkingRef = { value: false };
  const chunkCountRef = { value: 0 };

  // Always register WS handler for tool events — even if WS appears disconnected,
  // it may reconnect during the HTTP request. Tool events arrive via WS agent events.
  const httpRunId = `http:${crypto.randomUUID()}`;
  {
    turn.topicProvider.registerStreamHandler?.(sessionKey, httpRunId, {
      onTextDelta() {},  // Handled by HTTP SSE processLine
      onThinkingDelta() {},
      onToolStart(toolCallId: string, name: string, args?: Record<string, unknown>) {
        const toolCall = { id: toolCallId, name, args: args ?? {}, status: 'running' as const, contentOffset: contentRef.value.length };
        addToolCallToLastMessage(sessionKey, toolCall, { rowId: partialMsg.id });
        broadcastStreamToTopic({ type: "stream:tool_call", sessionKey, topicId: matchedTopic?.id, toolCall }, matchedTopic?.id);
      },
      onToolUpdate(toolCallId: string, partialResult: string) {
        broadcastStreamToTopic({ type: "stream:tool_update", sessionKey, topicId: matchedTopic?.id, toolCallId, partialResult }, matchedTopic?.id);
      },
      onToolResult(toolCallId: string, result: string) {
        updateToolCallResult(sessionKey, toolCallId, result, undefined, undefined, { rowId: partialMsg.id });
        broadcastStreamToTopic({ type: "stream:tool_result", sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'success', result }, matchedTopic?.id);
      },
      onDone() {},      // Handled by HTTP SSE [DONE]
      onError() {},
      onAborted() {},
    });
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let clientDisconnected = false;
  const encoder = new TextEncoder();
  const forwardToClient = async (chunk: Uint8Array) => { if (clientDisconnected) return; try { await writer.write(chunk); } catch { clientDisconnected = true; } };
  const closeClient = async () => { if (clientDisconnected) return; try { await writer.close(); } catch { clientDisconnected = true; } };

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
      if (!clientDisconnected) { try { writer.write(encoder.encode(payload)); } catch { clientDisconnected = true; } }
    },
    broadcastToAll,
    broadcastToTopicSubscribers,
    updateStreamContent,
    updateLastMessage,
    endStream,
    isStreaming,
    addToolCallToLastMessage,
    updateToolCallResult: (sk, id, result, own) => updateToolCallResult(sk, id, result, undefined, undefined, own),
    saveInterval: SAVE_INTERVAL,
    onDone: () => {
      // chat.ts-specific: unregister handler, broadcast message:new,
      // and mark stream:end as completed (overrides the shared broadcast).
      turn.topicProvider.unregisterStreamHandler?.(sessionKey);
      if (matchedTopic) {
        broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: partialMsg.id, content: contentRef.value, preview: contentRef.value.slice(0, 100) });
        // The shared module already broadcast stream:end; re-broadcast
        // with the chat-specific completed/dispatched fields.
        broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic?.id, messageId: partialMsg.id, completed: true, ...(dispatched ? { dispatched: true } : {}) });
        endTurnAttention(matchedTopic, { messageId: partialMsg.id, completed: true, dispatched: boardAgentTurn }, { preview: contentRef.value });
        finalizeTurnActivity(matchedTopic);
      }
    },
    onStreamEnd: () => {
      // chat.ts-specific: unregister handler + finalize activity (abrupt end).
      turn.topicProvider.unregisterStreamHandler?.(sessionKey);
      if (matchedTopic) {
        endTurnAttention(matchedTopic, { messageId: partialMsg.id, dispatched: boardAgentTurn });
        finalizeTurnActivity(matchedTopic);
      }
    },
    logTag: "[Stream]",
    abortController,
  });

  consumeGateway(originalBody).catch(err => console.error('[consumeGateway:chat] error:', err));
  return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}
