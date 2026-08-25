/**
 * Unit tests for `assembleTopicContext`.
 *
 * Strategy:
 * - Use a temporary directory rooted under `os.tmpdir()` for both `BASE_DIR`
 *   (memory/) and `OPENCLAW_DIR` (workspace/) so we exercise the real `fs`
 *   reads instead of mocking them.
 * - Build a minimal `AppContext` mock exposing only the methods/properties
 *   `assembleTopicContext` actually consumes.
 * - Each test owns its own tmpdir; cleanup in `afterAll`.
 * @covers CTX-GOAL-01
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AppContext, StoredMessage, Topic, TopicsData } from "../types";
import { assembleTopicContext } from "./assemble";
import { replaceSteps, setGoal } from "../services/goals";
import { initDatabase, closeDatabase } from "../db";
import { updateAppSettings } from "../services/app-settings";
import { languageDirective } from "../lib/topics-agent-prompt";

/** La radice del repo: `initDatabase` legge da lì `server/db/migrations`. */
const PROJECT_ROOT_FOR_MIGRATIONS = join(import.meta.dir, "..", "..");

/**
 * Un DB vero, ma solo con lo schema che serve: `pushGoalBlock` interroga
 * `ctx.db`, e un mock senza database renderebbe verde un blocco che in
 * produzione non si accende mai.
 */
function makeGoalsDb(): Database {
  const db = new Database(":memory:");
  db.run(readFileSync(join(import.meta.dir, "..", "db", "migrations", "064-topic-goals.sql"), "utf-8"));
  return db;
}

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const ROOT = join(tmpdir(), `assemble-test-${process.pid}-${Date.now()}`);

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: overrides.id ?? "topic-1",
    name: overrides.name ?? "My Topic",
    slug: overrides.slug ?? "my-topic",
    parentId: null,
    links: [],
    sessionKey: overrides.sessionKey ?? "topic:abc123",
    color: "#5865f2",
    icon: "MessageSquare",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    archived: false,
    ...overrides,
  };
}

function makeMessage(
  id: string,
  role: "user" | "assistant",
  content: string,
  extra: Partial<StoredMessage> = {},
): StoredMessage {
  return {
    id,
    role,
    content,
    timestamp: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

function makeMockCtx(opts: {
  baseDir: string;
  openclawDir: string;
  topic: Topic | null;
  messages: StoredMessage[];
  topicsData?: TopicsData;
  projectDir?: string;
  db?: Database;
}): AppContext {
  const topicsData = opts.topicsData ?? {
    topics: opts.topic ? { [opts.topic.id]: opts.topic } : {},
  };
  return {
    BASE_DIR: opts.baseDir,
    OPENCLAW_DIR: opts.openclawDir,
    getTopicBySessionKey: (sk: string) => (opts.topic && opts.topic.sessionKey === sk ? opts.topic : null),
    loadLocalMessages: (_sk: string) => opts.messages,
    loadTopics: () => topicsData,
    resolveTopicCwd: () => opts.projectDir ?? null,
    db: opts.db ?? makeGoalsDb(),
  } as unknown as AppContext;
}

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("assembleTopicContext — minimal topic", () => {
  const baseDir = join(ROOT, "minimal", "base");
  const openclawDir = join(ROOT, "minimal", "openclaw");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });

  const topic = makeTopic();
  const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages: [] });

  const env = assembleTopicContext(ctx, {
    sessionKey: topic.sessionKey,
    providerName: "claude",
    providerStrategy: "history-aware",
  });

  it("emits the topics-app synthetic blocks even when nothing is configured", () => {
    const ids = env.systemBlocks.map((b) => b.id);
    expect(ids).toContain("synthetic:browser-instruction");
    expect(ids).toContain("synthetic:project-markers");
    expect(ids).toContain("synthetic:topic-switch-directory");
  });

  it("does NOT emit prompt/file/template/memory/pinned/plan blocks", () => {
    const ids = env.systemBlocks.map((b) => b.id);
    expect(ids).not.toContain("prompt:system");
    expect(ids.some((id) => id.startsWith("file:"))).toBe(false);
    expect(ids.some((id) => id.startsWith("template:"))).toBe(false);
    expect(ids).not.toContain("memory:global");
    expect(ids).not.toContain("memory:topic");
    expect(ids).not.toContain("pinned:messages");
    expect(ids).not.toContain("synthetic:plan-mode");
  });

  it("history is empty and droppedHistoryTurns is 0", () => {
    expect(env.history).toEqual([]);
    expect(env.diagnostics.droppedHistoryTurns).toBe(0);
  });

  it("totalTokens equals the sum of enabled+countInBudget block tokens", () => {
    const expected = env.systemBlocks
      .filter((b) => b.enabled && b.countInBudget)
      .reduce((s, b) => s + b.tokens, 0);
    expect(env.diagnostics.totalTokens).toBe(expected);
  });

  it("provider strategy is propagated", () => {
    expect(env.providerStrategy).toBe("history-aware");
    expect(env.providerName).toBe("claude");
  });
});

