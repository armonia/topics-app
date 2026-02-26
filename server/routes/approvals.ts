import type { AppContext, RouteHandler } from "../types";
import { rowToApproval } from "../converters";

export function createApprovalsRouter(ctx: AppContext): RouteHandler {
  const { db, json, readJSON, matchRoute, errorResponse, broadcastToAll } = ctx;

  const stmts = {
    listPending: db.prepare(`
      SELECT a.*, t.text as task_text, t.status as task_status
      FROM approvals a
      JOIN tasks t ON t.id = a.task_id
      WHERE t.project_id = ? AND a.status = 'pending'
      ORDER BY a.created_at DESC
    `),
    listAll: db.prepare(`
      SELECT a.*, t.text as task_text, t.status as task_status
      FROM approvals a
      JOIN tasks t ON t.id = a.task_id
      WHERE t.project_id = ?
      ORDER BY a.created_at DESC
      LIMIT ?
    `),
    getApproval: db.prepare(`SELECT * FROM approvals WHERE id = ?`),
    getApprovalForTask: db.prepare(`
      SELECT * FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1
    `),
    insertApproval: db.prepare(`
      INSERT INTO approvals (id, task_id, requested_by, approval_type, from_status, to_status, confidence_score, rubric_scores, justification, status, created_at, expires_at)
      VALUES ($id, $task_id, $requested_by, $approval_type, $from_status, $to_status, $confidence_score, $rubric_scores, $justification, 'pending', $created_at, $expires_at)
    `),
    approveApproval: db.prepare(`
      UPDATE approvals SET status = 'approved', reviewed_by = ?, review_comment = ?, reviewed_at = ? WHERE id = ?
    `),
    rejectApproval: db.prepare(`
      UPDATE approvals SET status = 'rejected', reviewed_by = ?, review_comment = ?, reviewed_at = ? WHERE id = ?
    `),
    expireOld: db.prepare(`
      UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?
    `),
    pendingCount: db.prepare(`
      SELECT COUNT(*) as count FROM approvals a
      JOIN tasks t ON t.id = a.task_id
      WHERE t.project_id = ? AND a.status = 'pending'
    `),
    getSettings: db.prepare(`SELECT * FROM board_settings WHERE project_id = ?`),
  };

  // Expire old approvals on each request
  function expireStale() {
    stmts.expireOld.run(new Date().toISOString());
  }

  return async function approvalsRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // GET /api/boards/:projectId/approvals
    {
      const params = matchRoute(pathname, "/api/boards/:projectId/approvals");
      if (params && method === "GET") {
        expireStale();
        const pendingOnly = url.searchParams.get("status") === "pending";
        const rows = pendingOnly
          ? stmts.listPending.all(params.projectId)
          : stmts.listAll.all(params.projectId, 100);
        return json({ approvals: (rows as any[]).map(rowToApproval) });
      }

      // POST /api/boards/:projectId/approvals - create approval request
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.taskId) return errorResponse(400, "taskId required");
        if (!body?.approvalType) return errorResponse(400, "approvalType required");

        // Check if there's already a pending approval for this task
        const existing = stmts.getApprovalForTask.get(body.taskId);
        if (existing) return errorResponse(409, "Task already has a pending approval");

        const settings = stmts.getSettings.get(params.projectId) as any;
        const autoExpireHours = settings?.auto_expire_hours ?? 24;

        const now = new Date();
        const expiresAt = new Date(now.getTime() + autoExpireHours * 60 * 60 * 1000).toISOString();

        const id = crypto.randomUUID();
        stmts.insertApproval.run({
          $id: id,
          $task_id: body.taskId,
          $requested_by: body.requestedBy || 'agent',
          $approval_type: body.approvalType,
          $from_status: body.fromStatus || null,
          $to_status: body.toStatus || null,
          $confidence_score: body.confidenceScore ?? null,
          $rubric_scores: body.rubricScores ? JSON.stringify(body.rubricScores) : null,
          $justification: body.justification || null,
          $created_at: now.toISOString(),
          $expires_at: expiresAt,
        });

        const approval = rowToApproval({ ...stmts.getApproval.get(id), task_text: null, task_status: null });
        broadcastToAll({ type: "approval:created", projectId: params.projectId, approval });
        return json(approval, 201);
      }
    }

    // POST /api/approvals/:id/approve
    {
      const params = matchRoute(pathname, "/api/approvals/:id/approve");
      if (params && method === "POST") {
        const body = await readJSON(req);
        const row = stmts.getApproval.get(params.id) as any;
        if (!row) return errorResponse(404, "Approval not found");
        if (row.status !== 'pending') return errorResponse(409, "Approval is not pending");

        const now = new Date().toISOString();
        stmts.approveApproval.run(body?.reviewedBy || 'user', body?.comment || null, now, params.id);

        // If this was a status_change or completion approval, apply the status change to the task
        if ((row.approval_type === 'status_change' || row.approval_type === 'completion') && row.to_status) {
          const completedAt = row.to_status === 'done' ? now : null;
          db.prepare("UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?")
            .run(row.to_status, completedAt, now, row.task_id);

          // Get project ID for broadcast
          const task = db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(row.task_id) as any;
          if (task) {
            broadcastToAll({ type: "task:updated", projectId: task.project_id, task: { id: row.task_id, status: row.to_status } });
          }

          // Check if completing this task unblocks dependents
          if (row.to_status === 'done' && task) {
            const dependents = db.prepare(
              `SELECT td.blocked_id FROM task_dependencies td
               JOIN tasks t ON t.id = td.blocked_id
               WHERE td.blocker_id = ? AND t.status != 'done'`
            ).all(row.task_id) as any[];

            for (const dep of dependents) {
              const remaining = db.prepare(
                `SELECT COUNT(*) as cnt FROM task_dependencies td
                 JOIN tasks t ON t.id = td.blocker_id
                 WHERE td.blocked_id = ? AND t.status != 'done'`
              ).get(dep.blocked_id) as any;
              if (remaining.cnt === 0) {
                broadcastToAll({ type: "task:unblocked", projectId: task.project_id, taskId: dep.blocked_id });
              }
            }
          }
        }

        broadcastToAll({ type: "approval:approved", approvalId: params.id });
        return json({ ok: true, status: 'approved' });
      }
    }

    // POST /api/approvals/:id/reject
    {
      const params = matchRoute(pathname, "/api/approvals/:id/reject");
      if (params && method === "POST") {
        const body = await readJSON(req);
        const row = stmts.getApproval.get(params.id) as any;
        if (!row) return errorResponse(404, "Approval not found");
        if (row.status !== 'pending') return errorResponse(409, "Approval is not pending");

        const now = new Date().toISOString();
        stmts.rejectApproval.run(body?.reviewedBy || 'user', body?.comment || null, now, params.id);

        broadcastToAll({ type: "approval:rejected", approvalId: params.id });
        return json({ ok: true, status: 'rejected' });
      }
    }

    return null;
  };
}

