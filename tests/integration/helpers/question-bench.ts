/**
 * THE BENCH OF THE QUESTION TESTS: the real chat, topics and permission routes
 * over a real database, and a model that records what it reads. Shared by
 * `question-waits-for-human.test.ts` and `question-answer-order.test.ts`.
 */
import { beforeAll, afterAll, afterEach, expect, setSystemTime } from "bun:test";
import { cleanupTestDataDir, setupTestDataDir, createTestAppContext, testTmpDir } from "./index";
import type { AppContext, Topic, ToolCall } from "../../../server/types";
import type { AIProvider, StreamHandler } from "../../../server/providers/types";
import { createTopicsRouter } from "../../../server/routes/topics";
import { createChatRouter } from "../../../server/routes/chat";
import { decodeCol } from "../../../shared/message-blob";
import { createPermissionRouter } from "../../../server/routes/permission";
import { _dropAskStateLikeARestart } from "../../../server/lib/ask-user-bridge";
import type { AnswerRelay, Carry } from "../../../server/lib/answer-relay";

/** The app context of the running file, set by `useQuestionBench`. */
export let ctx: AppContext;

/**
 * THE MODEL, as far as this bench goes: a provider that records every message
 * a turn hands it and never answers (the turn is closed by hand). What
 * `sendChat` receives is exactly what the model would read.
 */
export const modelReceived: Array<{ sessionKey: string; message: string; options?: SendOptions }> = [];
/** What the route hands the provider with the message (history, the rows the message spans...). */
type SendOptions = Parameters<AIProvider["sendChat"]>[3];
export const handlers: StreamHandler[] = [];
const fakeModel = {
  name: "fake-model",
  capabilities: new Set(["streaming"]),
  contextStrategy: "history-aware",
  get connected() { return modelConnected; },
  registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { handlers.push(h); },
  unregisterStreamHandler: () => {},
  sendChat: (sessionKey: string, message: string, _h: StreamHandler, options?: SendOptions) => {
    modelReceived.push({ sessionKey, message, ...(options ? { options } : {}) });
    return new Promise<{ runId?: string }>(() => {});
  },
  defaultModel: () => "fake-model",
  abort: async () => {},
  start: () => {}, stop: () => {},
  complete: async () => ({ content: "ok" }),
} as unknown as AIProvider;

/** Off: the provider is unavailable, and the chat route refuses before the gate. */
let modelConnected = true;
export function setModelConnected(on: boolean): void { modelConnected = on; }
/** Set: the provider resolution throws it, as the routing switch does when it can no longer reach the pinned provider. */
let providerRefusal: Error | null = null;
export function setProviderRefusal(err: Error | null): void { providerRefusal = err; }
/** Every `stream:end` the routes broadcast, so a test can drain like the composer. */
export const streamEnds: Array<(sessionKey: string) => void> = [];

export const HOUR = 60 * 60 * 1000;
export const QUESTION = "Which branch do we ship?";
export const QUESTIONS = [{ question: QUESTION, header: "Branch", options: [{ label: "main" }, { label: "next" }], multiSelect: false }];
let seq = 0;

function seedTopic(sessionKey: string): void {
  const now = new Date().toISOString();
  const topic: Topic = {
    id: `qwait-${++seq}-aaaa-bbbb-cccc-000000000001`,
    name: `Question ${seq}`,
    slug: `question-${seq}`,
    parentId: null,
    links: [],
    sessionKey,
    color: "#aabbcc",
    icon: "chat",
    createdAt: now,
    updatedAt: now,
    archived: false,
  };
  ctx.saveSingleTopic(topic);
}

/** A turn that asked the bridge question: the row the panel is painted on. */
export function askOnRow(sessionKey: string, toolCallId: string, opts: { finalize?: boolean } = {}): string {
  seedTopic(sessionKey);
  ctx.appendLocalMessage(sessionKey, "user", "help me decide");
  const msg = ctx.createPartialMessage(sessionKey, "assistant");
  ctx.startStream(sessionKey, msg.id);
  const call: ToolCall = {
    id: toolCallId,
    name: "mcp__topics__ask_user_question",
    args: { questions: QUESTIONS },
    status: "waiting_for_input",
    startedAt: Date.now(),
    userInputSchema: { kind: "questions", questions: QUESTIONS },
  };
  ctx.addToolCallToLastMessage(sessionKey, call);
  if (opts.finalize) {
    // The row as a crash leaves it once the boot's partial sweep has run: final,
    // with the question still `waiting_for_input` and no stream in memory.
    ctx.updateLastMessage(sessionKey, { partial: undefined, streamedAt: undefined }, { rowId: msg.id });
    forgetStreamLikeARestart(sessionKey);
  }
  return msg.id;
}

