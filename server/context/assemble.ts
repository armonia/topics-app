/**
 * `assembleTopicContext` — produces a `ContextEnvelope` for a topic + provider.
 *
 * THE ONE entry point used by:
 *   - `streamEditResponse` (production send path)
 *   - `/api/topics/:id/context-preview`            (inspector preview)
 *   - `/api/context/analyze`                       (legacy inspector, via projection)
 *
 * The function replicates, byte-for-byte, the system message construction that
 * lives inline in `server/routes/topics.ts:1593-1734` (as of the change
 * `topic-context-canonical`). Where the route handler builds **aggregated**
 * `system` messages, this function emits **granular** `SystemBlock`s
 * (one per source: each context file, each project template, etc.) plus a
 * marker per synthetic block. `adaptEnvelope` later re-aggregates them into
 * the exact same payload the route handler used to produce — so providers
 * see no behavioural change while the inspector gains per-source toggling
 * and history visibility.
 *
 * Design contract: `openspec/changes/topic-context-canonical/design.md`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

import type { ChatMessage } from "../providers/types";
import type { AppContext, StoredMessage, Topic } from "../types";
import { loadMemoryForTopic } from "../routes/memory";
import { buildProviderHistory } from "../utils/build-provider-history";
import { stripMarkers, detectMarkers } from "../lib/markers";

import type {
  ContextDiagnostics,
  ContextEnvelope,
  HistoryEntryDiagnostic,
  HistoryExcludeReason,
  ProviderContextStrategy,
  SystemBlock,
} from "./envelope";

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

/** Default upper bound on history turns. Mirrors `buildProviderHistory`. */
const DEFAULT_HISTORY_LIMIT = 100;

/** Reference budget for the inspector bar. */
const DEFAULT_BUDGET_LIMIT = 200_000;

/** Threshold above which the inspector flags a "context > N%" warning. */
const BUDGET_WARN_PERCENT = 80;

/** Threshold above which a single source is flagged as "very large". */
const LARGE_SOURCE_TOKENS = 10_000;

/** Project files we surface as templates (CLAUDE.md falls back to .claude/CLAUDE.md). */
const PROJECT_TEMPLATE_FILES = ["CLAUDE.md", "README.md", ".cursorrules", "AGENTS.md"];

/** OpenClaw workspace files injected gateway-side; listed for inspector visibility. */
const OPENCLAW_WORKSPACE_FILES = ["SOUL.md", "MEMORY.md", "AGENTS.md", "TOOLS.md", "IDENTITY.md", "USER.md"];

const CHAT_CONTEXT_PREFIX = "[Chat messages since your last reply";
// Marker detection/stripping uses the canonical grammar in `../lib/markers`
// (all 5 families incl. PROJECT_*). The local copy here covered only 3 and
// leaked {{PROJECT_OPEN/CREATE:…}} into replayed history (audit #4).

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export interface AssembleArgs {
  /** Topic-bound session key (looked up via `ctx.getTopicBySessionKey`). */
  sessionKey: string;

  /** Provider name — drives `envelope.providerStrategy`. */
  providerName: string;

  /** Provider strategy. Falls back to `"history-aware"` if not supplied. */
  providerStrategy?: ProviderContextStrategy;

  /**
   * Override for the "current user turn". Used by the production send path
   * (`{ content: lastUser, messageId: lastUserMsg.id }`). When omitted the
   * function picks the most recent user turn from the DB so the inspector
   * can preview "if I sent now, this is what the model would see".
   */
  userMessageOverride?: { content: string; messageId?: string };

  /** Default 100. Mirrors `buildProviderHistory`. */
  historyLimit?: number;

  /**
   * When `false` (production send path), the most recent user turn is
   * dropped from `history[]` because the caller passes it via
   * `userMessage` / `payload.userContent`. When `true` (inspector preview)
   * the full conversation is kept in history.
   *
   * Default: `true` (inspector default).
   */
  includeLastUserInHistory?: boolean;

  /**
   * Override for `topic.disabledContextSources`. Useful for "what-if"
   * previews ("show me what the envelope would look like with X enabled").
   * Default: the topic's persisted list.
   */
  disabledSources?: string[];

  /** Whether plan-mode synthetic block should be included. */
  planMode?: boolean;

  /**
   * Whether Fast Mode is active for this assembly (openspec change
   * `chat-fast-mode`). Fast Mode does NOT alter system blocks or history —
   * it only changes the effective model at the route layer. We propagate
   * the flag into `diagnostics.fastMode` and `sessionMeta.fastMode` purely
   * so the inspector / snapshot ring can label the envelope.
   */
  fastMode?: boolean;
}

