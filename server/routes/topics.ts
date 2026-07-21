import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import type { AppContext, RouteHandler, Topic } from "../types";
import { getProvider, getDefaultProvider, type AIProvider } from "../providers";
import { createAutoNameRouter } from "./autoname";
import { createHistoryRouter } from "./history";
import { createEditRouter } from "./edit";
import { createChatRouter } from "./chat";
import type { BrowserService } from "../browser-service";
import { dispatchBrowserToolCallByContext, resolveContextIdForTopic } from "../browser-tool-dispatcher";
import { BRIDGED_BROWSER_ENDPOINTS } from "../browser-tool-spec";
import { nativeDelegateRegistry } from "../browser-native-delegate";
import { collectLiveContextIds, listBrowserTabs, type TabInventoryDeps } from "../browser-tab-inventory";
import { getTerminalSessionById } from "./terminal";
import { createTaskService } from "../services/tasks";
import { matchProjectRefAll, type ProjectRefCandidate } from "../lib/project-ref";
import { shouldHonorClearMessages } from "./abortClearPolicy";
import { switchTopicCore, createTopicCore } from "../lib/session-control-core";
import { moveTerminalPaneToProject as relocateTerminalPaneToProject } from "../lib/relocate-pane";
import { timingSafeEqualStr } from "../utils";

/**
 * Remove a topic id from every ui_state record's `openChatTopicIds` array,
 * across all clients. Called when a topic is archived or deleted to prevent
 * phantom ids from lingering in per-project persisted tab state.
 *
 * The read-modify-write is wrapped in a transaction so concurrent writes from
 * clients (debounced ui_state PUTs) can't interleave and lose the purge.
 * Broadcasts are collected and emitted AFTER the transaction commits so
 * clients never see a mutation that was subsequently rolled back.
 */
/**
 * Remove every reference to `topicId` from a single ui_state record value,
 * mutating `parsed` in place. Returns true iff something changed.
 *
 * Handles BOTH persisted shapes that can hold an open chat:
 *  - Project / legacy tab-identity records: `{ openChatTopicIds: string[],
 *    activeChatTopicId? }` (written by the project-window layout sync).
 *  - The single global `pane-store-v2` snapshot: `{ panes, groups, closedStack }`,
 *    where a top-level chat pane is keyed by the RAW topic id
 *    (`createPaneId('chat', id) === id`).
 *
 * Why both: before this, the purge only filtered `openChatTopicIds`, which the
 * current `pane-store-v2` snapshot does NOT contain. So archiving/deleting a
 * chat removed it from project records but NEVER from `pane-store-v2` — the
 * pane lingered in the single shared snapshot and resurfaced as a phantom tab
 * on any client that didn't independently filter it (the "ghost tab on mobile"
 * bug). Now the shared snapshot is purged too, with a fresh server_seq so LWW
 * treats the removal as newer than any pre-purge client write.
 */
export function removeTopicFromUiStateValue(parsed: any, topicId: string): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  let changed = false;

  // Shape A — project / legacy tab-identity records.
  if (Array.isArray(parsed.openChatTopicIds) && parsed.openChatTopicIds.includes(topicId)) {
    parsed.openChatTopicIds = parsed.openChatTopicIds.filter((id: string) => id !== topicId);
    changed = true;
  }
  if (parsed.activeChatTopicId === topicId) {
    delete parsed.activeChatTopicId;
    changed = true;
  }

  // Shape B — pane-store-v2 snapshot (panes / groups / closedStack).
  const removedPaneIds = new Set<string>();
  if (parsed.panes && typeof parsed.panes === "object" && !Array.isArray(parsed.panes)) {
    for (const [pid, p] of Object.entries(parsed.panes as Record<string, any>)) {
      if (pid === topicId || (p && typeof p === "object" && (p as any).topicId === topicId)) {
        removedPaneIds.add(pid);
      }
    }
    for (const pid of removedPaneIds) {
      delete (parsed.panes as Record<string, any>)[pid];
      changed = true;
    }
  }
  if (parsed.groups && typeof parsed.groups === "object" && !Array.isArray(parsed.groups)) {
    for (const g of Object.values(parsed.groups as Record<string, any>)) {
      if (g && Array.isArray(g.paneIds)) {
        const filtered = g.paneIds.filter((id: string) => id !== topicId && !removedPaneIds.has(id));
        if (filtered.length !== g.paneIds.length) {
          g.paneIds = filtered;
          changed = true;
        }
      }
      // Defensive only: the current synced pane-store-v2 Group shape carries no
      // `activePaneId` (active pane is derived at render time, never persisted),
      // so this never fires for real data — it's a no-op guard for legacy/demo
      // group shapes that did carry it. Kept for parity with the orphan-cleanup
      // backstop; safe because `Set.has(undefined)` is false.
      if (g && typeof g === "object" && removedPaneIds.has((g as any).activePaneId)) {
        delete (g as any).activePaneId;
        changed = true;
      }
    }
  }
  if (Array.isArray(parsed.closedStack)) {
    const before = parsed.closedStack.length;
    parsed.closedStack = parsed.closedStack.filter(
      (rec: any) => !(rec && rec.pane && (rec.pane.id === topicId || rec.pane.topicId === topicId)),
    );
    if (parsed.closedStack.length !== before) changed = true;
  }

  return changed;
}

function purgeTopicFromUiState(
  db: import("bun:sqlite").Database,
  broadcastToAll: (msg: any) => void,
  topicId: string,
): { ok: true } | { ok: false; error: string } {
  // Phase 30 PANE-02 invariant: every ui_state write must allocate a fresh
  // server_seq so cross-device LWW treats this purge as newer than any
  // pre-purge snapshot. Without this bump, a later client PUT carrying an
  // older seq could silently win and re-introduce the purged topic.
  //
  // Race-fix (round-6 audit): mirrors the BEGIN IMMEDIATE pattern used in
  // server/routes/ui-state.ts (single-key PUT L74-90, bulk PUT L107-126). The
  // previous implementation used db.transaction() (DEFERRED) plus three
  // redundant `SELECT MAX(server_seq)` subqueries per row (INSERT VALUES,
  // ON CONFLICT SET, and a separate readback), so a concurrent PUT could
  // snapshot the same MAX and collide on seq. Now: acquire RESERVED lock at
  // BEGIN via .immediate(), read MAX once, allocate N distinct seqs with a
  // counter, and bind nextSeq as a parameter (no more subqueries). The allocated
  // seq is returned from the txn, eliminating the separate readback SELECT.
  let broadcasts: { key: string; value: any; server_seq: number }[] = [];
  try {
    broadcasts = db.transaction(() => {
      const out: { key: string; value: any; server_seq: number }[] = [];
      const rows = db.query("SELECT key, value FROM ui_state").all() as { key: string; value: string }[];
      const { maxSeq } = db.query(
        "SELECT COALESCE(MAX(server_seq), 0) AS maxSeq FROM ui_state",
      ).get() as { maxSeq: number };
      let i = 0;
      for (const row of rows) {
        let parsed: any;
        try { parsed = JSON.parse(row.value); } catch { continue; }
        if (!removeTopicFromUiStateValue(parsed, topicId)) continue;
        const next = JSON.stringify(parsed);
        const nextSeq = maxSeq + (++i);
        db.run(
          `INSERT INTO ui_state (key, value, payload_version, server_seq, updated_at)
           VALUES (?, ?, 2, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             payload_version = 2,
             server_seq = excluded.server_seq,
             updated_at = datetime('now')`,
          [row.key, next, nextSeq],
        );
        out.push({ key: row.key, value: parsed, server_seq: nextSeq });
      }
      return out;
    }).immediate();
  } catch (err) {
    // Bug #12 (round-7 hardening): do NOT swallow. A silent failure here leaves
    // the ui_state record stale so the archived topic id "resurrects" on the
    // next reload — the ghost-topic bug. Log structured + propagate so the
    // caller can surface it to the client (500) instead of returning 200 OK
    // while the server state is incoherent.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[topics] purgeTopicFromUiState failed for topicId=${topicId}:`, { error: message, stack: err instanceof Error ? err.stack : undefined });
    return { ok: false, error: message };
  }
  for (const b of broadcasts) {
    broadcastToAll({
      type: "ui-state:updated",
      key: b.key,
      value: b.value,
      payload_version: 2,
      server_seq: b.server_seq,
    });
  }
  return { ok: true };
}

