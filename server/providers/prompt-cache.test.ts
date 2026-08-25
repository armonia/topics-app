/**
 * applyPromptCache — i confini del prefisso stabile.
 *
 * Prima di questa change il server non marcava un solo `cache_control`: ogni
 * turno ripagava tools + system + conversazione a prezzo pieno invece di 0,1x.
 * Qui si fissa DOVE cadono i marker (l'ordine del prefisso è tools → system →
 * messages) e che non si sfondi mai il limite di quattro.
 *
 * @covers CHAT-CACHE-01
 *
 * SDK providers mark the stable prefix as cacheable.
 */
import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { MAX_CACHE_BREAKPOINTS, applyPromptCache, countCacheBreakpoints } from "./prompt-cache";

function params(over: Partial<Anthropic.MessageCreateParams> = {}): Anthropic.MessageCreateParams {
  return {
    model: "claude-sonnet-5",
    max_tokens: 1024,
    messages: over.messages ?? [{ role: "user", content: "ciao" }],
    ...over,
  } as Anthropic.MessageCreateParams;
}

const cc = (v: unknown) => (v as Record<string, unknown> | undefined)?.cache_control;

describe("system", () => {
  test("una stringa diventa un blocco di testo che porta il marker", () => {
    const p = params({ system: "sei un assistente" });
    applyPromptCache(p);
    expect(Array.isArray(p.system)).toBe(true);
    const blocks = p.system as Anthropic.TextBlockParam[];
    expect(blocks[0]!.text).toBe("sei un assistente");
    expect(cc(blocks[0])).toEqual({ type: "ephemeral" });
  });

  test("con più blocchi il marker cade sull'ULTIMO — è lì che finisce il prefisso", () => {
    const p = params({
      system: [
        { type: "text", text: "primo" },
        { type: "text", text: "secondo" },
      ] as Anthropic.TextBlockParam[],
    });
    applyPromptCache(p);
    const blocks = p.system as Anthropic.TextBlockParam[];
    expect(cc(blocks[0])).toBeUndefined();
    expect(cc(blocks[1])).toEqual({ type: "ephemeral" });
  });

  test("un system vuoto non viene marcato", () => {
    const p = params({ system: "" });
    applyPromptCache(p);
    expect(p.system).toBe("");
  });
});

describe("tools", () => {
  test("il marker cade sull'ultimo tool", () => {
    const p = params({
      tools: [
        { name: "a", description: "a", input_schema: { type: "object" } },
        { name: "b", description: "b", input_schema: { type: "object" } },
      ] as Anthropic.Tool[],
    });
    applyPromptCache(p);
    const tools = p.tools as Anthropic.Tool[];
    expect(cc(tools[0])).toBeUndefined();
    expect(cc(tools[1])).toEqual({ type: "ephemeral" });
  });

  test("senza tool non succede nulla", () => {
    const p = params({ tools: [] });
    applyPromptCache(p);
    expect(p.tools).toEqual([]);
  });
});

describe("messages", () => {
  test("l'ultimo messaggio chiude la conversazione cacheabile", () => {
    const p = params({
      messages: [
        { role: "user", content: "primo" },
        { role: "assistant", content: "risposta" },
        { role: "user", content: "secondo" },
      ],
    });
    applyPromptCache(p);
    expect(typeof p.messages[0]!.content).toBe("string");
    const last = p.messages[2]!.content as Anthropic.ContentBlockParam[];
    expect(Array.isArray(last)).toBe(true);
    expect(cc(last[0])).toEqual({ type: "ephemeral" });
  });

  test("un contenuto già a blocchi viene marcato sull'ultimo blocco", () => {
    const p = params({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "uno" },
            { type: "text", text: "due" },
          ],
        },
      ] as Anthropic.MessageParam[],
    });
    applyPromptCache(p);
    const blocks = p.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(cc(blocks[0])).toBeUndefined();
    expect(cc(blocks[1])).toEqual({ type: "ephemeral" });
  });
});

describe("limiti e invarianti", () => {
  test("con tutto presente restano al più quattro breakpoint", () => {
    const p = params({
      system: "preambolo",
      tools: [{ name: "a", description: "a", input_schema: { type: "object" } }] as Anthropic.Tool[],
      messages: [
        { role: "user", content: "primo" },
        { role: "assistant", content: "risposta" },
        { role: "user", content: "secondo" },
      ],
    });
    applyPromptCache(p);
    expect(countCacheBreakpoints(p)).toBe(3);
    expect(countCacheBreakpoints(p)).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
  });

  test("è idempotente: due passate non moltiplicano i marker", () => {
    const p = params({
      system: "preambolo",
      tools: [{ name: "a", description: "a", input_schema: { type: "object" } }] as Anthropic.Tool[],
    });
    applyPromptCache(p);
    const dopoUna = countCacheBreakpoints(p);
    applyPromptCache(p);
    expect(countCacheBreakpoints(p)).toBe(dopoUna);
  });

  test("senza nulla di stabile non marca nulla", () => {
    const p = params({ messages: [] });
    applyPromptCache(p);
    expect(countCacheBreakpoints(p)).toBe(0);
  });

  test("non tocca il testo: il contenuto resta quello che era", () => {
    const p = params({ system: "preambolo", messages: [{ role: "user", content: "ciao" }] });
    applyPromptCache(p);
    expect((p.system as Anthropic.TextBlockParam[])[0]!.text).toBe("preambolo");
    const last = p.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect((last[0] as Anthropic.TextBlockParam).text).toBe("ciao");
  });
});
