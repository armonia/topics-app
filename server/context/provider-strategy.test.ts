/**
 * Tests for `getProviderStrategy()` — the resolver that picks how to adapt
 * a `ContextEnvelope` for a specific provider.
 *
 * One test per real provider verifies the declared strategy matches what
 * the design contract promises. A final synthetic-provider test covers the
 * fallback path (no `contextStrategy` declared).
  * @covers CTX-STRAT-01
 */

import { describe, expect, it } from "bun:test";
import type { AIProvider, ChatMessage, CompletionResult, ProviderCapability, StreamHandler } from "../providers/types";
import { ClaudeProvider } from "../providers/claude";
import { OpenAIProvider } from "../providers/openai";
import { CodexProvider } from "../providers/codex";
import { ClaudeCodeProvider } from "../providers/claude-code";
import { OpenClawProvider } from "../providers/openclaw";
import { getProviderStrategy } from "./provider-strategy";

describe("getProviderStrategy", () => {
  it("claude is history-aware", () => {
    const p = new ClaudeProvider({ type: "claude", apiKey: "test" });
    expect(getProviderStrategy(p)).toBe("history-aware");
  });

  it("openai is history-aware", () => {
    const p = new OpenAIProvider({ type: "openai", apiKey: "test" });
    expect(getProviderStrategy(p)).toBe("history-aware");
  });

  it("codex is history-aware", () => {
    const p = new CodexProvider({ type: "codex" });
    expect(getProviderStrategy(p)).toBe("history-aware");
  });

  it("claude-code is inline-system", () => {
    const p = new ClaudeCodeProvider({ type: "claude-code" });
    expect(getProviderStrategy(p)).toBe("inline-system");
  });

  it("openclaw is gateway-stateful", () => {
    const p = new OpenClawProvider({
      type: "openclaw",
      gatewayUrl: "ws://localhost:1234",
      token: "test",
    });
    expect(getProviderStrategy(p)).toBe("gateway-stateful");
  });

  // ── Fallback path ────────────────────────────────────────────────────────
  // A synthetic provider that does NOT declare `contextStrategy` should fall
  // back to history-aware iff `capabilities.has("history")`, otherwise
  // inline-system. This guards the legacy / third-party provider case.

  function syntheticProvider(caps: ProviderCapability[]): AIProvider {
    return {
      name: "synthetic",
      capabilities: new Set(caps),
      // contextStrategy intentionally omitted
      get connected() { return false; },
      start() {},
      stop() {},
      async sendChat(_s, _m, _h, _o) { return { runId: undefined }; },
      async complete(_messages: ChatMessage[]): Promise<CompletionResult> {
        return { content: "" };
      },
    } as AIProvider;
  }

  it("fallback: history capability → history-aware", () => {
    const p = syntheticProvider(["streaming", "history"]);
    expect(getProviderStrategy(p)).toBe("history-aware");
  });

  it("fallback: no history capability → inline-system", () => {
    const p = syntheticProvider(["streaming", "tools"]);
    expect(getProviderStrategy(p)).toBe("inline-system");
  });

  it("fallback never returns gateway-stateful (gateway must opt-in explicitly)", () => {
    // Even if a synthetic provider has every other capability, omitting the
    // explicit declaration MUST NOT promote it to gateway-stateful — that
    // signals different inspector messaging which the user opts into.
    const p = syntheticProvider(["streaming", "history", "tools", "context", "sessions"]);
    expect(getProviderStrategy(p)).toBe("history-aware");
    expect(getProviderStrategy(p)).not.toBe("gateway-stateful");
  });

  // Suppress unused-locals for handler-shaped `_h` etc. in the synthetic factory.
  it("type sanity: StreamHandler is referenced", () => {
    const _: StreamHandler = {
      onTextDelta: () => {},
      onToolStart: () => {},
      onToolResult: () => {},
      onDone: () => {},
      onError: () => {},
    };
    expect(typeof _).toBe("object");
  });
});
