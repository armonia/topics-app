/**
 * Shared SSE consumer for the HTTP-gateway streaming path.
 *
 * Both routes/chat.ts and routes/edit.ts talk to the same
 * `topicProvider.streamHTTP`, so they receive the same frame shape.  Before
 * this module existed, each route kept its own copy of `processLine` and
 * `consumeGateway`.  The copy in edit.ts had drifted: it was missing the
 * `delta.tool_calls` and `delta.tool_result` branches, so regenerating a
 * message lost all tool call activity.
 *
 * Usage: call `makeGatewaySseProcessor(opts)` to get `{ processLine,
 * consumeGateway }`.  The two callbacks `onDone` and `onStreamEnd` are the
 * ONLY things that differ between the chat and edit routes.
 */

import type { Topic, ActiveStream } from "../types";
import type { OutboundMessage } from "../../shared/ws-outbound";
import type { ToolCall } from "../../shared/types";

export interface GatewaySseProcessorOpts {
  /** Opaque string that identifies the running stream. */
  sessionKey: string;
  /** Topic bound to this session, if any. */
  matchedTopic: Topic | null | undefined;
  /** Id of the partial assistant message row. */
  partialMsgId: string;

  // --- mutable state shared between processLine and consumeGateway ---

  /** Accumulator for non-thinking content.  Passed by reference (object). */
  contentRef: { value: string };
  /** Accumulator for thinking content. */
  thinkingRef: { value: string };
  /** Whether we are currently inside a <thinking> block. */
  inThinkingRef: { value: boolean };
  /** Number of content chunks received so far. */
  chunkCountRef: { value: number };

  // --- forwarding ---

  /** Write raw bytes to the HTTP client.  No-op after disconnect. */
  forwardToClient: (chunk: Uint8Array) => Promise<void>;
  /** Close the HTTP client stream. */
  closeClient: () => Promise<void>;
  /** Whether the client disconnected (read-only here; written by callers). */
  isClientDisconnected: () => boolean;
  /** Encoder shared with callers to avoid extra allocations. */
  encoder: TextEncoder;
  /** Low-level writer used to push extra SSE frames (tool_calls / tool_result). */
  writeExtra: (payload: string) => void;

  // --- broadcast helpers ---

  broadcastToAll: (msg: OutboundMessage) => void;
  broadcastToTopicSubscribers: (topicId: string, msg: OutboundMessage) => void;

  // --- stream state ---

  updateStreamContent: (sessionKey: string, content: string, thinking: string) => void;
  updateLastMessage: (sessionKey: string, update: {
    content?: string;
    thinking?: string;
    partial?: undefined;
    streamedAt?: undefined;
  }) => void;
  endStream: (sessionKey: string) => void;
  isStreaming: (sessionKey: string) => ActiveStream | undefined;

  // --- tool call persistence ---

  addToolCallToLastMessage: (sessionKey: string, toolCall: ToolCall) => unknown;
  /** Called with (sessionKey, toolCallId, result) — additional params optional. */
  updateToolCallResult: (sessionKey: string, toolCallId: string, result: string) => unknown;

  // --- SAVE_INTERVAL ---

  /** How many chunks between intermediate saves (default: 10). */
  saveInterval?: number;

  // --- per-route callbacks ---

  /**
   * Called when `[DONE]` is received in the SSE stream (clean end).
   *
   * The shared code has already called `updateLastMessage` and `endStream`
   * before invoking this.  The caller is responsible for broadcasting
   * `stream:end` with the appropriate extra fields (e.g. `completed: true`
   * for chat, plain for edit).  Use it for route-specific follow-up:
   * - chat: broadcast stream:end (completed+dispatched), message:new,
   *         unregister stream handler, finalizeTurnActivity
   * - edit: broadcast stream:end, updateUnreadCount
   */
  onDone: (partialMsgId: string) => void;

