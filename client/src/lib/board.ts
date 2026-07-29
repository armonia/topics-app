/**
 * board.ts — client API + types for the Kanban board (human surface).
 *
 * Talks to the project-scoped `/api/boards/:projectId/...` endpoints
 * (server/routes/tasks.ts, actor="human"). Self-contained (its own fetch
 * wrapper + a pure `boardIdForPath`) so it carries no coupling to the rest of
 * lib/api.ts. The AGENT surface (`/api/sessions/...`) is driven by MCP, not
 * from here.
 */

// Il contratto della board sta in `shared/board.ts`, dichiarato UNA volta e
// letto dai due lati del filo: `export … from` ri-esporta ma non porta i nomi
// in scope locale, e qui sotto servono, quindi l'import gemello non è ridondante.
export { MAX_FANOUT, TASK_STATUSES } from '../../../shared/board';
export type {
  TaskStatus, TaskComment, ReviewCheck, CheckRun, BoardSettings, BoardSettingsPatch, DispatchCapacity,
} from '../../../shared/board';
import type {
  TaskStatus, TaskComment, CheckRun, BoardSettings, BoardSettingsPatch, DispatchCapacity,
} from '../../../shared/board';
// Il tentativo di un fan-out: stesso contratto del server, stessa cartella condivisa.
export { attemptHasWork, formatAttemptStat } from '../../../shared/task-attempt';
export type { TaskAttempt, AttemptState } from '../../../shared/task-attempt';
import type { TaskAttempt } from '../../../shared/task-attempt';

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

/**
 * A project-less "Auto" task is routed server-side to a scaffolded catch-all
 * board (workspace/generale → id "generale-<hash>") so it can actually DISPATCH
 * — the dispatcher only ticks real boards. But on the UI that "generale" name is
 * noise (the user wants no such label), so the board treats a catch-all task
 * exactly like UNASSIGNED_PROJECT_ID: no project chip. Mirrors the server's
 * join(workspaceDir, "generale"); a real top-level project literally named
 * "generale" is reserved for the catch-all by convention.
 */
export const isCatchAllProjectId = (projectId: string): boolean =>
  /^generale-[a-z0-9]+$/.test(projectId);

/** No user-facing project: unassigned OR the catch-all — both render with no chip. */
export const isProjectlessId = (projectId: string): boolean =>
  projectId === UNASSIGNED_PROJECT_ID || isCatchAllProjectId(projectId);

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

/**
 * Perché il sistema ha portato in review un task che l'agente non ha consegnato.
 * Cause diverse = decisioni diverse per il reviewer — perciò testi diversi e non
 * un generico "chiuso dal sistema".
 */
export const SYSTEM_DELIVERY_REASON: Record<'retries_exhausted' | 'model_refused' | 'fanout', string> = {
  retries_exhausted:
    "L'agent ha finito i tentativi senza mettere in review da solo: sotto può non esserci un deliverable. Rimandandolo indietro riparte sulla stessa sessione.",
  model_refused:
    "Il modello si è rifiutato di proseguire: nessun ritentativo automatico può sbloccarlo. Serve una decisione tua — rimandarlo indietro identico otterrebbe lo stesso rifiuto.",
  fanout:
    "Fan-out: più agenti hanno lavorato lo stesso task in parallelo, ognuno nel suo worktree. Scegli quale tentativo tenere dal pannello Tentativi — gli altri vengono buttati.",
};

/** Il testo giusto per una consegna di sistema, causa nota o meno. */
export function systemDeliveryNote(reason: BoardTask['deliveredReason']): string {
  return reason
    ? SYSTEM_DELIVERY_REASON[reason]
    : "Non l'ha consegnato l'agent: ce l'ha portato il sistema a fine turno. Sotto può non esserci un deliverable — guarda il thread prima di aprire il diff.";
}

