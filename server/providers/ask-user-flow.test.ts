/**
 * Integration test for the end-to-end ask-user-tool flow.
 *
 * Stubs the Claude Code subprocess so we don't actually spawn the CLI,
 * then drives the provider as if a real session were running. Validates:
 *
 *   1. A `tool_use` block named `AskUserQuestion` makes the provider
 *      register a pending input and fire `onUserInputRequired`.
 *   2. `resumeWithToolResponse` writes a `tool_result` line on the
 *      subprocess stdin in the exact stream-json shape the CLI accepts.
 *   3. Trying to resume a tool that isn't pending throws (the route
 *      handler relies on this to return 404).
 *   4. `abort()` drops all pending inputs so a stale resume can't
 *      sneak in after the user cancelled.
 *
 * The provider's spawn path is invasive (real `child_process.spawn`),
 * so we monkey-patch `processes.set` to inject a stub PersistentProcess
 * the same way the live spawn would. Side-stepping the spawn is
 * deliberate — we're testing the higher-level state machine, not the
 * CLI bootstrap.
 */

import { describe, expect, test } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";
import { SidechainTracker } from "./claude/sidechain-tracker";
import { beginAsk, hasPendingAsk } from "../lib/ask-user-bridge";
import type { StreamHandler } from "./types";
import type { UserInputSchema } from "../types";

// Minimal stub for `child_process.ChildProcess` — only the bits the
// provider actually touches. `stdin.write` records calls so we can
// assert the exact payload.
function makeStubProc() {
  const writes: string[] = [];
  const stub = {
    writes,
    stdin: {
      write(chunk: string) {
        writes.push(String(chunk));
        return true;
      },
      end() {},
    },
    kill() {},
    on() {},
    stdout: { on() {} },
    stderr: { on() {} },
  };
  return stub;
}

function makeProviderWithStubProcess(sessionKey: string) {
  // `binPath` was passed here but ClaudeCodeProviderConfig has never had such a
  // field and nothing ever read it — dead test data that only surfaced once the
  // *.test.ts files were pulled into the typecheck.
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const stub = makeStubProc();
  const pp: any = {
    proc: stub,
    readline: { on() {}, close() {} },
    // Mirrors the real SessionIO; writes go through stub.stdin so `stub.writes`
    // still captures the exact stream-json payload the test asserts on.
    io: {
      writeStdin: (data: string) => stub.stdin.write(data),
      signal: () => {},
      kill: () => {},
    },
    ready: Promise.resolve(),
    sessionKey,
    consumedOffset: 0,
    stderrBuf: "",
    spawnMeta: { claudeSessionId: "test-session", isNewSession: false },
    createdAt: Date.now(),
    lastActivity: Date.now(),
    alive: true,
    streamHandler: null,
    pendingResolve: null,
    pendingReject: null,
    fullText: "",
    activeToolCalls: new Set(),
    inactivityTimer: null,
    lifetimeTimer: null,
    heartbeatInterval: null,
    subAgentEmit: new Map(),
    lastEventAt: Date.now(),
    needsHistoryReplay: false,
    sidechain: new SidechainTracker(),
    pendingInputs: new Map(),
  };
  // Reach into the private map via cast — `findSessionKeyForProcess`
  // iterates it during detection so the lookup has to succeed.
  (provider as any).processes.set(sessionKey, pp);
  return { provider, pp, stub };
}

function makeHandler() {
  const events: any[] = [];
  const handler: StreamHandler = {
    onTextDelta: (text, full) => events.push({ kind: "text", text, full }),
    onToolStart: (id, name, args) => events.push({ kind: "tool_start", id, name, args }),
    onToolResult: (id, result, isError) => events.push({ kind: "tool_result", id, result, isError }),
    onUserInputRequired: (id, name, schema) =>
      events.push({ kind: "user_input_required", id, name, schema }),
    onDone: () => events.push({ kind: "done" }),
    onError: (err) => events.push({ kind: "error", err }),
  };
  return { handler, events };
}

