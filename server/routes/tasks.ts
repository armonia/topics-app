/**
 * tasks.ts (route) — session-scoped task API for the MCP/agent surface.
 *
 * Rebuilds the task endpoints removed with the Master/Board subsystem
 * (commits 42e92c1d + 827f6b6e), but session-scoped instead of
 * `/api/projects/:id/...` or `/api/boards/...`: the caller is a Claude session
 * (`--session-key`), so the server derives the project AND the agent identity
 * from it — the agent never passes (or can spoof) a project id or author.
 *
 * Two surfaces, one service (server/services/tasks.ts):
 *   - `/api/sessions/:key/...` — the AGENT surface (MCP). actor="agent": can
 *     reach `review` but never `done` (the human review gate). Project + author
 *     are derived from the session key, never passed by the caller.
 *   - `/api/boards/:projectId/...` — the HUMAN board surface (the board UI).
 *     actor="human": may move to `done`, archive, and approve/reject reviews.
 *
 * Both go through the service's projectId guard, so a caller can only touch
 * tasks on the project it named/owns (no cross-project IDOR).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AppContext, RouteHandler } from "../types";
import { getTerminalSessionById } from "./terminal";
import { createTaskService, projectIdForPath, TaskServiceError } from "../services/tasks";
import type { TaskDispatcher } from "../services/task-dispatcher";

const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  invalid_input: 400,
  invalid_transition: 400,
  agent_cannot_complete: 409,
  open_subtasks: 409,
  review_needs_summary: 409,
};

/**
 * Cap for AGENT-authored comments (the session surface only — humans are
 * uncapped). Generous enough for 2-3 dense sentences or a question block,
 * tight enough to reject log dumps; the 400 message coaches a retry.
 */
const AGENT_COMMENT_MAX_CHARS = 600;

export interface TasksRouterOpts {
  /** All project dirs the server knows (same union the dispatcher resolves against). */
  listProjectDirs?: () => string[];
  /** Workspace root for scaffolding a NEW project from the board. */
  workspaceDir?: string;
  /** Abort a running headless turn (human "stop" on a dispatched task). */
  abortTurn?: (sessionKey: string) => Promise<void>;
}

