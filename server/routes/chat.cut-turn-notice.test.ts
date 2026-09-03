/**
 * A TURN CUT BY THE OUTPUT CAP ENDS ON THE `done` LEG, AND MUST SAY SO THERE.
 *
 * The native loop exits a `max_tokens` round through `onDone` (agent-loop.ts
 * sends only `end === "error"` to `onError`), and `finalizeStream` wrote the
 * cut-turn notice only on `aborted`. So the notice shipped on 2026-08-28 for
 * topic:4c935add was unreachable: three times out of three the prose stopped
 * mid-sentence with no explanation, and only the tool half of that fix
 * (`toolOutcomeAtTurnEnd`) actually reached the screen.
 *
 * Proven on the real `POST /api/chat` with a fake provider driven from the
 * handler, and read back from the real DB: the wording itself is pinned by
 * `lib/cancelled-notice.test.ts`, here the question is whether it ARRIVES.
 * @covers CHAT-REL-02
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, Topic } from "../types";

const ROOT = testTmpDir("chat-cut-turn-notice");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

/** The route's soft inactivity timeout, as armed in `routes/chat.ts`. */
const STREAM_TIMEOUT_MS = 60_000;

interface Harness {
  ctx: AppContext;
  /** Every frame the route broadcast, in order. */
  frames: Array<Record<string, unknown>>;
  /** Send a first message on a fresh topic and return the route's StreamHandler. */
  startTurn: (sessionKey: string) => Promise<StreamHandler>;
  /** The assistant rows of a session, as the DB holds them. */
  assistantRows: (sessionKey: string) => Array<{ content: string; partial: boolean; blocks: Array<{ kind: string; text?: string }> }>;
}

async function harness(): Promise<Harness> {
  const ctx = await createTestAppContext();
  const frames: Array<Record<string, unknown>> = [];
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => { frames.push(m as Record<string, unknown>); };
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
    .broadcastToTopicSubscribers = (_id, m) => { frames.push(m as Record<string, unknown>); };

  let captured: StreamHandler | undefined;
  const provider = {
    name: "fake-stream",
    capabilities: new Set(["streaming"]),
    contextStrategy: "history-aware",
    get connected() { return true; },
    registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { captured = h; },
    unregisterStreamHandler: () => {},
    // Stays pending: the turn is driven from the handler, the way a real
    // provider drives it from inside its own loop.
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
    WORKSPACE_DIR: testTmpDir("chat-cut-turn-notice-ws"),
  } as never);

  const startTurn = async (sessionKey: string): Promise<StreamHandler> => {
    const topic: Topic = {
      id: `t-${sessionKey}`, name: "cut", slug: "cut", parentId: null, links: [],
      sessionKey, color: "#5865f2", icon: "MessageSquare",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      archived: false, provider: "openai",
    } as Topic;
    ctx.saveSingleTopic(topic);

    captured = undefined;
    const url = new URL("http://topics.test/api/chat");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "write the whole document" }] }),
    });
    const resp = await chatRouter(req, url, "/api/chat", "POST");
    expect(resp?.status).toBe(200);
    // Do NOT read the SSE body: draining it would block until `[DONE]`.
    resp?.body?.cancel().catch(() => {});
    if (!captured) throw new Error("the route registered no StreamHandler");
    return captured;
  };

  const assistantRows = (sessionKey: string) =>
    ctx.loadLocalMessages(sessionKey)
      .filter((m) => m.role === "assistant")
      .map((m) => ({ content: m.content, partial: m.partial === true, blocks: (m.blocks ?? []) as Array<{ kind: string; text?: string }> }));

  return { ctx, frames, startTurn, assistantRows };
}

/** The finalization is asynchronous (writes, then closes the SSE). */
const settle = () => Bun.sleep(80);

describe("a turn cut by the output cap says so on the done leg", () => {
  test("prose stopped mid-sentence: the prose stays, the notice goes in the blocks and on the wire", async () => {
    const h = await harness();
    const sk = "topic:cut-with-prose";
    const handler = await h.startTurn(sk);

    handler.onTextDelta("Ecco la prima metà del documento, che continua con", "Ecco la prima metà del documento, che continua con");
    // Exactly what the native loop delivers when the round stops on the cap.
    handler.onDone({ result: "Ecco la prima metà del documento, che continua con", turnEnd: { end: "max_tokens" } });
    await settle();

    const rows = h.assistantRows(sk);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.partial).toBe(false);
    // Whoever wrote prose keeps it: the verdict is carried by the block.
    expect(row.content).toBe("Ecco la prima metà del documento, che continua con");
    const notice = row.blocks.find((b) => b.kind === "error");
    expect(notice?.text).toContain("Risposta tagliata");
    // Something had arrived, so the tail asks for the rest a piece at a time
    // and does not send the person to a retry that would hit the same cap.
    expect(notice?.text).toContain("un pezzo alla volta");
    expect(notice?.text).not.toContain("Riprova");

    const wire = h.frames.find((f) => f.type === "stream:error");
    expect(String(wire?.error)).toContain("Risposta tagliata");
  });

  test("the whole cap spent on thinking: ONE notice, the cut one, not \"Nessuna risposta\"", async () => {
    const h = await harness();
    const sk = "topic:cut-no-prose";
    const handler = await h.startTurn(sk);

    handler.onDone({ result: "", turnEnd: { end: "max_tokens" } });
    await settle();

    const row = h.assistantRows(sk)[0]!;
    expect(row.partial).toBe(false);
    // The row has no text of its own, so the notice is also the text.
    expect(row.content).toContain("Risposta tagliata");
    const errors = row.blocks.filter((b) => b.kind === "error");
    expect(errors.length).toBe(1);
    expect(errors[0]!.text).toContain("Risposta tagliata");
    // A retry resends the same message into the same cap: wrong advice, and
    // the empty-turn notice that gives it must not be written on top.
    expect(row.content).not.toContain("Nessuna risposta");
    expect(row.content).not.toContain("Riprova");
  });

  test("a turn that finished normally keeps no notice at all", async () => {
    const h = await harness();
    const sk = "topic:cut-control";
    const handler = await h.startTurn(sk);

    handler.onTextDelta("Fatto.", "Fatto.");
    handler.onDone({ result: "Fatto.", turnEnd: { end: "end_turn" } });
    await settle();

    const row = h.assistantRows(sk)[0]!;
    expect(row.content).toBe("Fatto.");
    expect(row.blocks.some((b) => b.kind === "error")).toBe(false);
    expect(h.frames.some((f) => f.type === "stream:error")).toBe(false);
  });
});