/**
 * The turn's stream as a dead process leaves it: gone. A restart starts with an
 * empty stream map AND an empty turn ledger (`lib/turn-ledger.ts`), so both go:
 * a ledger still saying "route" would hold the session open for a turn that no
 * longer exists, and the chat route would refuse the next message with a 409.
 */
export function forgetStreamLikeARestart(sessionKey: string): void {
  ctx.activeStreams.delete(sessionKey);
  ctx.turnLedger?.set(sessionKey, "route", false);
}

/** The tool call as stored: the timeline copy first, the column as fallback. */
export function storedCall(rowId: string, toolCallId: string): ToolCall | undefined {
  const row = ctx.db.query("SELECT tool_calls, blocks FROM messages WHERE id = ?").get(rowId) as { tool_calls: unknown; blocks: unknown } | null;
  const blocks = JSON.parse(decodeCol(row?.blocks) ?? "[]") as Array<{ kind: string; toolCall?: ToolCall }>;
  const calls = JSON.parse(decodeCol(row?.tool_calls) ?? "[]") as ToolCall[];
  return blocks.find((b) => b.kind === "tool" && b.toolCall?.id === toolCallId)?.toolCall
    ?? calls.find((t) => t.id === toolCallId);
}

export function chatRouter(answerRelay?: () => AnswerRelay) {
  return createChatRouter(ctx, {
    // The relay the topics router built: the chat route is where it is taken.
    ...(answerRelay ? {
      answerRelay: {
        claim: (sk: string, id: string) => answerRelay().claim(sk, id),
        takeOwed: (sk: string) => answerRelay().takeOwed(sk),
        heard: (c: Carry) => answerRelay().heard(c),
        notCarried: (c: Carry) => answerRelay().notCarried(c),
      },
    } : {}),
    resolveProvider: () => { if (providerRefusal) throw providerRefusal; return fakeModel; },
    detectLocalhostAutoNav: () => {},
    bindTopicToProject: () => {},
    resolveProjectRef: () => null,
    getProjectIdForTopic: () => null,
    getWorkspaceProjects: () => [],
    autoBindProject: () => {},
    watchSessionForSubagents: () => {},
    updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(),
    WORKSPACE_DIR: testTmpDir("question-waits-ws"),
  } as never);
}

/** A message into the real chat route, the way the composer (or the server) sends one. */
async function postChat(chat: ReturnType<typeof chatRouter>, sessionKey: string, content: string, extra: Record<string, unknown> = {}): Promise<number> {
  const url = new URL("http://topics.test/api/chat");
  const resp = await chat(new Request(url.toString(), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }], ...extra }),
  }), url, "/api/chat", "POST");
  resp?.body?.cancel().catch(() => {});
  // Close the turn the way the model would, so the next send is not a 409.
  const h = handlers[handlers.length - 1];
  h?.onTextDelta("ok", "ok");
  h?.onDone();
  await new Promise((r) => setTimeout(r, 60));
  return resp?.status ?? 0;
}

/** Every relay a test booted: disposed after it, so none outlives its file's database. */
const bootedRelays: AnswerRelay[] = [];

