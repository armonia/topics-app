/**
 * `POST /api/topics/:id/fork` against a real SQLite (CHAT-FORK-01..03).
 *
 * What the route promises and nothing else checks: the branch is a NEW chat
 * with a copy of the active branch up to the last finished answer, the
 * original does not move by one byte, every refusal comes before the first
 * write, and a CLI branch forks the parent's session only when the parent's
 * memory matches the copy. The Claude Code parent is a real
 * `ClaudeCodeProvider` reading a real transcript, written where the CLI would
 * write it for the parent's project dir (a temp dir, so the folder under
 * `~/.claude/projects` is unique; it is removed at the end).
 *
 * @covers CHAT-FORK-01, CHAT-FORK-02, CHAT-FORK-03
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROJECT_ROOT, cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import { createForkRouter } from "../../server/routes/fork";
import { ClaudeCodeProvider } from "../../server/providers/claude-code";
import { nativeHistorySource } from "../../server/providers/native/history-source";
import { claudeTranscriptCandidates } from "../../server/lib/claude-transcript-path";
import { consumeFork, pendingForkSessions, readForkOrigin } from "../../server/lib/chat-fork-store";
import { registerProvider, removeProvider } from "../../server/providers";
import { computeProfileStats } from "../../server/services/profile-stats";
import { projectUsage } from "../../server/usage/project-usage";
import type { AIProvider } from "../../server/providers";
import type { AppContext, ContentBlock, StoredMessage, Topic } from "../../server/types";

const ROOT = testTmpDir("chat-fork-route");
const PROJECT = join(ROOT, "project");
/** Where a parent ran before it moved to PROJECT (`/project`, `open_project`, autoBind): its transcript stayed there. */
const PREVIOUS_PROJECT = join(ROOT, "previous-project");
let ctx: AppContext;
let router: ReturnType<typeof createForkRouter>;
const broadcasts: { type: string; topic?: Topic }[] = [];
const claude = new ClaudeCodeProvider({ type: "claude-code" });
const codexPoint = { ref: "thread-parent", at: "4242" };

beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(PREVIOUS_PROJECT, { recursive: true });
  ctx = await createTestAppContext();
  (ctx as { broadcastToAll: (m: object) => void }).broadcastToAll = (m) => { broadcasts.push(m as never); };
  router = createForkRouter(ctx, {
    resolveProvider: (topic) => {
      if (topic?.provider === "claude-code") return claude;
      if (topic?.provider === "codex") return { name: "codex", forkPoint: () => codexPoint } as unknown as AIProvider;
      return { name: topic?.provider ?? "topics" } as unknown as AIProvider;
    },
  });
});

afterAll(async () => {
  for (const dir of [PROJECT, PREVIOUS_PROJECT]) for (const file of claudeTranscriptCandidates(dir, "x")) rmSync(dirname(file), { recursive: true, force: true });
  await cleanupTestDataDir(ROOT);
});

let seq = 0;
type Row = Partial<StoredMessage> & { id: string; role: "user" | "assistant"; content: string };

/** A topic with these rows, in this order; `parentId` defaults to the row before. */
function chat(rows: Row[], topic: Partial<Topic> = {}): Topic {
  const id = `fork-${++seq}-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const t: Topic = {
    id, name: `Chat ${seq}`, slug: `chat-${seq}`, parentId: null, links: [], sessionKey: `topic:${id.slice(0, 12)}`,
    color: "#123456", icon: "MessageSquare", createdAt: now, updatedAt: now, archived: false, ...topic,
  };
  ctx.saveSingleTopic(t);
  let previous: string | null = null;
  ctx.saveLocalMessages(t.sessionKey, rows.map((r) => {
    const m = { timestamp: now, branchIndex: 0, ...r, id: `${t.sessionKey}:${r.id}`, parentId: r.parentId === undefined ? previous : r.parentId && `${t.sessionKey}:${r.parentId}` } as StoredMessage;
    previous = m.id;
    return m;
  }));
  return t;
}

const turns = (n: number): Row[] => Array.from({ length: n }, (_, i) => [
  { id: `u${i}`, role: "user" as const, content: `prompt ${i}` },
  { id: `a${i}`, role: "assistant" as const, content: `answer ${i}` },
]).flat();

async function fork(topic: Topic, body: object = {}): Promise<Response> {
  const url = new URL(`http://h/api/topics/${topic.id}/fork`);
  const req = new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const res = await router(req, url, url.pathname, "POST");
  if (!res) throw new Error("the fork route did not answer");
  return res;
}

