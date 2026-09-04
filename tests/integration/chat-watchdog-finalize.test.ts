/**
 * WHAT THE WATCHDOG LEAVES BEHIND, on the row and on the wire.
 *
 * A turn whose child died is closed by the grace watchdog, not by
 * `finalizeStream`. It repaired the database and said nothing: `endStream`
 * RETURNS the tool calls it cancelled, and that list is the only event able to
 * switch off a panel already drawn. Thrown away, the spinner on an open client
 * keeps spinning and a question or permission prompt stays clickable on a turn
 * that is over and whose human hold has already been released. Only a reload
 * fixed it, which is exactly the gesture nobody makes while watching an agent
 * work (card 6c2dc14c).
 *
 * The second half of the same finalization is the TAIL of the answer: blocks
 * are persisted every ten chunks, so a turn cut at the fifteenth delta must
 * still carry all fifteen in the column the client draws.
 *
 * The real route is driven, with the silence windows shrunk by env so the two
 * minutes of wall clock the watchdog normally needs become milliseconds.
 *
 * @covers CHAT-01
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { createChatRouter } from "../../server/routes/chat";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { AppContext, Topic } from "../../server/types";

const TEST_DATA = testTmpDir("chat-watchdog-data");
beforeAll(() => setupTestDataDir(TEST_DATA));

const PREVIOUS_SOFT = process.env.TOPICS_STREAM_SOFT_MS;
const PREVIOUS_GRACE = process.env.TOPICS_STREAM_GRACE_MS;
process.env.TOPICS_STREAM_SOFT_MS = "60";
process.env.TOPICS_STREAM_GRACE_MS = "60";
afterAll(() => {
  if (PREVIOUS_SOFT === undefined) delete process.env.TOPICS_STREAM_SOFT_MS;
  else process.env.TOPICS_STREAM_SOFT_MS = PREVIOUS_SOFT;
  if (PREVIOUS_GRACE === undefined) delete process.env.TOPICS_STREAM_GRACE_MS;
  else process.env.TOPICS_STREAM_GRACE_MS = PREVIOUS_GRACE;
});

interface WireMessage { type: string; toolCallId?: string; status?: string; [k: string]: unknown }

interface Harness {
  ctx: AppContext;
  startTurn: () => Promise<StreamHandler>;
  sent: WireMessage[];
  row: () => { content: string; blocksText: string; toolStatuses: string[] };
}

async function harness(sessionKey: string): Promise<Harness> {
  const ctx = await createTestAppContext();
  const sent: WireMessage[] = [];

  const topic: Topic = {
    id: `t-${sessionKey}`, name: "watchdog", slug: "watchdog", parentId: null, links: [],
    sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "openai",
  } as Topic;
  ctx.saveSingleTopic(topic);

  (ctx as { broadcastToAll: (m: unknown) => void })
    .broadcastToAll = (m) => { sent.push(m as WireMessage); };
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
    .broadcastToTopicSubscribers = (_id, m) => { sent.push(m as WireMessage); };

  let captured: StreamHandler | undefined;
  const provider = {
    name: "fake-stream",
    // `tool-phases`: the provider can tell "announced" from "executing", so a
    // tool the model only WROTE does not suspend the silence timer. It is the
    // shape of the native runtime, and the one where the watchdog can fire on
    // a turn that has an open tool call.
    capabilities: new Set(["streaming", "tool-phases"]),
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
    WORKSPACE_DIR: testTmpDir("chat-watchdog-ws"),
  } as never);

  const startTurn = async (): Promise<StreamHandler> => {
    const url = new URL("http://topics.test/api/chat");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "scrivi qualcosa" }] }),
    });
    const resp = await chatRouter(req, url, "/api/chat", "POST");
    expect(resp?.status).toBe(200);
    resp?.body?.cancel().catch(() => {});
    if (!captured) throw new Error("la route non ha registrato nessuno StreamHandler");
    return captured;
  };

  const row = () => {
    const messages = ctx.loadLocalMessages(sessionKey);
    const assistant = messages.filter((m) => m.role === "assistant").pop();
    if (!assistant) throw new Error("nessuna riga assistente");
    const blocksText = (assistant.blocks ?? [])
      .map((b) => (b.kind === "text" ? b.text : ""))
      .join("");
    const toolStatuses = (assistant.blocks ?? [])
      .filter((b) => b.kind === "tool")
      .map((b) => (b as { toolCall: { status: string } }).toolCall.status);
    return { content: assistant.content, blocksText, toolStatuses };
  };

  return { ctx, startTurn, sent, row };
}

/** Fifteen deltas: five past the last periodic save (SAVE_INTERVAL = 10). */
const DELTAS = Array.from({ length: 15 }, (_, i) => `d${i + 1} `);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("il watchdog chiude il turno: cosa arriva a chi sta guardando", () => {
  test("il tool aperto viene annunciato, non solo riparato in silenzio", async () => {
    const h = await harness("topic:watchdog-announce");
    const handler = await h.startTurn();

    let cumulato = "";
    for (const d of DELTAS) { cumulato += d; handler.onTextDelta(d, cumulato); }
    handler.onToolStart("toolu_open", "Bash", { command: "sleep 999" } as never);

    // Soft (60 ms) + grace (60 ms), con margine: il figlio non parla piu' e
    // nessuno dichiara il processo vivo, quindi il watchdog finalizza.
    await sleep(400);

    const results = h.sent.filter((m) => m.type === "stream:tool_result");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((m) => m.toolCallId === "toolu_open" && m.status === "error")).toBe(true);

    // E la riga concorda con l'annuncio: un solo verdetto, non due.
    expect(h.row().toolStatuses).toContain("error");
  });

  test("la coda della risposta resta: tutti e quindici i delta nei blocchi", async () => {
    const h = await harness("topic:watchdog-tail");
    const handler = await h.startTurn();

    let cumulato = "";
    for (const d of DELTAS) { cumulato += d; handler.onTextDelta(d, cumulato); }
    handler.onToolStart("toolu_open", "Bash", { command: "sleep 999" } as never);

    await sleep(400);

    const { blocksText } = h.row();
    for (const d of DELTAS) expect(blocksText).toContain(d);
  });
});
