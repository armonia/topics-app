/** @covers MP-API-01, APPSET-01, CHAT-DEF-03 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { OpenAIProvider } from "./openai";
import type { StreamHandler } from "./types";

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
const SETTINGS_ENV = ["OPENAI_MODEL", "OPENAI_MAX_TOKENS"] as const;
let savedSettings: Partial<Record<typeof SETTINGS_ENV[number], string | undefined>>;

// Bun's fetch includes a static preconnect method. Keep the full callable
// type while every network operation remains inert inside these tests.
function mockFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch {
  return Object.assign(handler, { preconnect: () => {} });
}

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockFetch(async () => { throw new Error("Unexpected fetch in OpenAI test"); }));
  savedSettings = {};
  for (const key of SETTINGS_ENV) {
    savedSettings[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  fetchSpy.mockRestore();
  for (const key of SETTINGS_ENV) {
    if (savedSettings[key] === undefined) delete process.env[key];
    else process.env[key] = savedSettings[key];
  }
});

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const finish = frame({ choices: [{ delta: {}, finish_reason: "stop" }] });
const done = "data: [DONE]\n\n";
const delta = (content: string) => frame({ choices: [{ delta: { content } }] });
const sse = (text = `${delta("Ready")}${finish}${done}`) => new Response(text, { headers: { "Content-Type": "text/event-stream" } });
const modelResponse = (ids: unknown[]) => Response.json({ data: ids.map((id) => ({ id })) });
const provider = () => new OpenAIProvider({ type: "openai", apiKey: "test-key" });

function observer() {
  const text: string[] = [];
  const tools: { id: string; name: string; args: unknown }[] = [];
  const errors: string[] = [];
  let completed = 0;
  let aborted = 0;
  const handler: StreamHandler = {
    onTextDelta: (_chunk, full) => { text.push(full); },
    onToolStart: (id, name, args) => { tools.push({ id, name, args }); },
    onToolResult: () => {},
    onDone: () => { completed++; },
    onError: (error) => { errors.push(error); },
    onAborted: () => { aborted++; },
  };
  return { handler, text, tools, errors, get completed() { return completed; }, get aborted() { return aborted; } };
}

describe("OpenAI request configuration", () => {
  test("preserves the existing default and uses completion token limits on every request path", async () => {
    const requests: Record<string, unknown>[] = [];
    fetchSpy.mockImplementation(mockFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      return body.stream ? sse() : Response.json({ choices: [{ message: { content: "Ready" } }] });
    }));
    const p = provider();
    expect(p.defaultModel()).toBe("gpt-4o");
    await p.sendChat("first", "Hello", observer().handler);
    process.env.OPENAI_MODEL = "o3-mini";
    process.env.OPENAI_MAX_TOKENS = "2048";
    expect(p.defaultModel()).toBe("o3-mini");
    await p.sendChat("first", "Next", observer().handler);
    await (await p.streamHTTP([{ role: "user", content: "Hello" }])).text();
    await p.complete([{ role: "user", content: "Hello" }]);
    expect(requests.map((request) => request.model)).toEqual(["gpt-4o", "o3-mini", "o3-mini", "o3-mini"]);
    expect(requests.map((request) => request.max_completion_tokens)).toEqual([8192, 2048, 2048, 2048]);
    expect(requests.every((request) => !("max_tokens" in request))).toBe(true);
    delete process.env.OPENAI_MODEL;
    delete process.env.OPENAI_MAX_TOKENS;
    expect(p.defaultModel()).toBe("gpt-4o");
  });

  test("per-request model and history remain isolated from other sessions and completions", async () => {
    const requests: Record<string, unknown>[] = [];
    fetchSpy.mockImplementation(mockFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      return body.stream ? sse() : Response.json({ choices: [{ message: { content: "Named" } }], usage: { prompt_tokens: 7, completion_tokens: 2 } });
    }));
    const p = provider();
    process.env.OPENAI_MODEL = "gpt-4o-mini";
    await Promise.all([
      p.sendChat("A", "A only", observer().handler, { model: "o3", history: [{ role: "system", content: "A context" }] }),
      p.sendChat("B", "B only", observer().handler),
    ]);
    const result = await p.complete([{ role: "user", content: "Name" }], { model: "gpt-4-turbo" });
    await p.sendChat("C", "C only", observer().handler);
    expect(requests.map((request) => request.model)).toEqual(["o3", "gpt-4o-mini", "gpt-4-turbo", "gpt-4o-mini"]);
    expect(requests[0].messages).toEqual([{ role: "system", content: "A context" }, { role: "user", content: "A only" }]);
    expect(requests[1].messages).toEqual([{ role: "user", content: "B only" }]);
    expect(result).toEqual({ content: "Named", usage: { promptTokens: 7, completionTokens: 2 } });
    expect(p.defaultModel()).toBe("gpt-4o-mini");
  });

  test("key rotation leaves active streams running and abort remains scoped to one session", async () => {
    const streams: { controller: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal; auth: string | null }[] = [];
    fetchSpy.mockImplementation(mockFetch(async (_url, init) => {
      const signal = init!.signal!;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        streams.push({ controller, signal, auth: new Headers(init?.headers).get("Authorization") });
        signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      } }));
    }));
    const p = provider();
    p.start();
    const a = observer(); const b = observer(); const c = observer();
    const first = p.sendChat("A", "one", a.handler);
    const second = p.sendChat("B", "two", b.handler);
    p.updateConfig({ type: "openai", apiKey: "replacement-key" });
    expect(p.connected).toBe(true);
    expect(streams.every((stream) => !stream.signal.aborted)).toBe(true);
    const third = p.sendChat("C", "three", c.handler);
    expect(streams.map((stream) => stream.auth)).toEqual(["Bearer test-key", "Bearer test-key", "Bearer replacement-key"]);
    await p.abort("A");
    expect(streams.map((stream) => stream.signal.aborted)).toEqual([true, false, false]);
    for (const stream of streams.slice(1)) {
      stream.controller.enqueue(new TextEncoder().encode(`${delta("Ready")}${finish}${done}`));
      stream.controller.close();
    }
    await Promise.all([first, second, third]);
    expect(a.aborted).toBe(1);
    expect(a.completed).toBe(0);
    expect(b.completed).toBe(1);
    expect(c.completed).toBe(1);
  });
});

describe("OpenAI model discovery", () => {
  test("diagnosis and picker share a filtered singleflight request and refresh after expiry", async () => {
    let resolveProbe!: (response: Response) => void;
    fetchSpy.mockImplementation(mockFetch(() => new Promise((resolve) => { resolveProbe = resolve; })));
    const now = spyOn(Date, "now").mockReturnValue(1000);
    try {
      const p = provider();
      const diagnostic = p.diagnose();
      const models = p.listModels();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      resolveProbe(modelResponse(["gpt-4o", "o3", "o3", "gpt-4o-mini", "gpt-image-1", "gpt-4o-audio-preview",
        "gpt-realtime", "gpt-4o-transcribe", "gpt-4o-mini-tts", "gpt-5-codex", "gpt-5-pro", "gpt-3.5-turbo-instruct",
        "o3-pro-2025-06-10", "o3-deep-research", "text-embedding-3-large", null, 42]));
      expect(await models).toEqual(["gpt-4o", "gpt-4o-mini", "o3"]);
      expect(await diagnostic).toMatchObject({ status: "ready", modelsCount: 3 });
      const copy = await p.listModels(); copy.push("local-change");
      expect(await p.listModels()).not.toContain("local-change");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      now.mockReturnValue(31_001);
      const refreshed = p.listModels();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      resolveProbe(modelResponse(["gpt-4o-mini"]));
      expect(await refreshed).toEqual(["gpt-4o-mini"]);
    } finally { now.mockRestore(); }
  });

  test("an old key's pending probe cannot overwrite a replacement key's modelResponse", async () => {
    const responses: ((response: Response) => void)[] = [];
    fetchSpy.mockImplementation(mockFetch(() => new Promise((resolve) => { responses.push(resolve); })));
    const p = provider();
    const old = p.listModels();
    p.updateConfig({ type: "openai", apiKey: "replacement-key" });
    const current = p.listModels();
    responses[1](modelResponse(["gpt-4o-mini"]));
    expect(await current).toEqual(["gpt-4o-mini"]);
    responses[0](modelResponse(["gpt-4o"]));
    await old;
    expect(await p.listModels()).toEqual(["gpt-4o-mini"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("rejected credentials stay sanitized and transient failures are retried", async () => {
    const now = spyOn(Date, "now").mockReturnValue(1000);
    try {
      fetchSpy.mockResolvedValueOnce(new Response("do not expose replacement-key", { status: 401 }));
      const p = provider();
      const error = await p.diagnose();
      expect(error.status).toBe("error");
      expect(error.lastError).not.toContain("replacement-key");
      await p.listModels();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      now.mockReturnValue(6001);
      fetchSpy.mockResolvedValueOnce(modelResponse(["o3-mini"]));
      expect(await p.listModels()).toEqual(["o3-mini"]);
      expect((await p.diagnose()).status).toBe("ready");
    } finally { now.mockRestore(); }
  });
});

describe("OpenAI stream events", () => {
  test("reassembles fragmented UTF-8, SSE lines and tool arguments exactly once", async () => {
    const tool = (value: unknown) => frame({ choices: [{ delta: { tool_calls: [value] } }] });
    const text = `${delta("Caffè ☕")}${tool({ index: 0, id: "call-a" })}${tool({ index: 0, function: { name: "browser_", arguments: '{"url":' } })}${tool({ index: 0, function: { name: "navigate", arguments: '"https://example.test"}' } })}${frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}${done}`.replaceAll("\n", "\r\n");
    const bytes = new TextEncoder().encode(text);
    fetchSpy.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
      controller.close();
    } })));
    const output = observer();
    await provider().sendChat("A", "Hello", output.handler);
    expect(output.text.at(-1)).toBe("Caffè ☕");
    expect(output.tools).toEqual([{ id: "call-a", name: "browser_navigate", args: { url: "https://example.test" } }]);
    expect(output.errors).toEqual([]);
    expect(output.completed).toBe(1);
  });

  test.each([
    `${delta("Partial")}${frame({ error: { code: "invalid_api_key", message: "secret-key must not appear" } })}${done}`,
    `${delta("Partial")}data: {broken json}\n\n${done}`,
    delta("Truncated"),
  ])("stream failures never become silent successful responses", async (text) => {
    fetchSpy.mockResolvedValueOnce(sse(text));
    const output = observer();
    await provider().sendChat("A", "Hello", output.handler);
    expect(output.completed).toBe(0);
    expect(output.errors).toHaveLength(1);
    expect(output.errors[0]).not.toContain("secret-key");
  });

  test("processes a final event without a trailing newline", async () => {
    fetchSpy.mockResolvedValueOnce(sse(`${delta("Ready")}data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`));
    const output = observer();
    await provider().sendChat("A", "Hello", output.handler);
    expect(output.text).toEqual(["Ready"]);
    expect(output.completed).toBe(1);
    expect(output.errors).toEqual([]);
  });
});