export function assembleTopicContext(ctx: AppContext, args: AssembleArgs): ContextEnvelope {
  const {
    sessionKey,
    providerName,
    providerStrategy = "history-aware",
    userMessageOverride,
    historyLimit = DEFAULT_HISTORY_LIMIT,
    includeLastUserInHistory = true,
    disabledSources,
    planMode = false,
    fastMode = false,
  } = args;

  const topic = ctx.getTopicBySessionKey(sessionKey);
  const disabled = disabledSources ?? topic?.disabledContextSources ?? [];
  const isEnabled = (id: string) => !disabled.includes(id);

  const systemBlocks: SystemBlock[] = [];

  // The order below mirrors the FINAL order of system messages in
  // `streamEditResponse` after all the splice() calls. See the table in
  // openspec/changes/topic-context-canonical/design.md.

  // (a) Informational only — OpenClaw workspace files (SOUL.md, MEMORY.md,
  //     AGENTS.md, TOOLS.md, IDENTITY.md, USER.md, plus the memory tree).
  //     These are injected by the OPENCLAW GATEWAY itself, not by
  //     topics-app, so they only reach the model when the topic is wired
  //     to the `openclaw` provider. For any other provider the gateway is
  //     never called and these files would be misleading noise in the
  //     inspector — so we skip them.
  //
  //     We surface them ONLY for openclaw (informational, with
  //     `injectedByTopicsApp: false` so the adapter still skips them and
  //     we don't double-inject).
  if (providerName === "openclaw" || providerStrategy === "gateway-stateful") {
    pushOpenClawInformationalBlocks(systemBlocks, ctx);
  }

  // (b) Topics-app-emitted blocks, in delivery order.
  if (topic) {
    pushSystemPromptBlock(systemBlocks, topic, isEnabled);
    pushContextFileBlocks(systemBlocks, topic, isEnabled);
    pushProjectTemplateBlocks(systemBlocks, topic, ctx, isEnabled);
    pushBrowserInstructionBlock(systemBlocks);
    pushProjectMarkersBlock(systemBlocks);
    pushTopicSwitchDirectoryBlock(systemBlocks, topic, ctx);
    pushMemoryBlocks(systemBlocks, topic, ctx, isEnabled);
    pushPinnedMessagesBlock(systemBlocks, topic, ctx, isEnabled);
    if (planMode) pushPlanModeBlock(systemBlocks);
  }

  // ── History ───────────────────────────────────────────────────────────
  const stored = ctx.loadLocalMessages(sessionKey);
  const { history, historyEntries, droppedHistoryTurns } = buildHistoryWithDiagnostics(
    stored,
    { historyLimit, includeLastUserInHistory },
  );

  // ── User message (override or DB) ─────────────────────────────────────
  const userMessage = resolveUserMessage(userMessageOverride, stored);

  // ── Diagnostics ───────────────────────────────────────────────────────
  // Informational blocks (not injected by Topics App) STILL count in the budget
  // bar — the user pays the token cost regardless of who injects them.
  const totalTokens = systemBlocks
    .filter((b) => b.enabled && b.countInBudget)
    .reduce((sum, b) => sum + b.tokens, 0);

  const budgetLimit = DEFAULT_BUDGET_LIMIT;
  const budgetPercent = Math.round((totalTokens / budgetLimit) * 100);
  const warnings = buildWarnings(systemBlocks, totalTokens, budgetLimit);

  const diagnostics: ContextDiagnostics = {
    totalTokens,
    budgetLimit,
    budgetPercent,
    droppedHistoryTurns,
    historyEntries,
    warnings,
    assembledAt: Date.now(),
    fastMode,
  };

  return {
    topicId: topic?.id ?? "",
    sessionKey,
    providerName,
    providerStrategy,
    sessionMeta: topic
      ? {
          topicName: topic.name,
          modelName: topic.model ?? null,
          projectPath: topic.projectPath ?? null,
          workingDir: ctx.resolveTopicCwd(topic),
          worktreeId: topic.worktreeId ?? null,
          totalStoredMessages: stored.length,
          planMode,
          fastMode,
        }
      : { planMode, fastMode, totalStoredMessages: stored.length },
    systemBlocks,
    history,
    userMessage,
    diagnostics,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// System block builders
// ────────────────────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

function readSafe(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function pushOpenClawInformationalBlocks(blocks: SystemBlock[], ctx: AppContext): void {
  const workspaceDir = join(ctx.OPENCLAW_DIR, "workspace");

  for (const name of OPENCLAW_WORKSPACE_FILES) {
    const filePath = join(workspaceDir, name);
    const content = readSafe(filePath);
    if (content === null) continue;
    blocks.push({
      id: `openclaw:${name}`,
      label: name,
      category: "openclaw",
      content,
      tokens: estimateTokens(content),
      enabled: true,         // Always enabled — toggling has no effect since we don't emit it.
      countInBudget: true,
      sourceUri: filePath,
      editable: false,
      injectedByTopicsApp: false,
    });
  }

  // Memory tree aggregate — informational, not counted in budget by default
  // (mirrors the legacy `/api/context/analyze` behaviour).
  const memoryDir = join(workspaceDir, "memory");
  if (existsSync(memoryDir)) {
    let memTokens = 0;
    const visit = (dir: string) => {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            visit(full);
            continue;
          }
          // Size-based estimate: avoid reading bytes we immediately discard.
          // Byte size slightly overestimates vs UTF-8 char length, but the
          // /4 heuristic is already approximate.
          memTokens += Math.round(statSync(full).size / 4);
        }
      } catch {
        /* ignore */
      }
    };
    visit(memoryDir);
    if (memTokens > 0) {
      blocks.push({
        id: "openclaw:memory-tree",
        label: "OpenClaw Memory Archive",
        category: "openclaw",
        content: "",                // We don't materialise the tree contents here.
        tokens: memTokens,
        enabled: true,
        countInBudget: false,
        sourceUri: memoryDir,
        editable: false,
        injectedByTopicsApp: false,
      });
    }
  }
}