/** Etichetta corta per la chip sulla card (la prosa lunga è nel title). */
export const SYSTEM_DELIVERY_CHIP: Record<'retries_exhausted' | 'model_refused' | 'fanout', string> = {
  retries_exhausted: 'non consegnato',
  model_refused: 'agent bloccato',
  fanout: 'scegli il tentativo',
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
  /** Screenshot della consegna (path assoluto allowlistato) — thumbnail
   *  sulla card, servito via /api/media. */
  previewImage: string | null;
  /** Dispatch contract: agent delivers a PLAN to review before implementing. */
  planFirst: boolean;
  /** When the current claim started — anchors the live "ci sta mettendo" ticker. */
  inProgressAt: string | null;
  /** Cumulative agent effort across every turn (dispatcher-recorded).
   *  agentTokens = input+output+cacheWrite (dedup by API message id); cache
   *  READS ride separately — the context re-read pressure, not "work" tokens. */
  agentMs: number;
  agentTokens: number;
  agentCacheReadTokens: number;
  /** Direct-children counters (board badges: "↳ done/total"). */
  subtaskCount: number;
  subtaskDoneCount: number;
  /** Human interactions in the thread: 'user' comments (kind='comment') — the
   *  AI/agent, system notes and status events are excluded. Shown on the card. */
  userCommentCount: number;
  /** Model the dispatched agent runs on; null = provider default ("Auto"). */
  model: string | null;
  /** Root task this one is gated on — the dispatcher won't start it until that task is done. */
  blockedByTaskId: string | null;
  /** When blocked, hand the new agent the blocker's session context instead of a cold start. */
  reuseBlockerContext: boolean;
  /** Branch the task delivered on, snapshot at review-time (diagnostics). */
  deliveryBranch: string | null;
  /** Tip of that branch at review-time — the durable handle the audit checks. */
  deliveryCommit: string | null;
  /** Landing audit verdict: is the delivered work actually on main?
   *  null = never audited (no delivery recorded). 'unlanded' is the alarm. */
  landingState: "landed" | "unlanded" | "unverifiable" | null;
  landingCheckedAt: string | null;
  /** Esito dei checks pre-review. null = mai girati — NON un verde. */
  checksState: "running" | "pass" | "fail" | null;
  checksAt: string | null;
  /** Commit su cui sono girati: se il branch è avanzato, il verde è scaduto. */
  checksCommit: string | null;
  checks: CheckRun[] | null;
  /** Chi l'ha portato in review. 'system' = non è una consegna: è un turno finito
   *  male che qualcuno deve guardare, e sotto può non esserci un deliverable. */
  deliveredBy: 'agent' | 'human' | 'system' | null;
  /** Perché, quando `deliveredBy === 'system'`. La prosa sta nel thread. */
  deliveredReason: 'retries_exhausted' | 'model_refused' | 'fanout' | null;
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
  // "Landa e pubblica" (go online = merge + push + deploy) is NEVER a per-task
  // quick-reply: publishing is a SEPARATE, human-only board action (the "Pubblica"
  // control) with a diff preview to review before pushing. The dispatcher used to
  // make agents offer it at delivery; drop it from the rendered options so old
  // deliveries that still carry it don't show a one-click merge+push button.
  // "Landa su main" (local merge, no push) stays.
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const filtered = options.filter((o) => norm(o) !== 'landa e pubblica');
  return { question, options: filtered };
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
  /** Screenshot della consegna per la card (path assoluto allowlistato);
   *  empty string clears it. */
  previewImage?: string;
  /** Model the dispatched agent runs on; null clears back to "Auto". */
  model?: string | null;
  /** Gate: don't dispatch until this root task is done; null clears it. */
  blockedByTaskId?: string | null;
  /** When blocked, hand the new agent the blocker's session context. */
  reuseBlockerContext?: boolean;
  /** Agent delivers a plan to approve before implementing. */
  planFirst?: boolean;
}

/** Machine-wide dispatch settings (server: reserved board_settings row '*'). */
export interface GlobalSettings {
  /** Auto-dispatch master switch — a Todo task starts an agent on any board. */
  autoDispatch: boolean;
  /** The ONE machine-wide concurrency cap is auto-sized from live capacity. */
  maxAgentsAuto: boolean;
  /** The fixed machine-wide cap used when `maxAgentsAuto` is off. */
  maxAgents: number;
}

/** One commit that a publish (push) would ship. */
export interface PublishCommit {
  hash: string;
  subject: string;
  author: string;
  when: string;
}

/** Per-file summary line of a unified diff. status: A/M/D/R (git name-status). */
export interface DiffFileStat {
  path: string;
  additions: number; // -1 = binary
  deletions: number; // -1 = binary
  status: string;
}

/** A unified-diff bundle: per-file stat + the raw patch, capped server-side. */
export interface DiffBundle {
  branch: string | null;
  range?: string;
  base?: string;
  stat: DiffFileStat[];
  patch: string;
  truncated: boolean;
  /** 'no_worktree' when a task has no isolated worktree to diff yet. */
  code?: string;
}

/**
 * Nota di revisione ancorata a una riga del diff, in sospeso finché non parte
 * come commento all'agente. Vive qui e non accanto al componente perché è una
 * forma DI DATI della board: la bozza la persiste in ui-state (`boardDrafts`),
 * e `lib/` non può dipendere da `components/`.
 */
