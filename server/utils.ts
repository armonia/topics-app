import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { readFileSync } from "fs";
import { join, resolve, extname } from "path";
import type { ServerWebSocket } from "bun";
import type { Database } from "bun:sqlite";
import { clientReceivesTopicDelta } from "./lib/ws-topic-routing";
import type {
  WSData, StoredMessage, ToolCall, Topic, TopicsData, UnreadData,
  ActiveStream, ErrorResponseOptions, AppContext,
} from "./types";
import { initDatabase } from "./db";
import { maybeSendPush } from "./push-triggers";
import { createProjectStore } from "./services/project-store";
import { createWorktreeStore } from "./services/worktree-store";
import { createWorktreeManager } from "./services/worktree-manager";
import { createMachineStore } from "./services/machine-store";
import { parseToolCallDetail } from "./schemas/tool-call-detail";
import { validateOutbound } from "./schemas/ws-outbound";

/**
 * v3 foundations WS-01 outbound validation hook. Runs in DEV mode only —
 * zero overhead in production. Catches server-side bugs that emit malformed
 * payloads at the source instead of letting clients discover them.
 *
 * For types not registered in `OUTBOUND_SCHEMAS`, this is a no-op.
 * Migration is incremental: add schemas as types stabilize.
 */
function devValidateOutbound(message: object): void {
  if (process.env.NODE_ENV === 'production') return;
  const result = validateOutbound(message);
  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.warn(`[WS:outbound] Malformed broadcast — ${result.error}`, message);
  }
}

/**
 * v3 foundations NORM-01 DB hydration: validate a tool call's `detail`
 * field against the canonical Zod schema. If the detail is missing,
 * returns the toolCall unchanged. If the detail is present and parses,
 * the validated copy is substituted. If the detail is present but
 * malformed (drifted schema, corrupt JSON, etc.), the detail field is
 * dropped — the renderer falls back to client-side derivation. Logs a
 * one-line warning at NORM-DB level so drift is observable without
 * spamming production.
 */
function sanitizeToolCallDetail(tc: any): any {
  if (!tc || typeof tc !== 'object' || !tc.detail) return tc;
  const result = parseToolCallDetail(tc.detail);
  if (result.ok) {
    return tc.detail === result.data ? tc : { ...tc, detail: result.data };
  }
  console.warn(`[NORM-DB] Dropping malformed detail for tool call ${tc.id ?? '?'} (${tc.name ?? '?'}): ${result.error}`);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { detail: _drop, ...rest } = tc;
  return rest;
}

