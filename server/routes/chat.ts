/**
 * Chat streaming engine — the POST /api/chat handler, extracted verbatim from
 * the topics.ts god-file. This is the streaming chat-proxy core: resolve the
 * topic/provider, assemble context, open an SSE writer, drive the provider
 * stream (WS-preferred with an HTTP-SSE fallback), dispatch inline markers
 * (browser / topic-switch / project) and server-side browser tool calls, track
 * soft/hard inactivity timeouts, persist blocks/tool-calls, and finalize the
 * assistant message.
 *
 * Pattern mirrors edit.ts/history.ts/autoname.ts: a dependency-injected
 * sub-router instantiated INSIDE createTopicsRouter, receiving the closure-local
 * helpers it needs (see ChatDeps) by reference. The only SHARED mutable state it
 * touches is `browserNavigatedTopics` (the localhost-auto-navigate dedupe Set),
 * passed in as the same instance so the dedupe contract still spans the marker
 * helper + the open-pane route. Behaviour is a verbatim move — only the route
 * dispatch wrapper changed.
 */
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { AppContext, ContentBlock, RouteHandler, ToolCall, Topic } from "../types";
import { getProvider, type AIProvider, type ChatMessage, type StreamHandler } from "../providers";
import { deriveToolDetail } from "../providers/claude/tool-detail";
import { getSnapshotManager } from "../providers/snapshot-manager";
import { getFastModelFor } from "../providers/fast-models";
import { appendUsageRecord } from "../usage/store";
import { calculateCost } from "../usage/pricing";
import { parseMentions, resolveMentions } from "../mention-parser";
import type { BrowserService } from "../browser-service";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { browserTools } from "../browser-tools";
import { isPassthroughProvider } from "../browser-tools-adapters";
import { dispatchBrowserToolCall, resolveContextIdForTopic } from "../browser-tool-dispatcher";
import {
  controlTools,
  isControlTool,
  dispatchControlToolCall,
  ControlToolError,
  type ControlDispatchDeps,
} from "../control-tools";
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
import { STREAM_SLOW_ANNOTATION, computeCleanBroadcastDelta, stripSlowAnnotation } from "./stream-markers";

/**
 * Closure-local helpers from createTopicsRouter that the /api/chat block needs,
 * injected by reference (they keep their own closures, so their transitive deps
 * stay in topics.ts). `browserNavigatedTopics` is shared mutable state — pass
 * the SAME Set instance the marker helper + open-pane route use.
 */
export interface ChatDeps {
  resolveProvider: (topic?: Topic | null) => AIProvider;
  detectLocalhostAutoNav: (content: string, topic: Topic | null) => string;
  bindTopicToProject: (topicId: string, targetDir: string, opts?: { focus?: boolean }) => boolean;
  resolveProjectRef: (ref: string, opts?: { trustRawPaths?: boolean }) => string | null;
  getProjectIdForTopic: (topicId: string) => string | null;
  getWorkspaceProjects: () => string[];
  autoBindProject: (topic: Topic) => void;
  watchSessionForSubagents: (topicId: string, sessionKey: string) => void;
  updateUnreadCount: (topicId: string) => void;
  browserNavigatedTopics: Set<string>;
  WORKSPACE_DIR: string;
}

