import { readFileSync, existsSync, watch } from "fs";
import { join } from "path";
import type { AppContext, RouteHandler } from "../types";

export interface AgentSession {
  key: string;
  kind: "main" | "group" | "cron" | "hook" | "node" | "subagent" | "other";
  channel: string;
  displayName: string;
  status: "active" | "idle" | "completed" | "error";
  model?: string;
  updatedAt: number;
  sessionId?: string;
  totalTokens?: number;
  contextTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  abortedLastRun?: boolean;
  lastMessage?: string;
  topicId?: string;
  topicName?: string;
}

function parseSessionKey(key: string): { kind: AgentSession["kind"]; channel: string; displayName: string } {
  // agent:main:main
  if (key === "agent:main:main" || key.endsWith(":main")) {
    return { kind: "main", channel: "webchat", displayName: "Main" };
  }
  // agent:main:telegram:direct:<id>
  if (key.includes(":telegram:direct:")) {
    const id = key.split(":telegram:direct:")[1];
    return { kind: "main", channel: "telegram", displayName: `Telegram DM ${id?.slice(-4) || ""}` };
  }
  // agent:main:telegram:group:<id>
  if (key.includes(":telegram:group:")) {
    return { kind: "group", channel: "telegram", displayName: "TG Group" };
  }
  // agent:main:discord:channel:<id>
  if (key.includes(":discord:channel:")) {
    return { kind: "group", channel: "discord", displayName: "Discord" };
  }
  // agent:main:subagent:<uuid>
  if (key.includes(":subagent:")) {
    return { kind: "subagent", channel: "internal", displayName: "Sub-agent" };
  }
  // cron:<id>
  if (key.startsWith("cron:")) {
    return { kind: "cron", channel: "internal", displayName: "Cron" };
  }
  // hook:<id>
  if (key.startsWith("hook:")) {
    return { kind: "hook", channel: "internal", displayName: "Webhook" };
  }
  // topic:<id> — Topics app sessions
  if (key.startsWith("topic:")) {
    return { kind: "main", channel: "webchat", displayName: "Topic" };
  }
  return { kind: "other", channel: "unknown", displayName: key.split(":").pop() || key };
}

function deriveStatus(updatedAt: number, abortedLastRun?: boolean): AgentSession["status"] {
  if (abortedLastRun) return "error";
  const ageMs = Date.now() - updatedAt;
  if (ageMs < 30_000) return "active";
  return "idle";
}

