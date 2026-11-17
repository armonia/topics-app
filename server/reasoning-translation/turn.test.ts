/**
 * The per-turn side of the reasoning translation, and the route that serves a
 * settled block, with the service replaced by a fake at its own interface.
 */
import { describe, expect, test } from "bun:test";
import { createTurnReasoningTranslator } from "./turn";
import { createReasoningTranslationRouter } from "../routes/reasoning-translation";
import { ReasoningTranslationService, memoryTranslationStore } from "./service";
import type { ReasoningTranslator } from "./translator";
import type { AppContext } from "../types";

const translator: ReasoningTranslator = {
  name: "fake",
  available: async () => true,
  detect: async () => ({ language: "en", confidence: 0.99 }),
  pairReady: async () => true,
  translate: async (text) => `IT(${text})`,
};
const service = () => new ReasoningTranslationService({ translator, store: memoryTranslationStore(), resolveTarget: () => "it" });

const BLOCK_ONE = "First I need to read the failing test and see what it expects. Then I will check the file.";
const BLOCK_TWO = "After the tools ran I can compare the two outputs and write the answer for the person.";

describe("a turn with two reasoning blocks", () => {
  test("each block is decided and numbered on its own", async () => {
    const seen: Array<{ index: number; source: string }> = [];
    const svc = service();
    const turn = createTurnReasoningTranslator((s) => seen.push({ index: s.index, source: s.source }), () => svc);
    turn.delta(BLOCK_ONE);
    turn.end();
    turn.delta(BLOCK_TWO);
    turn.end();
    await new Promise((r) => setTimeout(r, 30));
    // Blocks run side by side, so only the numbering inside each block is fixed: the client
    // matches a frame by its source text, never by its place in the turn.
    expect(seen.filter((s) => s.source !== BLOCK_TWO).map((s) => s.index).sort()).toEqual([0, 1]);
    expect(seen.filter((s) => s.source === BLOCK_TWO).map((s) => s.index)).toEqual([0]);
  });

  test("a service that cannot be built never throws into the turn", () => {
    const turn = createTurnReasoningTranslator(() => {}, () => { throw new Error("no database"); });
    expect(() => { turn.delta(BLOCK_ONE); turn.end(); }).not.toThrow();
  });
});

describe("POST /api/reasoning/translate", () => {
  const ctx = { json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }) } as unknown as AppContext;
  const call = async (body: unknown, method = "POST", path = "/api/reasoning/translate") => {
    const router = createReasoningTranslationRouter(ctx, service);
    const req = new Request(`http://x${path}`, { method, body: JSON.stringify(body) });
    return router(req, new URL(req.url), path, method);
  };

  test("a settled block comes back as source and translation pairs", async () => {
    const res = (await call({ text: BLOCK_ONE }))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; target: string; sentences: Array<{ source: string; text: string }> };
    expect(body.available).toBe(true);
    expect(body.target).toBe("it");
    expect(body.sentences[0]).toEqual({ source: "First I need to read the failing test and see what it expects.", text: "IT(First I need to read the failing test and see what it expects.)" });
  });

  test("a body without text is refused, and other paths and methods fall through", async () => {
    expect((await call({ text: "" }))!.status).toBe(400);
    expect((await call({}))!.status).toBe(400);
    expect(await call({ text: BLOCK_ONE }, "GET")).toBeNull();
    expect(await call({ text: BLOCK_ONE }, "POST", "/api/other")).toBeNull();
  });
});