export function createTasksRouter(ctx: AppContext, dispatcher?: TaskDispatcher, opts?: TasksRouterOpts): RouteHandler {
  const { db, json, readJSON, matchRoute, broadcastToAll, getTopicBySessionKey } = ctx;
  const svc = createTaskService(db);

  /**
   * Resolve the board project id + a display author from a session key. Works
   * for BOTH a chat topic bound to a project and a Claude terminal tab (which
   * has a cwd but no chat topic). Returns null when the session is unbound.
   * `topicId` (chat sessions only) feeds the "own steps" carve-out: it lets the
   * service recognise subtasks of the task dispatched to THIS agent.
   */
  function resolveSession(sessionKey: string): { projectId: string; author: string; topicId: string | null } | null {
    const topic = getTopicBySessionKey(sessionKey);
    if (topic?.projectPath) {
      return { projectId: projectIdForPath(topic.projectPath), author: topic.name?.trim() || "claude", topicId: topic.id ?? null };
    }
    const term = getTerminalSessionById(sessionKey);
    if (term?.cwd) {
      return { projectId: projectIdForPath(term.cwd), author: (term.name || "").trim() || "claude", topicId: null };
    }
    return null;
  }

  function fail(e: unknown): Response {
    if (e instanceof TaskServiceError) return json({ error: e.message, code: e.code }, ERROR_STATUS[e.code] ?? 400);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }

  return async function tasksRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    // Fast reject: only task paths — agent (session-scoped) or human (board-scoped).
    const isSession = pathname.startsWith("/api/sessions/");
    const isBoard = pathname.startsWith("/api/boards/");
    const isAllBoards = pathname.startsWith("/api/all-boards/");
    if (!isSession && !isBoard && !isAllBoards) return null;

    // GET /api/all-boards/tasks — the global cross-project feed (human overview).
    // Read-only: per-task mutations still go to /api/boards/:projectId/... using
    // each task's own projectId.
    if (pathname === "/api/all-boards/tasks" && method === "GET") {
      const status = new URL(req.url).searchParams.get("status") || undefined;
      try { return json({ tasks: svc.list({ scope: "all", status: status as any }) }); }
      catch (e) { return fail(e); }
    }

    // /api/all-boards/projects — the board index (task-detail project selector).
    //   GET  → every project dir the server knows, as {projectId, name, path}
    //          (projectId = the same hash the boards key on).
    //   POST → scaffold a NEW workspace project (same contract as the session
    //          create-project route: sanitized name, dir + CLAUDE.md, 409 on
    //          collision) so "Nuovo progetto…" works from the board too.
    if (pathname === "/api/all-boards/projects") {
      if (method === "GET") {
        const seen = new Set<string>();
        const projects: Array<{ projectId: string; name: string; path: string }> = [];
        let dirs: string[] = [];
        try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
        for (const raw of dirs) {
          if (typeof raw !== "string" || !raw.startsWith("/")) continue;
          const path = raw.replace(/\/+$/, "");
          if (!path || seen.has(path)) continue;
          seen.add(path);
          projects.push({ projectId: projectIdForPath(path), name: basename(path), path });
        }
        projects.sort((a, b) => a.name.localeCompare(b.name));
        return json({ projects });
      }
      if (method === "POST") {
        if (!opts?.workspaceDir) return json({ error: "workspace not configured", code: "invalid_input" }, 500);
        const body = (await readJSON(req)) as any;
        const safeName = (typeof body?.name === "string" ? body.name.trim() : "").replace(/[^a-zA-Z0-9_-]/g, "");
        if (!safeName) return json({ error: "name (alphanumeric) is required", code: "invalid_input" }, 400);
        const dir = join(opts.workspaceDir, safeName);
        if (existsSync(dir)) {
          return json({ error: `project "${safeName}" already exists`, code: "project_exists" }, 409);
        }
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "CLAUDE.md"), `# ${safeName}\n`);
        } catch (e) { return fail(e); }
        return json({ projectId: projectIdForPath(dir), name: safeName, path: dir }, 201);
      }
      return null;
    }

    // ── Human board API (project-scoped, actor="human") ─────────────────────
    // The board UI knows its projectId and drives these directly. A human MAY
    // move a task to 'done' (the review gate only blocks agents), archive it,
    // and approve/reject a pending review.
    if (isBoard) {
      const HUMAN = "user";

      // GET/PATCH /api/boards/:projectId/settings — per-board dispatch config
      // (auto-dispatch toggle, concurrency cap, effort, worktree, timeout).
      const bSettings = matchRoute(pathname, "/api/boards/:projectId/settings");
      if (bSettings) {
        const projectId = bSettings.projectId;
        if (method === "GET") {
          try { return json(svc.getBoardSettings(projectId)); } catch (e) { return fail(e); }
        }
        if (method === "PATCH") {
          const body = (await readJSON(req)) as any;
          try {
            const settings = svc.updateBoardSettings(projectId, {
              autoDispatch: typeof body?.autoDispatch === "boolean" ? body.autoDispatch : undefined,
              maxAgents: typeof body?.maxAgents === "number" ? body.maxAgents : undefined,
              dispatchEffort: typeof body?.dispatchEffort === "string" ? body.dispatchEffort : undefined,
              dispatchUseWorktree: typeof body?.dispatchUseWorktree === "boolean" ? body.dispatchUseWorktree : undefined,
              dispatchTimeoutMin: typeof body?.dispatchTimeoutMin === "number" ? body.dispatchTimeoutMin : undefined,
            });
            broadcastToAll({ type: "board:settings", projectId, settings });
            return json(settings);
          } catch (e) { return fail(e); }
        }
        return null;
      }

      const bCol = matchRoute(pathname, "/api/boards/:projectId/tasks");
      if (bCol) {
        const projectId = bCol.projectId;
        if (method === "GET") {
          const status = new URL(req.url).searchParams.get("status") || undefined;
          try { return json({ tasks: svc.list({ scope: "project", projectId, status: status as any }) }); }
          catch (e) { return fail(e); }
        }
        if (method === "POST") {
          const body = (await readJSON(req)) as any;
          try {
            const task = svc.create({
              projectId,
              text: body?.text,
              description: body?.description ?? null,
              priority: typeof body?.priority === "number" ? body.priority : undefined,
              assignedTo: typeof body?.assignee === "string" ? body.assignee : null,
              status: typeof body?.status === "string" ? body.status : undefined,
              parentTaskId: typeof body?.parentTaskId === "string" ? body.parentTaskId : null,
              planFirst: body?.planFirst === true,
            });
            broadcastToAll({ type: "task:created", projectId, task });
            // A task born directly in Todo is the same "vai" signal as a drag
            // into Todo: same chip, same grace window — not a silent 10s wait
            // for the reconcile poll. No-op when auto-dispatch is off.
            if (dispatcher && task.status === "todo") dispatcher.onEnterTodo(projectId, task.id);
            // Adding a STEP under an agent-bound root in review IS the
            // assignment — no "please also do X" comment ceremony: re-kick the
            // same agent with the new step. (Root mid-turn: the step just lands
            // in the tree; the open_subtasks gate keeps approve honest and the
            // resume prompt tells the agent to re-read its task.)
            try {
              if (dispatcher && task.parentTaskId) {
                const root = svc.boundRootOf(task.id);
                if (root && root.status === "review" && root.assignedTopicId) {
                  const rejected = svc.reviewDecision({ taskId: root.id, by: "user", decision: "reject", projectId });
                  broadcastToAll({ type: "task:updated", projectId, task: rejected });
                  void dispatcher.resume(root.id, `L'umano ha aggiunto un nuovo step al tuo task: "${task.text.slice(0, 80)}" (id=${task.id}). Lavoralo e marcalo done prima della consegna.`);
                }
              }
            } catch { /* best-effort — the step itself is already created */ }
            return json(task, 201);
          } catch (e) { return fail(e); }
        }
        return null;
      }

      // POST /api/boards/:projectId/tasks/:taskId/stop — the human pulls the
      // plug on a running dispatch ("ho sbagliato qualcosa"). Order matters:
      // park FIRST (backlog + reason), THEN cut the turn — so when the aborted
      // turn's onTurnEnd fires it finds the task already moved and just drops
      // the chip instead of auto-requeueing a fresh attempt.
      const bStop = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/stop");
      if (bStop && method === "POST") {
        try {
          const got = svc.get(bStop.taskId, { projectId: bStop.projectId });
          if (!got) return json({ error: "task not found", code: "not_found" }, 404);
          const t = got.task;
          const live = t.assignedTopicId || ["queued", "starting", "working"].includes(t.dispatchState ?? "");
          if (!live) return json({ error: "no active agent on this task", code: "invalid_transition" }, 409);
          const sessionKey = t.assignedTopicId ? "topic:" + t.assignedTopicId.slice(0, 8) : null;
          dispatcher?.onLeaveTodo(t.id); // clears a pending grace timer (queued)
          const parked = svc.release({
            taskId: t.id, requeue: false, by: "user",
            reason: "Fermato da te: agent interrotto. Rimetti il task in Todo per ripartire.",
          });
          broadcastToAll({ type: "task:updated", projectId: bStop.projectId, task: parked });
          if (sessionKey && opts?.abortTurn) void opts.abortTurn(sessionKey).catch(() => { /* best-effort */ });
          return json(parked);
        } catch (e) { return fail(e); }
      }

      // POST /api/boards/:projectId/tasks/:taskId/move — send the task (and its
      // subtree) to another board. Both boards get a broadcast so the source
      // drops the card and the target picks it up live.
      const bMove = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/move");
      if (bMove && method === "POST") {
        const body = (await readJSON(req)) as any;
        try {
          const task = svc.moveToProject({
            taskId: bMove.taskId,
            projectId: bMove.projectId,
            toProjectId: typeof body?.toProjectId === "string" ? body.toProjectId : "",
          });
          broadcastToAll({ type: "task:updated", projectId: bMove.projectId, task });
          if (task.projectId !== bMove.projectId) {
            broadcastToAll({ type: "task:updated", projectId: task.projectId, task });
          }
          return json(task);
        } catch (e) { return fail(e); }
      }

      const bReview = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/review");
      if (bReview && method === "POST") {
        const body = (await readJSON(req)) as any;
        const decision = body?.decision === "approve" ? "approve" : body?.decision === "reject" ? "reject" : null;
        if (!decision) return json({ error: "decision must be 'approve' or 'reject'", code: "invalid_input" }, 400);
        try {
          const comment = typeof body?.comment === "string" ? body.comment : undefined;
          const task = svc.reviewDecision({
            taskId: bReview.taskId, by: HUMAN, decision, comment,
            projectId: bReview.projectId,
          });
          broadcastToAll({ type: "task:updated", projectId: bReview.projectId, task });
          // Reject re-kicks the SAME agent tab with the human's feedback (a
          // "Serve te" answer routes through here too), so the conversation
          // resumes instead of a fresh agent spawning. reviewDecision already
          // moved it back to in_progress.
          if (dispatcher && decision === "reject" && task.assignedTopicId) {
            void dispatcher.resume(bReview.taskId, comment ?? "");
          }
          return json(task);
        } catch (e) { return fail(e); }
      }

      const bComments = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/comments");
      if (bComments && method === "POST") {
        const body = (await readJSON(req)) as any;
        try {
          const comment = svc.addComment({
            taskId: bComments.taskId, author: HUMAN, content: body?.content,
            mentions: Array.isArray(body?.mentions) ? body.mentions : undefined,
            projectId: bComments.projectId,
          });
          const task = svc.get(bComments.taskId, { projectId: bComments.projectId })?.task;
          broadcastToAll({ type: "task:updated", projectId: bComments.projectId, task });
          // Answering on a STEP is answering the agent: when the subtree's
          // dispatch root sits in review ("serve te"), a human comment anywhere
          // under it re-kicks the same agent tab with the step reference — the
          // specific reply lives on the step's own thread, not necessarily on
          // the main task's. Best-effort: the comment above is already saved.
          try {
            const root = dispatcher ? svc.boundRootOf(bComments.taskId) : null;
            if (dispatcher && root && root.status === "review" && root.assignedTopicId) {
              const rejected = svc.reviewDecision({
                taskId: root.id, by: HUMAN, decision: "reject", projectId: bComments.projectId,
              });
              broadcastToAll({ type: "task:updated", projectId: bComments.projectId, task: rejected });
              const text = typeof body?.content === "string" ? body.content : "";
              const msg = root.id === bComments.taskId
                ? text
                : `Commento sul tuo sottotask "${(task?.text ?? "").slice(0, 60)}" (id=${bComments.taskId}): ${text}`;
              void dispatcher.resume(root.id, msg);
            }
          } catch { /* the root may have moved meanwhile */ }
          return json(comment, 201);
        } catch (e) { return fail(e); }
      }

      const bItem = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId");
      if (bItem) {
        const { projectId, taskId } = bItem;
        if (method === "GET") {
          const got = svc.get(taskId, { projectId });
          if (!got) return json({ error: "task not found", code: "not_found" }, 404);
          return json(got);
        }
        if (method === "PATCH") {
          const body = (await readJSON(req)) as any;
          try {
            const prevStatus = svc.get(taskId, { projectId })?.task.status;
            const task = svc.update({
              taskId, actor: "human", by: HUMAN, projectId,
              patch: {
                status: typeof body?.status === "string" ? body.status : undefined,
                priority: typeof body?.priority === "number" ? body.priority : undefined,
                assignedTo: typeof body?.assignee === "string" ? body.assignee : undefined,
                text: typeof body?.text === "string" ? body.text : undefined,
                description: body?.description !== undefined ? body.description : undefined,
                kanbanOrder: typeof body?.kanbanOrder === "number" ? body.kanbanOrder : undefined,
                outputUrl: typeof body?.outputUrl === "string" ? body.outputUrl : undefined,
              },
            });
            broadcastToAll({ type: "task:updated", projectId, task });
            // Auto-dispatch trigger: the human dragging a task INTO todo is the
            // "vai" signal; dragging it back OUT while still queued cancels it.
            // The dispatcher itself no-ops when auto_dispatch is off for the board.
            if (dispatcher && prevStatus !== task.status) {
              if (task.status === "todo") dispatcher.onEnterTodo(projectId, taskId);
              else if (prevStatus === "todo") dispatcher.onLeaveTodo(taskId);
            }
            return json(task);
          } catch (e) { return fail(e); }
        }
        if (method === "DELETE") {
          try {
            const task = svc.archive({ taskId, projectId });
            broadcastToAll({ type: "task:deleted", projectId, taskId });
            return json({ ok: true, task });
          } catch (e) { return fail(e); }
        }
        return null;
      }
      return null;
    }

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
            // Agents/MCP always create into `backlog` (intake), never straight into
            // the "todo" run-queue: a task only becomes dispatch-eligible when a
            // HUMAN moves it to todo. Symmetric to the agent-cannot-mark-done gate.
            status: "backlog",
            idempotencyKey: typeof body?.idempotency_key === "string" ? body.idempotency_key : null,
            parentTaskId: typeof body?.parent_task_id === "string" ? body.parent_task_id : null,
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
      // Agent comments must stay SHORT and useful — the thread is a status
      // trail for the human, not a log sink. The cap only applies to the agent
      // surface (humans on /api/boards are uncapped); the error text coaches
      // the model to summarize and retry.
      if (typeof body?.content === "string" && body.content.length > AGENT_COMMENT_MAX_CHARS) {
        return json({
          error: `comment too long (${body.content.length} chars, max ${AGENT_COMMENT_MAX_CHARS}) — summarize: 1-2 short sentences, no logs or code dumps`,
          code: "comment_too_long",
        }, 400);
      }
      try {
        const comment = svc.addComment({
          taskId: commentsRoute.taskId,
          author: sess.author,
          content: body?.content,
          mentions: Array.isArray(body?.mentions) ? body.mentions : undefined,
          projectId: sess.projectId,
          // Structured human-decision request: the service composes the
          // canonical ```question``` block from these (KANBAN-07 quick-reply).
          questionOptions: Array.isArray(body?.options)
            ? body.options.filter((o: unknown) => typeof o === "string")
            : undefined,
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
            agentTopicId: sess.topicId,
            patch: {
              status: typeof body?.status === "string" ? body.status : undefined,
              priority: typeof body?.priority === "number" ? body.priority : undefined,
              assignedTo: typeof body?.assignee === "string" ? body.assignee : undefined,
              outputUrl: typeof body?.output_url === "string" ? body.output_url : undefined,
              // The agent may refine wording (a raw composer-born title →
              // clear, concise one). Same projectId guard as everything else.
              text: typeof body?.text === "string" && body.text.trim() ? body.text : undefined,
              description: typeof body?.description === "string" ? body.description : undefined,
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