export function createAgentsRouter(ctx: AppContext): RouteHandler {
  const { GATEWAY_URL, GATEWAY_TOKEN, SESSIONS_DIR, TOPICS_FILE, json, broadcastToAll, loadTopics } = ctx;

  // Cached sessionKey -> topicId/topicName map (invalidated on topic changes)
  let cachedTopicMap: Record<string, { topicId: string; topicName: string; topicIcon: string }> | null = null;

  function invalidateTopicMapCache() {
    cachedTopicMap = null;
  }

  // Watch topics.json for changes to invalidate cache
  if (existsSync(TOPICS_FILE)) {
    try {
      watch(TOPICS_FILE, () => { invalidateTopicMapCache(); });
    } catch {}
  }

  function buildSessionTopicMap(): Record<string, { topicId: string; topicName: string; topicIcon: string }> {
    if (cachedTopicMap) return cachedTopicMap;
    const data = loadTopics();
    const map: Record<string, { topicId: string; topicName: string; topicIcon: string }> = {};
    for (const topic of Object.values(data.topics)) {
      if (topic.sessionKey) {
        map[topic.sessionKey] = { topicId: topic.id, topicName: topic.name, topicIcon: topic.icon };
      }
    }
    cachedTopicMap = map;
    return map;
  }

  // Fast path: read sessions.json directly
  function readSessionsFile(): Record<string, any> | null {
    const sessionsPath = join(SESSIONS_DIR, "sessions.json");
    if (!existsSync(sessionsPath)) return null;
    try {
      return JSON.parse(readFileSync(sessionsPath, "utf-8"));
    } catch {
      return null;
    }
  }

  function formatSessions(store: Record<string, any>, activeMinutes: number): AgentSession[] {
    const cutoff = Date.now() - activeMinutes * 60 * 1000;
    const topicMap = buildSessionTopicMap();
    const sessions: AgentSession[] = [];

    for (const [key, entry] of Object.entries(store)) {
      if (!entry || typeof entry !== "object") continue;
      const updatedAt = entry.updatedAt || entry.lastActivity || 0;
      if (updatedAt < cutoff) continue;

      const parsed = parseSessionKey(key);
      const topicInfo = topicMap[key];

      sessions.push({
        key,
        kind: parsed.kind,
        channel: parsed.channel,
        displayName: entry.displayName || topicInfo?.topicName || parsed.displayName,
        status: deriveStatus(updatedAt, entry.abortedLastRun),
        model: entry.model,
        updatedAt,
        sessionId: entry.sessionId,
        totalTokens: entry.totalTokens,
        contextTokens: entry.contextTokens,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        abortedLastRun: entry.abortedLastRun,
        topicId: topicInfo?.topicId,
        topicName: topicInfo?.topicName,
      });
    }

    // Also include activeStreams from Topics app
    for (const [sessionKey, stream] of ctx.activeStreams.entries()) {
      if (!sessions.some(s => s.key === sessionKey)) {
        const parsed = parseSessionKey(sessionKey);
        const topicInfo = topicMap[sessionKey];
        sessions.push({
          key: sessionKey,
          kind: parsed.kind,
          channel: parsed.channel,
          displayName: topicInfo?.topicName || parsed.displayName,
          status: "active",
          updatedAt: new Date(stream.lastActivity).getTime(),
          topicId: topicInfo?.topicId,
          topicName: topicInfo?.topicName,
        });
      } else {
        // Update status to active if streaming
        const existing = sessions.find(s => s.key === sessionKey);
        if (existing) existing.status = "active";
      }
    }

    // Sort: active first, then by updatedAt desc
    sessions.sort((a, b) => {
      const statusOrder = { active: 0, idle: 1, error: 2, completed: 3 };
      const orderDiff = (statusOrder[a.status] || 3) - (statusOrder[b.status] || 3);
      if (orderDiff !== 0) return orderDiff;
      return b.updatedAt - a.updatedAt;
    });

    return sessions;
  }

  // Watch sessions.json for changes and broadcast (with debounce)
  const sessionsPath = join(SESSIONS_DIR, "sessions.json");
  let lastSessionsHash = "";
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  if (existsSync(sessionsPath)) {
    try {
      watch(sessionsPath, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          try {
            const store = readSessionsFile();
            if (!store) return;
            const sortedKeys = Object.keys(store).sort();
            const hash = JSON.stringify(sortedKeys.map(k => `${k}:${store[k]?.updatedAt || 0}`));
            if (hash === lastSessionsHash) return;
            lastSessionsHash = hash;
            const sessions = formatSessions(store, 120);
            broadcastToAll({ type: "agents:sessions", sessions });
          } catch (err) {
            console.warn("[Agents] Error processing sessions.json change:", err);
          }
        }, 300);
      });
    } catch (err) {
      console.warn("[Agents] Could not watch sessions.json:", err);
    }
  }

  return async function agentsRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // POST /api/agents/spawn — launch a new sub-agent
    if (method === "POST" && pathname === "/api/agents/spawn") {
      try {
        const body = await req.json() as { topicId: string; task: string; model?: string; label?: string };
        if (!body.topicId || !body.task) {
          return json({ error: "topicId and task are required" }, 400);
        }

        // Look up the topic's sessionKey
        const data = loadTopics();
        const topic = data.topics[body.topicId];
        if (!topic) {
          return json({ error: "Topic not found" }, 404);
        }

        const args: Record<string, any> = {
          task: body.task,
          parentSessionKey: topic.sessionKey,
        };
        if (body.model) args.model = body.model;

        const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` },
          body: JSON.stringify({ tool: "sessions_spawn", args }),
        });

        if (!resp.ok) {
          const text = await resp.text();
          return json({ error: text || "Gateway error" }, resp.status);
        }

        const result = await resp.json() as any;
        const sessionKey = result?.result?.sessionKey || result?.sessionKey || null;

        // Broadcast session update so all clients see the new agent
        broadcastToAll({ type: "agents:spawned", topicId: body.topicId, sessionKey, label: body.label || body.task.slice(0, 50) });

        return json({ ok: true, sessionKey, label: body.label || body.task.slice(0, 50) });
      } catch (err: any) {
        console.error("[Agents] Spawn error:", err);
        return json({ error: err.message || "Spawn failed" }, 500);
      }
    }

    // POST /api/agents/sessions/:key/stop — stop a running agent session
    const stopMatch = pathname.match(/^\/api\/agents\/sessions\/(.+)\/stop$/);
    if (method === "POST" && stopMatch) {
      const sessionKey = decodeURIComponent(stopMatch[1]);
      try {
        const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` },
          body: JSON.stringify({ tool: "sessions_stop", args: { sessionKey } }),
        });

        if (!resp.ok) {
          const text = await resp.text();
          return json({ error: text || "Gateway error" }, resp.status);
        }

        broadcastToAll({ type: "agents:stopped", sessionKey });
        return json({ ok: true });
      } catch (err: any) {
        console.error("[Agents] Stop error:", err);
        return json({ error: err.message || "Stop failed" }, 500);
      }
    }

    // GET /api/agents/sessions/:key/history?limit=100 — fetch conversation history for a session
    const historyMatch = pathname.match(/^\/api\/agents\/sessions\/(.+)\/history$/);
    if (method === "GET" && historyMatch) {
      const sessionKey = decodeURIComponent(historyMatch[1]);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1), 500);
      try {
        const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` },
          body: JSON.stringify({ tool: "sessions_history", args: { sessionKey, limit, includeTools: false } }),
        });

        if (!resp.ok) {
          const text = await resp.text();
          return json({ error: text || "Gateway error" }, resp.status);
        }

        const data = await resp.json() as any;
        const rawMessages = data?.result?.messages || data?.messages || [];
        const messages = rawMessages.map((m: any) => ({
          id: m.id,
          role: m.role,
          content: typeof m.content === "string" ? m.content : "",
          timestamp: m.timestamp || m.createdAt,
          thinking: m.thinking,
          toolCalls: m.toolCalls,
          media: m.media,
        }));

        return json({ messages });
      } catch (err: any) {
        console.error("[Agents] Session history error:", err);
        return json({ error: err.message || "Failed to fetch history" }, 500);
      }
    }

    // GET /api/agents/sessions?activeMinutes=120&messages=0
    if (method === "GET" && pathname === "/api/agents/sessions") {
      const activeMinutes = Math.min(Math.max(parseInt(url.searchParams.get("activeMinutes") || "120", 10) || 120, 1), 10080);
      const includeMessages = url.searchParams.get("messages") === "1";

      // Try fast path first (direct file read)
      const store = readSessionsFile();
      if (store) {
        const sessions = formatSessions(store, activeMinutes);

        // If messages requested, enrich via gateway
        if (includeMessages && sessions.length > 0) {
          try {
            const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` },
              body: JSON.stringify({ tool: "sessions_list", args: { activeMinutes, messageLimit: 1 } }),
            });
            if (resp.ok) {
              const data = await resp.json() as any;
              const gatewaySessions = data?.result?.sessions || [];
              for (const gs of gatewaySessions) {
                const match = sessions.find(s => s.key === gs.key);
                if (match && gs.messages?.[0]) {
                  const msg = gs.messages[0];
                  const text = typeof msg.content === "string" ? msg.content : "";
                  match.lastMessage = text.slice(0, 150);
                }
              }
            }
          } catch (err) {
            console.warn("[Agents] Failed to enrich sessions from gateway:", err);
          }
        }

        return json({ sessions });
      }

      // Fallback: use gateway
      try {
        const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` },
          body: JSON.stringify({ tool: "sessions_list", args: { activeMinutes, messageLimit: includeMessages ? 1 : 0 } }),
        });
        if (!resp.ok) return json({ sessions: [] });

        const data = await resp.json() as any;
        const gatewaySessions = data?.result?.sessions || [];
        const topicMap = buildSessionTopicMap();
        const sessions: AgentSession[] = gatewaySessions.map((gs: any) => {
          const parsed = parseSessionKey(gs.key);
          const topicInfo = topicMap[gs.key];
          return {
            key: gs.key,
            kind: parsed.kind,
            channel: gs.channel || parsed.channel,
            displayName: gs.displayName || topicInfo?.topicName || parsed.displayName,
            status: deriveStatus(gs.updatedAt, gs.abortedLastRun),
            model: gs.model,
            updatedAt: gs.updatedAt,
            sessionId: gs.sessionId,
            totalTokens: gs.totalTokens,
            contextTokens: gs.contextTokens,
            inputTokens: gs.inputTokens,
            outputTokens: gs.outputTokens,
            abortedLastRun: gs.abortedLastRun,
            lastMessage: gs.messages?.[0]?.content?.slice?.(0, 150),
            topicId: topicInfo?.topicId,
            topicName: topicInfo?.topicName,
          };
        });
        return json({ sessions });
      } catch (err) {
        console.warn("[Agents] Gateway fallback failed:", err);
        return json({ sessions: [] });
      }
    }

    return null;
  };
}
