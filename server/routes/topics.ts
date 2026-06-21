import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import type { AppContext, RouteHandler, Topic } from "../types";
import { getProvider, getDefaultProvider, type AIProvider } from "../providers";
import { createAutoNameRouter } from "./autoname";
import { createHistoryRouter } from "./history";
import { createEditRouter } from "./edit";
import { createChatRouter } from "./chat";
// computeCleanBroadcastDelta now lives in ./stream-markers (with the slow-stream
// annotation helpers); re-exported here so routes/topics-marker-strip.test.ts —
// which imports it from this module — keeps working unchanged.
export { computeCleanBroadcastDelta } from "./stream-markers";
import type { BrowserService } from "../browser-service";
import { dispatchBrowserToolCall } from "../browser-tool-dispatcher";
import { getTerminalSessionById } from "./terminal";
import { matchProjectRef, type ProjectRefCandidate } from "../lib/project-ref";
import { CLOSED_MARKER_REGEX, OPEN_MARKER_TAIL_REGEX } from "../lib/markers";
import { shouldHonorClearMessages } from "./abortClearPolicy";


/**
 * Internal markers emitted inline by LLMs in their response stream to trigger
 * side-effects in topics-app (open the browser pane, switch topic, create or
 * open a project). They are detected on the accumulated `fullContent` by
 * `detectAndBroadcastBrowserMarker` / `detectAndBroadcastTopicSwitch` /
 * `detectAndHandleProjectMarkers` (defined inside `createTopicsRouter`) and
 * stripped before persisting or broadcasting.
 *
 * `CLOSED_MARKER_REGEX` matches a fully-formed marker `{{NAME:body}}` anywhere
 * in a string — used to strip persisted state and chunk broadcasts.
 *
 * `OPEN_MARKER_TAIL_REGEX` matches a marker that has opened but not yet closed
 * at end-of-string (`...{{NAME:partial-body`). It defends against the
 * chunk-split case: when delta N contains `…{{BROWSER:https://exa` and
 * delta N+1 contains `mple.com}}`, the closed match on `fullContent` fires
 * correctly once N+1 arrives, but the delta N broadcast would otherwise leak
 * `{{BROWSER:https://exa` to the client. Stripping with this regex hides the
 * fragment until the close arrives. Marker dispatch is unchanged — only the
 * visible leak is suppressed.
 *
 * Going beyond this with state (e.g. delta-from-cumulative-clean accounting)
 * is intentional: see `WS-based chat` handler below for the
 * `lastBroadcastClean` accumulator that closes the remaining gap where a
 * single delta carries `{{...}} tail` (close + post-marker text in the same
 * chunk).
 *
 * The grammar itself now lives in `server/lib/markers.ts` (the single source
 * of truth, shared with the history pipelines and mirrored by the client).
 * Re-exported here so callers importing from this route module — notably
 * `topics-marker-strip.test.ts` — keep working unchanged.
 */
