import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import type { AppContext, ContentBlock, RouteHandler, StoredMessage, ToolCall, Topic } from "../types";
import { getProvider, getDefaultProvider, type AIProvider, type ChatMessage, type StreamHandler } from "../providers";
import { deriveToolDetail } from "../providers/claude/tool-detail";
import { getSnapshotManager } from "../providers/snapshot-manager";
import { appendUsageRecord } from "../usage/store";
import { loadMemoryForTopic } from "./memory";
import { calculateCost } from "../usage/pricing";
import { parseMentions, resolveMentions } from "../mention-parser";
import type { BrowserService } from "../browser-service";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { browserTools } from "../browser-tools";
import { isPassthroughProvider } from "../browser-tools-adapters";
import { dispatchBrowserToolCall } from "../browser-tool-dispatcher";
import { buildProviderHistory } from "../utils/build-provider-history";
import {
  adaptEnvelope,
  assembleTopicContext,
  composeSystemMessages,
  getProviderStrategy,
  pushSnapshot,
  type ContextEnvelope,
} from "../context";
import {
  logStreamSoftTimeout,
  logStreamHardTimeout,
  logStreamComplete,
  logStreamAborted,
  logStreamError,
  logStreamRecovered,
} from "../db/activity-log";

/**
 * Marker appended to a partial assistant message when the soft inactivity
 * timeout fires but we are still listening for the provider to recover.
 * Visible to the client so the user knows we noticed the slowness, but
 * intentionally NOT a hard "[Response timed out]" — the stream may still
 * resume during the grace period.
 *
 * The leading `\n\n---\n*` and trailing `*` brackets are how we round-trip:
 * `addSlowAnnotation()` appends, `stripSlowAnnotation()` removes by suffix
 * match, with no risk of clobbering legitimate content. Keep the entire
 * substring stable — modifying it requires updating both helpers.
 */
const STREAM_SLOW_ANNOTATION = "\n\n---\n*[⏱ stream lento — il provider è ancora connesso]*";

