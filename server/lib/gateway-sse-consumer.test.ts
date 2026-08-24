/**
 * Tests for makeGatewaySseProcessor — the shared SSE consumer used by both
 * routes/chat.ts and routes/edit.ts.
 *
 * The original bug: the copy of `processLine` in routes/edit.ts was missing
 * the `delta.tool_calls` and `delta.tool_result` branches that exist in
 * routes/chat.ts, so regenerating a message on a gateway HTTP provider lost
 * all tool-call activity.  This module is the single source of truth; these
 * tests verify that both paths (tool_call and tool_result) are exercised.
 *
 * @covers CHAT-REL-01, CHAT-REL-02
 *
 * CHAT-REL-01 (risposta vuota rilevata) e' coperto per intero. CHAT-REL-02
 * (propagazione dell'errore di stream) e' parziale: qui c'e' il lato consumer,
 * non la risalita fino alla bolla in chat.
 */

import { describe, expect, test, mock } from "bun:test";
import { makeGatewaySseProcessor } from "./gateway-sse-consumer";
import type { GatewaySseProcessorOpts } from "./gateway-sse-consumer";
import type { OutboundMessage } from "../../shared/ws-outbound";
import type { ToolCall } from "../../shared/types";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Build a ReadableStream that emits each string as a separate UTF-8 chunk. */
function makeStream(...frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

/** Build an SSE data line for a JSON payload. */
const dataLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const doneFrame = `data: [DONE]\n\n`;

/** Minimal opts for makeGatewaySseProcessor with all side-effects captured. */
function makeOpts(overrides?: Partial<GatewaySseProcessorOpts>): {
  opts: GatewaySseProcessorOpts;
  broadcast: ReturnType<typeof mock>;
  addToolCall: ReturnType<typeof mock>;
  updateToolResult: ReturnType<typeof mock>;
  onDoneCalled: { value: boolean };
  onStreamEndCalled: { value: boolean };
  contentRef: { value: string };
  extraFrames: string[];
  abortController: AbortController;
} {
  const broadcast = mock((_msg: OutboundMessage) => {});
  const addToolCall = mock((_sk: string, _tc: ToolCall) => null);
  const updateToolResult = mock((_sk: string, _id: string, _result: string) => null);
  const onDoneCalled = { value: false };
  const onStreamEndCalled = { value: false };
  const contentRef = { value: "" };
  const thinkingRef = { value: "" };
  const inThinkingRef = { value: false };
  const chunkCountRef = { value: 0 };
  const extraFrames: string[] = [];
  const abortController = new AbortController();

  const opts: GatewaySseProcessorOpts = {
    sessionKey: "test-session",
    matchedTopic: undefined,
    partialMsgId: "msg-1",
    contentRef,
    thinkingRef,
    inThinkingRef,
    chunkCountRef,
    forwardToClient: async () => {},
    closeClient: async () => {},
    isClientDisconnected: () => false,
    encoder: new TextEncoder(),
    writeExtra: (p) => { extraFrames.push(p); },
    broadcastToAll: broadcast,
    broadcastToTopicSubscribers: (_topicId, msg) => broadcast(msg),
    updateStreamContent: () => {},
    updateLastMessage: () => null,
    endStream: () => {},
    isStreaming: () => undefined,
    addToolCallToLastMessage: addToolCall,
    updateToolCallResult: updateToolResult,
    saveInterval: 1,
    onDone: (_msgId) => { onDoneCalled.value = true; },
    onStreamEnd: () => { onStreamEndCalled.value = true; },
    logTag: "[Test]",
    abortController,
    ...overrides,
  };

  return { opts, broadcast, addToolCall, updateToolResult, onDoneCalled, onStreamEndCalled, contentRef, extraFrames, abortController };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("makeGatewaySseProcessor — processLine", () => {
  test("content delta accumulates in contentRef and fires content_chunk", () => {
    const { opts, broadcast, contentRef } = makeOpts();
    const { processLine } = makeGatewaySseProcessor(opts);

    processLine(dataLine({ choices: [{ index: 0, delta: { content: "Hello" } }] }).trimEnd());
    processLine(dataLine({ choices: [{ index: 0, delta: { content: " world" } }] }).trimEnd());

    expect(contentRef.value).toBe("Hello world");
    const types = (broadcast.mock.calls as [OutboundMessage][]).map(([m]) => m.type);
    expect(types.filter(t => t === "stream:content_chunk").length).toBe(2);
  });

  test("tool_call delta calls addToolCallToLastMessage and writes extra SSE frame", () => {
    const { opts, addToolCall, extraFrames } = makeOpts();
    const { processLine } = makeGatewaySseProcessor(opts);

    const toolCallFrame = {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            id: "tc-1",
            function: { name: "bash", arguments: JSON.stringify({ cmd: "ls" }) },
          }],
        },
      }],
    };
    processLine(`data: ${JSON.stringify(toolCallFrame)}`);

    expect(addToolCall.mock.calls.length).toBe(1);
    const [sk, tc] = addToolCall.mock.calls[0] as [string, ToolCall];
    expect(sk).toBe("test-session");
    expect(tc.id).toBe("tc-1");
    expect(tc.name).toBe("bash");
    expect(tc.status).toBe("running");

    // Extra SSE frame forwarded to HTTP client
    expect(extraFrames.length).toBe(1);
    expect(extraFrames[0]).toContain("tool_calls");
  });

  test("tool_result delta calls updateToolCallResult and writes extra SSE frame", () => {
    const { opts, updateToolResult, extraFrames } = makeOpts();
    const { processLine } = makeGatewaySseProcessor(opts);

    const toolResultFrame = {
      choices: [{
        index: 0,
        delta: {
          tool_result: { id: "tc-1", status: "success", result: "ok output" },
        },
      }],
    };
    processLine(`data: ${JSON.stringify(toolResultFrame)}`);

    expect(updateToolResult.mock.calls.length).toBe(1);
    const [sk, id, result] = updateToolResult.mock.calls[0] as [string, string, string];
    expect(sk).toBe("test-session");
    expect(id).toBe("tc-1");
    expect(result).toBe("ok output");

    // Extra SSE frame forwarded to HTTP client
    expect(extraFrames.length).toBe(1);
    expect(extraFrames[0]).toContain("tool_result");
  });

  test("[DONE] calls onDone and invokes updateLastMessage + endStream", () => {
    const updateLastMessage = mock((_sk: string, _u: object) => null);
    const endStream = mock((_sk: string) => {});
    const { opts, onDoneCalled } = makeOpts({ updateLastMessage, endStream });
    const { processLine } = makeGatewaySseProcessor(opts);

    // Put some content first
    processLine(dataLine({ choices: [{ index: 0, delta: { content: "Hi" } }] }).trimEnd());
    processLine("data: [DONE]");

    expect(updateLastMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(endStream.mock.calls.length).toBe(1);
    expect(onDoneCalled.value).toBe(true);
  });

  test("[DONE] with empty content surfaces the error string", () => {
    const updateLastMessage = mock((_sk: string, _u: object) => null);
    const endStream = mock((_sk: string) => {});
    const { opts, contentRef } = makeOpts({ updateLastMessage, endStream });
    const { processLine } = makeGatewaySseProcessor(opts);

    processLine("data: [DONE]");

    // contentRef gets the error message
    expect(contentRef.value).toContain("No response received");
  });

  test("non-data lines are silently ignored", () => {
    const { opts, broadcast } = makeOpts();
    const { processLine } = makeGatewaySseProcessor(opts);

    processLine("event: ping");
    processLine(": comment");
    processLine("");

    expect(broadcast.mock.calls.length).toBe(0);
  });

  test("malformed JSON is silently ignored", () => {
    const { opts, broadcast } = makeOpts();
    const { processLine } = makeGatewaySseProcessor(opts);

    processLine("data: {not valid json}");

    expect(broadcast.mock.calls.length).toBe(0);
  });
});

