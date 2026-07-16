import { basename, join, resolve, sep } from "path";
import { existsSync, readFileSync, mkdirSync } from "fs";
import type { ServerWebSocket } from "bun";
import type { WSData } from "./server/types";
import { createAppContext } from "./server/utils";
import { closeDatabase } from "./server/db";
import {
  acquireLock, releaseLock, writeState, readState,
  uptimeMsSince, LiveLockError, worktreeIsolationHome,
} from "./server/services/daemon-state";
import {
  startUiStateBackupTicker, snapshotUiStateNow,
} from "./server/services/ui-state-backup";
import { purgeOrphanTopicRefs } from "./server/services/ui-state-orphan-cleanup";
import { createTopicsRouter } from "./server/routes/topics";
import { createVoiceRouter } from "./server/routes/voice";
import { createRemoteRouter } from "./server/routes/remote";
import { createMediaRouter } from "./server/routes/media";
import { createBranchesRouter } from "./server/routes/branches";
import { createFilesRouter } from "./server/routes/files";
import { createBrowserRouter } from "./server/routes/browser";
import { createCronRouter } from "./server/routes/cron";
import { createContextRouter } from "./server/routes/context";
import { createTerminalRouter, handleTerminalWebSocket, disconnectBridge, getClaudeSessionsForDetection, getClaudeSessionPtyIdleMs } from "./server/routes/terminal";
import { createStatusRouter } from "./server/routes/status";
import { createMemoryRouter } from "./server/routes/memory";
import { createUsageRouter } from "./server/routes/usage";
import { initUsageStore, rebuildSummary } from "./server/usage/store";
import { createAgentsRouter } from "./server/routes/agents";
import { createCheckpointsRouter } from "./server/routes/checkpoints";
import { createOpenClawContextRouter } from "./server/routes/openclaw-context";
import { createContextPreviewRouter } from "./server/routes/context-preview";
import { createTaskService } from "./server/services/tasks";
import { createTaskDispatcher } from "./server/services/task-dispatcher";
import { computeDispatchCapacity } from "./server/services/dispatch-capacity";
import { createTaskAutoMerge } from "./server/services/task-automerge";
import { createTranscriptUsageReader, ZERO_USAGE } from "./server/services/transcript-usage";
import { createDetachedTopic } from "./server/lib/session-control-core";
import { buildProjectCandidates, resolveProjectPath, isSelectableProjectDir } from "./server/services/project-path-resolver";
import { homedir } from "os";
import { createBrowserService } from "./server/browser-service";
import { clearBrowserCaches } from "./server/browser-tools-handler";
import { resetMoondreamCounter } from "./server/integrations/moondream-client";
import { sendBrowserWsMessage, parseBrowserWsMessage, type BrowserWsMessage } from "./server/browser-ws-messages";
import { nativeDelegateRegistry, handleNativeDelegationFrame } from "./server/browser-native-delegate";
import { parseChatWsInbound } from "./server/schemas/chat-ws-inbound";
import { buildPresenceSnapshot } from "./server/presence";
import { SERVER_VERSION, SERVER_PROTOCOL_VERSION, SERVER_CAPABILITIES } from "./server/ws-capabilities";
import { ActivityMonitor } from "./server/activity-monitor";
import { createActivityRouter } from "./server/routes/activity";
import { JournalCollector } from "./server/journal-collector";
import { createJournalRouter } from "./server/routes/journal";
import { createTagsRouter } from "./server/routes/tags";
import { createAgentProfilesRouter } from "./server/routes/agent-profiles";
import { createDashboardRouter } from "./server/routes/dashboard";
import { getGatewayWS } from "./server/gateway-ws";
import { initProvider, recomputeDefault, getDefaultProviderName, stopAllProviders, getProvider } from "./server/providers";
import { pickTaskModelDetailed } from "./server/services/task-model-picker";
import { createProcessesRouter, startProcessDetection } from "./server/routes/processes";
import { createTasksRouter } from "./server/routes/tasks";
import { createPushRouter } from "./server/routes/push";
import { createUiStateRouter, loadAllUiState, assertUiStateMigrationApplied } from "./server/routes/ui-state";
import { createProvidersRouter } from "./server/routes/providers";
import { createClaudeHooksRouter } from "./server/routes/claude-hooks";
import { createClaudeSessionTracker } from "./server/lib/claude-session-tracker";
import { createProjectsRouter } from "./server/routes/projects";
import { createWorktreesRouter } from "./server/routes/worktrees";
import { createMachinesRouter } from "./server/routes/machines";
import { initVapid } from "./server/push-service";
import { startHeartbeatChecker } from "./server/agent-heartbeat";
import { startDevBundleReload } from "./server/lib/dev-bundle-reload";

// Gateway token: .env takes priority, falls back to reading from ~/.openclaw/openclaw.json
if (!process.env.GATEWAY_TOKEN) {
  try {
    const config = JSON.parse(readFileSync(join(process.env.HOME || "", ".openclaw", "openclaw.json"), "utf-8"));
    if (config?.gateway?.auth?.token) {
      process.env.GATEWAY_TOKEN = config.gateway.auth.token;
      console.log("[Startup] GATEWAY_TOKEN loaded from ~/.openclaw/openclaw.json");
    }
  } catch {}
  if (!process.env.GATEWAY_TOKEN) {
    // The OpenClaw gateway is an OPTIONAL integration (journal sync + the
    // "openclaw" relay provider). A standalone download has no OpenClaw config,
    // so a missing token must NOT be fatal: the app defaults to the Claude
    // provider and runs fine without the gateway. This previously process.exit(1)'d,
    // which crashed the bundled server before it could listen — the packaged app
    // then hung forever on "Launching the local engine" on every clean machine.
    console.warn("[Startup] GATEWAY_TOKEN not set — OpenClaw gateway features (journal sync, gateway relay) disabled; continuing without them.");
  }
}

// Solid singleton: a server booted from a DISPATCH WORKTREE (e.g. an agent that
// ran `bun run server.ts` inside its isolation checkout under ~/.topics/worktrees)
// must NOT hijack production. Sharing the ~/.topics daemon lock + the prod port
// let a worktree server (with its own empty DB) win the race and starve the real
// server into a crash-loop — the "board vuota / kanban rotto" failure. Redirect
// such a server onto a worktree-local TOPICS_HOME + an ephemeral port BEFORE the
// context reads PORT and before acquireLock reads TOPICS_HOME. Opt out with
// TOPICS_ALLOW_WORKTREE_PROD=1 (deliberately running prod from a worktree).
if (!process.env.TOPICS_ALLOW_WORKTREE_PROD) {
  const isoHome = worktreeIsolationHome(import.meta.dir, homedir());
  if (isoHome) {
    if (!process.env.TOPICS_HOME) process.env.TOPICS_HOME = isoHome;
    if (!process.env.PORT && !process.env.BUN_PORT) process.env.PORT = "0";
    console.log(
      `[Daemon] worktree server isolated → TOPICS_HOME=${process.env.TOPICS_HOME}, ` +
      `PORT=${process.env.PORT === "0" ? "ephemeral" : process.env.PORT} (won't touch production)`,
    );
  }
}

// Create app context (initializes SQLite database)
const ctx = createAppContext(import.meta.dir);
const { PORT, PUBLIC_DIR, wsClients, broadcastToAll, broadcastToTopic, broadcast,
  loadTopics, loadUnread, saveUnread,
  activeStreams, getMessageById, getMimeType, logRequest, db } = ctx;

// Phase 30 BROWSER-CHAT-03 — registry of active /ws/browser/:contextId
// connections keyed by contextId. Multiple panels may watch the same context
// (UI plus E2E spies); the broadcast iterates the whole set. Populated by the
// websocket.open browser branch and cleaned by websocket.close.
const browserWsClients = new Map<string, Set<ServerWebSocket<WSData>>>();

// Cross-window presence: broadcast the FULL list of windows that have declared
// their presence (via `hello`/`presence:announce`) plus the topics each holds.
// A full-snapshot (not deltas) is trivially idempotent across reconnects; the
// list self-heals because a dead socket drops out of `wsClients` before its
// close handler re-broadcasts. Purely WS-ephemeral — nothing is persisted.
// The dedup/build logic is pure in server/presence.ts (unit-tested).
function broadcastPresence() {
  const windows = buildPresenceSnapshot(
    (function* () {
      for (const client of wsClients) yield client.data;
    })(),
  );
  broadcastToAll({ type: 'presence:windows', windows });
}

function broadcastToBrowserWs(contextId: string, msg: BrowserWsMessage): void {
  const set = browserWsClients.get(contextId);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify(msg);
  for (const ws of set) {
    if (ws.readyState !== 1) continue;
    try {
      ws.send(payload);
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`[broadcastToBrowserWs] send failed for ${contextId}:`, m);
    }
  }
}

