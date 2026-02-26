import { join, resolve } from "path";
import type { ServerWebSocket } from "bun";
import type { WSData } from "./server/types";
import { createAppContext } from "./server/utils";
import { closeDatabase } from "./server/db";
import { createTopicsRouter } from "./server/routes/topics";
import { createFilesRouter } from "./server/routes/files";
import { createBrowserRouter } from "./server/routes/browser";
import { createCronRouter } from "./server/routes/cron";
import { createContextRouter } from "./server/routes/context";
import { createTerminalRouter, handleTerminalWebSocket } from "./server/routes/terminal";
import { createStatusRouter } from "./server/routes/status";
import { createMemoryRouter } from "./server/routes/memory";
import { createUsageRouter } from "./server/routes/usage";
import { initUsageStore, rebuildSummary } from "./server/usage/store";
import { createAgentsRouter } from "./server/routes/agents";
import { createCheckpointsRouter } from "./server/routes/checkpoints";
import { createSpacesRouter } from "./server/routes/spaces";
import { createOpenClawContextRouter } from "./server/routes/openclaw-context";
import { createBrowserService, type BrowserService } from "./server/browser-service";
import { ActivityMonitor } from "./server/activity-monitor";
import { createActivityRouter } from "./server/routes/activity";
import { JournalCollector } from "./server/journal-collector";
import { createJournalRouter } from "./server/routes/journal";
import { createBoardsRouter } from "./server/routes/boards";
import { createTagsRouter } from "./server/routes/tags";
import { createApprovalsRouter } from "./server/routes/approvals";
import { createAgentProfilesRouter } from "./server/routes/agent-profiles";
import { createWebhooksRouter } from "./server/routes/webhooks";
import { createDashboardRouter } from "./server/routes/dashboard";
import { createAgentApiRouter } from "./server/routes/agent-api";
import { startHeartbeatChecker } from "./server/agent-heartbeat";

// Validate required environment variables
if (!process.env.GATEWAY_TOKEN) {
  console.error("ERROR: GATEWAY_TOKEN environment variable is required");
  process.exit(1);
}

// Create app context (initializes SQLite database)
const ctx = createAppContext(import.meta.dir);
const { PORT, PUBLIC_DIR, wsClients, broadcastToAll, broadcastToTopic, broadcast,
  loadTopics, saveTopics, loadUnread, saveUnread, loadLocalMessages, saveLocalMessages,
  isStreaming, activeStreams, getMimeType, logRequest, db } = ctx;

// Init browser service (lazy — Chromium launched on first use)
const browserService = await createBrowserService();

// Init usage tracking (still uses JSON files — will be migrated in a future phase)
initUsageStore(import.meta.dir);
rebuildSummary();

// Create route handlers
const topicsRouter = createTopicsRouter(ctx, browserService);
const filesRouter = createFilesRouter(ctx);
const browserRouter = createBrowserRouter(ctx, browserService);
const cronRouter = createCronRouter(ctx);
const contextRouter = createContextRouter(ctx);
const terminalRouter = createTerminalRouter(ctx);
const statusRouter = createStatusRouter(ctx);
const memoryRouter = createMemoryRouter(ctx);
const usageRouter = createUsageRouter(ctx);
const agentsRouter = createAgentsRouter(ctx);
const checkpointsRouter = createCheckpointsRouter(ctx);
const spacesRouter = createSpacesRouter(ctx);
const openclawContextRouter = createOpenClawContextRouter(ctx);
const boardsRouter = createBoardsRouter(ctx);
const tagsRouter = createTagsRouter(ctx);
const approvalsRouter = createApprovalsRouter(ctx);
const agentProfilesRouter = createAgentProfilesRouter(ctx);
const webhooksRouter = createWebhooksRouter(ctx);
const dashboardRouter = createDashboardRouter(ctx);
const agentApiRouter = createAgentApiRouter(ctx);
// Start agent heartbeat checker
startHeartbeatChecker(db);

// Init activity monitor (watches gateway log files)
const activityMonitor = new ActivityMonitor();
const activityRouter = createActivityRouter(ctx, activityMonitor);

// Init journal collector (polls gateway for daily summaries)
const journalCollector = new JournalCollector(import.meta.dir, ctx.GATEWAY_URL, ctx.GATEWAY_TOKEN);
journalCollector.start();
const journalRouter = createJournalRouter(ctx, journalCollector);

const WS_HEARTBEAT_INTERVAL_MS = 30000;
const WS_TIMEOUT_MS = 90000;