export interface DiffNote {
  id: string;
  /** Path `b/` del file, come lo mostra la card del diff. */
  path: string;
  /** Riga a cui è appesa la nota, nel lato indicato da `side`. */
  line: number;
  /** `new` = riga del file dopo la modifica; `old` = riga rimossa. */
  side: 'new' | 'old';
  /** La riga stessa, ricitata all'agente: senza, "riga 42" è ambiguo dopo un edit. */
  code: string;
  /** Testo scritto dall'umano. */
  body: string;
}

/** A project's unpushed state for the Publish control. */
export interface PublishProject {
  projectId: string;
  name: string;
  branch: string;
  ahead: number;
  commits: PublishCommit[];
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
  /** `force` scavalca il gate sui checks rossi: è una scelta esplicita dell'umano,
   *  mai il default (il server risponde 409 `checks_failed` senza). */
  review: (projectId: string, taskId: string, decision: 'approve' | 'reject', comment?: string, opts?: { force?: boolean }) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/review`, { method: 'POST', body: JSON.stringify({ decision, comment, force: opts?.force }) }),
  /** Land the task's branch on main (accept if still in review, then merge locally
   *  + rebuild). Explicit, decoupled from approve — never pushes online. */
  land: (projectId: string, taskId: string) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/land`, { method: 'POST', body: JSON.stringify({}) }),
  /** Move a root task (and its subtree) to another board. */
  move: (projectId: string, taskId: string, toProjectId: string) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/move`, { method: 'POST', body: JSON.stringify({ toProjectId }) }),
  /** Stop a running dispatch: parks the task and aborts the agent's turn. */
  stop: (projectId: string, taskId: string) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/stop`, { method: 'POST', body: JSON.stringify({}) }),
  /** Every board the server can resolve (the project selector's options). */
  projects: () =>
    req<{ projects: BoardProjectRef[] }>('/all-boards/projects').then(r => r.projects),
  /** Per-project commits on the current branch not yet pushed — feeds the Publish control.
   *  `commits` is the exact list a push would ship (newest first, capped at 50). */
  publishStatus: () =>
    req<{ projects: PublishProject[] }>('/all-boards/publish-status').then(r => r.projects),
  /** Push a project's current branch to its remote (triggers deploy CI where configured). */
  publish: (projectId: string) =>
    req<{ ok: boolean; branch: string; output?: string; error?: string }>(`/boards/${enc(projectId)}/publish`, { method: 'POST', body: JSON.stringify({}) }),
  /** Unified diff of the commits a publish would push (what ships). */
  publishDiff: (projectId: string) =>
    req<DiffBundle>(`/boards/${enc(projectId)}/publish-diff`),
  /** Unified diff of what a dispatched task changed in its isolated worktree.
   *  `attemptId` sposta la lettura su UN tentativo del fan-out invece che sul
   *  task: è così che si confrontano N alternative prima di sceglierne una. */
  taskDiff: (projectId: string, taskId: string, attemptId?: string) =>
    req<DiffBundle>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/diff${attemptId ? `?attempt=${enc(attemptId)}` : ''}`),
  /** I tentativi paralleli di un fan-out. Lista vuota = task dispatchato normalmente. */
  attempts: (projectId: string, taskId: string) =>
    req<{ attempts: TaskAttempt[] }>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/attempts`).then(r => r.attempts),
  /** Sceglie il vincitore: il task punta al suo worktree, gli altri vengono buttati. */
  selectAttempt: (projectId: string, taskId: string, attemptId: string) =>
    req<{ task: BoardTask; attempts: TaskAttempt[] }>(
      `/boards/${enc(projectId)}/tasks/${enc(taskId)}/attempts/${enc(attemptId)}/select`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  /** Scaffold a NEW workspace project (dir + CLAUDE.md); 409 on name collision. */
  createProject: (name: string) =>
    req<BoardProjectRef>('/all-boards/projects', { method: 'POST', body: JSON.stringify({ name }) }),
  getSettings: (projectId: string) =>
    req<BoardSettings>(`/boards/${enc(projectId)}/settings`),
  updateSettings: (projectId: string, patch: BoardSettingsPatch) =>
    req<BoardSettings>(`/boards/${enc(projectId)}/settings`, { method: 'PATCH', body: JSON.stringify(patch) }),
  /** Recommended auto concurrency cap for this machine right now (CPU/load). */
  dispatchCapacity: () =>
    req<DispatchCapacity>('/system/dispatch-capacity'),
  /** The GLOBAL auto-dispatch switch (one for every board, incl. the global one). */
  getGlobalDispatch: () =>
    req<{ autoDispatch: boolean }>('/all-boards/settings').then(r => r.autoDispatch),
  setGlobalDispatch: (autoDispatch: boolean) =>
    req<{ autoDispatch: boolean }>('/all-boards/settings', { method: 'PATCH', body: JSON.stringify({ autoDispatch }) }).then(r => r.autoDispatch),
  /** GLOBAL settings: auto-dispatch switch + the ONE machine-wide cap (auto/number). */
  getGlobalSettings: () =>
    req<GlobalSettings>('/all-boards/settings'),
  /** Update the machine-wide cap: `auto` toggle and/or a fixed `max` number. */
  setGlobalCap: (patch: { auto?: boolean; max?: number }) =>
    req<GlobalSettings>('/all-boards/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        ...(patch.auto !== undefined ? { maxAgentsAuto: patch.auto } : {}),
        ...(patch.max !== undefined ? { maxAgents: patch.max } : {}),
      }),
    }),
};