/** The server, as a process starts it: fresh routers over the same database. */
export function bootServer(opts: { modelAnswersRelay?: boolean } = {}) {
  const lateMessages: Array<{ sessionKey: string; content: string }> = [];
  let relay: AnswerRelay | null = null;
  const chat = chatRouter(() => relay!);
  const topics = createTopicsRouter(ctx, undefined, undefined, {
    exposeAnswerRelay: (r) => { relay = r; bootedRelays.push(r); },
    // The answer goes through the REAL chat route to the model, and the model
    // closes that turn at once, as `postChat` does for a typed message.
    answerRelayRoute: async (req, url, pathname, method) => {
      const body = await req.clone().json() as { sessionKey: string; messages: Array<{ content: string }> };
      lateMessages.push({ sessionKey: body.sessionKey, content: body.messages[0]!.content });
      const resp = await chat(req, url, pathname, method);
      // `modelAnswersRelay: false`: the test drives that turn's handler itself.
      if (resp?.ok && opts.modelAnswersRelay !== false) {
        const h = handlers[handlers.length - 1];
        setTimeout(() => { h?.onTextDelta("ok", "ok"); h?.onDone(); }, 0);
      }
      return resp;
    },
  });
  const permission = createPermissionRouter(ctx);
  const call = async (router: typeof topics, path: string, body: unknown) => {
    const url = new URL(`http://topics.test${path}`);
    const resp = await router(new Request(url.toString(), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), url, url.pathname, "POST");
    return { status: resp!.status, body: await resp!.json() as Record<string, unknown> };
  };
  return {
    lateMessages,
    chat,
    /** The queue that carries an answer whose asker is gone (`lib/answer-relay.ts`). */
    relay: () => relay!,
    /** One poll leg of the bridge, as `callAskUserQuestion` sends it. */
    leg: (sessionKey: string) => call(permission, `/api/sessions/${encodeURIComponent(sessionKey)}/ask-user`, { questions: QUESTIONS, legMs: 100 }),
    /** A leg of another question, held open for `legMs`. */
    legFor: (sessionKey: string, questions: unknown[], legMs: number) =>
      call(permission, `/api/sessions/${encodeURIComponent(sessionKey)}/ask-user`, { questions, legMs }),
    /** The panel's Send button. */
    answer: (sessionKey: string, toolCallId: string, choice: string) => call(topics, "/api/chat/tool-response", {
      sessionKey, toolCallId, response: { kind: "questions", answers: { [QUESTION]: choice } },
    }),
    /** A message typed in the composer, or (with `extra`) one the machine sends. */
    send: (sessionKey: string, content: string, extra?: Record<string, unknown>) => postChat(chat, sessionKey, content, extra),
  };
}

/** The hooks of a file that uses this bench: its own data dir, a fresh context. */
export function useQuestionBench(name: string): void {
  const testData = testTmpDir(name);
  beforeAll(async () => {
    setupTestDataDir(testData);
    ctx = await createTestAppContext();
    const onFrame = (m: unknown) => {
      const frame = m as { type?: string; sessionKey?: string };
      if (frame?.type === "stream:end" && frame.sessionKey) for (const f of [...streamEnds]) f(frame.sessionKey);
    };
    (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void }).broadcastToTopicSubscribers = (_id, m) => onFrame(m);
    (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => onFrame(m);
  });

  afterAll(async () => {
    setSystemTime();
    _dropAskStateLikeARestart();
    await cleanupTestDataDir(testData);
  });

  afterEach(() => {
    // A turn a test left open keeps the chat route's watchdog armed: 60 s later
    // it fires in whatever file runs then, over this file's closed database
    // (CI run 36731774291, three tests of other files failed on it). That
    // includes a turn a simulated restart only forgot (`forgetStreamLikeARestart`):
    // a real restart takes its timers with the process. Closed here the way the
    // model closes a turn, before the relays go. Every handler of the test, not
    // one per session: a restart's second turn on a session would hide the first.
    for (const h of handlers.splice(0)) {
      try { h.onDone(); } catch { /* the turn was already being torn down */ }
    }
    for (const r of bootedRelays.splice(0)) r.dispose();
    setSystemTime();
    _dropAskStateLikeARestart();
    streamEnds.length = 0;
    modelConnected = true;
    providerRefusal = null;
  });
}

/** A turn the machine starts and leaves in flight (the dispatcher relaunching a card). */
export async function machineTurnInFlight(chat: ReturnType<typeof chatRouter>, sessionKey: string): Promise<StreamHandler> {
  const url = new URL("http://topics.test/api/chat");
  const resp = await chat(new Request(url.toString(), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "Your previous turn was interrupted: carry on." }], dispatched: true }),
  }), url, "/api/chat", "POST");
  expect(resp?.status).toBe(200);
  resp?.body?.cancel().catch(() => {});
  return handlers[handlers.length - 1]!;
}

export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

export const receivedBy = (sk: string) => modelReceived.filter((m) => m.sessionKey === sk).map((m) => m.message);
