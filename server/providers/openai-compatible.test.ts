/**
 * A configured endpoint, from the request it sends to the words it uses when
 * the far end says no.
 *
 * @covers MP-DIRECT-01
 * @covers MP-DIRECT-03
 */
import { afterEach, describe, expect, test } from "bun:test";
import { OpenAICompatibleProvider, describeContextOverflow } from "./openai-compatible";
import { validateDirectEndpoint, type DirectEndpointConfig } from "../../shared/direct-endpoints";
import type { StreamHandler } from "./types";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function endpoint(overrides: Record<string, unknown> = {}): DirectEndpointConfig {
  const result = validateDirectEndpoint({
    label: "Local llama",
    baseUrl: "http://127.0.0.1:18080/v1",
    ...overrides,
  });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

interface Collected {
  text: string;
  errors: string[];
  done: number;
  aborted: number;
  usage: { inputTokens: number; outputTokens: number }[];
  windows: (number | undefined)[];
}

function collector(): { handler: StreamHandler; seen: Collected } {
  const seen: Collected = { text: "", errors: [], done: 0, aborted: 0, usage: [], windows: [] };
  const handler: StreamHandler = {
    onTextDelta: (delta) => { seen.text += delta; },
    onToolStart: () => { /* not used here */ },
    onToolResult: () => { /* not used here */ },
    onCallUsage: (usage) => { seen.usage.push({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }); },
    onContextSize: (_tokens, _model, window) => { seen.windows.push(window); },
    onDone: () => { seen.done += 1; },
    onAborted: () => { seen.aborted += 1; },
    onError: (error) => { seen.errors.push(error); },
  };
  return { handler, seen };
}

describe("a configured endpoint streaming a chat", () => {
  test("sends the model, asks for usage, and reports both text and tokens", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(
        sseStream([
          JSON.stringify({ choices: [{ delta: { content: "ci" } }] }),
          JSON.stringify({ choices: [{ delta: { content: "ao" }, finish_reason: "stop" }] }),
          JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } }),
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider({
      type: "openai-compatible",
      endpoint: endpoint({ modelFilter: ["qwen38-27b-200k"], contextWindows: { "qwen38-27b-200k": 200_192 } }),
    });
    provider.start();
    const { handler, seen } = collector();
    await provider.sendChat("session-a", "ciao", handler);

    expect(seen.text).toBe("ciao");
    expect(seen.done).toBe(1);
    expect(seen.errors).toEqual([]);
    expect(seen.usage).toEqual([{ inputTokens: 11, outputTokens: 3 }]);
    expect(seen.windows).toEqual([200_192]);
    expect(requests[0].url).toBe("http://127.0.0.1:18080/v1/chat/completions");
    const body = JSON.parse(String(requests[0].init.body));
    expect(body.model).toBe("qwen38-27b-200k");
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(requests[0].init.headers).not.toHaveProperty("Authorization");
  });

  test("the usage request is left out when the endpoint rejects the field", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(sseStream([JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })]), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider({
      type: "openai-compatible",
      endpoint: endpoint({ includeUsage: false, modelFilter: ["m"] }),
    });
    provider.start();
    await provider.sendChat("s", "hi", collector().handler);
    expect(body.stream_options).toBeUndefined();
  });

  test("a bearer token travels in the header and never in the body", async () => {
    let headers: Record<string, string> = {};
    let body = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      body = String(init.body);
      return new Response(sseStream([JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })]), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider({
      type: "openai-compatible",
      endpoint: endpoint({ auth: "bearer", modelFilter: ["m"] }),
      token: "tok-secret",
    });
    provider.start();
    await provider.sendChat("s", "hi", collector().handler);
    expect(headers.Authorization).toBe("Bearer tok-secret");
    expect(body).not.toContain("tok-secret");
  });

  test("aborting a session stops its turn and reports it as an abort, not an error", async () => {
    let requestSent: () => void = () => {};
    const sent = new Promise<void>((resolve) => { requestSent = resolve; });
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
      if (init.signal?.aborted) throw abortError();
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(abortError()));
        requestSent();
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider({
      type: "openai-compatible",
      endpoint: endpoint({ modelFilter: ["m"] }),
    });
    provider.start();
    const { handler, seen } = collector();
    const turn = provider.sendChat("session-a", "hi", handler);
    await sent;
    await provider.abort("session-a");
    await turn;
    expect(seen.aborted).toBe(1);
    expect(seen.errors).toEqual([]);
  });

  test("an unreachable address is refused before a body is sent", async () => {
    let called = 0;
    globalThis.fetch = (async () => { called += 1; return new Response("", { status: 200 }); }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      type: "openai-compatible",
      endpoint: endpoint({ baseUrl: "http://169.254.169.254/v1", modelFilter: ["m"] }),
    });
    provider.start();
    const { handler, seen } = collector();
    await provider.sendChat("s", "hi", handler);
    expect(called).toBe(0);
    expect(seen.errors.length).toBe(1);
  });

  test("a refusal names the endpoint the user configured", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      type: "openai-compatible",
      endpoint: endpoint({ modelFilter: ["m"] }),
    });
    provider.start();
    const { handler, seen } = collector();
    await provider.sendChat("s", "hi", handler);
    expect(seen.errors[0]).toContain("Local llama");
  });
});

describe("the model catalog", () => {
  test("the window the endpoint reports beats any table", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [{ id: "qwen38-27b-200k", meta: { n_ctx: 200_192 } }, { id: "other" }],
    }), { status: 200 })) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider({ type: "openai-compatible", endpoint: endpoint() });
    provider.start();
    expect(await provider.listModels()).toEqual(["qwen38-27b-200k", "other"]);
    expect(provider.contextWindowFor("qwen38-27b-200k")).toBe(200_192);
    expect(provider.contextWindows()).toEqual({ "qwen38-27b-200k": 200_192 });
  });

  test("the configured allow-list filters what the endpoint offers", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [{ id: "keep" }, { id: "drop" }],
    }), { status: 200 })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      type: "openai-compatible",
      endpoint: endpoint({ modelFilter: ["keep"] }),
    });
    provider.start();
    expect(await provider.listModels()).toEqual(["keep"]);
  });

  test("an endpoint that is asleep is unavailable, with a sentence that says so", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({ type: "openai-compatible", endpoint: endpoint() });
    provider.start();
    const diagnostic = await provider.diagnose();
    expect(diagnostic.status).toBe("unavailable");
    expect(diagnostic.lastError).toContain("Local llama");
  });
});

describe("describeContextOverflow", () => {
  test("a context refusal becomes a sentence with the number in it", () => {
    const message = describeContextOverflow(
      "the request exceeds the available context size",
      "qwen38-27b-200k",
      200_192,
    );
    expect(message).toContain("200,192");
    expect(message).toContain("qwen38-27b-200k");
  });

  test("an unrelated failure is left alone", () => {
    expect(describeContextOverflow("model not found", "m", 1000)).toBeUndefined();
  });
});
