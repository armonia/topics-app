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
import { getActiveGoal, goalContextContent } from "../services/goals";
import { languageDirective } from "../lib/topics-agent-prompt";
import { readUserRules, skillsBlock } from "../lib/native-parity";

import { contextWindowFor } from "../usage/context-window";
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

/**
 * Il budget della barra dell'inspector NON e' una costante: e' la finestra del
 * modello del topic (`contextWindowFor`, unica tabella). Cablarne una copia a
 * 200k dava la stessa barra al 90% su un topic a 1M che era in realta' al 18% —
 * il numero giusto esisteva, lo perdeva chi lo riportava.
 */

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

/**
 * openclaw decision gate (spec: replace-markers-with-tools, step 4 / design
 * open-question #1).
 *
 * The browser/project/topic control TOOLS reach the model on two tiers:
 *   - claude-code / codex → the topics-app MCP bridge (--mcp-config), and
 *   - claude / openai      → the SDK `sendOptions.tools` passthrough.
 * The `openclaw` provider is different: its tool surface is owned by the gateway,
 * not this app, so we cannot inject these tools into it. The gateway does not
 * expose equivalent control tools either (verified — no open_project/switch_topic
 * /create_project in the gateway surface). So openclaw keeps NO AI-initiated
 * control after the marker removal; it degrades to the always-available user-
 * driven path (sidebar drag / context-menu / `/project`).
 *
 * This returns whether a provider can actually reach the control tools. When it
 * is false we (a) skip the tool-instruction blocks (instructing openclaw to call
 * a tool it doesn't have would be misleading noise and could make it emit a call
 * that silently no-ops), and (b) log a one-line warning so the degradation is
 * visible, never a silent no-op.
 */
function providerHasControlTools(providerName: string): boolean {
  // claude-code/codex via MCP; claude/openai via SDK passthrough. openclaw (and
  // any future gateway-owned provider) does not.
  return providerName !== "openclaw";
}

