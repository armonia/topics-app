import type { AppContext, RouteHandler } from "../types";

interface TerminalSession {
  id: string;
  proc: any; // Bun subprocess with PTY
  createdAt: string;
  cwd: string;
}

const sessions = new Map<string, TerminalSession>();
// Map sessionId -> Set of WebSocket connections
const sessionSockets = new Map<string, Set<any>>();

export function createTerminalRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON, errorResponse, matchRoute } = ctx;

  return async function terminalRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // List sessions
    if (method === "GET" && pathname === "/api/terminal/sessions") {
      const list = Array.from(sessions.values()).map(s => ({
        id: s.id,
        createdAt: s.createdAt,
        cwd: s.cwd,
      }));
      return json(list);
    }

    // Create session
    if (method === "POST" && pathname === "/api/terminal/create") {
      const body = await readJSON(req).catch(() => ({}));
      const cwd = body.cwd || process.env.HOME || "/";
      const id = crypto.randomUUID();
      const shell = process.env.SHELL || "/bin/zsh";

      try {
        const proc = Bun.spawn([shell, "-l"], {
          stdin: "pipe",
          cwd,
          env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
          // @ts-ignore - Bun PTY support
          pty: { rows: 24, cols: 80 },
        });

        const session: TerminalSession = { id, proc, createdAt: new Date().toISOString(), cwd };
        sessions.set(id, session);
        sessionSockets.set(id, new Set());

        // Read PTY output and broadcast to connected WebSockets
        (async () => {
          try {
            const reader = proc.stdout.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const sockets = sessionSockets.get(id);
              if (sockets) {
                const data = value;
                for (const ws of sockets) {
                  try { ws.send(data); } catch { sockets.delete(ws); }
                }
              }
            }
          } catch {}
          // Cleanup on exit
          sessions.delete(id);
          sessionSockets.delete(id);
        })();

        return json({ id, cwd, createdAt: session.createdAt });
      } catch (err: any) {
        return errorResponse(500, `Failed to create terminal: ${err.message}`);
      }
    }

    // Delete session
    const deleteMatch = matchRoute(pathname, "/api/terminal/:id");
    if (method === "DELETE" && deleteMatch) {
      const session = sessions.get(deleteMatch.id);
      if (!session) return errorResponse(404, "Terminal session not found");
      try { session.proc.kill(); } catch {}
      sessions.delete(deleteMatch.id);
      sessionSockets.delete(deleteMatch.id);
      return json({ ok: true });
    }

    // Resize
    const resizeMatch = matchRoute(pathname, "/api/terminal/:id/resize");
    if (method === "POST" && resizeMatch) {
      const session = sessions.get(resizeMatch.id);
      if (!session) return errorResponse(404, "Terminal session not found");
      const body = await readJSON(req).catch(() => ({}));
      const { cols, rows } = body;
      if (cols && rows) {
        try {
          // @ts-ignore - Bun PTY resize
          session.proc.pty?.resize?.({ columns: cols, rows });
        } catch {}
      }
      return json({ ok: true });
    }

    return null;
  };
}

// Export for WebSocket handling in server.ts
export function handleTerminalWebSocket(ws: any, sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) {
    ws.close(1008, "Session not found");
    return;
  }

  const sockets = sessionSockets.get(sessionId);
  if (sockets) sockets.add(ws);

  return {
    message(data: string | Buffer | ArrayBuffer) {
      try {
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        session.proc.stdin.write(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
      } catch {}
    },
    close() {
      const s = sessionSockets.get(sessionId);
      if (s) s.delete(ws);
    },
  };
}

export { sessions as terminalSessions };
