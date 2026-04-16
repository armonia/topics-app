import type { AppContext, RouteHandler } from "../types";
import { spawn, execFile } from "child_process";
import { resolve, join } from "path";
import { createInterface } from "readline";
import { getDatabase } from "../db";
import { tmpdir } from "os";
import { writeFile } from "fs/promises";
import { createHash } from "crypto";
import net from "net";
import fs from "fs";

interface TerminalSession {
  id: string;
  name: string;
  createdAt: string;
  cwd: string;
  command: string;
  cols: number;
  rows: number;
  topicId?: string;
  type: 'shell' | 'claude-code';
  skipPermissions: boolean;
  claudeSessionId?: string;
}

const sessions = new Map<string, TerminalSession>();
const sessionSockets = new Map<string, Set<any>>();

// --- Bridge connection (Unix domain socket) ---
let bridgeSocket: net.Socket | null = null;
let bridgeReady = false;
let bridgeConnecting = false;
let bridgeReadyResolvers: (() => void)[] = [];

// Pending buffer requests: sessionId -> callback
const pendingBufferRequests = new Map<string, ((data: Uint8Array) => void)[]>();

function getSocketPath(): string {
  const projectDir = process.cwd();
  const hash = createHash('md5').update(projectDir).digest('hex').slice(0, 8);
  return `/tmp/topics-pty-bridge-${hash}.sock`;
}

const SOCKET_PATH = getSocketPath();

async function ensureBridge(): Promise<void> {
  if (bridgeReady && bridgeSocket && !bridgeSocket.destroyed) return;
  if (bridgeConnecting) {
    // Wait for the in-flight connection attempt
    return new Promise<void>((resolve) => { bridgeReadyResolvers.push(resolve); });
  }

  bridgeConnecting = true;

  try {
    // Try connecting to existing bridge
    const connected = await tryConnect();
    if (connected) {
      bridgeConnecting = false;
      bridgeReadyResolvers.forEach(r => r());
      bridgeReadyResolvers = [];
      return;
    }

    // No bridge running — spawn one
    const bridgePath = resolve(import.meta.dir, "../pty-bridge.mjs");
    const child = spawn("node", [bridgePath, "--socket", SOCKET_PATH], {
      detached: true,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.unref();

    // Wait for bridge to create socket (poll up to 3 seconds)
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
      if (fs.existsSync(SOCKET_PATH)) {
        const ok = await tryConnect();
        if (ok) break;
      }
    }

    if (!bridgeReady) {
      throw new Error("Failed to connect to PTY bridge after spawning");
    }
  } finally {
    bridgeConnecting = false;
    bridgeReadyResolvers.forEach(r => r());
    bridgeReadyResolvers = [];
  }
}

function tryConnect(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(SOCKET_PATH)) { resolve(false); return; }

    const socket = net.connect(SOCKET_PATH, () => {
      bridgeSocket = socket;
      bridgeReady = true;
      setupSocketReader(socket);
      console.log("[Terminal] Connected to PTY bridge daemon");
      resolve(true);
    });

    socket.on('error', () => {
      resolve(false);
    });

    // Timeout after 1 second
    setTimeout(() => {
      if (!bridgeReady) {
        socket.destroy();
        resolve(false);
      }
    }, 1000);
  });
}

function setupSocketReader(socket: net.Socket) {
  const rl = createInterface({ input: socket });
  rl.on("line", (line: string) => {
    try {
      handleBridgeMessage(JSON.parse(line));
    } catch {}
  });

  socket.on('close', () => {
    bridgeReady = false;
    bridgeSocket = null;
    console.log("[Terminal] Bridge socket closed, will reconnect on next use");
    // Auto-reconnect after a short delay
    setTimeout(() => {
      ensureBridge().catch(() => {});
    }, 500);
  });

  socket.on('error', () => {
    bridgeReady = false;
    bridgeSocket = null;
  });
}

function sendToBridge(msg: any) {
  if (!bridgeSocket || bridgeSocket.destroyed) {
    throw new Error("Bridge not connected");
  }
  bridgeSocket.write(JSON.stringify(msg) + "\n");
}

