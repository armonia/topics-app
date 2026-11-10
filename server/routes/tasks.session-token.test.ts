/**
 * THE SESSION ROUTES SIGN AS THE CALLER, NOT AS THE URL (card 964ea861).
 *
 * @covers KANBAN-07
 *
 * `/api/sessions/:sessionKey/...` took the signature from the key in the path,
 * and the loopback owns the server without credentials: an agent's shell could
 * post a comment signed `agent:<another topic>` by naming that topic's key. Now
 * the session token (`lib/session-token.ts`) binds the caller to its session:
 *
 *   - its own token: signed as that session;
 *   - another session's token: 403, on every write route (comment, PATCH,
 *     labels, defer, create) and on the coordinator's routes;
 *   - no token: signed as an anonymous agent, never as the topic in the path.
 *
 * The token survives a restart (the signing key is a file in the Topics home,
 * the daemon token is not its root) and never travels in the bridge's argv.
 *
 * Mutation: make `provenSession` return `resolveSession(sessionKey)` and the
 * forged comment comes back 201 signed `agent:top-s1`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { createTasksRouter } from "./tasks";
import { call, freshDb, makeCtx, rawCall } from "./tasks-test-support";
import {
  mintSessionToken, readSessionToken, resetSessionSigningCache, SESSION_TOKEN_HEADER, sessionTokenPath,
} from "../lib/session-token";
import { topicsHome, writeState } from "../services/daemon-state";
import { bridgeAuthHeaders } from "../mcp/topics-http";
import { topicsMcpBridgeSpec } from "../providers/claude-code";
import { AGENT_AUTHOR } from "../../shared/comment-author";

/** What the bridge of `sessionKey` would send: its own token. */
function asSession(sessionKey: string): Record<string, string> {
  return { [SESSION_TOKEN_HEADER]: mintSessionToken(topicsHome(), sessionKey) };
}

describe("session routes bind the caller to its session", () => {
  let db: Database; let router: any; let taskId: string;
  beforeEach(async () => {
    db = freshDb();
    router = createTasksRouter(makeCtx(db, []));
    taskId = (await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "card" }))!.json()).id;
  });

  async function authors(): Promise<string[]> {
    const got = await (await call(router, "GET", `/api/sessions/s1/tasks/${taskId}`))!.json();
    return got.comments.filter((c: { author: string }) => c.author !== "system").map((c: { author: string }) => c.author);
  }

  test("the session's own token signs as the session", async () => {
    const resp = (await rawCall(router, "POST", `/api/sessions/s1/tasks/${taskId}/comments`, { content: "mine" }, asSession("s1")))!;
    expect(resp.status).toBe(201);
    expect(await authors()).toEqual(["agent:top-s1"]);
  });

  test("another session's token naming this session's key is refused with 403", async () => {
    const resp = (await rawCall(router, "POST", `/api/sessions/s1/tasks/${taskId}/comments`, { content: "forged" }, asSession("s2")))!;
    expect(resp.status).toBe(403);
    expect(((await resp.json()) as { code: string }).code).toBe("session_token_mismatch");
    expect(await authors()).toEqual([]);
  });

  test("a call with no token is signed as an anonymous agent, not as the topic in the path", async () => {
    const resp = (await rawCall(router, "POST", `/api/sessions/s1/tasks/${taskId}/comments`, { content: "who?" }))!;
    expect(resp.status).toBe(201);
    expect(await authors()).toEqual([AGENT_AUTHOR]);
  });

  test("a malformed token is a refusal, not an absence", async () => {
    const resp = (await rawCall(router, "POST", `/api/sessions/s1/tasks/${taskId}/comments`, { content: "x" }, { [SESSION_TOKEN_HEADER]: "not-a-token" }))!;
    expect(resp.status).toBe(403);
  });

  test("PATCH, labels, defer and create refuse a foreign token too", async () => {
    const forged = asSession("s2");
    const routes: Array<[string, string, unknown]> = [
      ["PATCH", `/api/sessions/s1/tasks/${taskId}`, { priority: 4 }],
      ["PUT", `/api/sessions/s1/tasks/${taskId}/labels`, { labels: [] }],
      ["POST", `/api/sessions/s1/tasks/${taskId}/defer`, { reason: "later", minutes: 15 }],
      ["POST", "/api/sessions/s1/tasks", { text: "planted" }],
    ];
    for (const [method, path, body] of routes) {
      const resp = (await rawCall(router, method, path, body, forged))!;
      expect([method, path, resp.status]).toEqual([method, path, 403]);
    }
    const got = await (await call(router, "GET", `/api/sessions/s1/tasks/${taskId}`))!.json();
    expect(got.priority).not.toBe(4);
  });

  test("the coordinator's routes refuse a caller without the coordinator's token", async () => {
    // `s1` is not a registered coordinator, so this is the 403 of the registry;
    // with a registered one the missing token is the 403 (`provenGlobalOrchestrator`).
    const resp = (await rawCall(router, "GET", "/api/orchestrator-sessions/s1/tasks", undefined, asSession("s2")))!;
    expect(resp.status).toBe(403);
  });
});

describe("the session token across a restart", () => {
  afterEach(() => resetSessionSigningCache());

  test("a restart regenerates the daemon token and leaves the session token valid", async () => {
    const before = mintSessionToken(topicsHome(), "s1");
    const daemonBefore = writeState(0).token;
    // What a restart does: a new process (no cached key) and a new daemon token.
    resetSessionSigningCache();
    const daemonAfter = writeState(0).token;
    expect(daemonAfter).not.toBe(daemonBefore);
    expect(mintSessionToken(topicsHome(), "s1")).toBe(before);

    const db = freshDb();
    const router = createTasksRouter(makeCtx(db, []));
    const taskId = (await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "card" }))!.json()).id;
    const resp = (await rawCall(router, "POST", `/api/sessions/s1/tasks/${taskId}/comments`, { content: "still me" }, { [SESSION_TOKEN_HEADER]: before }))!;
    expect(resp.status).toBe(201);
  });

  test("each session has its own token", () => {
    expect(mintSessionToken(topicsHome(), "s1")).not.toBe(mintSessionToken(topicsHome(), "s2"));
  });
});

describe("how the token reaches the bridge", () => {
  test("the bridge spec writes it to a file and keeps it out of the argv", () => {
    const sessionKey = "topic:argv-check";
    const spec = topicsMcpBridgeSpec(sessionKey);
    const token = readSessionToken(topicsHome(), sessionKey);
    expect(token).toBe(mintSessionToken(topicsHome(), sessionKey));
    expect([spec.command, ...spec.args].join(" ")).not.toContain(token!);
    if (process.platform !== "win32") {
      expect(statSync(sessionTokenPath(topicsHome(), sessionKey)).mode & 0o777).toBe(0o600);
    }
  });

  test("the bridge sends the token of its own session, read from that file", () => {
    const sessionKey = "topic:bridge-headers";
    topicsMcpBridgeSpec(sessionKey);
    const headers = bridgeAuthHeaders({ topicsHome: topicsHome(), sessionKey });
    expect(headers[SESSION_TOKEN_HEADER]).toBe(mintSessionToken(topicsHome(), sessionKey));
    expect(bridgeAuthHeaders({ topicsHome: topicsHome(), sessionKey: "topic:never-launched" })[SESSION_TOKEN_HEADER]).toBeUndefined();
  });
});
