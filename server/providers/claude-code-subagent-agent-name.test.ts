/**
 * Il sotto-agente si chiama `Agent`, non piu' solo `Task`.
 *
 * La CLI ha rinominato il tool: il provider registrava il genitore della
 * sidechain (e ne riempiva `description`/`subagent_type`) solo per `Task`.
 * Con `Agent` il genitore nasceva come segnaposto vuoto dal ramo sidechain e
 * l'input vero non arrivava mai: misurato sulla topic cd85be85, 45 righe di
 * sotto-agente su 45 senza descrizione.
 */
import { describe, test, expect } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";
import { SidechainTracker, isSubAgentToolName } from "./claude/sidechain-tracker";

function streamEvent(event: Record<string, unknown>) {
  return { type: "stream_event", event };
}

function ppStub() {
  return {
    sidechain: new SidechainTracker(),
    activeToolCalls: new Set<string>(),
    pendingInputs: new Map(),
  } as Record<string, any>;
}

describe("sotto-agente: Task e Agent sono lo stesso tool", () => {
  test("isSubAgentToolName riconosce entrambi i nomi", () => {
    expect(isSubAgentToolName("Task")).toBe(true);
    expect(isSubAgentToolName("Agent")).toBe(true);
    expect(isSubAgentToolName("Bash")).toBe(false);
  });

  for (const name of ["Task", "Agent"]) {
    test(`${name}: l'annuncio parziale registra il genitore e lo stop ne riempie la descrizione`, () => {
      const provider = new ClaudeCodeProvider({ type: "claude-code" });
      const pp = ppStub();
      const partial = (ev: Record<string, unknown>) => (provider as any).handlePartialStreamEvent(pp, streamEvent(ev), null);
      partial({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_sub", name } });
      expect(pp.sidechain.has("toolu_sub")).toBe(true);
      partial({
        type: "content_block_delta", index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ description: "cerca i bug", subagent_type: "Explore", prompt: "x" }) },
      });
      partial({ type: "content_block_stop", index: 0 });
      const snap = pp.sidechain.snapshot("toolu_sub");
      expect(snap?.description).toBe("cerca i bug");
      expect(snap?.subAgentType).toBe("Explore");
    });
  }
});
