/**
 * tasks.ts (route) — session-scoped task API for the MCP/agent surface.
 *
 * Rebuilds the task endpoints removed with the Master/Board subsystem
 * (commits 42e92c1d + 827f6b6e), but session-scoped instead of
 * `/api/projects/:id/...` or `/api/boards/...`: the caller is a Claude session
 * (`--session-key`), so the server derives the project AND the agent identity
 * from it — the agent never passes (or can spoof) a project id or author.
 *
 * All mutations here run as `actor: "agent"` and route through the single task
 * service (server/services/tasks.ts), which enforces the human review gate
 * (an agent can reach `review` but never `done`). Human-side board endpoints
 * (actor=human, review approve/reject) belong to the board-UI rebuild and are
 * intentionally NOT here.
 */
import type { AppContext, RouteHandler } from "../types";
import { getTerminalSessionById } from "./terminal";
import { createTaskService, projectIdForPath, TaskServiceError } from "../services/tasks";

const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  invalid_input: 400,
  invalid_transition: 400,
  agent_cannot_complete: 409,
};

export function createTasksRouter(ctx: AppContext): RouteHandler {
  const { db, json, readJSON, matchRoute, broadcastToAll, getTopicBySessionKey } = ctx;
  const svc = createTaskService(db);

  /**
   * Resolve the board project id + a display author from a session key. Works
   * for BOTH a chat topic bound to a project and a Claude terminal tab (which
   * has a cwd but no chat topic). Returns null when the session is unbound.
   */
  function resolveSession(sessionKey: string): { projectId: string; author: string } | null {
    const topic = getTopicBySessionKey(sessionKey);
    if (topic?.projectPath) {
      return { projectId: projectIdForPath(topic.projectPath), author: topic.name?.trim() || "claude" };
    }
    const term = getTerminalSessionById(sessionKey);
    if (term?.cwd) {
      return { projectId: projectIdForPath(term.cwd), author: (term.name || "").trim() || "claude" };
    }
    return null;
  }

  function fail(e: unknown): Response {
    if (e instanceof TaskServiceError) return json({ error: e.message, code: e.code }, ERROR_STATUS[e.code] ?? 400);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }

  return async function tasksRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    // Fast reject: only session-scoped task paths belong to this router.
    if (!pathname.startsWith("/api/sessions/")) return null;

    // POST/GET /api/sessions/:sessionKey/tasks
    const collection = matchRoute(pathname, "/api/sessions/:sessionKey/tasks");
    if (collection) {
      const sk = decodeURIComponent(collection.sessionKey);
      const sess = resolveSession(sk);
      if (!sess) return json({ error: "session is not bound to a project", code: "no_project" }, 400);

      if (method === "GET") {
        const params = new URL(req.url).searchParams;
        const scope = params.get("scope") === "all" ? "all" : "project";
        const status = params.get("status") || undefined;
        try {
          const tasks = svc.list({ scope, projectId: sess.projectId, status: status as any });
          return json({ tasks });
        } catch (e) { return fail(e); }
      }
      if (method === "POST") {
        const body = (await readJSON(req)) as any;
        try {
          const task = svc.create({
            projectId: sess.projectId,
            text: body?.text,
            description: body?.description ?? null,
            priority: typeof body?.priority === "number" ? body.priority : undefined,
            assignedTo: typeof body?.assignee === "string" ? body.assignee : null,
            idempotencyKey: typeof body?.idempotency_key === "string" ? body.idempotency_key : null,
          });
          broadcastToAll({ type: "task:created", projectId: sess.projectId, task });
          return json(task, 201);
        } catch (e) { return fail(e); }
      }
      return null;
    }

    // POST /api/sessions/:sessionKey/tasks/:taskId/comments
    const commentsRoute = matchRoute(pathname, "/api/sessions/:sessionKey/tasks/:taskId/comments");
    if (commentsRoute && method === "POST") {
      const sk = decodeURIComponent(commentsRoute.sessionKey);
      const sess = resolveSession(sk);
      if (!sess) return json({ error: "session is not bound to a project", code: "no_project" }, 400);
      const body = (await readJSON(req)) as any;
      try {
        const comment = svc.addComment({
          taskId: commentsRoute.taskId,
          author: sess.author,
          content: body?.content,
          mentions: Array.isArray(body?.mentions) ? body.mentions : undefined,
          projectId: sess.projectId,
        });
        const task = svc.get(commentsRoute.taskId, { projectId: sess.projectId })?.task;
        broadcastToAll({ type: "task:updated", projectId: sess.projectId, task });
        return json(comment, 201);
      } catch (e) { return fail(e); }
    }

    // GET/PATCH /api/sessions/:sessionKey/tasks/:taskId
    const item = matchRoute(pathname, "/api/sessions/:sessionKey/tasks/:taskId");
    if (item) {
      const sk = decodeURIComponent(item.sessionKey);
      const sess = resolveSession(sk);
      if (!sess) return json({ error: "session is not bound to a project", code: "no_project" }, 400);

      if (method === "GET") {
        const got = svc.get(item.taskId, { projectId: sess.projectId });
        if (!got) return json({ error: "task not found", code: "not_found" }, 404);
        return json(got);
      }
      if (method === "PATCH") {
        const body = (await readJSON(req)) as any;
        try {
          const task = svc.update({
            taskId: item.taskId,
            actor: "agent",
            by: sess.author,
            projectId: sess.projectId,
            patch: {
              status: typeof body?.status === "string" ? body.status : undefined,
              priority: typeof body?.priority === "number" ? body.priority : undefined,
              assignedTo: typeof body?.assignee === "string" ? body.assignee : undefined,
            },
          });
          broadcastToAll({ type: "task:updated", projectId: sess.projectId, task });
          return json(task);
        } catch (e) { return fail(e); }
      }
      return null;
    }

    return null;
  };
}
