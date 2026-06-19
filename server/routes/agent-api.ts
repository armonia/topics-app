import type { AppContext, RouteHandler } from "../types";
import { authenticateAgent, mintAgentToken, hashToken } from "../middleware/agent-auth";
import { rowToTask, rowToApproval, rowToMemory, rowToAction, checkBlockers } from "../converters";

export function createAgentApiRouter(ctx: AppContext): RouteHandler {
  const { db, json, readJSON, matchRoute, errorResponse, broadcastToAll } = ctx;

  const VALID_STATUSES = ["backlog", "todo", "in_progress", "review", "done"];

  // --- Prepared statements ---
  const stmts = {
    // Tasks
    listTasks: db.prepare(`
      SELECT t.*, GROUP_CONCAT(DISTINCT td_block.blocked_id) as blocks,
             GROUP_CONCAT(DISTINCT td_by.blocker_id) as blocked_by
      FROM tasks t
      LEFT JOIN task_dependencies td_block ON td_block.blocker_id = t.id
      LEFT JOIN task_dependencies td_by ON td_by.blocked_id = t.id
      WHERE t.project_id = ?
      GROUP BY t.id
      ORDER BY t.kanban_order ASC
    `),
    getTask: db.prepare(`SELECT * FROM tasks WHERE id = ?`),
    getTaskInProject: db.prepare(`SELECT * FROM tasks WHERE id = ? AND project_id = ?`),
    maxOrder: db.prepare(`SELECT COALESCE(MAX(kanban_order), 0) as m FROM tasks WHERE project_id = ?`),
    insertTask: db.prepare(`
      INSERT INTO tasks (id, project_id, text, description, status, priority, kanban_order, assigned_to, assigned_agent_id, fingerprint, due_date, chat_id, created_at, completed_at, updated_at)
      VALUES ($id, $project_id, $text, $description, $status, $priority, $kanban_order, $assigned_to, $assigned_agent_id, $fingerprint, $due_date, $chat_id, $created_at, $completed_at, $updated_at)
    `),
    updateTaskClaim: db.prepare(`
      UPDATE tasks SET assigned_agent_id=$assigned_agent_id, assigned_to=$assigned_to, fingerprint=$fingerprint,
        status=$status, in_progress_at=$in_progress_at, updated_at=$updated_at
      WHERE id=$id AND status IN ('backlog','todo') AND (assigned_agent_id IS NULL OR assigned_agent_id = $assigned_agent_id)
    `),
    updateTaskStatus: db.prepare(`
      UPDATE tasks SET status=$status, completed_at=$completed_at, updated_at=$updated_at WHERE id=$id
    `),
    updateTask: db.prepare(`
      UPDATE tasks SET text=$text, description=$description, status=$status, priority=$priority,
        kanban_order=$kanban_order, assigned_to=$assigned_to, assigned_agent_id=$assigned_agent_id, fingerprint=$fingerprint,
        due_date=$due_date, chat_id=$chat_id, in_progress_at=$in_progress_at, completed_at=$completed_at, updated_at=$updated_at
      WHERE id=$id
    `),
    deleteTask: db.prepare(`DELETE FROM tasks WHERE id = ? AND project_id = ?`),
    countAgentActiveTasks: db.prepare(`
      SELECT COUNT(*) as count FROM tasks WHERE assigned_agent_id = ? AND status = 'in_progress'
    `),

    // Blockers
    getActiveBlockers: db.prepare(`
      SELECT td.blocker_id FROM task_dependencies td
      JOIN tasks t ON t.id = td.blocker_id
      WHERE td.blocked_id = ? AND t.status != 'done'
    `),
    getBlockers: db.prepare(`SELECT blocker_id FROM task_dependencies WHERE blocked_id = ?`),

    // Tags
    getTaskTags: db.prepare(`
      SELECT t.* FROM tags t JOIN task_tags tt ON tt.tag_id = t.id WHERE tt.task_id = ?
    `),

    // Comments
    insertComment: db.prepare(`
      INSERT INTO task_comments (id, task_id, author, content, mentions, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),

    // Board settings
    getSettings: db.prepare(`SELECT * FROM board_settings WHERE project_id = ?`),

    // Approvals
    insertApproval: db.prepare(`
      INSERT INTO approvals (id, task_id, requested_by, approval_type, from_status, to_status, confidence_score, rubric_scores, justification, status, created_at, expires_at)
      VALUES ($id, $task_id, $requested_by, $approval_type, $from_status, $to_status, $confidence_score, $rubric_scores, $justification, 'pending', $created_at, $expires_at)
    `),
    getApproval: db.prepare(`SELECT * FROM approvals WHERE id = ?`),
    getApprovalForTask: db.prepare(`SELECT id FROM approvals WHERE task_id = ? AND status = 'pending' LIMIT 1`),
    listPendingApprovals: db.prepare(`
      SELECT a.*, t.text as task_text, t.status as task_status
      FROM approvals a
      JOIN tasks t ON t.id = a.task_id
      WHERE t.project_id = ? AND a.status = 'pending'
      ORDER BY a.created_at DESC
    `),

    // Board memory
    listMemory: db.prepare(`SELECT * FROM board_memory WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`),
    listMemoryFiltered: db.prepare(`SELECT * FROM board_memory WHERE project_id = ? AND is_chat = ? ORDER BY created_at DESC LIMIT ?`),
    insertMemory: db.prepare(`
      INSERT INTO board_memory (id, project_id, content, tags, is_chat, source, agent_id, created_at)
      VALUES ($id, $project_id, $content, $tags, $is_chat, $source, $agent_id, $created_at)
    `),
    getMemory: db.prepare(`SELECT * FROM board_memory WHERE id = ?`),

    // Actions log
    logAction: db.prepare(`
      INSERT INTO agent_actions_log (id, agent_id, action_type, entity_type, entity_id, detail, created_at)
      VALUES ($id, $agent_id, $action_type, $entity_type, $entity_id, $detail, $created_at)
    `),
    listActions: db.prepare(`
      SELECT * FROM agent_actions_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?
    `),
    listActionsAll: db.prepare(`
      SELECT * FROM agent_actions_log ORDER BY created_at DESC LIMIT ?
    `),

    // Agent profiles
    getProfile: db.prepare(`SELECT * FROM agent_profiles WHERE id = ?`),
    updateLastSeen: db.prepare(`UPDATE agent_profiles SET last_seen_at = ? WHERE id = ?`),

    // Token management
    setTokenHash: db.prepare(`UPDATE agent_profiles SET agent_token_hash = ?, updated_at = ? WHERE id = ?`),
  };

  // Local shorthands for shared converters
  const toTask = (row: any) => rowToTask(row, stmts.getTaskTags);
  const toMemory = (row: any) => rowToMemory(row);
  const toAction = (row: any) => rowToAction(row);
  const toApproval = (row: any) => rowToApproval(row);

  return async function agentApiRouter(
    req: Request,
    url: URL,
    pathname: string,
    method: string
  ): Promise<Response | null> {
    // Only handle /api/agent/* routes (not /api/agents/* which is the profiles router)
    if (!pathname.startsWith("/api/agent/") && pathname !== "/api/agent") return null;
    if (pathname.startsWith("/api/agents/")) return null;

    // --- Token provisioning (admin, no agent auth) ---

    // POST /api/agent/provision/:agentId — mint token for an existing agent profile
    {
      const params = matchRoute(pathname, "/api/agent/provision/:agentId");
      if (params && method === "POST") {
        // Bug 1 fix: Require admin auth via X-Admin-Token matching GATEWAY_TOKEN
        const adminToken = req.headers.get("x-admin-token");
        if (!adminToken || adminToken !== ctx.GATEWAY_TOKEN) {
          return errorResponse(401, "X-Admin-Token required for provisioning");
        }

        const profile = stmts.getProfile.get(params.agentId) as any;
        if (!profile) return errorResponse(404, "Agent profile not found");

        const { token, hash } = mintAgentToken();
        const now = new Date().toISOString();
        stmts.setTokenHash.run(hash, now, params.agentId);

        return json({ token, agentId: params.agentId, warning: "Store this token securely. It cannot be retrieved later." }, 201);
      }
    }

    // ========================================
    // Everything below requires agent auth
    // ========================================

    const auth = authenticateAgent(req, db);
    if (!auth) {
      // Allow unauthenticated access to healthz for connectivity check
      if (pathname === "/api/agent/healthz" && method === "GET") {
        return errorResponse(401, "X-Agent-Token header required");
      }
      if (pathname.startsWith("/api/agent/")) {
        return errorResponse(401, "X-Agent-Token header required");
      }
      return null;
    }

    const { agent, isLead } = auth;

    // --- Health & Discovery ---

    // GET /api/agent/healthz
    if (pathname === "/api/agent/healthz" && method === "GET") {
      return json({
        ok: true,
        agentId: agent.id,
        name: agent.name,
        role: agent.role,
        status: agent.status,
        isLead,
      });
    }

    // POST /api/agent/heartbeat
    if (pathname === "/api/agent/heartbeat" && method === "POST") {
      const now = new Date().toISOString();
      let wasOffline = false;

      db.transaction(() => {
        stmts.updateLastSeen.run(now, agent.id);
        const profile = stmts.getProfile.get(agent.id) as any;
        if (profile && profile.status === "offline") {
          db.prepare("UPDATE agent_profiles SET status = 'available', updated_at = ? WHERE id = ?").run(now, agent.id);
          wasOffline = true;
        }
      })();

      if (wasOffline) {
        broadcastToAll({ type: "agent:status", agentId: agent.id, status: "available", previousStatus: "offline" });
      }

      broadcastToAll({ type: "agent:heartbeat", agentId: agent.id, timestamp: now });
      return json({ ok: true, timestamp: now });
    }

    // --- Task Operations ---

    // GET /api/agent/boards/:projectId/tasks
    {
      const params = matchRoute(pathname, "/api/agent/boards/:projectId/tasks");
      if (params && method === "GET") {
        let rows = stmts.listTasks.all(params.projectId) as any[];

        const statusFilter = url.searchParams.get("status");
        const unassigned = url.searchParams.get("unassigned");
        const assignedAgentId = url.searchParams.get("assigned_agent_id");

        if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
        if (unassigned === "true") rows = rows.filter((r) => !r.assigned_agent_id);
        if (assignedAgentId) rows = rows.filter((r) => r.assigned_agent_id === assignedAgentId);

        return json({ tasks: rows.map(toTask) });
      }

      // POST /api/agent/boards/:projectId/tasks — Lead only: create task
      if (params && method === "POST") {
        if (!isLead) return errorResponse(403, "Only lead agents can create tasks");

        const body = await readJSON(req);
        if (!body?.text) return errorResponse(400, "text required");

        const maxRow = stmts.maxOrder.get(params.projectId) as any;
        const now = new Date().toISOString();
        const status = body.status && VALID_STATUSES.includes(body.status) ? body.status : "todo";
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

        stmts.logAction.run({
          $id: crypto.randomUUID(),
          $agent_id: agent.id,
          $action_type: "task.created",
          $entity_type: "task",
          $entity_id: id,
          $detail: JSON.stringify({ text: body.text, status }),
          $created_at: now,
        });

        const row = stmts.listTasks.all(params.projectId).find((r: any) => r.id === id);
        const task = row ? toTask(row) : { id };
        broadcastToAll({ type: "task:created", projectId: params.projectId, task });
        return json(task, 201);
      }
    }

    // PATCH /api/agent/boards/:projectId/tasks/:taskId
    {
      const params = matchRoute(pathname, "/api/agent/boards/:projectId/tasks/:taskId");
      if (params && method === "PATCH") {
        const body = await readJSON(req);
        if (!body) return errorResponse(400, "body required");

        const row = stmts.getTaskInProject.get(params.taskId, params.projectId) as any;
        if (!row) return errorResponse(404, "Task not found");

        // Check dependency blocking for status changes
        if (body.status && body.status !== row.status) {
          const { blocked, blockers } = checkBlockers(params.taskId, body.status, { getBlockers: stmts.getBlockers, getTaskById: stmts.getTask });
          if (blocked) {
            return errorResponse(409, "Task is blocked by unfinished dependencies", { details: { blockers } });
          }
        }

        const now = new Date().toISOString();
        const newStatus = body.status !== undefined ? body.status : row.status;
        stmts.updateTask.run({
          $id: params.taskId,
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
          $in_progress_at: newStatus === "in_progress" && row.status !== "in_progress" ? now : row.in_progress_at,
          $completed_at: body.status === "done" ? now : body.status && body.status !== "done" ? null : row.completed_at,
          $updated_at: now,
        });

        const updated = stmts.listTasks.all(params.projectId).find((r: any) => r.id === params.taskId);
        const task = updated ? toTask(updated) : { id: params.taskId };
        broadcastToAll({ type: "task:updated", projectId: params.projectId, task });
        return json(task);
      }

      // DELETE /api/agent/boards/:projectId/tasks/:taskId — Lead only
      if (params && method === "DELETE") {
        if (!isLead) return errorResponse(403, "Only lead agents can delete tasks");

        const row = stmts.getTaskInProject.get(params.taskId, params.projectId);
        if (!row) return errorResponse(404, "Task not found");

        stmts.deleteTask.run(params.taskId, params.projectId);

        stmts.logAction.run({
          $id: crypto.randomUUID(),
          $agent_id: agent.id,
          $action_type: "task.deleted",
          $entity_type: "task",
          $entity_id: params.taskId,
          $detail: null,
          $created_at: new Date().toISOString(),
        });

        broadcastToAll({ type: "task:deleted", projectId: params.projectId, taskId: params.taskId });
        return json({ ok: true });
      }
    }

    // POST /api/agent/boards/:projectId/tasks/:taskId/claim
    {
      const params = matchRoute(pathname, "/api/agent/boards/:projectId/tasks/:taskId/claim");
      if (params && method === "POST") {
        const now = new Date().toISOString();
        let fromStatus: string | null = null;

        try {
          db.transaction(() => {
            // Re-fetch inside transaction for atomicity
            const task = stmts.getTask.get(params.taskId) as any;
            if (!task) throw { status: 404, msg: "Task not found" };
            if (task.project_id !== params.projectId) throw { status: 404, msg: "Task not found" };

            if (!["backlog", "todo"].includes(task.status)) {
              throw { status: 409, msg: `Task status is ${task.status}, cannot claim` };
            }
            if (task.assigned_agent_id && task.assigned_agent_id !== agent.id) {
              throw { status: 409, msg: "Task already assigned to another agent" };
            }

            const blockers = (stmts.getActiveBlockers.all(params.taskId) || []) as any[];
            if (blockers.length > 0) {
              throw { status: 409, msg: "Task is blocked", details: { blockers: blockers.map((b: any) => b.blocker_id) } };
            }

            const activeTasks = stmts.countAgentActiveTasks.get(agent.id) as any;
            if (activeTasks.count >= agent.maxConcurrentTasks) {
              throw { status: 429, msg: "Agent at max concurrent tasks" };
            }

            fromStatus = task.status;

            // Atomic claim with WHERE guard
            const result = stmts.updateTaskClaim.run({
              $id: params.taskId,
              $assigned_agent_id: agent.id,
              $assigned_to: agent.name,
              $fingerprint: agent.avatarEmoji,
              $status: "in_progress",
              $in_progress_at: now,
              $updated_at: now,
            });

            if (result.changes === 0) {
              throw { status: 409, msg: "Task was claimed by another agent" };
            }

            stmts.logAction.run({
              $id: crypto.randomUUID(),
              $agent_id: agent.id,
              $action_type: "task.claimed",
              $entity_type: "task",
              $entity_id: params.taskId,
              $detail: JSON.stringify({ from_status: fromStatus }),
              $created_at: now,
            });
          })();
        } catch (err: any) {
          if (err.status) return errorResponse(err.status, err.msg, err.details ? { details: err.details } : undefined);
          return errorResponse(500, "Failed to claim task", { log: true });
        }

        const updated = stmts.listTasks.all(params.projectId).find((r: any) => r.id === params.taskId);
        const mappedTask = updated ? toTask(updated) : { id: params.taskId };

        broadcastToAll({ type: "task:moved", projectId: params.projectId, task: mappedTask });
        broadcastToAll({ type: "agent:task_claimed", agentId: agent.id, taskId: params.taskId, projectId: params.projectId });

        return json(mappedTask);
      }
    }

    // POST /api/agent/boards/:projectId/tasks/:taskId/complete
    {
      const params = matchRoute(pathname, "/api/agent/boards/:projectId/tasks/:taskId/complete");
      if (params && method === "POST") {
        const body = await readJSON(req).catch(() => ({}));
        const task = stmts.getTask.get(params.taskId) as any;
        if (!task) return errorResponse(404, "Task not found");
        if (task.project_id !== params.projectId) return errorResponse(404, "Task not found");

        // Verify ownership
        if (task.assigned_agent_id !== agent.id) {
          return errorResponse(403, "Not assigned to you");
        }

        // Check if approval is needed
        const settings = stmts.getSettings.get(params.projectId) as any;
        const needsApproval = settings?.require_approval_for_done;

        if (needsApproval) {
          const approvalId = crypto.randomUUID();
          const now = new Date().toISOString();

          try {
            db.transaction(() => {
              stmts.insertApproval.run({
                $id: approvalId,
                $task_id: params.taskId,
                $requested_by: agent.name,
                $approval_type: "completion",
                $from_status: task.status,
                $to_status: "done",
                $confidence_score: body?.confidence ?? null,
                $rubric_scores: body?.rubricScores ? JSON.stringify(body.rubricScores) : null,
                $justification: body?.justification ?? null,
                $created_at: now,
                $expires_at: settings.auto_expire_hours
                  ? new Date(Date.now() + settings.auto_expire_hours * 3600000).toISOString()
                  : null,
              });

              stmts.updateTaskStatus.run({
                $id: params.taskId,
                $status: "review",
                $completed_at: null,
                $updated_at: now,
              });

              stmts.logAction.run({
                $id: crypto.randomUUID(),
                $agent_id: agent.id,
                $action_type: "approval.requested",
                $entity_type: "approval",
                $entity_id: approvalId,
                $detail: JSON.stringify({ taskId: params.taskId, confidence: body?.confidence }),
                $created_at: now,
              });
            })();
          } catch (err: any) {
            return errorResponse(500, "Failed to submit for approval", { log: true });
          }

          const updatedTask = stmts.listTasks.all(params.projectId).find((r: any) => r.id === params.taskId);
          const mappedTask = updatedTask ? toTask(updatedTask) : { id: params.taskId };
          const approval = stmts.getApproval.get(approvalId) as any;

          broadcastToAll({ type: "task:moved", projectId: params.projectId, task: mappedTask });
          broadcastToAll({ type: "approval:created", projectId: params.projectId, approval: approval ? toApproval(approval) : { id: approvalId } });

          return json({ status: "pending_approval", approvalId });
        }

        // No approval needed — mark done directly
        const now = new Date().toISOString();
        stmts.updateTaskStatus.run({
          $id: params.taskId,
          $status: "done",
          $completed_at: now,
          $updated_at: now,
        });

        stmts.logAction.run({
          $id: crypto.randomUUID(),
          $agent_id: agent.id,
          $action_type: "task.completed",
          $entity_type: "task",
          $entity_id: params.taskId,
          $detail: JSON.stringify({ direct: true }),
          $created_at: now,
        });

        const updatedTask = stmts.listTasks.all(params.projectId).find((r: any) => r.id === params.taskId);
        const mappedTask = updatedTask ? toTask(updatedTask) : { id: params.taskId };

        broadcastToAll({ type: "task:moved", projectId: params.projectId, task: mappedTask });
        broadcastToAll({ type: "agent:task_completed", agentId: agent.id, taskId: params.taskId, projectId: params.projectId });

        return json({ status: "done" });
      }
    }

    // --- Comments ---

    // POST /api/agent/boards/:projectId/tasks/:taskId/comments
    {
      const params = matchRoute(pathname, "/api/agent/boards/:projectId/tasks/:taskId/comments");
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.content) return errorResponse(400, "content required");

        const task = stmts.getTaskInProject.get(params.taskId, params.projectId);
        if (!task) return errorResponse(404, "Task not found");

        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const mentions = Array.isArray(body.mentions) ? body.mentions : [];

        stmts.insertComment.run(id, params.taskId, agent.name, body.content, JSON.stringify(mentions), now);

        const comment = {
          id,
          taskId: params.taskId,
          author: agent.name,
          content: body.content,
          mentions,
          createdAt: now,
        };

        broadcastToAll({ type: "task:comment:added", projectId: params.projectId, taskId: params.taskId, comment });
        return json(comment, 201);
      }
    }

    // --- Board Memory ---

    // GET /api/agent/boards/:projectId/memory
    {
      const params = matchRoute(pathname, "/api/agent/boards/:projectId/memory");
      if (params && method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        const isChatFilter = url.searchParams.get("is_chat");

        let rows: any[];
        if (isChatFilter !== null) {
          rows = stmts.listMemoryFiltered.all(params.projectId, isChatFilter === "true" ? 1 : 0, limit) as any[];
        } else {
          rows = stmts.listMemory.all(params.projectId, limit) as any[];
        }

        return json({ memory: rows.map(toMemory) });
      }

      // POST /api/agent/boards/:projectId/memory
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.content) return errorResponse(400, "content required");

        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        stmts.insertMemory.run({
          $id: id,
          $project_id: params.projectId,
          $content: body.content,
          $tags: body.tags ? JSON.stringify(body.tags) : "[]",
          $is_chat: body.isChat ? 1 : 0,
          $source: body.source || `agent:${agent.name}`,
          $agent_id: agent.id,
          $created_at: now,
        });

        const row = stmts.getMemory.get(id) as any;
        const memory = row ? toMemory(row) : { id };

        broadcastToAll({ type: "board:memory_added", projectId: params.projectId, memory });
        return json(memory, 201);
      }
    }

    // --- Approvals ---

    // GET /api/agent/boards/:projectId/approvals
    {
      const params = matchRoute(pathname, "/api/agent/boards/:projectId/approvals");
      if (params && method === "GET") {
        const rows = stmts.listPendingApprovals.all(params.projectId) as any[];

        return json({
          approvals: rows.map(toApproval),
        });
      }

      // POST /api/agent/boards/:projectId/approvals
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.taskId) return errorResponse(400, "taskId required");

        // Verify task belongs to project
        const taskRow = stmts.getTask.get(body.taskId) as any;
        if (!taskRow || taskRow.project_id !== params.projectId) return errorResponse(404, "Task not found");

        // Check for existing pending approval (prevent duplicates)
        const existing = stmts.getApprovalForTask.get(body.taskId);
        if (existing) return errorResponse(409, "Task already has a pending approval");

        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const settings = stmts.getSettings.get(params.projectId) as any;
        const autoExpireHours = settings?.auto_expire_hours ?? 24;
        const expiresAt = new Date(Date.now() + autoExpireHours * 3600000).toISOString();

        stmts.insertApproval.run({
          $id: id,
          $task_id: body.taskId,
          $requested_by: agent.name,
          $approval_type: body.approvalType || "completion",
          $from_status: body.fromStatus || null,
          $to_status: body.toStatus || "done",
          $confidence_score: body.confidence ?? null,
          $rubric_scores: body.rubricScores ? JSON.stringify(body.rubricScores) : null,
          $justification: body.justification || null,
          $created_at: now,
          $expires_at: expiresAt,
        });

        stmts.logAction.run({
          $id: crypto.randomUUID(),
          $agent_id: agent.id,
          $action_type: "approval.requested",
          $entity_type: "approval",
          $entity_id: id,
          $detail: JSON.stringify({ taskId: body.taskId }),
          $created_at: now,
        });

        const approval = stmts.getApproval.get(id) as any;
        broadcastToAll({ type: "approval:created", projectId: params.projectId, approval: approval ? toApproval(approval) : { id } });
        return json(toApproval(approval), 201);
      }
    }

    // --- Coordination ---

    // POST /api/agent/boards/:projectId/agents/:agentId/nudge — Lead only
    {
      const params = matchRoute(pathname, "/api/agent/boards/:projectId/agents/:agentId/nudge");
      if (params && method === "POST") {
        if (!isLead) return errorResponse(403, "Only lead agents can nudge");

        const body = await readJSON(req);
        const targetAgent = stmts.getProfile.get(params.agentId) as any;
        if (!targetAgent) return errorResponse(404, "Target agent not found");

        const now = new Date().toISOString();

        stmts.logAction.run({
          $id: crypto.randomUUID(),
          $agent_id: agent.id,
          $action_type: "agent.nudge",
          $entity_type: "agent",
          $entity_id: params.agentId,
          $detail: JSON.stringify({ message: body?.message || "" }),
          $created_at: now,
        });

        // Try gateway dispatch if session ID exists
        if (targetAgent.gateway_session_id && ctx.GATEWAY_URL) {
          try {
            const res = await fetch(`${ctx.GATEWAY_URL}/sessions/${targetAgent.gateway_session_id}/message`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${ctx.GATEWAY_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                role: "user",
                content: `[NUDGE from lead] ${body?.message || "Wake up!"}`,
              }),
            });
            if (!res.ok) {
              return json({ ok: true, dispatched: false, reason: "gateway_error" });
            }
            return json({ ok: true, dispatched: true });
          } catch {
            return json({ ok: true, dispatched: false, reason: "gateway_unreachable" });
          }
        }

        // No gateway session — just log it
        return json({ ok: true, dispatched: false, reason: "no_gateway_session" });
      }
    }

    // POST /api/agent/boards/:projectId/escalate
    {
      const params = matchRoute(pathname, "/api/agent/boards/:projectId/escalate");
      if (params && method === "POST") {
        const body = await readJSON(req);
        const now = new Date().toISOString();

        stmts.logAction.run({
          $id: crypto.randomUUID(),
          $agent_id: agent.id,
          $action_type: "escalation.sent",
          $entity_type: "task",
          $entity_id: body?.taskId || null,
          $detail: JSON.stringify({ message: body?.message || "", taskId: body?.taskId }),
          $created_at: now,
        });

        broadcastToAll({
          type: "agent:escalation",
          agentId: agent.id,
          agentName: agent.name,
          taskId: body?.taskId || null,
          projectId: params.projectId,
          message: body?.message || "",
        });

        return json({ ok: true });
      }
    }

    // --- Actions Log ---

    // GET /api/agent/boards/:projectId/actions
    {
      const params = matchRoute(pathname, "/api/agent/boards/:projectId/actions");
      if (params && method === "GET") {
        const agentIdFilter = url.searchParams.get("agent_id");
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);

        let rows: any[];
        if (agentIdFilter) {
          rows = stmts.listActions.all(agentIdFilter, limit) as any[];
        } else {
          rows = stmts.listActionsAll.all(limit) as any[];
        }

        return json({ actions: rows.map(toAction) });
      }
    }

    return null;
  };
}