describe("assembleTopicContext — system prompt block", () => {
  const baseDir = join(ROOT, "prompt", "base");
  const openclawDir = join(ROOT, "prompt", "openclaw");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });

  const topic = makeTopic({ systemPrompt: "You are a brisk assistant." });
  const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages: [] });

  const env = assembleTopicContext(ctx, {
    sessionKey: topic.sessionKey,
    providerName: "claude",
  });

  const block = env.systemBlocks.find((b) => b.id === "prompt:system");

  it("creates an editable prompt:system block with the configured content", () => {
    expect(block).toBeDefined();
    expect(block!.content).toBe("You are a brisk assistant.");
    expect(block!.editable).toBe(true);
    expect(block!.injectedByTopicsApp).toBe(true);
    expect(block!.category).toBe("prompt");
  });
});

describe("assembleTopicContext — disabledContextSources", () => {
  const baseDir = join(ROOT, "disabled", "base");
  const openclawDir = join(ROOT, "disabled", "openclaw");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });
  writeFileSync(join(baseDir, "memory", "_global.md"), "global memory content");

  const topic = makeTopic({ disabledContextSources: ["memory:global"] });
  const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages: [] });

  const env = assembleTopicContext(ctx, {
    sessionKey: topic.sessionKey,
    providerName: "claude",
  });

  it("memory:global is present but enabled=false", () => {
    const block = env.systemBlocks.find((b) => b.id === "memory:global");
    expect(block).toBeDefined();
    expect(block!.enabled).toBe(false);
  });

  it("disabled blocks do NOT count toward totalTokens", () => {
    const memBlock = env.systemBlocks.find((b) => b.id === "memory:global")!;
    const tokensWithoutDisabled = env.systemBlocks
      .filter((b) => b.enabled && b.countInBudget)
      .reduce((s, b) => s + b.tokens, 0);
    expect(env.diagnostics.totalTokens).toBe(tokensWithoutDisabled);
    // Sanity: the memory block had tokens > 0 but was excluded.
    expect(memBlock.tokens).toBeGreaterThan(0);
  });
});

describe("assembleTopicContext — .claude/CLAUDE.md fallback", () => {
  const baseDir = join(ROOT, "fallback", "base");
  const openclawDir = join(ROOT, "fallback", "openclaw");
  const projectDir = join(ROOT, "fallback", "project");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  writeFileSync(join(projectDir, ".claude", "CLAUDE.md"), "fallback content");

  const topic = makeTopic({ projectPath: projectDir });
  const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages: [], projectDir });

  const env = assembleTopicContext(ctx, {
    sessionKey: topic.sessionKey,
    providerName: "claude",
  });

  it("uses the .claude/CLAUDE.md label when no root CLAUDE.md exists", () => {
    const block = env.systemBlocks.find((b) => b.id === "template:CLAUDE.md");
    expect(block).toBeDefined();
    expect(block!.label).toBe(".claude/CLAUDE.md");
    expect(block!.content).toBe("fallback content");
  });

  it("includes the project-awareness synthetic template block", () => {
    const aware = env.systemBlocks.find((b) => b.id === "template:project-awareness");
    expect(aware).toBeDefined();
    expect(aware!.content).toContain("project");
  });
});

