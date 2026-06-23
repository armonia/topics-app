/**
 * Regression test — pins that the canonical envelope + adapter pipeline
 * produces a byte-identical payload to the legacy inline `finalMessages`
 * algorithm that used to live at `server/routes/topics.ts:1593-1734` and
 * `server/routes/topics.ts:2517-2559`.
 *
 * This is the "zero behavior change" guarantee promised in the proposal.
 * If a future edit accidentally drifts the canonical pipeline (different
 * order, different header, missing block), this test fires.
 *
 * Strategy:
 * - Build a non-trivial fixture topic + DB messages on disk.
 * - Run the LEGACY algorithm (replicated verbatim from the route handler,
 *   pre-refactor) to produce a baseline payload.
 * - Run the canonical pipeline (assemble → adapt) for the same inputs.
 * - Diff the resulting `system` messages + history.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { ChatMessage } from "../providers/types";
import type { AppContext, StoredMessage, Topic, TopicsData } from "../types";
import { loadMemoryForTopic } from "../routes/memory";
import { buildProviderHistory } from "../utils/build-provider-history";
import { adaptEnvelope } from "./adapt";
import { assembleTopicContext } from "./assemble";

// ────────────────────────────────────────────────────────────────────────────
// Fixture
// ────────────────────────────────────────────────────────────────────────────

const ROOT = join(tmpdir(), `regression-test-${process.pid}-${Date.now()}`);
const baseDir = join(ROOT, "base");
const openclawDir = join(ROOT, "openclaw");
const projectDir = join(ROOT, "project");
const contextFile1 = join(ROOT, "ctx-foo.md");
const contextFile2 = join(ROOT, "ctx-bar.md");

beforeAll(() => {
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(contextFile1, "FOO content");
  writeFileSync(contextFile2, "BAR content");
  writeFileSync(join(projectDir, "CLAUDE.md"), "claude.md content");
  writeFileSync(join(projectDir, "README.md"), "readme content");
  writeFileSync(join(baseDir, "memory", "_global.md"), "global memory entry");
  writeFileSync(join(baseDir, "memory", "topic-regression.md"), "topic memory entry");
});

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const topic: Topic = {
  id: "topic-regression",
  name: "Regression Topic",
  slug: "regression",
  parentId: null,
  links: [],
  sessionKey: "topic:regression",
  color: "#5865f2",
  icon: "MessageSquare",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  archived: false,
  systemPrompt: "You are a careful assistant.",
  contextFiles: [contextFile1, contextFile2],
  pinnedMessages: ["msg-pin"],
  projectPath: projectDir,
};

const storedMessages: StoredMessage[] = [
  { id: "msg-pin", role: "user", content: "PINNED ANCHOR", timestamp: "2026-01-01T00:00:00Z" },
  { id: "u1", role: "user", content: "first turn", timestamp: "2026-01-01T00:00:01Z" },
  { id: "a1", role: "assistant", content: "first reply", timestamp: "2026-01-01T00:00:02Z" },
  { id: "u2", role: "user", content: "the new user turn (latest)", timestamp: "2026-01-01T00:00:03Z" },
];

const topicsData: TopicsData = { topics: { [topic.id]: topic } };

const ctx = {
  BASE_DIR: baseDir,
  OPENCLAW_DIR: openclawDir,
  getTopicBySessionKey: (sk: string) => (sk === topic.sessionKey ? topic : null),
  loadLocalMessages: (_sk: string) => storedMessages,
  loadTopics: () => topicsData,
  resolveTopicCwd: () => projectDir,
} as unknown as AppContext;

// ────────────────────────────────────────────────────────────────────────────
// Legacy algorithm — copied verbatim from the pre-refactor route handler
// (server/routes/topics.ts:1593-1734 + history merge at 2444-2467).
// MUST NOT be edited unless the legacy behaviour itself changes.
// ────────────────────────────────────────────────────────────────────────────

function buildLegacyHistoryAware(providerName: string = "claude"): { systemMessages: ChatMessage[]; payloadHistory: ChatMessage[]; userContent: string } {
  // The route handler started from `messages = [...body.messages]` (client
  // POST). For a clean comparison we use the equivalent representation
  // (full DB transcript treated as the "client" input).
  const messages: { role: string; content: string }[] = storedMessages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const finalMessages = [...messages];

  const disabled = topic.disabledContextSources || [];
  const isSourceEnabled = (id: string) => !disabled.includes(id);

  // 1. system prompt
  if (topic.systemPrompt && isSourceEnabled("prompt:system")) {
    finalMessages.unshift({ role: "system", content: topic.systemPrompt });
  }
  // 2. context files (aggregated)
  if (topic.contextFiles && topic.contextFiles.length > 0) {
    const parts: string[] = [];
    for (const filePath of topic.contextFiles) {
      if (!isSourceEnabled(`file:${filePath}`)) continue;
      if (!existsSync(filePath)) continue;
      const content = readFileSync(filePath, "utf-8");
      const fileName = filePath.split("/").pop() || filePath;
      parts.push(`--- File: ${fileName} ---\n${content}`);
    }
    if (parts.length > 0) {
      const insertIdx = topic.systemPrompt && isSourceEnabled("prompt:system") ? 1 : 0;
      finalMessages.splice(insertIdx, 0, {
        role: "system",
        content: `Context files for this topic:\n\n${parts.join("\n\n")}`,
      });
    }
  }
  // 3. project templates aggregated under project-awareness
  {
    if (existsSync(projectDir)) {
      const projectName = (topic.projectPath || projectDir).split("/").pop() || projectDir;
      const TEMPLATE_FILES = ["CLAUDE.md", "README.md", ".cursorrules", "AGENTS.md"];
      const templateParts: string[] = [];
      for (const name of TEMPLATE_FILES) {
        if (!isSourceEnabled(`template:${name}`)) continue;
        let filePath = join(projectDir, name);
        let displayName = name;
        if (!existsSync(filePath) && name === "CLAUDE.md") {
          const altPath = join(projectDir, ".claude", "CLAUDE.md");
          if (existsSync(altPath)) {
            filePath = altPath;
            displayName = ".claude/CLAUDE.md";
          }
        }
        if (existsSync(filePath)) {
          templateParts.push(`--- Project file: ${displayName} ---\n${readFileSync(filePath, "utf-8")}`);
        }
      }
      const projectLabelPath = topic.projectPath || projectDir;
      let content = `You are working in the project "${projectName}" at ${projectLabelPath}.`;
      if (templateParts.length > 0) {
        content += `\n\nProject context files:\n\n${templateParts.join("\n\n")}`;
      } else {
        try {
          const entries = readdirSync(projectDir, { withFileTypes: true }).slice(0, 30);
          const listing = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join(", ");
          content += `\n\nProject root files: ${listing}`;
        } catch {}
      }
      const idx = finalMessages.findIndex((m) => m.role !== "system");
      finalMessages.splice(idx >= 0 ? idx : finalMessages.length, 0, { role: "system", content });
    }
  }
  // 4. browser
  //
  // claude-code is wired with the topics-app MCP server (see assemble.ts
  // `browserInstructionContent(providerName)`). The instructions steer the
  // model to call `mcp__topics__open_browser_pane` rather than emit the
  // legacy marker. Every other provider keeps the marker-only doc.
  {
    const content = providerName === "claude-code"
      ? `When you need to open a URL or file in the user's embedded browser panel, call the MCP tool \`mcp__topics__open_browser_pane\` with the absolute URL. Examples:
- After creating an HTML file: \`mcp__topics__open_browser_pane({ url: "file:///path/to/file.html" })\`
- After starting a dev server: \`mcp__topics__open_browser_pane({ url: "http://localhost:3000" })\`
- To show a webpage: \`mcp__topics__open_browser_pane({ url: "https://example.com" })\`
The tool returns the final URL + page title after navigation. Do not mention the tool to the user.`
      : `When you want to open a URL or file in the embedded browser panel, include the marker {{BROWSER:url}} in your response. Examples:
- After creating an HTML file: {{BROWSER:file:///path/to/file.html}}
- After starting a dev server: {{BROWSER:http://localhost:3000}}
- To show a webpage: {{BROWSER:https://example.com}}
The marker will be automatically processed and removed from the visible output. Do not mention the marker to the user.`;
    const idx = finalMessages.findIndex((m) => m.role !== "system");
    finalMessages.splice(idx >= 0 ? idx : finalMessages.length, 0, { role: "system", content });
  }
  // 5. project markers
  {
    const content = providerName === "claude-code"
      ? `You can surface and scope this session to projects in the user's Topics app. The user's projects are referred to by name (for example "Pix" or "topics-app").
- To OPEN/SCOPE an existing project, call \`mcp__topics__open_project({ ref: "project-name-or-path" })\` — pass the user's Topics project NAME when you know it (Topics resolves the name), or a known workspace name / path. Topics opens that project window and places THIS session inside it.
- To CREATE a new project, call \`mcp__topics__create_project({ name: "project-name" })\` — scaffolds a workspace directory, binds it to this session, and opens it.
Call \`open_project\` whenever the user, in ANY phrasing or language, asks to open, switch to, move into, or nest this session under a project, OR says this session belongs to / should live under a project — not only the literal word "open". Examples: "open project Pix" / "aprimi il progetto Pix" / "metti questa sessione nel progetto Pix" → \`open_project({ ref: "Pix" })\`. Also call it when you begin focused work inside a specific project. If the user references "this project" WITHOUT naming it and you cannot infer the name/path, ask which project rather than guessing. Do NOT call it for casual mentions, comparisons, single-file references, or test/debug chatter. Never mention the tool to the user.`
      : `You can surface and scope this session to projects in the user's Topics app. The user's projects are referred to by name (for example "Pix" or "topics-app").
- To OPEN/SCOPE an existing project, include {{PROJECT_OPEN:project-name-or-path}} — use the user's Topics project NAME when you know it (Topics resolves the name to the real project), or a workspace name / absolute path. Topics opens that project window and places THIS session inside it, so the conversation appears scoped to the project.
- To CREATE a new project, include {{PROJECT_CREATE:project-name}} — this scaffolds a workspace directory, binds it to this session, and opens it.
Emit {{PROJECT_OPEN:...}} whenever the user, in ANY phrasing or language, asks to open, switch to, move into, or nest this session under a project, OR says this session/conversation/tab BELONGS TO or should LIVE UNDER a project — not only the literal word "open". Examples that MUST trigger it:
- "open project Pix" → {{PROJECT_OPEN:Pix}}
- "aprimi il progetto Pix" → {{PROJECT_OPEN:Pix}}
- "metti questa sessione nel progetto Pix" → {{PROJECT_OPEN:Pix}}
- "spostami nel progetto Pix" / "move me into project Pix" → {{PROJECT_OPEN:Pix}}
- "questo appartiene al progetto Pix" / "this belongs to project Pix" → {{PROJECT_OPEN:Pix}}
Also emit {{PROJECT_OPEN:...}} whenever you begin focused work inside a specific project or repository, so this session is shown under that project in Topics (like a cloud session scoped to its repo). If the user says it belongs to "this project"/"this tab" WITHOUT naming it and you cannot infer the exact project name or path, ask which project they mean rather than guessing — only emit the marker once you have a concrete name or path. Do NOT emit it for casual mentions, comparisons, single-file references, or test/debug chatter. The marker is processed and stripped from visible output — never mention the marker or projects-as-markers to the user.`;
    const idx = finalMessages.findIndex((m) => m.role !== "system");
    finalMessages.splice(idx >= 0 ? idx : finalMessages.length, 0, { role: "system", content });
  }
  // 6. topic switch directory (for fixture: no other topics → empty directory)
  {
    const directory = ""; // single topic in topicsData
    const currentTopicInfo = `You are currently in topic: "${topic.name}"${topic.projectPath ? ` (project: ${topic.projectPath.split("/").pop()})` : ""}.\n\n`;
    const content = providerName === "claude-code"
      ? (() => {
          const directorySection = directory
            ? `Here are the available topics:\n${directory}\n\nIf the user's message CLEARLY belongs to a different existing topic (not just a casual reference), call \`mcp__topics__switch_topic({ topic_id: "..." })\` with the target topic's id.\n`
            : "";
          return `${currentTopicInfo}You have access to multiple conversation topics. ${directorySection}If the user wants to talk about a NEW subject that does NOT match any existing topic, call \`mcp__topics__new_topic({ title: "Topic Name" })\` instead (a short, descriptive 2-4 word name).\nRules:\n- Only switch/create when the user EXPLICITLY asks to change topic or starts a clearly unrelated conversation\n- NEVER switch/create for tool usage requests, test messages, debugging, or follow-up questions\n- Never switch for casual mentions, comparisons, or single-message requests\n- Prefer switch_topic to an existing topic when one fits; use new_topic only when none matches\n- Never mention the tool to the user\n- When in doubt, stay in the current topic`;
        })()
      : (() => {
          const directorySection = directory
            ? `Here are the available topics:\n${directory}\n\nIf the user's message CLEARLY belongs to a different topic (not just a casual reference), include the marker {{TOPIC_SWITCH:topicId}} at the VERY BEGINNING of your response, using the target topic's id. Then respond normally to the user's message after the marker.\n`
            : "";
          return `${currentTopicInfo}You have access to multiple conversation topics. ${directorySection}If the user wants to talk about a NEW subject that does NOT match any existing topic, you can CREATE a new topic by using {{TOPIC_NEW:Topic Name}} at the VERY BEGINNING of your response instead. Pick a short, descriptive name (2-4 words).\nRules:\n- Only switch/create when the user EXPLICITLY asks to change topic or starts a clearly unrelated conversation\n- NEVER switch/create for tool usage requests, test messages, debugging, or follow-up questions\n- Never switch for casual mentions, comparisons, or single-message requests\n- Do not mention the marker to the user\n- Prefer TOPIC_SWITCH to an existing topic when one fits; use TOPIC_NEW only when no existing topic matches\n- When in doubt, stay in the current topic`;
        })();
    const idx = finalMessages.findIndex((m) => m.role !== "system");
    finalMessages.splice(idx >= 0 ? idx : finalMessages.length, 0, { role: "system", content });
  }
  // 7. memory
  if (isSourceEnabled("memory:global") || isSourceEnabled("memory:topic")) {
    const memoryContent = loadMemoryForTopic(baseDir, topic.id, {
      includeGlobal: isSourceEnabled("memory:global"),
      includeTopic: isSourceEnabled("memory:topic"),
    });
    if (memoryContent) {
      const idx = finalMessages.findIndex((m) => m.role !== "system");
      finalMessages.splice(idx >= 0 ? idx : finalMessages.length, 0, { role: "system", content: memoryContent });
    }
  }
  // 8. pinned
  if (isSourceEnabled("pinned:messages") && topic.pinnedMessages && topic.pinnedMessages.length > 0) {
    const pinned = storedMessages.filter((m) => topic.pinnedMessages!.includes(m.id));
    if (pinned.length > 0) {
      const pinnedContent = pinned.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
      const idx = finalMessages.findIndex((m) => m.role !== "system");
      finalMessages.splice(idx >= 0 ? idx : finalMessages.length, 0, {
        role: "system",
        content: `Pinned messages from this conversation (important context):\n\n${pinnedContent}`,
      });
    }
  }
  // 9. plan mode → not enabled in this fixture, skipped

  // History-aware merge (lines 2444-2467 of pre-refactor topics.ts)
  const ephemeralSystems: ChatMessage[] = finalMessages
    .filter((m) => m.role === "system")
    .map((m) => ({ role: "system", content: m.content }));
  const dbHistory = buildProviderHistory(storedMessages, { excludeLast: true });
  const payloadHistory = [...ephemeralSystems, ...dbHistory];
  const userContent = storedMessages[storedMessages.length - 1].content;

  return { systemMessages: ephemeralSystems, payloadHistory, userContent };
}

function buildLegacyInlineSystem(providerName: string = "claude-code"): string {
  const { systemMessages } = buildLegacyHistoryAware(providerName);
  const userContent = storedMessages[storedMessages.length - 1].content;
  if (systemMessages.length === 0) return userContent;
  const preamble = systemMessages.map((m) => m.content).join("\n\n---\n\n");
  return `<context>\n${preamble}\n</context>\n\n${userContent}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("regression — canonical pipeline matches legacy", () => {
  it("history-aware: payload.history is byte-identical to the legacy ephemeralSystems + dbHistory", () => {
    const envelope = assembleTopicContext(ctx, {
      sessionKey: topic.sessionKey,
      providerName: "claude",
      providerStrategy: "history-aware",
      includeLastUserInHistory: false,
      userMessageOverride: { content: "the new user turn (latest)", messageId: "u2" },
    });
    const payload = adaptEnvelope(envelope);

    const legacy = buildLegacyHistoryAware();
    expect(payload.userContent).toBe(legacy.userContent);
    expect(payload.history).toEqual(legacy.payloadHistory);
  });

  it("inline-system: payload.userContent matches the legacy <context> preamble + user turn", () => {
    const envelope = assembleTopicContext(ctx, {
      sessionKey: topic.sessionKey,
      providerName: "claude-code",
      providerStrategy: "inline-system",
      includeLastUserInHistory: false,
      userMessageOverride: { content: "the new user turn (latest)", messageId: "u2" },
    });
    const payload = adaptEnvelope(envelope);

    const legacyUserContent = buildLegacyInlineSystem();
    expect(payload.userContent).toBe(legacyUserContent);
    expect(payload.history).toBeUndefined();
  });

  it("gateway-stateful: payload shape matches history-aware (gateway just gets different notes)", () => {
    const envelope = assembleTopicContext(ctx, {
      sessionKey: topic.sessionKey,
      providerName: "openclaw",
      providerStrategy: "gateway-stateful",
      includeLastUserInHistory: false,
      userMessageOverride: { content: "the new user turn (latest)", messageId: "u2" },
    });
    const payload = adaptEnvelope(envelope);
    const legacy = buildLegacyHistoryAware();
    expect(payload.userContent).toBe(legacy.userContent);
    expect(payload.history).toEqual(legacy.payloadHistory);
  });

  it("system blocks granularity: composing them back produces the same N system messages", () => {
    const envelope = assembleTopicContext(ctx, {
      sessionKey: topic.sessionKey,
      providerName: "claude",
      providerStrategy: "history-aware",
      includeLastUserInHistory: false,
      userMessageOverride: { content: "the new user turn (latest)", messageId: "u2" },
    });
    const payload = adaptEnvelope(envelope);
    const legacy = buildLegacyHistoryAware();

    // Count and content of system messages must match.
    const newSystems = (payload.history ?? []).filter((m) => m.role === "system");
    expect(newSystems.length).toBe(legacy.systemMessages.length);
    for (let i = 0; i < newSystems.length; i++) {
      expect(newSystems[i].content).toBe(legacy.systemMessages[i].content);
    }
  });
});