// ── Server-persisted drafts ──────────────────────────────────────────────────
// A half-written task or reply is work too: drafts live in the generic
// ui-state store (LWW), so they survive reloads/app restarts and follow the
// user across clients. Writes are debounced per key; failures are silent
// (the in-memory text is never blocked on the network).

export interface ComposerDraft {
  text: string;
  model: string | null;
  prio: number | null;
  planFirst: boolean;
}

async function uiGet<T>(key: string): Promise<T | null> {
  try {
    const r = await fetch(`/api/ui-state/${key}`); // PANE-01-ALLOWED: draft keys, not pane state
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    return (d?.value ?? null) as T | null;
  } catch { return null; }
}

const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
function uiPutDebounced(key: string, value: unknown, ms = 800): void {
  const t = draftTimers.get(key);
  if (t) clearTimeout(t);
  draftTimers.set(key, setTimeout(() => {
    draftTimers.delete(key);
    // PANE-01-ALLOWED: draft keys, not pane state
    fetch(`/api/ui-state/${key}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    }).catch(() => {});
  }, ms));
}

const TASK_DRAFTS_KEY = 'board-task-drafts';
const TASK_DRAFTS_CAP = 50;
let taskDraftsCache: Record<string, string> | null = null;

const REVIEW_NOTES_KEY = 'board-review-notes';
/** Più basso del cap delle bozze: una review in sospeso è per definizione una alla volta. */
const REVIEW_NOTES_CAP = 10;
let reviewNotesCache: Record<string, DiffNote[]> | null = null;

export const boardDrafts = {
  getComposer: () => uiGet<ComposerDraft>('board-composer-draft'),
  putComposer: (d: ComposerDraft) => uiPutDebounced('board-composer-draft', d),
  /** Immediate clear (submit) — no debounce window to resurrect the sent text. */
  clearComposer: () => uiPutDebounced('board-composer-draft', { text: '', model: null, prio: null, planFirst: false }, 0),

  async getTaskDraft(taskId: string): Promise<string> {
    if (!taskDraftsCache) taskDraftsCache = (await uiGet<Record<string, string>>(TASK_DRAFTS_KEY)) ?? {};
    return taskDraftsCache[taskId] ?? '';
  },
  putTaskDraft(taskId: string, text: string): void {
    if (!taskDraftsCache) taskDraftsCache = {};
    if (text) taskDraftsCache[taskId] = text;
    else delete taskDraftsCache[taskId];
    // Bounded map: drop the oldest entries past the cap (insertion order).
    const keys = Object.keys(taskDraftsCache);
    for (let i = 0; i < keys.length - TASK_DRAFTS_CAP; i++) delete taskDraftsCache[keys[i]];
    uiPutDebounced(TASK_DRAFTS_KEY, taskDraftsCache, text ? 800 : 0);
  },

  /** Note di revisione ancorate al diff, in sospeso finché non si spediscono. */
  async getReviewNotes(taskId: string): Promise<DiffNote[]> {
    if (!reviewNotesCache) reviewNotesCache = (await uiGet<Record<string, DiffNote[]>>(REVIEW_NOTES_KEY)) ?? {};
    return reviewNotesCache[taskId] ?? [];
  },
  putReviewNotes(taskId: string, notes: DiffNote[]): void {
    if (!reviewNotesCache) reviewNotesCache = {};
    if (notes.length) reviewNotesCache[taskId] = notes;
    else delete reviewNotesCache[taskId];
    const keys = Object.keys(reviewNotesCache);
    for (let i = 0; i < keys.length - REVIEW_NOTES_CAP; i++) delete reviewNotesCache[keys[i]];
    // Svuotare è immediato: dopo l'invio non deve esistere una finestra in cui
    // un reload resuscita note già spedite.
    uiPutDebounced(REVIEW_NOTES_KEY, reviewNotesCache, notes.length ? 800 : 0);
  },
};
