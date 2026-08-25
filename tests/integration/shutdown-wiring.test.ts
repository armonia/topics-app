/**
 * IL CABLAGGIO, non la decisione.
 *
 * Due pezzi di questo lavoro erano provati SOLO come funzioni pure:
 * `abortLogTitle` (che titolo scrivere in `activity_log`) e la regola che
 * decide `survivesRestart`. Verdi entrambi — ma una funzione pura verde non
 * dice NIENTE su chi la chiama: il difetto del 20/08 non stava in una
 * decisione sbagliata, stava in una decisione giusta che nessuno prendeva.
 *
 * Il modo in cui questi due potrebbero rompersi in silenzio e' identico: il
 * chiamante smette di passare il titolo (e `logStreamAborted` ricade sul suo
 * default storico «stream aborted by user», cioe' la bugia di partenza), o
 * `startStream` smette di ricevere il flag (e il default `false` fa sembrare
 * ogni chat non riadottabile, che e' prudente ma inchioda il hot-reload). In
 * entrambi i casi i test delle funzioni pure resterebbero verdi.
 *
 * Qui si guida la route VERA e si legge il DB VERO.
  * @covers RT-01
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { createChatRouter } from "../../server/routes/chat";
import type { AppContext, Topic } from "../../server/types";
import type { AIProvider, StreamHandler } from "../../server/providers/types";

const TEST_DATA = testTmpDir("verifica-cablaggio");
beforeAll(() => setupTestDataDir(TEST_DATA));

async function harness(sessionKey: string, conReattach: boolean) {
  const ctx: AppContext = await createTestAppContext();
  (ctx as any).broadcastToAll = () => {};
  (ctx as any).broadcastToTopicSubscribers = () => {};
  const topic = {
    id: `t-${sessionKey}`, name: "x", slug: "x", parentId: null, links: [],
    sessionKey, color: "#fff", icon: "M",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "openai",
  } as Topic;
  ctx.saveSingleTopic(topic);

  let captured: StreamHandler | undefined;
  const provider = {
    name: "fake", capabilities: new Set(["streaming"]), contextStrategy: "history-aware",
    get connected() { return true; },
    registerStreamHandler: (_s: string, _r: string|undefined, h: StreamHandler) => { captured = h; },
    unregisterStreamHandler: () => {},
    sendChat: () => new Promise<{runId?:string}>(() => {}),
    defaultModel: () => "m", abort: async () => {}, start: () => {}, stop: () => {},
    complete: async () => ({ content: "" }),
    ...(conReattach ? { reattach: async () => "live" } : {}),
  } as unknown as AIProvider;

  const router = createChatRouter(ctx, {
    resolveProvider: () => provider, detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {},
    resolveProjectRef: () => null, getProjectIdForTopic: () => null, getWorkspaceProjects: () => [],
    autoBindProject: () => {}, watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: testTmpDir("vc-ws"),
  } as never);

  const url = new URL("http://t.test/api/chat");
  const resp = await router(new Request(url.toString(), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "ciao" }] }),
  }), url, "/api/chat", "POST");
  resp?.body?.cancel().catch(() => {});
  return { ctx, handler: captured! };
}

describe("cablaggio reale", () => {
  test("activity_log: dopo uno shutdown il titolo NON dice 'by user'", async () => {
    const { ctx, handler } = await harness("topic:log-shutdown", false);
    handler.onTextDelta("qualcosa", "qualcosa");
    handler.onAborted?.({ result: "qualcosa", turnEnd: { end: "cancelled", cause: "server-shutdown" } });
    await new Promise((r) => setTimeout(r, 60));
    const righe = (ctx as any).db.query(
      "select title from activity_log where session_key=? and category='stream'"
    ).all("topic:log-shutdown") as Array<{title:string}>;
    expect(righe.length).toBeGreaterThan(0);
    expect(righe.map(r=>r.title)).toContain("stream aborted by server shutdown");
    expect(righe.map(r=>r.title)).not.toContain("stream aborted by user");
  });

  test("activity_log: uno stop VERO dell'utente resta 'by user'", async () => {
    const { ctx, handler } = await harness("topic:log-user", false);
    handler.onTextDelta("x", "x");
    handler.onAborted?.({ result: "x", turnEnd: { end: "cancelled", cause: "user" } });
    await new Promise((r) => setTimeout(r, 60));
    const righe = (ctx as any).db.query(
      "select title from activity_log where session_key=? and category='stream'"
    ).all("topic:log-user") as Array<{title:string}>;
    expect(righe.map(r=>r.title)).toContain("stream aborted by user");
  });

  test("survivesRestart: la mappa lo registra dal provider, non a caso", async () => {
    const a = await harness("topic:cli-like", true);   // ha reattach
    const b = await harness("topic:nativo-like", false); // non ce l'ha
    const sa = (a.ctx as any).activeStreams.get("topic:cli-like");
    const sb = (b.ctx as any).activeStreams.get("topic:nativo-like");
    expect(sa?.survivesRestart).toBe(true);
    expect(sb?.survivesRestart).toBe(false);
  });
});
