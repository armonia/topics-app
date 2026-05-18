import type { AppContext, RouteHandler } from "../types";
import { rowToTask, checkBlockers as sharedCheckBlockers } from "../converters";

export function createBoardsRouter(ctx: AppContext): RouteHandler {
  const { db, json, readJSON, matchRoute, errorResponse, broadcastToAll } = ctx;

  // Valid task statuses
  const VALID_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'];

  // --- Prepared statements ---
  const stmts = {
    listTasks: db.prepare(`
      SELECT t.*, GROUP_CONCAT(DISTINCT td_block.blocked_id) as blocks,
             GROUP_CONCAT(DISTINCT td_by.blocker_id) as blocked_by
      FROM tasks t
      LEFT JOIN task_dependencies td_block ON td_block.blocker_id = t.id
      LEFT JOIN task_dependencies td_by ON td_by.blocked_id = t.id
      WHERE t.project_id = ? AND t.archived = 0
      GROUP BY t.id
      ORDER BY t.kanban_order ASC
    `),
    listTasksIncludeArchived: db.prepare(`
      SELECT t.*, GROUP_CONCAT(DISTINCT td_block.blocked_id) as blocks,
             GROUP_CONCAT(DISTINCT td_by.blocker_id) as blocked_by
      FROM tasks t
      LEFT JOIN task_dependencies td_block ON td_block.blocker_id = t.id
      LEFT JOIN task_dependencies td_by ON td_by.blocked_id = t.id
      WHERE t.project_id = ?
      GROUP BY t.id
      ORDER BY t.kanban_order ASC
    `),
    getTask: db.prepare(`SELECT * FROM tasks WHERE id = ? AND project_id = ?`),
    getTaskById: db.prepare(`SELECT * FROM tasks WHERE id = ?`),
    maxOrder: db.prepare(`SELECT COALESCE(MAX(kanban_order), 0) as m FROM tasks WHERE project_id = ?`),
    insertTask: db.prepare(`
      INSERT INTO tasks (id, project_id, text, description, status, priority, kanban_order, assigned_to, assigned_agent_id, fingerprint, due_date, chat_id, created_at, completed_at, updated_at)
      VALUES ($id, $project_id, $text, $description, $status, $priority, $kanban_order, $assigned_to, $assigned_agent_id, $fingerprint, $due_date, $chat_id, $created_at, $completed_at, $updated_at)
    `),
    updateTask: db.prepare(`
      UPDATE tasks SET text=$text, description=$description, status=$status, priority=$priority,
        kanban_order=$kanban_order, assigned_to=$assigned_to, assigned_agent_id=$assigned_agent_id, fingerprint=$fingerprint, due_date=$due_date,
        chat_id=$chat_id, in_progress_at=$in_progress_at, completed_at=$completed_at, updated_at=$updated_at
      WHERE id=$id
    `),
    deleteTask: db.prepare(`DELETE FROM tasks WHERE id = ? AND project_id = ?`),

    // Dependencies
    getDeps: db.prepare(`SELECT * FROM task_dependencies WHERE blocker_id = ? OR blocked_id = ?`),
    getBlockers: db.prepare(`SELECT blocker_id FROM task_dependencies WHERE blocked_id = ?`),
    getBlocked: db.prepare(`SELECT blocked_id FROM task_dependencies WHERE blocker_id = ?`),
    addDep: db.prepare(`INSERT OR IGNORE INTO task_dependencies (blocker_id, blocked_id) VALUES (?, ?)`),
    removeDep: db.prepare(`DELETE FROM task_dependencies WHERE blocker_id = ? AND blocked_id = ?`),

    // Tags for task
    getTaskTags: db.prepare(`
      SELECT t.* FROM tags t
      JOIN task_tags tt ON tt.tag_id = t.id
      WHERE tt.task_id = ?
    `),
    addTaskTag: db.prepare(`INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)`),
    removeTaskTag: db.prepare(`DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?`),

    // Comments
    getComments: db.prepare(`SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC`),
    insertComment: db.prepare(`
      INSERT INTO task_comments (id, task_id, author, content, mentions, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    deleteComment: db.prepare(`DELETE FROM task_comments WHERE id = ? AND task_id = ?`),

    // Board settings
    getSettings: db.prepare(`SELECT * FROM board_settings WHERE project_id = ?`),
    upsertSettings: db.prepare(`
      INSERT OR REPLACE INTO board_settings (project_id, require_approval_for_done, require_review_before_done, block_status_with_pending, only_lead_can_change_status, max_agents, auto_expire_hours)
      VALUES ($project_id, $require_approval_for_done, $require_review_before_done, $block_status_with_pending, $only_lead_can_change_status, $max_agents, $auto_expire_hours)
    `),
  };

  // Local shorthands for shared converters
  const toTask = (row: any) => rowToTask(row, stmts.getTaskTags);

  function checkBlockers(taskId: string, targetStatus: string): { blocked: boolean; blockers: string[] } {
    return sharedCheckBlockers(taskId, targetStatus, { getBlockers: stmts.getBlockers, getTaskById: stmts.getTaskById });
  }

  // Global list (all projects)
  const listAllTasks = db.prepare(`
    SELECT t.*, GROUP_CONCAT(DISTINCT td_block.blocked_id) as blocks,
           GROUP_CONCAT(DISTINCT td_by.blocker_id) as blocked_by
    FROM tasks t
    LEFT JOIN task_dependencies td_block ON td_block.blocker_id = t.id
    LEFT JOIN task_dependencies td_by ON td_by.blocked_id = t.id
    WHERE t.archived = 0
    GROUP BY t.id
    ORDER BY t.kanban_order ASC
  `);
  const listAllTasksIncludeArchived = db.prepare(`
    SELECT t.*, GROUP_CONCAT(DISTINCT td_block.blocked_id) as blocks,
           GROUP_CONCAT(DISTINCT td_by.blocker_id) as blocked_by
    FROM tasks t
    LEFT JOIN task_dependencies td_block ON td_block.blocker_id = t.id
    LEFT JOIN task_dependencies td_by ON td_by.blocked_id = t.id
    GROUP BY t.id
    ORDER BY t.kanban_order ASC
  `);

  // Archive statements
  const archiveTask = db.prepare(`UPDATE tasks SET archived = 1, updated_at = ? WHERE id = ? AND project_id = ?`);
  const unarchiveTask = db.prepare(`UPDATE tasks SET archived = 0, updated_at = ? WHERE id = ? AND project_id = ?`);
  const archiveAllForProject = db.prepare(`UPDATE tasks SET archived = 1, updated_at = ? WHERE project_id = ?`);
  const countArchivedForProject = db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE project_id = ? AND archived = 1`);

  return async function boardsRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // ---- Global Tasks ----

    // GET /api/boards/tasks — all tasks across all projects
    if (pathname === "/api/boards/tasks" && method === "GET") {
      const statusFilter = url.searchParams.get("status");
      const includeArchived = url.searchParams.get("include_archived") === "true";
      let rows = (includeArchived ? listAllTasksIncludeArchived : listAllTasks).all() as any[];
      if (statusFilter) rows = rows.filter(r => r.status === statusFilter);
      return json({ tasks: rows.map(toTask) });
    }

    // ---- Tasks CRUD ----

    // GET /api/boards/:projectId/tasks
    {
      const params = matchRoute(pathname, "/api/boards/:projectId/tasks");
      if (params && method === "GET") {
        const statusFilter = url.searchParams.get("status");
        const priorityFilter = url.searchParams.get("priority");
        const assignedFilter = url.searchParams.get("assigned_to");
        const includeArchived = url.searchParams.get("include_archived") === "true";

        let rows = (includeArchived ? stmts.listTasksIncludeArchived : stmts.listTasks).all(params.projectId) as any[];

        if (statusFilter) rows = rows.filter(r => r.status === statusFilter);
        if (priorityFilter) rows = rows.filter(r => r.priority === parseInt(priorityFilter));
        if (assignedFilter) rows = rows.filter(r => r.assigned_to === assignedFilter);

        return json({ tasks: rows.map(toTask) });
      }

      // POST /api/boards/:projectId/tasks
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.text) return errorResponse(400, "text required");

        const maxRow = stmts.maxOrder.get(params.projectId) as any;
        const now = new Date().toISOString();
        const status = body.status && VALID_STATUSES.includes(body.status) ? body.status : 'todo';

        const id = crypto.randomUUID();
        stmts.insertTask.run({
          $id: id,
          $project_id: params.projectId,
          $text: body.text,
          $description: body.description || null,
          $status: status,
          $priority: body.priority ?? 2,
          $kanban_order: (maxRow?.m ?? 0) + 1,
          $assigned_to: body.assignedTo || null,
          $assigned_agent_id: body.assignedAgentId || null,
          $fingerprint: body.fingerprint || null,
          $due_date: body.dueDate || null,
          $chat_id: body.chatId || null,
          $created_at: now,
          $completed_at: null,
          $updated_at: now,
        });

        // Add tags if provided
        if (Array.isArray(body.tagIds)) {
          for (const tagId of body.tagIds) {
            stmts.addTaskTag.run(id, tagId);
          }
        }

        const row = stmts.listTasks.all(params.projectId).find((r: any) => r.id === id);
        const task = row ? toTask(row) : { id };
        broadcastToAll({ type: "task:created", projectId: params.projectId, task });
        broadcastToAll({ type: "dashboard:updated" });
        return json(task, 201);
      }
    }

    // PATCH /api/boards/:projectId/tasks/:id
    {
      const params = matchRoute(pathname, "/api/boards/:projectId/tasks/:id");
      if (params && method === "PATCH") {
        const body = await readJSON(req);
        if (!body) return errorResponse(400, "body required");

        const row = stmts.getTask.get(params.id, params.projectId) as any;
        if (!row) return errorResponse(404, "Task not found");

        // Check dependency blocking for status changes
        if (body.status && body.status !== row.status) {
          const { blocked, blockers } = checkBlockers(params.id, body.status);
          if (blocked) {
            return errorResponse(409, "Task is blocked by unfinished dependencies", {
              details: { blockers },
            });
          }
        }

        const now = new Date().toISOString();
        const newStatus = body.status !== undefined ? body.status : row.status;
        stmts.updateTask.run({
          $id: params.id,
          $text: body.text !== undefined ? body.text : row.text,
          $description: body.description !== undefined ? body.description : row.description,
          $status: newStatus,
          $priority: body.priority !== undefined ? body.priority : row.priority,
          $kanban_order: body.kanbanOrder !== undefined ? body.kanbanOrder : row.kanban_order,
          $assigned_to: body.assignedTo !== undefined ? body.assignedTo : row.assigned_to,
          $assigned_agent_id: body.assignedAgentId !== undefined ? body.assignedAgentId : row.assigned_agent_id,
          $fingerprint: body.fingerprint !== undefined ? body.fingerprint : row.fingerprint,
          $due_date: body.dueDate !== undefined ? body.dueDate : row.due_date,
          $chat_id: body.chatId !== undefined ? body.chatId : row.chat_id,
          $in_progress_at: newStatus === 'in_progress' && row.status !== 'in_progress' ? now : row.in_progress_at,
          $completed_at: (body.status === 'done') ? now : (body.status && body.status !== 'done') ? null : row.completed_at,
          $updated_at: now,
        });

        // Update tags if provided
        if (Array.isArray(body.tagIds)) {
          db.prepare("DELETE FROM task_tags WHERE task_id = ?").run(params.id);
          for (const tagId of body.tagIds) {
            stmts.addTaskTag.run(params.id, tagId);
          }
        }

        const updated = stmts.listTasks.all(params.projectId).find((r: any) => r.id === params.id);
        const task = updated ? toTask(updated) : { id: params.id };
        broadcastToAll({ type: "task:updated", projectId: params.projectId, task });
        broadcastToAll({ type: "dashboard:updated" });
        return json(task);
      }

      // POST /api/boards/:projectId/tasks/:id/assign-topic
      // KANBAN-DELTA-01 (jump-to-tab) — bind a task to a teammate Topic.
      // Body: { assignedTopicId: string | null }
      {
        const assignParams = matchRoute(pathname, "/api/boards/:projectId/tasks/:id/assign-topic");
        if (assignParams && method === "POST") {
          const body = await readJSON(req);
          const assignedTopicId = body?.assignedTopicId ?? null;
          if (assignedTopicId !== null && typeof assignedTopicId !== "string") {
            return errorResponse(400, "assignedTopicId must be a string or null");
          }
          const taskRow = stmts.getTask.get(assignParams.id, assignParams.projectId);
          if (!taskRow) return errorResponse(404, "Task not found");
          // Validate topic exists if provided.
          if (assignedTopicId) {
            const t = db.prepare("SELECT id FROM topics WHERE id = ?").get(assignedTopicId);
            if (!t) return errorResponse(400, "Topic not found");
          }
          try {
            db.prepare("UPDATE tasks SET assigned_topic_id = ?, updated_at = ? WHERE id = ? AND project_id = ?").run(
              assignedTopicId, new Date().toISOString(), assignParams.id, assignParams.projectId,
            );
          } catch (err: any) {
            // Column missing → migration 026 not applied.
            return errorResponse(500, "migration 026 (assigned_topic_id) not applied: " + err.message);
          }
          const updated = stmts.getTask.get(assignParams.id, assignParams.projectId);
          const task = updated ? toTask(updated) : { id: assignParams.id };
          broadcastToAll({ type: "task:updated", projectId: assignParams.projectId, task });
          // Phase D — emit a focus hint so a connected client can scroll its
          // pane manager to the bound teammate Topic.
          if (assignedTopicId) {
            broadcastToAll({ type: "pane:focus-suggest", topicId: assignedTopicId, taskId: assignParams.id });
          }
          return json(task);
        }
      }

      // DELETE /api/boards/:projectId/tasks/:id
      if (params && method === "DELETE") {
        const row = stmts.getTask.get(params.id, params.projectId);
        if (!row) return errorResponse(404, "Task not found");
        stmts.deleteTask.run(params.id, params.projectId);
        broadcastToAll({ type: "task:deleted", projectId: params.projectId, taskId: params.id });
        broadcastToAll({ type: "dashboard:updated" });
        return json({ ok: true });
      }
    }

    // POST /api/boards/:projectId/tasks/:id/move
    {
      const params = matchRoute(pathname, "/api/boards/:projectId/tasks/:id/move");
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.status) return errorResponse(400, "status required");
        if (!VALID_STATUSES.includes(body.status)) return errorResponse(400, "Invalid status");

        const row = stmts.getTask.get(params.id, params.projectId) as any;
        if (!row) return errorResponse(404, "Task not found");

        const { blocked, blockers } = checkBlockers(params.id, body.status);
        if (blocked) {
          return errorResponse(409, "Task is blocked by unfinished dependencies", { details: { blockers } });
        }

        const now = new Date().toISOString();
        const newOrder = body.kanbanOrder ?? row.kanban_order;
        stmts.updateTask.run({
          $id: params.id,
          $text: row.text, $description: row.description,
          $status: body.status, $priority: row.priority,
          $kanban_order: newOrder,
          $assigned_to: row.assigned_to, $assigned_agent_id: row.assigned_agent_id, $fingerprint: row.fingerprint,
          $due_date: row.due_date, $chat_id: row.chat_id,
          $in_progress_at: body.status === 'in_progress' && row.status !== 'in_progress' ? now : row.in_progress_at,
          $completed_at: body.status === 'done' ? now : null,
          $updated_at: now,
        });

        const updated = stmts.listTasks.all(params.projectId).find((r: any) => r.id === params.id);
        const task = updated ? toTask(updated) : { id: params.id };
        broadcastToAll({ type: "task:moved", projectId: params.projectId, task });
        broadcastToAll({ type: "dashboard:updated" });
        return json(task);
      }
    }

    // ---- Dependencies ----

    // GET /api/boards/:projectId/tasks/:id/dependencies
    {
      const params = matchRoute(pathname, "/api/boards/:projectId/tasks/:id/dependencies");
      if (params && method === "GET") {
        const blockers = (stmts.getBlockers.all(params.id) as any[]).map(r => r.blocker_id);
        const blocking = (stmts.getBlocked.all(params.id) as any[]).map(r => r.blocked_id);
        return json({ blockers, blocking });
      }

      // POST - add dependency
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.blockerId && !body?.blockedId) return errorResponse(400, "blockerId or blockedId required");

        if (body.blockerId) {
          // This task is blocked by blockerId
          if (body.blockerId === params.id) return errorResponse(400, "Cannot block self");
          stmts.addDep.run(body.blockerId, params.id);
        }
        if (body.blockedId) {
          // This task blocks blockedId
          if (body.blockedId === params.id) return errorResponse(400, "Cannot block self");
          stmts.addDep.run(params.id, body.blockedId);
        }

        broadcastToAll({ type: "task:dependency:added", projectId: params.projectId, taskId: params.id });
        return json({ ok: true }, 201);
      }

      // DELETE - remove dependency
      if (params && method === "DELETE") {
        const body = await readJSON(req);
        if (body?.blockerId) stmts.removeDep.run(body.blockerId, params.id);
        if (body?.blockedId) stmts.removeDep.run(params.id, body.blockedId);
        broadcastToAll({ type: "task:dependency:removed", projectId: params.projectId, taskId: params.id });
        return json({ ok: true });
      }
    }

    // ---- Comments ----

    // GET/POST /api/boards/:projectId/tasks/:id/comments
    {
      const params = matchRoute(pathname, "/api/boards/:projectId/tasks/:id/comments");
      if (params && method === "GET") {
        const rows = stmts.getComments.all(params.id) as any[];
        const comments = rows.map(r => ({
          id: r.id, taskId: r.task_id, author: r.author,
          content: r.content, mentions: r.mentions ? JSON.parse(r.mentions) : [],
          createdAt: r.created_at,
        }));
        return json({ comments });
      }

      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.content) return errorResponse(400, "content required");

        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const mentions = Array.isArray(body.mentions) ? body.mentions : [];

        stmts.insertComment.run(id, params.id, body.author || 'user', body.content, JSON.stringify(mentions), now);

        const comment = { id, taskId: params.id, author: body.author || 'user', content: body.content, mentions, createdAt: now };
        broadcastToAll({ type: "task:comment:added", projectId: params.projectId, taskId: params.id, comment });
        return json(comment, 201);
      }
    }

    // DELETE /api/boards/:projectId/tasks/:id/comments/:commentId
    {
      const params = matchRoute(pathname, "/api/boards/:projectId/tasks/:id/comments/:commentId");
      if (params && method === "DELETE") {
        stmts.deleteComment.run(params.commentId, params.id);
        return json({ ok: true });
      }
    }

    // ---- Board Memory (public, no agent auth) ----

    // GET /api/boards/:projectId/memory
    {
      const params = matchRoute(pathname, "/api/boards/:projectId/memory");
      if (params && method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        const isChatFilter = url.searchParams.get("is_chat");

        let rows: any[];
        if (isChatFilter !== null) {
          rows = db.prepare(
            `SELECT * FROM board_memory WHERE project_id = ? AND is_chat = ? ORDER BY created_at DESC LIMIT ?`
          ).all(params.projectId, isChatFilter === "true" ? 1 : 0, limit) as any[];
        } else {
          rows = db.prepare(
            `SELECT * FROM board_memory WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`
          ).all(params.projectId, limit) as any[];
        }

        const memory = rows.map((row: any) => ({
          id: row.id,
          projectId: row.project_id,
          content: row.content,
          tags: row.tags ? JSON.parse(row.tags) : [],
          isChat: !!row.is_chat,
          source: row.source || null,
          agentId: row.agent_id || null,
          createdAt: row.created_at,
        }));
        return json({ memory });
      }

      // POST /api/boards/:projectId/memory
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.content) return errorResponse(400, "content required");

        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        db.prepare(`
          INSERT INTO board_memory (id, project_id, content, tags, is_chat, source, agent_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, params.projectId, body.content, body.tags ? JSON.stringify(body.tags) : "[]", body.isChat ? 1 : 0, body.source || "user", null, now);

        const row = db.prepare(`SELECT * FROM board_memory WHERE id = ?`).get(id) as any;
        const memory = row ? {
          id: row.id,
          projectId: row.project_id,
          content: row.content,
          tags: row.tags ? JSON.parse(row.tags) : [],
          isChat: !!row.is_chat,
          source: row.source || null,
          agentId: row.agent_id || null,
          createdAt: row.created_at,
        } : { id };

        broadcastToAll({ type: "board:memory_added", projectId: params.projectId, memory });
        return json(memory, 201);
      }
    }

    // ---- Board Settings ----

    // GET/PUT /api/boards/:projectId/settings
    {
      const params = matchRoute(pathname, "/api/boards/:projectId/settings");
      if (params && method === "GET") {
        const row = stmts.getSettings.get(params.projectId) as any;
        if (!row) {
          return json({
            projectId: params.projectId,
            requireApprovalForDone: false, requireReviewBeforeDone: false,
            blockStatusWithPending: false, onlyLeadCanChangeStatus: false,
            maxAgents: 5, autoExpireHours: 24,
          });
        }
        return json({
          projectId: row.project_id,
          requireApprovalForDone: !!row.require_approval_for_done,
          requireReviewBeforeDone: !!row.require_review_before_done,
          blockStatusWithPending: !!row.block_status_with_pending,
          onlyLeadCanChangeStatus: !!row.only_lead_can_change_status,
          maxAgents: row.max_agents, autoExpireHours: row.auto_expire_hours,
        });
      }

      if (params && method === "PUT") {
        const body = await readJSON(req);
        if (!body) return errorResponse(400, "body required");
        stmts.upsertSettings.run({
          $project_id: params.projectId,
          $require_approval_for_done: body.requireApprovalForDone ? 1 : 0,
          $require_review_before_done: body.requireReviewBeforeDone ? 1 : 0,
          $block_status_with_pending: body.blockStatusWithPending ? 1 : 0,
          $only_lead_can_change_status: body.onlyLeadCanChangeStatus ? 1 : 0,
          $max_agents: body.maxAgents ?? 5,
          $auto_expire_hours: body.autoExpireHours ?? 24,
        });
        return json({ ok: true });
      }
    }

    // ---- Archive ----

    // POST /api/boards/:projectId/tasks/:id/archive
    {
      const params = matchRoute(pathname, "/api/boards/:projectId/tasks/:id/archive");
      if (params && method === "POST") {
        const row = stmts.getTask.get(params.id, params.projectId) as any;
        if (!row) {
          // Also check archived tasks
          const archivedRow = db.prepare(`SELECT * FROM tasks WHERE id = ? AND project_id = ?`).get(params.id, params.projectId);
          if (!archivedRow) return errorResponse(404, "Task not found");
        }
        const now = new Date().toISOString();
        archiveTask.run(now, params.id, params.projectId);
        broadcastToAll({ type: "task:archived", projectId: params.projectId, taskId: params.id });
        broadcastToAll({ type: "dashboard:updated" });
        return json({ ok: true });
      }
    }

    // POST /api/boards/:projectId/tasks/:id/unarchive
    {
      const params = matchRoute(pathname, "/api/boards/:projectId/tasks/:id/unarchive");
      if (params && method === "POST") {
        const row = db.prepare(`SELECT * FROM tasks WHERE id = ? AND project_id = ?`).get(params.id, params.projectId);
        if (!row) return errorResponse(404, "Task not found");
        const now = new Date().toISOString();
        unarchiveTask.run(now, params.id, params.projectId);

        const updated = stmts.listTasks.all(params.projectId).find((r: any) => r.id === params.id);
        const task = updated ? toTask(updated) : { id: params.id };
        broadcastToAll({ type: "task:unarchived", projectId: params.projectId, task });
        broadcastToAll({ type: "dashboard:updated" });
        return json(task);
      }
    }

    // POST /api/boards/:projectId/archive-all — archive all tasks for a project
    {
      const params = matchRoute(pathname, "/api/boards/:projectId/archive-all");
      if (params && method === "POST") {
        const now = new Date().toISOString();
        const result = archiveAllForProject.run(now, params.projectId);
        broadcastToAll({ type: "board:archived_all", projectId: params.projectId });
        broadcastToAll({ type: "dashboard:updated" });
        return json({ ok: true, archivedCount: result.changes });
      }
    }

    // GET /api/boards/:projectId/archived-count
    {
      const params = matchRoute(pathname, "/api/boards/:projectId/archived-count");
      if (params && method === "GET") {
        const row = countArchivedForProject.get(params.projectId) as any;
        return json({ count: row?.count ?? 0 });
      }
    }

    return null;
  };
}