function handleBridgeMessage(msg: any) {
  switch (msg.type) {
    case "created": {
      // Session created in bridge — no special handling needed
      break;
    }
    case "data": {
      const session = sessions.get(msg.id);
      if (!session) break;
      // Forward to connected WebSocket clients (buffer is in bridge)
      const sockets = sessionSockets.get(msg.id);
      if (sockets) {
        for (const ws of sockets) {
          try { ws.send(msg.data); } catch { sockets.delete(ws); }
        }
      }
      break;
    }
    case "exit": {
      const exitedSession = sessions.get(msg.id);
      sessions.delete(msg.id);
      const sockets = sessionSockets.get(msg.id);
      if (sockets) {
        for (const ws of sockets) {
          try { ws.close(1000, "Session ended"); } catch {}
        }
        sessionSockets.delete(msg.id);
      }
      if (exitedSession) {
        // Preserve claude-code sessions with a claudeSessionId so the user can
        // click "Resume" and relaunch claude with --resume <sessionId>. Dormant
        // rows are garbage-collected after 1h by the existing cleanup logic.
        const canResume = exitedSession.type === 'claude-code' && !!exitedSession.claudeSessionId;
        try {
          if (canResume) {
            getDatabase().run("UPDATE terminal_sessions SET status = 'dormant' WHERE id = ?", [msg.id]);
          } else {
            getDatabase().run("DELETE FROM terminal_sessions WHERE id = ?", [msg.id]);
          }
        } catch {}
      }
      broadcastTerminalSessions();
      break;
    }
    case "list": {
      // Response to reconciliation request — handled by reconcileSessions
      handleListResponse(msg.sessions || []);
      break;
    }
    case "buffer": {
      // Response to buffer request
      const callbacks = pendingBufferRequests.get(msg.id);
      if (callbacks) {
        const data = msg.data ? Buffer.from(msg.data, 'base64') : new Uint8Array(0);
        for (const cb of callbacks) cb(new Uint8Array(data));
        pendingBufferRequests.delete(msg.id);
      }
      break;
    }
  }
}

// --- Session reconciliation ---
let reconcileResolver: ((sessions: { id: string; pid: number }[]) => void) | null = null;

function handleListResponse(bridgeSessions: { id: string; pid: number }[]) {
  if (reconcileResolver) {
    reconcileResolver(bridgeSessions);
    reconcileResolver = null;
  }
}

async function reconcileSessions() {
  // Get bridge's live sessions
  const bridgeSessions = await new Promise<{ id: string; pid: number }[]>((resolve) => {
    reconcileResolver = resolve;
    sendToBridge({ type: "list" });
    // Timeout after 2 seconds
    setTimeout(() => {
      if (reconcileResolver) {
        reconcileResolver([]);
        reconcileResolver = null;
      }
    }, 2000);
  });

  const bridgeIds = new Set(bridgeSessions.map(s => s.id));

  // Get DB sessions
  const db = getDatabase();
  const dbRows = db.query("SELECT * FROM terminal_sessions").all() as any[];
  const dbIds = new Set(dbRows.map((r: any) => r.id));

  // Bridge has session + DB has it → restore in-memory entry
  for (const row of dbRows) {
    if (bridgeIds.has(row.id)) {
      // Session is alive in bridge — just add to in-memory map
      if (!sessions.has(row.id)) {
        sessions.set(row.id, {
          id: row.id,
          name: row.name,
          createdAt: row.created_at || new Date().toISOString(),
          cwd: row.cwd,
          command: row.command,
          cols: row.cols || 120,
          rows: row.rows || 30,
          topicId: row.topic_id || undefined,
          type: row.type || 'shell',
          skipPermissions: row.skip_permissions !== 0,
          claudeSessionId: row.claude_session_id || undefined,
        });
        sessionSockets.set(row.id, new Set());
        console.log(`[Terminal] Reattached to surviving session ${row.id} (${row.type})`);
      }
    }
  }

  // Bridge has session, DB doesn't → orphaned, kill it
  for (const bs of bridgeSessions) {
    if (!dbIds.has(bs.id)) {
      console.log(`[Terminal] Killing orphaned bridge session ${bs.id}`);
      sendToBridge({ type: "kill", id: bs.id });
    }
  }

  // DB has session, bridge doesn't → recreate or remove
  for (const row of dbRows) {
    if (!bridgeIds.has(row.id)) {
      if (row.type === 'claude-code' && row.claude_session_id) {
        // Claude Code session — recreate with --resume
        console.log(`[Terminal] Recreating claude-code session ${row.id} with --resume`);
        try {
          createSession(
            row.id, row.name, row.cwd, undefined,
            row.cols || 120, row.rows || 30,
            row.topic_id || undefined, 'claude-code',
            row.skip_permissions !== 0, row.claude_session_id,
          );
        } catch (err: any) {
          console.warn(`[Terminal] Failed to recreate session ${row.id}: ${err.message}`);
          try { db.run("DELETE FROM terminal_sessions WHERE id = ?", [row.id]); } catch {}
        }
      } else {
        // Shell session — mark dormant instead of deleting.
        // Client can revive it (creates new PTY in same cwd) or it gets cleaned up after 1h.
        console.log(`[Terminal] Marking shell session ${row.id} as dormant`);
        try { db.run("UPDATE terminal_sessions SET status = 'dormant' WHERE id = ?", [row.id]); } catch {}
      }
    }
  }
}

