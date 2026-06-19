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
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AppContext, StoredMessage, Topic, TopicsData } from "../types";
import { assembleTopicContext } from "./assemble";

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

describe("assembleTopicContext — marker stripping", () => {
  const baseDir = join(ROOT, "markers", "base");
  const openclawDir = join(ROOT, "markers", "openclaw");
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });

  const topic = makeTopic();
  const messages: StoredMessage[] = [
    makeMessage("u1", "user", "hello {{BROWSER:http://localhost:3000}} world"),
    makeMessage("a1", "assistant", "ack"),
    makeMessage("a2", "assistant", "opening {{PROJECT_OPEN:Pix}} now"),
  ];

  const ctx = makeMockCtx({ baseDir, openclawDir, topic, messages });
  const env = assembleTopicContext(ctx, {
    sessionKey: topic.sessionKey,
    providerName: "claude",
    includeLastUserInHistory: true,
  });

  it("history content has the marker stripped", () => {
    expect(env.history[0].content).not.toContain("{{BROWSER:");
    expect(env.history[0].content).toContain("hello");
    expect(env.history[0].content).toContain("world");
  });

  it("diagnostics expose the stripped marker for that message", () => {
    const e = env.diagnostics.historyEntries.find((x) => x.storedMessageId === "u1")!;
    expect(e.strippedMarkers).toContain("{{BROWSER:http://localhost:3000}}");
    expect(e.bytesDropped).toBeGreaterThan(0);
    expect(e.excluded).toBe(false);
  });

  it("strips and reports PROJECT_OPEN markers (audit #4 leak regression)", () => {
    const a2 = env.history.find((m) => m.content.includes("opening"))!;
    expect(a2.content).not.toContain("{{PROJECT_OPEN");
    const e = env.diagnostics.historyEntries.find((x) => x.storedMessageId === "a2")!;
    expect(e.strippedMarkers).toContain("{{PROJECT_OPEN:Pix}}");
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
