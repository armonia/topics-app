/**
 * Routes — `/api/external-sessions`
 *
 * Read-only census of the Claude Code sessions running OUTSIDE Topics (bare
 * `claude` in a terminal, another tool driving the SDK). See
 * services/external-sessions.ts for how it's derived.
 *
 *   GET /api/external-sessions            → { sessions, projects, generatedAt }
 *   GET /api/external-sessions?project_id=…  → only that board's sessions
 *
 * Live updates arrive over WS as `external-sessions` envelopes; this endpoint
 * is the initial fetch (and the CLI/debug view).
 */
import type { AppContext, RouteHandler } from "../types";
import type { ExternalSessionsService } from "../services/external-sessions";

export function createExternalSessionsRouter(
  ctx: AppContext,
  service: ExternalSessionsService,
): RouteHandler {
  const { json } = ctx;

  return async function externalSessionsRouter(
    _req: Request,
    url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> {
    if (method !== "GET" || pathname !== "/api/external-sessions") return null;

    const projectId = url.searchParams.get("project_id");
    const all = service.list();
    const sessions = projectId ? all.filter((s) => s.projectId === projectId) : all;
    return json({
      sessions,
      projects: service.byProject(),
      generatedAt: new Date().toISOString(),
    });
  };
}
