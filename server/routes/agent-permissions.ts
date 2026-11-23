/**
 * `GET /api/agent-permissions?agent=<id>` — what the channel engine applies
 * for that agent, read-only (AGENTS-NAV-01). See `server/agents/permissions.ts`.
 *
 * `GET /api/agent-permissions/stopped?agent=&reason=&page=&pageSize=` — the
 * engine's own record of turns it stopped, paged and filterable. The chat id
 * is resolved to its title with the same source `/api/agent-channels` uses,
 * so this route and that one never disagree on a chat's name.
 */
import { readAgentPermissions } from "../agents/permissions";
import { readStoppedLog } from "../agents/stopped-log";
import { channelsDbPath, readChannelTitles } from "./agent-channels";
import { defaultPaths, type Paths } from "./agent-config";
import type { AppContext, RouteHandler } from "../types";

export function createAgentPermissionsRouter(
  ctx: Pick<AppContext, "json">,
  paths: () => Paths = () => defaultPaths(),
  dbPath: () => string = () => channelsDbPath(),
): RouteHandler {
  return async function agentPermissionsRouter(_req, url, pathname, method) {
    if (method !== "GET") return null;
    if (pathname === "/api/agent-permissions") {
      const agentId = url.searchParams.get("agent") ?? "";
      if (!agentId) return ctx.json({ error: "agent is required" }, 400);
      return ctx.json(readAgentPermissions(paths(), agentId));
    }
    if (pathname === "/api/agent-permissions/stopped") {
      const agent = url.searchParams.get("agent") || undefined;
      const reason = url.searchParams.get("reason") || undefined;
      const page = Number(url.searchParams.get("page") ?? "1") || 1;
      const pageSize = Number(url.searchParams.get("pageSize") ?? "20") || 20;
      const result = readStoppedLog(dbPath(), paths().home, { agent, reason, page, pageSize });
      const titles = readChannelTitles(dbPath());
      return ctx.json({ ...result, rows: result.rows.map((r) => ({ ...r, chatTitle: titles[r.chat] ?? null })) });
    }
    return null;
  };
}
