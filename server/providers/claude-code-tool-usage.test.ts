/**
 * `StreamHandler.onToolUsage` — attribuire il consumo di token alla SINGOLA
 * azione (tool call), non solo al turno.
 *
 * Ogni evento `assistant` della CLI che annuncia un `tool_use` È la chiamata al
 * modello che ha deciso quell'azione: l'usage di quell'evento è il costo di
 * quell'azione. Questi test blindano le tre trappole:
 *   1) una chiamata → la sua azione (e la somma delle azioni ≤ totale del turno);
 *   2) gli eventi CLI sono cumulativi → un'azione già contata non si ri-attribuisce;
 *   3) le sotto-sessioni (sidechain) non gonfiano il conto del genitore.
 * @covers USAGE-14
 */

import { describe, expect, test } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";
import { SidechainTracker } from "./claude/sidechain-tracker";

function makeProviderWithStubProcess(sessionKey: string) {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const pp: any = {
    proc: { stdin: { write() { return true; }, end() {} }, kill() {}, on() {}, stdout: { on() {} }, stderr: { on() {} } },
    readline: { on() {}, close() {} },
    io: { writeStdin: () => {}, signal: () => {}, kill: () => {} },
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
  (provider as any).processes.set(sessionKey, pp);
  return { provider, pp };
}

type ToolUsage = { inputTokens: number; outputTokens: number; cacheRead: number; cacheCreation: number; cacheCreation1h: number; model?: string };

function makeHandler() {
  const perTool: Array<{ id: string; u: ToolUsage }> = [];
  const turn: ToolUsage[] = [];
  const started: string[] = [];
  return {
    perTool,
    turn,
    started,
    handler: {
      onTextDelta: () => {},
      onToolStart: (id: string) => started.push(id),
      onToolResult: () => {},
      onCallUsage: (u: ToolUsage) => turn.push(u),
      onToolUsage: (id: string, u: ToolUsage) => perTool.push({ id, u }),
      onDone: () => {},
      onError: () => {},
    },
  };
}

const emit = (provider: unknown, pp: unknown, event: unknown) =>
  (provider as any).handleStreamEvent(pp, event);

/** Somma un campo su tutte le attribuzioni per-azione. */
const sum = (rows: Array<{ u: ToolUsage }>, k: keyof ToolUsage) =>
  rows.reduce((a, r) => a + (r.u[k] as number), 0);

describe("claude-code · onToolUsage (attribuzione per-azione)", () => {
  test("due chiamate, ciascuna una tool call: ognuna riceve la SUA e la somma ≤ turno", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:tu1");
    const { handler, perTool, turn } = makeHandler();
    pp.streamHandler = handler;

    // Turno agentico: call 1 decide un Read, call 2 (contesto più grande dopo
    // il risultato) decide una Bash.
    emit(provider, pp, {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t_read", name: "Read", input: { file_path: "/big" } }],
        usage: { input_tokens: 1000, cache_read_input_tokens: 800, cache_creation_input_tokens: 100, output_tokens: 40 },
      },
    });
    emit(provider, pp, {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t_read", content: "…" }] },
    });
    emit(provider, pp, {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t_bash", name: "Bash", input: { command: "ls" } }],
        usage: { input_tokens: 5000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 12 },
      },
    });

    expect(perTool.map((r) => r.id)).toEqual(["t_read", "t_bash"]);
    // Ognuna eredita l'INTERO usage della sua chiamata (una sola azione → k=1).
    // `inputTokens` è il TOTALE letto: fresco + cacheRead + cacheCreation.
    expect(perTool[0].u.inputTokens).toBe(1000 + 800 + 100);
    expect(perTool[0].u.outputTokens).toBe(40);
    expect(perTool[1].u.inputTokens).toBe(5000 + 4000 + 500);

    // La somma delle azioni non supera il totale del turno (onCallUsage).
    const turnInput = turn.reduce((a, u) => a + u.inputTokens, 0);
    const turnOutput = turn.reduce((a, u) => a + u.outputTokens, 0);
    expect(sum(perTool, "inputTokens")).toBeLessThanOrEqual(turnInput);
    expect(sum(perTool, "outputTokens")).toBeLessThanOrEqual(turnOutput);
  });

  test("due tool_use nella STESSA chiamata: quota spartita in parti uguali, somma ≤ chiamata", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:tu2");
    const { handler, perTool, turn } = makeHandler();
    pp.streamHandler = handler;

    emit(provider, pp, {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "a", name: "Read", input: {} },
          { type: "tool_use", id: "b", name: "Read", input: {} },
        ],
        usage: { input_tokens: 1001, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 41 },
      },
    });

    expect(perTool.map((r) => r.id)).toEqual(["a", "b"]);
    // floor(1001/2)=500 ciascuna → somma 1000 ≤ 1001 (il troncamento tiene ≤).
    expect(perTool[0].u.inputTokens).toBe(500);
    expect(perTool[1].u.inputTokens).toBe(500);
    expect(sum(perTool, "inputTokens")).toBeLessThanOrEqual(turn[0].inputTokens);
    expect(sum(perTool, "outputTokens")).toBeLessThanOrEqual(turn[0].outputTokens);
  });

  test("evento cumulativo: un'azione già attribuita non ri-conta", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:tu3");
    const { handler, perTool } = makeHandler();
    pp.streamHandler = handler;

    // Snapshot 1: annuncia il Read.
    emit(provider, pp, {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
        usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 },
      },
    });
    // Snapshot 2 (cumulativo): riporta il vecchio Read PIÙ una nuova Bash.
    emit(provider, pp, {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "tool_use", id: "t2", name: "Bash", input: {} },
        ],
        usage: { input_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 20 },
      },
    });

    // t1 attribuito UNA sola volta (dallo snapshot 1); t2 dallo snapshot 2.
    expect(perTool.map((r) => r.id)).toEqual(["t1", "t2"]);
    expect(perTool.filter((r) => r.id === "t1").length).toBe(1);
    // t2 non eredita il costo di t1: il divisore dello snapshot 2 conta solo
    // l'azione NUOVA (t1 era già attribuito), quindi t2 prende l'intero 200.
    expect(perTool[1].u.inputTokens).toBe(200);
  });

  test("sotto-sessione (sidechain): il tool_use del figlio NON è attribuito al genitore", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:tu4");
    const { handler, perTool } = makeHandler();
    pp.streamHandler = handler;

    // Evento del figlio: porta usage e un tool_use, ma con parent_tool_use_id.
    emit(provider, pp, {
      type: "assistant",
      parent_tool_use_id: "toolu_parent",
      message: {
        content: [{ type: "tool_use", id: "child_tool", name: "Grep", input: {} }],
        usage: { input_tokens: 9999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 },
      },
    });

    expect(perTool).toEqual([]);
  });

  test("chiamata di solo testo (nessun tool_use): niente attribuzione", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:tu5");
    const { handler, perTool, turn } = makeHandler();
    pp.streamHandler = handler;

    emit(provider, pp, {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "solo testo" }],
        usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 },
      },
    });

    expect(perTool).toEqual([]);
    // Il costo resta comunque nel totale del turno.
    expect(turn.length).toBe(1);
  });
});