/** Warn ONCE per provider so the openclaw degradation is logged, not spammed. */
const controlToolWarningLogged = new Set<string>();

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
   * Messaggi su cui costruire la history, invece del thread attivo letto dalla
   * tabella.
   *
   * Serve a edit/regenerate (`server/routes/edit.ts`), che lavora su un ramo
   * TRONCATO: rigenerando una risposta il modello non deve vedere quella che sta
   * rimpiazzando, e il taglio all'ancora non è esprimibile con una query. Senza
   * questo, quel percorso non poteva usare l'envelope e si è ritrovato a
   * ricostruire i blocchi di sistema a mano — perdendone sette per strada.
   */
  historyOverride?: StoredMessage[];

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

  /**
   * Emit a MINIMAL envelope: only the topic system prompt (role) + the project
   * awareness sentence (the load-bearing cwd). Skips template files
   * (CLAUDE.md/README/…), browser/marker/topic-switch instructions, memory and
   * pinned blocks. Used by the dispatcher on a resume/continuation turn: the
   * persistent CLI session already saw the full envelope at kickoff, so
   * re-injecting it only compounds cache write/read on every later call.
   * Default: false (full envelope — interactive turns always refresh).
   */
  leanContext?: boolean;
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
    leanContext = false,
    historyOverride,
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
    // L'obiettivo prima di tutto il resto, e anche nel turno lean: vedi
    // `pushGoalBlock`.
    pushGoalBlock(systemBlocks, topic, ctx);
    // Chi non li deve ricevere li scarta in `adaptEnvelope`, dove il provider e'
    // finalmente noto (vedi SOLO_NATIVO). Nel turno LEAN no: la sessione li ha gia'
    // visti al kickoff, e rimandarli a ogni ripresa e' esattamente il costo composto
    // che `leanContext` esiste per non pagare.
    if (!leanContext) {
      pushUserRulesBlock(systemBlocks, isEnabled);
      pushSkillsBlock(systemBlocks, isEnabled);
    }
    // Lean (dispatcher resume/continuation): system prompt + cwd awareness ONLY.
    // The persistent CLI session already carries CLAUDE.md/README, the browser
    // instructions, memory & co. from the kickoff turn — re-sending them just
    // grows the cached history for every subsequent call this turn.
    if (leanContext) {
      pushProjectTemplateBlocks(systemBlocks, topic, ctx, isEnabled, { lean: true });
    } else {
      pushContextFileBlocks(systemBlocks, topic, isEnabled);
      pushProjectTemplateBlocks(systemBlocks, topic, ctx, isEnabled);
      // Browser/project/topic control instructions steer the model to TOOLS. Only
      // emit them for providers that can actually reach those tools (openclaw
      // cannot — see providerHasControlTools). For openclaw, log the degradation
      // to user-driven control once (never a silent no-op) and skip the blocks.
      if (providerHasControlTools(providerName)) {
        pushBrowserInstructionBlock(systemBlocks);
        pushProjectMarkersBlock(systemBlocks);
        pushTopicSwitchDirectoryBlock(systemBlocks, topic, ctx);
      } else if (!controlToolWarningLogged.has(providerName)) {
        controlToolWarningLogged.add(providerName);
        console.warn(
          `[assemble] provider "${providerName}" has no AI-initiated control-tool channel ` +
          `(browser/project/topic tools are not injectable into the gateway); ` +
          `these actions degrade to user-driven control (sidebar drag / context-menu / /project).`,
        );
      }
      // La lingua sta FUORI dal cancello qui sopra di proposito: quel cancello
      // riguarda i tool, e i provider che non li hanno — codex, openai, gli
      // agenti ACP — sono esattamente quelli che non hanno nemmeno un
      // `--append-system-prompt` in cui infilare la direttiva. Questa è l'unica
      // via che li raggiunge, ed è anche l'unica verificabile a occhio
      // nell'ispettore del contesto invece che per fede.
      pushLanguageBlock(systemBlocks);
      pushMemoryBlocks(systemBlocks, topic, ctx, isEnabled);
      pushPinnedMessagesBlock(systemBlocks, topic, ctx, isEnabled, historyOverride);
      if (planMode) pushPlanModeBlock(systemBlocks);
    }
  }

  // ── History ───────────────────────────────────────────────────────────
  // `historyOverride` serve a edit/regenerate: quel percorso lavora su un ramo
  // TRONCATO (il modello non deve vedere la risposta che sta rimpiazzando), e
  // il troncamento non è esprimibile leggendo la tabella. Assente ⇒ si legge il
  // thread attivo, che è il caso di tutti gli altri chiamanti.
  // The thread's consumers (buildHistoryWithDiagnostics, resolveUserMessage,
  // pushPinnedMessagesBlock) read only role/content/partial/id: never `blocks`
  // and never `toolCalls`. Saying so for BOTH means the two fat columns are not
  // even requested from SQLite. Measured on the heaviest topic of this machine
  // (118 rows, 4.11 MB of `tool_calls` and 7.17 MB of `blocks`): 14.5 ms down to
  // 0.5. It is a cost paid on every turn of every agent.
  const stored = historyOverride ?? ctx.loadLocalMessages(sessionKey, { withBlocks: false, withToolCalls: false });
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

  const budgetLimit = contextWindowFor(topic?.model).tokens;
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

// ── Filesystem snapshot cache ───────────────────────────────────────────────
// assembleTopicContext runs on EVERY production send (chat.ts). The OpenClaw
// workspace files, the recursive memory-tree walk and the project template
// reads are fs-derived inputs that change rarely compared to message cadence,
// yet they were re-read synchronously per message on Bun's single event loop
// (the memory tree in particular grows daily and the walk is unbounded).
// Snapshot them for a few seconds instead. Tests bypass the cache: fixtures
// write files and assemble immediately, so even seconds of staleness would
// couple tests that share a tmpdir.
const FS_SNAPSHOT_TTL_MS = 10_000;

function fsCacheEnabled(): boolean {
  return process.env.NODE_ENV !== "test";
}

