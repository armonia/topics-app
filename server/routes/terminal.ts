import type { AppContext, RouteHandler } from "../types";
import { spawn } from "child_process";
import { resolve } from "path";
import { createInterface } from "readline";

interface TerminalSession {
  id: string;
  name: string;
  createdAt: string;
  cwd: string;
  command: string;
  outputBuffer: Uint8Array[];
  outputBufferSize: number;
  cols: number;
  rows: number;
  topicId?: string;
  type: 'shell' | 'claude-code';
}

const MAX_BUFFER_SIZE = 100 * 1024;
const sessions = new Map<string, TerminalSession>();
const sessionSockets = new Map<string, Set<any>>();

// PTY Bridge process (Node.js with node-pty)
let bridge: any = null;
let bridgeReady = false;
const pendingCallbacks = new Map<string, Function>();

function ensureBridge() {
  if (bridge && !bridge.killed) return;
  
  const bridgePath = resolve(import.meta.dir, "../pty-bridge.mjs");
  bridge = spawn("node", [bridgePath], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  const rl = createInterface({ input: bridge.stdout });
  rl.on("line", (line: string) => {
    try {
      const msg = JSON.parse(line);
      handleBridgeMessage(msg);
    } catch {}
  });

  bridge.on("exit", () => {
    bridgeReady = false;
    bridge = null;
  });
}

function sendToBridge(msg: any) {
  ensureBridge();
  bridge.stdin.write(JSON.stringify(msg) + "\n");
}

function handleBridgeMessage(msg: any) {
  switch (msg.type) {
    case "ready":
      bridgeReady = true;
      break;
    case "created": {
      const cb = pendingCallbacks.get(msg.id);
      if (cb) { cb(msg); pendingCallbacks.delete(msg.id); }
      break;
    }
    case "data": {
      const session = sessions.get(msg.id);
      if (!session) break;
      const bytes = new TextEncoder().encode(msg.data);
      appendToBuffer(session, bytes);
      const sockets = sessionSockets.get(msg.id);
      if (sockets) {
        for (const ws of sockets) {
          try { ws.send(msg.data); } catch { sockets.delete(ws); }
        }
      }
      break;
    }
    case "exit": {
      sessions.delete(msg.id);
      const sockets = sessionSockets.get(msg.id);
      if (sockets) {
        for (const ws of sockets) {
          try { ws.close(1000, "Session ended"); } catch {}
        }
        sessionSockets.delete(msg.id);
      }
      break;
    }
  }
}

function appendToBuffer(session: TerminalSession, data: Uint8Array) {
  session.outputBuffer.push(new Uint8Array(data));
  session.outputBufferSize += data.byteLength;
  while (session.outputBufferSize > MAX_BUFFER_SIZE && session.outputBuffer.length > 1) {
    const removed = session.outputBuffer.shift()!;
    session.outputBufferSize -= removed.byteLength;
  }
}

function getBufferedOutput(session: TerminalSession): Uint8Array {
  if (session.outputBuffer.length === 0) return new Uint8Array(0);
  const total = session.outputBufferSize;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of session.outputBuffer) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function createSession(id: string, name: string, cwd: string, command?: string, cols = 120, rows = 30, topicId?: string, sessionType: 'shell' | 'claude-code' = 'shell'): TerminalSession {
  let file: string;
  let args: string[];

  if (sessionType === 'claude-code') {
    file = 'claude';
    args = ['--dangerously-skip-permissions'];
  } else if (command) {
    const parts = command.split(" ");
    file = parts[0];
    args = parts.slice(1);
  } else {
    file = process.env.SHELL || "/bin/zsh";
    args = ["-l"];
  }

  ensureBridge();
  sendToBridge({ type: "create", id, shell: file, args, cwd, cols, rows });

  const session: TerminalSession = {
    id,
    name,
    createdAt: new Date().toISOString(),
    cwd,
    command: sessionType === 'claude-code' ? 'claude' : (command || file),
    outputBuffer: [],
    outputBufferSize: 0,
    cols,
    rows,
    topicId,
    type: sessionType,
  };

  sessions.set(id, session);
  sessionSockets.set(id, new Set());
  return session;
}

export function createTerminalRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON, errorResponse, matchRoute } = ctx;
  
  // Start bridge on first load
  ensureBridge();

  return async function terminalRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    if (method === "GET" && pathname === "/api/terminal/sessions") {
      const filterTopicId = url.searchParams.get('topicId');
      let values = Array.from(sessions.values());
      if (filterTopicId) {
        values = values.filter(s => s.topicId === filterTopicId);
      }
      const list = values.map(s => ({
        id: s.id, name: s.name, createdAt: s.createdAt, cwd: s.cwd,
        command: s.command, clients: sessionSockets.get(s.id)?.size || 0,
        topicId: s.topicId, type: s.type,
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

      try {
        const session = createSession(id, name, cwd, command, cols, rows, topicId, sessionType);
        return json({ id, name, cwd, command: session.command, createdAt: session.createdAt, topicId: session.topicId, type: session.type });
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
      if (!session) return errorResponse(404, "Terminal session not found");
      sendToBridge({ type: "kill", id: deleteMatch.id });
      sessions.delete(deleteMatch.id);
      const sockets = sessionSockets.get(deleteMatch.id);
      if (sockets) {
        for (const ws of sockets) {
          try { ws.close(1000, "Session killed"); } catch {}
        }
      }
      sessionSockets.delete(deleteMatch.id);
      return json({ ok: true });
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

  const buffered = getBufferedOutput(session);
  if (buffered.byteLength > 0) {
    try { ws.send(buffered); } catch {}
  }

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
