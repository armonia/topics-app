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

/**
 * Reserved board id for tasks created WITHOUT a project (work spanning several
 * projects, or not decided yet). They live on the global board; the dispatcher
 * ignores them until a human assigns a real project via "Sposta su…".
 */
export const UNASSIGNED_PROJECT_ID = '_none';

/**
 * Virtual board id for "project: Auto" — the server resolves the real board
 * from a known project name mentioned in the task text (unique hit), falling
 * back to UNASSIGNED_PROJECT_ID when none/ambiguous.
 */
export const AUTO_PROJECT_ID = '_auto';
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
  /** Nobody chose a priority: the dispatched agent evaluates and sets one. */
  priorityAuto: boolean;
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
  /** Parent task when this is a nested subtask (unlimited depth). */
  parentTaskId: string | null;
  /** Reviewable output (http/https URL) shown in the task's review panel. */
  outputUrl: string | null;
  /** Dispatch contract: agent delivers a PLAN to review before implementing. */
  planFirst: boolean;
  /** When the current claim started — anchors the live "ci sta mettendo" ticker. */
  inProgressAt: string | null;
  /** Cumulative agent effort across every turn (dispatcher-recorded). */
  agentMs: number;
  agentTokens: number;
  /** Direct-children counters (board badges: "↳ done/total"). */
  subtaskCount: number;
  subtaskDoneCount: number;
  /** Model the dispatched agent runs on; null = provider default ("Auto"). */
  model: string | null;
  /** Root task this one is gated on — the dispatcher won't start it until that task is done. */
  blockedByTaskId: string | null;
  /** When blocked, hand the new agent the blocker's session context instead of a cold start. */
  reuseBlockerContext: boolean;
}

export interface TaskComment {
  id: string;
  taskId: string;
  author: string;
  content: string;
  mentions: string[];
  /** Attached files (absolute paths), rendered via /api/media. */
  media: string[];
  createdAt: string;
  /** 'status' = a transition event ("todo→review", author = who moved it) —
   *  rendered as a timeline row, never as a speech bubble. */
  kind: 'comment' | 'status';
}

export interface TaskWithThread {
  task: BoardTask;
  comments: TaskComment[];
  /** Direct subtasks (drawer list). */
  children: BoardTask[];
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
 * Parse a task comment for an agent "question block" — the human-decision
 * request the board renders as a quick-reply:
 *
 *   ```question
 *   Which auth approach?
 *   - JWT in an httpOnly cookie
 *   - Short-lived bearer token
 *   ```
 *
 * The canonical block is composed SERVER-side (tasks service `questionOptions`)
 * so this layout is guaranteed for new comments — but the parser stays
 * tolerant of hand-written LLM variants: `\r\n`, missing newlines around the
 * fences, options inlined on one line. Returns the question + the (possibly
 * empty) option list, or null when the text has no such block. Pure + exported
 * so the "Serve te" card and the detail drawer share it and a bun:test can pin
 * both the canonical and the degenerate forms.
 */
export function parseQuestionBlock(text: string): { question: string; options: string[] } | null {
  if (!text) return null;
  // \s+ (not \s*\n): tolerate a block whose newlines were lost/normalized —
  // '```question Question? - a - b```' still parses.
  const m = text.replace(/\r\n/g, '\n').match(/```question\s+([\s\S]*?)```/);
  if (!m) return null;
  const body = m[1].trim();
  if (!body) return null;
  const options: string[] = [];
  const qLines: string[] = [];
  if (body.includes('\n')) {
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const opt = line.match(/^[-*]\s+(.*)$/);
      if (opt) options.push(opt[1].trim());
      else qLines.push(line);
    }
  } else {
    // Degenerate single-line body: split on ' - ' option markers. The first
    // segment is the question; a leading '- ' marks an option-only block.
    const segments = body.split(/\s+-\s+/);
    const first = segments.shift()?.trim() ?? '';
    if (first.startsWith('- ')) segments.unshift(first.slice(2));
    else if (first) qLines.push(first);
    for (const s of segments) { const v = s.trim(); if (v) options.push(v); }
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
  /** Nest under this task (subtask, unlimited depth). */
  parentTaskId?: string | null;
  /** Dispatch contract: the agent plans first, implements after human approval. */
  planFirst?: boolean;
  /** Model the dispatched agent runs on; omitted/null = provider default ("Auto"). */
  model?: string | null;
  /** Gate: don't dispatch until this root task is done. */
  blockedByTaskId?: string | null;
  /** When blocked, hand the new agent the blocker's session context. */
  reuseBlockerContext?: boolean;
}

export interface UpdateTaskBody {
  status?: TaskStatus;
  priority?: number;
  assignee?: string | null;
  text?: string;
  description?: string | null;
  kanbanOrder?: number;
  /** http(s) URL of the reviewable output; empty string clears it. */
  outputUrl?: string;
  /** Model the dispatched agent runs on; null clears back to "Auto". */
  model?: string | null;
  /** Gate: don't dispatch until this root task is done; null clears it. */
  blockedByTaskId?: string | null;
  /** When blocked, hand the new agent the blocker's session context. */
  reuseBlockerContext?: boolean;
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

/** One entry of the board index (task-detail project selector). */
export interface BoardProjectRef {
  projectId: string;
  name: string;
  path: string;
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
  comment: (projectId: string, taskId: string, content: string, opts?: { mentions?: string[]; media?: string[] }) =>
    req<TaskComment>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/comments`, { method: 'POST', body: JSON.stringify({ content, mentions: opts?.mentions, media: opts?.media }) }),
  review: (projectId: string, taskId: string, decision: 'approve' | 'reject', comment?: string) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/review`, { method: 'POST', body: JSON.stringify({ decision, comment }) }),
  /** Move a root task (and its subtree) to another board. */
  move: (projectId: string, taskId: string, toProjectId: string) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/move`, { method: 'POST', body: JSON.stringify({ toProjectId }) }),
  /** Stop a running dispatch: parks the task and aborts the agent's turn. */
  stop: (projectId: string, taskId: string) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/stop`, { method: 'POST', body: JSON.stringify({}) }),
  /** Every board the server can resolve (the project selector's options). */
  projects: () =>
    req<{ projects: BoardProjectRef[] }>('/all-boards/projects').then(r => r.projects),
  /** Scaffold a NEW workspace project (dir + CLAUDE.md); 409 on name collision. */
  createProject: (name: string) =>
    req<BoardProjectRef>('/all-boards/projects', { method: 'POST', body: JSON.stringify({ name }) }),
  getSettings: (projectId: string) =>
    req<BoardSettings>(`/boards/${enc(projectId)}/settings`),
  updateSettings: (projectId: string, patch: BoardSettingsPatch) =>
    req<BoardSettings>(`/boards/${enc(projectId)}/settings`, { method: 'PATCH', body: JSON.stringify(patch) }),
  /** The GLOBAL auto-dispatch switch (one for every board, incl. the global one). */
  getGlobalDispatch: () =>
    req<{ autoDispatch: boolean }>('/all-boards/settings').then(r => r.autoDispatch),
  setGlobalDispatch: (autoDispatch: boolean) =>
    req<{ autoDispatch: boolean }>('/all-boards/settings', { method: 'PATCH', body: JSON.stringify({ autoDispatch }) }).then(r => r.autoDispatch),
};
