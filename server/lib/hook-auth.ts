/**
 * The two checks every route a local hook calls makes: the request was addressed
 * to this machine, and it carries the hook token (`claude-hooks/hook-token` under
 * Topics' home). Shared by the Claude Code hook ingest and the worktree
 * registration door, so the narrowest credential means the same thing on both.
 */
import { timingSafeEqual } from "node:crypto";

export function isLocalhostRequest(req: Request): boolean {
  // Behind Bun.serve, `req.headers.get('host')` is the Host header. We also
  // accept the dev TLS host (localhost:3333 / 127.0.0.1:3333). The token is
  // the real defense — this check is belt-and-braces.
  const host = (req.headers.get("host") || "").toLowerCase();
  return host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
}

/** The request's bearer equals `token`, compared in constant time. An empty token never matches. */
export function bearerMatches(req: Request, token: string | null | undefined): boolean {
  if (!token) return false;
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+([A-Za-z0-9]+)$/i);
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