describe("claude-code provider · ask-user-tool flow", () => {
  test("AskUserQuestion tool_use → fires onUserInputRequired + populates pendingInputs", () => {
    const sessionKey = "topic:abc";
    const { provider, pp } = makeProviderWithStubProcess(sessionKey);
    const { handler, events } = makeHandler();
    pp.streamHandler = handler;

    // Mimic the CLI emitting an `assistant` stream-json event with the
    // tool_use block we care about.
    const event = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_xyz",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Which color?",
                  header: "Color",
                  options: [{ label: "Red" }, { label: "Blue" }],
                },
              ],
            },
          },
        ],
      },
    };
    (provider as any).handleStreamEvent(pp, event);

    const userInput = events.find((e) => e.kind === "user_input_required");
    expect(userInput).toBeDefined();
    expect(userInput.id).toBe("toolu_xyz");
    expect(userInput.name).toBe("AskUserQuestion");
    expect((userInput.schema as UserInputSchema).kind).toBe("questions");

    expect(pp.pendingInputs.has("toolu_xyz")).toBe(true);
    expect(pp.pendingInputs.get("toolu_xyz").sessionKey).toBe(sessionKey);
  });

  test("resumeWithToolResponse writes a stream-json tool_result on stdin and clears pendingInputs", async () => {
    const sessionKey = "topic:abc";
    const { provider, pp, stub } = makeProviderWithStubProcess(sessionKey);
    pp.pendingInputs.set("toolu_xyz", {
      sessionKey,
      schema: { kind: "questions", questions: [] },
      awaitingSince: Date.now(),
    });

    await provider.resumeWithToolResponse(sessionKey, "toolu_xyz", {
      kind: "questions",
      answers: { "Which color?": "Red" },
      submittedAt: "2026-05-11T00:00:00Z",
    });

    expect(stub.writes.length).toBe(1);
    const written = JSON.parse(stub.writes[0].trim());
    expect(written).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_xyz",
            content: [{ type: "text", text: JSON.stringify({ answers: { "Which color?": "Red" } }) }],
            is_error: false,
          },
        ],
      },
    });
    expect(pp.pendingInputs.has("toolu_xyz")).toBe(false);
  });

  test("resumeWithToolResponse with raw response writes the verbatim text", async () => {
    const sessionKey = "topic:abc";
    const { provider, pp, stub } = makeProviderWithStubProcess(sessionKey);
    pp.pendingInputs.set("toolu_raw", {
      sessionKey,
      schema: { kind: "raw", rawInput: null },
      awaitingSince: Date.now(),
    });

    await provider.resumeWithToolResponse(sessionKey, "toolu_raw", {
      kind: "raw",
      text: "hello world",
      submittedAt: "2026-05-11T00:00:00Z",
    });

    const written = JSON.parse(stub.writes[0].trim());
    expect(written.message.content[0].content[0].text).toBe("hello world");
  });

  test("resumeWithToolResponse throws when no pending input matches (route returns 404)", async () => {
    const sessionKey = "topic:abc";
    const { provider } = makeProviderWithStubProcess(sessionKey);

    await expect(
      provider.resumeWithToolResponse(sessionKey, "unknown_id", {
        kind: "raw",
        text: "x",
        submittedAt: "2026-05-11T00:00:00Z",
      }),
    ).rejects.toThrow(/no pending input/);
  });

  test("resumeWithToolResponse throws when the process is dead (caller fails the tool)", async () => {
    const sessionKey = "topic:abc";
    const { provider, pp } = makeProviderWithStubProcess(sessionKey);
    pp.alive = false;
    pp.pendingInputs.set("toolu_dead", {
      sessionKey,
      schema: { kind: "raw", rawInput: null },
      awaitingSince: Date.now(),
    });

    await expect(
      provider.resumeWithToolResponse(sessionKey, "toolu_dead", {
        kind: "raw",
        text: "x",
        submittedAt: "2026-05-11T00:00:00Z",
      }),
    ).rejects.toThrow(/no live process/);
  });

  test("il tool_result della domanda chiude l'ask anche quando è un ERRORE", () => {
    // Il caso vero: il client MCP ha mollato la chiamata dopo mezz'ora («nessuna
    // risposta né progress per 1800s») e il risultato è arrivato come errore.
    // Nessuno aveva risposto, quindi `deliverAnswer` — che di solito chiude
    // l'ask — non è mai passato di qui: il bridge continuava a giurare che una
    // domanda fosse a schermo per un pannello che non esisteva più. E quella
    // bugia è tossica, perché sia il watchdog del turno sia lo sweeper degli
    // stream fermi si fanno da parte proprio davanti a un ask pendente.
    const sessionKey = "topic:ask-morto";
    const { provider, pp } = makeProviderWithStubProcess(sessionKey);
    const { handler } = makeHandler();
    pp.streamHandler = handler;

    beginAsk(sessionKey);
    (provider as any).handleStreamEvent(pp, {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "toolu_ask",
          name: "mcp__topics__ask_user_question",
          input: { questions: [{ question: "Quale?", header: "H", options: [{ label: "A" }] }] },
        }],
      },
    });
    expect(pp.pendingInputs.has("toolu_ask")).toBe(true);
    expect(hasPendingAsk(sessionKey)).toBe(true);

    (provider as any).handleStreamEvent(pp, {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_ask",
          is_error: true,
          content: "ask_user_question: no response and no progress for 1800s",
        }],
      },
    });

    expect(pp.pendingInputs.has("toolu_ask")).toBe(false);
    expect(hasPendingAsk(sessionKey)).toBe(false);
  });

  test("abort() clears pendingInputs so a late resume after cancel can't sneak in", async () => {
    const sessionKey = "topic:abc";
    const { provider, pp } = makeProviderWithStubProcess(sessionKey);
    pp.pendingInputs.set("toolu_late", {
      sessionKey,
      schema: { kind: "raw", rawInput: null },
      awaitingSince: Date.now(),
    });

    await provider.abort(sessionKey, undefined, "user");

    expect(pp.pendingInputs.size).toBe(0);
    await expect(
      provider.resumeWithToolResponse(sessionKey, "toolu_late", {
        kind: "raw",
        text: "x",
        submittedAt: "2026-05-11T00:00:00Z",
      }),
    ).rejects.toThrow(/no pending input/);
  });
});
