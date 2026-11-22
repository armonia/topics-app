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
import { applyPromptCache } from "./prompt-cache";

// The API accepts at most four cache_control blocks per request.
const MAX_CACHE_MARKS = 4;

/** Counts the cache_control marks a payload carries, in tools, system and message blocks. */
function countCacheMarks(p: Anthropic.MessageCreateParams): number {
  let n = 0;
  const bump = (v: unknown) => {
    if (v && typeof v === "object" && (v as Record<string, unknown>).cache_control) n++;
  };
  if (Array.isArray(p.tools)) p.tools.forEach(bump);
  if (Array.isArray(p.system)) p.system.forEach(bump);
  for (const m of p.messages ?? []) if (Array.isArray(m.content)) m.content.forEach(bump);
  return n;
}

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
    expect(cc(blocks[0])).toEqual({ type: "ephemeral", ttl: "1h" });
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
    expect(cc(blocks[1])).toEqual({ type: "ephemeral", ttl: "1h" });
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
    expect(cc(tools[1])).toEqual({ type: "ephemeral", ttl: "1h" });
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
    expect(cc(last[0])).toEqual({ type: "ephemeral", ttl: "1h" });
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
    expect(cc(blocks[1])).toEqual({ type: "ephemeral", ttl: "1h" });
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
    expect(countCacheMarks(p)).toBe(3);
    expect(countCacheMarks(p)).toBeLessThanOrEqual(MAX_CACHE_MARKS);
  });

  test("è idempotente: due passate non moltiplicano i marker", () => {
    const p = params({
      system: "preambolo",
      tools: [{ name: "a", description: "a", input_schema: { type: "object" } }] as Anthropic.Tool[],
    });
    applyPromptCache(p);
    const dopoUna = countCacheMarks(p);
    applyPromptCache(p);
    expect(countCacheMarks(p)).toBe(dopoUna);
  });

  test("senza nulla di stabile non marca nulla", () => {
    const p = params({ messages: [] });
    applyPromptCache(p);
    expect(countCacheMarks(p)).toBe(0);
  });

  test("non tocca il testo: il contenuto resta quello che era", () => {
    const p = params({ system: "preambolo", messages: [{ role: "user", content: "ciao" }] });
    applyPromptCache(p);
    expect((p.system as Anthropic.TextBlockParam[])[0]!.text).toBe("preambolo");
    const last = p.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect((last[0] as Anthropic.TextBlockParam).text).toBe("ciao");
  });
});

describe("applyPromptCache, segni arrivati da fuori", () => {
  test("cinque segni già presenti diventano i tre suoi, mai oltre il tetto di quattro", () => {
    const e = { type: "ephemeral" as const };
    const params = {
      model: "m", max_tokens: 1,
      tools: [{ name: "a", input_schema: { type: "object" }, cache_control: e }, { name: "b", input_schema: { type: "object" } }],
      system: [{ type: "text", text: "uno", cache_control: e }, { type: "text", text: "due", cache_control: e }],
      messages: [
        { role: "user", content: [{ type: "text", text: "x", cache_control: e }] },
        { role: "assistant", content: [{ type: "text", text: "y", cache_control: e }] },
        { role: "user", content: [{ type: "text", text: "z" }] },
      ],
    } as never;
    applyPromptCache(params);
    const n = JSON.stringify(params).split('"cache_control"').length - 1;
    expect(n).toBe(3);
    expect(n).toBeLessThanOrEqual(MAX_CACHE_MARKS);
  });
});