// WebSocket heartbeat
setInterval(() => {
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

const server = Bun.serve<WSData>({
  port: PORT,
  hostname: "0.0.0.0",
  reusePort: true,
  idleTimeout: 255,

  async fetch(req, server) {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;
    const startTime = Date.now();
    const isApiRequest = pathname.startsWith("/api/");
    if (isApiRequest) console.log(`[HTTP] → ${method} ${pathname}`);

    // WebSocket upgrade - terminal
    if (pathname.startsWith("/ws/terminal/")) {
      const termId = pathname.split("/ws/terminal/")[1];
      const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), focusedTopicId: null, lastPong: Date.now(), terminalId: termId } });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // WebSocket upgrade
    if (pathname === "/ws") {
      const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), focusedTopicId: null, lastPong: Date.now() } });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Static files
    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return new Response(Bun.file(join(PUBLIC_DIR, "index.html")), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }
    if (method === "GET" && pathname.endsWith(".html")) {
      const file = Bun.file(join(PUBLIC_DIR, pathname));
      if (await file.exists()) return new Response(file, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }
    if (method === "GET" && (pathname.startsWith("/assets/") || pathname.startsWith("/icons/") || pathname === "/vite.svg" || pathname === "/manifest.json" || pathname === "/sw.js")) {
      const filePath = join(PUBLIC_DIR, pathname);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        const cacheControl = pathname === "/manifest.json" || pathname === "/sw.js" ? "no-cache" : "public, max-age=31536000, immutable";
        return new Response(file, { headers: { "Content-Type": getMimeType(filePath), "Cache-Control": cacheControl } });
      }
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

    // Route through handlers
    if (isApiRequest) {
      const response = await agentApiRouter(req, url, pathname, method)
        || await topicsRouter(req, url, pathname, method)
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
        || await spacesRouter(req, url, pathname, method)
        || await openclawContextRouter(req, url, pathname, method)
        || await boardsRouter(req, url, pathname, method)
        || await approvalsRouter(req, url, pathname, method)
        || await tagsRouter(req, url, pathname, method)
        || await agentProfilesRouter(req, url, pathname, method)
        || await webhooksRouter(req, url, pathname, method)
        || await dashboardRouter(req, url, pathname, method)
;

      if (response) return response;
      logRequest(method, pathname, 404, startTime);
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    maxPayloadLength: 1024 * 1024,
    open(ws) {
      ws.data.lastPong = Date.now();
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
      ws.send(JSON.stringify({ type: "unread:init", data: loadUnread() }));

      // Send catch-up for any active streams so new clients can join mid-stream
      const topicsData = loadTopics();
      for (const [sessionKey, stream] of activeStreams.entries()) {
        let topicId: string | undefined;
        for (const t of Object.values(topicsData.topics)) { if (t.sessionKey === sessionKey) { topicId = t.id; break; } }
        ws.send(JSON.stringify({
          type: "stream:catchup",
          sessionKey,
          topicId,
          messageId: stream.messageId,
          content: stream.content,
          thinking: stream.thinking,
          isThinking: stream.isThinking,
        }));
      }
    },
    message(ws, message) {
      ws.data.lastPong = Date.now();
      const handler = ws.data._termHandler;
      if (handler) { handler.message(message); return; }
      try {
        const data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
        if (data.type === "focus") ws.data.focusedTopicId = data.topicId;
        if (data.type === "typing") broadcastToTopic(data.topicId, { type: "typing", topicId: data.topicId, clientId: ws.data.id, text: data.text || '' }, ws);
        if (data.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
        if (data.type === "drag:start") broadcast({ type: "drag:start", topicId: data.topicId, sourceWindowId: data.windowId }, ws);
        if (data.type === "drag:end") broadcast({ type: "drag:end", topicId: data.topicId, sourceWindowId: data.windowId }, ws);
        if (data.type === "drag:drop") broadcastToAll({ type: "drag:accepted", topicId: data.topicId, targetWindowId: data.windowId, sourceWindowId: data.sourceWindowId });
      } catch (err) { console.warn(`[WS] Failed to parse message from ${ws.data.id}:`, err); }
    },
    pong(ws) { ws.data.lastPong = Date.now(); },
    close(ws) {
      const handler = ws.data._termHandler;
      if (handler) { handler.close(); return; }
      wsClients.delete(ws); console.log(`[WS] Client disconnected: ${ws.data.id} (total: ${wsClients.size})`);
    },
  },
});

// Stale stream cleanup
const STALE_STREAM_CHECK_INTERVAL_MS = 30_000;
const STALE_STREAM_TIMEOUT_MS = 3 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [sessionKey, stream] of activeStreams.entries()) {
    const lastActivity = new Date(stream.lastActivity).getTime();
    if (now - lastActivity > STALE_STREAM_TIMEOUT_MS) {
      console.log(`[StaleStream] Auto-clearing stale stream for ${sessionKey}`);
      // Finalize partial messages via SQLite
      db.run("UPDATE messages SET partial = 0, streamed_at = NULL WHERE session_key = ? AND partial = 1", sessionKey);
      const topicsData = loadTopics();
      let topicId: string | undefined;
      for (const t of Object.values(topicsData.topics)) { if (t.sessionKey === sessionKey) { topicId = t.id; break; } }
      broadcastToAll({ type: "stream:end", sessionKey, topicId, reason: "stale_timeout" });
      activeStreams.delete(sessionKey);
    }
  }
}, STALE_STREAM_CHECK_INTERVAL_MS);

console.log(`🚀 Topics App running at http://localhost:${PORT}`);
console.log(`📡 WebSocket available at ws://localhost:${PORT}/ws`);
console.log(`🌐 BrowserService available (lazy Chromium, WebSocket at /ws/browser/:id)`);

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[Shutdown] Closing browser service...");
  await browserService.close();
  closeDatabase();
  process.exit(0);
});
