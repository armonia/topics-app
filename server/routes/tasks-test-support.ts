/**
 * IL BANCO DI PROVA DELLE ROTTE DEI TASK, in un posto solo.
 *
 * `matchRoute` e' una copia FEDELE di quella in `server/utils.ts` (stessa
 * lunghezza stretta, stessa decodifica dei parametri): se le due divergono, i
 * test provano un instradamento che in produzione non avviene.
 *
 * Estratto il 18/08 quando `tasks.test.ts` ha sfondato il cancello di dimensione
 * (3.106 righe, tetto 3.055) e la meta' sull'atterraggio se n'e' andata in
 * `tasks.landing.test.ts`. Un banco solo per i due file: se lo schema o le
 * sessioni finte divergessero, i due test parlerebbero di due produzioni.
 */
import { Database } from "bun:sqlite";
import type { AppContext, RouteHandler } from "../types";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

export function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL); // migration 100 — rowToTask la legge per OGNI task
  db.run(`CREATE UNIQUE INDEX idx_tasks_claude_task_id ON tasks(claude_task_id) WHERE claude_task_id IS NOT NULL`);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_auto_merge INTEGER NOT NULL DEFAULT 0,
    max_agents_auto INTEGER, review_checks TEXT
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  // migration 065 — i tentativi del fan-out, ridotta a cio' che la rotta chiede.
  db.run(`CREATE TABLE task_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, topic_id TEXT, worktree_id TEXT, branch TEXT, model TEXT,
    state TEXT NOT NULL DEFAULT 'running', commit_sha TEXT, files_changed INTEGER,
    insertions INTEGER, deletions INTEGER, summary TEXT, error TEXT,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, ended_at TEXT, selected_at TEXT, UNIQUE (task_id, idx)
  )`);
  return db;
}

// Faithful copy of server/utils.ts:matchRoute (length-strict, decodes params).
export function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const pp = pattern.split("/"), xp = pathname.split("/");
  if (pp.length !== xp.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(xp[i]);
    else if (pp[i] !== xp[i]) return null;
  }
  return params;
}

// Map known session keys → project path, so resolveSession takes the topic branch.
// `topicId` feeds the own-steps carve-out (agent may close subtasks of the task
// bound to its topic).
export const SESSIONS: Record<string, { projectPath: string; name: string; topicId?: string }> = {
  s1: { projectPath: "/proj/one", name: "topic-one", topicId: "top-s1" },
  s2: { projectPath: "/proj/two", name: "topic-two" },
  // A catch-all ("generale") dispatch: the topic's cwd is a per-task private dir
  // that maps to NO real board — the agent's own task lives on a different
  // project_id, reachable only via assigned_topic_id.
  sCatch: { projectPath: "/home/.openclaw/workspace/tasks/abc123", name: "generale-agent", topicId: "top-catch" },
};

export function makeCtx(db: Database, broadcasts: unknown[]) {
  return {
    db,
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    readJSON: (req: Request) => req.json(),
    matchRoute,
    broadcastToAll: (m: unknown) => { broadcasts.push(m); },
    getTopicBySessionKey: (sk: string) => (SESSIONS[sk] ? ({ id: SESSIONS[sk].topicId, projectPath: SESSIONS[sk].projectPath, name: SESSIONS[sk].name } as unknown as ReturnType<AppContext["getTopicBySessionKey"]>) : null),
    // La potatura di un tentativo perdente archivia la sua chat. Qui non ci sono
    // chat vere: lo stub dice «non c'è» invece di lasciare che il `catch` di
    // `reapAttemptWorkspace` stampi un TypeError per ogni perdente.
    getTopicById: () => null,
  } as unknown as AppContext;
}

export function call(router: RouteHandler, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = JSON.stringify(body);
  const req = new Request(`http://x${path}`, init);
  return Promise.resolve(router(req, new URL(req.url), new URL(req.url).pathname, method));
}
