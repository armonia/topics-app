/**
 * THE `stream:action` FEED, THROUGH THE REAL FAN-OUTS AND THE REAL SOCKET OPEN.
 *
 * `server/lib/stream-action-feed.test.ts` proves the rule on bare frames. Two
 * things it cannot see live elsewhere:
 *   - the wiring in `server/utils.ts`: the feed watches the frames at the tail
 *     of `broadcastToAll` and `broadcastToTopicSubscribers`; take either call
 *     away and the unit test stays green while the windows go blind;
 *   - the open of a socket (`server/routes/ws-open.ts`): the feed only says
 *     CHANGES, so a window that connects mid-turn must be told the current
 *     action, or it stays on `think` until the next change.
 *
 * @covers STATUS-VISUAL-01k
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { setupTestDataDir, cleanupTestDataDir, testTmpDir, PROJECT_ROOT } from "./helpers";
import type { AppContext, WSData } from "../../server/types";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { createWsOpen } from "../../server/routes/ws-open";
import { putGrant, deviceP } from "../../server/lib/grants-query";
import { principalsRev } from "../../server/lib/principals";
import { refreshSocketPrincipal, socketMayReadTopic, socketMayReceiveFrame } from "../../server/lib/socket-principals";

const ROOT = testTmpDir("stream-action-wiring");
let ctx: AppContext;
beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  // Not `createTestAppContext`: it replaces `ctx.broadcastToAll` with a no-op, and this test is about the real fan-out.
  const { createAppContext } = await import("../../server/utils");
  ctx = createAppContext(PROJECT_ROOT);
  // The same door the boot installs, so a guest socket is filtered like in production.
  ctx.setGuestBroadcastFilter({
    refreshSocketPrincipal(data) { refreshSocketPrincipal(ctx.db, data); },
    mayReceiveFrame(data, message) { return socketMayReceiveFrame(ctx.db, data, message); },
    mayReadTopic(data, topicId) { return socketMayReadTopic(ctx.db, data, topicId); },
  });
});
afterAll(() => cleanupTestDataDir(ROOT));

type Frame = Record<string, unknown>;

/** A socket that keeps every frame it is sent. `guestOf` makes it a confined guest device. */
function fakeSocket(id: string, guestOf?: string) {
  const frames: Frame[] = [];
  const data = {
    id, remote: false, lastPong: 0, focusedTopicId: null,
    deviceId: guestOf ?? null,
    principal: guestOf ? { principals: deviceP(guestOf), confined: true, rev: principalsRev(ctx.db) } : null,
  };
  const ws = { readyState: 1, data, send: (p: string) => { frames.push(JSON.parse(p) as Frame); return 0; } };
  return { ws: ws as unknown as import("bun").ServerWebSocket<WSData>, frames };
}

const actions = (frames: Frame[], topicId?: string) =>
  frames.filter((f) => f.type === "stream:action" && (!topicId || f.topicId === topicId)).map((f) => f.action);

const frame = (type: string, topicId: string, sessionKey: string, extra: Frame = {}) =>
  ({ type, topicId, sessionKey, ...extra }) as unknown as OutboundMessage;
const tool = (topicId: string, sessionKey: string, name: string) =>
  frame("stream:tool_call", topicId, sessionKey, { toolCall: { id: `${name}-id`, name } });

/** The open of a socket, through the real `createWsOpen`, with only the parts the first frames need. */
function openSocket(ws: import("bun").ServerWebSocket<WSData>) {
  const scope = {
    ctx, db: ctx.db, turnLedger: ctx.turnLedger!, wsClients: ctx.wsClients,
    browserService: {}, browserWsClients: new Map(), hostBootRace: {}, hostMirror: {}, viewerCountPublisher: {}, viewportWiring: {}, voiceBrainDoor: {},
    devBundleReload: { getRev: () => null },
    memoryPressureSignal: { frame: () => ({ type: "memory:pressure", level: "ok" }) },
    streamCatchupFrames: () => [],
  };
  createWsOpen(scope as never).open(ws);
}