function pushSystemPromptBlock(
  blocks: SystemBlock[],
  topic: Topic,
  isEnabled: (id: string) => boolean,
): void {
  if (!topic.systemPrompt) return;
  const id = "prompt:system";
  blocks.push({
    id,
    label: "System Prompt",
    category: "prompt",
    content: topic.systemPrompt,
    tokens: estimateTokens(topic.systemPrompt),
    enabled: isEnabled(id),
    countInBudget: true,
    editable: true,
    injectedByTopicsApp: true,
  });
}

function pushContextFileBlocks(
  blocks: SystemBlock[],
  topic: Topic,
  isEnabled: (id: string) => boolean,
): void {
  if (!topic.contextFiles || topic.contextFiles.length === 0) return;
  for (const filePath of topic.contextFiles) {
    const content = readSafe(filePath);
    if (content === null) continue;
    const fileName = filePath.split("/").pop() || filePath;
    const id = `file:${filePath}`;
    blocks.push({
      id,
      label: fileName,
      category: "file",
      content,
      tokens: estimateTokens(content),
      enabled: isEnabled(id),
      countInBudget: true,
      sourceUri: filePath,
      editable: false,
      injectedByTopicsApp: true,
    });
  }
}

function pushProjectTemplateBlocks(
  blocks: SystemBlock[],
  topic: Topic,
  ctx: AppContext,
  isEnabled: (id: string) => boolean,
): void {
  const projectDir = ctx.resolveTopicCwd(topic);
  if (!projectDir || !existsSync(projectDir)) return;

  const projectName = (topic.projectPath || projectDir).split("/").pop()
    || topic.projectPath
    || projectDir;
  const projectLabelPath = topic.projectPath || projectDir;
  const awarenessBase = `You are working in the project "${projectName}" at ${projectLabelPath}.`;

  // Pre-compute the "Project root files: a, b/, c" listing once. The adapter
  // consults `adapterHints.projectListing` at compose time iff no template
  // files end up enabled — mirrors the legacy fallback in `streamEditResponse`.
  let projectListing = "";
  try {
    const entries = readdirSync(projectDir, { withFileTypes: true }).slice(0, 30);
    projectListing = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join(", ");
  } catch {
    /* leave empty — adapter falls back to plain awareness statement */
  }

  // Synthetic project-awareness block — always emitted when projectDir
  // resolves. Content is the bare statement; the adapter appends either
  // template files OR the precomputed listing.
  blocks.push({
    id: "template:project-awareness",
    label: `Project: ${projectName}`,
    category: "template",
    content: awarenessBase,
    tokens: estimateTokens(awarenessBase),
    enabled: true,                // Always emitted; matches legacy behaviour.
    countInBudget: true,
    sourceUri: projectDir,
    editable: false,
    injectedByTopicsApp: true,
    adapterHints: projectListing ? { projectListing } : undefined,
  });

  for (const name of PROJECT_TEMPLATE_FILES) {
    let filePath = join(projectDir, name);
    let displayName = name;
    if (!existsSync(filePath) && name === "CLAUDE.md") {
      const altPath = join(projectDir, ".claude", "CLAUDE.md");
      if (existsSync(altPath)) {
        filePath = altPath;
        displayName = ".claude/CLAUDE.md";
      }
    }
    const content = readSafe(filePath);
    if (content === null) continue;
    const id = `template:${name}`;
    blocks.push({
      id,
      label: displayName,
      category: "template",
      content,
      tokens: estimateTokens(content),
      enabled: isEnabled(id),
      countInBudget: true,
      sourceUri: filePath,
      editable: false,
      injectedByTopicsApp: true,
    });
  }
}