const rowsOf = (sk: string) => ctx.db.prepare("SELECT * FROM messages WHERE session_key = ? ORDER BY sort_order").all(sk);
const branchesOf = (sk: string) => ctx.db.prepare("SELECT * FROM active_branches WHERE session_key = ?").all(sk);
const topicCount = () => (ctx.db.prepare("SELECT COUNT(*) AS n FROM topics").get() as { n: number }).n;
const sessionOf = (sk: string) => ctx.db.prepare("SELECT claude_session_id, import_offset FROM claude_code_sessions WHERE session_key = ?").get(sk) as { claude_session_id: string; import_offset: number | null } | null;

/** A Claude Code parent with a session and a transcript whose last answer is `lastText`, filed under `transcriptCwd`. */
function claudeParent(rows: Row[], lastText: string, uuid = "uuid-last", transcriptCwd = PROJECT): Topic {
  const t = chat(rows, { provider: "claude-code", projectPath: PROJECT });
  const sessionId = `sess-${crypto.randomUUID()}`;
  ctx.db.prepare("INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at) VALUES (?, ?, 'now', 'now')").run(t.sessionKey, sessionId);
  const file = claudeTranscriptCandidates(transcriptCwd, sessionId)[0];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [
    { type: "user", uuid: "u-x", message: { content: "prompt" } },
    { type: "assistant", uuid, isSidechain: false, message: { content: [{ type: "text", text: lastText }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  return t;
}

describe("the branch is a new chat with the same history, and the original does not move", () => {
  test("3 turns and an inactive alternative: 6 rows copied, no id shared, the original byte-identical", async () => {
    const t = chat([
      ...turns(2),
      { id: "a1b", role: "assistant", content: "the alternative", parentId: "u1", branchIndex: 1 },
      { id: "u2", role: "user", content: "prompt 2", parentId: "a1" },
      { id: "a2", role: "assistant", content: "answer 2" },
    ]);
    const rowsBefore = rowsOf(t.sessionKey);
    const branchesBefore = branchesOf(t.sessionKey);

    const res = await fork(t, { name: "Chat (ramo)" });
    expect(res.status).toBe(201);
    const branch = (await res.json()) as Topic;
    expect(branch.name).toBe("Chat (ramo)");
    expect(branch.sessionKey).not.toBe(t.sessionKey);

    const copied = ctx.loadActiveThread(branch.sessionKey);
    const original = ctx.loadActiveThread(t.sessionKey);
    expect(copied.map((m) => [m.role, m.content])).toEqual(original.map((m) => [m.role, m.content]));
    expect(copied).toHaveLength(6);
    expect(copied.some((m) => original.some((o) => o.id === m.id))).toBe(false);
    expect(branch.forkedFrom).toEqual({ topicId: t.id, name: t.name, atMessageId: copied[5].id });

    expect(rowsOf(t.sessionKey)).toEqual(rowsBefore);
    expect(branchesOf(t.sessionKey)).toEqual(branchesBefore);
    const announced = broadcasts.findLast((b) => b.type === "topic:created");
    expect(announced?.topic?.id).toBe(branch.id);
    expect(announced?.topic?.forkedFrom?.name).toBe(t.name);
  });

  test("the original gone: forkedFrom keeps its name and loses the link (CHAT-FORK-05)", async () => {
    const t = chat(turns(1));
    const branch = (await (await fork(t)).json()) as Topic;
    ctx.db.prepare("DELETE FROM topics WHERE id = ?").run(t.id);
    expect(ctx.getTopicById(branch.id)?.forkedFrom).toEqual({ topicId: null, name: t.name, atMessageId: branch.forkedFrom!.atMessageId });
    expect(ctx.loadTopics().topics[branch.id]?.forkedFrom).toEqual({ topicId: null, name: t.name, atMessageId: branch.forkedFrom!.atMessageId });
  });

  test("no name in the body: «<name> (ramo)»", async () => {
    const t = chat(turns(1));
    const branch = (await (await fork(t)).json()) as Topic;
    expect(branch.name).toBe(`${t.name} (ramo)`);
  });

  test("the branch inherits how the chat works, not what the page remembers", async () => {
    ctx.db.prepare("INSERT INTO projects (id, name, slug, path, created_at, updated_at) VALUES ('fork-p', 'p', 'fork-p', ?, 'now', 'now')").run(PROJECT);
    ctx.db.prepare("INSERT INTO worktrees (id, project_id, name, mode, abs_path, status, created_at, updated_at) VALUES ('fork-wt', 'fork-p', 'w', 'branch', ?, 'ready', 'now', 'now')").run(join(ROOT, "wt"));
    const t = chat(turns(1), {
      provider: "openai", model: "gpt-x", effort: "high", autonomyLevel: "yolo", fastMode: true,
      projectPath: PROJECT, worktreeId: "fork-wt", systemPrompt: "be brief", contextFiles: ["/a.md"], mcpPolicy: "bridge-only",
    });
    ctx.saveSingleTopic({ ...ctx.getTopicById(t.id)!, pinnedMessages: [`${t.sessionKey}:a0`] });
    const branch = ctx.getTopicById(((await (await fork(t)).json()) as Topic).id)!;
    expect(branch).toMatchObject({
      provider: "openai", model: "gpt-x", effort: "high", autonomyLevel: "yolo", fastMode: true,
      projectPath: PROJECT, worktreeId: "fork-wt", systemPrompt: "be brief", contextFiles: ["/a.md"],
    });
    expect(branch.pinnedMessages ?? []).toEqual([]);
    expect(branch.mcpPolicy ?? null).toBeNull();
  });

  test("the copy spends nothing: measured cost and tokens do not move, the model and the latency stay", async () => {
    const t = chat([
      { id: "u0", role: "user", content: "hi" },
      { id: "a0", role: "assistant", content: "hello", model: "claude-x", latencyMs: 1200, costCents: 500,
        usagePromptTokens: 100_000, usageCompletionTokens: 2_000, cacheReadTokens: 40_000, cacheCreationTokens: 300, cacheCreation1hTokens: 20 },
    ], { projectPath: PROJECT });
    const measured = () => {
      const profile = computeProfileStats(ctx.db);
      return { cost: profile.cost, tokens: profile.tokens, projects: projectUsage(ctx.db).totals };
    };
    const before = measured();
    const branch = (await (await fork(t)).json()) as Topic;
    expect(measured()).toEqual(before);
    const answer = ctx.loadActiveThread(branch.sessionKey)[1];
    expect(answer).toMatchObject({ content: "hello", model: "claude-x", latencyMs: 1200 });
    for (const field of ["costCents", "usagePromptTokens", "usageCompletionTokens", "cacheReadTokens", "cacheCreationTokens", "cacheCreation1hTokens"] as const) {
      expect(answer[field] ?? null).toBeNull();
    }
  });

  test("a partial row at the tail is not copied", async () => {
    const t = chat([...turns(2), { id: "p", role: "assistant", content: "half", partial: true, parentId: "a1" }]);
    const branch = (await (await fork(t)).json()) as Topic;
    const copied = ctx.loadActiveThread(branch.sessionKey);
    expect(copied.map((m) => m.content)).toEqual(["prompt 0", "answer 0", "prompt 1", "answer 1"]);
    expect(copied.some((m) => m.partial)).toBe(false);
  });

  test("a background notice at the tail is not the point, and is not copied", async () => {
    const blocks = [{ kind: "background-notice", event: "deferred", change: "model", text: "later" }] as ContentBlock[];
    const t = chat([...turns(2), { id: "n", role: "assistant", content: "", blocks }]);
    const branch = (await (await fork(t)).json()) as Topic;
    const copied = ctx.loadActiveThread(branch.sessionKey);
    expect(copied).toHaveLength(4);
    expect(branch.forkedFrom?.atMessageId).toBe(copied[3].id);
    expect(copied[3].content).toBe("answer 1");
  });
});

describe("every refusal comes before the first write", () => {
  test("a turn in flight: 409 turn_in_progress, nothing created, nothing moved", async () => {
    const t = chat(turns(1));
    const before = [topicCount(), rowsOf(t.sessionKey)];
    ctx.startStream(t.sessionKey, `${t.sessionKey}:a0`);
    try {
      const res = await fork(t);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "turn_in_progress" });
    } finally {
      ctx.endStream(t.sessionKey);
    }
    expect([topicCount(), rowsOf(t.sessionKey)]).toEqual(before);
  });

  test("the global coordinator: 403", async () => {
    const t = chat(turns(1), { provider: "codex" });
    ctx.db.prepare("INSERT INTO global_orchestrator_sessions (scope, topic_id, created_at, updated_at) VALUES ('global', ?, 'now', 'now')").run(t.id);
    try {
      const res = await fork(t);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "orchestrator_topic_invariant" });
    } finally {
      ctx.db.prepare("DELETE FROM global_orchestrator_sessions").run();
    }
  });

  test("a runtime with no way to carry the memory: 409 fork_unsupported", async () => {
    const t = chat(turns(1), { provider: "openclaw" });
    const before = topicCount();
    const res = await fork(t);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "fork_unsupported" });
    expect(topicCount()).toBe(before);
  });

  test("a provider that does not resolve (not connected): 409 fork_unsupported, nothing created", async () => {
    const t = chat(turns(1), { provider: "gone" });
    const refusing = createForkRouter(ctx, { resolveProvider: () => { throw new Error('Provider "gone" non disponibile.'); } });
    const url = new URL(`http://h/api/topics/${t.id}/fork`);
    const before = topicCount();
    const res = await refusing(new Request(url, { method: "POST", body: "{}" }), url, url.pathname, "POST");
    expect(res?.status).toBe(409);
    expect(await res!.json()).toMatchObject({ code: "fork_unsupported" });
    expect(topicCount()).toBe(before);
  });

  test("no finished answer: 400 nothing_to_fork; unknown topic: 404", async () => {
    const t = chat([{ id: "u0", role: "user", content: "hello?" }]);
    const res = await fork(t);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "nothing_to_fork" });
    expect((await fork({ ...t, id: "missing" })).status).toBe(404);
  });
});