describe("assembleTopicContext — worktree-bound awareness path", () => {
  // The provider spawns every session in a global workspace cwd, so the
  // awareness sentence is how the agent learns WHERE to work. For a
  // worktree-bound topic it must point at the worktree absPath, NOT the live
  // checkout (regression: a dispatched agent wrote into the main repo).
  const baseDir = join(ROOT, "wt", "base");
  const openclawDir = join(ROOT, "wt", "openclaw");
  const liveRepo = join(ROOT, "wt", "live-repo");
  const worktreeDir = join(ROOT, "wt", "worktrees", "falcon");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });
  mkdirSync(liveRepo, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });

  const topic = makeTopic({ projectPath: liveRepo, worktreeId: "wt-1" });
  // resolveTopicCwd resolves a READY worktree to its absPath (utils.ts).
  const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages: [], projectDir: worktreeDir });

  const env = assembleTopicContext(ctx, {
    sessionKey: topic.sessionKey,
    providerName: "claude",
  });

  it("awareness points at the worktree, never the live checkout", () => {
    const aware = env.systemBlocks.find((b) => b.id === "template:project-awareness")!;
    expect(aware.content).toContain(worktreeDir);
    expect(aware.content).toContain("ISOLATED git worktree");
    expect(aware.content).not.toContain(`at ${liveRepo}`);
  });

  it("keeps the human-friendly project name from the live checkout", () => {
    const aware = env.systemBlocks.find((b) => b.id === "template:project-awareness")!;
    expect(aware.content).toContain('"live-repo"');
  });
});

describe("assembleTopicContext — history truncation at limit", () => {
  const baseDir = join(ROOT, "trunc", "base");
  const openclawDir = join(ROOT, "trunc", "openclaw");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });

  const topic = makeTopic();

  // 150 stored messages: 75 user / 75 assistant alternating.
  const messages: StoredMessage[] = [];
  for (let i = 0; i < 150; i++) {
    messages.push(makeMessage(`msg-${i}`, i % 2 === 0 ? "user" : "assistant", `msg ${i}`));
  }

  const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages });
  const env = assembleTopicContext(ctx, {
    sessionKey: topic.sessionKey,
    providerName: "claude",
    historyLimit: 100,
    includeLastUserInHistory: true,
  });

  it("history.length === 100", () => {
    expect(env.history.length).toBe(100);
  });

  it("droppedHistoryTurns === 50", () => {
    expect(env.diagnostics.droppedHistoryTurns).toBe(50);
  });

  it("first 50 historyEntries are excluded with reason 'limit'", () => {
    const limitDropped = env.diagnostics.historyEntries.filter(
      (e) => e.excluded && e.excludeReason === "limit",
    );
    expect(limitDropped.length).toBe(50);
  });

  it("last 100 historyEntries are NOT excluded", () => {
    const tail = env.diagnostics.historyEntries.slice(-100);
    for (const e of tail) {
      expect(e.excluded).toBe(false);
    }
  });
});


describe("assembleTopicContext — partial messages excluded", () => {
  const baseDir = join(ROOT, "partial", "base");
  const openclawDir = join(ROOT, "partial", "openclaw");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });

  const topic = makeTopic();
  const messages: StoredMessage[] = [
    makeMessage("u1", "user", "hello"),
    makeMessage("a1", "assistant", "in flight…", { partial: true }),
  ];

  const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages });
  const env = assembleTopicContext(ctx, {
    sessionKey: topic.sessionKey,
    providerName: "claude",
    includeLastUserInHistory: true,
  });

  it("partial message is excluded with reason 'partial'", () => {
    const e = env.diagnostics.historyEntries.find((x) => x.storedMessageId === "a1")!;
    expect(e.excluded).toBe(true);
    expect(e.excludeReason).toBe("partial");
    expect(env.history.find((h) => h.content === "in flight…")).toBeUndefined();
  });
});

