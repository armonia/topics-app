/**
 * The legacy `/project` chat command must not turn the registered global
 * coordinator into a project-bound Topic.  This is deliberately exercised at
 * the real chat-route boundary: `/project create` used to touch the filesystem
 * before the normal bind helper had a chance to reject the bind.
 * @covers GLOBAL-ORCHESTRATOR-ISOLATION-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { registerProvider, removeProvider } from "../providers";
import { createChatRouter } from "./chat";
import type { Topic } from "../types";

// The guard is useful even while a real Codex turn is unavailable, but the
// healthy coordinator path deliberately resolves Codex from the registry
// before persisting a message. Register a REAL Codex provider rather than
// mocking the barrel: `mock.module` is process-global in bun and outlives this
// file, and a namespace import of the barrel makes every provider export look
// used to the dead-code gate. The Codex constructor only stores its config and
// `start()` only flips a flag: no process is spawned and no CLI is required.
// The command fence returns before the turn would reach the provider.
beforeAll(() => { registerProvider({ type: "codex" }); });
afterAll(() => { removeProvider("codex"); });

const ROOT = testTmpDir("chat-global-project-command");
const DATA_DIR = join(ROOT, "data");
const WORKSPACE_DIR = join(ROOT, "workspace");

beforeAll(() => setupTestDataDir(DATA_DIR));
afterAll(() => cleanupTestDataDir(ROOT));

function globalTopic(): Topic {
  const now = new Date().toISOString();
  return {
    id: "global-project-command-topic",
    name: "Kanban coordinator",
    slug: "kanban-coordinator",
    parentId: null,
    links: [],
    sessionKey: "topic:global-project-command",
    color: "#5865f2",
    icon: "MessageSquare",
    createdAt: now,
    updatedAt: now,
    archived: false,
    // This fixture exercises the healthy coordinator's legacy `/project`
    // command fence. The global role is deliberately Codex-only, so omit no
    // provider here: an omitted provider is a corrupted raw role and must
    // fail closed before command handling.
    provider: "codex",
  } as Topic;
}

describe("global coordinator /project chat command fence", () => {
  test("registered Topic cannot create, open, or bind a project and receives a truthful response", async () => {
    const ctx = await createTestAppContext();
    const topic = globalTopic();
    ctx.saveSingleTopic(topic);
    ctx.db.run(
      `INSERT INTO global_orchestrator_sessions (scope, topic_id, created_at, updated_at)
       VALUES ('global', ?, ?, ?)`,
      [topic.id, topic.createdAt, topic.updatedAt],
    );

    const bindCalls: unknown[][] = [];
    let resolveProjectRefCalls = 0;
    const router = createChatRouter(ctx, {
      // A guarded command returns before provider resolution.
      resolveProvider: () => { throw new Error("provider must not be called for /project"); },
      detectLocalhostAutoNav: () => "",
      bindTopicToProject: (...args: unknown[]) => { bindCalls.push(args); return true; },
      resolveProjectRef: () => { resolveProjectRefCalls += 1; return "/a/real/project"; },
      getProjectIdForTopic: () => null,
      getWorkspaceProjects: () => ["/a/real/project"],
      autoBindProject: () => {},
      watchSessionForSubagents: () => {},
      updateUnreadCount: () => {},
      browserNavigatedTopics: new Set<string>(),
      WORKSPACE_DIR,
    } as never);

    const send = async (content: string) => {
      const url = new URL("http://topics.test/api/chat");
      const response = await router(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionKey: topic.sessionKey,
            messages: [{ role: "user", content }],
          }),
        }),
        url,
        url.pathname,
        "POST",
      );
      expect(response?.status).toBe(200);
      const payload = await response!.text();
      expect(payload).toContain("Project controls are unavailable in the global Kanban coordinator");
      expect(payload).toContain("It remains unbound");
      expect(payload).not.toContain("Created project");
      expect(payload).not.toContain("Opened project");
    };

    await send("/project create must-not-exist");
    await send("/project open anything");

    // `create` used to mkdir before bind; `open` used to invoke the resolver
    // and then bind. Neither side effect is allowed for the mapped session.
    expect(existsSync(join(WORKSPACE_DIR, "must-not-exist"))).toBe(false);
    expect(resolveProjectRefCalls).toBe(0);
    expect(bindCalls).toEqual([]);
    expect(ctx.getTopicById(topic.id)?.projectPath).toBeUndefined();
  });
});