function pushBrowserInstructionBlock(blocks: SystemBlock[]): void {
  const content = browserInstructionContent();
  blocks.push({
    id: "synthetic:browser-instruction",
    label: "Browser tool instructions",
    category: "synthetic",
    content,
    tokens: estimateTokens(content),
    enabled: true,
    countInBudget: true,
    editable: false,
    injectedByTopicsApp: true,
  });
}

function pushProjectMarkersBlock(blocks: SystemBlock[]): void {
  const content = projectMarkersContent();
  blocks.push({
    id: "synthetic:project-markers",
    label: "Project create/open markers",
    category: "synthetic",
    content,
    tokens: estimateTokens(content),
    enabled: true,
    countInBudget: true,
    editable: false,
    injectedByTopicsApp: true,
  });
}

function pushTopicSwitchDirectoryBlock(
  blocks: SystemBlock[],
  topic: Topic,
  ctx: AppContext,
): void {
  const directory = buildTopicDirectory(ctx, topic.id);
  const content = topicSwitchContent(topic, directory);
  blocks.push({
    id: "synthetic:topic-switch-directory",
    label: "Topic switch directory",
    category: "synthetic",
    content,
    tokens: estimateTokens(content),
    enabled: true,
    countInBudget: true,
    editable: false,
    injectedByTopicsApp: true,
  });
}