interface WorkspaceSnapshot {
  at: number;
  files: Array<{ name: string; path: string; content: string }>;
  memTokens: number;
  memoryDir: string;
}
const workspaceSnapshots = new Map<string, WorkspaceSnapshot>();

interface TemplateSnapshot {
  at: number;
  listing: string;
  files: Array<{ name: string; displayName: string; path: string; content: string }>;
}
const templateSnapshots = new Map<string, TemplateSnapshot>();

/** Both maps are keyed by absolute dir paths; the workspace one holds a single
 *  entry in practice (OPENCLAW_DIR is fixed), the template one grows with the
 *  distinct project roots a user touches. Cap defensively rather than LRU —
 *  a full rebuild is what every call did before this cache existed. */
function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size > 100) map.clear();
  map.set(key, value);
}

function getWorkspaceSnapshot(workspaceDir: string): WorkspaceSnapshot {
  const now = Date.now();
  const hit = workspaceSnapshots.get(workspaceDir);
  if (hit && fsCacheEnabled() && now - hit.at < FS_SNAPSHOT_TTL_MS) return hit;

  const files: WorkspaceSnapshot["files"] = [];
  for (const name of OPENCLAW_WORKSPACE_FILES) {
    const filePath = join(workspaceDir, name);
    const content = readSafe(filePath);
    if (content === null) continue;
    files.push({ name, path: filePath, content });
  }

  const memoryDir = join(workspaceDir, "memory");
  let memTokens = 0;
  if (existsSync(memoryDir)) {
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
  }

  const snap: WorkspaceSnapshot = { at: now, files, memTokens, memoryDir };
  boundedSet(workspaceSnapshots, workspaceDir, snap);
  return snap;
}

function getTemplateSnapshot(projectDir: string): TemplateSnapshot {
  const now = Date.now();
  const hit = templateSnapshots.get(projectDir);
  if (hit && fsCacheEnabled() && now - hit.at < FS_SNAPSHOT_TTL_MS) return hit;

  let listing = "";
  try {
    const entries = readdirSync(projectDir, { withFileTypes: true }).slice(0, 30);
    listing = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join(", ");
  } catch {
    /* leave empty — adapter falls back to plain awareness statement */
  }

  const files: TemplateSnapshot["files"] = [];
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
    files.push({ name, displayName, path: filePath, content });
  }

  const snap: TemplateSnapshot = { at: now, listing, files };
  boundedSet(templateSnapshots, projectDir, snap);
  return snap;
}