// Boot-time invariant (Bug #7): ui_state.payload_version/server_seq must exist
// (migration 012). Without this, every GET/PUT would silently degrade. Fail loud.
try {
  assertUiStateMigrationApplied(db);
  console.log("[Startup] ui_state migration 012 applied — payload_version + server_seq columns present");
} catch (err: any) {
  console.error(`[Startup] ${err?.message ?? err}`);
  process.exit(1);
}

// Boot-time orphan cleanup (post-mortem from May-3 sidebar-flash incident).
// A topic UUID with `project_path` set must render as a project pane, not a
// standalone topic-pane. If any such UUID remains in `ui_state` (pane-store-v2,
// project-layout-*, openChatTopicIds, …) the renderer's `usePanelLifecycle`
// Effect 7 will refuse to keep it open while the WS hydrate keeps re-applying
// it from the server — a ~750 Hz ping-pong that visually flashes the sidebar
// tree.  The renderer-side fix (PURGE_ORPHAN_PANE dispatch) is the *primary*
// defence; this is the boot-time backstop that auto-corrects any DB left in a
// corrupt state by an older renderer build.  Idempotent — no-op when clean.
try {
  const report = purgeOrphanTopicRefs(db);
  if (report.rowsAffected > 0) {
    console.log(
      `[Startup] ui_state orphan cleanup: rewrote ${report.rowsAffected} row(s), stripped ${report.refsRemoved} orphan ref(s)`,
      report.perKey,
    );
  } else {
    console.log("[Startup] ui_state orphan cleanup: clean (no orphans found)");
  }
} catch (err) {
  // Non-fatal: log loudly but don't abort boot — the runtime guard in
  // PURGE_ORPHAN_PANE will still catch any orphan that slips through.
  console.error("[Startup] ui_state orphan cleanup failed:", err);
}

// Init AI provider — pick the boot default:
//   1. AI_PROVIDER env override (explicit, always wins)
//   2. claude (Anthropic SDK) if ANTHROPIC_API_KEY → stateless, sub-friendly,
//      autonomous: history is rebuilt from the local SQLite messages table on
//      every turn, so it survives `bun --watch` restarts and gateway outages.
//   3. openai if OPENAI_API_KEY
//   4. openclaw only if GATEWAY_URL is set (explicit opt-in to the gateway —
//      conversation memory there lives on the gateway and was lost on restart)
//   5. graceful fallback to "claude" so the picker UI still has a target;
//      initProviders() below auto-registers anything else available.
const providerType =
  (process.env.AI_PROVIDER as any) ||
  (process.env.ANTHROPIC_API_KEY ? 'claude' :
   process.env.OPENAI_API_KEY ? 'openai' :
   process.env.GATEWAY_URL ? 'openclaw' :
   'claude');

const aiProvider = initProvider({
  type: providerType,
  ...(providerType === 'openclaw' ? {
    gatewayUrl: ctx.GATEWAY_URL,
    token: ctx.GATEWAY_TOKEN,
    refreshToken: () => ctx.refreshGatewayToken(),
  } : providerType === 'openai' ? {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL,
  } : {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.CLAUDE_MODEL,
  }),
} as any);

// Wire provider events to broadcast system + recompute default on
// connectivity changes. Without recompute, openclaw would stay as default
// after the gateway goes down, and every chat would silently fail until
// the user manually picked another provider.
if (aiProvider.onConnect) {
  aiProvider.onConnect(() => {
    console.log("[Server] AI provider connected");
    ctx.broadcastToAll({ type: "gateway:status", connected: true });
    if (recomputeDefault()) {
      console.log(`[Server] Default provider re-picked: ${getDefaultProviderName()}`);
    }
  });
}
if (aiProvider.onDisconnect) {
  aiProvider.onDisconnect((reason) => {
    console.log(`[Server] AI provider disconnected: ${reason}`);
    ctx.broadcastToAll({ type: "gateway:status", connected: false });
    if (recomputeDefault()) {
      console.log(`[Server] Default provider re-picked: ${getDefaultProviderName()}`);
    }
  });
}

// Keep ctx.gatewayWS for backward compatibility
if (aiProvider.name === 'openclaw') {
  ctx.gatewayWS = getGatewayWS() ?? undefined;
}

console.log(`[Server] AI provider: ${aiProvider.name} (capabilities: ${[...aiProvider.capabilities].join(', ')})`);

// Init browser service (lazy — Chromium launched on first use)
const browserService = await createBrowserService({
  onNavigate: (contextId, url, viewport) => {
    // Find the topic whose first 8 chars of id match contextId (matches
    // the convention at server/routes/topics.ts:1650). Topics are created with
    // `sessionKey = "topic:" + id.slice(0,8)`, so the indexed session_key lookup
    // resolves the common case in O(1) instead of a full loadTopics() table-scan
    // + 5 joins on every browser navigation. Fall back to the scan only if that
    // misses or returns a topic whose id prefix doesn't actually match (a topic
    // with a non-standard sessionKey), preserving the original behaviour exactly.
    try {
      let topic = ctx.getTopicBySessionKey("topic:" + contextId);
      if (!topic || topic.id.slice(0, 8) !== contextId) {
        topic = Object.values(ctx.loadTopics().topics).find(t => t.id.slice(0, 8) === contextId) ?? null;
      }
      if (!topic) return;  // contextId may be temp/standalone — ignore
      topic.browserState = {
        url,
        contextId,
        lastActiveAt: Date.now(),
        viewport,
      };
      ctx.saveSingleTopic(topic);
    } catch (err: any) {
      console.warn(`[server] onNavigate persist failed for ${contextId}:`, err.message);
    }
  },
  // Flush the per-context browser caches (observe elements + ref snapshot) and
  // the vision budget counter when a context is torn down, so a recreated
  // same-id context can't act on stale refs/bboxes and per-context maps don't
  // grow unbounded across many topics.
  onDestroy: (contextId) => { clearBrowserCaches(contextId); resetMoondreamCounter(contextId); },
  // Phase 30 BROWSER-CHAT-03 — wire agent_active broadcast through the
  // /ws/browser/:contextId registry maintained in this module.
  broadcastToBrowserWs,
});

// Init usage tracking (still uses JSON files — will be migrated in a future phase)
initUsageStore(ctx.STATE_DIR);
rebuildSummary();

// Claude Code session tracker — canonical lifecycle state for every Claude
// CLI session spawned via Topics (topic chats persist in the DB; topic-less
// terminal sessions are tracked in-memory). Created before the terminal router
// so the latter can register its sessions with it. See
// openspec/changes/claude-session-tracker.
const claudeSessionTracker = createClaudeSessionTracker({ db: ctx.db, broadcast: ctx.broadcastToAll, ptyIdleMs: getClaudeSessionPtyIdleMs });

// Create route handlers
const topicsRouter = createTopicsRouter(ctx, browserService);
const filesRouter = createFilesRouter(ctx);
const voiceRouter = createVoiceRouter(ctx);
const remoteRouter = createRemoteRouter(ctx);
const mediaRouter = createMediaRouter(ctx);
const branchesRouter = createBranchesRouter(ctx);
const browserRouter = createBrowserRouter(ctx, browserService);
const cronRouter = createCronRouter(ctx);
const contextRouter = createContextRouter(ctx);
const terminalRouter = createTerminalRouter(ctx, claudeSessionTracker);
const statusRouter = createStatusRouter(ctx);
const memoryRouter = createMemoryRouter(ctx);
const usageRouter = createUsageRouter(ctx);
const agentsRouter = createAgentsRouter(ctx);
const checkpointsRouter = createCheckpointsRouter(ctx);
const openclawContextRouter = aiProvider.name === 'openclaw' ? createOpenClawContextRouter(ctx) : null;
// Always-on: serves /api/topics/:id/context-preview and /context-snapshots.
// Independent of which provider is the default — every provider benefits
// from the canonical envelope inspector (change `topic-context-canonical`).
const contextPreviewRouter = createContextPreviewRouter(ctx);
const tagsRouter = createTagsRouter(ctx);
const agentProfilesRouter = createAgentProfilesRouter(ctx);
const dashboardRouter = createDashboardRouter(ctx);
const processesRouter = createProcessesRouter(ctx);
// ─── Task auto-dispatch (Kanban "drag → agent in a tab") ───────────────────
// The dispatcher is the ONLY place that starts a headless agent turn from a
// board gesture. All its host-specific wiring — the in-process turn runtime,
// worktree creation, project-path resolution — is assembled here and injected,
// keeping server/services/task-dispatcher.ts host-agnostic and unit-tested.
const dispatcherSvc = createTaskService(ctx.db);
const DISPATCH_WORKSPACE_DIR = join(ctx.OPENCLAW_DIR, "workspace");