export function createTopicsRouter(ctx: AppContext, browserService?: BrowserService): RouteHandler {
  const {
    GATEWAY_URL, GATEWAY_TOKEN, OPENCLAW_DIR,
    broadcastToAll, isTopicFocused,
    loadTopics, saveSingleTopic,
    getTopicById, getTopicBySessionKey,
    loadUnread, saveUnread,
    loadLocalMessages, saveLocalMessages, appendLocalMessage,
    updateLastMessage, updateToolCallFields,
    endStream, isStreaming,
    readJSON, json, matchRoute, errorResponse, slugify,
    searchTranscripts,
    getMessageById,
    activeStreams,
    worktreeStore,
    projectStore,
  } = ctx;

  // Task lookup for the task-owned browser fork + tab-inventory label. One
  // instance over the shared db (same pattern as the dispatcher's service).
  const taskSvc = createTaskService(ctx.db);
  // Server gate for the task-owned browser fork (client mirror:
  // localStorage['board:taskBrowser']). Default ON → an agent open-pane on a
  // task topic routes to the task's browser group; set TOPICS_TASK_BROWSER='0'
  // as a kill-switch to fall back to the layout-level `browser:navigate`.
  const TASK_BROWSER_ENABLED = process.env.TOPICS_TASK_BROWSER !== "0";

  /**
   * If `topic` is a task dispatch AND the fork is enabled, the canonical
   * task-scoped browser handle. The contextId is STABLE per (task, topic) so
   * repeated opens reuse the SAME in-drawer tab (idempotent client upsert), and
   * self-describing (`task-<id8>-…`) so labelForContext + the store recognise it
   * without a lookup. Null → the caller falls back to the normal chat pane.
   */
  function resolveTaskBrowserContext(topic: Topic): { taskId: string; contextId: string } | null {
    if (!TASK_BROWSER_ENABLED) return null;
    const task = taskSvc.taskForTopic(topic.id);
    if (!task) return null;
    return { taskId: task.id, contextId: `task-${task.id.slice(0, 8)}-a${topic.id.slice(0, 8)}` };
  }

  /** Resolve the AI provider for a topic. Uses topic.provider if set, else default. */
  function resolveProvider(topic?: Topic | null): AIProvider {
    if (topic?.provider) {
      // Legacy coercion: Master topics were once created with the experimental
      // "claude-code-team" provider, which is NOT a registered chat provider —
      // getProvider would throw and we'd silently fall back to a non-deterministic
      // default. Map it to the real subscription-backed CLI provider so old leads
      // (and the removed PTY-teams path) keep working without a data migration.
      // See change refactor-master-into-kanban (AD-1).
      const name = topic.provider === "claude-code-team" ? "claude-code" : topic.provider;
      try { return getProvider(name); } catch {}
    }
    return getDefaultProvider();
  }

  /** Look up the topic owning a sessionKey and resolve its provider. */
  function providerForSessionKey(sessionKey: string): AIProvider {
    const topic = getTopicBySessionKey(sessionKey);
    return resolveProvider(topic);
  }

  /**
   * Resolve the browser-pane contextId for an MCP bridge call addressed by
   * topic id OR session key. Handles BOTH Claude Code surfaces:
   *   - chat topic   → contextId = the topic's own browser contextId (topic.id)
   *   - terminal tab → contextId = `term-<terminalId>` (the deterministic id the
   *     client registers the near-terminal pane under, see open-pane below)
   * Returns null when neither matches (genuinely unbound session). `topic` is
   * returned when present so callers that still need it (broadcasts) have it.
   */
  function resolveBrowserContext(
    byTopic: Record<string, string> | null,
    bySession: Record<string, string> | null,
  ): { contextId: string; topic: Topic | null } | null {
    if (byTopic) {
      const topic = getTopicById(byTopic.id);
      if (!topic) return null;
      return { contextId: resolveContextIdForTopic(topic), topic };
    }
    if (bySession) {
      const key = decodeURIComponent(bySession.sessionKey);
      const topic = getTopicBySessionKey(key);
      if (topic) return { contextId: resolveContextIdForTopic(topic), topic };
      const term = getTerminalSessionById(key);
      if (term) return { contextId: `term-${term.id}`, topic: null };
    }
    return null;
  }

  /**
   * Build the injected deps for the tab inventory (browser-tab-inventory.ts)
   * from the live singletons. `fetchNativeStatus` calls the native registry
   * DIRECTLY (not through dispatchBrowserToolCallByContext) so listing tabs
   * doesn't flash the agent-active pill on every open pane. Requires a live
   * browserService for CDP contexts (callers 503 when it's absent).
   */
  function buildTabDeps(svc: BrowserService): TabInventoryDeps {
    return {
      listDelegated: () => nativeDelegateRegistry.listDelegated(),
      listContexts: () => (svc.listContexts?.() ?? []).map((c) => ({ id: c.id, url: c.url, title: c.title })),
      getTopicById,
      findTopicByContextId: (contextId) => {
        for (const t of Object.values(loadTopics().topics)) {
          if (t.browserState?.contextId === contextId) return t;
        }
        return null;
      },
      getTerminalSessionById: (id) => {
        const t = getTerminalSessionById(id);
        return t ? { id: t.id, name: t.name, cwd: t.cwd } : undefined;
      },
      getTaskByContextId: (contextId) => {
        // `task-<id8>-…` → owning task (label "Task: <text>"). id8 is the task
        // id's 8-char hex prefix; resolve it back to the row.
        const m = /^task-([0-9a-f]{1,32})-/i.exec(contextId);
        if (!m) return null;
        const task = taskSvc.taskByIdPrefix(m[1]);
        return task ? { text: task.text } : null;
      },
      fetchNativeStatus: async (contextId) => {
        if (!nativeDelegateRegistry.isDelegated(contextId)) return null;
        const res = await nativeDelegateRegistry.delegateOp(contextId, "browser_status", {});
        if (res && typeof res === "object" && !("error" in res)) {
          return res as { url?: string; title?: string };
        }
        return null;
      },
    };
  }

  // ── Sub-agent completion polling via JSONL transcript ──────────────────
  // Gateway executes tool calls (including sessions_spawn) internally and
  // writes completion events as user messages with "[Internal task completion event]"
  // to the parent session's JSONL transcript. We poll that file for new events.
  interface WatchedSession {
    topicId: string;
    sessionKey: string;      // e.g. "topic:d1428015"
    jsonlPath: string;       // path to the JSONL transcript file
    byteOffset: number;      // bytes already consumed (incremental cursor)
    lastIno: number;         // inode of the file at last read (rotation guard)
    lastMtimeMs: number;     // mtime at last read (same-size rewrite guard)
    createdAt: number;
    deliveredEvents: Set<string>; // session_key of already-delivered results
  }
  const watchedSessions = new Map<string, WatchedSession>();  // keyed by sessionKey
  let subagentPollTimer: ReturnType<typeof setInterval> | null = null;

  function startSubagentPolling() {
    if (subagentPollTimer) return;
    console.log(`[SubagentPoll] Starting JSONL polling (${watchedSessions.size} watched sessions)`);
    subagentPollTimer = setInterval(pollJSONLTranscripts, 5000);
  }

  function stopSubagentPolling() {
    if (!subagentPollTimer) return;
    clearInterval(subagentPollTimer);
    subagentPollTimer = null;
    console.log(`[SubagentPoll] Stopped polling`);
  }

  function findSessionJSONL(sessionKey: string): string | null {
    const agentId = 'main';
    const transcriptDir = join(homedir(), '.openclaw', 'agents', agentId, 'sessions');
    if (!existsSync(transcriptDir)) return null;
    // JSONL files are named: <sessionId>-<sessionKey-slug>.jsonl
    // e.g. 466c80b4-...-topic-d1428015.jsonl
    const keySlug = sessionKey.replace(/:/g, '-');
    const files = readdirSync(transcriptDir).filter(f => f.endsWith('.jsonl') && f.includes(keySlug));
    if (files.length > 0) return join(transcriptDir, files[0]);
    // Fallback: search recent files for matching session key
    const recent = readdirSync(transcriptDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: statSync(join(transcriptDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10);
    for (const f of recent) {
      try {
        const first = readFileSync(join(transcriptDir, f.name), 'utf-8').split('\n')[0];
        if (first.includes(sessionKey)) return join(transcriptDir, f.name);
      } catch {}
    }
    return null;
  }

  function pollJSONLTranscripts() {
    for (const [sk, watched] of watchedSessions.entries()) {
      // Timeout: stop watching after 30 minutes
      if (Date.now() - watched.createdAt > 30 * 60_000) {
        console.log(`[SubagentPoll] Timeout watching ${sk}`);
        watchedSessions.delete(sk);
        continue;
      }
      // Find JSONL if not yet resolved
      if (!watched.jsonlPath) {
        const found = findSessionJSONL(sk);
        if (found) { watched.jsonlPath = found; }
        else continue;
      }
      if (!existsSync(watched.jsonlPath)) continue;

      try {
        // Incremental read: only the bytes appended since last tick, so cost is
        // O(new data) instead of O(whole transcript) on every 5s poll.
        let st: ReturnType<typeof statSync>;
        try { st = statSync(watched.jsonlPath); } catch { continue; }
        // Rotation/truncation: different inode, shrunk below the cursor, or a
        // same-size-or-smaller rewrite with a newer mtime → restart from 0.
        const inoChanged = watched.lastIno !== 0 && st.ino !== watched.lastIno;
        const truncated = st.size < watched.byteOffset;
        const rewriteSameSize = watched.lastMtimeMs !== 0 && st.mtimeMs > watched.lastMtimeMs && st.size <= watched.byteOffset;
        if (inoChanged || truncated || rewriteSameSize) watched.byteOffset = 0;
        watched.lastIno = st.ino;
        watched.lastMtimeMs = st.mtimeMs;
        if (st.size === watched.byteOffset) continue; // no new bytes

        const length = st.size - watched.byteOffset;
        const buf = Buffer.alloc(length);
        let fd: number | null = null;
        try {
          fd = openSync(watched.jsonlPath, 'r');
          readSync(fd, buf, 0, length, watched.byteOffset);
        } finally {
          if (fd != null) { try { closeSync(fd); } catch {} }
        }
        watched.byteOffset = st.size;
        const text = buf.toString('utf-8');
        const newLines = text.split('\n');
        // A trailing partial line (no newline yet) is rewound so it's re-read
        // whole on the next tick rather than JSON-parsed half-formed.
        if (newLines.length > 0 && !text.endsWith('\n')) {
          const partial = newLines.pop()!;
          watched.byteOffset -= Buffer.byteLength(partial, 'utf-8');
        }

        for (const line of newLines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            const msg = entry.message || entry;
            const textContent = extractTextContent(msg.content);
            if (!textContent.includes('[Internal task completion event]')) continue;

            // Extract the child session key to deduplicate
            const skMatch = textContent.match(/session_key:\s*(agent:\S+)/);
            const childSk = skMatch?.[1] || textContent.slice(0, 50);
            if (watched.deliveredEvents.has(childSk)) continue;
            watched.deliveredEvents.add(childSk);

            // Extract the result between markers
            const resultMatch = textContent.match(/<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>([\s\S]*?)<<<END_UNTRUSTED_CHILD_RESULT>>>/);
            const result = resultMatch?.[1]?.trim() || '(sub-agent completed, no output recovered)';

            // Extract task description
            const taskMatch = textContent.match(/task:\s*(.+)/);
            const task = taskMatch?.[1]?.trim() || '';

            console.log(`[SubagentPoll] Found completion event for ${childSk.slice(0, 40)} in ${sk}`);

            // Now we need the gateway to process this completion event (generate assistant response)
            // The event is already in the transcript — trigger a gateway inference call
            // so the AI can read the result and produce a user-facing response
            triggerGatewayInference(watched, result, task);
          } catch {}
        }
      } catch (err) {
        console.warn(`[SubagentPoll] Error reading ${watched.jsonlPath}:`, err);
      }
    }
    if (watchedSessions.size === 0) stopSubagentPolling();
  }

  function extractTextContent(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    return '';
  }

  async function triggerGatewayInference(watched: WatchedSession, result: string, task: string) {
    // Send a follow-up message to the gateway session so the AI generates a response
    // that includes the sub-agent result. The gateway has the completion event in its
    // context already — we just need to trigger a new inference turn.
    const topic = getTopicById(watched.topicId);
    const provider = resolveProvider(topic);
    if (provider.name !== 'openclaw') {
      // /api/inference/chat is OpenClaw-specific — deliver raw result for other providers
      deliverRawResult(watched, result, task);
      return;
    }
    try {
      const resp = await fetch(`${GATEWAY_URL}/api/inference/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}`, "x-openclaw-scopes": "operator.read,operator.write" },
        body: JSON.stringify({
          sessionKey: watched.sessionKey,
          messages: [{ role: "user", content: `[System: sub-agent completed. Present the result to the user naturally.]` }],
        }),
      });
      if (!resp.ok) {
        // Fallback: deliver raw result directly
        console.warn(`[SubagentPoll] Gateway inference failed (${resp.status}), delivering raw result`);
        deliverRawResult(watched, result, task);
        return;
      }
      // Stream the response — it should appear as a regular assistant message
      // The gateway streams SSE, and the existing chat flow handles it
      // But since we're not in an HTTP request context, we need to stream manually
      const reader = resp.body?.getReader();
      if (!reader) { deliverRawResult(watched, result, task); return; }

      let fullContent = '';
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) fullContent += delta.content;
          } catch {}
        }
      }

      if (fullContent) {
        const storedSubagent = appendLocalMessage(watched.sessionKey, 'assistant', fullContent);
        broadcastToAll({
          type: "message:new",
          sessionKey: watched.sessionKey,
          topicId: watched.topicId,
          role: "assistant",
          messageId: storedSubagent.id,
          content: fullContent,
          preview: fullContent.slice(0, 100),
        });
        updateUnreadCount(watched.topicId);
        console.log(`[SubagentPoll] ✓ Delivered AI-formatted result → topic ${watched.topicId.slice(0, 8)}`);
      } else {
        deliverRawResult(watched, result, task);
      }
    } catch (err) {
      console.warn(`[SubagentPoll] Inference error:`, err);
      deliverRawResult(watched, result, task);
    }
  }

  function deliverRawResult(watched: WatchedSession, result: string, task: string) {
    const msgContent = `📋 **Sub-agent result${task ? ` (${task.slice(0, 80)})` : ''}:**\n\n${result}`;
    const storedRaw = appendLocalMessage(watched.sessionKey, 'assistant', msgContent);
    broadcastToAll({
      type: "message:new",
      sessionKey: watched.sessionKey,
      topicId: watched.topicId,
      role: "assistant",
      messageId: storedRaw.id,
      content: msgContent,
      preview: result.slice(0, 100),
    });
    updateUnreadCount(watched.topicId);
    console.log(`[SubagentPoll] ✓ Delivered raw result → topic ${watched.topicId.slice(0, 8)}`);
  }

  function updateUnreadCount(topicId: string) {
    try {
      if (!isTopicFocused(topicId)) {
        const unread = loadUnread();
        if (!unread[topicId]) unread[topicId] = { lastReadAt: new Date().toISOString(), unreadCount: 0 };
        unread[topicId].unreadCount += 1;
        saveUnread(unread);
        broadcastToAll({ type: "unread:updated", topicId, unreadCount: unread[topicId].unreadCount });
      }
    } catch (err) {
      console.warn(`[topics] updateUnreadCount failed for ${topicId}:`, err);
    }
  }

  function watchSessionForSubagents(topicId: string, sessionKey: string) {
    if (watchedSessions.has(sessionKey)) {
      // Reset timeout
      watchedSessions.get(sessionKey)!.createdAt = Date.now();
      return;
    }
    const jsonlPath = findSessionJSONL(sessionKey) || '';
    // Skip existing history: start the cursor at the current end-of-file so only
    // events appended after we begin watching are processed.
    let byteOffset = 0, lastIno = 0, lastMtimeMs = 0;
    if (jsonlPath && existsSync(jsonlPath)) {
      try {
        const st = statSync(jsonlPath);
        byteOffset = st.size; lastIno = st.ino; lastMtimeMs = st.mtimeMs;
      } catch {}
    }
    watchedSessions.set(sessionKey, {
      topicId, sessionKey, jsonlPath, byteOffset, lastIno, lastMtimeMs,
      createdAt: Date.now(), deliveredEvents: new Set(),
    });
    console.log(`[SubagentPoll] Watching ${sessionKey} for sub-agent completions (JSONL: ${jsonlPath ? 'found' : 'pending'}, offset: ${byteOffset})`);
    startSubagentPolling();
  }

  // Track which topics already had a browser navigate this session to avoid duplicate triggers
  const browserNavigatedTopics = new Set<string>();

  // Phase 30 BROWSER-CHAT-03 — OpenClaw browser bridge removed; agent now
  // controls the browser via 5 native tools at /api/browsers/:id/agent/*.
  // The legacy per-request targetId memoization Map (used by the deleted
  // bridge handler) was deleted alongside the bridge block.

  /**
   * Auto-open the browser pane when the assistant mentions a localhost:PORT dev
   * server in plain text (once per topic per stream). This is NOT a marker — it's
   * a convenience heuristic on natural output — so it survived the marker removal.
   * Explicit browser control is via the `open_browser_pane` tool.
   * Returns content unchanged (no stripping); only the side-effect matters.
   */
  function detectLocalhostAutoNav(content: string, topic: Topic | null): string {
    if (!topic) return content;
    // Cheap substring guard before the regex (the pattern always requires the
    // literal "localhost:") so we don't rescan every delta for nothing.
    if (!browserNavigatedTopics.has(topic.id) && content.includes('localhost:')) {
      const localhostMatch = content.match(/(?:https?:\/\/)?localhost:(\d{4,5})\b/);
      if (localhostMatch) {
        const port = parseInt(localhostMatch[1]);
        const appPort = parseInt(process.env.PORT || "3333");
        if (port !== appPort && port >= 3000 && port <= 65535) {
          const browserUrl = localhostMatch[0].startsWith("http") ? localhostMatch[0] : `http://${localhostMatch[0]}`;
          console.log(`[Browser] Auto-navigate via localhost detection: ${browserUrl}`);
          broadcastToAll({ type: "browser:navigate", topicId: topic.id, contextId: resolveContextIdForTopic(topic), url: browserUrl });
          browserNavigatedTopics.add(topic.id);
        }
      }
    }
    return content;
  }

  function isExistingDir(p: string): boolean {
    try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; }
  }

  /**
   * Resolve a project reference (a Topics project name/slug, a `~/` or absolute
   * path, or an OpenClaw workspace name) to an absolute directory on disk.
   *
   * Crucially this prefers the user's REAL Topics projects (projectStore) and
   * folders already bound to a topic — not just `~/.openclaw/workspace`. That is
   * what makes a cloud session's "open project Pix" land on the actual Pix
   * project the user has in Topics. Returns null when nothing resolves to an
   * existing directory.
   */
  function resolveProjectRef(ref: string, opts?: { trustRawPaths?: boolean }): string | null {
    const raw = (ref || "").trim();
    if (!raw) return null;

    // Absolute / home-relative paths. Honoured verbatim ONLY for explicit local
    // user actions (the /project command, an adopt body). On the AI-marker path
    // (trustRawPaths falsy) a raw path must already be a project Topics knows
    // about — otherwise a model, or prompt injection reaching a cloud session,
    // could emit {{PROJECT_OPEN:~/.ssh}} / {{PROJECT_OPEN:/etc}} and make every
    // connected client open a pane rooted at an arbitrary directory.
    if (raw.startsWith("/") || raw.startsWith("~/")) {
      const abs = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
      if (!isExistingDir(abs)) return null;
      return (opts?.trustRawPaths || isKnownProject(abs)) ? abs : null;
    }

    // Bare name/slug: match against known projects (strongest signal first).
    const candidates: ProjectRefCandidate[] = [];
    try {
      for (const p of projectStore.list({ archived: false })) {
        candidates.push({ path: p.path, name: p.name, slug: p.slug });
      }
    } catch { /* projectStore is best-effort here */ }
    // Topic-bound paths ordered by liveness: a NON-archived, recently-updated
    // binding beats a dead one. Without this, "topics-app" once resolved to an
    // empty workspace husk because six archived June chats iterated before the
    // live ones bound to the real repo.
    const topicList = (Object.values(loadTopics().topics) as any[])
      .filter((t) => typeof t?.projectPath === "string" && t.projectPath)
      .sort((a, b) =>
        (Number(!!a.archived) - Number(!!b.archived)) ||
        String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    for (const t of topicList) candidates.push({ path: t.projectPath });
    for (const p of getWorkspaceProjects()) candidates.push({ path: p });

    // Compare candidate slugs with the SAME slugify that produced them (the
    // store's), so "My App" matches a project stored as slug "my-app". On an
    // ambiguous ref (same basename in several places) prefer the match that
    // LOOKS like a project (git repo, CLAUDE.md, manifest…) over a bare husk.
    const matches = matchProjectRefAll(raw, candidates, (s) => projectStore.slugify(s)).filter(isExistingDir);
    if (matches.length) return matches.find(looksLikeProject) ?? matches[0];

    // Last resort: a same-named folder directly under the workspace.
    const wsDir = join(WORKSPACE_DIR, raw.replace(/[^a-zA-Z0-9_-]/g, ""));
    return isExistingDir(wsDir) ? wsDir : null;
  }

  /** Is this directory already a project Topics knows about? Used to decide
   *  whether a heuristic auto-bind is safe to surface as a project window. */
  function isKnownProject(dir: string): boolean {
    try { if (projectStore.getByPath(dir)) return true; } catch { /* ignore */ }
    if (getWorkspaceProjects().includes(dir)) return true;
    for (const t of Object.values(loadTopics().topics)) {
      if ((t as any).projectPath === dir) return true;
    }
    return false;
  }

  /**
   * Single source of truth for binding a topic (a chat / cloud session) to a
   * project directory. Persists `projectPath`, notifies clients (topic:updated)
   * and — when `focus` — emits `pane:focus-suggest` so every client opens the
   * project window and nests THIS session inside it. The cloud session then
   * shows up as a project on Topics, the way a Warp cloud session is scoped to
   * its repo. `projectPath` rides along on the focus-suggest so the client
   * never has to wait for topic:updated to arrive first (removes a race).
   */
  function bindTopicToProject(topicId: string, targetDir: string, opts?: { focus?: boolean }): boolean {
    const t = getTopicById(topicId);
    if (!t) return false;
    if (t.projectPath !== targetDir) {
      t.projectPath = targetDir;
      t.updatedAt = new Date().toISOString();
      saveSingleTopic(t);
      broadcastToAll({ type: "topic:updated", topic: t });
    }
    if (opts?.focus) {
      broadcastToAll({ type: "pane:focus-suggest", topicId: t.id, projectPath: targetDir });
    }
    return true;
  }

  /**
   * Detect projectPath from user + assistant messages without needing an LLM call.
   * Looks for explicit directory paths in the conversation.
   */
  function detectProjectPathFromMessages(messages: { role: string; content: string }[]): string | null {
    const allText = messages.map(m => m.content).join('\n');
    // Match explicit paths like /tmp/something, ~/projects/xxx, /Users/xxx/yyy
    const pathPatterns = [
      /(?:in|to|at|from|create|mkdir|cd)\s+(\/(?:tmp|Users|home|var|opt|srv)\/[\w./-]+)/gi,
      /(?:in|to|at|from|create|mkdir|cd)\s+(~\/[\w./-]+)/gi,
      /(?:project|app|directory|folder|dir)\s+(?:at|in|is)?\s*(\/[\w./-]+)/gi,
    ];
    const candidates: string[] = [];
    for (const pattern of pathPatterns) {
      let match;
      while ((match = pattern.exec(allText)) !== null) {
        let p = match[1].replace(/[.,;:!?)]+$/, ''); // strip trailing punctuation
        if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
        // Must be at least 2 levels deep
        if (p.split('/').filter(Boolean).length >= 2) {
          candidates.push(p);
        }
      }
    }
    // Return first candidate that looks like a project directory (has package.json, or was explicitly created)
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch {}
    }
    // Even if directory doesn't exist yet, return the first candidate from user message
    const userText = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    for (const pattern of pathPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(userText)) !== null) {
        let p = match[1].replace(/[.,;:!?)]+$/, '');
        if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
        if (p.split('/').filter(Boolean).length >= 2) return p;
      }
    }
    return null;
  }

  /**
   * After first AI response: auto-detect projectPath and auto-name the topic (simple heuristic).
   * Runs server-side without needing a second LLM call.
   */
  function autoBindProject(topic: Topic): void {
    if (topic.projectPath) return; // already bound
    const localMsgs = loadLocalMessages(topic.sessionKey);
    if (localMsgs.length < 2) return; // need at least 1 user + 1 assistant
    const detected = detectProjectPathFromMessages(localMsgs);
    if (detected) {
      const t = getTopicById(topic.id);
      if (t && !t.projectPath) {
        // Heuristic detection: only force the project window open when the
        // folder is one Topics already knows about. A brand-new path mentioned
        // in passing still binds, but doesn't surprise the user with a window.
        bindTopicToProject(t.id, detected, { focus: isKnownProject(detected) });
        console.log(`[AutoBind] Detected projectPath for "${t.name}": ${detected}`);
      }
    }
  }

  function matchHistoryRoute(pathname: string): string | null {
    const prefix = "/api/history/";
    if (pathname.startsWith(prefix)) return decodeURIComponent(pathname.slice(prefix.length));
    return null;
  }

  /**
   * Stream an assistant response for an edited message.
   * Reuses the same gateway streaming flow as /api/chat.
   */
  // streamEditResponse() + POST /api/messages/:id/edit moved to server/routes/edit.ts

  const { db } = ctx;

  function getProjectIdForTopic(topicId: string): string | null {
    const topic = getTopicById(topicId);
    if (!topic?.projectPath) return null;
    const projectPath = topic.projectPath;
    const pathParts = projectPath.replace(/\/+$/, "").split("/");
    const dirName = pathParts[pathParts.length - 1] || "project";
    let hash = 0;
    for (let i = 0; i < projectPath.length; i++) { hash = ((hash << 5) - hash) + projectPath.charCodeAt(i); hash |= 0; }
    return dirName + "-" + Math.abs(hash).toString(36).slice(0, 6);
  }

  // Scan workspace directory for project directories
  const WORKSPACE_DIR = join(OPENCLAW_DIR, "workspace");
  const SKIP_DIRS = new Set(["node_modules", "memory", "backups", "test-results"]);
  const PROJECT_MARKERS = [
    ".git", "package.json", "CLAUDE.md", "Cargo.toml", "go.mod", "pyproject.toml",
    "Makefile", "README.md", "tsconfig.json", "requirements.txt", "Dockerfile",
    "index.html", "server.ts", "server.py", "server.js",
  ];
  function getWorkspaceProjects(): string[] {
    try {
      if (!existsSync(WORKSPACE_DIR)) return [];
      return readdirSync(WORKSPACE_DIR, { withFileTypes: true })
        .filter(e => {
          if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) return false;
          return looksLikeProject(join(WORKSPACE_DIR, e.name));
        })
        .map(e => join(WORKSPACE_DIR, e.name));
    } catch { return []; }
  }

  /** Does this dir carry at least one project marker? Used both by the
   *  workspace scan and by resolveProjectRef's ambiguity tiebreak (a real
   *  repo beats a marker-less husk with the same basename). */
  function looksLikeProject(dir: string): boolean {
    try { return PROJECT_MARKERS.some(m => existsSync(join(dir, m))); } catch { return false; }
  }

  /**
   * Relocate a Claude Code TERMINAL tab into a project window — extracted to
   * server/lib/relocate-pane.ts (unit-testable; the closure needed only db +
   * broadcastToAll). The extraction rode along with the duplicate-tab fix:
   * the splice now writes a durable TOMBSTONE, without which live clients'
   * union-hydrate re-persisted the standalone tab right back (moved tab
   * duplicated inside+outside the project, closes coupled). See the module
   * header for the full story.
   */
  const moveTerminalPaneToProject = (
    term: { id: string; name?: string },
    projectDir: string,
  ): { paneId: string; membershipKey: string } =>
    relocateTerminalPaneToProject(db, broadcastToAll, term, projectDir);

  // Auto-naming endpoint extracted to its own router  // Auto-naming endpoint extracted to its own router; it needs two closure
  // helpers injected (they close over this scope), so it's instantiated here.
  const autoNameRouter = createAutoNameRouter(ctx, { resolveProvider, detectProjectPathFromMessages });
  const historyRouter = createHistoryRouter(ctx, { matchHistoryRoute, providerForSessionKey });
  const editRouter = createEditRouter(ctx, { resolveProvider, updateUnreadCount });
  const chatRouter = createChatRouter(ctx, {
    resolveProvider, detectLocalhostAutoNav, bindTopicToProject, resolveProjectRef,
    getProjectIdForTopic, getWorkspaceProjects, autoBindProject,
    watchSessionForSubagents, updateUnreadCount, browserNavigatedTopics, WORKSPACE_DIR,
  }, browserService);

  return async function topicsRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // --- Topics CRUD ---
    if (method === "GET" && pathname === "/api/topics") {
      const data = loadTopics();
      const fixedIds: string[] = [];
      for (const topic of Object.values(data.topics)) {
        if (topic.parentId && !data.topics[topic.parentId]) {
          console.log(`[Orphan Fix] Topic "${topic.name}" (${topic.id}) had broken parentId "${topic.parentId}" — moved to root`);
          topic.parentId = null;
          fixedIds.push(topic.id);
        }
      }
      // Save only the topics we actually modified — saveTopics-all would
      // re-write every row and could overwrite a sibling request's recent
      // mutation on an unrelated field. One outer transaction so a crash
      // mid-loop can't leave half the orphan-fixes applied.
      if (fixedIds.length > 0) {
        ctx.db.transaction(() => {
          for (const id of fixedIds) saveSingleTopic(data.topics[id]);
        })();
      }
      return json({ ...data, workspaceProjects: getWorkspaceProjects() });
    }

    // Streaming-session snapshot for cross-reload loading hydration. The client
    // (useSignalsSync) polls this so a chat that was mid-reply when the page
    // (re)loaded shows its spinner even before its window mounts — the live WS
    // stream only drives the foreground session. Sourced from the authoritative
    // in-memory activeStreams registry (isStreaming auto-expires stale entries),
    // NOT the DB `partial` flag which a crashed stream can leave set forever.
    // Replaces the route lost when Master was removed: the old client path
    // /api/topics/master/sessions 404'd, so hydration silently never fired.
    if (method === "GET" && pathname === "/api/topics/streaming") {
      const data = loadTopics();
      // sessionKey is included so the client can reconcile its per-session
      // streaming flags against this authoritative registry (self-heal a
      // spinner stuck after a lost stream:end). topicId stays for the
      // hydratedStreamTopics mapping.
      const sessions: { topicId: string; sessionKey: string; state: "streaming" }[] = [];
      for (const topic of Object.values(data.topics)) {
        if (topic.sessionKey && isStreaming(topic.sessionKey)) {
          sessions.push({ topicId: topic.id, sessionKey: topic.sessionKey, state: "streaming" });
        }
      }
      return json({ sessions });
    }

    if (method === "POST" && pathname === "/api/topics") {
      const body = await readJSON(req);
      // typeof guard: slugify() calls .toLowerCase() and would 500 on a non-string name.
      if (!body || typeof body.name !== "string" || !body.name) return json({ error: "name (string) required" }, 400);
      const data = loadTopics();
      const id = crypto.randomUUID();
      const slug = slugify(body.name);
      const parentId = body.parentId || null;
      const topic: Topic = {
        id, name: body.name, slug, parentId, links: [],
        sessionKey: "", color: body.color || "#5865f2", icon: body.icon || "MessageSquare",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        archived: false, systemPrompt: body.systemPrompt || "",
        contextFiles: [], pinnedMessages: [],
        sortOrder: Object.keys(data.topics).length,
        provider: body.provider || null,
      };
      // Set projectPath if explicitly provided (e.g. creating from within a project)
      if (body.projectPath) {
        (topic as any).projectPath = body.projectPath;
      }
      // Optional binding to a Worktree (Phase A · TOPIC-WT-01).
      // Validate the FK before persistence — the DB-level FK would also
      // reject the insert, but a friendly 400 is nicer than a 500.
      if (body.worktreeId !== undefined && body.worktreeId !== null) {
        const wt = worktreeStore.get(body.worktreeId);
        if (!wt) return json({ error: "worktreeId not found" }, 400);
        topic.worktreeId = body.worktreeId;
      }
      // Phase C · TOPIC-IM-01: optional one-shot initial message.
      // Validation: ≤ 8000 chars, control-char strip. Empty string normalises
      // to null so callers can send "" without persisting useless rows.
      if (body.initialMessage !== undefined && body.initialMessage !== null) {
        const cleaned = String(body.initialMessage).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
        if (cleaned.length > 8000) return json({ error: "initialMessage too long (max 8000)" }, 400);
        if (cleaned.length > 0) topic.initialMessage = cleaned;
      }

      data.topics[id] = topic;
      topic.sessionKey = "topic:" + id.slice(0, 8);
      saveSingleTopic(topic);
      broadcastToAll({ type: "topic:created", topic });
      return json(topic, 201);
    }

    // POST /api/topics/adopt — open a cloud (gateway) session as a first-class,
    // INTERACTIVE Topics chat (like opening a cloud session from Warp), instead
    // of only viewing it read-only. Idempotent: if a topic already owns this
    // sessionKey, return (and focus) it. Otherwise create an openclaw-backed
    // topic bound to the EXISTING gateway session so the user can talk to it,
    // optionally scoped to a project.
    if (method === "POST" && pathname === "/api/topics/adopt") {
      try {
        const body = await readJSON(req);
        const sessionKey = body?.sessionKey ? String(body.sessionKey).trim() : "";
        if (!sessionKey) return json({ error: "sessionKey required" }, 400);

        // Shape guard: a session key is `kind:id` / a bare token (e.g.
        // "topic:abc12345", "agent:sub-xyz", "main"). Reject whitespace,
        // control chars, path-like inputs and `..` so a fabricated/garbled key
        // from a buggy client can't mint a phantom cloud chat.
        if (!/^[A-Za-z0-9][\w:.\-/]{0,127}$/.test(sessionKey) || sessionKey.includes("..")) {
          return json({ error: "invalid sessionKey" }, 400);
        }

        const existing = getTopicBySessionKey(sessionKey);
        if (existing) {
          if (existing.projectPath) bindTopicToProject(existing.id, existing.projectPath, { focus: true });
          return json(existing, 200);
        }

        const id = crypto.randomUUID();
        const name =
          (body?.name ? String(body.name).trim() : "") ||
          `Cloud session ${sessionKey.replace(/^topic:/, "").slice(0, 12)}`;
        // body.projectPath is an explicit local action → raw paths are trusted.
        const projectDir = body?.projectPath
          ? resolveProjectRef(String(body.projectPath), { trustRawPaths: true })
          : null;

        // Atomic check-then-insert: re-read INSIDE the transaction so two
        // concurrent adopts for the same sessionKey converge on one topic,
        // rather than the second INSERT OR REPLACE destructively deleting the
        // first row (session_key is UNIQUE; REPLACE would cascade FK deletes).
        const out = ctx.db.transaction((): { topic: Topic; created: boolean } => {
          const again = getTopicBySessionKey(sessionKey);
          if (again) return { topic: again, created: false };
          const data = loadTopics();
          const topic: Topic = {
            id, name, slug: slugify(name), parentId: null, links: [],
            sessionKey,                     // adopt the EXISTING gateway session
            color: body?.color || "#5865f2", icon: body?.icon || "Cloud",
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            archived: false, systemPrompt: "",
            contextFiles: [], pinnedMessages: [],
            sortOrder: Object.keys(data.topics).length,
            provider: "openclaw",           // cloud-backed
          };
          if (projectDir) (topic as any).projectPath = projectDir;
          saveSingleTopic(topic);
          return { topic, created: true };
        })();

        if (!out.created) {
          if (out.topic.projectPath) bindTopicToProject(out.topic.id, out.topic.projectPath, { focus: true });
          return json(out.topic, 200);
        }

        broadcastToAll({ type: "topic:created", topic: out.topic });
        // Scope to its project (open + nest) when one was resolved; otherwise the
        // caller opens it as a standalone cloud chat.
        if (projectDir) bindTopicToProject(out.topic.id, projectDir, { focus: true });
        return json(out.topic, 201);
      } catch (err: any) {
        console.warn("[adopt] failed:", err);
        return json({ error: `adopt failed: ${err?.message || String(err)}` }, 500);
      }
    }

    // PATCH /api/topics/:id
    {
      const params = matchRoute(pathname, "/api/topics/:id");
      if (params && method === "PATCH") {
        const body = await readJSON(req);
        if (!body) return json({ error: "body required" }, 400);
        // Loads all topics: the parent/ancestor cycle check below walks
        // `data.topics[ancestorId]` across the tree, so a single indexed read
        // would not suffice here.
        const data = loadTopics();
        const topic = data.topics[params.id];
        if (!topic) return json({ error: "not found" }, 404);
        // typeof guard: a non-string name here would set topic.name to garbage
        // and then 500 inside slugify() (.toLowerCase()), after the mutation.
        if (typeof body.name === "string" && body.name) { topic.name = body.name; topic.slug = slugify(body.name); }
        if (body.color !== undefined) topic.color = body.color;
        if (body.icon !== undefined) topic.icon = body.icon;
        if (body.parentId !== undefined) {
          const newParentId = body.parentId || null;
          // Prevent circular reference: topic can't be its own parent or ancestor
          if (newParentId) {
            if (newParentId === params.id) {
              return json({ error: "topic cannot be its own parent" }, 400);
            }
            // Walk up the ancestor chain to detect cycles
            let ancestorId: string | null = newParentId;
            const visited = new Set<string>();
            while (ancestorId) {
              if (visited.has(ancestorId)) break; // already a cycle in existing data
              visited.add(ancestorId);
              if (ancestorId === params.id) {
                return json({ error: "circular reference: topic cannot be nested under its own descendant" }, 400);
              }
              ancestorId = data.topics[ancestorId]?.parentId || null;
            }
          }
          topic.parentId = newParentId;
        }
        if (body.systemPrompt !== undefined) topic.systemPrompt = body.systemPrompt;
        if (body.contextFiles !== undefined) topic.contextFiles = body.contextFiles;
        if (body.pinnedMessages !== undefined) topic.pinnedMessages = body.pinnedMessages;
        if (body.projectPath !== undefined) topic.projectPath = body.projectPath || undefined;
        if (body.autonomyLevel !== undefined) {
          const valid: Topic['autonomyLevel'][] = ['ask', 'auto-apply', 'yolo'];
          topic.autonomyLevel = valid.includes(body.autonomyLevel) ? body.autonomyLevel : 'ask';
        }
        // Provider/model are spawn-time flags for the claude-code CLI (same
        // as effort below): track changes so we can force an idle respawn.
        let spawnConfigChanged = false;
        if (body.provider !== undefined) {
          const prev = topic.provider ?? null;
          topic.provider = body.provider || null;
          spawnConfigChanged ||= (topic.provider ?? null) !== prev;
        }
        if (body.model !== undefined) {
          const prev = topic.model ?? null;
          topic.model = body.model || null;
          spawnConfigChanged ||= (topic.model ?? null) !== prev;
        }
        // Per-topic effort tier (migration 033). Accepts a valid tier, or
        // null/""/"default" to clear the override (fall back to the global
        // env-resolved default). Unknown tiers are rejected so a stale client
        // can't persist garbage that silently disables the flag at spawn time.
        let effortChanged = false;
        if (body.effort !== undefined) {
          const prev = topic.effort ?? null;
          if (body.effort === null || body.effort === "" || body.effort === "default") {
            topic.effort = null;
          } else {
            const tier = String(body.effort).trim().toLowerCase();
            const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
            if (!VALID_EFFORTS.has(tier)) return json({ error: "invalid effort tier" }, 400);
            topic.effort = tier;
          }
          effortChanged = (topic.effort ?? null) !== prev;
        }
        // Fast Mode (migration 024). Accept boolean only; null/undefined leaves
        // the existing value alone. Coerce non-boolean truthy/falsy inputs
        // defensively so a stale client sending "false" string doesn't toggle.
        if (body.fastMode !== undefined && body.fastMode !== null) {
          topic.fastMode = body.fastMode === true;
        }
        if (body.disabledContextSources !== undefined) topic.disabledContextSources = body.disabledContextSources;
        // worktreeId update (Phase A · TOPIC-WT-01). NULL = clear binding.
        if (body.worktreeId !== undefined) {
          if (body.worktreeId === null) {
            topic.worktreeId = null;
          } else {
            const wt = worktreeStore.get(body.worktreeId);
            if (!wt) return json({ error: "worktreeId not found" }, 400);
            topic.worktreeId = body.worktreeId;
          }
        }
        // Phase C · TOPIC-IM-01. NULL = clear (renderer PATCHes after dispatch).
        if (body.initialMessage !== undefined) {
          if (body.initialMessage === null || body.initialMessage === "") {
            topic.initialMessage = null;
          } else {
            const cleaned = String(body.initialMessage).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
            if (cleaned.length > 8000) return json({ error: "initialMessage too long (max 8000)" }, 400);
            topic.initialMessage = cleaned;
          }
        }
        topic.updatedAt = new Date().toISOString();
        saveSingleTopic(topic);
        broadcastToAll({ type: "topic:updated", topic });
        // Effort tier AND model/provider are fixed at CLI spawn time — drop the
        // idle pooled process so the next turn respawns with the new `--effort`
        // / `--model`. Fire-and-forget: failures are non-fatal (the change still
        // applies on the next natural respawn) and must not block the PATCH
        // response.
        if (effortChanged || spawnConfigChanged) {
          try { resolveProvider(topic).refreshSessionConfig?.(topic.sessionKey); }
          catch (err) { console.warn(`[topics] refreshSessionConfig failed for ${topic.sessionKey}:`, err); }
        }
        return json(topic);
      }

      if (params && method === "DELETE") {
        const topic = getTopicById(params.id);
        if (!topic) return json({ error: "not found" }, 404);
        let archive = true;
        try { const body = await req.json(); if (typeof body.archived === 'boolean') archive = body.archived; } catch {}
        topic.archived = archive;
        topic.updatedAt = new Date().toISOString();
        saveSingleTopic(topic);
        broadcastToAll({ type: "topic:archived", topic });
        // Reset unread when archiving
        if (archive) {
          const unread = loadUnread();
          unread[params.id] = { lastReadAt: new Date().toISOString(), unreadCount: 0 };
          saveUnread(unread);
          broadcastToAll({ type: "unread:updated", topicId: params.id, unreadCount: 0 });
          // Purge this topic id from every client's persisted openChatTopicIds
          // so reloads don't fail validation on a phantom id.
          // Bug #12: if the purge fails we return 500 — topic is archived but
          // ui_state is stale, so client-side reload will see a phantom id.
          const purgeResult = purgeTopicFromUiState(ctx.db, broadcastToAll, params.id);
          if (!purgeResult.ok) {
            return json({ error: "topic archived but ui_state purge failed", details: purgeResult.error, topic }, 500);
          }
        }
        return json(topic);
      }
    }

    // POST /api/topics/bulk-archive
    if (method === "POST" && pathname === "/api/topics/bulk-archive") {
      const body = await readJSON(req);
      if (!body || !body.projectPath || typeof body.archived !== 'boolean') {
        return json({ error: "projectPath and archived (boolean) required" }, 400);
      }
      const { projectPath, archived } = body;
      const data = loadTopics();
      const unread = loadUnread();
      const updatedTopics: Topic[] = [];
      const now = new Date().toISOString();
      for (const topic of Object.values(data.topics)) {
        if (topic.projectPath === projectPath) {
          topic.archived = archived;
          topic.updatedAt = now;
          updatedTopics.push(topic);
          if (archived) {
            unread[topic.id] = { lastReadAt: now, unreadCount: 0 };
          }
        }
      }
      if (updatedTopics.length === 0) return json({ error: "no topics found for projectPath" }, 404);
      // Targeted writes wrapped in one transaction — only the topics we just
      // modified are written (no trampling of unrelated rows) AND a crash
      // mid-archive can't leave half the project archived. saveUnread for
      // the archive path is included so the unread reset commits with the
      // archive flip.
      ctx.db.transaction(() => {
        for (const topic of updatedTopics) saveSingleTopic(topic);
        if (archived) saveUnread(unread);
      })();
      const purgeFailures: { topicId: string; error: string }[] = [];
      for (const topic of updatedTopics) {
        broadcastToAll({ type: "topic:archived", topic });
        if (archived) {
          broadcastToAll({ type: "unread:updated", topicId: topic.id, unreadCount: 0 });
          const purgeResult = purgeTopicFromUiState(ctx.db, broadcastToAll, topic.id);
          if (!purgeResult.ok) {
            purgeFailures.push({ topicId: topic.id, error: purgeResult.error });
          }
        }
      }
      // Bug #12: surface any purge failure in the response body (partial-fail
      // semantics — topics are archived but some ui_state records may be stale).
      if (purgeFailures.length > 0) {
        return json({
          ok: false,
          count: updatedTopics.length,
          topics: updatedTopics,
          error: "some ui_state purges failed — stale topic ids may resurrect on client reload",
          purgeFailures,
        }, 500);
      }
      return json({ ok: true, count: updatedTopics.length, topics: updatedTopics });
    }

    // POST /api/topics/:id/link
    {
      const params = matchRoute(pathname, "/api/topics/:id/link");
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body || !body.targetId) return json({ error: "targetId required" }, 400);
        const topic = getTopicById(params.id);
        const target = getTopicById(body.targetId);
        if (!topic || !target) return json({ error: "not found" }, 404);
        if (!topic.links.includes(body.targetId)) topic.links.push(body.targetId);
        if (!target.links.includes(params.id)) target.links.push(params.id);
        topic.updatedAt = new Date().toISOString();
        target.updatedAt = new Date().toISOString();
        // Atomic: both sides of the symmetric link write together, so a
        // crash mid-pair can't leave a half-link (A→B exists, B→A doesn't).
        ctx.db.transaction(() => {
          saveSingleTopic(topic);
          saveSingleTopic(target);
        })();
        return json({ ok: true });
      }
    }

    // DELETE /api/topics/:id/link/:targetId
    {
      const params = matchRoute(pathname, "/api/topics/:id/link/:targetId");
      if (params && method === "DELETE") {
        const topic = getTopicById(params.id);
        const target = getTopicById(params.targetId);
        if (!topic) return json({ error: "not found" }, 404);
        topic.links = topic.links.filter((l) => l !== params.targetId);
        if (target) target.links = target.links.filter((l) => l !== params.id);
        topic.updatedAt = new Date().toISOString();
        if (target) target.updatedAt = new Date().toISOString();
        ctx.db.transaction(() => {
          saveSingleTopic(topic);
          if (target) saveSingleTopic(target);
        })();
        return json({ ok: true });
      }
    }

    // POST /api/topics/reorder
    if (method === "POST" && pathname === "/api/topics/reorder") {
      const body = await readJSON(req);
      if (!body?.order || !Array.isArray(body.order)) return json({ error: "order array required" }, 400);
      // Targeted column update inside one transaction: only `sort_order` is
      // touched, so a sibling request mutating `name` / `provider` / `model`
      // on the same topic concurrently doesn't have its write rolled back.
      // We bypass `saveSingleTopic` here because that function rewrites the
      // entire row from a Topic snapshot (and we don't want to re-fetch each
      // one just to flip one integer).
      const stmt = ctx.db.prepare("UPDATE topics SET sort_order = ?, updated_at = ? WHERE id = ?");
      const now = new Date().toISOString();
      ctx.db.transaction(() => {
        for (let i = 0; i < body.order.length; i++) {
          stmt.run(i, now, body.order[i]);
        }
      })();
      broadcastToAll({ type: "topics:reordered", order: body.order });
      return json({ ok: true });
    }

    // GET /api/unread
    if (method === "GET" && pathname === "/api/unread") {
      return json(loadUnread());
    }

    // POST /api/topics/:id/read
    {
      const params = matchRoute(pathname, "/api/topics/:id/read");
      if (params && method === "POST") {
        const unread = loadUnread();
        unread[params.id] = { lastReadAt: new Date().toISOString(), unreadCount: 0 };
        saveUnread(unread);
        broadcastToAll({ type: "unread:updated", topicId: params.id, unreadCount: 0 });
        return json({ ok: true });
      }
    }

    // POST /api/topics/:id/browser/open-pane
    // POST /api/sessions/:sessionKey/browser/open-pane
    //
    // The MCP bridge surface for non-SDK providers (claude-code CLI, codex CLI):
    // these providers can't receive an inline `browser_open` Anthropic Tool[]
    // through topics-app, so they invoke this endpoint via the MCP server
    // spawned at server/mcp/topics-mcp-server.ts (wired in claude-code provider
    // through `--mcp-config`). End result is identical to the SDK tool path:
    //   1. Playwright navigates the topic's headless context
    //   2. browser:navigate WS broadcast opens/focuses the user-facing pane
    //   3. browserNavigatedTopics is seeded to suppress the localhost-URL fallback
    //
    // Two address forms because:
    //   - topic-id: easy for REST callers that already know the topic
    //   - session-key: the claude-code MCP subprocess only has the sessionKey
    //     it was spawned under (the topicId would require an extra DB round-trip
    //     at spawn time). Both forms resolve to the same handler.
    {
      const byTopic = matchRoute(pathname, "/api/topics/:id/browser/open-pane");
      const bySession = matchRoute(pathname, "/api/sessions/:sessionKey/browser/open-pane");
      if ((byTopic || bySession) && method === "POST") {
        if (!browserService) {
          return json({ error: "Browser service is not enabled in this build" }, 503);
        }
        let topic: Topic | null = null;
        if (byTopic) {
          topic = getTopicById(byTopic.id);
        } else if (bySession) {
          topic = getTopicBySessionKey(decodeURIComponent(bySession.sessionKey));
        }

        // Terminal-originated open: the MCP bridge for a Claude Code *terminal*
        // passes the terminal session id as the sessionKey, which matches no
        // chat topic. Instead of 404, open the browser in the same layout group
        // as the terminal pane. The client resolves the group from the pane id
        // — works for both standalone (group:default) and project layouts — and
        // uses that group's own browser context, then navigates. We don't
        // pre-open a server browser context here (the contextId differs between
        // standalone and project rendering); the client's RemoteBrowserPanel
        // drives the actual open/navigate once the pane mounts.
        if (!topic && bySession) {
          const term = getTerminalSessionById(decodeURIComponent(bySession.sessionKey));
          if (term) {
            const body = (await readJSON(req)) as { url?: unknown } | null;
            const url = typeof body?.url === "string" ? body.url : "";
            if (!url) return json({ error: "url (string) is required" }, 400);
            // contextId is deterministic (`term-<id>`) so the client registers
            // the pane's CDP target under the SAME id the observe/act routes
            // resolve to — that's what lets a terminal drive the pane, not just
            // open it.
            const ctxId = `term-${term.id}`;
            // Broadcast so the client opens the near-terminal pane under ctxId and
            // seeds it with `url` (initialUrl). The client's native pane drives the
            // actual load; the agent's browser_* tools reach that same pane via the
            // native delegate (registered under ctxId). Nothing to navigate
            // server-side here — just ack.
            broadcastToAll({ type: "browser:open-near-pane", paneId: `terminal:${term.id}`, contextId: ctxId, url });
            return json({ url, title: "" });
          }
        }
        if (!topic) return json({ error: "Topic not found" }, 404);

        const body = (await readJSON(req)) as { url?: unknown } | null;
        const url = typeof body?.url === "string" ? body.url : "";
        if (!url) return json({ error: "url (string) is required" }, 400);

        // Task-owned browser fork (feature-flagged): the agent working a task
        // opens a browser into that task's IN-DRAWER group, not the global
        // layout. Mirror the terminal path above — broadcast + return, NO
        // server-side dispatchBrowserToolCallByContext: the task pane may be
        // unmounted (drawer closed), so a headless browser_open would drive an
        // invisible Playwright phantom. The client's RemoteBrowserPanel loads
        // `url` (initialUrl) once the pane mounts and registers its native
        // target under contextId; the agent's later observe/act reach that same
        // pane because we bind topic.browserState.contextId to it here.
        const taskCtx = resolveTaskBrowserContext(topic);
        if (taskCtx) {
          topic.browserState = {
            url,
            contextId: taskCtx.contextId,
            lastActiveAt: Date.now(),
            viewport: topic.browserState?.viewport,
          };
          saveSingleTopic(topic);
          browserNavigatedTopics.add(topic.id);
          broadcastToAll({ type: "browser:open-task-tab", taskId: taskCtx.taskId, contextId: taskCtx.contextId, url });
          return json({ url, title: "" });
        }

        const ctxId = resolveContextIdForTopic(topic);
        // 1. Broadcast FIRST (carrying contextId) so the client mounts/seeds the
        //    native pane under the SAME id the agent's browser_* tools resolve to.
        //    Previously this dispatched browser_open BEFORE the pane existed, so it
        //    navigated an invisible Playwright phantom while the visible pane stayed
        //    on about:blank — the reported bug. Also fixes the contextId-key
        //    mismatch: the chat pane used to register under a random id.
        broadcastToAll({ type: "browser:navigate", topicId: topic.id, contextId: ctxId, url });
        browserNavigatedTopics.add(topic.id);
        try {
          // Dispatch browser_open through the context. The dispatcher routes it to
          // the Tauri native pane (via the native delegate registered under ctxId
          // by the broadcast above) or, in web mode, to the Playwright context the
          // streamed pane mirrors. Idempotent with the client's own initialUrl load
          // and essential for re-navigating an already-open pane to a new URL.
          const result = await dispatchBrowserToolCallByContext(
            "browser_open",
            { url },
            ctxId,
            browserService,
          ) as { url?: string; title?: string; error?: string };
          if (result?.error) return json({ error: result.error }, 502);
          const resolvedUrl = typeof result?.url === "string" ? result.url : url;
          // Re-broadcast only if the navigation redirected, so the visible pane
          // tracks the final URL too.
          if (resolvedUrl !== url) {
            broadcastToAll({ type: "browser:navigate", topicId: topic.id, contextId: ctxId, url: resolvedUrl });
          }
          return json({ url: resolvedUrl, title: result?.title ?? "" });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return json({ error: msg }, 500);
        }
      }
    }

    // POST /api/topics/:id/browser/close-pane
    // POST /api/sessions/:sessionKey/browser/close-pane
    //
    // Symmetric counterpart of open-pane (close_browser_pane MCP tool): asks
    // every live window that renders `browser:<ctx>` to close it through its
    // NORMAL close flow (X-button semantics). This must be client-originated:
    // the membership keys are LWW documents that live clients re-persist from
    // memory, so a server-side state edit gets clobbered back within seconds.
    // Resolution mirrors open-pane (topic → topic.id, terminal → term-<id>);
    // an explicit body.contextId wins (close a specific pane you spawned).
    // Best-effort: the server-side headless context is destroyed too, so web
    // clients don't keep streaming a pane that no window shows anymore.
    {
      const byTopic = matchRoute(pathname, "/api/topics/:id/browser/close-pane");
      const bySession = matchRoute(pathname, "/api/sessions/:sessionKey/browser/close-pane");
      if ((byTopic || bySession) && method === "POST") {
        const body = (await readJSON(req)) as { contextId?: unknown } | null;
        let ctxId = typeof body?.contextId === "string" && body.contextId ? body.contextId : "";
        if (!ctxId) {
          let topic: Topic | null = null;
          if (byTopic) topic = getTopicById(byTopic.id);
          else if (bySession) topic = getTopicBySessionKey(decodeURIComponent(bySession.sessionKey));
          if (topic) {
            ctxId = resolveContextIdForTopic(topic);
          } else if (bySession) {
            const term = getTerminalSessionById(decodeURIComponent(bySession.sessionKey));
            if (term) ctxId = `term-${term.id}`;
          }
        }
        if (!ctxId) return json({ error: "No browser context resolvable for this session (pass contextId)" }, 404);
        broadcastToAll({ type: "browser:close-pane", contextId: ctxId });
        if (browserService) {
          try { await browserService.destroyContext(ctxId); } catch { /* no headless context — native-only pane */ }
        }
        return json({ ok: true, contextId: ctxId });
      }
    }

    // POST /api/sessions/:sessionKey/move-to-project
    //
    // Single authoritative op to relocate a Claude Code terminal tab INTO a
    // project window, de-duplicated. A membership-only add leaves the tab BOTH
    // inside the project and standalone (the app-level store still owns it), so
    // this endpoint does the whole move server-side:
    //   1. add the pane to the project's server-synced membership
    //      (`topics-project-panes-<projectHash(path)>`)
    //   2. splice it out of the app-level standalone store (`pane-store-v2`:
    //      its `panes` entry + every `groups.*.paneIds` ref)
    //   3. open/focus the project window
    // Both ui_state writes get a fresh monotonic server_seq + `ui-state:updated`
    // broadcast so live clients converge to exactly ONE instance. Device-local
    // split geometry (`project-layout-<hash>`) is intentionally NOT touched.
    // Chat topics use bindTopicToProject instead; this is the terminal-tab path
    // (a tab is not a chat-topic).
    {
      const bySession = matchRoute(pathname, "/api/sessions/:sessionKey/move-to-project");
      if (bySession && method === "POST") {
        const body = (await readJSON(req)) as { projectPath?: unknown } | null;
        const rawPath = typeof body?.projectPath === "string" ? body.projectPath : "";
        if (!rawPath) return json({ error: "projectPath (string) is required" }, 400);
        const dir = resolveProjectRef(rawPath, { trustRawPaths: true });
        if (!dir) return json({ error: "project path does not exist" }, 404);

        const sk = decodeURIComponent(bySession.sessionKey);
        const term = getTerminalSessionById(sk);
        if (!term) {
          return json({ error: "move-to-project supports terminal tabs only; use bind-project for chat topics" }, 400);
        }

        const { paneId, membershipKey } = moveTerminalPaneToProject(term, dir);
        broadcastToAll({ type: "open-project", projectPath: dir });
        return json({ ok: true, paneId, projectPath: dir, membershipKey });
      }
    }

    // POST /api/sessions/:sessionKey/{switch-topic,new-topic,create-project,open-project}
    //
    // Tool-shaped successors to the {{TOPIC_SWITCH/TOPIC_NEW/PROJECT_CREATE/
    // PROJECT_OPEN}} markers (the MCP `switch_topic`/`new_topic`/`create_project`/
    // `open_project` tools + the SDK-passthrough dispatcher both hit these).
    // AI-driven: project refs go through resolveProjectRef(trustRawPaths:false),
    // so a model (or prompt injection) can't open a pane rooted at /etc or ~/.ssh.
    //
    // The CALLER is resolved from its sessionKey, which is EITHER a chat topic OR
    // a Claude Code terminal tab:
    //   - open-project / create-project work from BOTH surfaces. A chat topic
    //     binds via bindTopicToProject; a terminal tab (no chat topic) falls back
    //     to moveTerminalPaneToProject — the tab pane is spliced out of the
    //     app-level store and into the project's membership (same as
    //     move-to-project, but resolving the ref by name/slug like the chat
    //     branch, not an absolute path). create-project scaffolds the dir first
    //     (409 on collision) either way, then routes by surface.
    //   - switch-topic / new-topic act on chat topics only (they migrate/split a
    //     conversation; a terminal tab has no conversation to switch). A terminal
    //     session gets a structured 400 naming open_project/move_session_to_project,
    //     not a bare 404 — so the caller knows the RIGHT tool, not just that this
    //     one didn't apply.
    //
    // switch/new reproduce the UI `topic:switch` broadcast but do NOT migrate
    // already-streamed messages (that was marker-only mid-turn surgery, not
    // reproducible by a tool call) — tool-driven switch is UI-only by design.
    {
      const switchM = matchRoute(pathname, "/api/sessions/:sessionKey/switch-topic");
      const newM = matchRoute(pathname, "/api/sessions/:sessionKey/new-topic");
      const createM = matchRoute(pathname, "/api/sessions/:sessionKey/create-project");
      const openM = matchRoute(pathname, "/api/sessions/:sessionKey/open-project");

      if (switchM && method === "POST") {
        const skRaw = decodeURIComponent(switchM.sessionKey);
        const cur = getTopicBySessionKey(skRaw);
        if (!cur) {
          // A terminal Claude tab has no chat topic to switch — tell it the right
          // tool instead of a bare 404 (which reads like "session doesn't exist").
          if (getTerminalSessionById(skRaw)) {
            return json({
              error: "switch_topic acts on chat topics; this is a terminal Claude tab with no conversation to switch. To move this tab into a project use open_project (or move_session_to_project with an absolute path).",
              code: "not_a_chat_topic",
              tool: "switch_topic",
            }, 400);
          }
          return json({ error: "no chat topic bound to this session" }, 404);
        }
        const body = (await readJSON(req)) as { topicId?: unknown } | null;
        const targetId = typeof body?.topicId === "string" ? body.topicId : "";
        if (!targetId) return json({ error: "topicId (string) is required" }, 400);
        const r = switchTopicCore(cur, targetId, { getTopicById, loadTopics, saveSingleTopic, slugify, broadcastToAll });
        if (!r.ok) {
          // AC-01: archived is a client error distinct from "doesn't exist" — the
          // topic IS there, it's just not switchable (unarchive/open it first).
          if (r.code === "archived") return json({ error: r.message, code: "topic_archived", topicId: targetId }, 400);
          return json({ error: r.message }, 404);
        }
        return json({ ok: true, toTopicId: r.toTopicId });
      }

      if (newM && method === "POST") {
        const skRaw = decodeURIComponent(newM.sessionKey);
        const cur = getTopicBySessionKey(skRaw);
        if (!cur) {
          // A terminal Claude tab has no chat topic to fork a new one from.
          if (getTerminalSessionById(skRaw)) {
            return json({
              error: "new_topic forks a new chat topic from the current one; this is a terminal Claude tab with no conversation. To move this tab into a project use open_project (or move_session_to_project with an absolute path).",
              code: "not_a_chat_topic",
              tool: "new_topic",
            }, 400);
          }
          return json({ error: "no chat topic bound to this session" }, 404);
        }
        const body = (await readJSON(req)) as { title?: unknown } | null;
        const title = typeof body?.title === "string" ? body.title.trim() : "";
        if (!title) return json({ error: "title (string) is required" }, 400);
        const { topic: newTopic } = createTopicCore(cur, title, { getTopicById, loadTopics, saveSingleTopic, slugify, broadcastToAll });
        return json({ ok: true, topicId: newTopic.id });
      }

      if (createM && method === "POST") {
        const skRaw = decodeURIComponent(createM.sessionKey);
        const cur = getTopicBySessionKey(skRaw);
        // Chat topic OR terminal Claude tab — both can create a project. Resolve
        // the terminal fallback up front so we only scaffold when a caller exists.
        const term = cur ? null : getTerminalSessionById(skRaw);
        if (!cur && !term) return json({ error: "no chat topic bound to this session" }, 404);
        const body = (await readJSON(req)) as { name?: unknown } | null;
        const rawName = typeof body?.name === "string" ? body.name.trim() : "";
        const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, "");
        if (!safeName) return json({ error: "name (alphanumeric) is required" }, 400);
        const targetDir = join(WORKSPACE_DIR, safeName);
        // AC-01: create means CREATE — a name collision is a 409, never a silent
        // bind to whatever already lives there (that's open-project/bind-project).
        if (existsSync(targetDir)) {
          return json(
            { error: `project "${safeName}" already exists`, code: "project_exists", name: safeName, projectPath: targetDir },
            409,
          );
        }
        mkdirSync(targetDir, { recursive: true });
        writeFileSync(join(targetDir, "CLAUDE.md"), `# ${safeName}\n`);
        if (cur) {
          bindTopicToProject(cur.id, targetDir, { focus: true });
        } else if (term) {
          // Terminal tab: move the pane into the freshly-scaffolded project and
          // focus it (same focus semantics as the chat bind, via open-project).
          moveTerminalPaneToProject(term, targetDir);
          broadcastToAll({ type: "open-project", projectPath: targetDir });
        }
        return json({ ok: true, projectPath: targetDir });
      }

      if (openM && method === "POST") {
        const skRaw = decodeURIComponent(openM.sessionKey);
        const cur = getTopicBySessionKey(skRaw);
        // Chat topic OR terminal Claude tab — both can open a project.
        const term = cur ? null : getTerminalSessionById(skRaw);
        if (!cur && !term) return json({ error: "no chat topic bound to this session" }, 404);
        const body = (await readJSON(req)) as { ref?: unknown } | null;
        const ref = typeof body?.ref === "string" ? body.ref : "";
        if (!ref) return json({ error: "ref (string) is required" }, 400);
        // Same resolver as the chat branch (trustRawPaths:false): "apri il
        // progetto yup" resolves by name/slug against known projects, and a model
        // still can't reach /etc or ~/.ssh from a terminal tab either.
        const dir = resolveProjectRef(ref, { trustRawPaths: false });
        if (!dir) return json({ error: "project not found (must be a project Topics already knows)" }, 404);
        if (cur) {
          bindTopicToProject(cur.id, dir, { focus: true });
        } else if (term) {
          // Terminal tab: move the pane into the project and focus it (the
          // open-project broadcast gives the same focus semantics as the bind).
          moveTerminalPaneToProject(term, dir);
          broadcastToAll({ type: "open-project", projectPath: dir });
        }
        return json({ ok: true, projectPath: dir });
      }
    }

    // POST /api/topics/:id/browser/import-chrome
    // POST /api/sessions/:sessionKey/browser/import-chrome
    //
    // MCP bridge for the `import_chrome` tool (claude-code CLI sessions): seed the
    // topic's native browser pane with the user's real Chrome cookies. Same handler
    // as the SDK chat tool path (dispatchBrowserToolCall -> handleBrowserImportChrome),
    // which requires the Electron native pane (CDP). Resolves the pane by topic
    // OR terminal session (resolveBrowserContext), so a Claude Code terminal tab
    // can seed its own near-terminal pane too.
    {
      const byTopic = matchRoute(pathname, "/api/topics/:id/browser/import-chrome");
      const bySession = matchRoute(pathname, "/api/sessions/:sessionKey/browser/import-chrome");
      if ((byTopic || bySession) && method === "POST") {
        // import-chrome decrypts the user's REAL Chrome session cookies — far more
        // sensitive than open-pane's navigate. The server binds 0.0.0.0, so require
        // the gateway token (the MCP bridge always sends X-Gateway-Token; the SDK
        // chat path never hits this route — it dispatches in-process). Stops a LAN
        // peer / local process from triggering a confused-deputy cookie import.
        const tok = req.headers.get("x-gateway-token") || "";
        if (!process.env.GATEWAY_TOKEN || !timingSafeEqualStr(tok, process.env.GATEWAY_TOKEN)) {
          return json({ error: "unauthorized" }, 401);
        }
        if (!browserService) {
          return json({ error: "Browser service is not enabled in this build" }, 503);
        }
        const target = resolveBrowserContext(byTopic, bySession);
        if (!target) return json({ error: "No browser pane bound to this session (open a browser pane first)" }, 404);

        const body = (await readJSON(req)) as { domains?: unknown; profile?: unknown; dry_run?: unknown } | null;
        const domains = Array.isArray(body?.domains) ? body.domains.map(String) : [];
        const profile = typeof body?.profile === "string" ? body.profile : undefined;
        const dryRun = !!body?.dry_run;
        try {
          const result = await dispatchBrowserToolCallByContext(
            "browser_import_chrome",
            { domains, profile, dry_run: dryRun },
            target.contextId,
            browserService,
          ) as { error?: string };
          if (result?.error) return json({ error: result.error }, 502);
          return json(result as Record<string, unknown>);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return json({ error: msg }, 500);
        }
      }
    }

    // POST /api/{topics/:id,sessions/:sessionKey}/browser/:tool
    // Generic MCP bridge for the ref-based browser tools (observe/act/extract/
    // get_text/screenshot/eval and, later, read_screen/save_state/load_state).
    // ONE block, projected from the single source of truth (browser-tool-spec.ts)
    // so the REST surface can't drift from the MCP/passthrough surfaces. Same
    // handler as the SDK chat path; token-gated like import-chrome. Resolves the
    // pane by topic OR terminal session so a Claude Code terminal tab can drive
    // its own near-terminal pane. open-pane/import-chrome keep bespoke blocks
    // above (not in BRIDGED_BROWSER_ENDPOINTS), so this never shadows them.
    {
      const byTopic = matchRoute(pathname, "/api/topics/:id/browser/:tool");
      const bySession = matchRoute(pathname, "/api/sessions/:sessionKey/browser/:tool");
      const m = byTopic || bySession;
      const endpoint = m?.tool;
      const toolName = endpoint ? BRIDGED_BROWSER_ENDPOINTS[endpoint] : undefined;
      if (m && method === "POST" && toolName) {
        const tok = req.headers.get("x-gateway-token") || "";
        if (!process.env.GATEWAY_TOKEN || !timingSafeEqualStr(tok, process.env.GATEWAY_TOKEN)) return json({ error: "unauthorized" }, 401);
        if (!browserService) return json({ error: "Browser service is not enabled in this build" }, 503);
        // Read the body FIRST so an explicit `contextId` override can retarget any
        // live tab (the "manage any tab" capability) — and so a pane-less session
        // can still drive another tab. `contextId` is stripped before dispatch so
        // it never leaks into a tool handler's args.
        const body = ((await readJSON(req)) as Record<string, unknown> | null) ?? {};
        const override = typeof body.contextId === "string" && body.contextId ? body.contextId : null;
        delete body.contextId;
        let contextId: string;
        if (override) {
          // Validate against the live inventory: an unknown contextId would
          // otherwise make getOrCreateContext upsert a phantom headless context.
          const live = collectLiveContextIds(buildTabDeps(browserService));
          if (!live.has(override)) {
            return json({
              error: `unknown contextId '${override}'. Live tabs: ${[...live].join(", ") || "(none)"}. Call browser_list_tabs for the current list.`,
            }, 404);
          }
          contextId = override;
        } else {
          const target = resolveBrowserContext(byTopic, bySession);
          if (!target) return json({ error: "No browser pane bound to this session (open a browser pane first, or pass contextId from browser_list_tabs)" }, 404);
          contextId = target.contextId;
        }
        try {
          const result = await dispatchBrowserToolCallByContext(
            toolName,
            body,
            contextId,
            browserService,
          ) as Record<string, unknown> & { error?: string };
          if (result?.error) return json({ error: result.error }, 502);
          return json(result);
        } catch (e: unknown) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }
    }

    // POST /api/{topics/:id,sessions/:sessionKey}/browser/list-tabs
    // Inventory of EVERY live browser tab (all topics/terminals/windows), not
    // just this session's own — the discovery half of "manage any tab". Bespoke
    // (not in BRIDGED_BROWSER_ENDPOINTS): it's inventory-scoped and needs `isOwn`
    // computed from the caller's own contextId, so it doesn't fit the per-context
    // dispatcher. Token-gated like the bridge (it exposes urls/titles of every
    // pane). A pane-less caller still lists (no 404 on a null own-context).
    {
      const byTopic = matchRoute(pathname, "/api/topics/:id/browser/list-tabs");
      const bySession = matchRoute(pathname, "/api/sessions/:sessionKey/browser/list-tabs");
      if ((byTopic || bySession) && method === "POST") {
        const tok = req.headers.get("x-gateway-token") || "";
        if (!process.env.GATEWAY_TOKEN || !timingSafeEqualStr(tok, process.env.GATEWAY_TOKEN)) return json({ error: "unauthorized" }, 401);
        if (!browserService) return json({ error: "Browser service is not enabled in this build" }, 503);
        const own = resolveBrowserContext(byTopic, bySession)?.contextId ?? null;
        try {
          const tabs = await listBrowserTabs(buildTabDeps(browserService), own);
          return json({ tabs });
        } catch (e: unknown) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }
    }

    // POST /api/{topics/:id,sessions/:sessionKey}/browser/focus-pane
    // Bring a browser tab to the front in whichever window shows it — the
    // management half of "manage any tab". Mirrors close-pane's broadcast path
    // (browser:focus-pane → usePanelLifecycle → useProjectLayout activation);
    // client-originated because tab-activation is device-local UI state. An
    // explicit body.contextId wins (VALIDATED against the live inventory —
    // focusing a dead pane is meaningless); else own via topic/term-<id>.
    {
      const byTopic = matchRoute(pathname, "/api/topics/:id/browser/focus-pane");
      const bySession = matchRoute(pathname, "/api/sessions/:sessionKey/browser/focus-pane");
      if ((byTopic || bySession) && method === "POST") {
        const tok = req.headers.get("x-gateway-token") || "";
        if (!process.env.GATEWAY_TOKEN || !timingSafeEqualStr(tok, process.env.GATEWAY_TOKEN)) return json({ error: "unauthorized" }, 401);
        if (!browserService) return json({ error: "Browser service is not enabled in this build" }, 503);
        const body = (await readJSON(req)) as { contextId?: unknown } | null;
        const override = typeof body?.contextId === "string" && body.contextId ? body.contextId : null;
        let ctxId: string;
        if (override) {
          const live = collectLiveContextIds(buildTabDeps(browserService));
          if (!live.has(override)) {
            return json({
              error: `unknown contextId '${override}'. Live tabs: ${[...live].join(", ") || "(none)"}. Call browser_list_tabs for the current list.`,
            }, 404);
          }
          ctxId = override;
        } else {
          const target = resolveBrowserContext(byTopic, bySession);
          if (!target) return json({ error: "No browser pane bound to this session (pass contextId from browser_list_tabs)" }, 404);
          ctxId = target.contextId;
        }
        broadcastToAll({ type: "browser:focus-pane", contextId: ctxId });
        return json({ ok: true, contextId: ctxId });
      }
    }

    // POST /api/topics/:id/system-message
    {
      const params = matchRoute(pathname, "/api/topics/:id/system-message");
      if (params && method === "POST") {
        const body = await readJSON(req);
        // Guard the TYPE up front: a non-string content would persist via
        // appendLocalMessage + fire the first broadcast, then throw on the
        // `.slice(0, 100)` below → a half-written message plus a 500.
        if (typeof body?.content !== "string" || !body.content) return json({ error: "content (string) required" }, 400);
        const topic = getTopicById(params.id);
        if (!topic) return json({ error: "Topic not found" }, 404);
        const stored = appendLocalMessage(topic.sessionKey, "assistant", body.content);
        broadcastToAll({ type: "message", sessionKey: topic.sessionKey, message: { id: stored.id, role: "assistant", content: body.content, timestamp: stored.timestamp } });
        broadcastToAll({ type: "message:new", topicId: params.id, sessionKey: topic.sessionKey, role: "assistant", messageId: stored.id, content: body.content, preview: body.content.slice(0, 100) });
        updateUnreadCount(params.id);
        return json({ ok: true, message: stored });
      }
    }

    // POST /api/topics/:id/messages/:msgId/plan-status
    {
      const params = matchRoute(pathname, "/api/topics/:id/messages/:msgId/plan-status");
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.status || !['approved', 'rejected'].includes(body.status)) {
          return json({ error: "status must be 'approved' or 'rejected'" }, 400);
        }
        const topic = getTopicById(params.id);
        if (!topic) return json({ error: "Topic not found" }, 404);
        const msg = getMessageById(params.msgId);
        if (!msg) return json({ error: "Message not found" }, 404);
        ctx.db.prepare(`UPDATE messages SET plan_status = ? WHERE id = ?`).run(body.status, params.msgId);
        broadcastToAll({ type: "message:plan-status", topicId: params.id, messageId: params.msgId, planStatus: body.status });
        return json({ ok: true, planStatus: body.status });
      }
    }

    // GET /api/topics/:id/messages - fetch conversation messages for a topic
    {
      const params = matchRoute(pathname, "/api/topics/:id/messages");
      if (params && method === "GET") {
        const topic = getTopicById(params.id);
        if (!topic) return json({ error: "Topic not found" }, 404);

        const urlParams = url.searchParams;
        const limit = parseInt(urlParams.get("limit") || "200");
        const offset = parseInt(urlParams.get("offset") || "0");

        const localMsgs = loadLocalMessages(topic.sessionKey);
        const completeMsgs = localMsgs.filter(m => !m.partial || (m.content && m.content.trim()));
        const total = completeMsgs.length;
        const sliced = offset > 0 ? completeMsgs.slice(0, Math.max(0, total - offset)) : completeMsgs;
        const result = sliced.slice(-limit);

        return json({ messages: result, total, topicName: topic.name });
      }
    }

    // --- Search ---
    if (method === "POST" && pathname === "/api/search") {
      const body = await readJSON(req);
      if (!body || !body.query) return json({ error: "query required" }, 400);
      return json({ results: searchTranscripts(body.query, body.limit || 50) });
    }

    // STT (/api/stt) + TTS (/api/tts) live in server/routes/voice.ts now.

    // --- Context file upload ---
    // /api/context-upload moved to server/routes/media.ts (with the other uploads).

    // --- Test: Seed message (for E2E tests — inserts a message directly into DB) ---
    if (method === "POST" && pathname === "/api/test/seed-message") {
      const body = await readJSON(req);
      if (!body?.sessionKey || !body?.role) {
        return json({ error: "sessionKey and role required" }, 400);
      }
      const id = body.id || crypto.randomUUID();
      const timestamp = body.timestamp || new Date().toISOString();
      const sortOrder = body.sortOrder ?? Date.now();
      try {
        db.prepare(`
          INSERT INTO messages (id, session_key, role, content, thinking, tool_calls, media, partial, streamed_at, plan_status, timestamp, sort_order, parent_id, branch_index, latency_ms, usage_prompt_tokens, usage_completion_tokens, cost_cents)
          VALUES ($id, $session_key, $role, $content, $thinking, $tool_calls, $media, 0, NULL, NULL, $timestamp, $sort_order, $parent_id, $branch_index, $latency_ms, $usage_prompt_tokens, $usage_completion_tokens, $cost_cents)
        `).run({
          $id: id,
          $session_key: body.sessionKey,
          $role: body.role,
          $content: body.content || '',
          $thinking: body.thinking || null,
          $tool_calls: body.toolCalls ? JSON.stringify(body.toolCalls) : null,
          $media: body.media ? JSON.stringify(body.media) : null,
          $timestamp: timestamp,
          $sort_order: sortOrder,
          $parent_id: body.parentId || null,
          // Branch index — defaults to 0 (linear thread). Tests seed sibling
          // branches (same parent, distinct index) to exercise the branch-
          // navigation UI without driving a provider-backed edit.
          $branch_index: typeof body.branchIndex === "number" ? body.branchIndex : 0,
          // Slice 7 — optional per-message footer fields. Tests use these to
          // exercise the MessageMetaFooter without driving a real provider.
          $latency_ms: typeof body.latencyMs === "number" ? body.latencyMs : null,
          $usage_prompt_tokens: typeof body.usagePromptTokens === "number" ? body.usagePromptTokens : null,
          $usage_completion_tokens: typeof body.usageCompletionTokens === "number" ? body.usageCompletionTokens : null,
          $cost_cents: typeof body.costCents === "number" ? body.costCents : null,
        });
        return json({ ok: true, id });
      } catch (err: any) {
        return json({ error: "Seed failed: " + err.message }, 500);
      }
    }

    // --- Chat proxy (streaming) ---
    // --- Chat streaming --- (handler extracted to server/routes/chat.ts)
    {
      const chatResp = await chatRouter(req, url, pathname, method);
      if (chatResp) return chatResp;
    }

    // --- Abort streaming ---
    if (method === "POST" && pathname === "/api/chat/abort") {
      const body = await readJSON(req);
      const sessionKey = body?.sessionKey;
      if (!sessionKey) return json({ error: "sessionKey required" }, 400);

      const stream = activeStreams.get(sessionKey);
      if (!stream) return json({ ok: false, reason: "no_active_stream" });

      // Abort the gateway request (HTTP fallback)
      if (stream.abortController) {
        try { stream.abortController.abort(); } catch {}
      }

      // Resolve topic and provider for abort — O(1) UNIQUE-index lookup
      // instead of a full topics scan per /api/chat/abort hit.
      const abortTopic = getTopicBySessionKey(sessionKey);
      const topicId: string | undefined = abortTopic?.id;
      const abortProvider = resolveProvider(abortTopic);

      // Also abort via provider if connected
      if (abortProvider.connected) {
        abortProvider.abort?.(sessionKey)?.catch((err: any) => console.warn(`[Abort] Provider abort failed:`, err));
        abortProvider.unregisterStreamHandler?.(sessionKey);
      }

      // `clearMessages` is the client's hint that this was a brand-new chat
      // whose first message was canceled before the AI could reply, so the
      // chat itself can be discarded. The client computes this from its own
      // in-memory state — which is empty during initial load, after WS
      // reconnect, and after a hot-reload race. Trusting the client here
      // would let `saveLocalMessages([])` wipe entire conversation histories
      // when the client guess is wrong. We re-derive the decision from the
      // DB authoritative copy via `shouldHonorClearMessages` (see
      // `abortClearPolicy.ts` for the rationale and the matching client-side
      // guard in `stopSessionPolicy.ts`).
      let clearedForReal = false;
      if (body?.clearMessages) {
        const stored = loadLocalMessages(sessionKey);
        const decision = shouldHonorClearMessages(stored);
        if (decision.shouldWipe) {
          saveLocalMessages(sessionKey, []);
          clearedForReal = true;
        } else {
          console.warn(
            `[Abort] Ignored clearMessages=true for ${sessionKey} — DB has ${decision.userCount} user / ${decision.assistantCount} assistant messages, not first-message`
          );
          // Fall through to the normal finalize path so we don't lose the
          // partial assistant content the user was about to abort.
          updateLastMessage(sessionKey, { content: stream.content, thinking: stream.thinking || undefined, partial: undefined, streamedAt: undefined });
        }
      } else {
        // Finalize whatever content we have
        updateLastMessage(sessionKey, { content: stream.content, thinking: stream.thinking || undefined, partial: undefined, streamedAt: undefined });
      }

      endStream(sessionKey);
      // user_abort: user explicitly clicked stop — they are present in the tab,
      // so we intentionally do NOT increment unread count. This is a design
      // choice, not an omission.
      broadcastToAll({ type: "stream:end", sessionKey, topicId, reason: "user_abort" });

      return json({ ok: true, cleared: clearedForReal });
    }

    // --- Tool response (resume a paused AskUserQuestion / MCP elicitation) ---
    //
    // Companion endpoint to the `onUserInputRequired` callback wired into
    // the stream handler above. The provider has paused the turn waiting
    // for a `tool_result` block on its stdin; we validate the submission
    // against the still-pending request on its side, persist the user's
    // answer onto the assistant message's tool_calls blob (so the
    // exchange survives reload), and ask the provider to inject the
    // result. Status transitions waiting_for_input → running; the next
    // `tool_result` from the CLI will flip it to success/error normally.
    if (method === "POST" && pathname === "/api/chat/tool-response") {
      const body = await readJSON(req);
      const sessionKey = body?.sessionKey;
      const toolCallId = body?.toolCallId;
      const response = body?.response;
      if (!sessionKey || !toolCallId || !response || typeof response.kind !== 'string') {
        return errorResponse(400, "sessionKey, toolCallId, and response{kind,...} required");
      }
      // Provider lookup mirrors abort: O(1) by sessionKey instead of a topics scan.
      const topic = getTopicBySessionKey(sessionKey);
      const provider = resolveProvider(topic);
      if (!provider.connected || !provider.resumeWithToolResponse) {
        // Fail the tool fast — the route never leaves a waiting_for_input
        // status orphaned on the row.
        const errMsg = provider.resumeWithToolResponse
          ? `provider ${provider.name} is not connected`
          : `provider ${provider.name} does not support user input`;
        updateToolCallFields(sessionKey, toolCallId, {
          status: 'error',
          error: errMsg,
        });
        broadcastToAll({
          type: 'stream:tool_result',
          sessionKey,
          topicId: topic?.id,
          toolCallId,
          status: 'error',
          error: errMsg,
        });
        return errorResponse(503, errMsg);
      }

      const submittedAt = new Date().toISOString();
      // Normalize the payload — accept partial shapes from the client so
      // a forgetful caller (no `submittedAt`) still gets a record we can
      // persist and replay.
      const normalised =
        response.kind === 'questions'
          ? {
              kind: 'questions' as const,
              answers: (response.answers || {}) as Record<string, string>,
              metadata: response.metadata as Record<string, unknown> | undefined,
              submittedAt,
            }
          : response.kind === 'elicitation'
            ? { kind: 'elicitation' as const, value: response.value, submittedAt }
            : response.kind === 'raw'
              ? { kind: 'raw' as const, text: String(response.text ?? ''), submittedAt }
              : null;
      if (!normalised) {
        return errorResponse(400, `unsupported response kind: ${String(response.kind)}`);
      }

      try {
        await provider.resumeWithToolResponse(sessionKey, toolCallId, normalised);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        // Provider rejected (no pending input, process dead, stdin write
        // failed). Flag the tool as errored so the UI unblocks; the next
        // user turn can retry from scratch.
        updateToolCallFields(sessionKey, toolCallId, {
          status: 'error',
          error: msg,
        });
        broadcastToAll({
          type: 'stream:tool_result',
          sessionKey,
          topicId: topic?.id,
          toolCallId,
          status: 'error',
          error: msg,
        });
        // 404 specifically for "no pending input" so the client can show
        // a friendly "this question was already answered" toast.
        const status = /no pending input/i.test(msg) ? 404 : 502;
        return errorResponse(status, msg);
      }

      updateToolCallFields(sessionKey, toolCallId, {
        status: 'running',
        userResponse: normalised,
      });
      broadcastToAll({
        type: 'stream:tool_update',
        sessionKey,
        topicId: topic?.id,
        toolCallId,
        // No partialResult — this is just a status transition. The next
        // tool_result event will carry the actual content from the model.
      });

      return json({ ok: true, submittedAt });
    }

    // --- Edit message --- (handler extracted to server/routes/edit.ts)
    {
      const editResp = await editRouter(req, url, pathname, method);
      if (editResp) return editResp;
    }

    // Switch-branch (POST /api/messages/:id/switch-branch) lives in server/routes/branches.ts now.

    // --- History --- (handler extracted to server/routes/history.ts)
    {
      const historyResp = await historyRouter(req, url, pathname, method);
      if (historyResp) return historyResp;
    }

    // --- Media serving ---
    // Media serving + uploads (/api/media, /api/upload, /api/upload-image,
    // /api/context-upload, DELETE /api/context-file) live in server/routes/media.ts now.

    // --- Auto-name --- (handler extracted to server/routes/autoname.ts)
    {
      const autoNameResp = await autoNameRouter(req, url, pathname, method);
      if (autoNameResp) return autoNameResp;
    }

    // --- Slash commands ---
    if (method === "POST" && pathname === "/api/command") {
      const body = await readJSON(req);
      if (!body?.command || !body?.sessionKey) return json({ error: "command and sessionKey required" }, 400);
      const { command, sessionKey, args } = body;
      try {
        switch (command) {
          case "status": {
            const messages = loadLocalMessages(sessionKey);
            const topic = getTopicBySessionKey(sessionKey);
            const output = [`📍 Session: ${sessionKey}`, `💬 Messages: ${messages.length}`, topic?.projectPath ? `📁 Project: ${topic.projectPath}` : null, topic?.name ? `📝 Topic: ${topic.name}` : null].filter(Boolean).join('\n');
            return json({ ok: true, command: "status", output });
          }
          case "clear": {
            const existingMsgs = loadLocalMessages(sessionKey);
            if (existingMsgs.length > 0) {
              const backupDir = join(ctx.BASE_DIR, "backups");
              try { mkdirSync(backupDir, { recursive: true }); const timestamp = new Date().toISOString().replace(/[:.]/g, "-"); const backupFile = join(backupDir, `${sessionKey.replace(/[^a-zA-Z0-9]/g, "_")}_${timestamp}.json`); writeFileSync(backupFile, JSON.stringify(existingMsgs, null, 2)); console.log(`[clear] Backed up ${existingMsgs.length} messages to ${backupFile}`); } catch (err) { console.warn("[clear] Backup failed:", err); }
            }
            saveLocalMessages(sessionKey, []);
            try { await providerForSessionKey(sessionKey).sendToSession?.(sessionKey, "/clear"); } catch (err) { console.warn("Failed to clear gateway session:", err); }
            broadcastToAll({ type: "clear", sessionKey });
            return json({ ok: true, command: "clear", message: "Conversation cleared" });
          }
          case "model": {
            const modelName = args?.model;
            if (!modelName) return json({ error: "model name required" }, 400);
            if (providerForSessionKey(sessionKey).name === 'openclaw') {
              const resp = await fetch(`${GATEWAY_URL}/api/inference/chat`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}`, "x-openclaw-scopes": "operator.read,operator.write" }, body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: `/model ${modelName}` }] }) });
              if (!resp.ok) return json({ error: "Failed to set model" }, 500);
              return json({ ok: true, command: "model", model: modelName, message: `Model set to: ${modelName}` });
            }
            // claude-code (and any respawn provider): the model is a spawn-time
            // `--model` flag. Persist it per-topic and drop the idle pooled
            // process so the next turn respawns with it — same path as PATCH
            // /api/topics/:id. (Previously this returned a hard 400.)
            const topic = getTopicBySessionKey(sessionKey);
            if (!topic) return json({ error: "No topic found for this session" }, 404);
            const prevModel = topic.model ?? null;
            topic.model = String(modelName).trim() || null;
            topic.updatedAt = new Date().toISOString();
            saveSingleTopic(topic);
            broadcastToAll({ type: "topic:updated", topic });
            if ((topic.model ?? null) !== prevModel) {
              try { resolveProvider(topic).refreshSessionConfig?.(topic.sessionKey); }
              catch (err) { console.warn(`[command] refreshSessionConfig (model) failed:`, err); }
            }
            return json({ ok: true, command: "model", model: topic.model, message: `Modello impostato: ${topic.model} — attivo dal prossimo turno.` });
          }
          case "effort": {
            // Per-topic reasoning-effort tier for claude-code (spawn-time
            // `--effort`). openclaw has no effort tier → route through /reasoning.
            const tier = String(args?.level || args?.effort || "").trim().toLowerCase();
            const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
            if (providerForSessionKey(sessionKey).name === 'openclaw') {
              return json({ error: "L'effort non si applica a questo provider — usa /reasoning." }, 400);
            }
            if (!tier || !VALID_EFFORTS.has(tier)) {
              return json({ error: "Uso: /effort <low|medium|high|xhigh|max>" }, 400);
            }
            const topic = getTopicBySessionKey(sessionKey);
            if (!topic) return json({ error: "No topic found for this session" }, 404);
            const prevEffort = topic.effort ?? null;
            topic.effort = tier;
            topic.updatedAt = new Date().toISOString();
            saveSingleTopic(topic);
            broadcastToAll({ type: "topic:updated", topic });
            if ((topic.effort ?? null) !== prevEffort) {
              try { resolveProvider(topic).refreshSessionConfig?.(topic.sessionKey); }
              catch (err) { console.warn(`[command] refreshSessionConfig (effort) failed:`, err); }
            }
            return json({ ok: true, command: "effort", level: tier, message: `Effort impostato: ${tier} — attivo dal prossimo turno.` });
          }
          case "reasoning": {
            const level = args?.level || "on";
            if (providerForSessionKey(sessionKey).name === 'openclaw') {
              const resp = await fetch(`${GATEWAY_URL}/api/inference/chat`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}`, "x-openclaw-scopes": "operator.read,operator.write" }, body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: `/reasoning ${level}` }] }) });
              if (!resp.ok) return json({ error: "Failed to toggle reasoning" }, 500);
              const text = await resp.text();
              return json({ ok: true, command: "reasoning", level, message: `Reasoning set to: ${level}`, output: text });
            }
            // claude-code has no on/off reasoning toggle — it has an effort tier.
            // Point the user at /effort instead of the old hard 400.
            return json({ ok: true, command: "reasoning", message: "Su claude-code il ragionamento si regola con l'effort: usa /effort <low|medium|high|xhigh|max>." });
          }
          case "project": {
            const sub = args?.sub || "info"; // create | open | info
            const value = (args?.value || "").trim();
            const topic = getTopicBySessionKey(sessionKey);
            if (!topic) return json({ error: "No topic found for this session" }, 404);

            if (sub === "create") {
              if (!value) return json({ error: "/project create <name> requires a project name" }, 400);
              const safeName = value.replace(/[^a-zA-Z0-9_-]/g, "");
              if (!safeName) return json({ error: "Invalid project name (only letters, digits, _ and - allowed)" }, 400);
              const targetDir = join(WORKSPACE_DIR, safeName);
              if (existsSync(targetDir)) return json({ error: `Project "${safeName}" already exists at ${targetDir}` }, 409);
              try {
                mkdirSync(targetDir, { recursive: true });
                writeFileSync(join(targetDir, "CLAUDE.md"), `# ${safeName}\n`);
              } catch (err: any) {
                return json({ error: `Failed to create project: ${err.message}` }, 500);
              }
              bindTopicToProject(topic.id, targetDir, { focus: true });
              return json({ ok: true, command: "project", sub: "create", path: targetDir, output: `📁 Created project "${safeName}" at ${targetDir} and bound it to this topic.` });
            }

            if (sub === "open") {
              if (!value) return json({ error: "/project open <name-or-path> requires a target" }, 400);
              const targetDir = resolveProjectRef(value, { trustRawPaths: true });
              if (!targetDir) {
                return json({ error: `Project not found: ${value}` }, 404);
              }
              bindTopicToProject(topic.id, targetDir, { focus: true });
              return json({ ok: true, command: "project", sub: "open", path: targetDir, output: `📁 Opened project at ${targetDir} and bound it to this topic.` });
            }

            // info (no args): show current binding + list workspace projects
            const lines: string[] = [];
            if (topic.projectPath) {
              lines.push(`📍 Current project: ${topic.projectPath}`);
            } else {
              lines.push("📍 No project bound to this topic.");
            }
            const wsProjects = getWorkspaceProjects();
            if (wsProjects.length > 0) {
              lines.push("", "🗂 Workspace projects:");
              for (const p of wsProjects.slice(0, 20)) {
                const name = p.split("/").pop() || p;
                lines.push(`  • ${name}  —  ${p}`);
              }
              if (wsProjects.length > 20) lines.push(`  …and ${wsProjects.length - 20} more`);
            }
            return json({ ok: true, command: "project", sub: "info", output: lines.join("\n") });
          }
          default: return json({ error: `Unknown command: ${command}` }, 400);
        }
      } catch (err: any) { return json({ error: `Command failed: ${err.message}` }, 500); }
    }

    // Remote-access tunnel endpoints (/api/remote/*) live in server/routes/remote.ts now.

    // --- Processes API ---
    if (method === "GET" && pathname === "/api/processes") {
      const topicId = url.searchParams.get("topicId");
      if (!topicId) return json({ error: "topicId parameter required" }, 400);
      try {
        const procProvider = resolveProvider(getTopicById(topicId));
        let result: any;
        if (procProvider.listSessions) {
          result = await procProvider.listSessions({ kinds: ["other"], activeMinutes: 30 });
        } else if (procProvider.invokeTool) {
          result = await procProvider.invokeTool("sessions_list", { kinds: ["other"], activeMinutes: 30 });
        } else {
          return json([]);
        }
        const sessions = result?.result?.sessions || [];
        const processes = sessions.filter((s: any) => s.sessionKey?.includes("subagent")).map((s: any) => ({ sessionKey: s.sessionKey, label: s.label || s.sessionKey.split(":").pop() || "Sub-agent", status: s.status === "active" ? "running" : "done", startedAt: s.createdAt || new Date().toISOString(), completedAt: s.status !== "active" ? (s.updatedAt || new Date().toISOString()) : undefined }));
        return json(processes);
      } catch { return json([]); }
    }

    {
      const params = matchRoute(pathname, "/api/topics/:topicId/project-id");
      if (params && method === "GET") {
        const projectId = getProjectIdForTopic(params.topicId);
        if (!projectId) return json({ error: "Topic has no project" }, 400);
        return json({ projectId });
      }
    }

    // --- Open project (broadcast to UI) ---
    if (method === "POST" && pathname === "/api/open-project") {
      try {
        const body = await req.json();
        const rawPath = body?.path;
        if (!rawPath || typeof rawPath !== "string") {
          return json({ error: "path is required" }, 400);
        }
        const projectPath = resolve(rawPath);
        if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
          return json({ error: "Directory does not exist" }, 404);
        }
        broadcastToAll({ type: "open-project", projectPath });
        return json({ ok: true, projectPath });
      } catch (e: any) {
        return errorResponse(500, e instanceof Error ? e.message : String(e));
      }
    }

    return null;
  };
}