describe("each runtime's memory", () => {
  test("claude-cli, parent's memory matching the copy: the branch session is minted and bound to the fork", async () => {
    const t = claudeParent(turns(2), "answer 1", "uuid-of-answer-1");
    const branch = (await (await fork(t)).json()) as Topic;
    const origin = readForkOrigin(ctx.db, branch.sessionKey)!;
    expect(origin).toMatchObject({ runtime: "claude-cli", parentRef: sessionOf(t.sessionKey)!.claude_session_id, parentAt: "uuid-of-answer-1" });
    expect(sessionOf(branch.sessionKey)).toEqual({ claude_session_id: origin.branchRef!, import_offset: null });
  });

  test("claude-cli, an answer that produced a media file: the MEDIA line Topics appended is not the transcript being ahead, the branch forks", async () => {
    const t = claudeParent(turns(2), "answer 1", "uuid-of-the-media-answer");
    ctx.updateLastMessageWithMedia(t.sessionKey, [join(PROJECT, "chart.png")]);
    expect(ctx.loadActiveThread(t.sessionKey).at(-1)!.content).toContain("\nMEDIA:");
    const branch = (await (await fork(t)).json()) as Topic;
    expect(readForkOrigin(ctx.db, branch.sessionKey)).toMatchObject({ runtime: "claude-cli", parentRef: sessionOf(t.sessionKey)!.claude_session_id, parentAt: "uuid-of-the-media-answer" });
  });

  test("claude-cli, the minted branch session waits for its fork: the boot sweep of orphaned transcripts skips it until the fork is consumed", async () => {
    const t = claudeParent(turns(2), "answer 1", "uuid-of-answer-1");
    const branch = (await (await fork(t)).json()) as Topic;
    const branchRef = readForkOrigin(ctx.db, branch.sessionKey)!.branchRef!;
    expect(pendingForkSessions(ctx.db).has(branchRef)).toBe(true);
    consumeFork(ctx.db, branch.sessionKey);
    expect(pendingForkSessions(ctx.db).has(branchRef)).toBe(false);
  });

  test("claude-cli, a parent moved to another project after its turns: its transcript is found where it is, and the branch forks", async () => {
    const t = claudeParent(turns(2), "answer 1", "uuid-before-the-move", PREVIOUS_PROJECT);
    const branch = (await (await fork(t)).json()) as Topic;
    expect(readForkOrigin(ctx.db, branch.sessionKey)).toMatchObject({ parentRef: sessionOf(t.sessionKey)!.claude_session_id, parentAt: "uuid-before-the-move" });
  });

  const noFork = async (t: Topic) => {
    const branch = (await (await fork(t)).json()) as Topic;
    expect(readForkOrigin(ctx.db, branch.sessionKey)).toMatchObject({ runtime: "claude-cli", parentRef: null, parentAt: null, branchRef: null });
    expect(sessionOf(branch.sessionKey)).toBeNull();
    return branch;
  };

  test("claude-cli, parent without a session: no fork, no session row (the spawn mints one with the recap)", async () => {
    await noFork(chat(turns(2), { provider: "claude-code", projectPath: PROJECT }));
  });

  test("claude-cli, a regenerated answer on the active branch: no fork", async () => {
    const t = claudeParent([...turns(2), { id: "a1r", role: "assistant", content: "answer 1 again", parentId: "u1", branchIndex: 1 }], "answer 1 again");
    ctx.db.prepare("INSERT INTO active_branches (parent_id, session_key, active_branch_index) VALUES (?, ?, 1)").run(`${t.sessionKey}:u1`, t.sessionKey);
    await noFork(t);
  });

  test("claude-cli, a turn cut at the tail (a prompt and a partial row): the copy ends at the answer, no fork", async () => {
    const t = claudeParent([...turns(2), { id: "u2", role: "user", content: "prompt 2" }, { id: "p", role: "assistant", content: "half", partial: true }], "answer 1");
    const branch = await noFork(t);
    expect(ctx.loadActiveThread(branch.sessionKey).map((m) => m.content).at(-1)).toBe("answer 1");
  });

  test("claude-cli, the transcript ahead of the database: no fork", async () => {
    await noFork(claudeParent(turns(2), "a turn made from the terminal"));
  });

  test("codex-cli: the parent's thread and rollout size, no Claude session", async () => {
    const t = chat(turns(1), { provider: "codex" });
    const branch = (await (await fork(t)).json()) as Topic;
    expect(readForkOrigin(ctx.db, branch.sessionKey)).toEqual({ runtime: "codex-cli", parentRef: "thread-parent", parentAt: "4242", branchRef: null });
    expect(sessionOf(branch.sessionKey)).toBeNull();
  });

  test("db-history: the native branch reads the 4 copied rows, tool calls included", async () => {
    const tool = { id: "tc1", name: "Read", args: { path: "a.ts" }, status: "success", result: "x = 1" };
    const t = chat([
      { id: "u0", role: "user", content: "read a.ts" },
      { id: "a0", role: "assistant", content: "Read it.", toolCalls: [tool] as never, blocks: [{ kind: "tool", toolCall: tool }] as never },
      { id: "u1", role: "user", content: "and then?" },
      { id: "a1", role: "assistant", content: "Done." },
    ], { provider: "topics" });
    const branch = (await (await fork(t)).json()) as Topic;
    expect(readForkOrigin(ctx.db, branch.sessionKey)).toMatchObject({ runtime: "db-history", parentRef: null });
    const history = nativeHistorySource(ctx, branch.sessionKey);
    expect(history).toHaveLength(4);
    expect(history[1].toolCalls?.[0]).toMatchObject({ id: "tc1", result: "x = 1" });
  });
});