async function abortHeadlessTurn(sessionKey: string): Promise<void> {
  const url = new URL("http://localhost/api/chat/abort");
  try {
    await topicsRouter(
      new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionKey }) }),
      url, "/api/chat/abort", "POST",
    );
  } catch { /* best-effort */ }
}

async function runHeadlessTurn(sessionKey: string, content: string, opts: { timeoutMs: number; contextMode?: "full" | "lean" }): Promise<void> {
  const url = new URL("http://localhost/api/chat");
  // contextMode "lean" (resume/continuation): the chat route skips re-injecting
  // the heavy context envelope (CLAUDE.md/README/memory/…) since the persistent
  // CLI session already has it — see assembleTopicContext(leanContext).
  const body = JSON.stringify({ sessionKey, messages: [{ role: "user", content }], contextMode: opts.contextMode ?? "full" });
  const resp = await topicsRouter(
    new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }),
    url, "/api/chat", "POST",
  );
  if (!resp || !resp.body) return;
  // The turn self-drives server-side (consumeGateway) whether or not we read the
  // SSE mirror; we drain it only to learn when the turn ENDS (the reconciliation
  // signal). A wall-clock backstop aborts a runaway turn.
  const reader = resp.body.getReader();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    abortHeadlessTurn(sessionKey).catch(() => {});
    reader.cancel().catch(() => {});
  }, opts.timeoutMs);
  try { while (true) { const { done } = await reader.read(); if (done) break; } }
  finally { clearTimeout(deadline); try { reader.releaseLock(); } catch { /* already released */ } }
  if (timedOut) throw new Error("turn exceeded wall-clock timeout");
}

// Ad-hoc dirs the server already references: topic projectPaths + terminal
// cwds. Most boards belong to projects opened this way (folder picker, Claude
// terminals) that were never registered in the ProjectStore — without these
// the dispatcher can't map their board id back to a directory. Same union
// rationale as the icon-allowlist gate in routes/projects.ts.
function dispatchExtraPaths(): string[] {
  const paths: string[] = [];
  try {
    for (const t of Object.values(ctx.loadTopics().topics)) {
      const p = (t as { projectPath?: string }).projectPath;
      if (p) paths.push(p);
    }
  } catch { /* best-effort source */ }
  try {
    for (const row of ctx.db.query("SELECT DISTINCT cwd FROM terminal_sessions").all() as Array<{ cwd?: string }>) {
      if (row.cwd) paths.push(row.cwd);
    }
  } catch { /* best-effort source */ }
  return paths;
}

// Incremental, dedup-by-message-id usage accounting over Claude Code
// transcripts (see transcript-usage.ts). One instance: it caches per-path
// byte offsets so the dispatcher's 4s live ticker stays O(appended bytes).
const transcriptUsageReader = createTranscriptUsageReader();

const taskDispatcher = createTaskDispatcher({
  svc: dispatcherSvc,
  // Self-heal dead bindings: a todo task linked to a topic that was reaped
  // (agent tab deleted after a prior run) would never dispatch. tick() clears
  // the dead link so the task runs again.
  topicExists: (id) => !!ctx.getTopicById(id),
  // Must match the catch-all dir tasks.ts scaffolds (join(workspaceDir,
  // "generale")): a session resolved here renders standalone, not as a project.
  catchAllProjectPath: join(DISPATCH_WORKSPACE_DIR, "generale"),
  // Private per-task cwd for a catch-all task: a unique dir under the workspace
  // so the task's topic gets a unique projectPath (→ its own splittable
  // workspace claims the agent's browser panes). Non-git, like the shared
  // catch-all dir, so the worktree guard behaves identically.
  catchAllTaskDir: (taskId) => {
    const dir = join(DISPATCH_WORKSPACE_DIR, "tasks", taskId.slice(0, 8));
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  // "modello auto" → a fast haiku one-shot classifies the task and picks the
  // tier before the agent spawns. Standard is OPUS-first: unsure/unavailable/
  // empty-snapshot all resolve to opus (the human's default), never a silent
  // downgrade — the picker itself never throws (see task-model-picker.ts).
  pickAutoModel: async (task) => {
    try {
      const provider = getProvider("claude-code");
      const { getSnapshotManager } = await import("./server/providers/snapshot-manager");
      const snap = getSnapshotManager().getSnapshot();
      const cc = snap?.providers?.find((p) => p.name === "claude-code");
      const availableModels = cc?.models ?? [];
      // No snapshot yet → can't classify, but opus-first means we still hand the
      // agent opus (the human's default + this host's primary), never a downgrade.
      if (availableModels.length === 0) return { model: "claude-opus-4-8", fuzzy: false };
      return await pickTaskModelDetailed(task, {
        // Force the cheapest tier for the classification itself.
        complete: (prompt) =>
          provider.complete([{ role: "user", content: prompt }], { model: "claude-haiku-4-5" }).then((r) => r.content ?? ""),
        availableModels,
        fallback: "claude-opus-4-8",
        log: (m) => console.log(`[dispatcher] ${m}`),
      });
    } catch {
      return { model: "claude-opus-4-8", fuzzy: false }; // any failure → opus-first, never a silent downgrade
    }
  },
  // Auto concurrency cap: live machine capacity for boards on `maxAgentsAuto`.
  recommendedCap: () => computeDispatchCapacity().recommended,
  resolveProject: (projectId) => {
    const c = resolveProjectPath(
      projectId,
      buildProjectCandidates({
        projectStore: ctx.projectStore,
        workspaceDir: DISPATCH_WORKSPACE_DIR,
        extraPaths: dispatchExtraPaths,
      }),
    );
    if (!c) return null;
    // Worktrees require a ProjectStore row. Ad-hoc projects (path-only
    // candidates) that are git repos get registered on demand, so the default
    // "isola in un worktree" board setting actually works for them instead of
    // parking every task with "progetto non registrato".
    let storeId = c.projectStoreId;
    if (!storeId && existsSync(join(c.path, ".git"))) {
      try {
        const existing = ctx.projectStore.getByPath(c.path);
        if (existing) {
          storeId = existing.id;
        } else {
          const name = basename(c.path);
          let slug = ctx.projectStore.slugify(name);
          // Slug is UNIQUE; a same-named project at another path gets a suffix.
          if (ctx.projectStore.getBySlug(slug)) slug = `${slug}-${Date.now().toString(36)}`.slice(0, 64);
          storeId = ctx.projectStore.create({ name, slug, path: c.path }).id;
          console.log(`[dispatcher] auto-registered project "${name}" (${c.path}) for worktree dispatch`);
        }
      } catch (err) {
        console.error(`[dispatcher] project auto-register failed for ${c.path}`, err);
      }
    }
    return { path: c.path, projectStoreId: storeId };
  },
  createTopic: (o) => {
    const { topic } = createDetachedTopic(
      // background: an agent session never pops a tab — it lives in the
      // sidebar; the task drawer's "apri tab" un-archives it on demand.
      { name: o.name, projectPath: o.projectPath, worktreeId: o.worktreeId, systemPrompt: o.systemPrompt, effort: o.effort, model: o.model, background: true, standalone: o.standalone, mcpPolicy: o.mcpPolicy },
      {
        getTopicById: ctx.getTopicById,
        loadTopics: ctx.loadTopics,
        saveSingleTopic: ctx.saveSingleTopic,
        slugify: ctx.slugify,
        broadcastToAll: ctx.broadcastToAll,
      },
    );
    return { topicId: topic.id, sessionKey: topic.sessionKey };
  },
  createWorktree: async (projectStoreId) => {
    const wt = await ctx.worktreeManager.create({ projectId: projectStoreId, mode: "branch", baseRef: "HEAD" });
    const ready = await ctx.worktreeManager.awaitMaterialisation(wt.id, 120_000);
    if (ready.status !== "ready") {
      throw new Error(`worktree ${wt.id}: ${ready.status}${ready.errorMessage ? " " + ready.errorMessage : ""}`);
    }
    return ready.id;
  },
  deleteWorktree: async (worktreeId) => { await ctx.worktreeManager.delete(worktreeId); },
  runTurn: runHeadlessTurn,
  // Usage consumed by the dispatched session so far, from its Claude Code
  // transcript (jsonl_path is kept fresh by the session tracker). The reader
  // (transcript-usage.ts) is incremental (per-path byte offset — the live
  // ticker polls every 4s) and DEDUPLICATES usage rows by message.id (Claude
  // Code writes one per content block; the old inline sum overcounted ~2.4x).
  // Best-effort — a missing/unparsable transcript reads as zeros, and the
  // dispatcher only books per-turn deltas.
  getSessionUsage: (sessionKey: string) => {
    const row = ctx.db
      .prepare("SELECT jsonl_path FROM claude_code_sessions WHERE session_key = ?")
      .get(sessionKey) as { jsonl_path?: string | null } | null;
    const path = row?.jsonl_path;
    if (!path) return ZERO_USAGE;
    return transcriptUsageReader.read(path);
  },
  broadcast: ctx.broadcastToAll,
});

// Opt-in auto-merge on approve (board setting `dispatchAutoMerge`). Resolves a
// task → its dispatch topic → worktree → project's main checkout, then merges the
// branch there. Only `branch`-mode worktrees on a ready project have something to
// land; everything else resolves to null (skip). Default branch is `main`.
const taskAutoMerge = createTaskAutoMerge({
  resolveTaskMerge: (taskId) => {
    const topicId = dispatcherSvc.get(taskId)?.task.assignedTopicId;
    if (!topicId) return null;
    const worktreeId = ctx.getTopicById(topicId)?.worktreeId;
    if (!worktreeId) return null;
    const wt = ctx.worktreeStore.get(worktreeId);
    if (!wt || wt.mode !== "branch" || !wt.branchName) return null;
    const repoPath = ctx.projectStore.get(wt.projectId)?.path;
    if (!repoPath) return null;
    return { repoPath, branch: wt.branchName, defaultBranch: "main" };
  },
  log: (msg, err) => console.error(msg, err ?? ""),
});

const tasksRouter = createTasksRouter(ctx, taskDispatcher, {
  workspaceDir: DISPATCH_WORKSPACE_DIR,
  autoMerge: taskAutoMerge,
  // Human "stop" on a dispatched task cuts the running turn (same abort path
  // as the dispatcher's wall-clock timeout).
  abortTurn: abortHeadlessTurn,
  // Same union the dispatcher resolves against — but trimmed to the dirs that
  // are actually SELECTABLE boards. Internal catch-all plumbing (the shared
  // `generale` dir, the per-task `tasks/<id8>` cwds), the home dir, config
  // dot-dirs and vanished paths are dropped so the picker/sidebar stay clean;
  // the resolver above keeps the FULL union so those hashes still invert.
  listProjectDirs: () =>
    buildProjectCandidates({
      projectStore: ctx.projectStore,
      workspaceDir: DISPATCH_WORKSPACE_DIR,
      extraPaths: dispatchExtraPaths,
    })
      .map((c) => c.path)
      .filter((p) => isSelectableProjectDir(p, { workspaceDir: DISPATCH_WORKSPACE_DIR, homeDir: homedir() })),
});
// Auto-register servers Claude starts inside its PTY sessions (bare `bun run dev`
// etc.) into the Processes panel, attributing listening ports by PTY process tree.
startProcessDetection(ctx, getClaudeSessionsForDetection);
const pushRouter = createPushRouter(ctx);
const uiStateRouter = createUiStateRouter(ctx);
const providersRouter = createProvidersRouter(ctx);

const claudeHooksRouter = createClaudeHooksRouter(ctx, claudeSessionTracker);
// Replay JSONL tails for any session whose state was lost on the previous
// shutdown, then start the reaper and the LIVE transcript tail. All three are
// fire-and-forget — they advance state independently of the live hook stream.
// The live tail is what tracks turns no hook announces (a Monitor firing, a
// background task completing, a teammate message waking a parked session).
claudeSessionTracker.recoverFromJsonl().catch((err) => {
  console.error("[claude-session-tracker] Boot recovery failed", err);
});
claudeSessionTracker.startReaper();
claudeSessionTracker.startJsonlTail();
const projectsRouter = createProjectsRouter(ctx);
const worktreesRouter = createWorktreesRouter(ctx);
const machinesRouter = createMachinesRouter(ctx);

// Phase D — heartbeat ticker. Upserts the local machine row every 30 s
// and flips other machines that haven't checked in for 5 minutes to
// `offline`. Cheap (one indexed UPDATE + one indexed SELECT per tick).
const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 5 * 60_000;
function tickHeartbeat() {
  try {
    const local = ctx.machineStore.upsertLocal();
    ctx.broadcastToAll({ type: "machine:upserted", machine: local, payload_version: 1 });
    const flipped = ctx.machineStore.markStaleOffline(STALE_THRESHOLD_MS);
    for (const m of flipped) {
      ctx.broadcastToAll({ type: "machine:updated", machine: m, payload_version: 1 });
    }
  } catch (err) {
    console.warn("[Heartbeat] tick failed:", err);
  }
}
tickHeartbeat();
const heartbeatTimer = setInterval(tickHeartbeat, HEARTBEAT_INTERVAL_MS);

// Periodic ui_state backup — defence-in-depth against accidental wipes.
// Snapshot once at startup so any pre-restart state is preserved on disk
// before any client PUT can overwrite it; then the ticker takes over.
try {
  snapshotUiStateNow(ctx.db);
  console.log(`[UiStateBackup] initial snapshot written → ~/.topics/ui-state-backups/`);
} catch (err) {
  console.warn("[UiStateBackup] initial snapshot failed:", err);
}
const stopUiStateBackup = startUiStateBackupTicker(ctx.db);

// Wire snapshot manager → WS broadcast. Single 100ms debounce coalesces
// the multiple "loading → ready" transitions a single refresh fires.
{
  // Lazy require to keep this block the only load site (avoid stale singletons in --watch mode).
  const { getSnapshotManager } = await import("./server/providers/snapshot-manager");
  const snapMgr = getSnapshotManager();
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  const SNAPSHOT_BROADCAST_DEBOUNCE_MS = 100;
  snapMgr.on("change", () => {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      broadcastToAll({ type: "providers:snapshot", snapshot: snapMgr.getSnapshot() });
    }, SNAPSHOT_BROADCAST_DEBOUNCE_MS);
  });
  // Trigger an initial warm-up so clients connecting at startup get fresh data.
  void snapMgr.refresh();
}