export function createChatRouter(ctx: AppContext, deps: ChatDeps, browserService?: BrowserService): RouteHandler {
  const {
    broadcastToAll, broadcastToTopicSubscribers, db, json, readJSON,
    getTopicBySessionKey,
    appendLocalMessage,
    createPartialMessage, updateLastMessage, addToolCallToLastMessage, updateToolCallResult, updateToolCallFields,
    startStream, updateStreamContent, endStream, isStreaming,
    findNewMediaFiles, updateLastMessageWithMedia,
  } = ctx;
  const {
    resolveProvider, detectLocalhostAutoNav, bindTopicToProject, resolveProjectRef,
    getProjectIdForTopic, getWorkspaceProjects, autoBindProject,
    watchSessionForSubagents, updateUnreadCount, browserNavigatedTopics, WORKSPACE_DIR,
  } = deps;

  // Deps for the SDK-passthrough control tools (open/create-project, switch/new-
  // topic). Reuses the SAME closure-local project helpers + AppContext topic
  // ops the Layer-1 endpoints use, so a claude/openai tool call and an MCP tool
  // call land on identical side-effects + broadcasts.
  const controlDispatchDeps: ControlDispatchDeps = {
    getTopicById: ctx.getTopicById,
    loadTopics: ctx.loadTopics,
    saveSingleTopic: ctx.saveSingleTopic,
    slugify: ctx.slugify,
    broadcastToAll,
    resolveProjectRef,
    bindTopicToProject,
    workspaceDir: WORKSPACE_DIR,
  };

  return async function chatRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {
    if (method === "POST" && pathname === "/api/chat") {
      console.log(`[HTTP] POST /api/chat received`);
      const body = await readJSON(req);
      if (!body) return json({ error: "body required" }, 400);
      const sessionKey = body.sessionKey;
      // O(1) UNIQUE-index lookup — replaces a full topics scan per chat send.
      const matchedTopic = getTopicBySessionKey(sessionKey);
      // Reset browser navigate tracking for this topic so new URLs can trigger
      if (matchedTopic) browserNavigatedTopics.delete(matchedTopic.id);
      const planMode = body.planMode === true;
      // Fast Mode: per-turn flag OR per-topic persisted preference. Either is
      // enough to opt in. Resolution into an actual model id happens after
      // provider resolution below (the mapping is provider-dependent).
      const fastModeRequested = body.fastMode === true;
      const messages = body.messages;
      if (!messages || !Array.isArray(messages) || messages.length === 0) return json({ error: "messages array required" }, 400);

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
                      // Bind to current topic + open the project window.
                      if (matchedTopic) bindTopicToProject(matchedTopic.id, targetDir, { focus: true });
                      response = `Created project **${safeName}** at \`${targetDir}\` and bound to this topic.`;
                    }
                  }
                } else if (sub === "open" && arg) {
                  // Resolve against the user's real Topics projects, not just the workspace.
                  // Explicit local user command → raw absolute/~ paths are trusted.
                  const targetDir = resolveProjectRef(arg, { trustRawPaths: true });
                  if (!targetDir) {
                    response = `Project not found: \`${arg}\``;
                  } else {
                    const projectName = targetDir.split("/").pop() || arg;
                    if (matchedTopic) bindTopicToProject(matchedTopic.id, targetDir, { focus: true });
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
            // Per-turn flag OR topic-persisted preference — either opts in.
            // Mirrors the resolution logic for `fastModeActive` further down
            // (the route layer is the single authority on whether fast is on).
            fastMode: body.fastMode === true || matchedTopic.fastMode === true,
            // Lean envelope on a dispatcher resume/continuation (contextMode
            // "lean"), but ONLY when the session already has stored turns — a
            // resume onto an empty/lost conversation must re-ground with the
            // full envelope, not a bare role prompt.
            leanContext: body.contextMode === "lean" && ctx.loadLocalMessages(sessionKey).length > 0,
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
      const finalMessages: ChatMessage[] = [
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

      // ─── Fast Mode model resolution (openspec change `chat-fast-mode`) ───
      //
      // Fast Mode is the "soft default": it kicks in only when nothing more
      // explicit was set. The user can still override with the per-message
      // picker (`body.model`) or by persisting a topic-level model
      // (`matchedTopic.model`); both win over Fast.
      //
      // Two opt-in paths:
      //   1. `body.fastMode === true` — per-turn flag from the composer.
      //   2. `matchedTopic.fastMode === true` — persisted per-topic preference
      //      (synced across windows). Either is sufficient.
      //
      // `getFastModelFor` is snapshot-aware: when the statically-mapped id
      // isn't in the live model list (e.g. codex bumped a slug), it falls
      // back to a heuristic (haiku → mini → flash) so fast mode doesn't
      // silently no-op on a CLI/SDK version change.
      const fastModeActive = fastModeRequested || matchedTopic?.fastMode === true;
      if (fastModeActive) {
        if (overrideModel) {
          // Picker / topic.model already set an explicit choice. Honour it
          // and log so users can audit *why* their fast toggle "didn't work".
          console.info(
            `[Chat] Fast mode requested but explicit model "${overrideModel}" takes precedence ` +
            `for provider "${topicProvider.name}" — fast mapping skipped.`,
          );
        } else {
          const snap = getSnapshotManager().getSnapshot();
          const entry = snap.providers.find(p => p.name === topicProvider.name);
          const available = entry?.models ?? [];
          const fastModel = getFastModelFor(topicProvider.name, available);
          if (fastModel === null) {
            // Either provider has no fast-model mapping (e.g. openclaw → null)
            // OR the snapshot was non-empty and no heuristic matched. Both
            // cases: delegate to the provider's default, log the reason.
            const isGatewayDelegate = available.length > 0;
            console.info(
              isGatewayDelegate
                ? `[Chat] Fast mode requested but no fast-tier model found in snapshot for ` +
                  `"${topicProvider.name}" (have: [${available.slice(0, 5).join(", ")}]) — falling back to default.`
                : `[Chat] Fast mode requested for provider "${topicProvider.name}" — no fast-model mapping; ` +
                  `delegating routing to the provider/gateway.`,
            );
          } else {
            overrideModel = fastModel;
            console.info(
              `[Chat] Fast mode active — using "${fastModel}" for provider "${topicProvider.name}".`,
            );
          }
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
          // Carry-over tail for the localhost auto-nav scan: instead of
          // re-scanning the whole accumulated fullContent every delta (O(n²) over
          // a stream), we scan only `carry + newDelta` where `carry` holds the
          // last few chars of what we already scanned — enough to catch a
          // `localhost:PORT` URL split across two chunks (max ~22 chars).
          let localhostScanCarry = "";
          // Cumulative marker-stripped content that has already been broadcast
          // to clients. Delta to broadcast on each chunk =
          //   currentMarkerStrippedFullContent - lastBroadcastClean
          // This closes the chunk-split + post-marker-tail leak (delta carrying
          // `…}} now check it out` after the close arrives) that pure regex
          // strip on `newText` cannot. See CLOSED_MARKER_REGEX comment above.
          let lastBroadcastClean = "";
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
          // 1 min soft: surface the "sta rallentando" cue after a minute of PURE
          // silence (the timer already suspends while tool calls run, so this
          // only counts genuine no-output gaps), instead of a 2-min apparent
          // freeze. Harmless if a healthy-but-slow turn trips it — the slow
          // annotation is stripped the moment output resumes (resetStreamTimer
          // recovery). Grace (recovery window) and the hard cap are unchanged.
          const STREAM_TIMEOUT_MS = 60_000;        // 1 min soft
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
            // Abort the underlying provider turn too. `unregisterStreamHandler` is
            // a no-op for providers that don't implement it (e.g. ClaudeCodeProvider),
            // so without this the spawned process keeps running and later fires
            // `onDone` → a second finalizeStream (now guarded) and, worse, a frozen
            // per-session turn queue. Mirrors `/api/chat/abort` in topics.ts.
            topicProvider.abort?.(sessionKey)?.catch((err: any) => console.warn(`[StreamWS] Provider abort on grace-expiry failed:`, err));
            if (matchedTopic) {
              broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: timeoutMsg });
              broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: partialMsg.id });
              updateUnreadCount(matchedTopic.id);
            }
            // No separate "grace expired" log line — the soft-timeout entry
            // already exists; recovery would have logged on the way out.
            // Failing to recover IS the absence of a recovery log entry.
            writeSSE("[DONE]").then(() => closeClient())
              .catch((err) => console.warn(`[StreamWS] DONE/close on grace-expiry failed:`, err));
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
            // See handleGraceExpiry: abort the orphaned provider turn (no-op
            // unregister otherwise leaves the process running).
            topicProvider.abort?.(sessionKey)?.catch((err: any) => console.warn(`[StreamWS] Provider abort on hard-timeout failed:`, err));
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
            writeSSE("[DONE]").then(() => closeClient())
              .catch((err) => console.warn(`[StreamWS] DONE/close on hard-timeout failed:`, err));
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

          // Helper: finalize the stream (called on done/error/abort)
          const finalizeStream = async (reason: "done" | "error" | "aborted", errorMsg?: string) => {
            // Idempotent. A timeout path (handleGraceExpiry/handleHardTimeout) may
            // have already finalized and aborted this stream; a late provider
            // callback — `onDone` from an orphaned turn, or `onAborted` from the
            // abort() those handlers now issue — must not re-persist content or
            // re-broadcast to clients that already closed the stream out.
            if (streamState === "finalized") return;
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

            // (Topic switching is now a tool — `switch_topic`/`new_topic` —
            // which switches the UI mid-turn; the old marker path's message
            // migration to the target topic was removed with the markers.)

            // Media detection
            setTimeout(async () => {
              try {
                const newMedia = await findNewMediaFiles(requestStartMs);
                if (newMedia.length > 0 && sessionKey) {
                  updateLastMessageWithMedia(sessionKey, newMedia);
                  broadcastToAll({ type: "message:media", sessionKey, topicId: matchedTopic?.id, media: newMedia });
                }
              } catch {}
            }, 1000);

            if (matchedTopic && !matchedTopic.projectPath) {
              setTimeout(() => {
                try {
                  autoBindProject(matchedTopic!);
                } catch (err) {
                  console.error("[AutoBind] failed:", err);
                }
              }, 500);
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

                // Topic/project/browser are now driven by tools, not markers.
                // The only surviving heuristic is auto-opening the browser pane
                // when the model mentions a localhost:PORT dev server in prose.
                // Scan only the new delta plus a small carry-over tail (a URL can
                // straddle two chunks) — not the whole accumulated fullContent.
                const localhostScanWindow = localhostScanCarry + newText;
                detectLocalhostAutoNav(localhostScanWindow, matchedTopic);
                // Keep enough trailing context for a `localhost:PORT` split across
                // the boundary (`http://localhost:65535` ≈ 22 chars).
                localhostScanCarry = localhostScanWindow.slice(-24);

                // Broadcast clean content as a true delta against the cumulative
                // marker-stripped state. See computeCleanBroadcastDelta() for
                // the three observable cases this handles (closed marker
                // spanning chunks, close+tail in same chunk, multiple markers
                // in one chunk). Unit-tested in
                // server/routes/topics-marker-strip.test.ts.
                const { cumulativeClean, delta: deltaToBroadcast } =
                  computeCleanBroadcastDelta(fullContent, lastBroadcastClean);
                lastBroadcastClean = cumulativeClean;
                if (deltaToBroadcast) {
                  const chunk = { type: "stream:content_chunk", sessionKey, topicId: matchedTopic?.id, content: deltaToBroadcast };
                  if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, chunk);
                  else broadcastToAll(chunk);
                  writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { content: deltaToBroadcast } }] }));
                }
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
              const thinkingChunk = { type: "stream:thinking_chunk", sessionKey, topicId: matchedTopic?.id, content: text };
              if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, thinkingChunk);
              else broadcastToAll(thinkingChunk);
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

                    // Close the tool→UI loop: browser_open navigates Playwright server-side,
                    // but until now nothing opened the user-visible pane. Broadcast the same
                    // `browser:navigate` event the legacy `{{BROWSER:url}}` marker path emits
                    // (see detectAndBroadcastBrowserMarker above) so usePaneOrdering's WS
                    // listener (client/src/components/Layout/hooks/usePaneOrdering.ts) opens
                    // or focuses the pane and navigates it. Also seed browserNavigatedTopics
                    // so the localhost fallback at line 443+ doesn't fire a duplicate
                    // navigate when the model later mentions the same URL in plain text.
                    if (name === 'browser_open' && matchedTopic) {
                      const urlArg = typeof (args as any)?.url === 'string' ? (args as any).url : undefined;
                      // Prefer the resolved URL the handler returns (final URL after any
                      // redirects). Fall back to the input URL if the result shape changes.
                      const resolvedUrl = (result && typeof (result as any).url === 'string')
                        ? (result as any).url as string
                        : urlArg;
                      if (resolvedUrl) {
                        // contextId so the visible pane registers under the SAME id
                        // the SDK browser_* tools resolve to (resolveContextIdForTopic),
                        // not a random one → no invisible Playwright phantom.
                        broadcastToAll({ type: "browser:navigate", topicId: matchedTopic.id, contextId: resolveContextIdForTopic(matchedTopic), url: resolvedUrl });
                        browserNavigatedTopics.add(matchedTopic.id);
                      }
                    }
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

              // SDK-passthrough control tools (open/create-project, switch/new-topic
              // — the tool-shaped successors to the {{PROJECT_*}}/{{TOPIC_*}} markers).
              // Same in-turn flow as the browser dispatch above: run the side-effect
              // in-process (reuses the closure-local project helpers + AppContext
              // topic ops), then feed the confirmation (or error) back through the
              // shared onToolResult update path so the chat UI shows the normal
              // running→success/error lifecycle. Fire-and-forget: single-turn SDK
              // providers don't need the result back to continue.
              if (isControlTool(name) && matchedTopic) {
                dispatchControlToolCall(name, args || {}, matchedTopic, controlDispatchDeps)
                  .then((confirmation) => {
                    updateToolCallResult(sessionKey, toolCallId, confirmation);
                    updateBlockTool(toolCallId, { status: 'success', result: confirmation });
                    broadcastToAll({ type: 'stream:tool_result', sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'success', result: confirmation });
                    writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_result: { id: toolCallId, status: 'success', result: confirmation } } }] }));
                    const idx = trackedToolCallIds.indexOf(toolCallId);
                    if (idx >= 0) trackedToolCallIds.splice(idx, 1);
                  })
                  .catch((err: unknown) => {
                    const msg = err instanceof ControlToolError ? err.message : (err instanceof Error ? err.message : String(err));
                    console.warn(`[control-tool] ${name} failed: ${msg}`);
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

            onUserInputRequired: (toolCallId, _toolName, schema) => {
              // A tool paused the stream to ask the user a question. The
              // detector in `server/providers/ask-user-detector.ts` already
              // validated the shape; here we just (1) mutate the on-disk
              // ToolCall row to flip status + persist the schema so a mid-
              // pause refresh re-renders the form, (2) update the chat
              // blocks timeline in-memory for the current stream, and
              // (3) broadcast a typed WS event so connected clients open
              // the form immediately. The soft inactivity timer stays
              // suspended naturally because `trackedToolCallIds` still
              // contains this id — see the `running` invariant in
              // `stream-timer.test.ts`.
              updateToolCallFields(sessionKey, toolCallId, {
                status: 'waiting_for_input',
                userInputSchema: schema,
              });
              updateBlockTool(toolCallId, {
                status: 'waiting_for_input',
                userInputSchema: schema,
              });
              broadcastToAll({
                type: 'stream:tool_user_input_required',
                sessionKey,
                topicId: matchedTopic?.id,
                toolCallId,
                schema,
              });
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
                    if (extra) {
                      const extraChunk = { type: "stream:content_chunk", sessionKey, topicId: matchedTopic?.id, content: extra };
                      if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, extraChunk);
                      else broadcastToAll(extraChunk);
                    }
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
            //
            // Also register the control tools (open/create-project, switch/new-topic
            // — the tool-shaped successors to the {{PROJECT_*}}/{{TOPIC_*}} markers;
            // spec: replace-markers-with-tools). Unlike browserTools these don't need
            // browserService, so a passthrough provider always gets AI-initiated
            // control even in a build without the browser pane.
            if (isPassthroughProvider(topicProvider.name)) {
              sendOptions.tools = [
                ...(browserService ? browserTools : []),
                ...controlTools,
              ];
            }
            // Fire-and-forget: kick off sendChat WITHOUT awaiting so the
            // Response can be returned immediately. The provider's stream
            // for-await loop drives handler callbacks → writeSSE → flushes
            // deltas live to the client. Awaiting here would buffer the
            // whole stream into the TransformStream and release it all at
            // once when the Response is finally returned.
            // Reattach mode (ai-bridge restart recovery): adopt the turn still
            // running in the broker and drive it to completion, instead of
            // starting a new one. No user message is sent; everything else
            // (handler, partial row, SSE, finalize) is reused. Falls back to a
            // normal send when the provider has no reattach (flag off / other providers).
            const reattachFn = (topicProvider as unknown as { reattach?: (sk: string, h: StreamHandler) => Promise<string> }).reattach;
            const drive = (body.mode === "reattach" && typeof reattachFn === "function")
              ? reattachFn.call(topicProvider, sessionKey, handler).then((outcome) => ({ runId: outcome }))
              : topicProvider.sendChat(
                  sessionKey,
                  userContent,
                  handler,
                  Object.keys(sendOptions).length > 0 ? sendOptions : undefined,
                );
            drive.then((result) => {
              topicProvider.registerStreamHandler?.(sessionKey, result.runId, handler);
              console.log(`[StreamWS] chat.send OK for ${sessionKey}, runId: ${result.runId}`);
            }).catch(async (err: any) => {
              console.error(`[StreamWS] chat.send failed for ${sessionKey}:`, err);
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
            const content = data?.choices?.[0]?.message?.content || "";
            detectLocalhostAutoNav(content, matchedTopic);
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
                if (isInThinking) { const cleaned = content.replace(/<\/?thinking>/g, ''); fullThinking += cleaned; const tc = { type: "stream:thinking_chunk", sessionKey, topicId: matchedTopic?.id, content: cleaned }; if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, tc); else broadcastToAll(tc); }
                else { const cleaned = content.replace(/<\/?thinking>/g, ''); if (cleaned) { fullContent += cleaned; const cc = { type: "stream:content_chunk", sessionKey, topicId: matchedTopic?.id, content: cleaned }; if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, cc); else broadcastToAll(cc); } }
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

    return null;
  };
}