describe("/clear on a branch", () => {
  test("consumes the fork: a Codex branch emptied before its first turn does not fork at the next", async () => {
    registerProvider({ type: "codex" } as never);
    try {
      const t = chat(turns(1), { provider: "codex" });
      const branch = (await (await fork(t)).json()) as Topic;
      expect(readForkOrigin(ctx.db, branch.sessionKey)?.parentRef).toBe("thread-parent");
      const { createTopicsRouter } = await import("../../server/routes/topics");
      const topics = createTopicsRouter(ctx);
      const url = new URL("http://h/api/command");
      const res = await topics(new Request(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "clear", sessionKey: branch.sessionKey }),
      }), url, url.pathname, "POST");
      expect(res?.status).toBe(200);
      expect(readForkOrigin(ctx.db, branch.sessionKey)).toMatchObject({ runtime: "codex-cli", parentRef: null, parentAt: null });
      // The route backs the emptied chat up under the repo's `backups/`: this test's copy goes.
      const prefix = `${branch.sessionKey.replace(/[^a-zA-Z0-9]/g, "_")}_`;
      for (const f of readdirSync(join(PROJECT_ROOT, "backups"))) if (f.startsWith(prefix)) rmSync(join(PROJECT_ROOT, "backups", f));
    } finally {
      removeProvider("codex");
    }
  });
});