export function createAppContext(baseDir: string): AppContext {
  // CLI PORT override: BUN_PORT beats .env PORT (Bun auto-loads .env first)
  const PORT = parseInt(process.env.BUN_PORT || process.env.PORT || "3333");
  const GATEWAY_URL = process.env.GATEWAY_URL || "http://127.0.0.1:18789";
  let GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || readGatewayTokenFromConfig() || "";

  /** Read gateway token from ~/.openclaw/openclaw.json (auto-syncs when OpenClaw rotates) */
  function readGatewayTokenFromConfig(): string | null {
    try {
      const configPath = join(process.env.HOME || "", ".openclaw", "openclaw.json");
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      return config?.gateway?.auth?.token || null;
    } catch { return null; }
  }

  /** Refresh token from openclaw.json — called on auth failure */
  function refreshGatewayToken(): string {
    const fresh = readGatewayTokenFromConfig();
    if (fresh && fresh !== GATEWAY_TOKEN) {
      console.log("[Gateway] Token refreshed from openclaw.json");
      GATEWAY_TOKEN = fresh;
    }
    return GATEWAY_TOKEN;
  }

  const TOPICS_FILE = join(baseDir, "topics.json");
  const UNREAD_FILE = join(baseDir, "unread.json");
  const PUBLIC_DIR = join(baseDir, "public");
  const UPLOADS_DIR = join(baseDir, "uploads");
  const CONTEXT_DIR = join(baseDir, "context-files");
  const OPENCLAW_DIR = process.env.APP_DATA_DIR || process.env.OPENCLAW_DIR || `${process.env.HOME}/.openclaw`;
  const SESSIONS_DIR = process.env.SESSIONS_DIR || `${OPENCLAW_DIR}/agents/main/sessions`;
  const MESSAGES_DIR = join(baseDir, "messages");

  mkdirSync(MESSAGES_DIR, { recursive: true });

  // Initialize SQLite
  const db = initDatabase(baseDir);

  // State
  const activeStreams = new Map<string, ActiveStream>();
  const wsClients = new Set<ServerWebSocket<WSData>>();

  // --- Prepared statements (created once for performance) ---
  const stmts = {
    // Topics
    getAllTopics: db.prepare(`SELECT * FROM topics WHERE 1=1`),
    getTopicById: db.prepare(`SELECT * FROM topics WHERE id = ?`),
    getTopicLinks: db.prepare(`SELECT target_id FROM topic_links WHERE source_id = ?`),
    getTopicContextFiles: db.prepare(`SELECT file_path FROM topic_context_files WHERE topic_id = ?`),
    getTopicPinnedMessages: db.prepare(`SELECT message_id FROM topic_pinned_messages WHERE topic_id = ?`),
    getTopicDisabledSources: db.prepare(`SELECT source_id FROM topic_disabled_sources WHERE topic_id = ?`),
    getTopicAssignedAgents: db.prepare(`SELECT a.agent_id, p.name, a.role FROM agent_assignments a LEFT JOIN agent_profiles p ON a.agent_id = p.id WHERE a.topic_id = ?`),
    // Batch variants used ONLY by loadTopics() to collapse the per-topic N+1
    // (1 table scan + 5 sub-queries × N topics) into 1 + 5 full scans grouped
    // in-memory. The per-id stmts above stay the path for single-topic reads
    // (getTopicById / getTopicBySessionKey), which must not pay a full scan.
    getAllTopicLinks: db.prepare(`SELECT source_id, target_id FROM topic_links`),
    getAllTopicContextFiles: db.prepare(`SELECT topic_id, file_path FROM topic_context_files`),
    getAllTopicPinnedMessages: db.prepare(`SELECT topic_id, message_id FROM topic_pinned_messages`),
    getAllTopicDisabledSources: db.prepare(`SELECT topic_id, source_id FROM topic_disabled_sources`),
    getAllTopicAssignedAgents: db.prepare(`SELECT a.topic_id, a.agent_id, p.name, a.role FROM agent_assignments a LEFT JOIN agent_profiles p ON a.agent_id = p.id`),

    insertTopic: db.prepare(`
      INSERT OR REPLACE INTO topics (id, name, slug, parent_id, session_key, color, icon, system_prompt, project_path, sort_order, autonomy_level, provider, model, fast_mode, worktree_id, initial_message, archived, created_at, updated_at)
      VALUES ($id, $name, $slug, $parent_id, $session_key, $color, $icon, $system_prompt, $project_path, $sort_order, $autonomy_level, $provider, $model, $fast_mode, $worktree_id, $initial_message, $archived, $created_at, $updated_at)
    `),
    deleteTopic: db.prepare(`DELETE FROM topics WHERE id = ?`),

    // Topic relations
    deleteTopicLinks: db.prepare(`DELETE FROM topic_links WHERE source_id = ?`),
    insertTopicLink: db.prepare(`INSERT OR IGNORE INTO topic_links (source_id, target_id) VALUES (?, ?)`),
    deleteTopicContextFiles: db.prepare(`DELETE FROM topic_context_files WHERE topic_id = ?`),
    insertTopicContextFile: db.prepare(`INSERT OR IGNORE INTO topic_context_files (topic_id, file_path) VALUES (?, ?)`),
    deleteTopicPinnedMessages: db.prepare(`DELETE FROM topic_pinned_messages WHERE topic_id = ?`),
    insertTopicPinnedMessage: db.prepare(`INSERT OR IGNORE INTO topic_pinned_messages (topic_id, message_id) VALUES (?, ?)`),
    deleteTopicDisabledSources: db.prepare(`DELETE FROM topic_disabled_sources WHERE topic_id = ?`),
    insertTopicDisabledSource: db.prepare(`INSERT OR IGNORE INTO topic_disabled_sources (topic_id, source_id) VALUES (?, ?)`),
    // Unread
    getAllUnread: db.prepare(`SELECT topic_id, last_read_at, unread_count FROM unread`),
    upsertUnread: db.prepare(`INSERT OR REPLACE INTO unread (topic_id, last_read_at, unread_count) VALUES (?, ?, ?)`),
    deleteUnread: db.prepare(`DELETE FROM unread WHERE topic_id = ?`),

    // Messages
    getMessages: db.prepare(`SELECT * FROM messages WHERE session_key = ? ORDER BY sort_order ASC`),
    getLastMessage: db.prepare(`SELECT * FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1`),
    getMaxSortOrder: db.prepare(`SELECT COALESCE(MAX(sort_order), -1) as max_order FROM messages WHERE session_key = ?`),
    insertMessage: db.prepare(`
      INSERT INTO messages (id, session_key, role, content, thinking, tool_calls, blocks, media, partial, streamed_at, plan_status, timestamp, sort_order, parent_id, branch_index, latency_ms, usage_prompt_tokens, usage_completion_tokens, cost_cents)
      VALUES ($id, $session_key, $role, $content, $thinking, $tool_calls, $blocks, $media, $partial, $streamed_at, $plan_status, $timestamp, $sort_order, $parent_id, $branch_index, $latency_ms, $usage_prompt_tokens, $usage_completion_tokens, $cost_cents)
    `),
    updateMessage: db.prepare(`
      UPDATE messages SET content = $content, thinking = $thinking, tool_calls = $tool_calls,
        blocks = COALESCE($blocks, blocks),
        media = $media,
        partial = $partial, streamed_at = $streamed_at, plan_status = $plan_status,
        latency_ms = COALESCE($latency_ms, latency_ms),
        usage_prompt_tokens = COALESCE($usage_prompt_tokens, usage_prompt_tokens),
        usage_completion_tokens = COALESCE($usage_completion_tokens, usage_completion_tokens),
        cost_cents = COALESCE($cost_cents, cost_cents)
      WHERE id = $id
    `),
    deleteMessagesBySession: db.prepare(`DELETE FROM messages WHERE session_key = ?`),

    // Branching
    getMessageById: db.prepare(`SELECT * FROM messages WHERE id = ?`),
    getChildren: db.prepare(`SELECT * FROM messages WHERE parent_id = ? ORDER BY branch_index ASC`),
    getSiblings: db.prepare(`SELECT * FROM messages WHERE parent_id = ? ORDER BY branch_index ASC`),
    getMaxBranchIndex: db.prepare(`SELECT COALESCE(MAX(branch_index), -1) as max_idx FROM messages WHERE parent_id = ?`),
    getActiveBranch: db.prepare(`SELECT active_branch_index FROM active_branches WHERE parent_id = ? AND session_key = ?`),
    upsertActiveBranch: db.prepare(`INSERT OR REPLACE INTO active_branches (parent_id, session_key, active_branch_index) VALUES (?, ?, ?)`),
    getRootMessages: db.prepare(`SELECT * FROM messages WHERE session_key = ? AND parent_id IS NULL ORDER BY sort_order ASC`),
    deleteActiveBranchesBySession: db.prepare(`DELETE FROM active_branches WHERE session_key = ?`),

  };

  // Pre-grouped topic relations, built once per loadTopics() call by
  // buildTopicRelations() and threaded into rowToTopic to avoid the N+1.
  type TopicRelations = {
    links: Map<string, string[]>;
    contextFiles: Map<string, string[]>;
    pinnedMessages: Map<string, string[]>;
    disabledSources: Map<string, string[]>;
    assignedAgents: Map<string, { id: string; name: string; role: string }[]>;
  };
  function buildTopicRelations(): TopicRelations {
    const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
      const arr = m.get(k); if (arr) arr.push(v); else m.set(k, [v]);
    };
    const links = new Map<string, string[]>();
    for (const r of stmts.getAllTopicLinks.all() as any[]) push(links, r.source_id, r.target_id);
    const contextFiles = new Map<string, string[]>();
    for (const r of stmts.getAllTopicContextFiles.all() as any[]) push(contextFiles, r.topic_id, r.file_path);
    const pinnedMessages = new Map<string, string[]>();
    for (const r of stmts.getAllTopicPinnedMessages.all() as any[]) push(pinnedMessages, r.topic_id, r.message_id);
    const disabledSources = new Map<string, string[]>();
    for (const r of stmts.getAllTopicDisabledSources.all() as any[]) push(disabledSources, r.topic_id, r.source_id);
    const assignedAgents = new Map<string, { id: string; name: string; role: string }[]>();
    for (const r of stmts.getAllTopicAssignedAgents.all() as any[]) push(assignedAgents, r.topic_id, { id: r.agent_id, name: r.name || r.agent_id, role: r.role });
    return { links, contextFiles, pinnedMessages, disabledSources, assignedAgents };
  }

  // --- Helper: Convert SQLite topic row to Topic object ---
  // `rels` (supplied by loadTopics) reads relations from pre-grouped maps;
  // without it each relation is a per-id sub-query (single-topic read path).
  function rowToTopic(row: any, rels?: TopicRelations): Topic {
    const topic: Topic = {
      id: row.id,
      name: row.name,
      slug: row.slug,
      parentId: row.parent_id || null,
      links: rels ? (rels.links.get(row.id) ?? []) : (stmts.getTopicLinks.all(row.id) as any[]).map(r => r.target_id),
      sessionKey: row.session_key,
      color: row.color,
      icon: row.icon,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archived: !!row.archived,
    };
    if (row.system_prompt) topic.systemPrompt = row.system_prompt;
    if (row.project_path) topic.projectPath = row.project_path;
    if (row.sort_order !== undefined) topic.sortOrder = row.sort_order;
    if (row.autonomy_level && row.autonomy_level !== 'ask') topic.autonomyLevel = row.autonomy_level;
    if (row.provider) topic.provider = row.provider;
    if (row.model) topic.model = row.model;
    // fast_mode (migration 024). 1 = enabled, 0/NULL = disabled (default).
    // Only attached when truthy so legacy rows (pre-migration, before backfill)
    // round-trip through inspector serializers unchanged.
    if (row.fast_mode) topic.fastMode = true;
    // worktree_id (Phase A · migration 018). Optional FK; legacy rows are NULL.
    if (row.worktree_id) topic.worktreeId = row.worktree_id;
    // Phase C · TOPIC-IM-01. Surfaced when present; legacy NULL omitted.
    if (row.initial_message) topic.initialMessage = row.initial_message;

    const contextFiles = rels ? (rels.contextFiles.get(row.id) ?? []) : (stmts.getTopicContextFiles.all(row.id) as any[]).map(r => r.file_path);
    if (contextFiles.length > 0) topic.contextFiles = contextFiles;

    const pinnedMessages = rels ? (rels.pinnedMessages.get(row.id) ?? []) : (stmts.getTopicPinnedMessages.all(row.id) as any[]).map(r => r.message_id);
    if (pinnedMessages.length > 0) topic.pinnedMessages = pinnedMessages;

    const disabledSources = rels ? (rels.disabledSources.get(row.id) ?? []) : (stmts.getTopicDisabledSources.all(row.id) as any[]).map(r => r.source_id);
    if (disabledSources.length > 0) topic.disabledContextSources = disabledSources;

    const assignedAgents = rels ? (rels.assignedAgents.get(row.id) ?? []) : (stmts.getTopicAssignedAgents.all(row.id) as any[]).map(r => ({
      id: r.agent_id,
      name: r.name || r.agent_id,
      role: r.role,
    }));
    if (assignedAgents.length > 0) topic.assignedAgents = assignedAgents;

    return topic;
  }

  // --- Helper: Save a single topic and its relations to SQLite ---
  /**
   * Upsert a topic plus its 4 child relation tables atomically. Wrapped in
   * one transaction so a concurrent reader (e.g. another request running
   * `getTopicById`) never sees the half-state where links/contextFiles/etc.
   * have been DELETEd but not yet re-INSERTed.
   *
   * Without the transaction, the 9 statements below were a write fence —
   * any reader landing between `deleteTopicLinks` and the matching insert
   * loop would observe the topic with `links: []` for a few microseconds.
   * SQLite's WAL mode masks most of this, but Bun's `await` yields make
   * the gap large enough to matter under load.
   */
  function saveSingleTopic(topic: Topic): void {
    db.transaction(() => {
      stmts.insertTopic.run({
        $id: topic.id,
        $name: topic.name,
        $slug: topic.slug,
        $parent_id: topic.parentId || null,
        $session_key: topic.sessionKey,
        $color: topic.color,
        $icon: topic.icon,
        $system_prompt: topic.systemPrompt || null,
        $project_path: topic.projectPath || null,
        $sort_order: topic.sortOrder ?? 0,
        $autonomy_level: topic.autonomyLevel || 'ask',
        $provider: topic.provider || null,
        $model: topic.model || null,
        // fast_mode column gets 0/1 — SQLite has no native boolean. Coerce
        // here so callers can pass `undefined` (legacy topics) and still get
        // the schema's NOT NULL DEFAULT 0 guarantee.
        $fast_mode: topic.fastMode ? 1 : 0,
        // worktree_id (Phase A · migration 018). NULL = no binding; FK
        // ON DELETE SET NULL on the column ensures graceful degrade.
        $worktree_id: topic.worktreeId || null,
        // initial_message (Phase C · migration 019). One-shot — the renderer
        // PATCHes back to null after dispatching it.
        $initial_message: topic.initialMessage || null,
        $archived: topic.archived ? 1 : 0,
        $created_at: topic.createdAt,
        $updated_at: topic.updatedAt,
      });

      // Links
      stmts.deleteTopicLinks.run(topic.id);
      if (topic.links?.length) {
        for (const targetId of topic.links) stmts.insertTopicLink.run(topic.id, targetId);
      }

      // Context files
      stmts.deleteTopicContextFiles.run(topic.id);
      if (topic.contextFiles?.length) {
        for (const fp of topic.contextFiles) stmts.insertTopicContextFile.run(topic.id, fp);
      }

      // Pinned messages
      stmts.deleteTopicPinnedMessages.run(topic.id);
      if (topic.pinnedMessages?.length) {
        for (const msgId of topic.pinnedMessages) stmts.insertTopicPinnedMessage.run(topic.id, msgId);
      }

      // Disabled sources
      stmts.deleteTopicDisabledSources.run(topic.id);
      if (topic.disabledContextSources?.length) {
        for (const src of topic.disabledContextSources) stmts.insertTopicDisabledSource.run(topic.id, src);
      }
    })();
  }

  /**
   * Delete a single topic, its child relations, and all per-session data
   * (messages, active branch pointers, claude-code session id) cascaded by
   * sessionKey. Wrapped in one transaction so a half-deleted topic can't
   * leave orphans visible to a concurrent reader.
   *
   * The `messages` table can't have a real FK to `topics` because not all
   * sessionKeys are topic-owned (terminals, agents, telegram bridges all
   * share the same column), so we sweep explicitly here. The
   * `claude_code_sessions` table DOES have FK CASCADE (migration 023) — the
   * explicit DELETE here is redundant when foreign_keys=ON but cheap and
   * defensive against a future config drift.
   */
  function deleteTopicById(id: string): void {
    // Resolve the topic's sessionKey BEFORE the transaction so we can sweep
    // by session_key inside the same atomic write.
    const row = stmts.getTopicById.get(id) as { session_key?: string } | undefined;
    const sessionKey = row?.session_key;
    db.transaction(() => {
      stmts.deleteTopicLinks.run(id);
      stmts.deleteTopicContextFiles.run(id);
      stmts.deleteTopicPinnedMessages.run(id);
      stmts.deleteTopicDisabledSources.run(id);
      if (sessionKey) {
        // Sweep messages and active branch pointers — these reference
        // session_key (no FK), so SQLite won't cascade them automatically.
        stmts.deleteMessagesBySession.run(sessionKey);
        stmts.deleteActiveBranchesBySession.run(sessionKey);
        // Defense-in-depth: drop the claude_code_sessions row even if FK
        // CASCADE happens to be disabled in this build.
        db.prepare("DELETE FROM claude_code_sessions WHERE session_key = ?").run(sessionKey);
      }
      stmts.deleteTopic.run(id);
    })();
  }

  // --- Helper: Convert SQLite message row to StoredMessage ---
  function rowToMessage(row: any): StoredMessage {
    const msg: StoredMessage = {
      id: row.id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
    };
    if (row.thinking) msg.thinking = row.thinking;
    if (row.tool_calls) {
      try {
        const parsed = JSON.parse(row.tool_calls);
        msg.toolCalls = Array.isArray(parsed)
          ? parsed.map(sanitizeToolCallDetail)
          : parsed;
      } catch {}
    }
    if (row.blocks) {
      try {
        const parsed = JSON.parse(row.blocks);
        if (Array.isArray(parsed)) {
          // v3 foundations NORM-01 DB hydration: each block of kind 'tool'
          // carries a toolCall whose `detail` may be a legacy / drifted
          // shape. Sanitize at the boundary so downstream consumers always
          // see a schema-conforming detail or none.
          msg.blocks = parsed.map((block: any) => {
            if (block && block.kind === 'tool' && block.toolCall) {
              return { ...block, toolCall: sanitizeToolCallDetail(block.toolCall) };
            }
            return block;
          });
        }
      } catch {}
    }
    if (row.media) {
      try { msg.media = JSON.parse(row.media); } catch {}
    }
    if (row.partial) msg.partial = true;
    if (row.streamed_at) msg.streamedAt = row.streamed_at;
    if (row.plan_status) msg.planStatus = row.plan_status;
    if (row.parent_id !== undefined && row.parent_id !== null) msg.parentId = row.parent_id;
    if (row.branch_index !== undefined) msg.branchIndex = row.branch_index;
    if (row.latency_ms !== undefined && row.latency_ms !== null) msg.latencyMs = row.latency_ms;
    if (row.usage_prompt_tokens !== undefined && row.usage_prompt_tokens !== null) msg.usagePromptTokens = row.usage_prompt_tokens;
    if (row.usage_completion_tokens !== undefined && row.usage_completion_tokens !== null) msg.usageCompletionTokens = row.usage_completion_tokens;
    if (row.cost_cents !== undefined && row.cost_cents !== null) msg.costCents = row.cost_cents;
    return msg;
  }

  // Build the meta param block for insertMessage/updateMessage. Mirrors the
  // schema in 014-message-meta.sql + 015-message-blocks.sql; passing null
  // means "leave existing value alone" because updateMessage uses COALESCE
  // on these fields.
  function metaParams(msg: Partial<StoredMessage>) {
    return {
      $latency_ms: msg.latencyMs ?? null,
      $usage_prompt_tokens: msg.usagePromptTokens ?? null,
      $usage_completion_tokens: msg.usageCompletionTokens ?? null,
      $cost_cents: msg.costCents ?? null,
      $blocks: msg.blocks ? JSON.stringify(msg.blocks) : null,
    };
  }

  // --- Broadcast helpers ---
  function broadcast(message: object, exclude?: ServerWebSocket<WSData>) {
    devValidateOutbound(message);
    const payload = JSON.stringify(message);
    for (const ws of wsClients) {
      if (ws !== exclude && ws.readyState === 1) {
        try { ws.send(payload); } catch (err) {
          console.error(`[WS] Send error to ${ws.data.id}:`, err);
        }
      }
    }
  }

  function broadcastToAll(message: object) {
    devValidateOutbound(message);
    const payload = JSON.stringify(message);
    for (const ws of wsClients) {
      if (ws.readyState === 1) {
        try { ws.send(payload); } catch (err) {
          console.error(`[WS] Send error to ${ws.data.id}:`, err);
        }
      }
    }
    // Trigger push notifications for meaningful events
    try { maybeSendPush(message as Record<string, any>); } catch {}
  }

  function broadcastToTopic(topicId: string, message: object, exclude?: ServerWebSocket<WSData>) {
    devValidateOutbound(message);
    const payload = JSON.stringify(message);
    for (const ws of wsClients) {
      if (ws !== exclude && ws.data.focusedTopicId === topicId && ws.readyState === 1) {
        try { ws.send(payload); } catch (err) {
          console.error(`[WS] Send error to ${ws.data.id}:`, err);
        }
      }
    }
  }

  function isTopicFocused(topicId: string): boolean {
    for (const ws of wsClients) {
      if (ws.data.focusedTopicId === topicId && ws.readyState === 1) return true;
    }
    return false;
  }

  /**
   * P6: send to every client that currently has `topicId` open (declared via a
   * `subscribe` frame), plus any client that hasn't declared an open-set yet.
   * Preserves multi-window/background streaming while skipping clients that
   * aren't showing the topic — unlike broadcastToTopic (focused-only) which
   * drops background-tab deltas. Routing rule is the pure `clientReceivesTopicDelta`.
   */
  function broadcastToTopicSubscribers(topicId: string, message: object, exclude?: ServerWebSocket<WSData>) {
    devValidateOutbound(message);
    const payload = JSON.stringify(message);
    for (const ws of wsClients) {
      if (ws === exclude || ws.readyState !== 1) continue;
      if (!clientReceivesTopicDelta(ws.data, topicId)) continue;
      try { ws.send(payload); } catch (err) {
        console.error(`[WS] Send error to ${ws.data.id}:`, err);
      }
    }
  }

  // --- Project + Worktree domain (Phase A · migrations 016-018) ---
  // Stores are pure SQL helpers, instantiated against the singleton db.
  // The manager is the only stateful dependency: it closes over broadcastToAll
  // (declared above) so it can fire `worktree:updated` envelopes when the
  // async git materialise step transitions a row from `pending` → `ready|error`.
  const projectStore = createProjectStore(db);
  const worktreeStore = createWorktreeStore(db);
  const worktreeManager = createWorktreeManager(
    { broadcastToAll } as AppContext,
    { projectStore, worktreeStore },
  );
  // Phase D — machines (heartbeat ticker is wired in server.ts).
  const machineStore = createMachineStore(db, baseDir);

  // --- Atomic write (kept for backward compat with non-DB file writes) ---
  function atomicWriteJSON(filepath: string, data: object): void {
    const tempPath = filepath + ".tmp." + process.pid + "." + Date.now();
    try {
      writeFileSync(tempPath, JSON.stringify(data, null, 2));
      renameSync(tempPath, filepath);
    } catch (err) {
      try { unlinkSync(tempPath); } catch {}
      throw err;
    }
  }

  // --- Topics (SQLite-backed) ---
  function loadTopics(): TopicsData {
    const rows = stmts.getAllTopics.all() as any[];
    // Batch-load every relation once (1 + 5 scans) instead of 5 sub-queries per
    // topic — GET /api/topics is the hot UI-hydration path, hit on every load /
    // reconnect, and this DB carries ~hundreds of topics.
    const rels = buildTopicRelations();
    const topics: Record<string, Topic> = {};
    for (const row of rows) {
      topics[row.id] = rowToTopic(row, rels);
    }
    return { topics };
  }

  /**
   * Load a single topic by id without paying for a full table scan + Topic
   * reconstruction for every row. Returns null if missing. Use this in
   * mutation paths that touch one topic — pairs with `saveSingleTopic` to
   * avoid the lost-update race that the load-all/save-all pattern carries
   * across concurrent requests.
   */
  function getTopicById(id: string): Topic | null {
    const row = stmts.getTopicById.get(id) as any;
    if (!row) return null;
    return rowToTopic(row);
  }

  /**
   * Load a single topic by sessionKey. Same constant-time read as
   * `getTopicById` but indexed on `session_key` (UNIQUE in migration 001).
   * Used by chat/abort, autoname, gateway hooks, and other code paths that
   * only know the session, not the topic id.
   */
  function getTopicBySessionKey(sessionKey: string): Topic | null {
    const row = db.prepare("SELECT * FROM topics WHERE session_key = ? LIMIT 1").get(sessionKey) as any;
    if (!row) return null;
    return rowToTopic(row);
  }

  /**
   * @deprecated Bulk-save every topic in `data`. All in-tree callers were
   * migrated to `saveSingleTopic` / `getTopicById` / targeted column writes
   * because the old "load-all → mutate one → save-all" pattern carried a
   * lost-update race: two concurrent requests would each load a snapshot,
   * mutate disjoint fields, and save — the second save would overwrite the
   * first's mutation with stale values. This function is kept ONLY for
   * out-of-tree consumers (CLI tooling, tests) and now upserts without
   * deleting absent topics. Hard deletes go through `deleteTopicById`.
   */
  function saveTopics(data: TopicsData): void {
    db.transaction(() => {
      for (const topic of Object.values(data.topics)) {
        saveSingleTopic(topic);
      }
    })();
  }

  // --- Unread (SQLite-backed) ---
  function loadUnread(): UnreadData {
    const rows = stmts.getAllUnread.all() as any[];
    const result: UnreadData = {};
    for (const row of rows) {
      result[row.topic_id] = { lastReadAt: row.last_read_at, unreadCount: row.unread_count };
    }
    return result;
  }

  function saveUnread(data: UnreadData): void {
    db.transaction(() => {
      // Get current unread topic IDs
      const currentRows = stmts.getAllUnread.all() as any[];
      const currentIds = new Set(currentRows.map(r => r.topic_id));
      const newIds = new Set(Object.keys(data));

      // Delete entries not in new data
      for (const id of currentIds) {
        if (!newIds.has(id)) stmts.deleteUnread.run(id);
      }
      // Upsert all entries
      for (const [topicId, entry] of Object.entries(data)) {
        stmts.upsertUnread.run(topicId, entry.lastReadAt, entry.unreadCount);
      }
    })();
  }

  // --- Messages (SQLite-backed) ---
  function getMessagesPath(sessionKey: string): string {
    // Keep for backward compat (some code references this for file existence checks)
    const safe = sessionKey.replace(/[^a-zA-Z0-9_:-]/g, "_");
    return join(MESSAGES_DIR, safe + ".json");
  }

  /**
   * Walk the message tree following active branch selections.
   * Returns a linear thread representing the currently active conversation path.
   */
  function loadActiveThread(sessionKey: string): StoredMessage[] {
    // Get all messages for this session
    const allRows = stmts.getMessages.all(sessionKey) as any[];
    if (allRows.length === 0) return [];

    // Build parent→children map
    const childrenMap = new Map<string | null, any[]>(); // parentId → child rows
    for (const row of allRows) {
      const pid = row.parent_id || null;
      if (!childrenMap.has(pid)) childrenMap.set(pid, []);
      childrenMap.get(pid)!.push(row);
    }

    // Sort children by branch_index
    for (const children of childrenMap.values()) {
      children.sort((a: any, b: any) => (a.branch_index || 0) - (b.branch_index || 0));
    }

    // Walk from root(s) following active branches
    const thread: StoredMessage[] = [];
    let currentParentId: string | null = null;
    // Guard against a corrupt chain (cyclic or self-referential parent_id)
    // looping forever — bail the first time we'd revisit a node.
    const visited = new Set<string>();

    while (true) {
      const children = childrenMap.get(currentParentId);
      if (!children || children.length === 0) break;

      // Determine which branch to follow
      let activeBranchIndex = 0;
      if (children.length > 1) {
        // For root messages (parent_id IS NULL), use '__root__' key
        const lookupKey = currentParentId === null ? '__root__' : currentParentId;
        const active = stmts.getActiveBranch.get(lookupKey, sessionKey) as any;
        if (active) activeBranchIndex = active.active_branch_index;
      }

      // Find the child at this branch index
      const selectedChild = children.find((c: any) => (c.branch_index || 0) === activeBranchIndex) || children[0];
      if (visited.has(selectedChild.id)) {
        console.warn(`[loadActiveThread] Cyclic message chain detected for ${sessionKey} at ${selectedChild.id} — truncating thread`);
        break;
      }
      visited.add(selectedChild.id);
      const msg = rowToMessage(selectedChild);

      // Annotate with sibling info for the client
      msg.siblingCount = children.length;
      msg.activeBranchIndex = selectedChild.branch_index || 0;

      thread.push(msg);
      currentParentId = selectedChild.id;
    }

    return thread;
  }

  function loadLocalMessages(sessionKey: string): StoredMessage[] {
    return loadActiveThread(sessionKey);
  }

  function saveLocalMessages(sessionKey: string, msgs: StoredMessage[]): void {
    db.transaction(() => {
      stmts.deleteMessagesBySession.run(sessionKey);
      stmts.deleteActiveBranchesBySession.run(sessionKey);
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        stmts.insertMessage.run({
          $id: msg.id,
          $session_key: sessionKey,
          $role: msg.role,
          $content: msg.content || '',
          $thinking: msg.thinking || null,
          $tool_calls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
          $media: msg.media ? JSON.stringify(msg.media) : null,
          $partial: msg.partial ? 1 : 0,
          $streamed_at: msg.streamedAt || null,
          $plan_status: msg.planStatus || null,
          $timestamp: msg.timestamp,
          $sort_order: i,
          $parent_id: msg.parentId || null,
          $branch_index: msg.branchIndex || 0,
          ...metaParams(msg),
        });
      }
    })();
  }

  function appendLocalMessage(sessionKey: string, role: "user" | "assistant", content: string): StoredMessage {
    const maxOrder = (stmts.getMaxSortOrder.get(sessionKey) as any).max_order;
    // Find the last message in the active thread to set as parent
    const activeThread = loadActiveThread(sessionKey);
    const lastMsg = activeThread.length > 0 ? activeThread[activeThread.length - 1] : null;
    const parentId = lastMsg?.id || null;
    const stored: StoredMessage = { id: crypto.randomUUID(), role, content, timestamp: new Date().toISOString(), parentId, branchIndex: 0 };
    stmts.insertMessage.run({
      $id: stored.id,
      $session_key: sessionKey,
      $role: role,
      $content: content,
      $thinking: null,
      $tool_calls: null,
      $media: null,
      $partial: 0,
      $streamed_at: null,
      $plan_status: null,
      $timestamp: stored.timestamp,
      $sort_order: maxOrder + 1,
      $parent_id: parentId,
      $branch_index: 0,
      ...metaParams({}),
    });
    return stored;
  }

  function createPartialMessage(sessionKey: string, role: "user" | "assistant"): StoredMessage {
    const maxOrder = (stmts.getMaxSortOrder.get(sessionKey) as any).max_order;
    // Find the last message in the active thread to set as parent
    const activeThread = loadActiveThread(sessionKey);
    const lastMsg = activeThread.length > 0 ? activeThread[activeThread.length - 1] : null;
    const parentId = lastMsg?.id || null;
    const stored: StoredMessage = {
      id: crypto.randomUUID(), role, content: "", timestamp: new Date().toISOString(),
      partial: true, streamedAt: new Date().toISOString(), parentId, branchIndex: 0,
    };
    stmts.insertMessage.run({
      $id: stored.id,
      $session_key: sessionKey,
      $role: role,
      $content: '',
      $thinking: null,
      $tool_calls: null,
      $media: null,
      $partial: 1,
      $streamed_at: stored.streamedAt!,
      $plan_status: null,
      $timestamp: stored.timestamp,
      $sort_order: maxOrder + 1,
      $parent_id: parentId,
      $branch_index: 0,
      ...metaParams({}),
    });
    return stored;
  }

  /** Get the last message in the active thread (or by sort_order as fallback for streaming). */
  function getLastActiveMessage(sessionKey: string): any | null {
    // During streaming, the last message by sort_order is the partial assistant message
    // which is always the correct one to update.
    return stmts.getLastMessage.get(sessionKey) as any;
  }

  function updateLastMessage(sessionKey: string, updates: Partial<StoredMessage>): StoredMessage | null {
    const row = getLastActiveMessage(sessionKey);
    if (!row) return null;
    const msg = rowToMessage(row);
    Object.assign(msg, updates);
    stmts.updateMessage.run({
      $id: msg.id,
      $content: msg.content || '',
      $thinking: msg.thinking || null,
      $tool_calls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
      $media: msg.media ? JSON.stringify(msg.media) : null,
      $partial: msg.partial ? 1 : 0,
      $streamed_at: msg.streamedAt || null,
      $plan_status: msg.planStatus || null,
      // Only the partial-msg fields landing in `updates` should overwrite —
      // the SQL's COALESCE keeps existing values when these are null.
      ...metaParams(updates),
    });
    return msg;
  }

  function appendToLastMessage(sessionKey: string, contentDelta: string, thinkingDelta?: string): StoredMessage | null {
    const row = stmts.getLastMessage.get(sessionKey) as any;
    if (!row) return null;
    const msg = rowToMessage(row);
    if (contentDelta) msg.content += contentDelta;
    if (thinkingDelta) msg.thinking = (msg.thinking || "") + thinkingDelta;
    stmts.updateMessage.run({
      $id: msg.id,
      $content: msg.content,
      $thinking: msg.thinking || null,
      $tool_calls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
      $media: msg.media ? JSON.stringify(msg.media) : null,
      $partial: msg.partial ? 1 : 0,
      $streamed_at: msg.streamedAt || null,
      $plan_status: msg.planStatus || null,
      ...metaParams({}),
    });
    return msg;
  }

  function finalizeLastMessage(sessionKey: string): StoredMessage | null {
    const row = stmts.getLastMessage.get(sessionKey) as any;
    if (!row) return null;
    const msg = rowToMessage(row);
    delete msg.partial;
    delete msg.streamedAt;
    stmts.updateMessage.run({
      $id: msg.id,
      $content: msg.content,
      $thinking: msg.thinking || null,
      $tool_calls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
      $media: msg.media ? JSON.stringify(msg.media) : null,
      $partial: 0,
      $streamed_at: null,
      $plan_status: msg.planStatus || null,
      ...metaParams({}),
    });
    return msg;
  }

  function addToolCallToLastMessage(sessionKey: string, toolCall: ToolCall): StoredMessage | null {
    const row = stmts.getLastMessage.get(sessionKey) as any;
    if (!row) return null;
    const msg = rowToMessage(row);
    if (!msg.toolCalls) msg.toolCalls = [];
    // Defensive dedup: providers that emit cumulative tool snapshots (the
    // Claude CLI is one) call this multiple times for the same id. Without
    // this guard we'd accumulate duplicate entries; updateToolCallResult
    // only patches the FIRST match, so the duplicates would stay forever
    // in `running` and the spinner would never clear in the UI. The
    // upstream provider is meant to dedup too — this is belt-and-braces.
    const existingIdx = msg.toolCalls.findIndex(t => t.id === toolCall.id);
    if (existingIdx >= 0) {
      // Update in place so a re-announcement with newer args doesn't lose
      // the work tracked under the same id.
      msg.toolCalls[existingIdx] = { ...msg.toolCalls[existingIdx], ...toolCall };
    } else {
      msg.toolCalls.push(toolCall);
    }
    stmts.updateMessage.run({
      $id: msg.id,
      $content: msg.content,
      $thinking: msg.thinking || null,
      $tool_calls: JSON.stringify(msg.toolCalls),
      $media: msg.media ? JSON.stringify(msg.media) : null,
      $partial: msg.partial ? 1 : 0,
      $streamed_at: msg.streamedAt || null,
      $plan_status: msg.planStatus || null,
      ...metaParams({}),
    });
    return msg;
  }

  function updateToolCallResult(sessionKey: string, toolCallId: string, result: string, error?: string): StoredMessage | null {
    const row = stmts.getLastMessage.get(sessionKey) as any;
    if (!row) return null;
    const msg = rowToMessage(row);
    const tc = msg.toolCalls?.find(t => t.id === toolCallId);
    if (tc) {
      tc.result = result;
      tc.error = error;
      tc.status = error ? 'error' : 'success';
      stmts.updateMessage.run({
        $id: msg.id,
        $content: msg.content,
        $thinking: msg.thinking || null,
        $tool_calls: JSON.stringify(msg.toolCalls),
        $media: msg.media ? JSON.stringify(msg.media) : null,
        $partial: msg.partial ? 1 : 0,
        $streamed_at: msg.streamedAt || null,
        $plan_status: msg.planStatus || null,
        ...metaParams({}),
      });
    }
    return msg;
  }

  /**
   * Generic patch for a single ToolCall on the last assistant message.
   * Used for non-terminal mutations that `updateToolCallResult` doesn't
   * cover — currently `status: 'waiting_for_input'` + `userInputSchema`
   * on the way in, and `userResponse` on the way out when the user
   * answers a paused tool. `status` patching here goes through the same
   * SQLite row so a reload renders the pending form correctly.
   */
  function updateToolCallFields(sessionKey: string, toolCallId: string, patch: Partial<ToolCall>): StoredMessage | null {
    const row = stmts.getLastMessage.get(sessionKey) as any;
    if (!row) return null;
    const msg = rowToMessage(row);
    const tc = msg.toolCalls?.find(t => t.id === toolCallId);
    if (!tc) return msg;
    Object.assign(tc, patch);
    stmts.updateMessage.run({
      $id: msg.id,
      $content: msg.content,
      $thinking: msg.thinking || null,
      $tool_calls: JSON.stringify(msg.toolCalls),
      $media: msg.media ? JSON.stringify(msg.media) : null,
      $partial: msg.partial ? 1 : 0,
      $streamed_at: msg.streamedAt || null,
      $plan_status: msg.planStatus || null,
      ...metaParams({}),
    });
    return msg;
  }

  // --- Streams (in-memory, unchanged) ---
  function startStream(sessionKey: string, messageId: string, abortController?: AbortController) {
    activeStreams.set(sessionKey, { sessionKey, startedAt: new Date().toISOString(), isThinking: false, lastActivity: new Date().toISOString(), content: "", thinking: "", messageId, abortController });
  }

  function updateStreamActivity(sessionKey: string, isThinking?: boolean) {
    const stream = activeStreams.get(sessionKey);
    if (stream) {
      stream.lastActivity = new Date().toISOString();
      if (isThinking !== undefined) stream.isThinking = isThinking;
    }
  }

  function updateStreamContent(sessionKey: string, content: string, thinking: string) {
    const stream = activeStreams.get(sessionKey);
    if (stream) {
      stream.content = content;
      stream.thinking = thinking;
      stream.lastActivity = new Date().toISOString();
    }
  }

  function getStreamContent(sessionKey: string): { content: string; thinking: string; messageId: string } | null {
    const stream = activeStreams.get(sessionKey);
    if (!stream) return null;
    return { content: stream.content, thinking: stream.thinking, messageId: stream.messageId };
  }

  function endStream(sessionKey: string) {
    const stream = activeStreams.get(sessionKey);
    if (stream?.messageId) {
      // Mark any "running" tool calls as "error" in the DB so clients don't show stale spinners.
      // Parse → map → serialize (same pattern as updateToolCallResult) instead of a substring
      // REPLACE, which would also clobber the literal string `"status":"running"` if it ever
      // appeared inside a tool call's args/result.
      try {
        const row = db.prepare(`SELECT tool_calls FROM messages WHERE id = ?`).get(stream.messageId) as any;
        if (row?.tool_calls) {
          const toolCalls = JSON.parse(row.tool_calls) as ToolCall[];
          let changed = false;
          for (const tc of toolCalls) {
            if (tc?.status === 'running') { tc.status = 'error'; changed = true; }
          }
          if (changed) {
            db.prepare(`UPDATE messages SET tool_calls = ? WHERE id = ?`).run(JSON.stringify(toolCalls), stream.messageId);
          }
        }
      } catch {}
    }
    activeStreams.delete(sessionKey);
  }

  function isStreaming(sessionKey: string): ActiveStream | undefined {
    const stream = activeStreams.get(sessionKey);
    if (!stream) return undefined;
    const lastActivity = new Date(stream.lastActivity).getTime();
    const STREAM_TIMEOUT_MS = 3 * 60 * 1000;
    if (Date.now() - lastActivity > STREAM_TIMEOUT_MS) {
      console.log(`[isStreaming] Auto-expiring stale stream for ${sessionKey} (last activity: ${stream.lastActivity})`);
      activeStreams.delete(sessionKey);
      return undefined;
    }
    return stream;
  }

  // NOTE: the periodic stale-active-stream sweeper lives in server.ts
  // (`staleStreamTimer`, 30s). It is the authoritative one — it finalizes the
  // partial DB row and broadcasts stream:end with topicId+reason, and it is
  // cleared in gracefulShutdown. A second sweeper used to run here too, but it
  // duplicated/raced the server.ts logic with weaker side effects AND its
  // interval handle was never stored, so it leaked one live 60s timer per
  // `bun --watch` hot reload. Removed — don't reintroduce a sweeper here.

  // --- Request helpers (unchanged) ---
  async function readJSON(req: Request): Promise<any> {
    try { return await req.json(); } catch { return null; }
  }

  function json(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  }

  function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
    const patternParts = pattern.split("/");
    const pathParts = pathname.split("/");
    if (patternParts.length !== pathParts.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(":")) {
        params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (patternParts[i] !== pathParts[i]) {
        return null;
      }
    }
    return params;
  }

  function errorResponse(status: number, message: string, options: ErrorResponseOptions = {}): Response {
    const { log = true, details } = options;
    if (log && status >= 500) console.error(`[Error ${status}] ${message}`, details || "");
    else if (log && status >= 400) console.warn(`[Warn ${status}] ${message}`);
    const body: { error: string; details?: unknown } = { error: message };
    if (details !== undefined) body.details = details;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  function slugify(name: string): string {
    return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  // --- Path resolution (unchanged) ---
  const ALLOWED_FILE_BASES = [OPENCLAW_DIR, process.env.HOME ? join(process.env.HOME, ".openclaw") : null].filter(Boolean) as string[];

  function resolveSafePath(inputPath: string, allowedBases: string[] = ALLOWED_FILE_BASES): string | null {
    if (!inputPath) return null;
    let expanded = inputPath;
    if (inputPath.startsWith("~")) {
      const home = process.env.HOME;
      if (!home) return null;
      expanded = inputPath.replace(/^~/, home);
    }
    const resolved = resolve(expanded);
    const isAllowed = allowedBases.some(base => {
      const normalizedBase = resolve(base);
      return resolved === normalizedBase || resolved.startsWith(normalizedBase + "/");
    });
    if (!isAllowed) {
      console.warn(`[Security] Path access denied: ${inputPath} -> ${resolved}`);
      return null;
    }
    return resolved;
  }

  function resolveProjectPath(inputPath: string): string | null {
    if (!inputPath) return null;
    let expanded = inputPath;
    if (inputPath.startsWith("~")) {
      const home = process.env.HOME;
      if (!home) return null;
      expanded = inputPath.replace(/^~/, home);
    }
    return resolve(expanded);
  }

  /**
   * Resolve the working directory for a topic — Phase A · TOPIC-WT-01 §4.
   *
   * Precedence:
   *   1. If topic is bound to a Worktree (worktreeId NOT NULL) AND that
   *      worktree exists AND its status is `ready`, return the worktree's
   *      absPath. This is what slash commands, browser preview, and
   *      template loading scope to when the topic is worktree-bound.
   *   2. Otherwise fall back to `resolveProjectPath(topic.projectPath)` —
   *      identical to the pre-Phase-A behaviour for unbound (legacy) topics.
   *   3. If neither is set, return null (caller decides what to do).
   *
   * Pending or errored worktrees fall through to the projectPath fallback
   * so the user is never blocked from chatting while git is still working.
   */
  function resolveTopicCwd(topic: Topic | null | undefined): string | null {
    if (!topic) return null;
    if (topic.worktreeId) {
      const wt = worktreeStore.get(topic.worktreeId);
      if (wt && wt.status === "ready") return wt.absPath;
      // pending / error / missing → fall through to projectPath
    }
    return topic.projectPath ? resolveProjectPath(topic.projectPath) : null;
  }

  // --- Media helpers (unchanged) ---
  const ALLOWED_MEDIA_BASES = [
    `${OPENCLAW_DIR}/media/`,
    `${OPENCLAW_DIR}/workspace/`,
  ];

  function getMimeType(filepath: string): string {
    const ext = extname(filepath).toLowerCase().replace(".", "");
    const types: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm",
      mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
      aac: "audio/aac", opus: "audio/opus", pdf: "application/pdf",
      json: "application/json", txt: "text/plain", md: "text/markdown",
      csv: "text/csv", html: "text/html", css: "text/css", js: "application/javascript",
      zip: "application/zip", doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
    return types[ext] || "application/octet-stream";
  }

  function isPathAllowed(filepath: string): boolean {
    const resolved = resolve(filepath);
    if (resolved.startsWith(resolve(UPLOADS_DIR) + "/")) return true;
    if (resolved.startsWith(resolve(CONTEXT_DIR) + "/")) return true;
    return ALLOWED_MEDIA_BASES.some((base) => resolved.startsWith(base));
  }

  const MEDIA_SCAN_DIRS = [
    join(process.env.HOME || "", ".openclaw/media/browser"),
    join(process.env.HOME || "", ".openclaw/media"),
  ];
  const MEDIA_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "mp3", "wav", "ogg", "m4a", "aac", "opus", "webm", "mp4", "pdf"]);

  function findNewMediaFiles(sinceMs: number): string[] {
    const results: string[] = [];
    const seen = new Set<string>();
    for (const dir of MEDIA_SCAN_DIRS) {
      if (!existsSync(dir)) continue;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) continue;
          const ext = extname(entry.name).toLowerCase().replace(".", "");
          if (!MEDIA_EXTENSIONS.has(ext)) continue;
          const fullPath = join(dir, entry.name);
          if (seen.has(fullPath)) continue;
          seen.add(fullPath);
          try { const stat = statSync(fullPath); if (stat.mtimeMs >= sinceMs) results.push(fullPath); } catch {}
        }
      } catch {}
    }
    return results;
  }

  function updateLastMessageWithMedia(sessionKey: string, mediaPaths: string[]): void {
    const row = stmts.getLastMessage.get(sessionKey) as any;
    if (!row) return;
    // Walk backwards to find the last assistant message
    const rows = stmts.getMessages.all(sessionKey) as any[];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].role === "assistant") {
        const mediaLines = mediaPaths.map((p: string) => `\nMEDIA:${p}`).join("");
        const newContent = (rows[i].content || '') + mediaLines;
        db.prepare("UPDATE messages SET content = ? WHERE id = ?").run(newContent, rows[i].id);
        break;
      }
    }
  }

  function logRequest(method: string, path: string, status: number, startTime: number): void {
    const duration = Date.now() - startTime;
    const statusColor = status >= 500 ? "❌" : status >= 400 ? "⚠️" : "✓";
    console.log(`[HTTP] ${statusColor} ${method} ${path} ${status} ${duration}ms`);
  }

  // --- Search (hybrid: SQLite local + gateway JSONL) ---
  function searchTranscripts(query: string, limit = 50): any[] {
    const results: any[] = [];
    const lowerQuery = query.toLowerCase();
    const topicsData = loadTopics();
    const sessionToTopic: Record<string, Topic> = {};
    for (const topic of Object.values(topicsData.topics)) { sessionToTopic[topic.sessionKey] = topic; }

    // Search gateway JSONL files (as before)
    const sessionsStorePath = join(SESSIONS_DIR, "sessions.json");
    if (existsSync(sessionsStorePath)) {
      try {
        const store = JSON.parse(readFileSync(sessionsStorePath, "utf-8"));
        for (const [key, entry] of Object.entries(store) as any[]) {
          if (!entry?.sessionId) continue;
          // Guard against path traversal — sessionId becomes a filename below.
          if (typeof entry.sessionId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(entry.sessionId)) continue;
          if (!key.startsWith("topic:")) continue;
          if (!sessionToTopic[key]) continue;
          const jsonlPath = join(SESSIONS_DIR, entry.sessionId + ".jsonl");
          if (!existsSync(jsonlPath)) continue;
          const topic = sessionToTopic[key];
          try {
            const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
            for (const line of lines) {
              try {
                const d = JSON.parse(line);
                if (d.type === "message" && d.message) {
                  const msg = d.message;
                  if (msg.role === "user" || msg.role === "assistant") {
                    let text = "";
                    if (typeof msg.content === "string") text = msg.content;
                    else if (Array.isArray(msg.content)) text = msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
                    if (text.toLowerCase().includes(lowerQuery)) {
                      results.push({ sessionKey: key, topicId: topic?.id || null, topicName: topic?.name || key, topicIcon: topic?.icon || "MessageSquare", role: msg.role, content: text, timestamp: d.timestamp || null });
                      if (results.length >= limit) return results;
                    }
                  }
                }
              } catch {}
            }
          } catch {}
        }
      } catch {}
    }

    return results;
  }

  const ALLOWED_UPLOAD_MIMES = new Set([
    "text/plain", "text/markdown", "text/csv", "text/html", "text/css", "text/javascript",
    "application/json", "application/xml", "application/pdf", "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
    "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/webm",
  ]);

  // --- Branching helpers ---
  function getMessageById(id: string): StoredMessage | null {
    const row = stmts.getMessageById.get(id) as any;
    return row ? rowToMessage(row) : null;
  }

  function getMessageSessionKey(id: string): string | null {
    const row = stmts.getMessageById.get(id) as any;
    return row?.session_key || null;
  }

  function createBranchMessage(sessionKey: string, parentId: string, role: "user" | "assistant", content: string): StoredMessage {
    const maxOrder = (stmts.getMaxSortOrder.get(sessionKey) as any).max_order;
    const maxBranch = (stmts.getMaxBranchIndex.get(parentId) as any).max_idx;
    const branchIndex = maxBranch + 1;
    const stored: StoredMessage = { id: crypto.randomUUID(), role, content, timestamp: new Date().toISOString(), parentId, branchIndex };
    stmts.insertMessage.run({
      $id: stored.id,
      $session_key: sessionKey,
      $role: role,
      $content: content,
      $thinking: null,
      $tool_calls: null,
      $media: null,
      $partial: 0,
      $streamed_at: null,
      $plan_status: null,
      $timestamp: stored.timestamp,
      $sort_order: maxOrder + 1,
      $parent_id: parentId,
      $branch_index: branchIndex,
      ...metaParams({}),
    });
    // Set this new branch as active
    stmts.upsertActiveBranch.run(parentId, sessionKey, branchIndex);
    return stored;
  }

  function createBranchPartialMessage(sessionKey: string, parentId: string): StoredMessage {
    const maxOrder = (stmts.getMaxSortOrder.get(sessionKey) as any).max_order;
    const stored: StoredMessage = {
      id: crypto.randomUUID(), role: "assistant", content: "", timestamp: new Date().toISOString(),
      partial: true, streamedAt: new Date().toISOString(), parentId, branchIndex: 0,
    };
    stmts.insertMessage.run({
      $id: stored.id,
      $session_key: sessionKey,
      $role: "assistant",
      $content: '',
      $thinking: null,
      $tool_calls: null,
      $media: null,
      $partial: 1,
      $streamed_at: stored.streamedAt!,
      $plan_status: null,
      $timestamp: stored.timestamp,
      $sort_order: maxOrder + 1,
      $parent_id: parentId,
      $branch_index: 0,
      ...metaParams({}),
    });
    return stored;
  }

  function switchActiveBranch(sessionKey: string, parentId: string, branchIndex: number): void {
    stmts.upsertActiveBranch.run(parentId, sessionKey, branchIndex);
  }

  function getSiblingMessages(parentId: string): StoredMessage[] {
    const rows = stmts.getSiblings.all(parentId) as any[];
    return rows.map(rowToMessage);
  }

  return {
    db,
    projectStore, worktreeStore, worktreeManager,
    machineStore,
    PORT, GATEWAY_URL,
    get GATEWAY_TOKEN() { return GATEWAY_TOKEN; },
    refreshGatewayToken,
    TOPICS_FILE, UNREAD_FILE, PUBLIC_DIR, UPLOADS_DIR, CONTEXT_DIR,
    OPENCLAW_DIR, SESSIONS_DIR, MESSAGES_DIR, BASE_DIR: baseDir,
    activeStreams, wsClients,
    broadcast, broadcastToAll, broadcastToTopic, broadcastToTopicSubscribers, isTopicFocused,
    loadTopics, saveTopics, saveSingleTopic, deleteTopicById,
    getTopicById, getTopicBySessionKey,
    loadUnread, saveUnread,
    loadLocalMessages, saveLocalMessages, appendLocalMessage,
    createPartialMessage, updateLastMessage, appendToLastMessage,
    finalizeLastMessage, addToolCallToLastMessage, updateToolCallResult, updateToolCallFields,
    startStream, updateStreamActivity, updateStreamContent, getStreamContent, endStream, isStreaming,
    readJSON, json, matchRoute, errorResponse, slugify,
    resolveSafePath, resolveProjectPath, resolveTopicCwd, getMimeType, isPathAllowed,
    findNewMediaFiles, updateLastMessageWithMedia, atomicWriteJSON, logRequest,
    searchTranscripts, getMessagesPath,
    ALLOWED_UPLOAD_MIMES,
    // Branching
    getMessageById,
    getMessageSessionKey,
    createBranchMessage,
    createBranchPartialMessage,
    switchActiveBranch,
    getSiblingMessages,
    loadActiveThread,
  };
}