describe("assembleTopicContext — context-message prefix excluded", () => {
  const baseDir = join(ROOT, "ctxmsg", "base");
  const openclawDir = join(ROOT, "ctxmsg", "openclaw");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });

  const topic = makeTopic();
  const messages: StoredMessage[] = [
    makeMessage("u1", "user", "hello"),
    makeMessage("a1", "assistant", "[Chat messages since your last reply: 2]\nfoo"),
  ];

  const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages });
  const env = assembleTopicContext(ctx, {
    sessionKey: topic.sessionKey,
    providerName: "claude",
    includeLastUserInHistory: true,
  });

  it("legacy openclaw envelope marker → excluded with 'context-message'", () => {
    const e = env.diagnostics.historyEntries.find((x) => x.storedMessageId === "a1")!;
    expect(e.excluded).toBe(true);
    expect(e.excludeReason).toBe("context-message");
  });
});

describe("assembleTopicContext — includeLastUserInHistory: false", () => {
  const baseDir = join(ROOT, "lastuser", "base");
  const openclawDir = join(ROOT, "lastuser", "openclaw");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });

  const topic = makeTopic();
  const messages: StoredMessage[] = [
    makeMessage("u1", "user", "first"),
    makeMessage("a1", "assistant", "ack 1"),
    makeMessage("u2", "user", "second (the most recent user turn)"),
  ];

  const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages });
  const env = assembleTopicContext(ctx, {
    sessionKey: topic.sessionKey,
    providerName: "claude",
    includeLastUserInHistory: false,
  });

  it("last user is excluded with 'duplicate-last-user'", () => {
    const e = env.diagnostics.historyEntries.find((x) => x.storedMessageId === "u2")!;
    expect(e.excluded).toBe(true);
    expect(e.excludeReason).toBe("duplicate-last-user");
  });

  it("history does not contain the last user turn", () => {
    expect(env.history.find((h) => h.content.includes("second (the most recent"))).toBeUndefined();
  });

  it("userMessage falls back to the last user turn from DB", () => {
    expect(env.userMessage.content).toContain("second");
    expect(env.userMessage.messageId).toBe("u2");
  });
});

describe("assembleTopicContext — userMessageOverride wins", () => {
  const baseDir = join(ROOT, "override", "base");
  const openclawDir = join(ROOT, "override", "openclaw");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });

  const topic = makeTopic();
  const messages: StoredMessage[] = [
    makeMessage("u1", "user", "old turn"),
  ];

  const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages });
  const env = assembleTopicContext(ctx, {
    sessionKey: topic.sessionKey,
    providerName: "claude",
    userMessageOverride: { content: "fresh turn", messageId: "u-new" },
  });

  it("envelope.userMessage matches the override", () => {
    expect(env.userMessage.content).toBe("fresh turn");
    expect(env.userMessage.messageId).toBe("u-new");
  });
});

