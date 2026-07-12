/**
 * board.ts — client API + types for the Kanban board (human surface).
 *
 * Talks to the project-scoped `/api/boards/:projectId/...` endpoints
 * (server/routes/tasks.ts, actor="human"). Self-contained (its own fetch
 * wrapper + a pure `boardIdForPath`) so it carries no coupling to the rest of
 * lib/api.ts. The AGENT surface (`/api/sessions/...`) is driven by MCP, not
 * from here.
 */

export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';

export const TASK_STATUSES: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];
export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

export interface BoardTask {
  id: string;
  projectId: string;
  text: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  kanbanOrder: number;
  assignedTo: string | null;
  dueDate: string | null;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string;
  /** Topic (chat tab) the dispatched agent works this task in, if any. */
  assignedTopicId: string | null;
  /** null = not dispatched; queued | starting | working | needs_input. */
  dispatchState: string | null;
  /** Why the last dispatch attempt was released/parked (visible feedback). */
  dispatchError: string | null;
}

export interface TaskComment {
  id: string;
  taskId: string;
  author: string;
  content: string;
  mentions: string[];
  createdAt: string;
}

export interface TaskWithThread {
  task: BoardTask;
  comments: TaskComment[];
}

/**
 * Derive the board `projectId` from an absolute project path.
 *
 * BYTE-IDENTICAL to the server (server/services/tasks.ts:projectIdForPath ⇔
 * routes/topics.ts:getProjectIdForTopic). A parity test locks the exact output;
 * do NOT change the hash without updating all three copies.
 */
export function boardIdForPath(projectPath: string): string {
  const parts = projectPath.replace(/\/+$/, '').split('/');
  const dirName = parts[parts.length - 1] || 'project';
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash) + projectPath.charCodeAt(i);
    hash |= 0;
  }
  return dirName + '-' + Math.abs(hash).toString(36).slice(0, 6);
}

/**
 * Parse a task comment for an agent "question block" — the convention the
 * dispatcher's kickoff tells the agent to use when it needs a human decision:
 *
 *   ```question
 *   Which auth approach?
 *   - JWT in an httpOnly cookie
 *   - Short-lived bearer token
 *   ```
 *
 * Returns the question + the (possibly empty) option list, or null when the text
 * has no such block. Pure + exported so the "Serve te" card can render a
 * quick-reply and a bun:test can pin the format.
 */
export function parseQuestionBlock(text: string): { question: string; options: string[] } | null {
  if (!text) return null;
  const m = text.match(/```question\s*\n([\s\S]*?)```/);
  if (!m) return null;
  const options: string[] = [];
  const qLines: string[] = [];
  for (const raw of m[1].split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const opt = line.match(/^[-*]\s+(.*)$/);
    if (opt) options.push(opt[1].trim());
    else qLines.push(line);
  }
  const question = qLines.join(' ').trim();
  if (!question) return null;
  return { question, options };
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await resp.text().catch(() => '');
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  if (!resp.ok) throw new Error((parsed as { error?: string } | undefined)?.error || text || resp.statusText);
  return parsed as T;
}

export interface CreateTaskBody {
  text: string;
  description?: string | null;
  priority?: number;
  assignee?: string | null;
  status?: TaskStatus;
}

export interface UpdateTaskBody {
  status?: TaskStatus;
  priority?: number;
  assignee?: string | null;
  text?: string;
  description?: string | null;
  kanbanOrder?: number;
}

/** Per-board dispatch config (server: board_settings). */
export interface BoardSettings {
  projectId: string;
  autoDispatch: boolean;
  maxAgents: number;
  dispatchEffort: string;
  dispatchUseWorktree: boolean;
  dispatchTimeoutMin: number;
  requireApprovalForDone: boolean;
  requireReviewBeforeDone: boolean;
}

export interface BoardSettingsPatch {
  autoDispatch?: boolean;
  maxAgents?: number;
  dispatchEffort?: string;
  dispatchUseWorktree?: boolean;
  dispatchTimeoutMin?: number;
}

const enc = encodeURIComponent;

export const boardApi = {
  list: (projectId: string, status?: TaskStatus) =>
    req<{ tasks: BoardTask[] }>(`/boards/${enc(projectId)}/tasks${status ? `?status=${status}` : ''}`).then(r => r.tasks),
  /**
   * The global cross-project feed (GET /api/all-boards/tasks). Read-only list;
   * each task carries its own `projectId`, so per-task mutations route back
   * through the normal project-scoped endpoints via that id.
   */
  listAll: (status?: TaskStatus) =>
    req<{ tasks: BoardTask[] }>(`/all-boards/tasks${status ? `?status=${status}` : ''}`).then(r => r.tasks),
  create: (projectId: string, body: CreateTaskBody) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks`, { method: 'POST', body: JSON.stringify(body) }),
  get: (projectId: string, taskId: string) =>
    req<TaskWithThread>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}`),
  update: (projectId: string, taskId: string, patch: UpdateTaskBody) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  archive: (projectId: string, taskId: string) =>
    req<{ ok: boolean }>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}`, { method: 'DELETE' }),
  comment: (projectId: string, taskId: string, content: string, mentions?: string[]) =>
    req<TaskComment>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/comments`, { method: 'POST', body: JSON.stringify({ content, mentions }) }),
  review: (projectId: string, taskId: string, decision: 'approve' | 'reject', comment?: string) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/review`, { method: 'POST', body: JSON.stringify({ decision, comment }) }),
  getSettings: (projectId: string) =>
    req<BoardSettings>(`/boards/${enc(projectId)}/settings`),
  updateSettings: (projectId: string, patch: BoardSettingsPatch) =>
    req<BoardSettings>(`/boards/${enc(projectId)}/settings`, { method: 'PATCH', body: JSON.stringify(patch) }),
};