function pushMemoryBlocks(
  blocks: SystemBlock[],
  topic: Topic,
  ctx: AppContext,
  isEnabled: (id: string) => boolean,
): void {
  const MEMORY_DIR = join(ctx.BASE_DIR, "memory");
  const globalPath = join(MEMORY_DIR, "_global.md");
  const topicPath = join(MEMORY_DIR, `${topic.id}.md`);
  const globalContent = readSafe(globalPath) ?? "";
  const topicContent = readSafe(topicPath) ?? "";

  if (globalContent.trim().length > 0) {
    const id = "memory:global";
    blocks.push({
      id,
      label: "Global Memory",
      category: "memory",
      content: globalContent,
      tokens: estimateTokens(globalContent),
      enabled: isEnabled(id),
      countInBudget: true,
      sourceUri: globalPath,
      editable: true,
      injectedByTopicsApp: true,
    });
  }
  if (topicContent.trim().length > 0) {
    const id = "memory:topic";
    blocks.push({
      id,
      label: "Topic Memory",
      category: "memory",
      content: topicContent,
      tokens: estimateTokens(topicContent),
      enabled: isEnabled(id),
      countInBudget: true,
      sourceUri: topicPath,
      editable: true,
      injectedByTopicsApp: true,
    });
  }
}

function pushPinnedMessagesBlock(
  blocks: SystemBlock[],
  topic: Topic,
  ctx: AppContext,
  isEnabled: (id: string) => boolean,
): void {
  if (!topic.pinnedMessages || topic.pinnedMessages.length === 0) return;
  const localMsgs = ctx.loadLocalMessages(topic.sessionKey);
  const pinned = localMsgs.filter((m) => topic.pinnedMessages!.includes(m.id));
  if (pinned.length === 0) return;
  const content = pinned.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
  const id = "pinned:messages";
  blocks.push({
    id,
    label: `Pinned Messages (${pinned.length})`,
    category: "pinned",
    content,
    tokens: estimateTokens(content),
    enabled: isEnabled(id),
    countInBudget: true,
    editable: false,
    injectedByTopicsApp: true,
  });
}

