import type { AppContext, RouteHandler } from "../types";
import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { randomBytes } from "crypto";
import type { ClaudeSessionTracker } from "../lib/claude-session-tracker";
import { type HookPayload } from "../lib/claude-session-state";
import { topicsHome } from "../services/daemon-state";
import { autoNameClaudeSession } from "./terminal";

/**
 * Where the hook auth token lives: under Topics' OWN home, never under
 * `~/.claude`. Until 2026-09-07 the server wrote it into the user's Claude
 * config dir on every boot (`~/.claude/topics-app/hook-token` and
 * `~/.claude/topics-hook-token`), which is Topics leaving files in another
 * tool's directory. Those two paths are now READ-ONLY legacy: a wrapper
 * installed by a previous version still reads the second one, so an existing
 * token is adopted from there (and persisted here), but nothing is written
 * back.
 */
export function hookTokenPath(home: string = topicsHome()): string {
  return join(home, "claude-hooks", "hook-token");
}

/** The paths a previous version wrote; read for adoption, never written. */
export function legacyHookTokenPaths(claudeDir: string = join(homedir(), ".claude")): string[] {
  return [join(claudeDir, "topics-app", "hook-token"), join(claudeDir, "topics-hook-token")];
}

const TOKEN_SHAPE = /^[a-f0-9]{32,128}$/i;

function readTokenFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const t = readFileSync(path, "utf-8").trim();
    return TOKEN_SHAPE.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Read, adopt or create the token at `ownPath`. Pure over its paths so a test
 * can point it at a fake home and a fake `~/.claude`.
 *
 * Order: our own file wins; otherwise a legacy file's value is adopted so the
 * wrappers already installed keep authenticating; otherwise a fresh token is
 * generated. Anything not already at `ownPath` is persisted there, mode 0600.
 */
export function resolveHookToken(ownPath: string, legacyPaths: string[]): string {
  const own = readTokenFile(ownPath);
  if (own) return own;

  let token: string | null = null;
  for (const p of legacyPaths) {
    token = readTokenFile(p);
    if (token) break;
  }
  token ??= randomBytes(32).toString("hex");

  try {
    mkdirSync(join(ownPath, ".."), { recursive: true });
    writeFileSync(ownPath, token, { mode: 0o600 });
    chmodSync(ownPath, 0o600);
  } catch (err) {
    // Could not persist: in-memory only for this boot. Hooks installed by a
    // previous boot will not authenticate. Logged loudly.
    console.error("[claude-hooks] Failed to persist hook token", err);
  }
  return token;
}

/**
 * The hook auth token, shared between Topics App (which validates incoming
 * hooks) and the hook wrapper scripts (which read it from disk to set the
 * Authorization header). Resolved on first server boot; cached in-memory
 * thereafter.
 */
let cachedToken: string | null = null;

export function getOrCreateHookToken(): string {
  if (cachedToken) return cachedToken;
  cachedToken = resolveHookToken(hookTokenPath(), legacyHookTokenPaths());
  return cachedToken;
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

        // Keep a Claude Code chat's tab label tracking its topic: on the first
        // prompt and at each turn boundary, re-derive the auto-name from the
        // session transcript. Best-effort — never blocks or breaks the response.
        if (payload.hook_event_name === "UserPromptSubmit" || payload.hook_event_name === "Stop") {
          try {
            autoNameClaudeSession(
              payload.session_id,
              typeof payload.transcript_path === "string" ? payload.transcript_path : undefined,
            );
          } catch { /* best-effort */ }
        }

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
        // Transcript pointer — which file the live JSONL tail follows and how
        // far it has consumed. Diagnostic: lets `curl /api/claude-sessions`
        // answer "is this session tail-covered?" without server logs.
        jsonlPath: s.jsonlPath,
        jsonlOffset: s.jsonlOffset,
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
