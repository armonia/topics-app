/**
 * AICTRL-01: un catalogo Topics ancora in scoperta NON e' un'indisponibilita' definitiva. allow-italian: la regola che il file difende
 * Con lo switch acceso, un motore nativo in `loading` (o uno snapshot non ancora assemblato) finiva in blocco permanente: la card si parcheggiava per una condizione che si risolve da sola in qualche secondo, e ci voleva una mano umana per rimetterla in giro. allow-italian: nomina il difetto trovato in review
 * La semantica giusta e' quella gia' in uso per il warm-up di Codex: pending, quindi defer e requeue, tentativo NON consumato. allow-italian: dice a quale precedente si allinea
 * Il seam e' quello vero: `createTopic` qui fa quello che fa `server.ts`, cioe' chiama `resolveDispatchTopicIdentity` con lo snapshot. allow-italian: dice quale porta di produzione viene esercitata
 *
 * @covers AICTRL-01
 */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { createTaskAttemptStore } from "./task-attempts";
import { resolveDispatchTopicIdentity } from "./dispatch-topic-identity";
import type { ProviderSnapshotEntry, ProvidersSnapshot } from "../../shared/types";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium', dispatch_model TEXT,
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_idle_min INTEGER NOT NULL DEFAULT 5,
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER,
    max_agents_auto INTEGER, dispatch_fanout INTEGER,
    dispatch_paused INTEGER NOT NULL DEFAULT 0,
    dispatch_topics_routing INTEGER CHECK (dispatch_topics_routing IN (0, 1))
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment', message_id TEXT
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  db.run(`CREATE TABLE task_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, topic_id TEXT, worktree_id TEXT, branch TEXT, model TEXT,
    state TEXT NOT NULL DEFAULT 'running', commit_sha TEXT, files_changed INTEGER,
    insertions INTEGER, deletions INTEGER, summary TEXT, error TEXT,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, ended_at TEXT, selected_at TEXT,
    UNIQUE (task_id, idx)
  )`);
  return db;
}

const PID = "alpha-abc123";

function entry(name: string, models: string[], status: ProviderSnapshotEntry["status"] = "ready"): ProviderSnapshotEntry {
  return { name, models, status, isDefault: false, requirements: [], fetchedAt: "2026-09-22T00:00:00Z" };
}
function snap(providers: ProviderSnapshotEntry[]): ProvidersSnapshot {
  return { providers, defaultProvider: "claude-code", generatedAt: "2026-09-22T00:00:00Z" };
}

/** Il motore nativo sta ancora enumerando i modelli: nessuna risposta, non un no. allow-italian: dice cosa rappresenta questa fotografia */
const LOADING = snap([entry("topics", [], "loading"), entry("claude-code", ["claude-opus-5"])]);
/** Motore nativo assente da uno snapshot vero: quello si', e' un no definitivo. allow-italian: e' la recinzione del caso qui sopra */
const ABSENT = snap([entry("claude-code", ["claude-opus-5"])]);

function seedTask(db: Database, id: string, model: string | null): void {
  const ts = new Date().toISOString();
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, model, topics_routing)
     VALUES (?, ?, ?, 'todo', ?, ?, 0, ?, 1)`,
    [id, PID, "task " + id, ts, ts, model],
  );
}

function harness(snapshot: ProvidersSnapshot | null, overrides: Partial<DispatcherDeps> = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const turns: string[] = [];
  const deps: DispatcherDeps = {
    svc,
    attempts: createTaskAttemptStore(db),
    resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    // Esattamente il corpo di `createTopic` in server.ts, snapshot incluso. allow-italian: dice quale porta vera sta imitando questo finto
    createTopic: (o) => {
      resolveDispatchTopicIdentity(o, snapshot);
      db.run("INSERT OR IGNORE INTO topics (id) VALUES ('topic-1')");
      return { topicId: "topic-1", sessionKey: "topic:sk1" };
    },
    createWorktree: async () => "wt-1",
    deleteWorktree: async () => {},
    runTurn: async (sessionKey: string) => { turns.push(sessionKey); return undefined as TurnEndInfo | undefined; },
    broadcast: () => {},
    graceMs: 10,
    retryBackoffMs: 0,
    log: () => {},
    ...overrides,
  };
  return { db, svc, dispatcher: createTaskDispatcher(deps), turns };
}

const flush = async (n = 40) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
};

async function run(snapshot: ProvidersSnapshot | null, o: { fanOut?: number; model?: string | null } = {}) {
  const h = harness(snapshot);
  h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, ...(o.fanOut ? { dispatchFanOut: o.fanOut } : {}) });
  h.svc.setGlobalCap({ auto: false, max: 5 });
  seedTask(h.db, "t1", "model" in o ? o.model ?? null : "claude-code:claude-opus-5");
  await h.dispatcher.tick(PID);
  await flush();
  return h;
}

describe("AICTRL-01: catalogo Topics in scoperta = attesa, non blocco", () => {
  it("un agente solo: la card resta in coda col motivo, senza consumare un tentativo", async () => {
    const h = await run(LOADING);

    const task = h.svc.get("t1")!.task;
    expect(task.dispatchState).toBe("queued");
    expect(task.status).toBe("todo");
    expect(task.dispatchAttempts).toBe(0);
    expect(task.dispatchError ?? "").toContain("topics");
    expect(h.turns).toHaveLength(0);
  });

  it("fan-out: stessa attesa, la card non si parcheggia come bloccata", async () => {
    const h = await run(LOADING, { fanOut: 2 });

    const task = h.svc.get("t1")!.task;
    expect(task.dispatchState).toBe("queued");
    expect(task.dispatchAttempts).toBe(0);
    expect(h.turns).toHaveLength(0);
  });

  it("Automatico: attesa sia col motore in scoperta sia con lo snapshot non ancora assemblato", async () => {
    expect((await run(LOADING, { model: null })).svc.get("t1")!.task.dispatchState).toBe("queued");
    expect((await run(null, { model: null })).svc.get("t1")!.task.dispatchState).toBe("queued");
  });

  it("la recinzione: motore nativo ASSENTE resta un blocco permanente col motivo", async () => {
    // Senza questa riga il fix comprerebbe l'attesa al prezzo di un blocco che non arriva mai: un motore che non c'e' non compare enumerando. allow-italian: dice perche' questo caso NON deve aspettare
    const h = await run(ABSENT);

    const task = h.svc.get("t1")!.task;
    expect(task.dispatchState).toBe("blocked");
    expect(task.dispatchError ?? "").toContain("claude-code");
  });
});