// Initialize VAPID keys on startup
initVapid();
// Start agent heartbeat checker
const stopHeartbeatChecker = startHeartbeatChecker(db, broadcastToAll);
// Dev bundle hot-delivery: rebuilt /public → open windows self-reload.
// Inert unless STATE_DIR/topics-dev.json exists (never in standalone installs).
// getRev() also feeds the WS open handler: every (re)connecting window gets
// the current bundle rev and self-reloads if stale — covers deploys that
// landed while the watcher was off or the window was disconnected.
const devBundleReload = startDevBundleReload({
  publicDir: PUBLIC_DIR,
  stateDir: ctx.STATE_DIR,
  broadcastToAll,
});

// NOTE: the session attention monitor is NOT auto-started. It runs only when
// the user enables it from Topics (POST /api/master/monitor) — nothing runs
// "a caso". Default OFF on every server start. See session-monitor.ts.

// Init activity monitor (watches gateway log files)
const activityMonitor = new ActivityMonitor();
const activityRouter = createActivityRouter(ctx, activityMonitor);

// Init journal collector (polls gateway for daily summaries)
const journalCollector = new JournalCollector(ctx.STATE_DIR, ctx.GATEWAY_URL, ctx.GATEWAY_TOKEN);
journalCollector.start();
const journalRouter = createJournalRouter(ctx, journalCollector);

const WS_HEARTBEAT_INTERVAL_MS = 30000;
const WS_TIMEOUT_MS = 90000;

// WebSocket heartbeat
const wsHeartbeatTimer = setInterval(() => {
  const now = Date.now();
  for (const ws of wsClients) {
    if (now - ws.data.lastPong > WS_TIMEOUT_MS) {
      console.log(`[WS] Removing stale client ${ws.data.id} (no pong for ${Math.round((now - ws.data.lastPong) / 1000)}s)`);
      wsClients.delete(ws);
      try { ws.close(1001, "Connection timeout"); } catch {}
      continue;
    }
    if (ws.readyState === 1) { try { ws.ping(); } catch {} }
  }
  // Browser screencast sockets are kept OUT of wsClients, so reap them here too.
  // Without this, a half-open TCP break (laptop sleep / network drop) never
  // fires `close`, so _browserCleanup never runs and the CDP screencast keeps
  // streaming JPEG frames into a dead socket — this watchdog is the only thing
  // that releases the CDP session. _browserCleanup is idempotent, so calling it
  // here and again in the close handler is safe.
  for (const [ctxId, set] of browserWsClients) {
    for (const ws of set) {
      if (now - ws.data.lastPong > WS_TIMEOUT_MS) {
        console.log(`[WS][browser] Reaping stale browser client for ctx ${ctxId} (no pong for ${Math.round((now - ws.data.lastPong) / 1000)}s)`);
        // De-register the native executor explicitly (idempotent): a server-side
        // close on an already-half-dead socket may not fire the `close` handler,
        // which would otherwise leave a Tauri pane's delegation pointing at a dead
        // socket so isDelegated() keeps routing agent ops into the void.
        // Owner-scoped: if the pane already re-registered on a NEWER socket
        // (reconnect after sleep), reaping this stale one must not drop the
        // fresh registration.
        nativeDelegateRegistry.unregister(ctxId, ws);
        void ws.data._browserCleanup?.();
        set.delete(ws);
        try { ws.close(1001, "Connection timeout"); } catch {}
        continue;
      }
      if (ws.readyState === 1) { try { ws.ping(); } catch {} }
    }
    if (set.size === 0) browserWsClients.delete(ctxId);
  }
}, WS_HEARTBEAT_INTERVAL_MS);

