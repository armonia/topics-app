/**
 * La chiusura di un turno non deve riportare indietro la riga del topic.
 *
 * Difetto vero (card 76b0058b). Una chat chiede `open_project` a metà risposta:
 * la rotta scrive `project_path` sulla riga e manda il broadcast, la chat entra
 * nel progetto. Poi il turno finisce — anche venti minuti dopo — e
 * `finalizeTurnActivity` faceva `saveSingleTopic(matchedTopic)`, cioè un upsert
 * di TUTTE le colonne a partire dall'oggetto letto quando la richiesta era
 * arrivata. `projectPath` lì dentro era ancora vuoto: la chat si ritrovava
 * fuori dal progetto, senza un errore da nessuna parte e senza che nessuno
 * avesse toccato niente.
 *
 * Si guida la rotta VERA (`POST /api/chat`) con un provider finto: si parte, si
 * lega il topic al progetto mentre il turno è in volo, si chiude il turno.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { createChatRouter } from "../../server/routes/chat";
import { registerProvider, removeProvider } from "../../server/providers";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { Topic } from "../../server/types";

const TEST_DATA = testTmpDir("turn-end-topic-write");
beforeAll(() => setupTestDataDir(TEST_DATA));

registerProvider({ type: "openai", apiKey: "" } as never);
afterAll(() => { try { removeProvider("openai"); } catch { /* già tolto */ } });

describe("fine turno: il bump di attività non riscrive la riga intera", () => {
  test("un projectPath scritto a metà turno sopravvive alla chiusura del turno", async () => {
    const sessionKey = "topic:fine-turno";
    const ctx = await createTestAppContext();
    (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
    (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
      .broadcastToTopicSubscribers = () => {};

    const topic: Topic = {
      id: "t-fine-turno", name: "senza progetto", slug: "senza-progetto", parentId: null, links: [],
      sessionKey, color: "#5865f2", icon: "MessageSquare",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      archived: false, provider: "openai",
    } as Topic;
    ctx.saveSingleTopic(topic);

    let captured: StreamHandler | undefined;
    const provider = {
      name: "fake-stream",
      capabilities: new Set(["streaming"]),
      contextStrategy: "history-aware",
      get connected() { return true; },
      registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { captured = h; },
      unregisterStreamHandler: () => {},
      sendChat: () => new Promise<{ runId?: string }>(() => {}),
      defaultModel: () => "fake-model",
      abort: async () => {},
      start: () => {}, stop: () => {},
      complete: async () => ({ content: "" }),
    } as unknown as AIProvider;

    const chatRouter = createChatRouter(ctx, {
      resolveProvider: () => provider,
      detectLocalhostAutoNav: () => {},
      bindTopicToProject: () => {},
      resolveProjectRef: () => null,
      getProjectIdForTopic: () => null,
      getWorkspaceProjects: () => [],
      autoBindProject: () => {},
      watchSessionForSubagents: () => {},
      updateUnreadCount: () => {},
      browserNavigatedTopics: new Set<string>(),
      WORKSPACE_DIR: testTmpDir("turn-end-topic-write-ws"),
    } as never);

    const url = new URL("http://topics.test/api/chat");
    const resp = await chatRouter(
      new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "spostami nel progetto" }] }),
      }),
      url, "/api/chat", "POST",
    );
    expect(resp?.status).toBe(200);
    resp?.body?.cancel().catch(() => {});
    if (!captured) throw new Error("la route non ha registrato nessuno StreamHandler");

    // A METÀ TURNO: è quello che fa `bindTopicToProject` quando la chat chiede
    // open_project — legge la riga fresca, scrive, e basta.
    const fresh = ctx.getTopicById(topic.id)!;
    fresh.projectPath = "/tmp/un-progetto";
    ctx.saveSingleTopic(fresh);

    captured.onTextDelta("fatto", "fatto");
    captured.onDone();
    // La chiusura del turno passa da un `await` interno prima di scrivere.
    await new Promise((r) => setTimeout(r, 50));

    const dopo = ctx.getTopicById(topic.id)!;
    expect(dopo.projectPath).toBe("/tmp/un-progetto");
    // E il bump ha comunque fatto il suo lavoro.
    expect(dopo.updatedAt >= fresh.updatedAt).toBe(true);

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });
});
