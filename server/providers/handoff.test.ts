/**
 * The handoff a fresh CLI session receives.
 * @covers MP-HANDOFF-01
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ToolCall } from "../../shared/types";
import { configureNativeHistorySource, type PersistedTurn } from "./native/history-rehydrate";
import { estimateTokens } from "./native/compaction";
import { freshSessionPreamble, handoffFromStore, renderHandoff } from "./handoff";

const u = (content: string): PersistedTurn => ({ role: "user", content });
const tc = (over: Partial<ToolCall> & { id: string }): ToolCall => ({
  name: "stay_search", args: { place: "Barcelona" }, status: "success", ...over,
});

function useStore(thread: PersistedTurn[]): void {
  configureNativeHistorySource(() => thread);
}
afterEach(() => configureNativeHistorySource(null));

describe("handoff", () => {
  test("the tool calls and their results reach the new session", () => {
    // RED BEFORE: Codex and Muse received prose only, so a chat switched
    // provider after an hour of searches lost every page and price.
    useStore([
      u("trova un alloggio"),
      { role: "assistant", content: "Cerco.Trovati 3.", toolCalls: [
        tc({ id: "t1", result: "Aldara 172,96 € balcone fumo ok", contentOffset: 6 }),
      ] },
      u("e in centro?"),
    ]);
    const text = handoffFromStore("topic:x")!;
    expect(text).toContain("## User");
    expect(text).toContain("trova un alloggio");
    expect(text).toContain("tool `stay_search`");
    expect(text).toContain("\"place\":\"Barcelona\"");
    expect(text).toContain("result of `stay_search`");
    expect(text).toContain("Aldara 172,96 €");
    // The message about to be sent is not repeated in the handoff.
    expect(text).not.toContain("e in centro?");
  });

  test("a long history is cut by budget, keeps the opening request and says how to read the rest", () => {
    const thread: PersistedTurn[] = [u("la richiesta iniziale")];
    for (let i = 0; i < 300; i++) {
      thread.push({ role: "assistant", content: `giro ${i}`, toolCalls: [tc({ id: `t${i}`, result: "x".repeat(4_000), contentOffset: 0 })] });
      thread.push(u(`avanti ${i}`));
    }
    thread.push(u("messaggio nuovo"));
    useStore(thread);
    const budget = 20_000;
    const text = handoffFromStore("topic:x", { budgetTokens: budget })!;
    expect(estimateTokens([{ role: "user", content: text }])).toBeLessThanOrEqual(budget);
    expect(text).toContain("la richiesta iniziale");
    expect(text).toContain("avanti 299");
    expect(text).toMatch(/\d+ earlier messages are not shown|Older tool results are shortened/);
    expect(text).toContain("read_chat_messages");
    // compact's own notice is not repeated inside the first turn.
    expect(text).not.toContain("were removed to fit the context window");
  });

  test("without the store, the route's history is used, pinned context first", () => {
    const pre = freshSessionPreamble("topic:none", [
      { role: "system", content: "SOUL" },
      { role: "user", content: "ciao" },
      { role: "assistant", content: "ehi" },
    ]);
    expect(pre.startsWith("# Conversation so far\n\n## Context\n\nSOUL")).toBe(true);
    expect(pre).toContain("## User\n\nciao");
    expect(pre).toContain("## Assistant\n\nehi");
  });

  test("the store wins over the route's prose when it has the session", () => {
    useStore([u("dal db"), { role: "assistant", content: "ok" }, u("nuovo")]);
    const pre = freshSessionPreamble("topic:x", [{ role: "user", content: "dalla rotta" }]);
    expect(pre).toContain("dal db");
    expect(pre).not.toContain("dalla rotta");
  });

  test("the written text stays within budget even with hundreds of small tool calls", () => {
    // RED BEFORE: the budget was applied to the messages, and the text adds a
    // line per call. On the real chat (1,483 calls) 60k came out at ~84k.
    const thread: PersistedTurn[] = [u("inizio")];
    for (let i = 0; i < 400; i++) {
      thread.push({ role: "assistant", content: "", toolCalls: Array.from({ length: 4 }, (_, k) =>
        tc({ id: `t${i}-${k}`, args: { command: `ls -la /some/path/${i}/${k}` }, result: "ok ".repeat(40), contentOffset: 0 })) });
      thread.push(u(`passo ${i}`));
    }
    thread.push(u("nuovo"));
    useStore(thread);
    const budget = 10_000;
    const text = handoffFromStore("topic:x", { budgetTokens: budget })!;
    expect(estimateTokens([{ role: "user", content: text }])).toBeLessThanOrEqual(budget);
    expect(text).toContain("passo 399");
    expect(text).not.toContain("risultato rimosso");
  });

  test("a history that fits is handed over whole, with no notice", () => {
    useStore([u("breve"), { role: "assistant", content: "ok" }, u("nuovo")]);
    const text = handoffFromStore("topic:x")!;
    expect(text).not.toContain("not shown");
    expect(text).not.toContain("shortened");
  });

  test("nothing to hand over is an empty preamble", () => {
    expect(freshSessionPreamble("topic:none", [])).toBe("");
  });

  test("a row of tool results is not written as the person speaking", () => {
    const text = renderHandoff([
      { role: "user", content: "vai" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read_file", input: { path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "contenuto" }] },
    ]);
    expect(text.match(/## User/g)?.length).toBe(1);
    expect(text).toContain("result of `read_file`");
  });
});
