/** @covers MP-API-01, MSEL-06 */
import { expect, test } from "bun:test";
import { createChatRouter } from "./chat";
import { resolveTopicProvider } from "../providers/resolve-topic-provider";
import type { AppContext } from "../types";

/** Il registry vero, come lo monta la produzione (topic-provider-resolver). */
function routingResolver(known: Record<string, { name: string; connected: boolean }>, nativeModels?: string[]) {
  return (topic: unknown) => resolveTopicProvider(topic as never, {
    getProvider: (name: string) => {
      const found = known[name];
      if (!found) throw new Error(`not registered: ${name}`);
      return found as never;
    },
    getDefaultProvider: () => { throw new Error("must not select a default"); },
    getTopicsModels: () => nativeModels,
  });
}

test("an unavailable per-message provider is rejected before persistence or default routing", async () => {
  let appended = 0;
  let defaults = 0;
  const ctx = {
    json: (data: unknown, status = 200) => Response.json(data, { status }),
    readJSON: (request: Request) => request.json(),
    getTopicBySessionKey: () => null,
    isStreaming: () => undefined,
    appendLocalMessage: () => { appended++; },
  } as unknown as AppContext;
  const router = createChatRouter(ctx, {
    // L'override passa ORA dal resolver, quindi il finto si comporta come quello vero: nome sconosciuto esplode, il default non si tocca mai. allow-italian: dice perche' il finto e' severo
    resolveProvider: (topic?: unknown) => {
      if (!(topic as { provider?: string } | null)?.provider) { defaults++; throw new Error("must not select a default"); }
      throw new Error("not registered");
    },
    browserNavigatedTopics: new Set(), WORKSPACE_DIR: "/tmp",
  } as unknown as Parameters<typeof createChatRouter>[1]);
  const url = new URL("http://topics.test/api/chat");
  const response = await router(new Request(url, {
    method: "POST", body: JSON.stringify({ sessionKey: "topic:provider-choice-test", provider: "missing-gpt-provider", messages: [{ role: "user", content: "test" }] }),
  }), url, url.pathname, "POST");
  expect(response?.status).toBe(503);
  expect(await response!.json()).toMatchObject({ code: "provider_unavailable", provider: "missing-gpt-provider" });
  expect(appended).toBe(0);
  expect(defaults).toBe(0);
});

/** The resolver the route really calls, recording where it sent the turn and
 *  then stopping the route right there: what follows is the turn itself,
 *  which these tests do not run. The stop is a provider error, so the route
 *  answers 503, never the 409 of a refused switch. */
function recordingResolver(inner: (topic: unknown) => { name: string }) {
  const resolvedTo: string[] = [];
  return {
    resolvedTo,
    resolve: (topic: unknown) => {
      resolvedTo.push(inner(topic).name);
      throw new Error("stop after resolution");
    },
  };
}

function routeCtx(topic: unknown, counter: { appended: number }) {
  return {
    json: (data: unknown, status = 200) => Response.json(data, { status }),
    readJSON: (request: Request) => request.json(),
    getTopicBySessionKey: () => topic,
    isStreaming: () => undefined,
    appendLocalMessage: () => { counter.appended++; },
  } as unknown as AppContext;
}

async function send(router: ReturnType<typeof createChatRouter>, body: Record<string, unknown>) {
  const url = new URL("http://topics.test/api/chat");
  return router(new Request(url, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "test" }], ...body }) }), url, url.pathname, "POST");
}

test("MSEL-06: ON + a pinned Codex never blocks the send: the turn goes direct to Codex, provider/model untouched", async () => {
  const counter = { appended: 0 };
  const codex = { name: "codex", connected: true };
  const native = { name: "topics", connected: true };
  for (const topicsRouting of [true, null]) {
    const topic = { id: "t1", provider: "codex", model: "gpt-5-codex", topicsRouting };
    const rec = recordingResolver((t) => routingResolver({ codex, topics: native }, ["claude-opus-5"])(t));
    const router = createChatRouter(routeCtx(topic, counter), {
      resolveProvider: rec.resolve as never,
      browserNavigatedTopics: new Set(), WORKSPACE_DIR: "/tmp",
    } as unknown as Parameters<typeof createChatRouter>[1]);
    const response = await send(router, { sessionKey: "topic:t1" });
    expect(response?.status).not.toBe(409);
    expect(rec.resolvedTo).toEqual(["codex"]);
    expect(topic.provider).toBe("codex");
    expect(topic.model).toBe("gpt-5-codex");
    expect(topic.topicsRouting).toBe(topicsRouting);
  }
});

