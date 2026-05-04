import { join, resolve } from "path";
import type { ServerWebSocket } from "bun";
import type { WSData } from "./server/types";
import { createAppContext } from "./server/utils";
import { closeDatabase } from "./server/db";
import {
  acquireLock, releaseLock, writeState, readState,
  uptimeMsSince, LiveLockError,
} from "./server/services/daemon-state";
import {
  startUiStateBackupTicker, snapshotUiStateNow,
} from "./server/services/ui-state-backup";
import { purgeOrphanTopicRefs } from "./server/services/ui-state-orphan-cleanup";
import { createTopicsRouter } from "./server/routes/topics";
import { createFilesRouter } from "./server/routes/files";
import { createBrowserRouter } from "./server/routes/browser";
import { createCronRouter } from "./server/routes/cron";
import { createContextRouter } from "./server/routes/context";
import { createTerminalRouter, handleTerminalWebSocket, disconnectBridge } from "./server/routes/terminal";
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
import { getGatewayWS } from "./server/gateway-ws";
import { initProvider, recomputeDefault, getDefaultProviderName } from "./server/providers";
import { createAgentApiRouter } from "./server/routes/agent-api";
import { createProcessesRouter } from "./server/routes/processes";
import { createPushRouter } from "./server/routes/push";
import { createUiStateRouter, loadAllUiState, assertUiStateMigrationApplied } from "./server/routes/ui-state";
import { createProvidersRouter } from "./server/routes/providers";
import { createProjectsRouter } from "./server/routes/projects";
import { createWorktreesRouter } from "./server/routes/worktrees";
import { createMachinesRouter } from "./server/routes/machines";
import { initVapid } from "./server/push-service";
import { startHeartbeatChecker } from "./server/agent-heartbeat";

// Gateway token: .env takes priority, falls back to reading from ~/.openclaw/openclaw.json
if (!process.env.GATEWAY_TOKEN) {
  try {
    const { readFileSync } = require("fs");
    const { join } = require("path");
    const config = JSON.parse(readFileSync(join(process.env.HOME || "", ".openclaw", "openclaw.json"), "utf-8"));
    if (config?.gateway?.auth?.token) {
      process.env.GATEWAY_TOKEN = config.gateway.auth.token;
      console.log("[Startup] GATEWAY_TOKEN loaded from ~/.openclaw/openclaw.json");
    }
  } catch {}
  if (!process.env.GATEWAY_TOKEN) {
    console.error("ERROR: GATEWAY_TOKEN not found in .env or ~/.openclaw/openclaw.json");
    process.exit(1);
  }
}

// Create app context (initializes SQLite database)
const ctx = createAppContext(import.meta.dir);
const { PORT, PUBLIC_DIR, wsClients, broadcastToAll, broadcastToTopic, broadcast,
  loadTopics, saveTopics, loadUnread, saveUnread, loadLocalMessages, saveLocalMessages,
  isStreaming, activeStreams, getMimeType, logRequest, db } = ctx;

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