describe("assembleTopicContext — OpenClaw informational blocks", () => {
  const baseDir = join(ROOT, "openclaw-info", "base");
  const openclawDir = join(ROOT, "openclaw-info", "openclaw");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  const wsDir = join(openclawDir, "workspace");
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, "SOUL.md"), "soul content");
  writeFileSync(join(wsDir, "MEMORY.md"), "memory content");

  const topic = makeTopic();
  const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages: [] });

  it("provider=openclaw → workspace files appear (gateway will inject them)", () => {
    const env = assembleTopicContext(ctx, {
      sessionKey: topic.sessionKey,
      providerName: "openclaw",
      providerStrategy: "gateway-stateful",
    });
    const ids = env.systemBlocks.map((b) => b.id);
    expect(ids).toContain("openclaw:SOUL.md");
    expect(ids).toContain("openclaw:MEMORY.md");
    expect(ids).not.toContain("openclaw:USER.md");      // file not present on disk
  });

  it("workspace blocks are NOT injected by topics-app (informational)", () => {
    const env = assembleTopicContext(ctx, {
      sessionKey: topic.sessionKey,
      providerName: "openclaw",
      providerStrategy: "gateway-stateful",
    });
    const soul = env.systemBlocks.find((b) => b.id === "openclaw:SOUL.md")!;
    expect(soul.injectedByTopicsApp).toBe(false);
    expect(soul.editable).toBe(false);
  });

  it("provider=claude → workspace files are HIDDEN (gateway not in play)", () => {
    const env = assembleTopicContext(ctx, {
      sessionKey: topic.sessionKey,
      providerName: "claude",
      providerStrategy: "history-aware",
    });
    const ids = env.systemBlocks.map((b) => b.id);
    expect(ids).not.toContain("openclaw:SOUL.md");
    expect(ids).not.toContain("openclaw:MEMORY.md");
    expect(ids).not.toContain("openclaw:memory-tree");
  });

  it("provider=claude-code → workspace files are HIDDEN", () => {
    const env = assembleTopicContext(ctx, {
      sessionKey: topic.sessionKey,
      providerName: "claude-code",
      providerStrategy: "inline-system",
    });
    expect(env.systemBlocks.find((b) => b.id === "openclaw:SOUL.md")).toBeUndefined();
  });
});

describe("assembleTopicContext — pinned messages aggregate", () => {
  const baseDir = join(ROOT, "pinned", "base");
  const openclawDir = join(ROOT, "pinned", "openclaw");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });

  const topic = makeTopic({ pinnedMessages: ["u1", "a1"] });
  const messages: StoredMessage[] = [
    makeMessage("u1", "user", "important question"),
    makeMessage("a1", "assistant", "important answer"),
  ];
  const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages });
  const env = assembleTopicContext(ctx, {
    sessionKey: topic.sessionKey,
    providerName: "claude",
  });

  it("creates a pinned:messages block aggregating both pins", () => {
    const pin = env.systemBlocks.find((b) => b.id === "pinned:messages");
    expect(pin).toBeDefined();
    expect(pin!.content).toContain("important question");
    expect(pin!.content).toContain("important answer");
    expect(pin!.label).toBe("Pinned Messages (2)");
  });
});

describe("assembleTopicContext — planMode flag", () => {
  const baseDir = join(ROOT, "plan", "base");
  const openclawDir = join(ROOT, "plan", "openclaw");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });

  const topic = makeTopic();
  const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages: [] });

  it("planMode: true → synthetic:plan-mode block present", () => {
    const env = assembleTopicContext(ctx, {
      sessionKey: topic.sessionKey,
      providerName: "claude",
      planMode: true,
    });
    expect(env.systemBlocks.find((b) => b.id === "synthetic:plan-mode")).toBeDefined();
  });

  it("planMode default → block absent", () => {
    const env = assembleTopicContext(ctx, {
      sessionKey: topic.sessionKey,
      providerName: "claude",
    });
    expect(env.systemBlocks.find((b) => b.id === "synthetic:plan-mode")).toBeUndefined();
  });
});