describe("makeGatewaySseProcessor — consumeGateway", () => {
  test("full stream: content + tool_call + tool_result + [DONE]", async () => {
    const { opts, addToolCall, updateToolResult, onDoneCalled } = makeOpts();
    const { consumeGateway } = makeGatewaySseProcessor(opts);

    const stream = makeStream(
      dataLine({ choices: [{ index: 0, delta: { content: "Thinking..." } }] }),
      dataLine({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              id: "tc-42",
              function: { name: "read_file", arguments: JSON.stringify({ path: "/tmp/x" }) },
            }],
          },
        }],
      }),
      dataLine({
        choices: [{
          index: 0,
          delta: { tool_result: { id: "tc-42", status: "success", result: "file content" } },
        }],
      }),
      doneFrame,
    );

    await consumeGateway(stream);

    expect(addToolCall.mock.calls.length).toBe(1);
    expect((addToolCall.mock.calls[0] as [string, ToolCall])[1].name).toBe("read_file");
    expect(updateToolResult.mock.calls.length).toBe(1);
    expect((updateToolResult.mock.calls[0] as [string, string, string])[2]).toBe("file content");
    expect(onDoneCalled.value).toBe(true);
  });

  test("abrupt stream end triggers onStreamEnd (not onDone)", async () => {
    const isStreamingFn = mock((_sk: string) => ({ id: "active" } as never));
    const { opts, onDoneCalled, onStreamEndCalled } = makeOpts({ isStreaming: isStreamingFn });
    const { consumeGateway } = makeGatewaySseProcessor(opts);

    // Stream closes without [DONE]
    const stream = makeStream(
      dataLine({ choices: [{ index: 0, delta: { content: "partial" } }] }),
      // No [DONE] — stream just ends
    );

    await consumeGateway(stream);

    expect(onDoneCalled.value).toBe(false);
    expect(onStreamEndCalled.value).toBe(true);
  });

  test("tool_call id defaults to 'tool-<timestamp>' when absent", () => {
    const { opts, addToolCall } = makeOpts();
    const { processLine } = makeGatewaySseProcessor(opts);

    // No `id` field in the tool_call
    const frame = {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            function: { name: "list_files", arguments: "{}" },
          }],
        },
      }],
    };
    processLine(`data: ${JSON.stringify(frame)}`);

    expect(addToolCall.mock.calls.length).toBe(1);
    const tc = (addToolCall.mock.calls[0] as [string, ToolCall])[1];
    expect(tc.id).toMatch(/^tool-\d+$/);
  });
});