// Startup cleanup: remove orphaned unread entries
{
  const topicsData = loadTopics();
  const unreadData = loadUnread();
  let cleaned = false;
  for (const topicId of Object.keys(unreadData)) {
    if (!topicsData.topics[topicId]) { delete unreadData[topicId]; cleaned = true; }
  }
  if (cleaned) { saveUnread(unreadData); console.log("[Startup] Cleaned orphaned unread entries"); }
}

// Startup: reset stale partial messages (via SQLite)
{
  console.log("[Startup] Checking for stale partial messages...");
  const result = db.run("UPDATE messages SET partial = 0, streamed_at = NULL WHERE partial = 1");
  if (result.changes > 0) {
    console.log(`[Startup] Reset ${result.changes} stale partial messages`);
  } else {
    console.log("[Startup] No stale partial messages found");
  }
}

const tlsCert = join(import.meta.dir, "certs", "fullchain.pem");
const tlsKey = join(import.meta.dir, "certs", "key.pem");
const useTls = !process.env.NO_TLS && await Bun.file(tlsCert).exists() && await Bun.file(tlsKey).exists();

// ─── Phase B · Daemon lifecycle (DAEMON-01) ────────────────────────────────
// Acquire singleton lock + write state file BEFORE Bun.serve so
// concurrent boots see the live lock and exit fast. The state file is
// finalised after Bun.serve returns the actual port (in case PORT=0).
try {
  acquireLock();
} catch (err) {
  if (err instanceof LiveLockError) {
    console.error(`[Daemon] ${err.message}`);
    console.error(`[Daemon] If the other process is dead, delete ~/.topics/daemon-process.lock manually.`);
    process.exit(1);
  }
  throw err;
}

// PORTING-PLAN.md Tier 1 — CORS for the Tauri desktop shell, which serves the UI
// locally (tauri://localhost) and calls this server cross-origin for /api + /ws.
// Provably a no-op for the existing web/Electron clients: their Origin is never a
// tauri/desktop origin, so corsAllowOrigin() returns "" and nothing is added.
function corsAllowOrigin(req: Request): string {
  const origin = req.headers.get("origin") || "";
  // macOS WKWebView → tauri://localhost; Windows WebView2 → http(s)://tauri.localhost
  if (origin === "tauri://localhost" || origin === "http://tauri.localhost" || origin === "https://tauri.localhost") {
    return origin;
  }
  return "";
}
function applyDesktopCors(req: Request, resp: Response): void {
  const origin = corsAllowOrigin(req);
  if (!origin) return;
  resp.headers.set("Access-Control-Allow-Origin", origin);
  resp.headers.set("Vary", "Origin");
}
function corsPreflightHeaders(req: Request, origin: string): Record<string, string> {
  // Reflect whatever headers the request wants to send: origin is already
  // gated to the desktop-shell origins, and a fixed list rots — it silently
  // blocked every PUT carrying X-Client-Id (pane/layout sync), so the desktop
  // never persisted state except via the header-less sendBeacon teardown path.
  const requested = req.headers.get("access-control-request-headers");
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": requested || "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin, Access-Control-Request-Headers",
  };
}