describe("the feed is wired into the real fan-outs", () => {
  test("broadcastToAll: one frame per change, repeats and the end are not extra", () => {
    const { ws, frames } = fakeSocket("w-all");
    ctx.wsClients.add(ws);
    ctx.broadcastToAll(frame("stream:start", "T-all", "sk-all", { messageId: "m1" }));
    ctx.broadcastToAll(tool("T-all", "sk-all", "Bash"));
    ctx.broadcastToAll(tool("T-all", "sk-all", "Bash"));
    ctx.broadcastToAll(tool("T-all", "sk-all", "Bash"));
    ctx.broadcastToAll(tool("T-all", "sk-all", "Read"));
    ctx.broadcastToAll(frame("stream:end", "T-all", "sk-all"));
    // Start says nothing; Bash is `run` once; Read is `read`; the end clears without a frame.
    expect(actions(frames, "T-all")).toEqual(["run", "read"]);
    ctx.wsClients.delete(ws);
  });

  test("broadcastToTopicSubscribers: the same rule, from the per-topic fan-out", () => {
    const { ws, frames } = fakeSocket("w-sub");
    ctx.wsClients.add(ws);
    ctx.broadcastToTopicSubscribers("T-sub", frame("stream:start", "T-sub", "sk-sub", { messageId: "m2" }));
    ctx.broadcastToTopicSubscribers("T-sub", tool("T-sub", "sk-sub", "Edit"));
    ctx.broadcastToTopicSubscribers("T-sub", tool("T-sub", "sk-sub", "Edit"));
    ctx.broadcastToTopicSubscribers("T-sub", tool("T-sub", "sk-sub", "Bash"));
    ctx.broadcastToTopicSubscribers("T-sub", frame("stream:end", "T-sub", "sk-sub"));
    expect(actions(frames, "T-sub")).toEqual(["edit", "run"]);
    ctx.wsClients.delete(ws);
  });

  test("a window that does not hold the topic still hears the action (it is global)", () => {
    const { ws, frames } = fakeSocket("w-other");
    ws.data.focusedTopicId = "elsewhere";
    ctx.wsClients.add(ws);
    ctx.broadcastToTopicSubscribers("T-glob", tool("T-glob", "sk-glob", "Grep"));
    expect(actions(frames, "T-glob")).toEqual(["read"]);
    ctx.broadcastToAll(frame("stream:end", "T-glob", "sk-glob"));
    ctx.wsClients.delete(ws);
  });
});

describe("a socket that connects mid-turn is told the current action", () => {
  test("it receives one `stream:action` per open turn, and only on its own socket", () => {
    ctx.broadcastToAll(tool("T-mid", "sk-mid", "Edit"));
    ctx.broadcastToAll(frame("stream:content_chunk", "T-mid", "sk-mid", { content: "hi" }));
    const bystander = fakeSocket("w-bystander");
    ctx.wsClients.add(bystander.ws);
    const late = fakeSocket("w-late");
    openSocket(late.ws);
    const told = late.frames.filter((f) => f.type === "stream:action" && f.topicId === "T-mid");
    expect(told).toEqual([{ type: "stream:action", topicId: "T-mid", sessionKey: "sk-mid", action: "write" }]);
    // The connect is not a change: the sockets already there hear nothing.
    expect(actions(bystander.frames, "T-mid")).toEqual([]);
    // It comes right after the turn snapshot, like the rest of the initial burst.
    const types = late.frames.map((f) => f.type);
    expect(types.indexOf("stream:action")).toBeGreaterThan(types.indexOf("turn:snapshot"));
    ctx.broadcastToAll(frame("stream:end", "T-mid", "sk-mid"));
    ctx.wsClients.delete(bystander.ws);
    ctx.wsClients.delete(late.ws);
  });

  test("a socket that connects after the turn ended receives nothing", () => {
    ctx.broadcastToAll(tool("T-done", "sk-done", "Bash"));
    ctx.broadcastToAll(frame("stream:end", "T-done", "sk-done"));
    const late = fakeSocket("w-after");
    openSocket(late.ws);
    expect(actions(late.frames, "T-done")).toEqual([]);
    ctx.wsClients.delete(late.ws);
  });

  test("a failed turn is not replayed either", () => {
    ctx.broadcastToAll(tool("T-err", "sk-err", "Bash"));
    ctx.broadcastToAll(frame("stream:error", "T-err", "sk-err", { error: "boom" }));
    const late = fakeSocket("w-after-err");
    openSocket(late.ws);
    expect(actions(late.frames, "T-err")).toEqual([]);
    ctx.wsClients.delete(late.ws);
  });
});

describe("a guest only hears the action of a chat it can read", () => {
  const DEVICE = "guest-dev-1";
  beforeAll(() => {
    // The device row is not needed by the checks below: the socket carries its principals already.
    putGrant(ctx.db, { kind: "device", id: DEVICE }, "topic", "T-shared", { level: "read", grantedAt: 0 });
  });

  test("live: the shared topic's action passes, another topic's does not", () => {
    const guest = fakeSocket("g-live", DEVICE);
    ctx.wsClients.add(guest.ws);
    ctx.broadcastToAll(tool("T-shared", "sk-shared-live", "Bash"));
    ctx.broadcastToAll(tool("T-secret", "sk-secret-live", "Bash"));
    expect(actions(guest.frames)).toEqual(["run"]);
    expect(guest.frames.every((f) => f.topicId !== "T-secret")).toBe(true);
    ctx.broadcastToAll(frame("stream:end", "T-shared", "sk-shared-live"));
    ctx.broadcastToAll(frame("stream:end", "T-secret", "sk-secret-live"));
    ctx.wsClients.delete(guest.ws);
  });

  test("on connect: the same rule, from the open", () => {
    ctx.broadcastToAll(tool("T-shared", "sk-shared-open", "Edit"));
    ctx.broadcastToAll(tool("T-secret", "sk-secret-open", "Edit"));
    const guest = fakeSocket("g-open", DEVICE);
    openSocket(guest.ws);
    expect(guest.frames.filter((f) => f.type === "stream:action").map((f) => f.topicId)).toEqual(["T-shared"]);
    ctx.broadcastToAll(frame("stream:end", "T-shared", "sk-shared-open"));
    ctx.broadcastToAll(frame("stream:end", "T-secret", "sk-secret-open"));
    ctx.wsClients.delete(guest.ws);
  });
});
