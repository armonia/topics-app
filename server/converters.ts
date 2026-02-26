// server/converters.ts — Shared converters and helpers for board/agent-api/approvals routes

export function safeParseJSON<T>(input: string | null | undefined, fallback: T): T {
  if (!input) return fallback;
  try { return JSON.parse(input); } catch { return fallback; }
}

export function normalizeConfidence(score: number | null): number | null {
  if (score == null) return null;
  return score <= 1 ? Math.round(score * 100) : Math.round(score);
}

export function rowToTask(row: any, getTaskTags: { all: (id: string) => any[] }): any {
  return {
    id: row.id,
    projectId: row.project_id,
    text: row.text,
    description: row.description || null,
    status: row.status,
    priority: row.priority,
    kanbanOrder: row.kanban_order,
    assignedTo: row.assigned_to || null,
    assignedAgentId: row.assigned_agent_id || null,
    fingerprint: row.fingerprint || null,
    dueDate: row.due_date || null,
    chatId: row.chat_id || null,
    inProgressAt: row.in_progress_at || null,
    createdAt: row.created_at,
    completedAt: row.completed_at || null,
    updatedAt: row.updated_at,
    archived: !!row.archived,
    blocks: row.blocks ? row.blocks.split(",") : [],
    blockedBy: row.blocked_by ? row.blocked_by.split(",") : [],
    tags: (getTaskTags.all(row.id) as any[]).map(t => ({ id: t.id, name: t.name, color: t.color })),
  };
}

export function rowToApproval(row: any): any {
  return {
    id: row.id,
    taskId: row.task_id,
    taskText: row.task_text || null,
    taskStatus: row.task_status || null,
    requestedBy: row.requested_by,
    approvalType: row.approval_type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    confidenceScore: normalizeConfidence(row.confidence_score),
    rubricScores: safeParseJSON(row.rubric_scores, null),
    justification: row.justification,
    status: row.status,
    reviewedBy: row.reviewed_by,
    reviewComment: row.review_comment,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    expiresAt: row.expires_at,
  };
}

export function rowToMemory(row: any): any {
  return {
    id: row.id,
    projectId: row.project_id,
    content: row.content,
    tags: safeParseJSON(row.tags, []),
    isChat: !!row.is_chat,
    source: row.source || null,
    agentId: row.agent_id || null,
    createdAt: row.created_at,
  };
}

export function rowToAction(row: any): any {
  return {
    id: row.id,
    agentId: row.agent_id,
    actionType: row.action_type,
    entityType: row.entity_type || null,
    entityId: row.entity_id || null,
    detail: safeParseJSON(row.detail, null),
    createdAt: row.created_at,
  };
}

export function checkBlockers(
  taskId: string,
  targetStatus: string,
  stmts: { getBlockers: { all: (id: string) => any[] }; getTaskById: { get: (id: string) => any } }
): { blocked: boolean; blockers: string[] } {
  if (targetStatus === 'backlog' || targetStatus === 'todo') return { blocked: false, blockers: [] };
  const blockerRows = stmts.getBlockers.all(taskId) as any[];
  const activeBlockers: string[] = [];
  for (const row of blockerRows) {
    const blocker = stmts.getTaskById.get(row.blocker_id) as any;
    if (blocker && blocker.status !== 'done') {
      activeBlockers.push(blocker.id);
    }
  }
  return { blocked: activeBlockers.length > 0, blockers: activeBlockers };
}
