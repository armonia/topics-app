/** @covers MP-API-01 */
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

test("AICTRL-01: ON + a non-routable pinned provider blocks the send with the typed reason, before persistence, provider/model untouched", async () => {
  let appended = 0;
  const codex = { name: "codex", connected: true };
  const registry = {
    getProvider: (name: string) => (name === "codex" ? codex : (() => { throw new Error("not registered"); })()),
    getDefaultProvider: () => codex,
  };
  const topic = { id: "t1", provider: "codex", model: "gpt-5-codex", topicsRouting: true };
  const ctx = {
    json: (data: unknown, status = 200) => Response.json(data, { status }),
    readJSON: (request: Request) => request.json(),
    getTopicBySessionKey: () => topic,
    isStreaming: () => undefined,
    appendLocalMessage: () => { appended++; },
  } as unknown as AppContext;
  const router = createChatRouter(ctx, {
    resolveProvider: (t: typeof topic) => resolveTopicProvider(t, registry as any),
    browserNavigatedTopics: new Set(), WORKSPACE_DIR: "/tmp",
  } as unknown as Parameters<typeof createChatRouter>[1]);
  const url = new URL("http://topics.test/api/chat");
  const response = await router(new Request(url, {
    method: "POST", body: JSON.stringify({ sessionKey: "topic:t1", messages: [{ role: "user", content: "test" }] }),
  }), url, url.pathname, "POST");
  // The typed error crosses the HTTP boundary with a stable code, not the
  // generic provider_unavailable 503 this route also returns.
  expect(response?.status).toBe(409);
  const payload = await response!.json();
  expect(payload).toMatchObject({ code: "topics_routing_incompatible", provider: "codex" });
  expect(typeof payload.error).toBe("string");
  expect(payload.error.length).toBeGreaterThan(0);
  // Blocked before the turn was recorded, and the pinned choice is untouched.
  expect(appended).toBe(0);
  expect(topic.provider).toBe("codex");
  expect(topic.model).toBe("gpt-5-codex");
  expect(topic.topicsRouting).toBe(true);
});

/**
 * AICTRL-01: lo switch vale anche quando il provider arriva col body, non solo quando e' pinnato sul topic. allow-italian: la regola che il file difende
 * Il ramo con override saltava il resolver e dispacciava diretto dal registry: con lo switch acceso bastava un override per messaggio per eseguire fuori dal motore nativo, senza blocco e senza motivo. allow-italian: nomina la porta laterale chiusa qui
 * @covers AICTRL-01
 */
test("AICTRL-01b: l'override provider per messaggio passa dal resolver con lo switch del topic, mai diretto", async () => {
  let appended = 0;
  const codex = { name: "codex", connected: true };
  const claudeCode = { name: "claude-code", connected: true };
  const native = { name: "topics", connected: true };
  const topic = { id: "t1", provider: "claude-code", model: "claude-opus-5", topicsRouting: true };
  const ctx = {
    json: (data: unknown, status = 200) => Response.json(data, { status }),
    readJSON: (request: Request) => request.json(),
    getTopicBySessionKey: () => topic,
    isStreaming: () => undefined,
    appendLocalMessage: () => { appended++; },
  } as unknown as AppContext;
  const resolve = routingResolver({ codex, "claude-code": claudeCode, topics: native }, ["claude-opus-5"]);
  const router = createChatRouter(ctx, {
    resolveProvider: resolve as never,
    // Se l'handler usa ancora questa scorciatoia il test fallisce qui: nessuna porta scavalca lo switch. allow-italian: dice perche' il finto esplode invece di rispondere
    resolveProviderByName: (name: string) => { throw new Error(`bypass del resolver per "${name}"`); },
    browserNavigatedTopics: new Set(), WORKSPACE_DIR: "/tmp",
  } as unknown as Parameters<typeof createChatRouter>[1]);
  const url = new URL("http://topics.test/api/chat");
  const response = await router(new Request(url, {
    method: "POST",
    body: JSON.stringify({ sessionKey: "topic:t1", provider: "codex", messages: [{ role: "user", content: "test" }] }),
  }), url, url.pathname, "POST");

  expect(response?.status).toBe(409);
  expect(await response!.json()).toMatchObject({ code: "topics_routing_incompatible", provider: "codex" });
  expect(appended).toBe(0);
  // Switch e scelta pinnata restano quelli: il turno e' bloccato, non riscritto. allow-italian: la differenza fra bloccare e riscrivere
  expect(topic.provider).toBe("claude-code");
  expect(topic.topicsRouting).toBe(true);
});

test("AICTRL-01c: anche il MODELLO per messaggio passa dal cancello, con lo switch acceso", async () => {
  let appended = 0;
  const claudeCode = { name: "claude-code", connected: true };
  const native = { name: "topics", connected: true };
  const topic = { id: "t2", provider: "claude-code", model: "claude-opus-5", topicsRouting: true };
  const ctx = {
    json: (data: unknown, status = 200) => Response.json(data, { status }),
    readJSON: (request: Request) => request.json(),
    getTopicBySessionKey: () => topic,
    isStreaming: () => undefined,
    appendLocalMessage: () => { appended++; },
  } as unknown as AppContext;
  const router = createChatRouter(ctx, {
    // Il motore nativo serve SOLO opus: il modello di questo turno non e' instradabile e va detto adesso, non eseguito altrove. allow-italian: dice cosa rende rosso il caso
    resolveProvider: routingResolver({ "claude-code": claudeCode, topics: native }, ["claude-opus-5"]) as never,
    resolveProviderByName: (name: string) => { throw new Error(`bypass del resolver per "${name}"`); },
    browserNavigatedTopics: new Set(), WORKSPACE_DIR: "/tmp",
  } as unknown as Parameters<typeof createChatRouter>[1]);
  const url = new URL("http://topics.test/api/chat");
  const response = await router(new Request(url, {
    method: "POST",
    body: JSON.stringify({ sessionKey: "topic:t2", provider: "claude-code", model: "claude-sonnet-5", messages: [{ role: "user", content: "test" }] }),
  }), url, url.pathname, "POST");

  expect(response?.status).toBe(409);
  const payload = await response!.json();
  expect(payload.code).toBe("topics_routing_incompatible");
  expect(payload.error).toContain("claude-sonnet-5");
  expect(appended).toBe(0);
  // Il pin del topic non lo tocca l'override rifiutato. allow-italian: l'invariante dopo un rifiuto
  expect(topic.model).toBe("claude-opus-5");
});