const server = Bun.serve<WSData>({
  port: PORT,
  // Bind host. Default "::" dual-stack: with net.inet6.ip6.v6only=0 (macOS
  // default) it owns BOTH the IPv6 and the IPv4-mapped families on PORT, so
  // Topics occupies localhost on every resolution path — important on a DEV box
  // where a stray server could otherwise squat ::1:PORT and clients using
  // `localhost` (resolved to ::1 first) land on it ("connecting forever").
  //
  // BUT on some Bun/macOS combos a "::" bind is effectively IPv6-only, so a
  // client connecting to 127.0.0.1 (which the packaged Electron app and its
  // readiness probe deliberately use) cannot reach it → the app hangs on the
  // splash and a relaunch hits EADDRINUSE against the still-running instance.
  // The packaged launcher therefore sets SERVER_HOST="0.0.0.0" (all IPv4 incl.
  // 127.0.0.1 and the LAN address for mobile/PWA access); IPv6 ::1 is unused by
  // the app. Override via SERVER_HOST; default stays "::" so dev is unchanged.
  hostname: process.env.SERVER_HOST || "::",
  // Exclusive ownership for the singleton. With reusePort:true a SECOND Topics
  // server on the same port doesn't fail — the OS lets both bind and round-robins
  // connections between them, so a live prod server and a stray one (e.g. a
  // worktree server with an empty DB) take turns answering and the board flickers
  // full/empty. false → the second bind fails fast with EADDRINUSE. The daemon
  // lock (acquired before Bun.serve) is the primary guard; this is defense in
  // depth for any server that bypasses it via a custom TOPICS_HOME.
  reusePort: false,
  idleTimeout: 255,
  ...(useTls ? {
    tls: {
      cert: Bun.file(tlsCert),
      key: Bun.file(tlsKey),
    },
  } : {}),

  async fetch(req, server) {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;
    const startTime = Date.now();
    const isApiRequest = pathname.startsWith("/api/");
    if (isApiRequest) console.log(`[HTTP] → ${method} ${pathname}`);

    // Phase B · DAEMON-02: token-authed loopback control endpoints.
    // We read the state file fresh on every call so a state-file rewrite
    // (e.g. token rotation in a future phase) takes effect immediately.
    if (pathname.startsWith("/__daemon/")) {
      const fresh = readState();
      const auth = req.headers.get("authorization") || "";
      const match = auth.match(/^Bearer\s+([0-9a-f]{64})$/i);
      const token = match?.[1] ?? "";
      if (!fresh || token.length !== 64 || token !== fresh.token) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401, headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && pathname === "/__daemon/healthz") {
        return new Response(JSON.stringify({
          pid: fresh.pid,
          startedAt: fresh.startedAt,
          uptime_ms: uptimeMsSince(fresh.startedAt),
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && pathname === "/__daemon/shutdown") {
        // Reply first so the caller sees 202; SIGTERM ourselves a tick
        // later so the existing graceful-shutdown handler runs.
        setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
        return new Response(JSON.stringify({ ok: true }), {
          status: 202, headers: { "content-type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    }

    // WebSocket upgrade - terminal
    if (pathname.startsWith("/ws/terminal/")) {
      const termId = pathname.split("/ws/terminal/")[1];
      const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), focusedTopicId: null, lastPong: Date.now(), terminalId: termId } });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Phase 30 BROWSER-CHAT-02 — WebSocket upgrade for browser streaming.
    // Path: /ws/browser/:contextId — bidirectional. server -> client carries
    // 'frame' (CDP screencast JPEG base64) and 'agent_active'/'console'/'nav'
    // events; client -> server carries 'input' actions (click/type/scroll/etc).
    // The per-WS lifecycle (startScreencast on open, stopScreencast on close,
    // input dispatch on message) lives in the websocket.{open,message,close}
    // handlers below.
    if (pathname.startsWith("/ws/browser/")) {
      const browserContextId = decodeURIComponent(pathname.split("/ws/browser/")[1] || "");
      if (!browserContextId) {
        return new Response("Missing contextId", { status: 400 });
      }
      const upgraded = server.upgrade(req, {
        data: {
          id: crypto.randomUUID(),
          focusedTopicId: null,
          lastPong: Date.now(),
          browserContextId,
        },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // WebSocket upgrade
    if (pathname === "/ws") {
      const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), focusedTopicId: null, lastPong: Date.now() } });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Dev mode proxy: ?dev=true proxies to Topics Vite dev server on :3332
    const isDevMode = url.searchParams.get("dev") === "true" || req.headers.get("cookie")?.includes("topics-dev=true");
    if (isDevMode && method === "GET" && !pathname.startsWith("/api/") && !pathname.startsWith("/ws")) {
      try {
        const viteUrl = `https://localhost:3332${pathname}${url.search}`;
        const viteResp = await fetch(viteUrl, { headers: req.headers, tls: { rejectUnauthorized: false } } as any);
        if (viteResp.ok) {
          const respHeaders = new Headers(viteResp.headers);
          if (url.searchParams.get("dev") === "true") {
            respHeaders.set("Set-Cookie", "topics-dev=true; Path=/; SameSite=Lax");
          }
          return new Response(viteResp.body, { status: viteResp.status, headers: respHeaders });
        }
      } catch {
        // Vite not running, fall through to static files
      }
    }
    // Exit dev mode: ?dev=false clears cookie
    if (url.searchParams.get("dev") === "false") {
      return new Response(null, { status: 302, headers: { "Location": "/", "Set-Cookie": "topics-dev=; Path=/; Max-Age=0" } });
    }

    // Static files
    const isDevPort = PORT === 3330;
    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      let html = await Bun.file(join(PUBLIC_DIR, "index.html")).text();
      if (isDevPort) {
        html = html
          .replace(/\/icons\/icon-180\.png/g, '/icons/icon-180-dev.png')
          .replace(/\/icons\/icon-192\.png/g, '/icons/icon-192-dev.png')
          .replace('href="/manifest.json"', 'href="/manifest-dev.json"');
      }
      // no-STORE, not no-cache: the app shell must never sit in a cache. With
      // `no-cache` WKWebView still served a stale index.html after a deploy
      // (revalidation didn't fire reliably), so the desktop kept booting the
      // old bundle. `no-store` forces a fresh fetch every launch; the hashed
      // /assets/* stay immutable, so this costs one tiny HTML fetch, not the JS.
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (method === "GET" && pathname.endsWith(".html")) {
      const file = Bun.file(join(PUBLIC_DIR, pathname));
      if (await file.exists()) return new Response(file, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (method === "GET" && (pathname.startsWith("/assets/") || pathname.startsWith("/icons/") || pathname === "/vite.svg" || pathname === "/manifest.json" || pathname === "/manifest-dev.json" || pathname === "/sw.js")) {
      const filePath = join(PUBLIC_DIR, pathname);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        const cacheControl = pathname === "/manifest.json" || pathname === "/manifest-dev.json" || pathname === "/sw.js" ? "no-cache" : "public, max-age=31536000, immutable";
        return new Response(file, { headers: { "Content-Type": getMimeType(filePath), "Cache-Control": cacheControl } });
      }
    }

    // Serve uploaded files (screenshots, attachments)
    if (method === "GET" && pathname.startsWith("/uploads/")) {
      const filePath = join(ctx.UPLOADS_DIR, pathname.slice("/uploads/".length));
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": getMimeType(filePath), "Cache-Control": "public, max-age=3600" } });
      }
      return new Response("Not Found", { status: 404 });
    }

    // Serve OpenClaw media files (browser screenshots, etc.)
    // Handles paths like /media/browser/uuid.jpg → ~/.openclaw/media/browser/uuid.jpg
    if (method === "GET" && pathname.startsWith("/media/") && !pathname.includes("..")) {
      const mediaBase = join(process.env.HOME || "/tmp", ".openclaw", "media");
      const filePath = join(mediaBase, pathname.slice("/media/".length));
      // Security: ensure resolved path stays within media directory (match on a
      // trailing separator so a sibling like `…/media-evil` can't sneak through,
      // while still allowing the base dir itself).
      const resolvedFile = resolve(filePath);
      const resolvedBase = resolve(mediaBase);
      if (resolvedFile === resolvedBase || resolvedFile.startsWith(resolvedBase + sep)) {
        const file = Bun.file(filePath);
        if (await file.exists()) {
          return new Response(file, { headers: { "Content-Type": getMimeType(filePath), "Cache-Control": "public, max-age=86400" } });
        }
      }
      return new Response("Not Found", { status: 404 });
    }

    // Preview endpoint: serve local files for browser panel
    if (method === "GET" && pathname.startsWith("/preview/")) {
      let filePath = decodeURIComponent(pathname.slice("/preview".length));
      if (!filePath.startsWith("/")) filePath = "/" + filePath;
      const resolved = resolve(filePath);
      if (resolved !== filePath || filePath.includes("..")) return new Response("Forbidden", { status: 403 });
      try {
        const file = Bun.file(resolved);
        if (await file.exists()) {
          return new Response(file, { headers: { "Content-Type": getMimeType(resolved), "Cache-Control": "no-cache" } });
        }
      } catch {}
      return new Response("Not Found", { status: 404 });
    }

    // Desktop shell (Tauri) CORS preflight — no-op for non-desktop origins.
    if (isApiRequest && method === "OPTIONS") {
      const o = corsAllowOrigin(req);
      if (o) return new Response(null, { status: 204, headers: corsPreflightHeaders(req, o) });
    }

    // Route through handlers
    if (isApiRequest) {
      const response = await topicsRouter(req, url, pathname, method)
        || await voiceRouter(req, url, pathname, method)
        || await remoteRouter(req, url, pathname, method)
        || await mediaRouter(req, url, pathname, method)
        || await branchesRouter(req, url, pathname, method)
        || await projectsRouter(req, url, pathname, method)
        || await worktreesRouter(req, url, pathname, method)
        || await machinesRouter(req, url, pathname, method)
        || await filesRouter(req, url, pathname, method)
        || await browserRouter(req, url, pathname, method)
        || await cronRouter(req, url, pathname, method)
        || await contextRouter(req, url, pathname, method)
        || await terminalRouter(req, url, pathname, method)
        || await statusRouter(req, url, pathname, method)
        || await memoryRouter(req, url, pathname, method)
        || await usageRouter(req, url, pathname, method)
        || await activityRouter(req, url, pathname, method)
        || await agentsRouter(req, url, pathname, method)
        || await checkpointsRouter(req, url, pathname, method)
        || await journalRouter(req, url, pathname, method)
        || (openclawContextRouter && await openclawContextRouter(req, url, pathname, method))
        || await contextPreviewRouter(req, url, pathname, method)
        || await tagsRouter(req, url, pathname, method)
        || await agentProfilesRouter(req, url, pathname, method)
        || await dashboardRouter(req, url, pathname, method)
        || await processesRouter(req, url, pathname, method)
        || await tasksRouter(req, url, pathname, method)
        || await pushRouter(req, url, pathname, method)
        || await uiStateRouter(req, url, pathname, method)
        || await providersRouter(req, url, pathname, method)
        || await claudeHooksRouter(req, url, pathname, method)
;

      if (response) {
        applyDesktopCors(req, response);
        return response;
      }
      logRequest(method, pathname, 404, startTime);
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    maxPayloadLength: 1024 * 1024,
    open(ws) {
      ws.data.lastPong = Date.now();

      // Phase 30 BROWSER-CHAT-02 — browser WS branch.
      // Started BEFORE the terminal branch since both use ws.data fields,
      // but the browser branch is the more specific check.
      if (ws.data.browserContextId) {
        const ctxId = ws.data.browserContextId;
        console.log(`[WS][browser] Open: ${ws.data.id} -> ctx ${ctxId}`);
        // Phase 30 BROWSER-CHAT-03 — register this WS in the broadcast set
        // so broadcastToBrowserWs(ctxId, msg) reaches it.
        let bset = browserWsClients.get(ctxId);
        if (!bset) {
          bset = new Set();
          browserWsClients.set(ctxId, bset);
        }
        bset.add(ws);
        // This WS's own frame consumer. Hoisted to a const so we pass the SAME
        // identity to stopScreencast — with fan-out, that removes only THIS
        // viewer and leaves the shared CDP screencast running for the others
        // (the old stopScreencast(ctxId) detached the session, blacking out
        // every other client viewing the same browser).
        const onFrame = (data: string, metadata: { timestamp: number; pageScaleFactor?: number; deviceWidth?: number; deviceHeight?: number }) => {
          // Backpressure: if the WS isn't OPEN (1), drop the frame.
          if (ws.readyState !== 1) return;
          // Backpressure #2 — congested link: the CDP screencast keeps producing at
          // full local rate and its frame ACK fires on receipt (decoupled from this
          // send), so a slow viewer (mobile PWA on a bad link) would otherwise pile
          // frames unbounded in the server-side WS send buffer. DROP instead of
          // queue: for a LIVE view the freshest frame once the buffer drains is what
          // matters, not a stale backlog. ~1MB ≈ tens of q70 JPEG frames of slack.
          if (ws.getBufferedAmount() > 1_000_000) return;
          sendBrowserWsMessage(ws, {
            type: 'frame',
            data,
            metadata: {
              timestamp: metadata.timestamp,
              pageScaleFactor: metadata.pageScaleFactor,
              deviceWidth: metadata.deviceWidth,
              deviceHeight: metadata.deviceHeight,
            },
          });
        };
        // Deferred + race-safe screencast start. A Tauri native pane's FIRST
        // frame is `register_native_executor`, which arrives a few ms after
        // open — but startScreencast's getOrCreate would already be launching a
        // headless Chromium for a context that must NOT exist server-side
        // (delegated panes run ops natively). The old code started eagerly and
        // the 'registered' cleanup raced it: stopScreencast found no session
        // yet (idempotent no-op), the start then completed seconds later, and
        // the screencast streamed JPEGs forever into a pane that ignores them —
        // with the phantom context pinning Chromium past the reaper's
        // contexts.size===0 gate. The grace window lets the register frame
        // cancel the start before anything launches; if the start already
        // began, cleanup AWAITS it before stopping so the stop can't lose.
        const SCREENCAST_START_GRACE_MS = 250;
        let screencastCancelled = false;
        let screencastStart: Promise<void> | null = null;
        const screencastTimer = setTimeout(() => {
          if (screencastCancelled) return;
          screencastStart = browserService.startScreencast(ctxId, onFrame).catch(err => {
            console.warn(`[WS][browser] startScreencast failed for ${ctxId}:`, err.message);
            try {
              ws.send(JSON.stringify({ type: 'error', message: `Screencast start failed: ${err.message}` }));
            } catch {}
          });
        }, SCREENCAST_START_GRACE_MS);
        ws.data._browserCleanup = async () => {
          screencastCancelled = true;
          clearTimeout(screencastTimer);
          if (screencastStart) await screencastStart;
          await browserService.stopScreencast(ctxId, onFrame).catch(err =>
            console.warn(`[WS][browser] stopScreencast failed for ${ctxId}:`, err.message)
          );
        };
        return;
      }

      const termId = ws.data.terminalId;
      if (termId) {
        // Terminal WebSocket
        const handler = handleTerminalWebSocket(ws, termId);
        if (handler) ws.data._termHandler = handler;
        return;
      }
      wsClients.add(ws);
      console.log(`[WS] Client connected: ${ws.data.id} (total: ${wsClients.size})`);
      ws.send(JSON.stringify({ type: "connected", clientId: ws.data.id }));
      // v3 foundations WS-02 — handshake welcome (additive; old clients ignore unknown types).
      ws.send(JSON.stringify({
        type: "welcome",
        serverVersion: SERVER_VERSION,
        protocolVersion: SERVER_PROTOCOL_VERSION,
        capabilities: SERVER_CAPABILITIES,
        serverTime: Date.now(),
        clientId: ws.data.id,
      }));
      // Dev-only freshness check: a window that missed the deploy-time
      // broadcast reloads itself on reconnect (null when the flag is off —
      // standalone installs never see this frame).
      { const __rev = devBundleReload.getRev(); if (__rev) ws.send(JSON.stringify({ type: "ui:bundle-rev", rev: __rev })); }
      ws.send(JSON.stringify({ type: "unread:init", data: loadUnread() }));
      { const __ui = loadAllUiState(db); ws.send(JSON.stringify({ type: "ui-state:init", data: __ui.data, meta: __ui.meta })); }
      // Initial provider snapshot — keeps the picker / settings page in sync without an extra HTTP fetch.
      try {
        const { getSnapshotManager } = require("./server/providers/snapshot-manager") as typeof import("./server/providers/snapshot-manager");
        ws.send(JSON.stringify({ type: "providers:snapshot", snapshot: getSnapshotManager().getSnapshot() }));
      } catch {
        // Snapshot manager not loaded yet — initial bootstrap will broadcast once it warms up.
      }

      // Send catch-up for any active streams so new clients can join mid-stream.
      //
      // The catchup MUST include `toolCalls` and `blocks` from the partial
      // message in DB, not just `content` + `thinking`. Without them, a fresh
      // WS connect (browser refresh, second window, network reconnect) sees
      // only the cumulative text and loses any tool calls that already
      // executed in the stream — the user perceives "response arrived all
      // at once with no tools visible". With them, the chronological timeline
      // is preserved and future stream:* deltas continue appending live.
      // The common case is zero active streams (idle app): skip the work
      // entirely rather than paying a full loadTopics() table-scan+joins on
      // every WS connect. When streams do exist, resolve each one's topicId
      // via the indexed single-row lookup instead of scanning all topics.
      for (const [sessionKey, stream] of activeStreams.entries()) {
        // Trust the DB's `partial` flag as single source of truth: if the
        // assistant message was already finalized, the stream is over even
        // though `activeStreams` still has a stale entry (can happen when an
        // `endStream` path skipped cleanup, or when a broadcast was lost
        // before this client reconnected). Emitting catchup here would
        // wedge the client's `streaming` state on for up to 3 min until the
        // watchdog clears it — which the user perceives as random ghost
        // spinners on chat tabs.
        const partial = getMessageById(stream.messageId);
        if (!partial || partial.partial !== true) {
          activeStreams.delete(sessionKey);
          continue;
        }
        const topicId = ctx.getTopicBySessionKey(sessionKey)?.id;
        ws.send(JSON.stringify({
          type: "stream:catchup",
          sessionKey,
          topicId,
          messageId: stream.messageId,
          content: stream.content,
          thinking: stream.thinking,
          isThinking: stream.isThinking,
          toolCalls: partial.toolCalls,
          blocks: partial.blocks,
        }));
      }
    },
    message(ws, message) {
      ws.data.lastPong = Date.now();

      // Phase 30 BROWSER-CHAT-02 — browser WS branch.
      if (ws.data.browserContextId) {
        const ctxId = ws.data.browserContextId;
        try {
          const raw = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
          // Tauri native-pane delegation — raw types OUTSIDE the strict browser-ws
          // Zod envelope (kept out of it on purpose so the schema stays the
          // streaming protocol). Classified by the shared helper (unit-tested);
          // handled before parseBrowserWsMessage.
          const delegated = handleNativeDelegationFrame(
            raw, ctxId,
            (m) => { try { ws.send(JSON.stringify(m)); } catch {} },
            nativeDelegateRegistry,
            ws, // owner — lets unregister() skip stale-socket cleanups after a re-register
          );
          if (delegated === 'registered') {
            // A native pane runs ops itself — it never views server frames, so tear
            // down the screencast the open handler auto-started (no wasted headless
            // Chromium / bandwidth for a context that isn't streaming).
            try { void ws.data._browserCleanup?.(); } catch {}
            ws.data._browserCleanup = undefined;
            console.log(`[WS][browser] native executor registered for ctx ${ctxId}`);
            return;
          }
          if (delegated === 'result') return;
          const result = parseBrowserWsMessage(raw);
          if (!result.ok) {
            console.warn(`[WS][browser] Invalid message from ${ws.data.id}: ${result.error}`);
            return;
          }
          const parsed = result.data;
          if (parsed.type === 'input') {
            browserService.dispatchInput(ctxId, parsed.action, parsed.payload).catch(err =>
              console.warn(`[WS][browser] dispatchInput failed for ${ctxId}:`, err.message)
            );
          } else if (parsed.type === 'nav' && parsed.phase === 'request') {
            browserService.navigate(ctxId, parsed.url).then((r) => {
              // goto failures resolve with `error` (page stayed on the old
              // URL); launch failures reject below. Both must reach the pane
              // as phase 'error' — a bare 'response' here made every failed
              // navigation invisible (BRW-REL-02).
              if (r.error) {
                sendBrowserWsMessage(ws, { type: 'nav', url: parsed.url, phase: 'error', error: r.error });
              } else {
                sendBrowserWsMessage(ws, { type: 'nav', url: parsed.url, phase: 'response' });
              }
            }).catch(err => {
              const msg = err instanceof Error ? (err.message.split('\n')[0] || 'Browser failed to start') : String(err);
              console.warn(`[WS][browser] navigate failed for ${ctxId}:`, msg);
              try {
                sendBrowserWsMessage(ws, { type: 'nav', url: parsed.url, phase: 'error', error: msg });
              } catch { /* socket gone — nothing to surface to */ }
            });
          } else if (parsed.type === 'take_control') {
            // Phase 30 BROWSER-CHAT-04 — user reclaimed control. Force-release the
            // lock with an eager agent_active=false broadcast. The agent's in-flight
            // tool will complete naturally (Playwright actions are quick), and its
            // withLock finally block will broadcast agent_active=false a second
            // time. The double-broadcast is idempotent on the client. Aborting the
            // tool mid-action is a future enhancement (would require an
            // AbortController plumbed through BrowserService dispatchInput / handlers).
            console.log(`[WS][browser] take_control received for ctx ${ctxId}`);
            browserService.broadcastAgentActive(ctxId, false);
          }
          // Ignore other message types from client (frame/agent_active/console are server -> client only).
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[WS][browser] Failed to parse message from ${ws.data.id}:`, msg);
        }
        return;
      }

      const handler = ws.data._termHandler;
      if (handler) { handler.message(message); return; }
      try {
        const raw = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
        const result = parseChatWsInbound(raw);
        if (!result.ok) {
          // Backward-compat: silently drop unknown/malformed messages instead
          // of crashing. The previous handler did the same (unmatched types
          // hit none of the `if` branches). Log in dev for observability.
          if (process.env.NODE_ENV !== 'production') {
            console.warn(`[WS] Invalid inbound message from ${ws.data.id}: ${result.error}`);
          }
          return;
        }
        const data = result.data;
        switch (data.type) {
          case 'focus':
            ws.data.focusedTopicId = data.topicId;
            break;
          case 'subscribe':
            // P6: the set of topics this connection currently has open, used to
            // route streaming deltas only to clients showing that topic.
            ws.data.openTopicIds = new Set(data.topicIds);
            break;
          case 'typing':
            broadcastToTopic(data.topicId, { type: 'typing', topicId: data.topicId, clientId: ws.data.id, text: data.text || '' }, ws);
            break;
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
          case 'drag:start':
            broadcast({ type: 'drag:start', topicId: data.topicId, sourceWindowId: data.windowId }, ws);
            break;
          case 'drag:end':
            broadcast({ type: 'drag:end', topicId: data.topicId, sourceWindowId: data.windowId }, ws);
            break;
          case 'drag:drop':
            broadcastToAll({ type: 'drag:accepted', topicId: data.topicId, targetWindowId: data.windowId, sourceWindowId: data.sourceWindowId });
            break;
          case 'hello':
            // v3 foundations WS-02 handshake — log client version + capabilities
            // for observability. Future protocol versions may use this to emit
            // an `upgrade-required` frame when clientProtocolVersion < SERVER_PROTOCOL_VERSION.
            console.log(`[WS][handshake] hello from ${ws.data.id}: client v${data.clientVersion} (proto ${data.protocolVersion}), caps=[${data.capabilities.join(', ')}]`);
            // Presence: a window may carry its identity + open topics on hello
            // (reconnect-safe — the client re-sends hello on every WS 'open').
            if (data.windowId) {
              ws.data.windowId = data.windowId;
              ws.data.windowLabel = data.windowLabel;
              ws.data.detached = data.detached;
              ws.data.presenceTopicIds = data.topicIds ?? [];
              ws.data.presenceFocusedTopicId = data.focusedTopicId;
              broadcastPresence();
            }
            break;
          case 'presence:announce':
            // Presence update after hello (tab opened/closed/focused inside the
            // window, or detach state changed). Restamp this socket + re-snapshot.
            ws.data.windowId = data.windowId;
            ws.data.windowLabel = data.windowLabel;
            ws.data.detached = data.detached;
            ws.data.presenceTopicIds = data.topicIds;
            ws.data.presenceFocusedTopicId = data.focusedTopicId;
            broadcastPresence();
            break;
        }
      } catch (err) { console.warn(`[WS] Failed to parse message from ${ws.data.id}:`, err); }
    },
    pong(ws) { ws.data.lastPong = Date.now(); },
    close(ws) {
      // Phase 30 BROWSER-CHAT-02 — browser WS branch.
      if (ws.data.browserContextId) {
        console.log(`[WS][browser] Close: ${ws.data.id} -> ctx ${ws.data.browserContextId}`);
        // Phase 30 BROWSER-CHAT-03 — remove from broadcast set BEFORE invoking
        // cleanup so any concurrent broadcast no longer targets this socket.
        const bset = browserWsClients.get(ws.data.browserContextId);
        if (bset) {
          bset.delete(ws);
          if (bset.size === 0) browserWsClients.delete(ws.data.browserContextId);
        }
        // Drop any native-executor registration for this pane + fail its in-flight
        // ops (Tauri delegation) — no-op if this context never registered, and
        // owner-scoped so a late `close` from an OLD socket can't kill a fresh
        // re-registration made by the pane's reconnect (see unregister()).
        nativeDelegateRegistry.unregister(ws.data.browserContextId, ws);
        ws.data._browserCleanup?.().catch(err =>
          console.warn(`[WS][browser] cleanup failed:`, err.message)
        );
        return;
      }

      const handler = ws.data._termHandler;
      if (handler) { handler.close(); return; }
      // Remove from client set FIRST so concurrent isTopicFocused() iterations
      // don't see this ws at all. Clear focusedTopicId after as defense-in-depth
      // in case any ref to this ws object lingers elsewhere.
      wsClients.delete(ws);
      ws.data.focusedTopicId = null;
      console.log(`[WS] Client disconnected: ${ws.data.id} (total: ${wsClients.size})`);
      // Presence self-heal: if this socket had declared a window, re-broadcast
      // so peers drop its "open elsewhere" markers the instant it dies. Removed
      // from wsClients first, so the fresh snapshot no longer includes it.
      if (ws.data.windowId) broadcastPresence();
    },
  },
});

// Stale stream cleanup
const STALE_STREAM_CHECK_INTERVAL_MS = 30_000;
const STALE_STREAM_TIMEOUT_MS = 3 * 60 * 1000;
const staleStreamTimer = setInterval(() => {
  const now = Date.now();
  for (const [sessionKey, stream] of activeStreams.entries()) {
    if (!activeStreams.has(sessionKey)) continue;
    // Fast path — DB says the partial assistant message is already finalized
    // but the in-memory entry lingered (lost cleanup in some endStream path).
    // Drop it silently: nobody is mid-stream to notify, and leaving it would
    // cause ghost `stream:catchup` events on future WS reconnects.
    const partial = getMessageById(stream.messageId);
    if (!partial || partial.partial !== true) {
      activeStreams.delete(sessionKey);
      continue;
    }
    const lastActivity = new Date(stream.lastActivity).getTime();
    if (now - lastActivity > STALE_STREAM_TIMEOUT_MS) {
      console.log(`[StaleStream] Auto-clearing stale stream for ${sessionKey}`);
      // Finalize partial messages via SQLite
      db.run("UPDATE messages SET partial = 0, streamed_at = NULL WHERE session_key = ? AND partial = 1", [sessionKey]);
      const topicId = ctx.getTopicBySessionKey(sessionKey)?.id;
      broadcastToAll({ type: "stream:end", sessionKey, topicId, reason: "stale_timeout" });
      activeStreams.delete(sessionKey);
    }
  }
}, STALE_STREAM_CHECK_INTERVAL_MS);

// Task auto-dispatch reconciliation: on boot, requeue any in-progress task whose
// agent turn died with the previous process; then poll to fill free slots on
// boards with auto_dispatch on (also the safety net if a →todo hook is missed).
// reconcile() is a no-op for boards with auto_dispatch off, so this is cheap.
const DISPATCH_POLL_MS = 10_000;
taskDispatcher.reconcile().catch((err) => console.error("[dispatcher] boot reconcile failed", err));
const dispatchTimer = setInterval(() => {
  taskDispatcher.reconcile().catch((err) => console.error("[dispatcher] poll reconcile failed", err));
}, DISPATCH_POLL_MS);

const proto = useTls ? "https" : "http";
const wsProto = useTls ? "wss" : "ws";
console.log(`🚀 Topics App running at ${proto}://localhost:${PORT}`);
console.log(`📡 WebSocket available at ${wsProto}://localhost:${PORT}/ws`);
if (useTls) console.log(`🔒 TLS enabled (cert: ${tlsCert})`);
console.log(`🌐 BrowserService available (lazy Chromium, WebSocket at /ws/browser/:id)`);

// Phase B · DAEMON-01: finalise state file once Bun.serve owns a port.
// `server.port` reflects the *actual* port (Bun resolves 0 → ephemeral).
const daemonState = writeState(server.port ?? PORT);
console.log(`[Daemon] state written → pid=${daemonState.pid} port=${daemonState.port}`);

// Phase 30 BROWSER-CHAT-01 — restore browser contexts in background.
// Fire-and-forget: never blocks server startup. Errors are logged but
// never thrown (matches restoreAllContexts contract).
browserService.restoreAllContexts(Object.values(ctx.loadTopics().topics))
  .then(r => console.log(`[server] browser restore: ${r.restored} restored, ${r.failed} failed`))
  .catch(err => console.warn(`[server] browser restore failed (non-fatal):`, err.message));

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n[Shutdown] Received ${signal}, closing browser service...`);
  clearInterval(heartbeatTimer);
  clearInterval(wsHeartbeatTimer);
  clearInterval(staleStreamTimer);
  clearInterval(dispatchTimer);
  taskDispatcher.shutdown();
  stopHeartbeatChecker();      // agent FSM stale-checker (was an unstoppable leak)
  activityMonitor.destroy();   // closes the log fs.watch + batch/persist timers
  journalCollector.stop();     // clears the journal collection interval
  stopUiStateBackup();
  disconnectBridge(); // Disconnect from bridge — bridge daemon stays alive, PTY sessions persist
  await browserService.close();
  // Stop all AI providers BEFORE closing the DB. claude-code's stop() sends
  // SIGTERM to the spawned `claude` CLI children so they flush session state
  // to ~/.claude/sessions/ — without this, `bun --watch` hot reloads left
  // children orphaned and the next spawn started a fresh conversation. The
  // grace window inside stopAllProviders matches each provider's internal
  // SIGTERM→SIGKILL window so process.exit() doesn't truncate the flush.
  await stopAllProviders();
  closeDatabase();
  releaseLock();
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