/**
 * AICTRL-01: lo switch vale anche quando il provider arriva col body, non solo quando e' pinnato sul topic. allow-italian: la regola che il file difende
 * MSEL-06: il resolver decide la strada anche per l'override; un bersaglio fuori dalla famiglia Claude va diretto, mai bloccato. allow-italian: il contratto nuovo
 * @covers AICTRL-01, MSEL-06
 */
test("AICTRL-01b: l'override provider per messaggio passa dal resolver con lo switch del topic: Codex va diretto", async () => {
  const counter = { appended: 0 };
  const codex = { name: "codex", connected: true };
  const claudeCode = { name: "claude-code", connected: true };
  const native = { name: "topics", connected: true };
  const topic = { id: "t1", provider: "claude-code", model: "claude-opus-5", topicsRouting: true };
  const rec = recordingResolver((t) => routingResolver({ codex, "claude-code": claudeCode, topics: native }, ["claude-opus-5"])(t));
  const router = createChatRouter(routeCtx(topic, counter), {
    resolveProvider: rec.resolve as never,
    // Se l'handler usa ancora questa scorciatoia il test fallisce qui: nessuna porta scavalca il resolver. allow-italian: dice perche' il finto esplode invece di rispondere
    resolveProviderByName: (name: string) => { throw new Error(`bypass del resolver per "${name}"`); },
    browserNavigatedTopics: new Set(), WORKSPACE_DIR: "/tmp",
  } as unknown as Parameters<typeof createChatRouter>[1]);
  const response = await send(router, { sessionKey: "topic:t1", provider: "codex" });
  expect(response?.status).not.toBe(409);
  expect(rec.resolvedTo).toEqual(["codex"]);
  // La scelta pinnata resta quella: l'override non riscrive il topic. allow-italian: l'invariante
  expect(topic.provider).toBe("claude-code");
  expect(topic.topicsRouting).toBe(true);
});

test("AICTRL-01c: anche il MODELLO per messaggio passa dal resolver: servito dal motore va sul motore, non servito va diretto", async () => {
  const counter = { appended: 0 };
  const claudeCode = { name: "claude-code", connected: true };
  const native = { name: "topics", connected: true };
  const topic = { id: "t2", provider: "claude-code", model: "claude-opus-5", topicsRouting: true };
  for (const [model, expected] of [["claude-sonnet-5", "claude-code"], ["claude-opus-5", "topics"]] as const) {
    const rec = recordingResolver((t) => routingResolver({ "claude-code": claudeCode, topics: native }, ["claude-opus-5"])(t));
    const router = createChatRouter(routeCtx(topic, counter), {
      resolveProvider: rec.resolve as never,
      resolveProviderByName: (name: string) => { throw new Error(`bypass del resolver per "${name}"`); },
      browserNavigatedTopics: new Set(), WORKSPACE_DIR: "/tmp",
    } as unknown as Parameters<typeof createChatRouter>[1]);
    const response = await send(router, { sessionKey: "topic:t2", provider: "claude-code", model });
    expect(response?.status).not.toBe(409);
    expect(rec.resolvedTo).toEqual([expected]);
  }
  expect(topic.model).toBe("claude-opus-5");
});

test("the legacy chat bound to the engine itself, engine down: the one 409 left, before persistence", async () => {
  const counter = { appended: 0 };
  const topic = { id: "t3", provider: "topics", model: "claude-opus-5", topicsRouting: null };
  const router = createChatRouter(routeCtx(topic, counter), {
    resolveProvider: routingResolver({ topics: { name: "topics", connected: false } }) as never,
    browserNavigatedTopics: new Set(), WORKSPACE_DIR: "/tmp",
  } as unknown as Parameters<typeof createChatRouter>[1]);
  const response = await send(router, { sessionKey: "topic:t3" });
  expect(response?.status).toBe(409);
  expect(await response!.json()).toMatchObject({ code: "topics_routing_incompatible", provider: "topics" });
  expect(counter.appended).toBe(0);
});