// Init AI provider (wraps gateway for openclaw, or uses Anthropic SDK for standalone)
const aiProvider = initProvider({
  type: (process.env.AI_PROVIDER as any) || (process.env.GATEWAY_URL ? 'openclaw' : process.env.ANTHROPIC_API_KEY ? 'claude' : 'openclaw'),
  ...(process.env.GATEWAY_URL ? {
    gatewayUrl: ctx.GATEWAY_URL,
    token: ctx.GATEWAY_TOKEN,
    refreshToken: () => ctx.refreshGatewayToken(),
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
const openclawContextRouter = aiProvider.name === 'openclaw' ? createOpenClawContextRouter(ctx) : null;
const boardsRouter = createBoardsRouter(ctx);
const tagsRouter = createTagsRouter(ctx);
const approvalsRouter = createApprovalsRouter(ctx);
const agentProfilesRouter = createAgentProfilesRouter(ctx);
const webhooksRouter = createWebhooksRouter(ctx);
const dashboardRouter = createDashboardRouter(ctx);
const agentApiRouter = createAgentApiRouter(ctx);
const processesRouter = createProcessesRouter(ctx);
const pushRouter = createPushRouter(ctx);
const uiStateRouter = createUiStateRouter(ctx);
const providersRouter = createProvidersRouter(ctx);
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
startHeartbeatChecker(db, broadcastToAll);

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

const server = Bun.serve<WSData>({
  port: PORT,
  hostname: "0.0.0.0",
  reusePort: true,
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
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }
    if (method === "GET" && pathname.endsWith(".html")) {
      const file = Bun.file(join(PUBLIC_DIR, pathname));
      if (await file.exists()) return new Response(file, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
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
      const filePath = join(import.meta.dir, "uploads", pathname.slice("/uploads/".length));
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
      // Security: ensure resolved path stays within media directory
      if (resolve(filePath).startsWith(resolve(mediaBase))) {
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

    // Route through handlers
    if (isApiRequest) {
      const response = await agentApiRouter(req, url, pathname, method)
        || await topicsRouter(req, url, pathname, method)
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
        || await spacesRouter(req, url, pathname, method)
        || (openclawContextRouter && await openclawContextRouter(req, url, pathname, method))
        || await boardsRouter(req, url, pathname, method)
        || await approvalsRouter(req, url, pathname, method)
        || await tagsRouter(req, url, pathname, method)
        || await agentProfilesRouter(req, url, pathname, method)
        || await webhooksRouter(req, url, pathname, method)
        || await dashboardRouter(req, url, pathname, method)
        || await processesRouter(req, url, pathname, method)
        || await pushRouter(req, url, pathname, method)
        || await uiStateRouter(req, url, pathname, method)
        || await providersRouter(req, url, pathname, method)
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
      { const __ui = loadAllUiState(db); ws.send(JSON.stringify({ type: "ui-state:init", data: __ui.data, meta: __ui.meta })); }
      // Initial provider snapshot — keeps the picker / settings page in sync without an extra HTTP fetch.
      try {
        const { getSnapshotManager } = require("./server/providers/snapshot-manager") as typeof import("./server/providers/snapshot-manager");
        ws.send(JSON.stringify({ type: "providers:snapshot", snapshot: getSnapshotManager().getSnapshot() }));
      } catch {
        // Snapshot manager not loaded yet — initial bootstrap will broadcast once it warms up.
      }

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
      // Remove from client set FIRST so concurrent isTopicFocused() iterations
      // don't see this ws at all. Clear focusedTopicId after as defense-in-depth
      // in case any ref to this ws object lingers elsewhere.
      wsClients.delete(ws);
      ws.data.focusedTopicId = null;
      console.log(`[WS] Client disconnected: ${ws.data.id} (total: ${wsClients.size})`);
    },
  },
});

// Stale stream cleanup
const STALE_STREAM_CHECK_INTERVAL_MS = 30_000;
const STALE_STREAM_TIMEOUT_MS = 3 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [sessionKey, stream] of activeStreams.entries()) {
    if (!activeStreams.has(sessionKey)) continue;
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

const proto = useTls ? "https" : "http";
const wsProto = useTls ? "wss" : "ws";
console.log(`🚀 Topics App running at ${proto}://localhost:${PORT}`);
console.log(`📡 WebSocket available at ${wsProto}://localhost:${PORT}/ws`);
if (useTls) console.log(`🔒 TLS enabled (cert: ${tlsCert})`);
console.log(`🌐 BrowserService available (lazy Chromium, WebSocket at /ws/browser/:id)`);

// Phase B · DAEMON-01: finalise state file once Bun.serve owns a port.
// `server.port` reflects the *actual* port (Bun resolves 0 → ephemeral).
const daemonState = writeState(server.port);
console.log(`[Daemon] state written → pid=${daemonState.pid} port=${daemonState.port}`);

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n[Shutdown] Received ${signal}, closing browser service...`);
  clearInterval(heartbeatTimer);
  stopUiStateBackup();
  disconnectBridge(); // Disconnect from bridge — bridge daemon stays alive, PTY sessions persist
  await browserService.close();
  closeDatabase();
  releaseLock();
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