describe("assembleTopicContext — fastMode flag (chat-fast-mode)", () => {
  const baseDir = join(ROOT, "fast", "base");
  const openclawDir = join(ROOT, "fast", "openclaw");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });

  const topic = makeTopic();

  it("fastMode: true → diagnostics.fastMode === true, sessionMeta.fastMode === true", () => {
    const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages: [] });
    const env = assembleTopicContext(ctx, {
      sessionKey: topic.sessionKey,
      providerName: "claude-code",
      fastMode: true,
    });
    expect(env.diagnostics.fastMode).toBe(true);
    expect(env.sessionMeta?.fastMode).toBe(true);
  });

  it("fastMode default → diagnostics.fastMode === false", () => {
    const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages: [] });
    const env = assembleTopicContext(ctx, {
      sessionKey: topic.sessionKey,
      providerName: "claude-code",
    });
    expect(env.diagnostics.fastMode).toBe(false);
    expect(env.sessionMeta?.fastMode).toBe(false);
  });

  it("fastMode does NOT alter systemBlocks or history", () => {
    const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages: [] });
    const off = assembleTopicContext(ctx, {
      sessionKey: topic.sessionKey,
      providerName: "claude-code",
      fastMode: false,
    });
    const on = assembleTopicContext(ctx, {
      sessionKey: topic.sessionKey,
      providerName: "claude-code",
      fastMode: true,
    });
    // System blocks: identical ids in identical order. Tokens can differ
    // (file mtimes flip cache windows) but the *shape* must not move.
    expect(on.systemBlocks.map((b) => b.id)).toEqual(off.systemBlocks.map((b) => b.id));
    // History identical (same DB state, no synthetic injection).
    expect(on.history).toEqual(off.history);
    // No "synthetic:fast-mode" pseudo-block: fast mode only affects the
    // model selection downstream, not what the model sees.
    expect(on.systemBlocks.find((b) => b.id.startsWith("synthetic:fast-mode"))).toBeUndefined();
  });
});

describe("assembleTopicContext — leanContext (dispatcher resume/continuation)", () => {
  const baseDir = join(ROOT, "lean", "base");
  const openclawDir = join(ROOT, "lean", "openclaw");
  const projectDir = join(ROOT, "lean", "project");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "CLAUDE.md"), "# Heavy project doc\n".repeat(50));
  writeFileSync(join(baseDir, "memory", "_global.md"), "global memory content");

  const topic = makeTopic({ systemPrompt: "Role: task agent.", projectPath: projectDir });
  const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages: [], projectDir });

  const full = assembleTopicContext(ctx, {
    sessionKey: topic.sessionKey,
    providerName: "claude-code",
  });
  const lean = assembleTopicContext(ctx, {
    sessionKey: topic.sessionKey,
    providerName: "claude-code",
    leanContext: true,
  });

  it("lean emits ONLY the role prompt + project-awareness sentence", () => {
    const ids = lean.systemBlocks.map((b) => b.id).sort();
    expect(ids).toEqual(["prompt:system", "template:project-awareness"]);
  });

  it("lean drops the template files, browser/marker/topic-switch, memory & pinned", () => {
    const ids = lean.systemBlocks.map((b) => b.id);
    expect(ids).not.toContain("template:CLAUDE.md");
    expect(ids).not.toContain("synthetic:browser-instruction");
    expect(ids).not.toContain("synthetic:project-markers");
    expect(ids).not.toContain("synthetic:topic-switch-directory");
    expect(ids).not.toContain("memory:global");
  });

  it("lean keeps the load-bearing cwd in the awareness sentence", () => {
    const aware = lean.systemBlocks.find((b) => b.id === "template:project-awareness")!;
    expect(aware.content).toContain(projectDir);
  });

  it("lean costs far fewer tokens than the full envelope", () => {
    // The heavy CLAUDE.md alone dwarfs the two lean blocks.
    expect(lean.diagnostics.totalTokens).toBeLessThan(full.diagnostics.totalTokens);
    expect(full.systemBlocks.map((b) => b.id)).toContain("template:CLAUDE.md");
  });
});