function pushPlanModeBlock(blocks: SystemBlock[]): void {
  const content = planModeContent();
  blocks.push({
    id: "synthetic:plan-mode",
    label: "Plan Mode",
    category: "synthetic",
    content,
    tokens: estimateTokens(content),
    enabled: true,
    countInBudget: true,
    editable: false,
    injectedByTopicsApp: true,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// History pipeline
// ────────────────────────────────────────────────────────────────────────────

interface BuildHistoryResult {
  history: ChatMessage[];
  historyEntries: HistoryEntryDiagnostic[];
  droppedHistoryTurns: number;
}

function buildHistoryWithDiagnostics(
  stored: StoredMessage[],
  opts: { historyLimit: number; includeLastUserInHistory: boolean },
): BuildHistoryResult {
  const { historyLimit, includeLastUserInHistory } = opts;

  // First pass — classify every stored message.
  const classified: { msg: StoredMessage; entry: HistoryEntryDiagnostic; stripped: string }[] = [];

  // Identify the index of the most recent user message (only relevant when
  // `includeLastUserInHistory: false`).
  let lastUserIdx = -1;
  if (!includeLastUserInHistory) {
    for (let i = stored.length - 1; i >= 0; i--) {
      if (stored[i].role === "user" && !stored[i].partial) {
        lastUserIdx = i;
        break;
      }
    }
  }

  for (let i = 0; i < stored.length; i++) {
    const m = stored[i];
    const original = m.content || "";
    const markers = detectMarkers(original);
    const stripped = stripMarkers(original).trim();
    const bytesDropped = original.length - stripped.length;

    let excludeReason: HistoryExcludeReason | undefined;

    if (m.partial) excludeReason = "partial";
    else if (original.startsWith(CHAT_CONTEXT_PREFIX)) excludeReason = "context-message";
    else if (stripped.length === 0) excludeReason = "empty-after-strip";
    else if (i === lastUserIdx) excludeReason = "duplicate-last-user";
    // `limit` reason is applied in the second pass (after we know how many
    // candidates survived the per-message filters).

    classified.push({
      msg: m,
      stripped,
      entry: {
        storedMessageId: m.id,
        role: (m.role === "assistant" ? "assistant" : "user"),
        strippedMarkers: markers,
        bytesDropped,
        excluded: excludeReason !== undefined,
        excludeReason,
      },
    });
  }

  // Second pass — apply `limit` to whatever survived.
  const survivors: number[] = [];                     // indices into `classified`
  for (let i = 0; i < classified.length; i++) {
    if (!classified[i].entry.excluded) survivors.push(i);
  }

  let droppedHistoryTurns = 0;
  if (survivors.length > historyLimit) {
    const dropCount = survivors.length - historyLimit;
    for (let k = 0; k < dropCount; k++) {
      const idx = survivors[k];
      classified[idx].entry.excluded = true;
      classified[idx].entry.excludeReason = "limit";
      droppedHistoryTurns++;
    }
  }

  const history: ChatMessage[] = classified
    .filter((c) => !c.entry.excluded)
    .map((c) => ({
      role: c.entry.role,
      content: c.stripped,
    }));

  return {
    history,
    historyEntries: classified.map((c) => c.entry),
    droppedHistoryTurns,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Misc helpers
// ────────────────────────────────────────────────────────────────────────────

function resolveUserMessage(
  override: AssembleArgs["userMessageOverride"],
  stored: StoredMessage[],
): { content: string; messageId?: string } {
  if (override) return override;
  for (let i = stored.length - 1; i >= 0; i--) {
    const m = stored[i];
    if (m.role === "user" && !m.partial && (m.content ?? "").trim().length > 0) {
      return { content: m.content, messageId: m.id };
    }
  }
  return { content: "" };
}

function buildWarnings(
  blocks: SystemBlock[],
  totalTokens: number,
  budgetLimit: number,
): { type: string; detail: string }[] {
  const warnings: { type: string; detail: string }[] = [];
  const budgetPercent = Math.round((totalTokens / budgetLimit) * 100);
  if (budgetPercent > BUDGET_WARN_PERCENT) {
    warnings.push({
      type: "budget",
      detail: `Context usage is at ${budgetPercent}% of budget (${totalTokens} / ${budgetLimit} tokens)`,
    });
  }
  for (const b of blocks) {
    if (b.enabled && b.tokens > LARGE_SOURCE_TOKENS) {
      warnings.push({
        type: "large-source",
        detail: `"${b.label}" is very large (${b.tokens} tokens)`,
      });
    }
  }
  return warnings;
}

function buildTopicDirectory(ctx: AppContext, currentTopicId: string): string {
  const data = ctx.loadTopics();
  const lines: string[] = [];
  for (const t of Object.values(data.topics)) {
    if (t.id === currentTopicId || t.archived) continue;
    const project = t.projectPath ? ` (project: ${t.projectPath.split("/").pop()})` : "";
    lines.push(`- [id:${t.id}] ${t.name}${project}`);
  }
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// Synthetic block contents — copied verbatim from `streamEditResponse`.
// Centralised here so `adaptEnvelope` and tests reference the same strings.
// ────────────────────────────────────────────────────────────────────────────

export function browserInstructionContent(): string {
  // All control of the embedded browser pane is via the topics-app tool
  // `open_browser_pane` (claude-code/codex over MCP; claude/openai over the SDK
  // browser-tool passthrough). The legacy {{BROWSER:url}} marker was removed.
  return `When you need to open a URL or file in the user's embedded browser panel, use the \`open_browser_pane\` tool with the absolute URL. Examples:
- After creating an HTML file: open_browser_pane({ url: "file:///path/to/file.html" })
- After starting a dev server: open_browser_pane({ url: "http://localhost:3000" })
- To show a webpage: open_browser_pane({ url: "https://example.com" })
The tool returns the final URL + page title after navigation. Do not mention the tool to the user.`;
}

export function projectMarkersContent(): string {
  // Project control is via the topics-app tools `open_project` / `create_project`
  // (MCP for claude-code/codex). The legacy {{PROJECT_OPEN/CREATE}} markers were removed.
  return `You can surface and scope this session to projects in the user's Topics app. The user's projects are referred to by name (for example "Pix" or "topics-app").
- To OPEN/SCOPE an existing project, use the \`open_project\` tool: open_project({ ref: "project-name-or-path" }) — pass the user's Topics project NAME when you know it (Topics resolves the name), or a known workspace name / path. Topics opens that project window and places THIS session inside it.
- To CREATE a new project, use the \`create_project\` tool: create_project({ name: "project-name" }) — scaffolds a workspace directory, binds it to this session, and opens it.
Call \`open_project\` whenever the user, in ANY phrasing or language, asks to open, switch to, move into, or nest this session under a project, OR says this session belongs to / should live under a project — not only the literal word "open". Examples: "open project Pix" / "aprimi il progetto Pix" / "metti questa sessione nel progetto Pix" → open_project({ ref: "Pix" }). Also call it when you begin focused work inside a specific project. If the user references "this project" WITHOUT naming it and you cannot infer the name/path, ask which project rather than guessing. Do NOT call it for casual mentions, comparisons, single-file references, or test/debug chatter. Never mention the tool to the user.`;
}

export function topicSwitchContent(topic: Topic, directory: string): string {
  const currentTopicInfo = `You are currently in topic: "${topic.name}"${topic.projectPath ? ` (project: ${topic.projectPath.split("/").pop()})` : ""}.\n\n`;
  // Topic control is via the topics-app tools `switch_topic` / `new_topic`.
  // The legacy {{TOPIC_SWITCH/TOPIC_NEW}} markers were removed.
  const directorySection = directory
    ? `Here are the available topics:\n${directory}\n\nIf the user's message CLEARLY belongs to a different existing topic (not just a casual reference), use the \`switch_topic\` tool: switch_topic({ topic_id: "..." }) with the target topic's id.\n`
    : "";
  return `${currentTopicInfo}You have access to multiple conversation topics. ${directorySection}If the user wants to talk about a NEW subject that does NOT match any existing topic, use the \`new_topic\` tool: new_topic({ title: "Topic Name" }) instead (a short, descriptive 2-4 word name).\nRules:\n- Only switch/create when the user EXPLICITLY asks to change topic or starts a clearly unrelated conversation\n- NEVER switch/create for tool usage requests, test messages, debugging, or follow-up questions\n- Never switch for casual mentions, comparisons, or single-message requests\n- Prefer switch_topic to an existing topic when one fits; use new_topic only when none matches\n- Never mention the tool to the user\n- When in doubt, stay in the current topic`;
}

export function planModeContent(): string {
  return `IMPORTANT: You are in PLAN MODE. Analyze the user's request and provide a detailed implementation plan. Do NOT execute any changes yet. Format your response as follows:

## Plan

1. **Step title** — Description of what this step does
2. **Step title** — Description of what this step does
3. ...

## Summary
Brief summary of the approach and any considerations.

Wait for the user to approve the plan before executing any changes.`;
}

// `loadMemoryForTopic` is re-used inside `adaptEnvelope` to compose the memory
// system message; we re-export it here so consumers can stay within
// `server/context/`.
export { loadMemoryForTopic };

// `buildProviderHistory` is referenced by tests that want to compare the
// canonical history pipeline against the legacy utility. Re-exported for
// convenience; production code should use `assembleTopicContext`.
export { buildProviderHistory };