export { CLOSED_MARKER_REGEX, OPEN_MARKER_TAIL_REGEX };

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
    GATEWAY_URL, GATEWAY_TOKEN, MESSAGES_DIR, OPENCLAW_DIR,
    broadcastToAll, broadcast, isTopicFocused,
    loadTopics, saveTopics, saveSingleTopic, deleteTopicById,
    getTopicById, getTopicBySessionKey,
    loadUnread, saveUnread,
    loadLocalMessages, saveLocalMessages, appendLocalMessage,
    createPartialMessage, updateLastMessage, addToolCallToLastMessage, updateToolCallResult, updateToolCallFields,
    startStream, updateStreamActivity, updateStreamContent, endStream, isStreaming,
    readJSON, json, matchRoute, errorResponse, slugify,
    resolveProjectPath, resolveTopicCwd, findNewMediaFiles, updateLastMessageWithMedia,
    searchTranscripts, getMessagesPath,
    getMessageById,
    activeStreams,
    worktreeStore,
    projectStore,
  } = ctx;

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

  // ── Sub-agent completion polling via JSONL transcript ──────────────────
  // Gateway executes tool calls (including sessions_spawn) internally and
  // writes completion events as user messages with "[Internal task completion event]"
  // to the parent session's JSONL transcript. We poll that file for new events.
  interface WatchedSession {
    topicId: string;
    sessionKey: string;      // e.g. "topic:d1428015"
    jsonlPath: string;       // path to the JSONL transcript file
    lastLineCount: number;   // lines already processed
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
        const content = readFileSync(watched.jsonlPath, 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        if (lines.length <= watched.lastLineCount) continue; // no new lines

        // Check new lines for completion events
        const newLines = lines.slice(watched.lastLineCount);
        watched.lastLineCount = lines.length;

        for (const line of newLines) {
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
    const lineCount = jsonlPath && existsSync(jsonlPath)
      ? readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean).length
      : 0;
    watchedSessions.set(sessionKey, {
      topicId, sessionKey, jsonlPath, lastLineCount: lineCount,
      createdAt: Date.now(), deliveredEvents: new Set(),
    });
    console.log(`[SubagentPoll] Watching ${sessionKey} for sub-agent completions (JSONL: ${jsonlPath ? 'found' : 'pending'}, lines: ${lineCount})`);
    startSubagentPolling();
  }

  // Track which topics already had a browser navigate this session to avoid duplicate triggers
  const browserNavigatedTopics = new Set<string>();

  // Phase 30 BROWSER-CHAT-03 — OpenClaw browser bridge removed; agent now
  // controls the browser via 5 native tools at /api/browsers/:id/agent/*.
  // The legacy per-request targetId memoization Map (used by the deleted
  // bridge handler) was deleted alongside the bridge block.

  function detectAndBroadcastBrowserMarker(content: string, topic: Topic | null): string {
    if (!topic) return content;

    // 1. Check for explicit {{BROWSER:url}} markers (highest priority).
    //    Cheap substring guard before the regex scan — runs on every text
    //    delta, so we skip the full-content regex unless the marker is present.
    const browserMatch = content.includes('{{BROWSER:')
      ? content.match(/\{\{BROWSER:(.*?)\}\}/)
      : null;
    if (browserMatch) {
      let browserUrl = browserMatch[1];
      if (browserUrl.startsWith("file:///")) {
        browserUrl = `http://localhost:${process.env.PORT || 3333}/preview/${browserUrl.slice(8)}`;
      } else if (!browserUrl.startsWith("http")) {
        // Phase A: prefer worktree.absPath when topic is bound to a ready
        // worktree; fall back to legacy projectPath for unbound topics.
        const projectDir = resolveTopicCwd(topic);
        if (projectDir) browserUrl = `http://localhost:${process.env.PORT || 3333}/preview${join(projectDir, browserUrl)}`;
      }
      console.log(`[Browser] Auto-navigate via marker: ${browserUrl}`);
      broadcastToAll({ type: "browser:navigate", topicId: topic.id, url: browserUrl });
      browserNavigatedTopics.add(topic.id);
      return content.replace(/\{\{BROWSER:.*?\}\}/g, '');
    }

    // 2. Fallback: detect localhost:PORT URLs in response (only once per topic per stream)
    //    Matches http://localhost:PORT, https://localhost:PORT, or bare localhost:PORT.
    //    Cheap substring guard before the regex (the pattern always requires the
    //    literal "localhost:") so we don't rescan every delta for nothing.
    if (!browserNavigatedTopics.has(topic.id) && content.includes('localhost:')) {
      const localhostMatch = content.match(/(?:https?:\/\/)?localhost:(\d{4,5})\b/);
      if (localhostMatch) {
        const port = parseInt(localhostMatch[1]);
        const appPort = parseInt(process.env.PORT || "3333");
        if (port !== appPort && port >= 3000 && port <= 65535) {
          const browserUrl = localhostMatch[0].startsWith("http") ? localhostMatch[0] : `http://${localhostMatch[0]}`;
          console.log(`[Browser] Auto-navigate via localhost detection: ${browserUrl}`);
          broadcastToAll({ type: "browser:navigate", topicId: topic.id, url: browserUrl });
          browserNavigatedTopics.add(topic.id);
        }
      }
    }

    return content;
  }

  function buildTopicDirectory(currentTopicId: string): string {
    const data = loadTopics();
    const lines: string[] = [];
    for (const t of Object.values(data.topics)) {
      if (t.id === currentTopicId || t.archived) continue;
      const project = t.projectPath ? ` (project: ${t.projectPath.split('/').pop()})` : '';
      lines.push(`- [id:${t.id}] ${t.name}${project}`);
    }
    return lines.join('\n');
  }

  function detectAndBroadcastTopicSwitch(content: string, currentTopic: Topic | null): { content: string; switchedToTopicId: string | null } {
    if (!currentTopic) return { content, switchedToTopicId: null };

    // Check for TOPIC_NEW first (create a new topic on the fly)
    const newMatch = content.match(/\{\{TOPIC_NEW:([^}]+)\}\}/);
    if (newMatch) {
      const topicName = newMatch[1].trim();
      if (topicName) {
        const data = loadTopics();
        const id = crypto.randomUUID();
        const slug = slugify(topicName);
        const newTopic: Topic = {
          id, name: topicName, slug, parentId: null, links: [],
          sessionKey: "topic:" + id.slice(0, 8), color: "#5865f2", icon: "MessageSquare",
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          archived: false, systemPrompt: "",
          contextFiles: [], pinnedMessages: [],
          sortOrder: Object.keys(data.topics).length,
        };
        // Inherit projectPath from current topic if it has one
        if (currentTopic.projectPath) {
          (newTopic as any).projectPath = currentTopic.projectPath;
        }
        data.topics[id] = newTopic;
        // Targeted single-topic write — no diff against in-memory snapshot,
        // so a sibling request that just created its own topic isn't trampled.
        saveSingleTopic(newTopic);
        broadcastToAll({ type: "topic:created", topic: newTopic });
        console.log(`[TopicSwitch] Created new topic "${topicName}" and switching from "${currentTopic.name}"`);
        broadcastToAll({ type: 'topic:switch', fromTopicId: currentTopic.id, fromSessionKey: currentTopic.sessionKey, toTopicId: newTopic.id, toSessionKey: newTopic.sessionKey });
        const cleaned = content.replace(/\{\{TOPIC_NEW:[^}]+\}\}/g, '');
        return { content: cleaned, switchedToTopicId: newTopic.id };
      }
    }

    // Check for TOPIC_SWITCH (switch to existing topic)
    const match = content.match(/\{\{TOPIC_SWITCH:([\w-]+)\}\}/);
    if (!match) return { content, switchedToTopicId: null };
    const targetId = match[1];
    const target = getTopicById(targetId);
    if (!target || target.archived) {
      return { content: content.replace(/\{\{TOPIC_SWITCH:[\w-]+\}\}/g, ''), switchedToTopicId: null };
    }
    console.log(`[TopicSwitch] Switching from "${currentTopic.name}" to "${target.name}"`);
    broadcastToAll({ type: 'topic:switch', fromTopicId: currentTopic.id, fromSessionKey: currentTopic.sessionKey, toTopicId: target.id, toSessionKey: target.sessionKey });
    return { content: content.replace(/\{\{TOPIC_SWITCH:[\w-]+\}\}/g, ''), switchedToTopicId: target.id };
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
    for (const t of Object.values(loadTopics().topics)) {
      const pp = (t as any).projectPath as string | undefined;
      if (pp) candidates.push({ path: pp });
    }
    for (const p of getWorkspaceProjects()) candidates.push({ path: p });

    // Compare candidate slugs with the SAME slugify that produced them (the
    // store's), so "My App" matches a project stored as slug "my-app".
    const matched = matchProjectRef(raw, candidates, (s) => projectStore.slugify(s));
    if (matched && isExistingDir(matched)) return matched;

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
   * Detect {{PROJECT_CREATE:name}} and {{PROJECT_OPEN:path}} markers in AI responses.
   * Creates or binds projects, opens them as project windows (nesting the
   * current session), and strips markers from content.
   */
  function detectAndHandleProjectMarkers(content: string, currentTopic: Topic | null): string {
    if (!currentTopic) return content;

    // {{PROJECT_CREATE:name}} — scaffold a workspace dir, then open + nest.
    const createMatch = content.match(/\{\{PROJECT_CREATE:([^}]+)\}\}/);
    if (createMatch) {
      const rawName = createMatch[1].trim();
      const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, "");
      if (safeName) {
        const targetDir = join(WORKSPACE_DIR, safeName);
        if (!existsSync(targetDir)) {
          mkdirSync(targetDir, { recursive: true });
          writeFileSync(join(targetDir, "CLAUDE.md"), `# ${safeName}\n`);
          console.log(`[ProjectMarker] Created project "${safeName}" at ${targetDir}`);
        }
        bindTopicToProject(currentTopic.id, targetDir, { focus: true });
      }
      content = content.replace(/\{\{PROJECT_CREATE:[^}]+\}\}/g, "");
    }

    // {{PROJECT_OPEN:name-or-path}} — resolve against the user's real Topics
    // projects (not just the workspace), then open + nest the session.
    const openMatch = content.match(/\{\{PROJECT_OPEN:([^}]+)\}\}/);
    if (openMatch) {
      const targetDir = resolveProjectRef(openMatch[1]);
      if (targetDir) {
        bindTopicToProject(currentTopic.id, targetDir, { focus: true });
        console.log(`[ProjectMarker] Opened project at ${targetDir}`);
      } else {
        console.log(`[ProjectMarker] Could not resolve PROJECT_OPEN ref: ${openMatch[1].trim()}`);
      }
      content = content.replace(/\{\{PROJECT_OPEN:[^}]+\}\}/g, "");
    }

    return content;
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
          // Check for at least one project marker
          const dir = join(WORKSPACE_DIR, e.name);
          return PROJECT_MARKERS.some(m => existsSync(join(dir, m)));
        })
        .map(e => join(WORKSPACE_DIR, e.name));
    } catch { return []; }
  }

  // Auto-naming endpoint extracted to its own router; it needs two closure
  // helpers injected (they close over this scope), so it's instantiated here.
  const autoNameRouter = createAutoNameRouter(ctx, { resolveProvider, detectProjectPathFromMessages });
  const historyRouter = createHistoryRouter(ctx, { matchHistoryRoute, providerForSessionKey });
  const editRouter = createEditRouter(ctx, { resolveProvider, updateUnreadCount });
  const chatRouter = createChatRouter(ctx, {
    resolveProvider, detectAndBroadcastBrowserMarker, detectAndBroadcastTopicSwitch,
    detectAndHandleProjectMarkers, bindTopicToProject, resolveProjectRef,
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
      if (!body || !body.name) return json({ error: "name required" }, 400);
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
        if (body.name) { topic.name = body.name; topic.slug = slugify(body.name); }
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
        if (body.provider !== undefined) topic.provider = body.provider || null;
        if (body.model !== undefined) topic.model = body.model || null;
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
            broadcastToAll({ type: "browser:open-near-pane", paneId: `terminal:${term.id}`, url });
            return json({ url, title: "" });
          }
        }
        if (!topic) return json({ error: "Topic not found" }, 404);

        const body = (await readJSON(req)) as { url?: unknown } | null;
        const url = typeof body?.url === "string" ? body.url : "";
        if (!url) return json({ error: "url (string) is required" }, 400);

        try {
          const result = await dispatchBrowserToolCall(
            "browser_open",
            { url },
            topic,
            browserService,
          ) as { url?: string; title?: string; error?: string };
          if (result?.error) return json({ error: result.error }, 502);
          const resolvedUrl = typeof result?.url === "string" ? result.url : url;
          broadcastToAll({ type: "browser:navigate", topicId: topic.id, url: resolvedUrl });
          browserNavigatedTopics.add(topic.id);
          return json({ url: resolvedUrl, title: result?.title ?? "" });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return json({ error: msg }, 500);
        }
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
        const paneId = `terminal:${term.id}`;

        // djb2 — MUST match client projectHash() in
        // client/src/state/pane/adapters/projectLayoutSync.ts so the membership
        // key lines up with what the renderer reads.
        const projectHash = (p: string): string => {
          let h = 0;
          for (let i = 0; i < p.length; i++) { h = p.charCodeAt(i) + ((h << 5) - h); h = h & h; }
          return Math.abs(h).toString(36);
        };
        const membershipKey = `topics-project-panes-${projectHash(dir)}`;
        const APP_KEY = "pane-store-v2";

        const readUi = (key: string): Record<string, unknown> | null => {
          const row = db.query("SELECT value FROM ui_state WHERE key = ?").get(key) as { value?: string } | undefined;
          if (!row?.value) return null;
          try { return JSON.parse(row.value) as Record<string, unknown>; } catch { return null; }
        };
        const writes: Array<{ key: string; value: unknown }> = [];

        // 1. Splice the pane out of the app-level standalone store, capturing its
        //    full pane object so the project membership carries the same shape.
        let paneObj: Record<string, unknown> | null = null;
        const app = readUi(APP_KEY);
        if (app) {
          const panes = app.panes as Record<string, Record<string, unknown>> | undefined;
          if (panes && panes[paneId]) {
            const { scrollOffset: _drop, ...rest } = panes[paneId];
            paneObj = rest;
            delete panes[paneId];
          }
          const groups = app.groups as Record<string, { paneIds?: string[] }> | undefined;
          if (groups) {
            for (const g of Object.values(groups)) {
              if (g && Array.isArray(g.paneIds)) g.paneIds = g.paneIds.filter((x) => x !== paneId);
            }
          }
          writes.push({ key: APP_KEY, value: app });
        }

        // 2. Add the pane to the project's server-synced membership (idempotent).
        const mem = (readUi(membershipKey) as { nonChatPanes?: unknown[]; openChatTopicIds?: unknown[] } | null)
          || { nonChatPanes: [], openChatTopicIds: [] };
        if (!Array.isArray(mem.nonChatPanes)) mem.nonChatPanes = [];
        if (!Array.isArray(mem.openChatTopicIds)) mem.openChatTopicIds = [];
        if (!mem.nonChatPanes.some((p) => (p as { id?: string })?.id === paneId)) {
          mem.nonChatPanes.push(paneObj || { id: paneId, type: "terminal", title: term.name || "Claude Code", preview: false, terminalType: "claude-code" });
        }
        writes.push({ key: membershipKey, value: mem });

        // 3. Persist with fresh monotonic server_seq each (BEGIN IMMEDIATE so two
        //    writers can't collide on seq — same rule as the ui-state PUT route),
        //    then broadcast each so live clients converge.
        const stamped = db.transaction(() => {
          const out: Array<{ key: string; value: unknown; seq: number }> = [];
          for (const w of writes) {
            const { maxSeq } = db.query("SELECT COALESCE(MAX(server_seq), 0) AS maxSeq FROM ui_state").get() as { maxSeq: number };
            const seq = maxSeq + 1;
            db.run(
              `INSERT INTO ui_state (key, value, payload_version, server_seq, updated_at)
               VALUES (?, ?, 2, ?, datetime('now'))
               ON CONFLICT(key) DO UPDATE SET
                 value = excluded.value, payload_version = 2,
                 server_seq = excluded.server_seq, updated_at = datetime('now')`,
              [w.key, JSON.stringify(w.value), seq],
            );
            out.push({ key: w.key, value: w.value, seq });
          }
          return out;
        }).immediate() as Array<{ key: string; value: unknown; seq: number }>;

        for (const s of stamped) {
          broadcastToAll({ type: "ui-state:updated", key: s.key, value: s.value, payload_version: 2, server_seq: s.seq });
        }
        broadcastToAll({ type: "open-project", projectPath: dir });
        return json({ ok: true, paneId, projectPath: dir, membershipKey });
      }
    }

    // POST /api/topics/:id/browser/import-chrome
    // POST /api/sessions/:sessionKey/browser/import-chrome
    //
    // MCP bridge for the `import_chrome` tool (claude-code CLI sessions): seed the
    // topic's native browser pane with the user's real Chrome cookies. Same handler
    // as the SDK chat tool path (dispatchBrowserToolCall -> handleBrowserImportChrome),
    // which requires the Electron native pane (CDP). Needs a real topic pane, so
    // (unlike open-pane) there is no terminal-session fallback.
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
        if (!process.env.GATEWAY_TOKEN || tok !== process.env.GATEWAY_TOKEN) {
          return json({ error: "unauthorized" }, 401);
        }
        if (!browserService) {
          return json({ error: "Browser service is not enabled in this build" }, 503);
        }
        let topic: Topic | null = null;
        if (byTopic) topic = getTopicById(byTopic.id);
        else if (bySession) topic = getTopicBySessionKey(decodeURIComponent(bySession.sessionKey));
        if (!topic) return json({ error: "Topic not found (import-chrome needs an open topic browser pane)" }, 404);

        const body = (await readJSON(req)) as { domains?: unknown; profile?: unknown; dry_run?: unknown } | null;
        const domains = Array.isArray(body?.domains) ? body.domains.map(String) : [];
        const profile = typeof body?.profile === "string" ? body.profile : undefined;
        const dryRun = !!body?.dry_run;
        try {
          const result = await dispatchBrowserToolCall(
            "browser_import_chrome",
            { domains, profile, dry_run: dryRun },
            topic,
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

    // POST /api/{topics/:id,sessions/:sessionKey}/browser/observe
    // MCP bridge: read the pane's actionable elements (a11y + indexed elements)
    // so an MCP-driven (claude-code) session can click/type, not just navigate.
    // Same handler as the SDK chat path. Token-gated like import-chrome.
    {
      const byTopic = matchRoute(pathname, "/api/topics/:id/browser/observe");
      const bySession = matchRoute(pathname, "/api/sessions/:sessionKey/browser/observe");
      if ((byTopic || bySession) && method === "POST") {
        const tok = req.headers.get("x-gateway-token") || "";
        if (!process.env.GATEWAY_TOKEN || tok !== process.env.GATEWAY_TOKEN) return json({ error: "unauthorized" }, 401);
        if (!browserService) return json({ error: "Browser service is not enabled in this build" }, 503);
        let topic: Topic | null = null;
        if (byTopic) topic = getTopicById(byTopic.id);
        else if (bySession) topic = getTopicBySessionKey(decodeURIComponent(bySession.sessionKey));
        if (!topic) return json({ error: "Topic not found (open a browser pane first)" }, 404);
        const body = (await readJSON(req)) as { max_elements?: unknown } | null;
        const max_elements = typeof body?.max_elements === "number" ? body.max_elements : undefined;
        try {
          const result = await dispatchBrowserToolCall("browser_observe", { max_elements }, topic, browserService) as Record<string, unknown> & { error?: string };
          if (result?.error) return json({ error: result.error }, 502);
          // Drop the heavy base64 screenshot — the user sees the pane; the agent
          // acts via the element list. Keeps the MCP response token-light.
          const { screenshot_annotated, ...lean } = result;
          return json(lean);
        } catch (e: unknown) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }
    }

    // POST /api/{topics/:id,sessions/:sessionKey}/browser/act
    // MCP bridge: click/type/select an element by id from the latest observe.
    {
      const byTopic = matchRoute(pathname, "/api/topics/:id/browser/act");
      const bySession = matchRoute(pathname, "/api/sessions/:sessionKey/browser/act");
      if ((byTopic || bySession) && method === "POST") {
        const tok = req.headers.get("x-gateway-token") || "";
        if (!process.env.GATEWAY_TOKEN || tok !== process.env.GATEWAY_TOKEN) return json({ error: "unauthorized" }, 401);
        if (!browserService) return json({ error: "Browser service is not enabled in this build" }, 503);
        let topic: Topic | null = null;
        if (byTopic) topic = getTopicById(byTopic.id);
        else if (bySession) topic = getTopicBySessionKey(decodeURIComponent(bySession.sessionKey));
        if (!topic) return json({ error: "Topic not found (open a browser pane first)" }, 404);
        const body = (await readJSON(req)) as { element_id?: unknown; action?: unknown; text?: unknown } | null;
        try {
          const result = await dispatchBrowserToolCall(
            "browser_act",
            { element_id: body?.element_id, action: body?.action, text: body?.text },
            topic,
            browserService,
          ) as Record<string, unknown> & { error?: string };
          if (result?.error) return json({ error: result.error }, 502);
          return json(result);
        } catch (e: unknown) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }
    }

    // POST /api/topics/:id/system-message
    {
      const params = matchRoute(pathname, "/api/topics/:id/system-message");
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.content) return json({ error: "content required" }, 400);
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
          VALUES ($id, $session_key, $role, $content, $thinking, $tool_calls, $media, 0, NULL, NULL, $timestamp, $sort_order, $parent_id, 0, $latency_ms, $usage_prompt_tokens, $usage_completion_tokens, $cost_cents)
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
            if (providerForSessionKey(sessionKey).name !== 'openclaw') return json({ error: "Model switching not supported by this provider" }, 400);
            const resp = await fetch(`${GATEWAY_URL}/api/inference/chat`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}`, "x-openclaw-scopes": "operator.read,operator.write" }, body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: `/model ${modelName}` }] }) });
            if (!resp.ok) return json({ error: "Failed to set model" }, 500);
            return json({ ok: true, command: "model", model: modelName, message: `Model set to: ${modelName}` });
          }
          case "reasoning": {
            const level = args?.level || "on";
            if (providerForSessionKey(sessionKey).name !== 'openclaw') return json({ error: "Reasoning toggle not supported by this provider" }, 400);
            const resp = await fetch(`${GATEWAY_URL}/api/inference/chat`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}`, "x-openclaw-scopes": "operator.read,operator.write" }, body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: `/reasoning ${level}` }] }) });
            if (!resp.ok) return json({ error: "Failed to toggle reasoning" }, 500);
            const text = await resp.text();
            return json({ ok: true, command: "reasoning", level, message: `Reasoning set to: ${level}`, output: text });
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