describe("assembleTopicContext — graphify hint", () => {
  const baseDir = join(ROOT, "graphify", "base");
  const openclawDir = join(ROOT, "graphify", "openclaw");
  const projectDir = join(ROOT, "graphify", "project");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });
  mkdirSync(join(projectDir, "graphify-out"), { recursive: true });
  writeFileSync(join(projectDir, "graphify-out", "graph.json"), "{}");

  const topic = makeTopic({ projectPath: projectDir });
  const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages: [], projectDir });

  it("mentions graphify when graphify-out/graph.json exists in the project", () => {
    const env = assembleTopicContext(ctx, { sessionKey: topic.sessionKey, providerName: "claude-code" });
    const aware = env.systemBlocks.find((b) => b.id === "template:project-awareness")!;
    expect(aware.content).toContain("graphify");
    expect(aware.content).toContain(join(projectDir, "graphify-out", "graph.json"));
  });

  it("does not mention graphify when the graph is absent", () => {
    // NB: dir name must not itself contain "graphify" (the path is in the text).
    const bare = join(ROOT, "nohint", "plain-project");
    mkdirSync(bare, { recursive: true });
    const t2 = makeTopic({ sessionKey: "topic:nograph", projectPath: bare });
    const ctx2 = makeMockCtx({ baseDir, openclawDir, topic: t2, messages: [], projectDir: bare });
    const env = assembleTopicContext(ctx2, { sessionKey: t2.sessionKey, providerName: "claude-code" });
    const aware = env.systemBlocks.find((b) => b.id === "template:project-awareness")!;
    expect(aware.content).not.toContain("graphify");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3.4 — l'obiettivo della topic
// ────────────────────────────────────────────────────────────────────────────

describe("assembleTopicContext — blocco obiettivo", () => {
  const baseDir = join(ROOT, "goal", "base");
  const openclawDir = join(ROOT, "goal", "openclaw");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });

  const topic = makeTopic({ id: "topic-goal", sessionKey: "topic:goal" });

  function assemble(db: Database, opts: { leanContext?: boolean } = {}) {
    const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages: [], db });
    return assembleTopicContext(ctx, {
      sessionKey: topic.sessionKey,
      providerName: "claude",
      providerStrategy: "history-aware",
      ...opts,
    });
  }

  it("senza goal attivo non c'è nessun blocco", () => {
    const env = assemble(makeGoalsDb());
    expect(env.systemBlocks.map((b) => b.id)).not.toContain("synthetic:goal");
  });

  it("col goal attivo il blocco c'è e conta nel budget", () => {
    const db = makeGoalsDb();
    setGoal(db, { topicId: topic.id, content: "Sistemare il login" });
    const block = assemble(db).systemBlocks.find((b) => b.id === "synthetic:goal")!;
    expect(block).toBeDefined();
    expect(block.content).toContain("Sistemare il login");
    expect(block.enabled).toBe(true);
    expect(block.countInBudget).toBe(true);
    expect(block.editable).toBe(false);
    expect(block.tokens).toBeGreaterThan(0);
  });

  it("SOPRAVVIVE al turno lean — è tutto il motivo per cui esiste", () => {
    // Il turno lean è quello di ripresa del dispatcher: se l'obiettivo cadesse
    // proprio lì, cadrebbe esattamente quando il modello ha già perso il resto.
    const db = makeGoalsDb();
    setGoal(db, { topicId: topic.id, content: "Non perdermi dopo la compattazione" });
    const env = assemble(db, { leanContext: true });
    const ids = env.systemBlocks.map((b) => b.id);
    expect(ids).toContain("synthetic:goal");
    // Guardia contro il falso positivo: nel turno lean gli altri NON ci sono.
    expect(ids).not.toContain("synthetic:browser-instruction");
    expect(ids).not.toContain("memory:global");
  });

  it("i passi del piano entrano nel blocco, col loro stato", () => {
    const db = makeGoalsDb();
    const goal = setGoal(db, { topicId: topic.id, content: "Rilasciare la 2.3" });
    replaceSteps(db, goal.id, [
      { content: "Scrivere il changelog", status: "completed" },
      { content: "Taggare", status: "pending" },
    ]);
    const block = assemble(db).systemBlocks.find((b) => b.id === "synthetic:goal")!;
    expect(block.content).toContain("[x] Scrivere il changelog");
    expect(block.content).toContain("[ ] Taggare");
  });

  it("un goal chiuso esce dal contesto", () => {
    const db = makeGoalsDb();
    setGoal(db, { topicId: topic.id, content: "Fatto" });
    db.run("UPDATE topic_goals SET status = 'achieved' WHERE topic_id = ?", [topic.id]);
    expect(assemble(db).systemBlocks.map((b) => b.id)).not.toContain("synthetic:goal");
  });

  it("un DB senza la tabella non fa saltare l'assemblaggio", () => {
    // Prod non ci arriva (le migration girano al boot), ma un envelope che
    // esplode per un blocco accessorio sarebbe un guasto peggiore del blocco
    // mancante: il resto del contesto vale comunque.
    const env = assemble(new Database(":memory:"));
    expect(env.systemBlocks.map((b) => b.id)).not.toContain("synthetic:goal");
    expect(env.systemBlocks.length).toBeGreaterThan(0);
  });
});

