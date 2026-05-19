import type { AppContext, RouteHandler } from "../types";
import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { randomBytes } from "crypto";
import type { ClaudeSessionTracker } from "../lib/claude-session-tracker";
import { type HookPayload } from "../lib/claude-session-state";

const TOKEN_DIR = join(homedir(), ".claude", "topics-app");
const TOKEN_PATH = join(TOKEN_DIR, "hook-token");
const SHARED_TOKEN_PATH = join(homedir(), ".claude", "topics-hook-token");

/**
 * Read or create the hook auth token. The token is shared between Topics App
 * (which validates incoming hooks) and the hook wrapper scripts (which read
 * it from `~/.claude/topics-hook-token` to set the Authorization header).
 *
 * Generated on first server boot; cached in-memory thereafter. Mode 0600.
 */
let cachedToken: string | null = null;

export function getOrCreateHookToken(): string {
  if (cachedToken) return cachedToken;

  try {
    if (existsSync(TOKEN_PATH)) {
      const t = readFileSync(TOKEN_PATH, "utf-8").trim();
      if (/^[a-f0-9]{32,128}$/i.test(t)) {
        cachedToken = t;
        // Mirror to the shared path for the hook scripts. Done idempotently
        // every boot so a missing file is restored without surprises.
        ensureSharedTokenFile(t);
        return t;
      }
    }
  } catch {}

  // Generate.
  const fresh = randomBytes(32).toString("hex");
  try {
    mkdirSync(TOKEN_DIR, { recursive: true });
    writeFileSync(TOKEN_PATH, fresh, { mode: 0o600 });
    chmodSync(TOKEN_PATH, 0o600);
    ensureSharedTokenFile(fresh);
  } catch (err) {
    // Couldn't persist — fall back to in-memory only. Hooks installed in a
    // previous boot won't authenticate. Logged loudly.
    console.error("[claude-hooks] Failed to persist hook token", err);
  }
  cachedToken = fresh;
  return fresh;
}

function ensureSharedTokenFile(token: string): void {
  try {
    if (existsSync(SHARED_TOKEN_PATH)) {
      const cur = readFileSync(SHARED_TOKEN_PATH, "utf-8").trim();
      if (cur === token) return;
    }
    writeFileSync(SHARED_TOKEN_PATH, token, { mode: 0o600 });
    chmodSync(SHARED_TOKEN_PATH, 0o600);
  } catch (err) {
    console.error("[claude-hooks] Failed to mirror token to shared path", err);
  }
}

function isLocalhost(req: Request): boolean {
  // Behind Bun.serve, `req.headers.get('host')` is the Host header. We also
  // accept the dev TLS host (localhost:3333 / 127.0.0.1:3333). The token is
  // the real defense — this check is belt-and-braces.
  const host = (req.headers.get("host") || "").toLowerCase();
  if (host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]")) return true;
  return false;
}

export function createClaudeHooksRouter(
  ctx: AppContext,
  tracker: ClaudeSessionTracker,
): RouteHandler {
  const { json, errorResponse, matchRoute, readJSON } = ctx;
  const token = getOrCreateHookToken();

  return async function claudeHooksRouter(req: Request, url: URL, pathname: string, method: string) {
    // POST /api/claude-hooks/:event — receives Claude Code hook payloads.
    {
      const params = matchRoute(pathname, "/api/claude-hooks/:event");
      if (params && method === "POST") {
        if (!isLocalhost(req)) {
          return errorResponse(403, "claude-hooks endpoint is localhost-only");
        }
        const auth = req.headers.get("authorization") || "";
        const m = auth.match(/^Bearer\s+([a-f0-9]+)$/i);
        if (!m || m[1] !== token) {
          return errorResponse(401, "Invalid hook token");
        }

        let body: any;
        try { body = await readJSON(req); } catch {
          return errorResponse(400, "Body must be JSON");
        }
        if (!body || typeof body !== "object") {
          return errorResponse(400, "Body must be a JSON object");
        }

        const payload: HookPayload = {
          ...body,
          hook_event_name: params.event,
          session_id: body.session_id ?? body.sessionId ?? "",
        } as HookPayload;

        if (!payload.session_id) {
          return errorResponse(400, "Missing session_id in payload");
        }

        const result = tracker.ingestHook(payload);
        // Hook callers should never crash because we returned 4xx — we
        // always answer 200 unless the request was malformed at the
        // protocol level. The result kind tells us what happened.
        return json({ ok: true, result: result.kind });
      }
    }

    // GET /api/claude-sessions — snapshot of current state. Used by clients
    // to populate the local cache on connect.
    if (pathname === "/api/claude-sessions" && method === "GET") {
      const sessions = tracker.listSessions().map((s) => ({
        sessionKey: s.sessionKey,
        claudeSessionId: s.claudeSessionId,
        phase: s.phase,
        phaseUpdatedAt: s.phaseUpdatedAt,
        rev: s.rev,
        pendingApproval: s.pendingApproval,
        lastTool: s.lastTool,
        lastHookAt: s.lastHookAt,
        error: s.error,
        updatedAt: s.updatedAt,
      }));
      return json({ sessions });
    }

    // GET /api/claude-sessions/by-key/:sessionKey — fetch a single session
    {
      const params = matchRoute(pathname, "/api/claude-sessions/by-key/:sessionKey");
      if (params && method === "GET") {
        const s = tracker.getSessionByKey(params.sessionKey);
        if (!s) return errorResponse(404, "No Claude session for this sessionKey");
        return json({ session: s });
      }
    }

    return null;
  };
}