/**
 * Middleware: Check if a task status transition requires approval.
 * Returns null if no approval needed, or creates an approval and returns 202.
 */
export function checkApprovalGate(db: any, projectId: string, taskId: string, fromStatus: string, toStatus: string): { required: boolean; approvalId?: string } {
  const settings = db.prepare("SELECT * FROM board_settings WHERE project_id = ?").get(projectId) as any;
  if (!settings) return { required: false };

  // Check if approval is needed for moving to "done"
  if (toStatus === 'done' && settings.require_approval_for_done) {
    // Check if there's already an approved approval for this transition
    const approved = db.prepare(
      "SELECT id FROM approvals WHERE task_id = ? AND to_status = 'done' AND status = 'approved' ORDER BY reviewed_at DESC LIMIT 1"
    ).get(taskId);

    if (approved) return { required: false }; // Already approved

    // Check if there's a pending approval
    const pending = db.prepare(
      "SELECT id FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
    ).get(taskId) as any;

    if (pending) return { required: true, approvalId: pending.id };

    // Create a new approval request
    const id = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (settings.auto_expire_hours || 24) * 60 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO approvals (id, task_id, requested_by, approval_type, from_status, to_status, status, created_at, expires_at)
      VALUES (?, ?, 'system', 'status_change', ?, ?, 'pending', ?, ?)
    `).run(id, taskId, fromStatus, toStatus, now.toISOString(), expiresAt);

    return { required: true, approvalId: id };
  }

  // Check if status change is blocked by pending approvals
  if (settings.block_status_with_pending) {
    const pending = db.prepare(
      "SELECT id FROM approvals WHERE task_id = ? AND status = 'pending'"
    ).get(taskId);
    if (pending) return { required: true, approvalId: (pending as any).id };
  }

  return { required: false };
}
