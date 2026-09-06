/**
 * The global Kanban orchestrator is a normal Topic selected exclusively by its
 * registry row. These tests deliberately exercise mutable lookalikes to keep
 * title/MCP-policy identity from creeping back in.
 * @covers GLOBAL-ORCHESTRATOR-REGISTRY-01
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Topic } from "../types";
import {
  ensureGlobalOrchestratorSession,
  getGlobalOrchestratorSessionBySessionKey,
  getGlobalOrchestratorSessionByTopicId,
  GlobalOrchestratorTopicInvariantError,
  isEligibleGlobalOrchestratorSession,
  isGlobalOrchestratorSession,
  isGlobalOrchestratorTopic,
  listGlobalOrchestratorTopicIds,
  presentGlobalOrchestratorTopic,
  type EnsureGlobalOrchestratorSessionDeps,
} from "./global-orchestrator-session";

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function makeTopic(id: string, overrides: Partial<Topic> = {}): Topic {
  return {
    id,
    name: "Kanban coordinator",
    slug: "kanban-coordinator",
    parentId: null,
    links: [],
    sessionKey: `topic:${id.slice(0, 8)}`,
    color: "#5865f2",
    icon: "MessageSquare",
    createdAt: "2026-09-04T11:00:00.000Z",
    updatedAt: "2026-09-04T11:00:00.000Z",
    archived: false,
    ...overrides,
  };
}

function harness() {
  const db = new Database(":memory:");
  databases.push(db);
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL UNIQUE,
    project_path TEXT,
    worktree_id TEXT,
    parent_id TEXT,
    provider TEXT
  )`);
  db.run(`CREATE TABLE global_orchestrator_sessions (
    scope TEXT PRIMARY KEY CHECK (scope = 'global'),
    topic_id TEXT NOT NULL UNIQUE REFERENCES topics(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  const topics = new Map<string, Topic>();
  let createdCount = 0;
  let savedCount = 0;
  let nextTopic = makeTopic("orchestrator-00000001", {
    systemPrompt: "server-owned global board prompt",
    provider: "codex",
  });

  const deps: EnsureGlobalOrchestratorSessionDeps = {
    db,
    getTopicById: (id) => topics.get(id) ?? null,
    saveTopic: (topic) => {
      // Match AppContext.saveSingleTopic: the ordinary Topic writer is itself
      // transactional, and must stay safely nested inside ensure's IMMEDIATE
      // boundary rather than needing a special persistence path.
      db.transaction(() => {
        savedCount += 1;
        topics.set(topic.id, topic);
        db.run(
          `INSERT INTO topics (id, session_key, project_path, worktree_id, parent_id, provider)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             session_key = excluded.session_key,
             project_path = excluded.project_path,
             worktree_id = excluded.worktree_id,
             parent_id = excluded.parent_id,
             provider = excluded.provider`,
          [
            topic.id,
            topic.sessionKey,
            topic.projectPath ?? null,
            topic.worktreeId ?? null,
            topic.parentId ?? null,
            topic.provider ?? null,
          ],
        );
      })();
    },
    createTopic: () => {
      createdCount += 1;
      return nextTopic;
    },
    now: () => "2026-09-04T11:00:01.000Z",
  };

  return {
    db,
    deps,
    topics,
    setNextTopic: (topic: Topic) => { nextTopic = topic; },
    stats: () => ({ createdCount, savedCount }),
    seed: (topic: Topic) => {
      topics.set(topic.id, topic);
      db.run(
        `INSERT INTO topics (id, session_key, project_path, worktree_id, parent_id, provider)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          topic.id,
          topic.sessionKey,
          topic.projectPath ?? null,
          topic.worktreeId ?? null,
          topic.parentId ?? null,
          topic.provider ?? null,
        ],
      );
    },
  };
}

describe("global orchestrator session registry", () => {
  test("ensures exactly one ordinary Topic and reuses the mapping", () => {
    const h = harness();

    const first = ensureGlobalOrchestratorSession(h.deps);
    const second = ensureGlobalOrchestratorSession(h.deps);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.topic.id).toBe(first.topic.id);
    expect(h.stats()).toEqual({ createdCount: 1, savedCount: 1 });
    expect(
      h.db.query("SELECT COUNT(*) AS count FROM global_orchestrator_sessions").get(),
    ).toEqual({ count: 1 });
    expect(
      h.db.query("SELECT scope, topic_id, created_at, updated_at FROM global_orchestrator_sessions").get(),
    ).toEqual({
      scope: "global",
      topic_id: first.topic.id,
      created_at: "2026-09-04T11:00:01.000Z",
      updated_at: "2026-09-04T11:00:01.000Z",
    });
  });

  test("uses only the registry, never a mutable lookalike title or MCP policy", () => {
    const h = harness();
    const lookalike = makeTopic("lookalike-00000001", {
      name: "Kanban coordinator",
      systemPrompt: "server-owned global board prompt",
      mcpPolicy: "bridge-only",
    });
    h.seed(lookalike);

    const result = ensureGlobalOrchestratorSession(h.deps);

    expect(result.topic.id).not.toBe(lookalike.id);
    expect(getGlobalOrchestratorSessionByTopicId(h.db, lookalike.id)).toBeNull();
    expect(isGlobalOrchestratorTopic(h.db, lookalike.id)).toBe(false);
    expect(isGlobalOrchestratorSession(h.db, lookalike.sessionKey)).toBe(false);

    // Those Topic fields remain free to change after registration without
    // changing the role, because the mapping row is the only authority.
    result.topic.name = "Renamed by the user";
    result.topic.mcpPolicy = null;
    h.topics.set(result.topic.id, result.topic);
    expect(isGlobalOrchestratorTopic(h.db, result.topic.id)).toBe(true);
    expect(isGlobalOrchestratorSession(h.db, result.topic.sessionKey)).toBe(true);
  });

  test("projects the client marker from raw registry membership, never a lookalike", () => {
    const h = harness();
    const registered = ensureGlobalOrchestratorSession(h.deps).topic;
    const lookalike = makeTopic("lookalike-projection", {
      name: registered.name,
      provider: "codex",
      systemPrompt: registered.systemPrompt,
    });
    h.seed(lookalike);

    const registryIds = listGlobalOrchestratorTopicIds(h.db);
    expect(registryIds).toEqual(new Set([registered.id]));

    const presented = presentGlobalOrchestratorTopic(h.db, registered);
    expect(presented).not.toBe(registered);
    expect(presented).toMatchObject({ id: registered.id, isGlobalOrchestrator: true });
    // The original ordinary Topic remains safe to persist: the UI marker is
    // explicitly a transport projection, not mutable Topic state.
    expect(registered).not.toHaveProperty("isGlobalOrchestrator");

    expect(presentGlobalOrchestratorTopic(h.db, lookalike)).toBe(lookalike);
    expect(lookalike).not.toHaveProperty("isGlobalOrchestrator");

    const forgedMarker = { ...lookalike, isGlobalOrchestrator: true };
    const canonicalOrdinaryTopic = presentGlobalOrchestratorTopic(h.db, forgedMarker);
    expect(canonicalOrdinaryTopic).not.toBe(forgedMarker);
    expect(canonicalOrdinaryTopic).not.toHaveProperty("isGlobalOrchestrator");
  });

  test("resolves the registry by exact Topic id and normal session key", () => {
    const h = harness();
    const { topic } = ensureGlobalOrchestratorSession(h.deps);

    expect(getGlobalOrchestratorSessionByTopicId(h.db, topic.id)).toMatchObject({
      scope: "global",
      topicId: topic.id,
    });
    expect(getGlobalOrchestratorSessionBySessionKey(h.db, topic.sessionKey)).toMatchObject({
      scope: "global",
      topicId: topic.id,
    });
    expect(getGlobalOrchestratorSessionByTopicId(h.db, "not-registered")).toBeNull();
    expect(getGlobalOrchestratorSessionBySessionKey(h.db, "topic:not-registered")).toBeNull();
  });

  test("keeps raw identity but revokes usable capability after backing-row corruption", () => {
    const h = harness();
    const { topic } = ensureGlobalOrchestratorSession(h.deps);

    expect(isGlobalOrchestratorSession(h.db, topic.sessionKey)).toBe(true);
    expect(isEligibleGlobalOrchestratorSession(h.db, topic.sessionKey)).toBe(true);

    h.db.run("UPDATE topics SET project_path = ? WHERE id = ?", ["/manual/corruption", topic.id]);

    // Raw identity is intentionally retained so generic project/session routes
    // still deny it; only the focused global capability is revoked.
    expect(isGlobalOrchestratorSession(h.db, topic.sessionKey)).toBe(true);
    expect(isEligibleGlobalOrchestratorSession(h.db, topic.sessionKey)).toBe(false);
  });

  test("revokes the role automatically when its Topic is deleted", () => {
    const h = harness();
    const { topic } = ensureGlobalOrchestratorSession(h.deps);

    h.db.run("DELETE FROM topics WHERE id = ?", [topic.id]);

    expect(getGlobalOrchestratorSessionByTopicId(h.db, topic.id)).toBeNull();
    expect(getGlobalOrchestratorSessionBySessionKey(h.db, topic.sessionKey)).toBeNull();
    expect(
      h.db.query("SELECT COUNT(*) AS count FROM global_orchestrator_sessions").get(),
    ).toEqual({ count: 0 });
  });

  test("rejects a project-bound factory result before it can be registered", () => {
    const h = harness();
    h.setNextTopic(makeTopic("bound-000000000001", { projectPath: "/real/project" }));

    expect(() => ensureGlobalOrchestratorSession(h.deps)).toThrow(
      GlobalOrchestratorTopicInvariantError,
    );
    expect(h.stats()).toEqual({ createdCount: 1, savedCount: 0 });
    expect(
      h.db.query("SELECT COUNT(*) AS count FROM global_orchestrator_sessions").get(),
    ).toEqual({ count: 0 });
  });

  test("rejects a worktree-bound factory result before it can be registered", () => {
    const h = harness();
    h.setNextTopic(makeTopic("worktree-0000000001", { worktreeId: "worktree-1" }));

    expect(() => ensureGlobalOrchestratorSession(h.deps)).toThrow(
      GlobalOrchestratorTopicInvariantError,
    );
    expect(h.stats()).toEqual({ createdCount: 1, savedCount: 0 });
  });

  test("rejects a nested factory result before it can be registered", () => {
    const h = harness();
    h.setNextTopic(makeTopic("nested-000000000001", { parentId: "another-topic" }));

    expect(() => ensureGlobalOrchestratorSession(h.deps)).toThrow(
      GlobalOrchestratorTopicInvariantError,
    );
    expect(h.stats()).toEqual({ createdCount: 1, savedCount: 0 });
  });

  test("will not elevate a pre-existing unregistered Topic", () => {
    const h = harness();
    const ordinaryTopic = makeTopic("ordinary-0000000001");
    h.seed(ordinaryTopic);
    h.setNextTopic(ordinaryTopic);

    expect(() => ensureGlobalOrchestratorSession(h.deps)).toThrow(
      GlobalOrchestratorTopicInvariantError,
    );
    expect(isGlobalOrchestratorTopic(h.db, ordinaryTopic.id)).toBe(false);
    expect(h.stats()).toEqual({ createdCount: 1, savedCount: 0 });
  });

  test("fails closed if the registered Topic is later bound to a project", () => {
    const h = harness();
    const { topic } = ensureGlobalOrchestratorSession(h.deps);
    h.topics.set(topic.id, { ...topic, projectPath: "/real/project" });

    expect(() => ensureGlobalOrchestratorSession(h.deps)).toThrow(
      GlobalOrchestratorTopicInvariantError,
    );
    expect(h.stats()).toEqual({ createdCount: 1, savedCount: 1 });
  });

  test("repairs a registered Topic back to Codex only through explicit ensure", () => {
    const h = harness();
    const { topic } = ensureGlobalOrchestratorSession(h.deps);
    h.topics.set(topic.id, { ...topic, provider: "openclaw" });

    const repaired = ensureGlobalOrchestratorSession(h.deps);

    expect(repaired.created).toBe(false);
    expect(repaired.topic.provider).toBe("codex");
    expect(h.stats()).toEqual({ createdCount: 1, savedCount: 2 });
  });
});