/**
 * Il blocco della lingua — e soprattutto DOVE sta.
 *
 * La direttiva arriva a claude-code e ai PTY da `--append-system-prompt`, ma
 * codex, openai e gli agenti ACP quella via non ce l'hanno: per loro il blocco
 * sintetico è l'UNICA. Il rischio concreto della modifica era infilarlo dentro
 * il cancello `providerHasControlTools` insieme alle istruzioni del browser —
 * dove sarebbe stato saltato proprio dai provider che ne hanno bisogno, e
 * nessun test lo avrebbe notato perché su `claude` funziona. Quindi la prova
 * gira su un provider SENZA control tool.
 */
describe("assembleTopicContext — la lingua delle risposte", () => {
  const baseDir = join(ROOT, "lang", "base");
  const openclawDir = join(ROOT, "lang", "openclaw");
  const topic = makeTopic({ id: "topic-lang", sessionKey: "topic:lang" });

  beforeAll(() => {
    mkdirSync(join(baseDir, "memory"), { recursive: true });
    mkdirSync(join(openclawDir, "workspace"), { recursive: true });
    // Serve il DB VERO: la lingua vive in `app_settings` (migration 087) e il
    // blocco la legge da lì. Con il modulo db non inizializzato il servizio
    // ripiega su una riga tutta null — cioè 'auto' — e il test proverebbe solo
    // il ramo «nessun blocco».
    process.env.DATA_DIR = join(ROOT, "lang", "data");
    initDatabase(PROJECT_ROOT_FOR_MIGRATIONS);
  });

  afterAll(() => {
    try { closeDatabase(); } catch { /* già chiuso */ }
    delete process.env.DATA_DIR;
  });

  /** `providerName` deliberatamente senza control tool: è il caso che conta. */
  const assemble = () =>
    assembleTopicContext(
      makeMockCtx({ baseDir, openclawDir, topic, messages: [] }),
      { sessionKey: topic.sessionKey, providerName: "codex", providerStrategy: "history-aware" },
    );

  it("«auto» non emette NIENTE: un blocco vuoto sembrerebbe rotto", () => {
    updateAppSettings({ outputLanguage: null });
    expect(assemble().systemBlocks.map((b) => b.id)).not.toContain("synthetic:output-language");
    updateAppSettings({ outputLanguage: "auto" });
    expect(assemble().systemBlocks.map((b) => b.id)).not.toContain("synthetic:output-language");
  });

  it("una lingua scelta arriva a un provider SENZA control tool (il punto della modifica)", () => {
    updateAppSettings({ outputLanguage: "it" });
    const block = assemble().systemBlocks.find((b) => b.id === "synthetic:output-language");
    expect(block).toBeDefined();
    // Il testo è quello di `languageDirective`, non una copia scritta qui: se
    // divergessero, chat e contesto direbbero due cose diverse allo stesso
    // modello.
    expect(block!.content).toBe(languageDirective("it"));
    expect(block!.injectedByTopicsApp).toBe(true);
  });

  it("cambiare lingua cambia il blocco senza riavviare niente", () => {
    updateAppSettings({ outputLanguage: "en" });
    const block = assemble().systemBlocks.find((b) => b.id === "synthetic:output-language")!;
    expect(block.content).toBe(languageDirective("en"));
  });
});
