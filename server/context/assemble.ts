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

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

import type { ChatMessage } from "../providers/types";
import type { AppContext, StoredMessage, Topic } from "../types";
import { loadMemoryForTopic } from "../routes/memory";
import { buildProviderHistory } from "../utils/build-provider-history";

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
const BROWSER_MARKER_RE = /\{\{BROWSER:.*?\}\}/g;
const TOPIC_SWITCH_MARKER_RE = /\{\{TOPIC_SWITCH:[\w-]+\}\}\s*/g;
const TOPIC_NEW_MARKER_RE = /\{\{TOPIC_NEW:[^}]+\}\}\s*/g;

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
  const totalTokens = systemBlocks
    .filter((b) => b.enabled && b.countInBudget && b.injectedByTopicsApp)
    .reduce((sum, b) => sum + b.tokens, 0)
    + systemBlocks
      .filter((b) => b.enabled && b.countInBudget && !b.injectedByTopicsApp)
      .reduce((sum, b) => sum + b.tokens, 0);
  // ↑ Both branches sum the same way; kept split to make explicit that
  //   informational blocks STILL count in the budget bar (the user pays the
  //   token cost regardless of who injects them).

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
        }
      : { planMode, totalStoredMessages: stored.length },
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
          const c = readSafe(full);
          if (c) memTokens += estimateTokens(c);
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
    if (!existsSync(filePath)) continue;
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
    if (!existsSync(filePath)) continue;
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
    const stripped = stripMarkersImpl(original).trim();
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

function detectMarkers(content: string): string[] {
  const markers: string[] = [];
  const browser = content.match(BROWSER_MARKER_RE);
  if (browser) markers.push(...browser);
  const switchM = content.match(TOPIC_SWITCH_MARKER_RE);
  if (switchM) markers.push(...switchM.map((m) => m.trim()));
  const newM = content.match(TOPIC_NEW_MARKER_RE);
  if (newM) markers.push(...newM.map((m) => m.trim()));
  return markers;
}

function stripMarkersImpl(content: string): string {
  return content
    .replace(BROWSER_MARKER_RE, "")
    .replace(TOPIC_SWITCH_MARKER_RE, "")
    .replace(TOPIC_NEW_MARKER_RE, "");
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
  return `When you want to open a URL or file in the embedded browser panel, include the marker {{BROWSER:url}} in your response. Examples:
- After creating an HTML file: {{BROWSER:file:///path/to/file.html}}
- After starting a dev server: {{BROWSER:http://localhost:3000}}
- To show a webpage: {{BROWSER:https://example.com}}
The marker will be automatically processed and removed from the visible output. Do not mention the marker to the user.`;
}

export function projectMarkersContent(): string {
  return `You can create or open projects for the user. When the user asks to create a new project, include {{PROJECT_CREATE:project-name}} in your response — this creates a directory in the workspace and binds it to this topic. When the user asks to open or switch to an existing project, include {{PROJECT_OPEN:project-name-or-path}} (workspace name or absolute path). The marker is automatically processed and removed from visible output. Do not mention the marker to the user. Only use these when the user explicitly asks to create or open a project.`;
}

export function topicSwitchContent(topic: Topic, directory: string): string {
  const currentTopicInfo = `You are currently in topic: "${topic.name}"${topic.projectPath ? ` (project: ${topic.projectPath.split("/").pop()})` : ""}.\n\n`;
  const directorySection = directory
    ? `Here are the available topics:\n${directory}\n\nIf the user's message CLEARLY belongs to a different topic (not just a casual reference), include the marker {{TOPIC_SWITCH:topicId}} at the VERY BEGINNING of your response, using the target topic's id. Then respond normally to the user's message after the marker.\n`
    : "";
  return `${currentTopicInfo}You have access to multiple conversation topics. ${directorySection}If the user wants to talk about a NEW subject that does NOT match any existing topic, you can CREATE a new topic by using {{TOPIC_NEW:Topic Name}} at the VERY BEGINNING of your response instead. Pick a short, descriptive name (2-4 words).\nRules:\n- Only switch/create when the user EXPLICITLY asks to change topic or starts a clearly unrelated conversation\n- NEVER switch/create for tool usage requests, test messages, debugging, or follow-up questions\n- Never switch for casual mentions, comparisons, or single-message requests\n- Do not mention the marker to the user\n- Prefer TOPIC_SWITCH to an existing topic when one fits; use TOPIC_NEW only when no existing topic matches\n- When in doubt, stay in the current topic`;
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