function stripSlowAnnotation(content: string): string {
  if (!content.endsWith(STREAM_SLOW_ANNOTATION)) return content;
  return content.slice(0, -STREAM_SLOW_ANNOTATION.length);
}

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
        if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.openChatTopicIds)) continue;
        if (!parsed.openChatTopicIds.includes(topicId)) continue;
        parsed.openChatTopicIds = parsed.openChatTopicIds.filter((id: string) => id !== topicId);
        if (parsed.activeChatTopicId === topicId) delete parsed.activeChatTopicId;
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
          row.key, next, nextSeq,
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
    GATEWAY_URL, GATEWAY_TOKEN, UPLOADS_DIR, CONTEXT_DIR, SESSIONS_DIR, MESSAGES_DIR, OPENCLAW_DIR,
    broadcastToAll, broadcast, isTopicFocused,
    loadTopics, saveTopics, saveSingleTopic, deleteTopicById,
    getTopicById, getTopicBySessionKey,
    loadUnread, saveUnread,
    loadLocalMessages, saveLocalMessages, appendLocalMessage,
    createPartialMessage, updateLastMessage, addToolCallToLastMessage, updateToolCallResult,
    startStream, updateStreamActivity, updateStreamContent, getStreamContent, endStream, isStreaming,
    readJSON, json, matchRoute, errorResponse, slugify,
    resolveProjectPath, resolveTopicCwd, findNewMediaFiles, updateLastMessageWithMedia,
    searchTranscripts, getMessagesPath,
    ALLOWED_UPLOAD_MIMES,
    getMessageById, getMessageSessionKey, createBranchMessage, createBranchPartialMessage,
    switchActiveBranch, getSiblingMessages, loadActiveThread,
    activeStreams,
    worktreeStore,
  } = ctx;

  /** Resolve the AI provider for a topic. Uses topic.provider if set, else default. */
  function resolveProvider(topic?: Topic | null): AIProvider {
    if (topic?.provider) {
      try { return getProvider(topic.provider); } catch {}
    }
    return getDefaultProvider();
  }

  /** Look up the topic owning a sessionKey and resolve its provider. */
  function providerForSessionKey(sessionKey: string): AIProvider {
    const topic = Object.values(loadTopics().topics).find(t => t.sessionKey === sessionKey);
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
    const topic = loadTopics().topics[watched.topicId];
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

    // 1. Check for explicit {{BROWSER:url}} markers (highest priority)
    const browserMatch = content.match(/\{\{BROWSER:(.*?)\}\}/);
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
    //    Matches http://localhost:PORT, https://localhost:PORT, or bare localhost:PORT
    if (!browserNavigatedTopics.has(topic.id)) {
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
        broadcastToAll({ type: 'topic:switch', fromTopicId: currentTopic.id, toTopicId: newTopic.id, toSessionKey: newTopic.sessionKey });
        const cleaned = content.replace(/\{\{TOPIC_NEW:[^}]+\}\}/g, '');
        return { content: cleaned, switchedToTopicId: newTopic.id };
      }
    }

    // Check for TOPIC_SWITCH (switch to existing topic)
    const match = content.match(/\{\{TOPIC_SWITCH:([\w-]+)\}\}/);
    if (!match) return { content, switchedToTopicId: null };
    const targetId = match[1];
    const data = loadTopics();
    const target = data.topics[targetId];
    if (!target || target.archived) {
      return { content: content.replace(/\{\{TOPIC_SWITCH:[\w-]+\}\}/g, ''), switchedToTopicId: null };
    }
    console.log(`[TopicSwitch] Switching from "${currentTopic.name}" to "${target.name}"`);
    broadcastToAll({ type: 'topic:switch', fromTopicId: currentTopic.id, toTopicId: target.id, toSessionKey: target.sessionKey });
    return { content: content.replace(/\{\{TOPIC_SWITCH:[\w-]+\}\}/g, ''), switchedToTopicId: target.id };
  }

  /**
   * Detect {{PROJECT_CREATE:name}} and {{PROJECT_OPEN:path}} markers in AI responses.
   * Creates or binds projects and strips markers from content.
   */
  function detectAndHandleProjectMarkers(content: string, currentTopic: Topic | null): string {
    if (!currentTopic) return content;

    // {{PROJECT_CREATE:name}}
    const createMatch = content.match(/\{\{PROJECT_CREATE:([^}]+)\}\}/);
    if (createMatch) {
      const rawName = createMatch[1].trim();
      const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, "");
      if (safeName) {
        const targetDir = join(WORKSPACE_DIR, safeName);
        if (!existsSync(targetDir)) {
          mkdirSync(targetDir, { recursive: true });
          writeFileSync(join(targetDir, "CLAUDE.md"), `# ${safeName}\n`);
          const t = getTopicById(currentTopic.id);
          if (t) {
            t.projectPath = targetDir;
            t.updatedAt = new Date().toISOString();
            saveSingleTopic(t);
            broadcastToAll({ type: "topic:updated", topic: t });
          }
          console.log(`[ProjectMarker] Created project "${safeName}" at ${targetDir}`);
        }
      }
      content = content.replace(/\{\{PROJECT_CREATE:[^}]+\}\}/g, "");
    }

    // {{PROJECT_OPEN:path}}
    const openMatch = content.match(/\{\{PROJECT_OPEN:([^}]+)\}\}/);
    if (openMatch) {
      let targetDir = openMatch[1].trim();
      if (targetDir.startsWith("~/")) {
        targetDir = join(homedir(), targetDir.slice(2));
      } else if (!targetDir.startsWith("/")) {
        // Look up by name in workspace
        const wsProjects = getWorkspaceProjects();
        const found = wsProjects.find(p => p.endsWith("/" + targetDir));
        targetDir = found || join(WORKSPACE_DIR, targetDir);
      }
      if (existsSync(targetDir) && statSync(targetDir).isDirectory()) {
        const t = getTopicById(currentTopic.id);
        if (t) {
          t.projectPath = targetDir;
          t.updatedAt = new Date().toISOString();
          saveSingleTopic(t);
          broadcastToAll({ type: "topic:updated", topic: t });
        }
        console.log(`[ProjectMarker] Opened project at ${targetDir}`);
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
        t.projectPath = detected;
        t.updatedAt = new Date().toISOString();
        saveSingleTopic(t);
        broadcastToAll({ type: "topic:updated", topic: t });
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
  async function streamEditResponse(sessionKey: string, newUserMsgId: string, userContent: string): Promise<Response> {
    // O(1) lookup via UNIQUE index on session_key — replaces a full-table
    // scan that paid for every queued edit-stream.
    const matchedTopic = getTopicBySessionKey(sessionKey);
    const topicProvider = resolveProvider(matchedTopic);

    // Build the messages array from the active thread up to (and including) the new user message
    const activeThread = loadActiveThread(sessionKey);
    const finalMessages: { role: string; content: string }[] = activeThread.map(m => ({
      role: m.role,
      content: m.content,
    }));

    // Add system messages (system prompt, context files, etc.)
    if (matchedTopic) {
      const disabled = matchedTopic.disabledContextSources || [];
      const isSourceEnabled = (id: string) => !disabled.includes(id);
      if (matchedTopic.systemPrompt && isSourceEnabled("prompt:system")) {
        finalMessages.unshift({ role: "system", content: matchedTopic.systemPrompt });
      }
      if (matchedTopic.contextFiles && matchedTopic.contextFiles.length > 0) {
        const contextParts: string[] = [];
        for (const filePath of matchedTopic.contextFiles) {
          if (!isSourceEnabled(`file:${filePath}`)) continue;
          if (existsSync(filePath)) {
            try {
              const content = readFileSync(filePath, "utf-8");
              const fileName = filePath.split("/").pop() || filePath;
              contextParts.push(`--- File: ${fileName} ---\n${content}`);
            } catch {}
          }
        }
        if (contextParts.length > 0) {
          const insertIdx = (matchedTopic.systemPrompt && isSourceEnabled("prompt:system")) ? 1 : 0;
          finalMessages.splice(insertIdx, 0, { role: "system", content: `Context files for this topic:\n\n${contextParts.join("\n\n")}` });
        }
      }
      // Phase A: prefer the bound worktree's directory for template auto-
      // loading (CLAUDE.md, README.md, …). Falls back to projectPath for
      // unbound (legacy) topics. The system-message label still cites the
      // project's logical path so the agent's mental model stays project-
      // centric, not worktree-centric.
      {
        const projectDir = resolveTopicCwd(matchedTopic);
        const projectLabel = matchedTopic.projectPath || projectDir || null;
        if (projectDir && existsSync(projectDir)) {
          const TEMPLATE_FILES = ["CLAUDE.md", "README.md", ".cursorrules", "AGENTS.md"];
          const templateParts: string[] = [];
          for (const name of TEMPLATE_FILES) {
            let filePath = join(projectDir, name);
            if (!existsSync(filePath) && name === "CLAUDE.md") {
              const altPath = join(projectDir, ".claude", "CLAUDE.md");
              if (existsSync(altPath)) filePath = altPath;
            }
            if (existsSync(filePath)) {
              try { templateParts.push(`--- Project file: ${name} ---\n${readFileSync(filePath, "utf-8")}`); } catch {}
            }
          }
          if (templateParts.length > 0 && projectLabel) {
            const insertIdx = finalMessages.findIndex(m => m.role !== "system");
            finalMessages.splice(insertIdx >= 0 ? insertIdx : finalMessages.length, 0, {
              role: "system", content: `Project context files (from ${projectLabel}):\n\n${templateParts.join("\n\n")}`,
            });
          }
        }
      }
    }

    try {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 300000);

      let resp: Response;
      if (topicProvider.streamHTTP) {
        resp = await topicProvider.streamHTTP(finalMessages, { sessionKey, signal: abortController.signal });
      } else {
        // Fallback: use complete() and synthesize an SSE response
        const result = await topicProvider.complete(finalMessages);
        clearTimeout(timeoutId);
        const storedAssistant = appendLocalMessage(sessionKey, "assistant", result.content);
        if (matchedTopic) broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: storedAssistant.id, content: result.content, preview: result.content.slice(0, 100) });
        const ssePayload = `data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(result.content)}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
        return new Response(ssePayload, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
      }
      clearTimeout(timeoutId);

      if (!resp.ok) {
        const text = await resp.text();
        return new Response(text, { status: resp.status, headers: { "Content-Type": "application/json" } });
      }

      // Create partial assistant message as child of the new user message
      const partialMsg = createBranchPartialMessage(sessionKey, newUserMsgId);
      startStream(sessionKey, partialMsg.id, abortController);
      broadcastToAll({ type: "stream:start", sessionKey, topicId: matchedTopic?.id, messageId: partialMsg.id });

      const originalBody = resp.body!;
      let fullContent = "";
      let fullThinking = "";
      let isInThinking = false;
      let chunkCount = 0;
      let lastSaveChunk = 0;
      const SAVE_INTERVAL = 10;

      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      let clientDisconnected = false;

      const forwardToClient = async (chunk: Uint8Array) => {
        if (clientDisconnected) return;
        try { await writer.write(chunk); } catch { clientDisconnected = true; }
      };
      const closeClient = async () => {
        if (clientDisconnected) return;
        try { await writer.close(); } catch { clientDisconnected = true; }
      };

      const processLine = (line: string) => {
        if (!line.startsWith("data: ")) return;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          updateLastMessage(sessionKey, { content: fullContent, thinking: fullThinking || undefined, partial: undefined, streamedAt: undefined });
          endStream(sessionKey);
          if (matchedTopic) {
            broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: partialMsg.id });
            updateUnreadCount(matchedTopic.id);
          }
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            const content = delta.content;
            if (content.includes('<thinking>')) { isInThinking = true; broadcastToAll({ type: "stream:thinking_start", sessionKey, topicId: matchedTopic?.id }); }
            if (content.includes('</thinking>')) { isInThinking = false; broadcastToAll({ type: "stream:thinking_end", sessionKey, topicId: matchedTopic?.id }); }
            if (isInThinking) {
              const cleaned = content.replace(/<\/?thinking>/g, '');
              fullThinking += cleaned;
              broadcastToAll({ type: "stream:thinking_chunk", sessionKey, topicId: matchedTopic?.id, content: cleaned });
            } else {
              const cleaned = content.replace(/<\/?thinking>/g, '');
              if (cleaned) {
                fullContent += cleaned;
                broadcastToAll({ type: "stream:content_chunk", sessionKey, topicId: matchedTopic?.id, content: cleaned });
              }
            }
            chunkCount++;
            updateStreamContent(sessionKey, fullContent, fullThinking);
            if (chunkCount - lastSaveChunk >= SAVE_INTERVAL) {
              lastSaveChunk = chunkCount;
              updateLastMessage(sessionKey, { content: fullContent, thinking: fullThinking || undefined });
            }
          }
        } catch {}
      };

      const consumeGateway = async () => {
        const reader = originalBody.getReader();
        const onAbort = () => reader.cancel();
        abortController.signal.addEventListener("abort", onAbort, { once: true });
        const decoder = new TextDecoder();
        let sseBuffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await forwardToClient(value);
            sseBuffer += decoder.decode(value, { stream: true });
            const lines = sseBuffer.split("\n");
            sseBuffer = lines.pop() || "";
            for (const line of lines) processLine(line);
          }
          if (sseBuffer.trim()) processLine(sseBuffer);
        } catch (err) {
          console.warn(`[Stream:Edit] Gateway read error for ${sessionKey}:`, err);
        } finally {
          abortController.signal.removeEventListener("abort", onAbort);
          reader.releaseLock();
          await closeClient();
          if (isStreaming(sessionKey)) {
            updateLastMessage(sessionKey, { content: fullContent, thinking: fullThinking || undefined, partial: undefined, streamedAt: undefined });
            endStream(sessionKey);
            broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic?.id, messageId: partialMsg.id });
            if (matchedTopic) updateUnreadCount(matchedTopic.id);
          }
        }
      };

      consumeGateway().catch(err => console.error('[consumeGateway:edit] error:', err));

      return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
    } catch (err: any) {
      if (err.name === "AbortError") return json({ error: "Request timeout" }, 504);
      return json({ error: "Gateway unreachable: " + err.message }, 502);
    }
  }

  // --- Tasks helpers (SQLite-backed) ---
  const { db } = ctx;

  function loadTasks(projectId: string): any[] {
    const rows = db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY kanban_order ASC").all(projectId) as any[];
    return rows.map(r => ({
      id: r.id, text: r.text, description: r.description || null,
      status: r.status, priority: r.priority, kanbanOrder: r.kanban_order,
      assignedTo: r.assigned_to || null, dueDate: r.due_date || null,
      chatId: r.chat_id || null, createdAt: r.created_at, completedAt: r.completed_at || null,
      updatedAt: r.updated_at,
    }));
  }

  function saveTask(projectId: string, task: any) {
    db.prepare(`
      INSERT OR REPLACE INTO tasks (id, project_id, text, description, status, priority, kanban_order, assigned_to, due_date, chat_id, created_at, completed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, projectId, task.text, task.description || null,
      task.status, task.priority ?? 2, task.kanbanOrder ?? 0,
      task.assignedTo || null, task.dueDate || null, task.chatId || null,
      task.createdAt, task.completedAt || null, task.updatedAt || new Date().toISOString()
    );
  }

  function getProjectIdForTopic(topicId: string): string | null {
    const data = loadTopics();
    const topic = data.topics[topicId];
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

    // PATCH /api/topics/:id
    {
      const params = matchRoute(pathname, "/api/topics/:id");
      if (params && method === "PATCH") {
        const body = await readJSON(req);
        if (!body) return json({ error: "body required" }, 400);
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

    // POST /api/topics/:id/system-message
    {
      const params = matchRoute(pathname, "/api/topics/:id/system-message");
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.content) return json({ error: "content required" }, 400);
        const data = loadTopics();
        const topic = data.topics[params.id];
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
        const data = loadTopics();
        const topic = data.topics[params.id];
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
        const data = loadTopics();
        const topic = data.topics[params.id];
        if (!topic) return json({ error: "Topic not found" }, 404);

        const urlParams = new URL(req.url, `http://localhost`).searchParams;
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

    // --- STT ---
    if (method === "POST" && pathname === "/api/stt") {
      try {
        const formData = await req.formData();
        const audioFile = formData.get("audio");
        if (!audioFile || typeof audioFile === "string") return json({ error: "audio file required" }, 400);
        const ts = Date.now();
        const tempWebm = `/tmp/stt-${ts}.webm`;
        const tempWav = `/tmp/stt-${ts}.wav`;
        const buffer = await (audioFile as File).arrayBuffer();
        writeFileSync(tempWebm, Buffer.from(buffer));
        const ffmpeg = Bun.spawnSync(["ffmpeg", "-i", tempWebm, "-ar", "16000", "-ac", "1", tempWav, "-y"], { timeout: 30000, stdout: "pipe", stderr: "pipe" });
        if (ffmpeg.exitCode !== 0) throw new Error(`ffmpeg conversion failed: ${ffmpeg.stderr.toString()}`);
        const whisper = Bun.spawnSync(["whisper-cli", "-m", "/Users/user/whisper-models/ggml-large-v3.bin", "-l", "it", "-f", tempWav, "--no-timestamps"], { timeout: 60000, stdout: "pipe", stderr: "pipe" });
        if (whisper.exitCode !== 0) throw new Error(`Whisper failed: ${whisper.stderr.toString()}`);
        const transcript = whisper.stdout.toString().split("\n").filter((line: string) => !line.match(/^(whisper|ggml|system|main):/i) && line.trim()).join(" ").trim();
        try { unlinkSync(tempWebm); } catch {}
        try { unlinkSync(tempWav); } catch {}
        return json({ transcript });
      } catch (err: any) {
        console.error("STT error:", err);
        return json({ error: "STT failed: " + err.message }, 500);
      }
    }

    // --- TTS ---
    if (method === "POST" && pathname === "/api/tts") {
      const body = await readJSON(req);
      if (!body?.text) return json({ error: "text required" }, 400);
      if (!process.env.ELEVENLABS_API_KEY) return json({ error: "ELEVENLABS_API_KEY not configured" }, 500);
      try {
        const voiceId = body.voiceId || "iP95p4xoKVk53GoZ742B";
        const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "xi-api-key": process.env.ELEVENLABS_API_KEY || "" },
          body: JSON.stringify({ text: body.text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true } }),
        });
        if (!resp.ok) { const errText = await resp.text(); return json({ error: "TTS failed: " + errText }, 502); }
        const audioBuffer = await resp.arrayBuffer();
        return new Response(audioBuffer, { headers: { "Content-Type": "audio/mpeg", "Content-Length": audioBuffer.byteLength.toString() } });
      } catch (err: any) { return json({ error: "TTS error: " + err.message }, 500); }
    }

    // --- Context file upload ---
    if (method === "POST" && pathname === "/api/context-upload") {
      try {
        const formData = await req.formData();
        const file = formData.get("file");
        const topicId = formData.get("topicId") as string;
        if (!file || typeof file === "string") return json({ error: "file required" }, 400);
        if (!topicId) return json({ error: "topicId required" }, 400);
        const fileType = (file as File).type;
        if (!ALLOWED_UPLOAD_MIMES.has(fileType)) return json({ error: `File type not allowed: ${fileType}. Allowed types: text, documents, images, audio.` }, 400);
        const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;
        if ((file as File).size > MAX_UPLOAD_SIZE) return json({ error: "File too large. Maximum size is 10MB." }, 400);
        const topicDir = join(CONTEXT_DIR, topicId);
        mkdirSync(topicDir, { recursive: true });
        const safeName = (file as File).name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const filename = `${Date.now()}-${safeName}`;
        const filepath = join(topicDir, filename);
        const buffer = await (file as File).arrayBuffer();
        writeFileSync(filepath, Buffer.from(buffer));
        const topic = getTopicById(topicId);
        if (topic) {
          if (!topic.contextFiles) topic.contextFiles = [];
          topic.contextFiles.push(filepath);
          topic.updatedAt = new Date().toISOString();
          saveSingleTopic(topic);
        }
        return json({ path: filepath, filename: (file as File).name, size: (file as File).size });
      } catch (err: any) { return json({ error: "Upload failed: " + err.message }, 500); }
    }

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
    if (method === "POST" && pathname === "/api/chat") {
      console.log(`[HTTP] POST /api/chat received`);
      const body = await readJSON(req);
      if (!body) return json({ error: "body required" }, 400);
      // Reset browser navigate tracking for this topic so new URLs can trigger
      const topicsForReset = loadTopics();
      for (const t of Object.values(topicsForReset.topics)) {
        if (t.sessionKey === body.sessionKey) { browserNavigatedTopics.delete(t.id); break; }
      }
      const sessionKey = body.sessionKey;
      const planMode = body.planMode === true;
      const messages = body.messages;
      if (!messages || !Array.isArray(messages) || messages.length === 0) return json({ error: "messages array required" }, 400);

      // O(1) UNIQUE-index lookup — replaces a full topics scan per chat send.
      const matchedTopic = getTopicBySessionKey(sessionKey);

      const lastUserMsg = messages[messages.length - 1];
      if (lastUserMsg?.role === "user" && lastUserMsg?.content) {
        const storedUserMsg = appendLocalMessage(sessionKey, "user", lastUserMsg.content);
        if (matchedTopic) {
          broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "user", messageId: storedUserMsg.id, content: lastUserMsg.content, preview: lastUserMsg.content.slice(0, 100) });
        }

        // Parse and store mentions from user message
        try {
          const mentions = parseMentions(lastUserMsg.content);
          if (mentions.length > 0) {
            const resolved = resolveMentions(db, mentions);
            const insertMention = db.prepare(
              "INSERT INTO mentions (message_id, session_key, mentioned_entity, entity_type, created_at) VALUES (?, ?, ?, ?, ?)"
            );
            const now = new Date().toISOString();
            for (const m of resolved) {
              insertMention.run(storedUserMsg.id, sessionKey, m.entity, m.entityType, now);
            }
          }
        } catch (err) {
          console.warn("[Mentions] Failed to parse/store mentions:", err);
        }

        // Handle board chat control commands (/ prefixed)
        if (lastUserMsg.content.trim().startsWith("/")) {
          const cmdText = lastUserMsg.content.trim();
          const cmdMatch = cmdText.match(/^\/(\w+)\s*(.*)/);
          if (cmdMatch) {
            const [, cmd, rest] = cmdMatch;
            let response: string | null = null;

            try {
              if (cmd === "pause") {
                const agentName = rest.replace(/^@/, "").trim();
                if (agentName) {
                  const agent = db.prepare("SELECT id FROM agent_profiles WHERE LOWER(name) = LOWER(?)").get(agentName) as any;
                  if (agent) {
                    const session = db.prepare("SELECT session_key FROM agent_sessions WHERE agent_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1").get(agent.id) as any;
                    if (session) {
                      try {
                        const p = resolveProvider(matchedTopic);
                        if (p.pauseSession) {
                          await p.pauseSession(session.session_key);
                        } else {
                          throw new Error("Provider does not support pause");
                        }
                        response = `Paused agent @${agentName}`;
                      } catch { response = `Failed to pause @${agentName} — no reachable session`; }
                    } else { response = `No active session found for @${agentName}`; }
                  } else { response = `Agent "${agentName}" not found`; }
                }
              } else if (cmd === "resume") {
                const agentName = rest.replace(/^@/, "").trim();
                if (agentName) {
                  const agent = db.prepare("SELECT id FROM agent_profiles WHERE LOWER(name) = LOWER(?)").get(agentName) as any;
                  if (agent) {
                    const session = db.prepare("SELECT session_key FROM agent_sessions WHERE agent_id = ? AND status = 'paused' ORDER BY started_at DESC LIMIT 1").get(agent.id) as any;
                    if (session) {
                      try {
                        const p = resolveProvider(matchedTopic);
                        if (p.resumeSession) {
                          await p.resumeSession(session.session_key);
                        } else {
                          throw new Error("Provider does not support resume");
                        }
                        response = `Resumed agent @${agentName}`;
                      } catch { response = `Failed to resume @${agentName} — no reachable session`; }
                    } else { response = `No paused session found for @${agentName}`; }
                  } else { response = `Agent "${agentName}" not found`; }
                }
              } else if (cmd === "agents") {
                const rows = db.prepare("SELECT name, role, avatar_emoji, status FROM agent_profiles ORDER BY name ASC").all() as any[];
                if (rows.length === 0) {
                  response = "No agent profiles configured.";
                } else {
                  const lines = rows.map((r: any) => `${r.avatar_emoji} **${r.name}** — ${r.role} (${r.status})`);
                  response = `**Agent Profiles**\n\n${lines.join("\n")}`;
                }
              } else if (cmd === "assign") {
                const assignMatch = rest.match(/^@(\S+)\s+(.+)/);
                if (assignMatch) {
                  const [, agentName, taskText] = assignMatch;
                  const agent = db.prepare("SELECT id FROM agent_profiles WHERE LOWER(name) = LOWER(?)").get(agentName) as any;
                  if (agent) {
                    // Find project ID for this topic to create a task
                    const projectId = matchedTopic ? getProjectIdForTopic(matchedTopic.id) : null;
                    if (projectId) {
                      const maxRow = db.prepare("SELECT COALESCE(MAX(kanban_order), 0) as m FROM tasks WHERE project_id = ?").get(projectId) as any;
                      const now = new Date().toISOString();
                      const taskId = crypto.randomUUID();
                      db.prepare(`INSERT INTO tasks (id, project_id, text, status, priority, kanban_order, assigned_to, created_at, updated_at) VALUES (?, ?, ?, 'todo', 2, ?, ?, ?, ?)`).run(
                        taskId, projectId, taskText, (maxRow?.m ?? 0) + 1, agentName, now, now
                      );
                      response = `Created task and assigned to @${agentName}: "${taskText}"`;
                    } else {
                      response = `Cannot assign task — topic has no project. Set a project path first.`;
                    }
                  } else { response = `Agent "${agentName}" not found`; }
                }
              } else if (cmd === "project") {
                const subMatch = rest.match(/^(\w+)\s*(.*)/);
                const sub = subMatch ? subMatch[1] : "";
                const arg = subMatch ? subMatch[2].trim() : "";

                if (sub === "create" && arg) {
                  // Sanitize name: only alphanumeric, hyphens, underscores
                  const safeName = arg.replace(/[^a-zA-Z0-9_-]/g, "");
                  if (!safeName) {
                    response = `Invalid project name. Use alphanumeric characters, hyphens, and underscores.`;
                  } else {
                    const targetDir = join(WORKSPACE_DIR, safeName);
                    if (existsSync(targetDir)) {
                      response = `Project **${safeName}** already exists at \`${targetDir}\`. Use \`/project open ${safeName}\` to bind it.`;
                    } else {
                      mkdirSync(targetDir, { recursive: true });
                      writeFileSync(join(targetDir, "CLAUDE.md"), `# ${safeName}\n`);
                      // Bind to current topic
                      if (matchedTopic) {
                        const t = getTopicById(matchedTopic.id);
                        if (t) {
                          t.projectPath = targetDir;
                          t.updatedAt = new Date().toISOString();
                          saveSingleTopic(t);
                          broadcastToAll({ type: "topic:updated", topic: t });
                        }
                      }
                      response = `Created project **${safeName}** at \`${targetDir}\` and bound to this topic.`;
                    }
                  }
                } else if (sub === "open" && arg) {
                  // Resolve path: absolute, ~/, or workspace name
                  let targetDir = arg;
                  if (targetDir.startsWith("~/")) {
                    targetDir = join(homedir(), targetDir.slice(2));
                  } else if (!targetDir.startsWith("/")) {
                    // Look up by name in workspace
                    const wsProjects = getWorkspaceProjects();
                    const found = wsProjects.find(p => p.endsWith("/" + arg));
                    targetDir = found || join(WORKSPACE_DIR, arg);
                  }
                  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
                    response = `Directory not found: \`${targetDir}\``;
                  } else {
                    const projectName = targetDir.split("/").pop() || arg;
                    if (matchedTopic) {
                      const t = getTopicById(matchedTopic.id);
                      if (t) {
                        t.projectPath = targetDir;
                        t.updatedAt = new Date().toISOString();
                        saveSingleTopic(t);
                        broadcastToAll({ type: "topic:updated", topic: t });
                      }
                    }
                    response = `Opened project **${projectName}** — bound to this topic.`;
                  }
                } else {
                  // No subcommand: show current + list
                  const lines: string[] = [];
                  if (matchedTopic?.projectPath) {
                    lines.push(`**Current project:** \`${matchedTopic.projectPath}\``);
                  } else {
                    lines.push("No project bound to this topic.");
                  }
                  const wsProjects = getWorkspaceProjects();
                  if (wsProjects.length > 0) {
                    lines.push("", "**Workspace projects:**");
                    for (const p of wsProjects) {
                      const name = p.split("/").pop();
                      lines.push(`- \`${name}\` — ${p}`);
                    }
                  }
                  response = lines.join("\n");
                }
              }
            } catch (err: any) {
              console.warn("[ChatCommand] Error handling command:", err);
              response = `Command error: ${err.message}`;
            }

            // If a command produced a response, inject it as a synthetic assistant message
            if (response) {
              const storedCmdMsg = appendLocalMessage(sessionKey, "assistant", response);
              if (matchedTopic) {
                broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: storedCmdMsg.id, content: response, preview: response.slice(0, 100) });
              }
              // Return the response as an SSE payload so the client displays it
              const ssePayload = `data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(response)}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
              return new Response(ssePayload, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
            }
          }
        }
      }

      // ─── Canonical context envelope ─────────────────────────────────
      // Replaces the inline finalMessages assembly that used to live here
      // (≈140 lines of category-aware splice() calls). The envelope is the
      // single source of truth for what the model will see — both the
      // `streamEditResponse` send path AND the inspector preview consume
      // it via `assembleTopicContext`.
      //
      // Provider-specific shaping (history vs inline preamble) happens
      // later via `adaptEnvelope`, after we resolve the actual provider.
      // For now we use a placeholder strategy; the *system block contents*
      // and *history* are strategy-independent so the FS reads happen once.
      //
      // `includeLastUserInHistory: false` — the new user turn (just persisted
      // by appendLocalMessage above) is passed separately via
      // `payload.userContent`, not duplicated inside `payload.history`.
      const envelope: ContextEnvelope = matchedTopic
        ? assembleTopicContext(ctx, {
            sessionKey,
            providerName: "(pending)",
            providerStrategy: "history-aware",
            userMessageOverride: { content: lastUserMsg?.content ?? "", messageId: lastUserMsg?.id },
            includeLastUserInHistory: false,
            planMode,
          })
        : {
            // No topic bound to this sessionKey — emit a degenerate envelope
            // so the legacy HTTP fallback path still has *something* to
            // serialise. Mirrors the pre-refactor behaviour where
            // `if (matchedTopic)` skipped all the system block injection.
            topicId: "",
            sessionKey,
            providerName: "(pending)",
            providerStrategy: "history-aware",
            systemBlocks: [],
            history: messages
              .filter((m: any) => m.role === "user" || m.role === "assistant")
              .slice(0, -1)
              .map((m: any) => ({ role: m.role, content: m.content })),
            userMessage: { content: lastUserMsg?.content ?? "" },
            diagnostics: {
              totalTokens: 0, budgetLimit: 200_000, budgetPercent: 0,
              droppedHistoryTurns: 0, historyEntries: [],
              warnings: [], assembledAt: Date.now(),
            },
          };

      // Build the legacy `finalMessages: { role; content }[]` array for the
      // HTTP fallback path further down. Composed from the envelope so the
      // shape matches what providers used to receive (system messages
      // followed by the full user/assistant transcript).
      const composedSystemMessages = composeSystemMessages(envelope.systemBlocks);
      const finalMessages: { role: string; content: string }[] = [
        ...composedSystemMessages.map((m) => ({ role: m.role, content: m.content })),
        ...envelope.history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: envelope.userMessage.content },
      ];

      // ─── Resolve provider for this topic (with optional per-message override) ───
      let topicProvider: AIProvider;
      const overrideProvider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : null;
      if (overrideProvider) {
        try {
          topicProvider = getProvider(overrideProvider);
        } catch (err: any) {
          console.warn(`[Chat] Override provider "${overrideProvider}" not available, falling back: ${err.message}`);
          topicProvider = resolveProvider(matchedTopic);
        }
      } else {
        topicProvider = resolveProvider(matchedTopic);
      }
      // Per-message override wins; otherwise the topic's persisted model is
      // used (set by the picker via PUT /api/topics/:id and broadcast as
      // topic:updated). Falls through to the provider default when both unset.
      const requestedModel = typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : (typeof matchedTopic?.model === "string" && matchedTopic.model.trim() ? matchedTopic.model.trim() : undefined);

      // Drop the override if the resolved provider no longer offers that
      // model — e.g. the user picked `gpt-5-codex` two months ago, then ChatGPT
      // auth changed plan and the cache no longer lists it. Without this check
      // the model name is forwarded to the CLI which fails with "exit 1" and
      // surfaces as a "Codex error" stub. If we can't resolve a model list
      // (manager not warmed yet, or provider has no listModels), trust the
      // override — the previous behavior. The validation is a guard, not a
      // contract.
      let overrideModel: string | undefined = requestedModel;
      if (requestedModel) {
        const snap = getSnapshotManager().getSnapshot();
        const entry = snap.providers.find(p => p.name === topicProvider.name);
        if (entry && entry.models.length > 0 && !entry.models.includes(requestedModel)) {
          console.warn(
            `[Chat] Dropping stale model override "${requestedModel}" — not offered by provider "${topicProvider.name}". ` +
            `Available: [${entry.models.slice(0, 5).join(", ")}${entry.models.length > 5 ? ", …" : ""}]`,
          );
          overrideModel = undefined;
        }
      }

      // ─── Streaming ───
      const useWS = topicProvider.capabilities.has('streaming') && topicProvider.connected;

      console.log(`[Chat] useWS=${useWS}, sessionKey=${sessionKey}`);
      if (useWS) {
        // === WS-based chat: sends via chat.send, receives tool + text events ===
        try {
          const requestStartMs = Date.now();
          let fullContent = "";
          let fullThinking = "";
          let lastTextDelta = ""; // track cumulative text from delta events
          let chunkCount = 0;
          let lastSaveChunk = 0;
          const SAVE_INTERVAL = 10;
          const trackedToolCallIds: string[] = [];
          // Chronological content timeline. Each event from the provider is
          // appended in arrival order; consecutive same-kind text/thinking
          // deltas grow the trailing block, while tool calls always start a
          // new block. Persisted on finalize so reload preserves ordering.
          // See `server/types.ts:ContentBlock` — same shape lives on
          // `StoredMessage.blocks` and (mirror-typed) on the client.
          const blocks: ContentBlock[] = [];
          const appendTextBlock = (delta: string) => {
            if (!delta) return;
            const last = blocks[blocks.length - 1];
            if (last && last.kind === "text") last.text += delta;
            else blocks.push({ kind: "text", text: delta });
          };
          const appendThinkingBlock = (delta: string) => {
            if (!delta) return;
            const last = blocks[blocks.length - 1];
            if (last && last.kind === "thinking") last.text += delta;
            else blocks.push({ kind: "thinking", text: delta });
          };
          // Persist `blocks` immediately on every tool lifecycle event (start,
          // result, abort). Without this, mid-stream reload misses tool calls:
          // `addToolCallToLastMessage` writes the legacy `tool_calls` column
          // synchronously but `blocks` only persists every SAVE_INTERVAL=10
          // text chunks. The renderer prefers `blocks` when present, so any
          // reload between text saves shows stale rows. This helper closes
          // that race — the cost is one extra UPDATE per tool event, which is
          // small relative to the model's tool-call cadence.
          const persistBlocks = () => {
            updateLastMessage(sessionKey, { blocks: blocks.length > 0 ? blocks : undefined });
          };
          const appendToolBlock = (tc: ToolCall) => {
            blocks.push({ kind: "tool", toolCall: tc });
            persistBlocks();
          };
          const updateBlockTool = (id: string, patch: Partial<ToolCall>) => {
            for (let i = 0; i < blocks.length; i++) {
              const b = blocks[i];
              if (b.kind === "tool" && b.toolCall.id === id) {
                // Replace the tool block with a fresh object holding a fresh
                // toolCall ref. Mutating in place looks tempting but breaks
                // any client-side React.memo that uses shallow prop equality
                // when we serialize the array — the toolCall ref is what
                // ToolCallRow keys off of in the legacy bucket too.
                blocks[i] = {
                  kind: "tool",
                  toolCall: { ...b.toolCall, ...patch },
                };
                persistBlocks();
                return;
              }
            }
          };
          let topicSwitchDetected = false;
          let switchTargetTopicId: string | null = null;
          // Captured at stream-end if the provider's final message includes
          // usage (claude-code SDK does; codex turn.completed will too).
          // finalizeStream() reads these and persists them on the message so
          // the UI footer can render `<duration>s · <tokens> · $<cost>`.
          let usagePromptTokens: number | undefined;
          let usageCompletionTokens: number | undefined;
          let costCents: number | undefined;
          const partialMsg = createPartialMessage(sessionKey, "assistant");
          startStream(sessionKey, partialMsg.id);
          broadcastToAll({ type: "stream:start", sessionKey, topicId: matchedTopic?.id, messageId: partialMsg.id });

          // Create SSE response for the HTTP client
          const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
          const writer = writable.getWriter();
          let clientDisconnected = false;
          const encoder = new TextEncoder();

          const writeSSE = async (data: string) => {
            if (clientDisconnected) return;
            try { await writer.write(encoder.encode(`data: ${data}\n\n`)); } catch { clientDisconnected = true; }
          };
          const closeClient = async () => {
            if (clientDisconnected) return;
            try { await writer.close(); } catch { clientDisconnected = true; }
          };

          // ── Stream timeout state machine (resilience layer) ────────────
          //
          // We split the old single-timer design into three layered timers
          // because the previous "any 2 min of silence → kill the stream"
          // rule was too aggressive for multi-agent flows where the parent
          // legitimately waits on Task() sub-agents that may not emit events
          // for minutes at a time (e.g. a Bash inside a sub-agent).
          //
          //   SOFT (STREAM_TIMEOUT_MS, 2 min)
          //     The provider has gone quiet. Annotate the partial message
          //     with a "stream slow" marker, log a warn to activity_log,
          //     keep the handler registered, and start the GRACE timer.
          //     CRUCIAL: while ≥1 tool call is in `running` state, this
          //     timer is suspended (we are not in a true silence — we are
          //     waiting on a tool by design).
          //
          //   GRACE (STREAM_GRACE_MS, 60 s)
          //     Final window after a soft timeout to receive ANY provider
          //     event. If one arrives, we strip the annotation and resume
          //     normal streaming. Otherwise the stream is finalized as
          //     timed-out (the old behavior).
          //
          //   HARD (STREAM_HARD_TIMEOUT_MS, 30 min)
          //     Absolute upper bound, armed once at stream start and never
          //     reset. Protects against a provider that keeps emitting
          //     dust events forever; logs `error` to activity_log.
          //
          // The state variable below tracks where we are; resetStreamTimer
          // is the single entry point called by every onTextDelta /
          // onToolStart / onSubAgentUpdate / etc. handler.
          const STREAM_TIMEOUT_MS = 120_000;       // 2 min soft
          const STREAM_GRACE_MS = 60_000;          // 1 min grace
          const STREAM_HARD_TIMEOUT_MS = 30 * 60_000; // 30 min hard upper-bound
          let streamState: "streaming" | "soft-timed-out" | "finalized" = "streaming";
          let softTimer: ReturnType<typeof setTimeout> | null = null;
          let graceTimer: ReturnType<typeof setTimeout> | null = null;
          let hardTimer: ReturnType<typeof setTimeout> | null = null;
          let softTimedOutAtMs: number | null = null;

          const clearAllTimers = () => {
            if (softTimer) { clearTimeout(softTimer); softTimer = null; }
            if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
            if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
          };

          const armSoftTimer = () => {
            if (streamState !== "streaming") return;
            if (softTimer) clearTimeout(softTimer);
            // Suspend while ≥1 tool call is `running`. The next
            // resetStreamTimer (fired on onToolResult / new event) will
            // re-arm if needed.
            if (trackedToolCallIds.length > 0) { softTimer = null; return; }
            softTimer = setTimeout(handleSoftTimeout, STREAM_TIMEOUT_MS);
          };

          const handleSoftTimeout = () => {
            if (streamState !== "streaming") return;
            console.warn(`[StreamWS] Soft timeout: no data for ${STREAM_TIMEOUT_MS / 1000}s on ${sessionKey} (grace ${STREAM_GRACE_MS / 1000}s)`);
            streamState = "soft-timed-out";
            softTimedOutAtMs = Date.now();
            // Annotate but keep streaming flagged on — the message is still
            // partial; we are NOT closing the SSE writer or unregistering.
            if (fullContent.trim()) {
              fullContent = stripSlowAnnotation(fullContent) + STREAM_SLOW_ANNOTATION;
            } else {
              fullContent = STREAM_SLOW_ANNOTATION.trimStart();
            }
            updateLastMessage(sessionKey, { content: fullContent });
            if (matchedTopic) {
              broadcastToAll({
                type: "stream:slow",
                sessionKey,
                topicId: matchedTopic.id,
                messageId: partialMsg.id,
                graceMs: STREAM_GRACE_MS,
              });
            }
            logStreamSoftTimeout({
              sessionKey,
              topicId: matchedTopic?.id,
              durationMs: Date.now() - requestStartMs,
              toolCallCount: trackedToolCallIds.length,
            });
            // Start grace window. If the provider emits ANYTHING in this
            // window, resetStreamTimer's recovery branch fires and we
            // return to "streaming". Otherwise we finalize as timeout.
            graceTimer = setTimeout(handleGraceExpiry, STREAM_GRACE_MS);
          };

          const handleGraceExpiry = () => {
            if (streamState !== "soft-timed-out") return;
            console.warn(`[StreamWS] Grace expired without recovery on ${sessionKey} → finalize as timeout`);
            streamState = "finalized";
            const timeoutMsg = "⚠️ Response timed out. The AI service took too long to respond. Please try again.";
            // Replace the soft annotation with the hard timeout marker.
            fullContent = stripSlowAnnotation(fullContent);
            if (!fullContent.trim()) fullContent = timeoutMsg;
            else fullContent += "\n\n---\n*[Response timed out]*";
            updateLastMessage(sessionKey, { content: fullContent, partial: undefined, streamedAt: undefined });
            endStream(sessionKey);
            topicProvider.unregisterStreamHandler?.(sessionKey);
            if (matchedTopic) {
              broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: timeoutMsg });
              broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: partialMsg.id });
              updateUnreadCount(matchedTopic.id);
            }
            // No separate "grace expired" log line — the soft-timeout entry
            // already exists; recovery would have logged on the way out.
            // Failing to recover IS the absence of a recovery log entry.
            writeSSE("[DONE]").then(() => closeClient());
            clearAllTimers();
          };

          const handleHardTimeout = () => {
            if (streamState === "finalized") return;
            console.error(`[StreamWS] Hard timeout (${STREAM_HARD_TIMEOUT_MS / 60_000} min) on ${sessionKey}`);
            streamState = "finalized";
            const msg = `⚠️ Hard timeout (${STREAM_HARD_TIMEOUT_MS / 60_000} min) reached. The provider stopped responding.`;
            fullContent = stripSlowAnnotation(fullContent);
            if (!fullContent.trim()) fullContent = msg;
            else fullContent += `\n\n---\n*[Hard timeout (${STREAM_HARD_TIMEOUT_MS / 60_000} min) reached]*`;
            updateLastMessage(sessionKey, { content: fullContent, partial: undefined, streamedAt: undefined });
            endStream(sessionKey);
            topicProvider.unregisterStreamHandler?.(sessionKey);
            if (matchedTopic) {
              broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: msg });
              broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: partialMsg.id });
              updateUnreadCount(matchedTopic.id);
            }
            logStreamHardTimeout({
              sessionKey,
              topicId: matchedTopic?.id,
              durationMs: Date.now() - requestStartMs,
              toolCallCount: trackedToolCallIds.length,
            });
            writeSSE("[DONE]").then(() => closeClient());
            clearAllTimers();
          };

          const recoverFromSoftTimeout = () => {
            // A provider event arrived during the grace window. Strip the
            // annotation and return to "streaming". Future events resume
            // normal handling.
            if (streamState !== "soft-timed-out") return;
            console.log(`[StreamWS] Recovered from soft timeout on ${sessionKey} after ${Date.now() - (softTimedOutAtMs ?? Date.now())}ms`);
            if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
            streamState = "streaming";
            fullContent = stripSlowAnnotation(fullContent);
            updateLastMessage(sessionKey, { content: fullContent });
            if (matchedTopic) {
              broadcastToAll({
                type: "stream:resumed",
                sessionKey,
                topicId: matchedTopic.id,
                messageId: partialMsg.id,
              });
            }
            logStreamRecovered({
              sessionKey,
              topicId: matchedTopic?.id,
              durationMs: softTimedOutAtMs ? Date.now() - softTimedOutAtMs : undefined,
            });
            softTimedOutAtMs = null;
          };

          /** Single entry point called by every provider event handler. */
          const resetStreamTimer = () => {
            if (streamState === "finalized") return;
            if (streamState === "soft-timed-out") recoverFromSoftTimeout();
            armSoftTimer();
          };

          // Hard timer is armed once at stream start and is the only timer
          // never reset by events. Soft timer arms lazily on first event /
          // when no tools are running.
          hardTimer = setTimeout(handleHardTimeout, STREAM_HARD_TIMEOUT_MS);
          // Provide a back-compat reference so any future `streamInactivityTimer`
          // checks (used to exist) won't break — it's now a synthetic getter.
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          let streamInactivityTimer: ReturnType<typeof setTimeout> | null = null;

          // Helper: finalize the stream (called on done/error/abort)
          const finalizeStream = async (reason: "done" | "error" | "aborted", errorMsg?: string) => {
            // Always cancel pending timers — the stream is over.
            clearAllTimers();
            // Recovery path: if the provider succeeded after the soft
            // timeout fired, we want the user to see the real content,
            // not the "[stream slow]" annotation. Strip it and emit a
            // recovered log entry so we have telemetry on near-misses.
            if (streamState === "soft-timed-out") {
              const beforeStrip = fullContent;
              fullContent = stripSlowAnnotation(fullContent);
              if (beforeStrip !== fullContent && matchedTopic) {
                broadcastToAll({
                  type: "stream:resumed",
                  sessionKey,
                  topicId: matchedTopic.id,
                  messageId: partialMsg.id,
                });
              }
              logStreamRecovered({
                sessionKey,
                topicId: matchedTopic?.id,
                durationMs: softTimedOutAtMs ? Date.now() - softTimedOutAtMs : undefined,
                extra: { finalizeReason: reason },
              });
            }
            streamState = "finalized";

            if (reason === "error" && errorMsg) {
              if (!fullContent.trim()) fullContent = `⚠️ ${errorMsg}`;
              if (matchedTopic) {
                broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: errorMsg });
              }
            }

            if (reason === "done" && !fullContent.trim() && trackedToolCallIds.length === 0) {
              const emptyErrorMsg = "⚠️ No response received. The AI service may be temporarily unavailable. Please try again.";
              fullContent = emptyErrorMsg;
              console.warn(`[StreamWS] Empty response for ${sessionKey}`);
              if (matchedTopic) {
                broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: emptyErrorMsg });
              }
            }

            // Finalize any tool calls that the provider started but never
            // emitted a result for. Three failure modes share this loop:
            //   - "done":     fire-and-forget tools (ExitPlanMode, tools that
            //                 don't return a result). Mark as success but with
            //                 NO result string — the previous code passed
            //                 'success' as the result, which persisted the
            //                 literal "success" into the row's body.
            //   - "error":    a stream-level error. Tool was probably mid-run
            //                 when things broke — mark as error.
            //   - "aborted":  user clicked stop. Tools did not complete; mark
            //                 as error with reason so the UI doesn't show a
            //                 misleading green ✓.
            const finalizeStatus: 'success' | 'error' = reason === 'done' ? 'success' : 'error';
            const finalizeError = reason === 'aborted'
              ? 'Aborted by user'
              : reason === 'error'
              ? (errorMsg || 'Stream ended with error')
              : undefined;
            for (const tcId of trackedToolCallIds) {
              if (finalizeStatus === 'error') {
                // updateToolCallResult sets status='error' when error is provided.
                updateToolCallResult(sessionKey, tcId, '', finalizeError);
                updateBlockTool(tcId, { status: 'error', error: finalizeError });
                broadcastToAll({ type: "stream:tool_result", sessionKey, topicId: matchedTopic?.id, toolCallId: tcId, status: 'error', result: '', error: finalizeError });
                writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_result: { id: tcId, status: 'error', error: finalizeError } } }] }));
              } else {
                // Fire-and-forget success. Empty result so the UI shows just
                // the green ✓ without a literal "success" body.
                updateToolCallResult(sessionKey, tcId, '');
                updateBlockTool(tcId, { status: 'success' });
                broadcastToAll({ type: "stream:tool_result", sessionKey, topicId: matchedTopic?.id, toolCallId: tcId, status: 'success' });
                writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_result: { id: tcId, status: 'success' } } }] }));
              }
            }

            const latencyMs = Date.now() - requestStartMs;
            updateLastMessage(sessionKey, {
              content: fullContent,
              thinking: fullThinking || undefined,
              blocks: blocks.length > 0 ? blocks : undefined,
              partial: undefined,
              streamedAt: undefined,
              latencyMs,
              usagePromptTokens,
              usageCompletionTokens,
              costCents,
            });
            endStream(sessionKey);
            topicProvider.unregisterStreamHandler?.(sessionKey);

            // Detect sub-agent launches
            if (matchedTopic && /sub.?agent|subagent|lanciato|spawned|sessions_spawn/i.test(fullContent)) {
              watchSessionForSubagents(matchedTopic.id, sessionKey);
            }

            if (matchedTopic) {
              broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: partialMsg.id, content: fullContent, preview: fullContent.slice(0, 100) });
              broadcastToAll({
                type: "stream:end",
                sessionKey,
                topicId: matchedTopic?.id,
                messageId: partialMsg.id,
                latencyMs,
                usagePromptTokens,
                usageCompletionTokens,
                costCents,
              });
              updateUnreadCount(matchedTopic.id);
            }

            // Activity log (Fix E): one row per stream lifecycle event so
            // future timeouts/aborts/errors leave a queryable trail. The
            // helper swallows DB errors so a logging failure can never
            // break the stream finalization path.
            const logCtx = {
              sessionKey,
              topicId: matchedTopic?.id,
              durationMs: latencyMs,
              toolCallCount: trackedToolCallIds.length,
              promptTokens: usagePromptTokens,
              completionTokens: usageCompletionTokens,
              costCents,
            };
            if (reason === "done") logStreamComplete(logCtx);
            else if (reason === "aborted") logStreamAborted(logCtx);
            else if (reason === "error") logStreamError({ ...logCtx, errorMessage: errorMsg });

            // Topic switch handling
            if (topicSwitchDetected && switchTargetTopicId) {
              const targetData = loadTopics();
              const targetTopic = targetData.topics[switchTargetTopicId];
              if (targetTopic) {
                const currentMsgs = loadLocalMessages(sessionKey);
                const lastUserMsg = [...currentMsgs].reverse().find(m => m.role === 'user');
                let userContent = '';
                if (lastUserMsg) {
                  userContent = lastUserMsg.content;
                  appendLocalMessage(targetTopic.sessionKey, 'user', userContent);
                }
                appendLocalMessage(targetTopic.sessionKey, 'assistant', fullContent);
                const sourceMsgs = loadLocalMessages(sessionKey);
                const toRemove = sourceMsgs.slice(-2);
                for (const m of toRemove) {
                  const parentRow = ctx.db.prepare(`SELECT parent_id FROM messages WHERE id = ?`).get(m.id) as any;
                  const pId = parentRow?.parent_id || null;
                  ctx.db.prepare(`UPDATE messages SET parent_id = ? WHERE parent_id = ?`).run(pId, m.id);
                  ctx.db.prepare(`DELETE FROM messages WHERE id = ?`).run(m.id);
                }
                broadcastToAll({
                  type: "topic:switch:complete",
                  fromTopicId: matchedTopic!.id, fromSessionKey: sessionKey,
                  toTopicId: switchTargetTopicId, toSessionKey: targetTopic.sessionKey,
                  userContent, assistantContent: fullContent,
                });
              }
            }

            // Media detection
            setTimeout(() => {
              try {
                const newMedia = findNewMediaFiles(requestStartMs);
                if (newMedia.length > 0 && sessionKey) {
                  updateLastMessageWithMedia(sessionKey, newMedia);
                  broadcastToAll({ type: "message:media", sessionKey, topicId: matchedTopic?.id, media: newMedia });
                }
              } catch {}
            }, 1000);

            if (matchedTopic && !matchedTopic.projectPath) {
              setTimeout(() => autoBindProject(matchedTopic!), 500);
            }

            // Close SSE response
            await writeSSE("[DONE]");
            await closeClient();
          };

          // Register event handler for this session
          const handler: StreamHandler = {
            onTextDelta: (text: string, _fullText: string) => {
              resetStreamTimer();
              // Gateway sends cumulative text in delta events
              // Extract the new portion by comparing with what we've seen
              let newText = text;
              if (text.length > lastTextDelta.length && text.startsWith(lastTextDelta)) {
                newText = text.slice(lastTextDelta.length);
              } else if (text === lastTextDelta) {
                return; // No new content
              }
              lastTextDelta = text;

              if (newText) {
                fullContent += newText;
                appendTextBlock(newText);

                // Strip internal markers before broadcasting to client
                fullContent = detectAndBroadcastBrowserMarker(fullContent, matchedTopic);
                if (!topicSwitchDetected && (fullContent.includes('{{TOPIC_SWITCH:') || fullContent.includes('{{TOPIC_NEW:'))) {
                  const result = detectAndBroadcastTopicSwitch(fullContent, matchedTopic);
                  fullContent = result.content;
                  if (result.switchedToTopicId) { topicSwitchDetected = true; switchTargetTopicId = result.switchedToTopicId; }
                }
                // Detect project create/open markers
                if (fullContent.includes('{{PROJECT_CREATE:') || fullContent.includes('{{PROJECT_OPEN:')) {
                  fullContent = detectAndHandleProjectMarkers(fullContent, matchedTopic);
                }

                // Broadcast clean content (recalculate delta after marker stripping)
                const markerRegex = /\{\{(?:TOPIC_SWITCH|TOPIC_NEW|BROWSER|PROJECT_CREATE|PROJECT_OPEN):[^}]*\}\}/g;
                const cleanContent = fullContent;
                broadcastToAll({ type: "stream:content_chunk", sessionKey, topicId: matchedTopic?.id, content: newText.replace(markerRegex, '') });
                writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { content: newText.replace(markerRegex, '') } }] }));
              }

              chunkCount++;
              updateStreamContent(sessionKey, fullContent, fullThinking);
              if (chunkCount - lastSaveChunk >= SAVE_INTERVAL) {
                lastSaveChunk = chunkCount;
                // Persist blocks alongside content so a mid-stream
                // GET /api/history (e.g. another window attaching) sees
                // the chronological timeline up to this point, not just
                // the bucket fields. Without this the attaching window
                // has no blocks until finalize, and falls back to the
                // legacy bucket render for the duration of the stream.
                updateLastMessage(sessionKey, {
                  content: fullContent,
                  thinking: fullThinking || undefined,
                  blocks: blocks.length > 0 ? blocks : undefined,
                });
              }
            },

            onThinkingDelta: (text: string) => {
              resetStreamTimer();
              fullThinking += text;
              appendThinkingBlock(text);
              broadcastToAll({ type: "stream:thinking_chunk", sessionKey, topicId: matchedTopic?.id, content: text });
              updateStreamContent(sessionKey, fullContent, fullThinking);
            },

            onToolStart: (toolCallId: string, name: string, args?: Record<string, unknown>) => {
              resetStreamTimer();
              console.log(`[StreamWS] Tool start: ${name} (${toolCallId.slice(0,8)}) for ${sessionKey}`);
              // Build a typed `detail` at the boundary so the renderer doesn't
              // have to JSON-grovel `args`. Bash → shell, Read → read, Task →
              // sub_agent (empty actions, populated later by SidechainTracker
              // updates), `mcp__*` → mcp with namespace stripped, etc. See
              // `providers/claude/tool-detail.ts`. Unknown names fall through
              // to `{ type: 'unknown' }` so the legacy generic row still works.
              const detail = deriveToolDetail(name, args);
              const toolCall: ToolCall = {
                id: toolCallId, name, args: args || {},
                status: 'running', contentOffset: fullContent.length,
                detail,
              };
              trackedToolCallIds.push(toolCallId);
              addToolCallToLastMessage(sessionKey, toolCall);
              appendToolBlock(toolCall);
              broadcastToAll({ type: "stream:tool_call", sessionKey, topicId: matchedTopic?.id, toolCall });

              // Also send as SSE for the HTTP client
              writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ id: toolCallId, function: { name, arguments: JSON.stringify(args || {}) }, contentOffset: fullContent.length }] } }] }));

              // Track sessions_spawn
              if (name === 'sessions_spawn' && matchedTopic) {
                watchSessionForSubagents(matchedTopic.id, sessionKey);
                console.log(`[SubagentPoll] sessions_spawn detected via WS in topic ${matchedTopic.id.slice(0,8)}`);
              }

              // Phase 30 BROWSER-CHAT-04 — server-side dispatch for native browser_* tools.
              // When the LLM emits a tool call with name starting with "browser_", call
              // the canonical handler directly (no HTTP roundtrip). The handler wraps
              // its action in withLock so agent_active broadcasts on entry and exit
              // (try/finally guaranteed unlock even if it throws). Result is fed back
              // through the same onToolResult update path used by every other tool, so
              // the chat UI shows identical lifecycle (running -> success/error).
              if (name.startsWith('browser_') && matchedTopic && browserService) {
                dispatchBrowserToolCall(name, args || {}, matchedTopic, browserService)
                  .then((result) => {
                    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
                    // Mirror the onToolResult flow inline so the UI / SSE / persisted
                    // state updates happen consistently. Same surface as the existing
                    // onToolResult callback below.
                    updateToolCallResult(sessionKey, toolCallId, resultStr);
                    updateBlockTool(toolCallId, { status: 'success', result: resultStr });
                    broadcastToAll({ type: 'stream:tool_result', sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'success', result: resultStr });
                    writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_result: { id: toolCallId, status: 'success', result: resultStr } } }] }));
                    const idx = trackedToolCallIds.indexOf(toolCallId);
                    if (idx >= 0) trackedToolCallIds.splice(idx, 1);
                  })
                  .catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.warn(`[browser-tool-dispatcher] ${name} failed: ${msg}`);
                    const errResult = JSON.stringify({ error: msg });
                    updateToolCallResult(sessionKey, toolCallId, errResult);
                    updateBlockTool(toolCallId, { status: 'error', result: errResult });
                    broadcastToAll({ type: 'stream:tool_result', sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'error', result: errResult });
                    writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_result: { id: toolCallId, status: 'error', result: errResult } } }] }));
                    const idx = trackedToolCallIds.indexOf(toolCallId);
                    if (idx >= 0) trackedToolCallIds.splice(idx, 1);
                  });
              }

              // Phase 30 BROWSER-CHAT-03 — OpenClaw browser tool profile monitoring.
              // The bridge that injected targetId+profile system messages was removed;
              // this block remains as logging-only telemetry for OpenClaw browser tool
              // calls coming through other routes (sees what profile the model picked).
              if (name === 'browser' && matchedTopic) {
                const profile = args?.profile;
                if (profile === 'topics') {
                  console.log(`[BrowserMonitor] ✓ Topic ${matchedTopic.id.slice(0,8)} using isolated browser (action: ${args?.action})`);
                } else {
                  console.warn(`[BrowserMonitor] ⚠ Topic ${matchedTopic.id.slice(0,8)} used browser with profile="${profile || 'default'}" instead of "topics"`);
                }
              }
            },

            onToolUpdate: (toolCallId: string, _partialResult: string) => {
              resetStreamTimer();
              // Broadcast partial result to clients
              broadcastToAll({ type: "stream:tool_update", sessionKey, topicId: matchedTopic?.id, toolCallId, partialResult: _partialResult });
            },

            onSubAgentUpdate: (parentToolCallId, snapshot) => {
              resetStreamTimer();
              // Patch the parent Task tool's `detail` with the latest sub-agent
              // snapshot. Each call replaces the full actions[] (snapshot, not
              // delta) so the renderer always shows the current truth. Same
              // callId used as the regular tool_call channel — the client
              // matches by id and merges. We also persist via updateBlockTool
              // so a mid-stream reload sees the in-progress sub-agent activity.
              const detail: import("../types").ToolCallDetail = {
                type: "sub_agent",
                ...(snapshot.subAgentType ? { subAgentType: snapshot.subAgentType } : {}),
                ...(snapshot.description ? { description: snapshot.description } : {}),
                actions: snapshot.actions,
                ...(snapshot.result ? { result: snapshot.result } : {}),
              };
              updateBlockTool(parentToolCallId, { detail });
              broadcastToAll({
                type: "stream:tool_detail",
                sessionKey,
                topicId: matchedTopic?.id,
                toolCallId: parentToolCallId,
                detail,
                finished: snapshot.finished,
              });
            },

            onToolResult: (toolCallId: string, result: string, isError?: boolean) => {
              resetStreamTimer();
              const status = isError ? 'error' : 'success';
              console.log(`[StreamWS] Tool result: ${toolCallId.slice(0,8)} ${status} for ${sessionKey}`);

              // Re-derive detail with result so per-kind body fields (shell.output,
              // read.content, fetch.result) are populated for the renderer. We
              // need the original tool name + args to build it — read them off
              // the in-memory blocks (the running ToolCall is already there
              // courtesy of onToolStart).
              let detail: import("../types").ToolCallDetail | undefined;
              for (let i = blocks.length - 1; i >= 0; i--) {
                const b = blocks[i];
                if (b.kind === "tool" && b.toolCall.id === toolCallId) {
                  detail = deriveToolDetail(b.toolCall.name, b.toolCall.args, result);
                  break;
                }
              }

              if (isError) {
                // Pass result as the error so updateToolCallResult sets status='error'
                // and the row renders red ✗ + error body. The Claude SDK puts the
                // failure message inside `tool_result.content` so `result` IS the
                // error text — passing it as both result and error is intentional.
                updateToolCallResult(sessionKey, toolCallId, result, result);
                updateBlockTool(toolCallId, { status: 'error', result, error: result, ...(detail ? { detail } : {}) });
                broadcastToAll({ type: "stream:tool_result", sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'error', result, error: result, detail });
                writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_result: { id: toolCallId, status: 'error', result, error: result } } }] }));
              } else {
                updateToolCallResult(sessionKey, toolCallId, result);
                updateBlockTool(toolCallId, { status: 'success', result, ...(detail ? { detail } : {}) });
                broadcastToAll({ type: "stream:tool_result", sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'success', result, detail });
                writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_result: { id: toolCallId, status: 'success', result } } }] }));
              }
              // Remove from tracked list (it's already finalized)
              const idx = trackedToolCallIds.indexOf(toolCallId);
              if (idx >= 0) trackedToolCallIds.splice(idx, 1);
            },

            onDone: (message?: any) => {
              // Extract final content from message if available
              if (message) {
                const finalText = extractFinalText(message);
                if (finalText && finalText.length > fullContent.length) {
                  const extra = finalText.slice(fullContent.length);
                  if (extra) {
                    fullContent = finalText;
                    broadcastToAll({ type: "stream:content_chunk", sessionKey, topicId: matchedTopic?.id, content: extra });
                  }
                }
                // Capture provider-reported usage so the message footer can
                // render. Different providers shape this slightly differently:
                // claude-code → `{ input_tokens, output_tokens, ... }`,
                // codex → `{ inputTokens, outputTokens, totalTokens }`.
                const usage = message.usage;
                if (usage && typeof usage === "object") {
                  const inTok = usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens;
                  const outTok = usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens;
                  if (typeof inTok === "number") usagePromptTokens = inTok;
                  if (typeof outTok === "number") usageCompletionTokens = outTok;
                  // Cost: try the provider field first, then derive via the
                  // existing per-model price table when both token counts exist.
                  const usdFromProvider = typeof usage.costUsd === "number" ? usage.costUsd : undefined;
                  if (usdFromProvider != null) {
                    costCents = Math.round(usdFromProvider * 100);
                  } else if (typeof inTok === "number" && typeof outTok === "number") {
                    try {
                      const usd = calculateCost(message.model || overrideModel || "unknown", inTok, outTok);
                      if (usd > 0) costCents = Math.round(usd * 100);
                    } catch { /* unknown model — skip cost, keep tokens */ }
                  }
                }
              }
              finalizeStream("done");
            },

            onError: (error: string) => {
              console.error(`[StreamWS] Error for ${sessionKey}: ${error}`);
              finalizeStream("error", error);
            },

            onAborted: (message?: any) => {
              // Extract content from aborted message
              if (message) {
                const abortedText = extractFinalText(message);
                if (abortedText && abortedText.length > fullContent.length) {
                  fullContent = abortedText;
                }
              }
              finalizeStream("aborted");
            },
          };

          // Helper to extract text from final/aborted message
          function extractFinalText(message: any): string | null {
            if (!message) return null;
            if (typeof message.text === "string") return message.text;
            if (typeof message.content === "string") return message.content;
            if (Array.isArray(message.content)) {
              return message.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("");
            }
            return null;
          }

          resetStreamTimer();

          // Send chat via WS
          try {
            // Re-shape the canonical envelope for the actual provider strategy.
            // The system blocks and history were already assembled in one
            // pass by `assembleTopicContext` above (with a placeholder
            // strategy); `adaptEnvelope` is a pure function so the second
            // call is essentially free.
            //
            // The dual-output here mirrors what the legacy supportsHistory
            // branch produced:
            //   - history-aware (claude, openai, codex):
            //       payload.history = [composed system msgs..., ...stripped DB history]
            //       payload.userContent = the new user turn verbatim
            //   - inline-system (claude-code):
            //       payload.userContent = "<context>...</context>\n\n${user}"
            //       payload.history = undefined (CLI session keeps its own state)
            //   - gateway-stateful (openclaw):
            //       same shape as history-aware; gateway may ignore `history`
            //       on the happy path and use its session state instead.
            const envForProvider: ContextEnvelope = {
              ...envelope,
              providerName: topicProvider.name,
              providerStrategy: getProviderStrategy(topicProvider),
            };
            // Push the envelope to the in-memory snapshot ring BEFORE the
            // adapter so what the inspector shows is exactly what we hand
            // to the provider. Best-effort — never throws.
            try { pushSnapshot(envForProvider); } catch (e) { console.warn("[Context] pushSnapshot failed:", e); }

            const payload = adaptEnvelope(envForProvider);
            const userContent = payload.userContent;
            const historyForProvider = payload.history;

            // Register handler BEFORE sendChat so tool events arriving during the await aren't lost.
            // Use undefined runId initially — the sentinel filter in gateway-ws.ts handles stale events.
            topicProvider.registerStreamHandler?.(sessionKey, undefined, handler);
            const sendOptions: { model?: string; history?: ChatMessage[]; tools?: Tool[] } = {};
            if (overrideModel) sendOptions.model = overrideModel;
            if (historyForProvider) sendOptions.history = historyForProvider;
            // Phase 30 BROWSER-CHAT-04 — register browserTools for SDK-driven providers.
            // CLI/gateway providers (codex, claude-code, openclaw) ignore this field
            // (their tool surfaces are managed upstream).
            if (isPassthroughProvider(topicProvider.name) && browserService) {
              sendOptions.tools = browserTools;
            }
            // Fire-and-forget: kick off sendChat WITHOUT awaiting so the
            // Response can be returned immediately. The provider's stream
            // for-await loop drives handler callbacks → writeSSE → flushes
            // deltas live to the client. Awaiting here would buffer the
            // whole stream into the TransformStream and release it all at
            // once when the Response is finally returned.
            topicProvider.sendChat(
              sessionKey,
              userContent,
              handler,
              Object.keys(sendOptions).length > 0 ? sendOptions : undefined,
            ).then((result) => {
              topicProvider.registerStreamHandler?.(sessionKey, result.runId, handler);
              console.log(`[StreamWS] chat.send OK for ${sessionKey}, runId: ${result.runId}`);
            }).catch(async (err: any) => {
              console.error(`[StreamWS] chat.send failed for ${sessionKey}:`, err);
              if (streamInactivityTimer) clearTimeout(streamInactivityTimer);
              topicProvider.unregisterStreamHandler?.(sessionKey);
              endStream(sessionKey);
              const errorMsg = `⚠️ Failed to send message: ${err.message}`;
              updateLastMessage(sessionKey, { content: errorMsg, partial: undefined, streamedAt: undefined });
              if (matchedTopic) {
                broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: errorMsg });
                broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: partialMsg.id });
                updateUnreadCount(matchedTopic.id);
              }
              await writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { content: errorMsg }, finish_reason: "stop" }] }));
              await writeSSE("[DONE]");
              await closeClient();
            });
          } catch (err: any) {
            console.error(`[StreamWS] sync setup error for ${sessionKey}:`, err);
            if (streamInactivityTimer) clearTimeout(streamInactivityTimer);
            topicProvider.unregisterStreamHandler?.(sessionKey);
            endStream(sessionKey);
            const errorMsg = `⚠️ Failed to send message: ${err.message}`;
            updateLastMessage(sessionKey, { content: errorMsg, partial: undefined, streamedAt: undefined });
            if (matchedTopic) {
              broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: errorMsg });
              broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: partialMsg.id });
              updateUnreadCount(matchedTopic.id);
            }
            await writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { content: errorMsg }, finish_reason: "stop" }] }));
            await writeSSE("[DONE]");
            await closeClient();
            return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
          }

          // Return SSE response — events will be pushed by the handler.
          // `no-transform` + `X-Accel-Buffering: no` tell every proxy in
          // the chain (vite-dev, electron, nginx) NOT to coalesce the
          // body into chunks of their own. Without these the user sees
          // the whole message arrive at once on stream-end instead of
          // progressive deltas.
          return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });

        } catch (err: any) {
          console.error(`[StreamWS] Unexpected error for ${sessionKey}:`, err);
          return json({ error: "Gateway WS error: " + err.message }, 502);
        }

      } else {
        // === Fallback: HTTP SSE (original approach — no tool visibility) ===
        console.log(`[Stream] Using HTTP SSE fallback (provider ${topicProvider.connected ? 'connected but no WS' : 'disconnected'})`);
        try {
          const abortController = new AbortController();
          const timeoutId = setTimeout(() => abortController.abort(), 300000);
          const requestStartMs = Date.now();

          let resp: Response;
          if (topicProvider.streamHTTP) {
            resp = await topicProvider.streamHTTP(finalMessages, { sessionKey, signal: abortController.signal });
          } else {
            // Provider doesn't support streamHTTP — use complete() as fallback
            const result = await topicProvider.complete(finalMessages);
            clearTimeout(timeoutId);
            const content = result.content;
            const storedFallback = appendLocalMessage(sessionKey, "assistant", content);
            if (matchedTopic) {
              broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: storedFallback.id, content, preview: content.slice(0, 100) });
            }
            const ssePayload = `data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(content)}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
            return new Response(ssePayload, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
          }
          clearTimeout(timeoutId);

          if (!resp.ok) {
            const text = await resp.text();
            const isRateLimit = resp.status === 429 || /rate.?limit/i.test(text);
            const errorMsg = isRateLimit
              ? "⚠️ Rate limit reached. The AI service is temporarily overloaded. Please wait a moment and try again."
              : `⚠️ AI service error (${resp.status}). Please try again.`;
            const errorPartial = createPartialMessage(sessionKey, "assistant");
            updateLastMessage(sessionKey, { content: errorMsg, partial: undefined, streamedAt: undefined });
            if (matchedTopic) {
              broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: errorMsg });
              broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: errorPartial.id, content: errorMsg, preview: errorMsg.slice(0, 100) });
              broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: errorPartial.id });
              updateUnreadCount(matchedTopic.id);
            }
            return new Response(
              `data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(errorMsg)}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
              { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }
            );
          }

          const contentType = resp.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            const data = await resp.json() as any;
            let content = data?.choices?.[0]?.message?.content || "";
            content = detectAndBroadcastBrowserMarker(content, matchedTopic);
            content = detectAndHandleProjectMarkers(content, matchedTopic);
            if (data?.usage) {
              const model = data.model || "unknown";
              const inputTokens = data.usage.prompt_tokens || 0;
              const outputTokens = data.usage.completion_tokens || 0;
              appendUsageRecord({
                timestamp: Date.now(), sessionKey, topicId: matchedTopic?.id, model, inputTokens, outputTokens,
                totalTokens: inputTokens + outputTokens, costUsd: calculateCost(model, inputTokens, outputTokens),
              }).catch(err => console.warn("[Usage] Failed to record usage:", err));
            }
            // Only broadcast message:new when we actually persisted the
            // assistant turn — otherwise receivers would see a row with no
            // messageId AND no content (current dedupe falls back to
            // last-of-role/content matching, which would silently dedupe
            // against an unrelated previous message). Empty completions are
            // recoverable on next turn; a phantom broadcast is not.
            const storedJsonAssistant = content ? appendLocalMessage(sessionKey, "assistant", content) : null;
            if (matchedTopic && storedJsonAssistant) {
              broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: storedJsonAssistant.id, content, preview: content.slice(0, 100) });
              updateUnreadCount(matchedTopic.id);
            }
            if (matchedTopic && !matchedTopic.projectPath) setTimeout(() => autoBindProject(matchedTopic!), 100);
            const ssePayload = `data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(content)}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
            return new Response(ssePayload, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
          }

          // Streaming fallback — simplified version (no tool visibility)
          const originalBody = resp.body!;
          let fullContent = "";
          let fullThinking = "";
          let isInThinking = false;
          let chunkCount = 0;
          let lastSaveChunk = 0;
          const SAVE_INTERVAL = 10;
          const partialMsg = createPartialMessage(sessionKey, "assistant");
          startStream(sessionKey, partialMsg.id, abortController);
          broadcastToAll({ type: "stream:start", sessionKey, topicId: matchedTopic?.id, messageId: partialMsg.id });

          // Always register WS handler for tool events — even if WS appears disconnected,
          // it may reconnect during the HTTP request. Tool events arrive via WS agent events.
          const httpRunId = `http:${crypto.randomUUID()}`;
          {
            topicProvider.registerStreamHandler?.(sessionKey, httpRunId, {
              onTextDelta() {},  // Handled by HTTP SSE processLine
              onThinkingDelta() {},
              onToolStart(toolCallId: string, name: string, args?: Record<string, unknown>) {
                const toolCall = { id: toolCallId, name, args: args ?? {}, status: 'running' as const, contentOffset: fullContent.length };
                addToolCallToLastMessage(sessionKey, toolCall);
                broadcastToAll({ type: "stream:tool_call", sessionKey, topicId: matchedTopic?.id, toolCall });
              },
              onToolUpdate(toolCallId: string, partialResult: string) {
                broadcastToAll({ type: "stream:tool_update", sessionKey, topicId: matchedTopic?.id, toolCallId, partialResult });
              },
              onToolResult(toolCallId: string, result: string) {
                updateToolCallResult(sessionKey, toolCallId, result);
                broadcastToAll({ type: "stream:tool_result", sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'success', result });
              },
              onDone() {},      // Handled by HTTP SSE [DONE]
              onError() {},
              onAborted() {},
            });
          }

          const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
          const writer = writable.getWriter();
          let clientDisconnected = false;
          const encoder = new TextEncoder();
          const forwardToClient = async (chunk: Uint8Array) => { if (clientDisconnected) return; try { await writer.write(chunk); } catch { clientDisconnected = true; } };
          const closeClient = async () => { if (clientDisconnected) return; try { await writer.close(); } catch { clientDisconnected = true; } };

          const processLine = (line: string) => {
            if (!line.startsWith("data: ")) return;
            const data = line.slice(6).trim();
            if (data === "[DONE]") {
              // CHAT-REL-01: Detect empty response and surface error
              if (!fullContent.trim()) {
                fullContent = "⚠️ No response received. The AI service may be overloaded. Please try again.";
                console.warn(`[Stream] Empty response for ${sessionKey} — surfacing error to client`);
              }
              updateLastMessage(sessionKey, { content: fullContent, thinking: fullThinking || undefined, partial: undefined, streamedAt: undefined });
              endStream(sessionKey);
              topicProvider.unregisterStreamHandler?.(sessionKey);
              if (matchedTopic) {
                broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: partialMsg.id, content: fullContent, preview: fullContent.slice(0, 100) });
                broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic?.id, messageId: partialMsg.id });
                updateUnreadCount(matchedTopic.id);
              }
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) {
                const content = delta.content;
                if (content.includes('<thinking>')) { isInThinking = true; broadcastToAll({ type: "stream:thinking_start", sessionKey, topicId: matchedTopic?.id }); }
                if (content.includes('</thinking>')) { isInThinking = false; broadcastToAll({ type: "stream:thinking_end", sessionKey, topicId: matchedTopic?.id }); }
                if (isInThinking) { const cleaned = content.replace(/<\/?thinking>/g, ''); fullThinking += cleaned; broadcastToAll({ type: "stream:thinking_chunk", sessionKey, topicId: matchedTopic?.id, content: cleaned }); }
                else { const cleaned = content.replace(/<\/?thinking>/g, ''); if (cleaned) { fullContent += cleaned; broadcastToAll({ type: "stream:content_chunk", sessionKey, topicId: matchedTopic?.id, content: cleaned }); } }
                chunkCount++;
                updateStreamContent(sessionKey, fullContent, fullThinking);
                if (chunkCount - lastSaveChunk >= SAVE_INTERVAL) { lastSaveChunk = chunkCount; updateLastMessage(sessionKey, { content: fullContent, thinking: fullThinking || undefined }); }
              }
              // Tool calls from SSE stream (if gateway includes them in HTTP response)
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (tc.function?.name) {
                    const toolCall = {
                      id: tc.id || `tool-${Date.now()}`,
                      name: tc.function.name,
                      args: tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
                      status: 'running' as const,
                      contentOffset: fullContent.length,
                    };
                    addToolCallToLastMessage(sessionKey, toolCall);
                    broadcastToAll({ type: "stream:tool_call", sessionKey, topicId: matchedTopic?.id, toolCall });
                    // Also forward as SSE for the HTTP client
                    const sseToolPayload = JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ id: toolCall.id, function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) }, contentOffset: toolCall.contentOffset }] } }] });
                    if (!clientDisconnected) { try { writer.write(encoder.encode(`data: ${sseToolPayload}\n\n`)); } catch {} }
                  }
                }
              }
              if (delta?.tool_result) {
                const { id: trId, status: trStatus, result: trResult } = delta.tool_result;
                if (trId) {
                  updateToolCallResult(sessionKey, trId, trResult || 'completed');
                  broadcastToAll({ type: "stream:tool_result", sessionKey, topicId: matchedTopic?.id, toolCallId: trId, status: trStatus || 'success', result: trResult });
                  const sseResultPayload = JSON.stringify({ choices: [{ index: 0, delta: { tool_result: { id: trId, status: trStatus || 'success', result: trResult } } }] });
                  if (!clientDisconnected) { try { writer.write(encoder.encode(`data: ${sseResultPayload}\n\n`)); } catch {} }
                }
              }
            } catch {}
          };

          const consumeGateway = async () => {
            const reader = originalBody.getReader();
            const onAbort = () => reader.cancel();
            abortController.signal.addEventListener("abort", onAbort, { once: true });
            const decoder = new TextDecoder();
            let sseBuffer = "";
            let streamError: string | null = null;

            // CHAT-REL-03: Inactivity timeout (60s per chunk)
            const INACTIVITY_TIMEOUT_MS = 60000;
            let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
            const resetInactivityTimer = () => {
              if (inactivityTimer) clearTimeout(inactivityTimer);
              inactivityTimer = setTimeout(() => {
                console.warn(`[Stream] Inactivity timeout (${INACTIVITY_TIMEOUT_MS / 1000}s) for ${sessionKey}`);
                streamError = "⚠️ Response timed out. The AI service took too long to respond. Please try again.";
                abortController.abort();
              }, INACTIVITY_TIMEOUT_MS);
            };
            resetInactivityTimer();

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                resetInactivityTimer();
                await forwardToClient(value);
                sseBuffer += decoder.decode(value, { stream: true });
                const lines = sseBuffer.split("\n");
                sseBuffer = lines.pop() || "";
                for (const line of lines) processLine(line);
              }
              if (sseBuffer.trim()) processLine(sseBuffer);
            } catch (err: any) {
              // CHAT-REL-02: Propagate errors to client via SSE
              const isAbort = err?.name === "AbortError" || abortController.signal.aborted;
              const errorMsg = streamError || (isAbort
                ? "⚠️ Response timed out. Please try again."
                : "⚠️ Connection lost during response. Please try again.");
              console.warn(`[Stream] Gateway read error for ${sessionKey}:`, err?.message || err);
              if (!fullContent.trim()) fullContent = errorMsg;
              else fullContent += `\n\n---\n*${errorMsg}*`;
              // Send error to client SSE
              const errPayload = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `\n\n${errorMsg}` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
              if (!clientDisconnected) { try { await writer.write(encoder.encode(errPayload)); } catch {} }
            }
            finally {
              if (inactivityTimer) clearTimeout(inactivityTimer);
              abortController.signal.removeEventListener("abort", onAbort);
              reader.releaseLock();
              await closeClient();
              topicProvider.unregisterStreamHandler?.(sessionKey);
              if (isStreaming(sessionKey)) {
                updateLastMessage(sessionKey, { content: fullContent, thinking: fullThinking || undefined, partial: undefined, streamedAt: undefined });
                endStream(sessionKey);
                broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic?.id, messageId: partialMsg.id });
                if (matchedTopic) updateUnreadCount(matchedTopic.id);
              }
            }
          };

          consumeGateway().catch(err => console.error('[consumeGateway:chat] error:', err));
          return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
        } catch (err: any) {
          if (err.name === "AbortError") return json({ error: "Request timeout (5 min)" }, 504);
          return json({ error: "Gateway unreachable: " + err.message }, 502);
        }
      }
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
      // when the client guess is wrong. We re-check from the DB authoritative
      // copy: only honor the wipe when there's actually ≤1 user message AND
      // ≤1 assistant message stored.
      let clearedForReal = false;
      if (body?.clearMessages) {
        const stored = loadLocalMessages(sessionKey);
        const userCount = stored.filter((m) => m.role === "user").length;
        const assistantCount = stored.filter((m) => m.role === "assistant").length;
        if (userCount <= 1 && assistantCount <= 1) {
          saveLocalMessages(sessionKey, []);
          clearedForReal = true;
        } else {
          console.warn(
            `[Abort] Ignored clearMessages=true for ${sessionKey} — DB has ${userCount} user / ${assistantCount} assistant messages, not first-message`
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

    // --- Edit message (create branch) ---
    {
      const params = matchRoute(pathname, "/api/messages/:id/edit");
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.content) return json({ error: "content required" }, 400);

        const originalMsg = getMessageById(params.id);
        if (!originalMsg) return json({ error: "message not found" }, 404);

        const sessionKey = getMessageSessionKey(params.id);
        if (!sessionKey) return json({ error: "session not found" }, 404);

        const parentId = originalMsg.parentId || null;
        if (!parentId) {
          // Root message edit: create a new root message (sibling)
          // For simplicity, we treat root messages as having parent_id = null
          // and create a sibling with a different branch_index
          const maxOrder = (ctx.db.prepare(`SELECT COALESCE(MAX(sort_order), -1) as max_order FROM messages WHERE session_key = ?`).get(sessionKey) as any).max_order;
          const maxBranch = (ctx.db.prepare(`SELECT COALESCE(MAX(branch_index), -1) as max_idx FROM messages WHERE session_key = ? AND parent_id IS NULL`).get(sessionKey) as any).max_idx;
          const branchIndex = maxBranch + 1;
          const newMsg: any = {
            id: crypto.randomUUID(),
            role: originalMsg.role,
            content: body.content,
            timestamp: new Date().toISOString(),
            parentId: null,
            branchIndex,
          };
          ctx.db.prepare(`
            INSERT INTO messages (id, session_key, role, content, timestamp, sort_order, parent_id, branch_index, partial, plan_status)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL)
          `).run(newMsg.id, sessionKey, newMsg.role, newMsg.content, newMsg.timestamp, maxOrder + 1, branchIndex);
          // Set active branch to this new sibling — use a special key for root siblings
          ctx.db.prepare(`INSERT OR REPLACE INTO active_branches (parent_id, session_key, active_branch_index) VALUES ('__root__', ?, ?)`).run(sessionKey, branchIndex);

          // Now stream a response — reuse the gateway streaming logic
          return await streamEditResponse(sessionKey, newMsg.id, body.content);
        }

        // Create sibling user message under the same parent
        const newUserMsg = createBranchMessage(sessionKey, parentId, "user", body.content);

        // Now stream the assistant response under the new user message
        return await streamEditResponse(sessionKey, newUserMsg.id, body.content);
      }
    }

    // --- Switch branch ---
    {
      const params = matchRoute(pathname, "/api/messages/:id/switch-branch");
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (body?.branchIndex === undefined) return json({ error: "branchIndex required" }, 400);

        const msg = getMessageById(params.id);
        if (!msg) return json({ error: "message not found" }, 404);

        const sessionKey = getMessageSessionKey(params.id);
        if (!sessionKey) return json({ error: "session not found" }, 404);

        const parentId = msg.parentId;
        if (!parentId) {
          // Root message — switch active root branch
          ctx.db.prepare(`INSERT OR REPLACE INTO active_branches (parent_id, session_key, active_branch_index) VALUES ('__root__', ?, ?)`).run(sessionKey, body.branchIndex);
        } else {
          switchActiveBranch(sessionKey, parentId, body.branchIndex);
        }

        // Return the new active thread
        const thread = loadActiveThread(sessionKey);
        return json({ messages: thread });
      }
    }

    // --- History ---
    {
      const sessionKey = matchHistoryRoute(pathname);
      if (sessionKey && (method === "POST" || method === "GET")) {
        const body = method === "POST" ? await readJSON(req) : {};
        const urlParams = new URL(req.url, `http://localhost`).searchParams;
        const limit = body?.limit || parseInt(urlParams.get('limit') || '50');
        const offset = body?.offset || parseInt(urlParams.get('offset') || '0');

        const localMsgs = loadLocalMessages(sessionKey);
        const activeStream = isStreaming(sessionKey);
        // A message is "real" if it has any of: trimmed text content,
        // recorded tool calls, or a populated chronological blocks
        // timeline. Messages with tools-only-no-text were getting nuked
        // by the cleanup pass below — when a stream crashed mid-flight or
        // produced only tool calls (no prose), the message got DELETE'd
        // on the next /api/history request and the user lost their
        // tools on refresh.
        const isRealMessage = (m: StoredMessage) =>
          (m.content && m.content.trim().length > 0) ||
          (m.toolCalls && m.toolCalls.length > 0) ||
          (m.blocks && m.blocks.length > 0);
        // When streaming, keep ALL messages (including empty partials) — filtering them deletes from disk
        const completeMsgs = activeStream
          ? localMsgs
          : localMsgs.filter(m => !m.partial || isRealMessage(m));

        // Clean up stale messages surgically (avoid saveLocalMessages which destroys branch tree)
        if (!activeStream) {
          // Delete empty partial messages — re-parent children first to avoid FK constraint.
          // Preserve messages with tools/blocks even when text is empty.
          const removedIds = localMsgs.filter(m => m.partial && !isRealMessage(m)).map(m => m.id);
          for (const id of removedIds) {
            const parentRow = ctx.db.prepare(`SELECT parent_id FROM messages WHERE id = ?`).get(id) as any;
            const parentId = parentRow?.parent_id || null;
            ctx.db.prepare(`UPDATE messages SET parent_id = ? WHERE parent_id = ?`).run(parentId, id);
            ctx.db.prepare(`DELETE FROM messages WHERE id = ?`).run(id);
          }
          // Clear partial flag on messages with content
          for (const m of completeMsgs) {
            if (m.partial) {
              ctx.db.prepare(`UPDATE messages SET partial = 0 WHERE id = ?`).run(m.id);
              m.partial = false;
            }
          }
        }

        if (completeMsgs.length > 0) {
          const total = completeMsgs.length;
          const sliced = offset > 0 ? completeMsgs.slice(0, Math.max(0, total - offset)) : completeMsgs;
          const result = sliced.slice(-limit);
          const currentStream = isStreaming(sessionKey);

          // Overlay in-memory stream content onto the last assistant message
          if (currentStream) {
            const streamContent = getStreamContent(sessionKey);
            if (streamContent && result.length > 0) {
              const last = result[result.length - 1];
              if (last.role === 'assistant' && last.partial) {
                last.content = streamContent.content;
                if (streamContent.thinking) last.thinking = streamContent.thinking;
              }
            }
          }

          const lastMsg = completeMsgs[completeMsgs.length - 1];
          const hasOrphanedMessage = lastMsg?.role === 'user';
          return json({ messages: result, total, hasOrphanedMessage, isStreaming: !!currentStream, streamState: currentStream ? { startedAt: currentStream.startedAt, isThinking: currentStream.isThinking } : null });
        }

        // Fallback: Provider history
        try {
          const histProvider = providerForSessionKey(sessionKey);
          let data: any;
          if (histProvider.invokeTool) {
            data = await histProvider.invokeTool("sessions_history", { sessionKey, limit: limit + offset, includeTools: false });
          } else if (histProvider.getHistory) {
            data = await histProvider.getHistory(sessionKey, limit + offset);
          }
          const gatewayMessages = data?.result?.messages || data?.result?.details?.messages || [];
          if (gatewayMessages.length > 0) {
            for (const msg of gatewayMessages) {
              if ((msg.role === "user" || msg.role === "assistant") && msg.content) {
                const content = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") : "";
                if (content.trim() && !content.startsWith("[Chat messages since your last reply")) appendLocalMessage(sessionKey, msg.role, content);
              }
            }
            const migrated = loadLocalMessages(sessionKey);
            const total = migrated.length;
            const sliced = offset > 0 ? migrated.slice(0, Math.max(0, total - offset)) : migrated;
            return json({ messages: sliced.slice(-limit), total });
          }
        } catch (err) { console.warn(`[Messages] Gateway migration failed for ${sessionKey}:`, err); }

        // Last resort: JSONL
        try {
          const sessionsStorePath = join(SESSIONS_DIR, "sessions.json");
          if (existsSync(sessionsStorePath)) {
            const store = JSON.parse(readFileSync(sessionsStorePath, "utf-8"));
            const entry = store[sessionKey];
            if (entry?.sessionId) {
              const jsonlPath = join(SESSIONS_DIR, entry.sessionId + ".jsonl");
              if (existsSync(jsonlPath)) {
                const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
                const messages: any[] = [];
                for (const line of lines) {
                  try {
                    const d = JSON.parse(line);
                    if (d.type === "message" && d.message) {
                      const msg = d.message;
                      if (msg.role === "user" || msg.role === "assistant") {
                        let text = "";
                        if (typeof msg.content === "string") text = msg.content;
                        else if (Array.isArray(msg.content)) text = msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
                        if (text.trim() && !text.startsWith("[Chat messages since your last reply")) messages.push({ role: msg.role, content: text, timestamp: d.timestamp });
                      }
                    }
                  } catch {}
                }
                for (const msg of messages) appendLocalMessage(sessionKey, msg.role, msg.content);
                const total = messages.length;
                const sliced = offset > 0 ? messages.slice(0, Math.max(0, total - offset)) : messages;
                return json({ messages: sliced.slice(-limit), total });
              }
            }
          }
        } catch (err) { console.warn(`[Messages] JSONL migration failed for ${sessionKey}:`, err); }

        return json({ messages: [], total: 0 });
      }
    }

    // --- Media serving ---
    if (method === "GET" && pathname === "/api/media") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return json({ error: "path parameter required" }, 400);
      // Prefer the media allowlist for cacheable project media; fall back to
      // resolveProjectPath so sibling images of any openable MD file load.
      // Symmetric with /api/files/content which also uses resolveProjectPath.
      let resolved = ctx.isPathAllowed(resolve(filePath)) ? resolve(filePath) : ctx.resolveProjectPath(filePath);
      if (!resolved) return json({ error: "forbidden: invalid path" }, 403);
      if (!existsSync(resolved)) return new Response("Not Found", { status: 404 });
      const file = Bun.file(resolved);
      const contentType = ctx.getMimeType(resolved);
      return new Response(file, { headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=3600" } });
    }

    // --- Base64 image upload ---
    if (method === "POST" && pathname === "/api/upload-image") {
      try {
        const body = await readJSON(req);
        if (!body?.dataUrl || !body?.mimeType) return json({ error: "dataUrl and mimeType required" }, 400);
        const { dataUrl, mimeType } = body;
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return json({ error: "Invalid data URL format" }, 400);
        const ext = mimeType === "image/png" ? "png" : "jpg";
        mkdirSync(UPLOADS_DIR, { recursive: true });
        const filename = `${Date.now()}-paste.${ext}`;
        const filepath = join(UPLOADS_DIR, filename);
        const buffer = Buffer.from(match[2], "base64");
        writeFileSync(filepath, buffer);
        return json({ url: filepath });
      } catch (err: any) { return json({ error: "Image upload failed: " + err.message }, 500); }
    }

    // --- File upload ---
    if (method === "POST" && pathname === "/api/upload") {
      try {
        const formData = await req.formData();
        const file = formData.get("file");
        if (!file || typeof file === "string") return json({ error: "file required" }, 400);
        mkdirSync(UPLOADS_DIR, { recursive: true });
        const safeName = (file as File).name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const filename = `${Date.now()}-${safeName}`;
        const filepath = join(UPLOADS_DIR, filename);
        const buffer = await (file as File).arrayBuffer();
        writeFileSync(filepath, Buffer.from(buffer));
        return json({ path: filepath, filename: (file as File).name, size: (file as File).size });
      } catch (err: any) { return json({ error: "Upload failed: " + err.message }, 500); }
    }

    // --- Context file deletion ---
    if (method === "DELETE" && pathname === "/api/context-file") {
      const body = await readJSON(req);
      if (!body?.topicId || !body?.filePath) return json({ error: "topicId and filePath required" }, 400);
      const topic = getTopicById(body.topicId);
      if (!topic) return json({ error: "not found" }, 404);
      topic.contextFiles = (topic.contextFiles || []).filter(f => f !== body.filePath);
      topic.updatedAt = new Date().toISOString();
      saveSingleTopic(topic);
      return json({ ok: true });
    }

    // --- Auto-name ---
    {
      const params = matchRoute(pathname, "/api/topics/:id/auto-name");
      if (params && method === "POST") {
        const topic = getTopicById(params.id);
        if (!topic) return json({ error: "not found" }, 404);
        const localMsgs = loadLocalMessages(topic.sessionKey);
        if (localMsgs.length < 2) return json({ error: "Not enough messages yet" }, 400);

        // Detect project path from messages
        let suggestedProject: string | null = null;
        const detectedPath = detectProjectPathFromMessages(localMsgs);
        if (detectedPath && !topic.projectPath) suggestedProject = detectedPath;

        if (suggestedProject) {
          // Re-read inside the conditional so two concurrent autoname runs
          // don't both decide they need to write — whichever lands first
          // sets projectPath, the loser sees the field already populated.
          const freshTopic = getTopicById(params.id);
          if (freshTopic && !freshTopic.projectPath) {
            freshTopic.projectPath = suggestedProject;
            freshTopic.updatedAt = new Date().toISOString();
            saveSingleTopic(freshTopic);
            broadcastToAll({ type: "topic:updated", topic: freshTopic });
          }
        }

        // Background: ask AI for a smart title (single user message to avoid gateway session issues)
        const topicId = params.id;
        const recentMsgs = localMsgs.slice(-4);
        const conversationSummary = recentMsgs.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 150)}`).join('\n');
        (async () => {
          try {
            const aiTopicEarly = getTopicById(topicId);
            const namingProvider = resolveProvider(aiTopicEarly);
            const result = await namingProvider.complete([
              { role: "user", content: `Suggest a short title (3-5 words) and one emoji icon for this conversation. Reply ONLY with valid JSON, nothing else: {"title": "...", "icon": "..."}\n\nConversation:\n${conversationSummary}` },
            ]);
            const content = result.content || "";
            const jsonMatch = content.match(/\{[^}]+\}/);
            if (!jsonMatch) { console.log("[AutoName] AI did not return JSON:", content.slice(0, 100)); return; }
            const parsed = JSON.parse(jsonMatch[0]);
            if (!parsed.title) return;
            // Re-fetch right before write — between the AI call (~seconds) and
            // here the user may have manually renamed the topic; preserve
            // their explicit edit instead of overwriting with the AI guess.
            const aiTopic = getTopicById(topicId);
            if (aiTopic) {
              aiTopic.name = parsed.title;
              if (parsed.icon) aiTopic.icon = parsed.icon;
              aiTopic.slug = slugify(parsed.title);
              aiTopic.updatedAt = new Date().toISOString();
              saveSingleTopic(aiTopic);
              broadcastToAll({ type: "topic:updated", topic: aiTopic });
              console.log(`[AutoName] AI: "${parsed.title}" ${parsed.icon || ''}`);
            }
          } catch (err) { console.warn("[AutoName] AI call failed:", err); }
        })();

        return json({ title: topic.name, icon: topic.icon, suggestedProject });
      }
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
            const topic = Object.values(loadTopics().topics).find(t => t.sessionKey === sessionKey);
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
          default: return json({ error: `Unknown command: ${command}` }, 400);
        }
      } catch (err: any) { return json({ error: `Command failed: ${err.message}` }, 500); }
    }

    // --- Remote Access ---
    if (method === "GET" && pathname === "/api/remote/status") {
      const runCmd = (cmd: string[]) => {
        const result = Bun.spawnSync(cmd, { stderr: "pipe" });
        return result.exitCode === 0 ? result.stdout.toString().trim() : "";
      };
      try {
        try {
          const serveStatus = runCmd(["tailscale", "serve", "status", "--json"]);
          const serve = JSON.parse(serveStatus || '{}');
          const isActive = serve?.TCP?.["3333"] || serve?.Web?.["https://"]?.Handlers?.["/"];
          const tsJson = runCmd(["tailscale", "status", "--json"]);
          const tsStatus = JSON.parse(tsJson || '{}');
          const hostname = (tsStatus?.Self?.DNSName || "").replace(/\.$/, "");
          if (isActive && hostname) return json({ active: true, url: `https://${hostname}`, type: 'tailscale' });
        } catch {}
        try {
          const psResult = Bun.spawnSync(["ps", "aux"], { stderr: "pipe" });
          const procs = psResult.stdout.toString();
          const lines = procs.split("\n").filter(l => /cloudflared|lt |ngrok/.test(l) && !l.includes("grep"));
          const line = lines[0] || "";
          if (line.includes('cloudflared') && line.includes('3333')) return json({ active: true, type: 'cloudflare', url: 'Check cloudflared logs' });
          if (line.includes('ngrok')) {
            try {
              const resp = await fetch("http://localhost:4040/api/tunnels");
              const data = await resp.json() as any;
              const ngrokUrl = data?.tunnels?.[0]?.public_url;
              if (ngrokUrl) return json({ active: true, type: 'ngrok', url: ngrokUrl });
            } catch {}
          }
        } catch {}
        return json({ active: false, type: 'unknown' });
      } catch (err: any) { return json({ active: false, error: err.message }); }
    }

    if (method === "POST" && pathname === "/api/remote/tunnel") {
      try {
        const body = await readJSON(req);
        const action = body?.action;
        if (action === "start") {
          try {
            Bun.spawnSync(["tailscale", "serve", "--bg", "--https=443", "http://localhost:3333"], { stderr: "pipe" });
            Bun.spawnSync(["tailscale", "funnel", "--bg", "443"], { stderr: "pipe" });
            const tsJson = Bun.spawnSync(["tailscale", "status", "--json"], { stderr: "pipe" });
            const tsStatus = JSON.parse(tsJson.stdout.toString() || '{}');
            const hostname = (tsStatus?.Self?.DNSName || "").replace(/\.$/, "");
            return json({ success: true, url: hostname ? `https://${hostname}` : null, message: 'Tailscale Funnel activated' });
          } catch (err: any) { return json({ success: false, error: err.message }, 500); }
        } else if (action === "stop") {
          try {
            Bun.spawnSync(["tailscale", "funnel", "off"], { stderr: "pipe" });
            Bun.spawnSync(["tailscale", "serve", "off"], { stderr: "pipe" });
            return json({ success: true, message: 'Tunnel deactivated' });
          } catch (err: any) { return json({ success: false, error: err.message }, 500); }
        }
        return json({ error: "Invalid action" }, 400);
      } catch (err: any) { return json({ error: err.message }, 500); }
    }

    // --- Processes API ---
    if (method === "GET" && pathname === "/api/processes") {
      const topicId = url.searchParams.get("topicId");
      if (!topicId) return json({ error: "topicId parameter required" }, 400);
      try {
        const procProvider = resolveProvider(loadTopics().topics[topicId]);
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

    // --- Tasks ---
    {
      const params = matchRoute(pathname, "/api/projects/:projectId/tasks");
      if (params && method === "GET") return json({ tasks: loadTasks(params.projectId) });
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.text) return json({ error: "text required" }, 400);
        const maxRow = db.prepare("SELECT COALESCE(MAX(kanban_order), 0) as m FROM tasks WHERE project_id = ?").get(params.projectId) as any;
        const now = new Date().toISOString();
        const task = {
          id: crypto.randomUUID(), text: body.text, description: body.description || null,
          status: body.status || "todo", priority: body.priority ?? 2,
          kanbanOrder: (maxRow?.m ?? 0) + 1,
          assignedTo: null, dueDate: null,
          chatId: body.chatId || null, createdAt: now, completedAt: null, updatedAt: now,
        };
        saveTask(params.projectId, task);
        broadcastToAll({ type: "task:created", projectId: params.projectId, task });
        return json(task, 201);
      }
    }

    {
      const params = matchRoute(pathname, "/api/projects/:projectId/tasks/:taskId");
      if (params && method === "PATCH") {
        const body = await readJSON(req);
        if (!body) return json({ error: "body required" }, 400);
        const row = db.prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?").get(params.taskId, params.projectId) as any;
        if (!row) return json({ error: "Task not found" }, 404);
        const task = {
          id: row.id, text: row.text, description: row.description,
          status: row.status, priority: row.priority, kanbanOrder: row.kanban_order,
          assignedTo: row.assigned_to, dueDate: row.due_date,
          chatId: row.chat_id, createdAt: row.created_at, completedAt: row.completed_at,
          updatedAt: new Date().toISOString(),
        };
        if (body.text !== undefined) task.text = body.text;
        if (body.description !== undefined) task.description = body.description;
        if (body.status !== undefined) { task.status = body.status; task.completedAt = body.status === "done" ? new Date().toISOString() : null; }
        if (body.priority !== undefined) task.priority = body.priority;
        if (body.kanbanOrder !== undefined) task.kanbanOrder = body.kanbanOrder;
        if (body.assignedTo !== undefined) task.assignedTo = body.assignedTo;
        if (body.dueDate !== undefined) task.dueDate = body.dueDate;
        saveTask(params.projectId, task);
        broadcastToAll({ type: "task:updated", projectId: params.projectId, task });
        return json(task);
      }
      if (params && method === "DELETE") {
        const row = db.prepare("SELECT id FROM tasks WHERE id = ? AND project_id = ?").get(params.taskId, params.projectId);
        if (!row) return json({ error: "Task not found" }, 404);
        db.prepare("DELETE FROM tasks WHERE id = ?").run(params.taskId);
        broadcastToAll({ type: "task:deleted", projectId: params.projectId, taskId: params.taskId });
        return json({ ok: true });
      }
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
        return errorResponse(e);
      }
    }

    return null;
  };
}