// --- Buffer request from bridge ---
function requestBuffer(sessionId: string): Promise<Uint8Array> {
  return new Promise((resolve) => {
    if (!bridgeReady) { resolve(new Uint8Array(0)); return; }
    const existing = pendingBufferRequests.get(sessionId) || [];
    existing.push(resolve);
    pendingBufferRequests.set(sessionId, existing);
    sendToBridge({ type: "buffer", id: sessionId });
    // Timeout after 1 second
    setTimeout(() => {
      const cbs = pendingBufferRequests.get(sessionId);
      if (cbs) {
        for (const cb of cbs) cb(new Uint8Array(0));
        pendingBufferRequests.delete(sessionId);
      }
    }, 1000);
  });
}

// --- Session management ---
function createSession(id: string, name: string, cwd: string, command?: string, cols = 120, rows = 30, topicId?: string, sessionType: 'shell' | 'claude-code' = 'shell', skipPermissions = true, claudeSessionId?: string): TerminalSession {
  let file: string;
  let args: string[];

  let resolvedClaudeSessionId = claudeSessionId;
  if (sessionType === 'claude-code' && !resolvedClaudeSessionId) {
    resolvedClaudeSessionId = crypto.randomUUID();
  }

  if (sessionType === 'claude-code') {
    file = 'claude';
    args = [];
    if (claudeSessionId) {
      args.push('--resume', claudeSessionId);
    } else if (resolvedClaudeSessionId) {
      args.push('--session-id', resolvedClaudeSessionId);
    }
    if (skipPermissions) args.push('--dangerously-skip-permissions');
  } else if (command) {
    const parts = command.split(" ");
    file = parts[0];
    args = parts.slice(1);
  } else {
    file = process.env.SHELL || "/bin/zsh";
    args = ["-l"];
  }

  let env: Record<string, string | null> | undefined;
  if (sessionType === 'claude-code') {
    const home = process.env.HOME || '';
    const extraPaths = [`${home}/.local/bin`, `${home}/.bun/bin`, '/opt/homebrew/bin'];
    const currentPath = process.env.PATH || '/usr/local/bin';
    const augmentedPath = [...extraPaths, currentPath].filter(Boolean).join(':');
    env = { CLAUDECODE: null, PATH: augmentedPath };
  }

  sendToBridge({ type: "create", id, shell: file, args, cwd, cols, rows, ...(env ? { env } : {}) });

  const session: TerminalSession = {
    id,
    name,
    createdAt: new Date().toISOString(),
    cwd,
    command: sessionType === 'claude-code' ? 'claude' : (command || file),
    cols,
    rows,
    topicId,
    type: sessionType,
    skipPermissions,
    claudeSessionId: resolvedClaudeSessionId,
  };

  sessions.set(id, session);
  sessionSockets.set(id, new Set());

  try {
    getDatabase().run(
      `INSERT OR REPLACE INTO terminal_sessions (id, name, cwd, command, type, topic_id, cols, rows, skip_permissions, created_at, claude_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, cwd, session.command, sessionType, topicId || null, cols, rows, skipPermissions ? 1 : 0, session.createdAt, resolvedClaudeSessionId || null]
    );
  } catch {}

  return session;
}

// Broadcast current terminal sessions list via WS
let _broadcastToAll: ((msg: any) => void) | null = null;
function broadcastTerminalSessions() {
  if (!_broadcastToAll) return;
  const list = Array.from(sessions.values()).map(s => ({
    id: s.id, name: s.name, createdAt: s.createdAt, cwd: s.cwd,
    command: s.command, clients: sessionSockets.get(s.id)?.size || 0,
    topicId: s.topicId, type: s.type,
  }));
  _broadcastToAll({ type: 'terminal:sessions', sessions: list });
}

export function createTerminalRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON, errorResponse, matchRoute } = ctx;
  _broadcastToAll = ctx.broadcastToAll;

  // Connect to bridge and reconcile sessions (async, fire-and-forget)
  ensureBridge()
    .then(() => reconcileSessions())
    .then(() => broadcastTerminalSessions())
    .catch((err) => console.error("[Terminal] Bridge init failed:", err.message));

  return async function terminalRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    if (method === "GET" && pathname === "/api/terminal/sessions") {
      // Lazy cleanup: delete dormant sessions older than 1 hour
      try {
        const db = getDatabase();
        db.run("DELETE FROM terminal_sessions WHERE status = 'dormant' AND datetime(created_at) < datetime('now', '-1 hour')");
      } catch {}

      const filterTopicId = url.searchParams.get('topicId');
      let values = Array.from(sessions.values());
      if (filterTopicId) {
        values = values.filter(s => s.topicId === filterTopicId);
      }
      const list = values.map(s => ({
        id: s.id, name: s.name, createdAt: s.createdAt, cwd: s.cwd,
        command: s.command, clients: sessionSockets.get(s.id)?.size || 0,
        topicId: s.topicId, type: s.type,
        claudeSessionId: s.claudeSessionId || null,
      }));
      return json(list);
    }

    if (method === "POST" && (pathname === "/api/terminal/sessions" || pathname === "/api/terminal/create")) {
      const body = await readJSON(req).catch(() => ({}));
      const cwd = body.cwd || process.env.HOME || "/";
      const id = crypto.randomUUID();
      const name = body.name || `Terminal ${sessions.size + 1}`;
      const command = body.command || undefined;
      const cols = body.cols || 120;
      const rows = body.rows || 30;
      const topicId = body.topicId || undefined;
      const sessionType = body.type === 'claude-code' ? 'claude-code' : 'shell';
      const skipPermissions = body.skipPermissions !== false;

      try {
        await ensureBridge();
        const session = createSession(id, name, cwd, command, cols, rows, topicId, sessionType, skipPermissions);
        broadcastTerminalSessions();
        return json({ id, name, cwd, command: session.command, createdAt: session.createdAt, topicId: session.topicId, type: session.type, claudeSessionId: session.claudeSessionId || null });
      } catch (err: any) {
        return errorResponse(500, `Failed to create terminal: ${err.message}`);
      }
    }

    const sendMatch = matchRoute(pathname, "/api/terminal/sessions/:id/send");
    if (method === "POST" && sendMatch) {
      const session = sessions.get(sendMatch.id);
      if (!session) return errorResponse(404, "Terminal session not found");
      const body = await readJSON(req).catch(() => ({}));
      const input = body.input || body.text || body.data || "";
      if (!input) return errorResponse(400, "No input provided");
      sendToBridge({ type: "write", id: sendMatch.id, data: input });
      return json({ ok: true, sent: input.length });
    }

    const resizeMatch = matchRoute(pathname, "/api/terminal/sessions/:id/resize") || matchRoute(pathname, "/api/terminal/:id/resize");
    if (method === "POST" && resizeMatch) {
      const session = sessions.get(resizeMatch.id);
      if (!session) return errorResponse(404, "Terminal session not found");
      const body = await readJSON(req).catch(() => ({}));
      const { cols, rows } = body;
      if (cols && rows) {
        session.cols = cols;
        session.rows = rows;
        sendToBridge({ type: "resize", id: resizeMatch.id, cols, rows });
      }
      return json({ ok: true });
    }

    const deleteMatch = matchRoute(pathname, "/api/terminal/sessions/:id") || matchRoute(pathname, "/api/terminal/:id");
    if (method === "DELETE" && deleteMatch) {
      const session = sessions.get(deleteMatch.id);
      // Always try to clean up the DB row — the session may be dormant (PTY exited
      // but row kept alive for Resume), in which case `session` is not in memory.
      const db = getDatabase();
      const dbRow = db.query("SELECT id FROM terminal_sessions WHERE id = ?").get(deleteMatch.id) as any;
      if (!session && !dbRow) return errorResponse(404, "Terminal session not found");
      if (session) {
        sendToBridge({ type: "kill", id: deleteMatch.id });
        sessions.delete(deleteMatch.id);
        const sockets = sessionSockets.get(deleteMatch.id);
        if (sockets) {
          for (const ws of sockets) {
            try { ws.close(1000, "Session killed"); } catch {}
          }
        }
        sessionSockets.delete(deleteMatch.id);
      }
      try { db.run("DELETE FROM terminal_sessions WHERE id = ?", [deleteMatch.id]); } catch {}
      broadcastTerminalSessions();
      return json({ ok: true });
    }

    // --- Dormant sessions: list and revive ---

    if (method === "GET" && pathname === "/api/terminal/sessions/dormant") {
      const db = getDatabase();
      const cwd = url.searchParams.get('cwd');
      const rows = cwd
        ? db.query("SELECT * FROM terminal_sessions WHERE status = 'dormant' AND cwd = ?").all(cwd) as any[]
        : db.query("SELECT * FROM terminal_sessions WHERE status = 'dormant'").all() as any[];
      const list = rows.map((r: any) => ({
        id: r.id, name: r.name, cwd: r.cwd, command: r.command,
        type: r.type, createdAt: r.created_at,
        claudeSessionId: r.claude_session_id || null,
        skipPermissions: r.skip_permissions !== 0,
      }));
      return json(list);
    }

    const reviveMatch = matchRoute(pathname, "/api/terminal/sessions/:id/revive");
    if (method === "POST" && reviveMatch) {
      const db = getDatabase();
      const row = db.query("SELECT * FROM terminal_sessions WHERE id = ? AND status = 'dormant'").get(reviveMatch.id) as any;
      if (!row) return errorResponse(404, "Dormant session not found");
      try {
        await ensureBridge();
        const session = createSession(
          row.id, row.name, row.cwd, undefined,
          row.cols || 120, row.rows || 30,
          row.topic_id || undefined,
          row.type || 'shell',
          row.skip_permissions !== 0,
          row.claude_session_id || undefined,
        );
        // Mark as active
        try { db.run("UPDATE terminal_sessions SET status = 'active' WHERE id = ?", [row.id]); } catch {}
        broadcastTerminalSessions();
        return json({
          id: session.id, name: session.name, cwd: session.cwd,
          command: session.command, type: session.type,
          claudeSessionId: session.claudeSessionId || null,
        });
      } catch (err: any) {
        return errorResponse(500, `Failed to revive session: ${err.message}`);
      }
    }

    // Cleanup: delete dormant sessions older than 1 hour (lazy, on each GET sessions call)
    // (This runs in the GET /api/terminal/sessions handler above, no separate endpoint needed)

    // Paste image: save to temp file and copy to macOS system clipboard
    if (method === "POST" && pathname === "/api/terminal/paste-image") {
      const body = await readJSON(req).catch(() => ({}));
      const { dataUrl, sessionId } = body;
      if (!dataUrl || !sessionId) return errorResponse(400, "Missing dataUrl or sessionId");

      const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!match) return errorResponse(400, "Invalid data URL");
      const mimeType = match[1];
      const ext = mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : "png";
      const buffer = Buffer.from(match[2], "base64");

      const filename = `claude-paste-${Date.now()}.${ext}`;
      const filePath = join(tmpdir(), filename);
      await writeFile(filePath, buffer);

      if (process.platform === "darwin") {
        const appleClass = ext === "png" ? "PNGf" : "JPEG";
        const script = `set the clipboard to (read (POSIX file "${filePath}") as «class ${appleClass}»)`;
        try {
          await new Promise<void>((resolve, reject) => {
            execFile("osascript", ["-e", script], (err) => err ? reject(err) : resolve());
          });
        } catch (e) {}
      }

      return json({ ok: true, filePath });
    }

    return null;
  };
}

export function handleTerminalWebSocket(ws: any, sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) {
    ws.close(1008, "Session not found");
    return;
  }

  const sockets = sessionSockets.get(sessionId);
  if (sockets) sockets.add(ws);

  // Request output buffer from bridge (async)
  requestBuffer(sessionId).then((buffered) => {
    if (buffered.byteLength > 0) {
      try { ws.send(buffered); } catch {}
    }
  });

  return {
    message(data: string | Buffer | ArrayBuffer) {
      const input = typeof data === "string" ? data : new TextDecoder().decode(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      sendToBridge({ type: "write", id: sessionId, data: input });
    },
    close() {
      const s = sessionSockets.get(sessionId);
      if (s) s.delete(ws);
    },
  };
}

// Exported for graceful shutdown — disconnects from bridge without killing it
export function disconnectBridge() {
  if (bridgeSocket && !bridgeSocket.destroyed) {
    bridgeSocket.destroy();
  }
  bridgeSocket = null;
  bridgeReady = false;
}