function pushOpenClawInformationalBlocks(blocks: SystemBlock[], ctx: AppContext): void {
  const snap = getWorkspaceSnapshot(join(ctx.OPENCLAW_DIR, "workspace"));

  for (const file of snap.files) {
    blocks.push({
      id: `openclaw:${file.name}`,
      label: file.name,
      category: "openclaw",
      content: file.content,
      tokens: estimateTokens(file.content),
      enabled: true,         // Always enabled — toggling has no effect since we don't emit it.
      countInBudget: true,
      sourceUri: file.path,
      editable: false,
      injectedByTopicsApp: false,
    });
  }

  // Memory tree aggregate — informational, not counted in budget by default
  // (mirrors the legacy `/api/context/analyze` behaviour).
  if (snap.memTokens > 0) {
    blocks.push({
      id: "openclaw:memory-tree",
      label: "OpenClaw Memory Archive",
      category: "openclaw",
      content: "",                // We don't materialise the tree contents here.
      tokens: snap.memTokens,
      enabled: true,
      countInBudget: false,
      sourceUri: snap.memoryDir,
      editable: false,
      injectedByTopicsApp: false,
    });
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
  opts?: { lean?: boolean },
): void {
  const projectDir = ctx.resolveTopicCwd(topic);
  if (!projectDir || !existsSync(projectDir)) return;
  const lean = opts?.lean === true;

  const projectName = (topic.projectPath || projectDir).split("/").pop()
    || topic.projectPath
    || projectDir;
  // The path in this sentence is LOAD-BEARING: the provider spawns every
  // session in a global workspace cwd, so this block is how the agent learns
  // where to work. It must be the RESOLVED cwd (worktree absPath when the
  // topic is worktree-bound), not topic.projectPath — pointing a worktree-
  // bound agent at the live repo is exactly the clobbering the worktree
  // exists to prevent.
  const isWorktreeBound = !!topic.worktreeId && projectDir !== topic.projectPath;
  let awarenessBase = isWorktreeBound
    ? `You are working in the project "${projectName}" inside an ISOLATED git worktree at ${projectDir}. ` +
      `Do all your work in that directory — never in the project's main checkout.`
    : `You are working in the project "${projectName}" at ${projectDir}.`;

  // Graphify hint: if the project has a prebuilt code graph, point the agent at
  // it so it navigates the structure with `graphify query/explain/path` instead
  // of a fan-out of Grep/Read (each large tool-result inflates the cached
  // conversation). graphify-out/ is NOT committed, so a worktree checkout won't
  // have it — check the MAIN repo (topic.projectPath) and cite its absolute
  // path (read-only; the agent reads the graph where it lives).
  const graphRepo = topic.projectPath || projectDir;
  const graphPath = graphRepo ? join(graphRepo, "graphify-out", "graph.json") : "";
  if (graphPath && existsSync(graphPath)) {
    // Report the graph's age so the agent can gauge how much to trust it. The
    // graph is auto-rebuilt by a git post-commit hook (scripts/graphify-regen.sh),
    // so under normal use it tracks HEAD; if it's stale the agent must be told,
    // otherwise it silently reasons over an out-of-date map of the code.
    let ageNote = "";
    try {
      const ageMs = Date.now() - statSync(graphPath).mtimeMs;
      const ageDays = ageMs / 86_400_000;
      const label =
        ageDays >= 1 ? `${Math.floor(ageDays)}d`
        : ageMs >= 3_600_000 ? `${Math.floor(ageMs / 3_600_000)}h`
        : `${Math.max(1, Math.floor(ageMs / 60_000))}m`;
      ageNote = ageDays > 2
        ? ` The graph was last rebuilt ${label} ago — STALE (>2 days): it may miss recent changes, so verify any hit against the live source before trusting it.`
        : ` The graph was last rebuilt ${label} ago.`;
    } catch { /* stat can race a rebuild; skip the age note if so */ }
    awarenessBase +=
      `\n\nCode graph available for this project: prefer \`graphify query/explain/path\` ` +
      `(graph at ${graphPath}) over broad Grep/Read exploration when locating code — ` +
      `e.g. \`graphify query 'who calls streamEditResponse' --graph ${graphPath}\`.` +
      ageNote;
  }

  // Snapshot carries the "Project root files: a, b/, c" listing plus the
  // template file contents. The adapter consults `adapterHints.projectListing`
  // at compose time iff no template files end up enabled — mirrors the legacy
  // fallback in `streamEditResponse`. In lean mode we skip the snapshot entirely
  // (no listing hint, no file reads).
  const snap = lean ? null : getTemplateSnapshot(projectDir);
  const projectListing = snap?.listing;

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

  if (!snap) return; // lean: awareness sentence only, no template file blocks

  for (const file of snap.files) {
    const id = `template:${file.name}`;
    blocks.push({
      id,
      label: file.displayName,
      category: "template",
      content: file.content,
      tokens: estimateTokens(file.content),
      enabled: isEnabled(id),
      countInBudget: true,
      sourceUri: file.path,
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

/**
 * La lingua in cui rispondere, come blocco del contesto.
 *
 * Nessun blocco quando la scelta è «auto»: un blocco vuoto nell'ispettore è
 * peggio di un blocco assente — sembra rotto, e non lo è. `auto` significa
 * appunto che al modello non arriva nessuna direttiva.
 *
 * Su claude-code questa riga è la SECONDA copia (la prima viaggia in
 * `--append-system-prompt` allo spawn, vedi `topicsAgentSystemPrompt`), e va
 * bene: i due canali hanno vite diverse — quello dello spawn dura quanto la
 * sessione e non si vede da nessuna parte, questo è per-turno e si legge
 * nell'ispettore. Una riga ripetuta costa una riga.
 */
function pushLanguageBlock(blocks: SystemBlock[]): void {
  const content = languageDirective();
  if (!content) return;
  blocks.push({
    id: "synthetic:output-language",
    label: "Output language",
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
  /**
   * Gli stessi messaggi su cui è costruita la history. Passarlo NON è un
   * dettaglio: su un Rigenera la history è troncata all'ancora perché il modello
   * non veda la risposta che sta rimpiazzando, ma questo blocco rileggeva il
   * thread dal DB — e se quella risposta era PINNATA rientrava per intero nel
   * preambolo di sistema, annullando il troncamento senza che nulla lo dicesse.
   */
  messages?: StoredMessage[],
): void {
  if (!topic.pinnedMessages || topic.pinnedMessages.length === 0) return;
  const localMsgs = messages ?? ctx.loadLocalMessages(topic.sessionKey);
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

/**
 * Il goal attivo del topic (3.4). Va SEMPRE, anche in `leanContext`: è l'unico
 * blocco che esiste proprio per sopravvivere alla compattazione — toglierlo dal
 * turno di ripresa del dispatcher significherebbe togliere l'obiettivo esattamente
 * al turno in cui il modello ha già perso tutto il resto.
 *
 * Non è disattivabile dall'ispettore: un obiettivo che l'umano ha dichiarato e
 * che il modello non vede è la premessa del guasto che questo blocco previene.
 * Per toglierlo si chiude il goal, che è una decisione, non un interruttore.
 */
function pushGoalBlock(blocks: SystemBlock[], topic: Topic, ctx: AppContext): void {
  let content: string | null = null;
  try {
    content = goalContextContent(getActiveGoal(ctx.db, topic.id));
  } catch (err) {
    // Una topic senza tabella (DB vecchio) o una query che fallisce non deve
    // far saltare l'assemblaggio: il resto del contesto vale comunque.
    console.warn("[assemble] goal block skipped:", err);
    return;
  }
  if (!content) return;
  blocks.push({
    id: "synthetic:goal",
    label: "Obiettivo",
    category: "synthetic",
    content,
    tokens: estimateTokens(content),
    enabled: true,
    countInBudget: true,
    editable: false,
    injectedByTopicsApp: true,
  });
}

/** `~/.claude/CLAUDE.md`: le regole che l'utente da' a OGNI agente. */
function pushUserRulesBlock(blocks: SystemBlock[], isEnabled: (id: string) => boolean): void {
  const content = readUserRules();
  if (!content?.trim()) return;
  blocks.push({
    id: "user:CLAUDE.md",
    label: "~/.claude/CLAUDE.md",
    category: "template",
    content,
    tokens: estimateTokens(content),
    enabled: isEnabled("user:CLAUDE.md"),
    countInBudget: true,
    editable: false,
    injectedByTopicsApp: true,
  });
}

/** L'ELENCO delle skill, non il loro corpo: quello lo carica il tool `skill`. */
function pushSkillsBlock(blocks: SystemBlock[], isEnabled: (id: string) => boolean): void {
  const content = skillsBlock();
  if (!content) return;
  blocks.push({
    id: "synthetic:skills",
    label: "Skill disponibili",
    category: "synthetic",
    content,
    tokens: estimateTokens(content),
    enabled: isEnabled("synthetic:skills"),
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
    // Markers were removed (migrated to tools) — history is plain text now.
    const stripped = original.trim();
    const bytesDropped = 0;

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
        strippedMarkers: [],
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

// Nessuna ri-esportazione di `loadMemoryForTopic` / `buildProviderHistory`: chi
// li usa (routes, `regression.test.ts`) li importa dal loro modulo — `routes/
// memory` e `utils/build-provider-history` — non da qui. Ri-esportarli "per
// restare dentro server/context/" dava due nomi alla stessa funzione senza che
// nessuno passasse dal secondo. Il codice di produzione usa
// `assembleTopicContext`.