  /**
   * Called in `consumeGateway`'s `finally` block when `isStreaming` is still
   * true (i.e. the stream ended abruptly without a clean `[DONE]`).
   *
   * The shared code has already called `updateLastMessage`, `endStream` and
   * `broadcastToAll({ type: "stream:end", ... })` before invoking this.
   * Use it for route-specific cleanup:
   * - chat: unregister stream handler, finalizeTurnActivity
   * - edit: updateUnreadCount
   */
  onStreamEnd: () => void;

  /** Logger tag shown in console warnings (e.g. "[Stream:Edit]" or "[Stream]"). */
  logTag: string;

  /** AbortController governing this gateway read. */
  abortController: AbortController;
}

export interface GatewaySseProcessor {
  processLine: (line: string) => void;
  consumeGateway: (originalBody: ReadableStream<Uint8Array>) => Promise<void>;
}

/**
 * Build the shared `processLine` + `consumeGateway` pair for a gateway SSE
 * stream.  Both routes call this and supply their own `onDone`/`onStreamEnd`
 * callbacks for the parts that differ.
 */
export function makeGatewaySseProcessor(opts: GatewaySseProcessorOpts): GatewaySseProcessor {
  const {
    sessionKey, matchedTopic, partialMsgId,
    contentRef, thinkingRef, inThinkingRef, chunkCountRef,
    forwardToClient, closeClient, isClientDisconnected, writeExtra,
    broadcastToAll, broadcastToTopicSubscribers,
    updateStreamContent, updateLastMessage, endStream, isStreaming,
    addToolCallToLastMessage, updateToolCallResult,
    saveInterval = 10,
    onDone, onStreamEnd,
    logTag,
    abortController,
  } = opts;

  let lastSaveChunk = 0;

  const broadcastStreamToTopic = (msg: OutboundMessage): void => {
    if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, msg);
    else broadcastToAll(msg);
  };

  const processLine = (line: string): void => {
    if (!line.startsWith("data: ")) return;
    const data = line.slice(6).trim();

    if (data === "[DONE]") {
      if (!contentRef.value.trim()) {
        contentRef.value = "\u26a0\ufe0f No response received. The AI service may be overloaded. Please try again.";
        console.warn(`${logTag} Empty response for ${sessionKey} — surfacing error to client`);
      }
      updateLastMessage(sessionKey, {
        content: contentRef.value,
        thinking: thinkingRef.value || undefined,
        partial: undefined,
        streamedAt: undefined,
      });
      endStream(sessionKey);
      // Route-specific: the caller broadcasts stream:end with its own extra
      // fields and handles post-stream cleanup (unregister, finalize, unread).
      onDone(partialMsgId);
      return;
    }

    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta;

      if (delta?.content) {
        const content: string = delta.content;
        if (content.includes('<thinking>')) {
          inThinkingRef.value = true;
          broadcastToAll({ type: "stream:thinking_start", sessionKey, topicId: matchedTopic?.id } as OutboundMessage);
        }
        if (content.includes('</thinking>')) {
          inThinkingRef.value = false;
          broadcastToAll({ type: "stream:thinking_end", sessionKey, topicId: matchedTopic?.id } as OutboundMessage);
        }
        if (inThinkingRef.value) {
          const cleaned = content.replace(/<\/?thinking>/g, '');
          thinkingRef.value += cleaned;
          broadcastStreamToTopic({ type: "stream:thinking_chunk", sessionKey, topicId: matchedTopic?.id, content: cleaned } as OutboundMessage);
        } else {
          const cleaned = content.replace(/<\/?thinking>/g, '');
          if (cleaned) {
            contentRef.value += cleaned;
            broadcastStreamToTopic({ type: "stream:content_chunk", sessionKey, topicId: matchedTopic?.id, content: cleaned } as OutboundMessage);
          }
        }
        chunkCountRef.value++;
        updateStreamContent(sessionKey, contentRef.value, thinkingRef.value);
        if (chunkCountRef.value - lastSaveChunk >= saveInterval) {
          lastSaveChunk = chunkCountRef.value;
          updateLastMessage(sessionKey, { content: contentRef.value, thinking: thinkingRef.value || undefined });
        }
      }

      // Tool calls from the gateway SSE stream
      if (delta?.tool_calls) {
        for (const tc of (delta.tool_calls as Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>)) {
          if (tc.function?.name) {
            const toolCall: ToolCall = {
              id: tc.id ?? `tool-${Date.now()}`,
              name: tc.function.name,
              args: tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
              status: 'running',
              contentOffset: contentRef.value.length,
            };
            addToolCallToLastMessage(sessionKey, toolCall);
            broadcastStreamToTopic({ type: "stream:tool_call", sessionKey, topicId: matchedTopic?.id, toolCall });
            // Forward as an extra SSE frame to the HTTP client
            const payload = JSON.stringify({
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    id: toolCall.id,
                    function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
                    contentOffset: toolCall.contentOffset,
                  }],
                },
              }],
            });
            if (!isClientDisconnected()) writeExtra(`data: ${payload}\n\n`);
          }
        }
      }

      // Tool result from the gateway SSE stream
      if (delta?.tool_result) {
        const { id: trId, status: trStatus, result: trResult } = delta.tool_result as {
          id?: string; status?: string; result?: string;
        };
        if (trId) {
          updateToolCallResult(sessionKey, trId, trResult ?? 'completed');
          broadcastStreamToTopic({
            type: "stream:tool_result",
            sessionKey,
            topicId: matchedTopic?.id,
            toolCallId: trId,
            status: trStatus ?? 'success',
            result: trResult,
          });
          const payload = JSON.stringify({
            choices: [{
              index: 0,
              delta: { tool_result: { id: trId, status: trStatus ?? 'success', result: trResult } },
            }],
          });
          if (!isClientDisconnected()) writeExtra(`data: ${payload}\n\n`);
        }
      }
    } catch {
      // Malformed SSE frame: skip silently (matches original behaviour).
    }
  };

  const INACTIVITY_TIMEOUT_MS = 60_000;

  const consumeGateway = async (originalBody: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = originalBody.getReader();
    const onAbort = () => reader.cancel();
    abortController.signal.addEventListener("abort", onAbort, { once: true });
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let streamError: string | null = null;

    let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
    const resetInactivityTimer = (): void => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        console.warn(`${logTag} Inactivity timeout (${INACTIVITY_TIMEOUT_MS / 1000}s) for ${sessionKey}`);
        streamError = "Response timed out. The AI service took too long to respond. Please try again.";
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
        sseBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      }
      if (sseBuffer.trim()) processLine(sseBuffer);
    } catch (err: unknown) {
      const isAbort = (err as { name?: string })?.name === "AbortError" || abortController.signal.aborted;
      const errorMsg = streamError ?? (isAbort
        ? "Response timed out. Please try again."
        : "Connection lost during response. Please try again.");
      console.warn(`${logTag} Gateway read error for ${sessionKey}:`, (err as Error)?.message ?? err);
      if (!contentRef.value.trim()) contentRef.value = `\u26a0\ufe0f ${errorMsg}`;
      else contentRef.value += `\n\n---\n*\u26a0\ufe0f ${errorMsg}*`;
      const errPayload =
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `\n\n\u26a0\ufe0f ${errorMsg}` }, finish_reason: "stop" }] })}\n\n` +
        `data: [DONE]\n\n`;
      if (!isClientDisconnected()) {
        try { writeExtra(errPayload); } catch { /* client already gone */ }
      }
    } finally {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      abortController.signal.removeEventListener("abort", onAbort);
      reader.releaseLock();
      await closeClient();
      if (isStreaming(sessionKey)) {
        updateLastMessage(sessionKey, {
          content: contentRef.value,
          thinking: thinkingRef.value || undefined,
          partial: undefined,
          streamedAt: undefined,
        });
        endStream(sessionKey);
        broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic?.id, messageId: partialMsgId });
        onStreamEnd();
      }
    }
  };

  return { processLine, consumeGateway };
}
