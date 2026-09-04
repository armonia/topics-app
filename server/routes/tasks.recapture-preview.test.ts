/**
 * «Ricattura evidenza» — POST /api/boards/:p/tasks/:t/preview.
 *
 * `prepareForReview` girava in un punto solo: il bordo d'ingresso in review.
 * Una card che l'evidenza l'ha PERSA (i due cancelli dell'11/08 l'hanno ritirata
 * a 23 card) poteva riaverla solo uscendo da review e rientrandoci — cioè
 * svegliando un agente e bruciando un turno per una foto.
 *
 * Questi test tengono ferme le due metà del contratto:
 *   1. l'azione RIFÀ l'evidenza e NON muove nient'altro — status ancora `review`,
 *      `dispatch_attempts` invariato, nessun topic assegnato, dispatcher mai
 *      chiamato (né `resume` né `dispatch`);
 *   2. quando l'anteprima è impossibile l'esito è comunque ONESTO — nessuna
 *      immagine, una review-note col motivo, e sempre nessun risveglio: il
 *      canale `review-note` non sveglia l'agente, un commento umano invece
 *      farebbe reject+resume ed è esattamente ciò che qui non deve succedere.
 *
 * Il preview manager è quello VERO (deps iniettate): il ramo negativo deve
 * dimostrare la nota, non la nostra idea della nota.
  * @covers KANBAN-41
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { AppContext } from "../types";
import { createTasksRouter } from "./tasks";
import { createTaskService } from "../services/tasks";
import { createPreviewManager, type PreviewProcess, type PreviewWorktree } from "../services/preview-manager";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    max_agents_auto INTEGER, review_checks TEXT
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment',
    -- migration 20260904190855: the assistant row an agent said this in.
    message_id TEXT
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  // `rowToTask` legge le etichette per OGNI riga: senza questa tabella ogni
  // lettura di task esplode in un 500, non solo i test delle etichette.
  db.run(TASK_LABELS_DDL);
  return db;
}

/** Copia fedele di server/utils.ts:matchRoute. */
function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const pp = pattern.split("/"), xp = pathname.split("/");
  if (pp.length !== xp.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(xp[i]);
    else if (pp[i] !== xp[i]) return null;
  }
  return params;
}

function makeCtx(db: Database, broadcasts: any[]) {
  return {
    db,
    json: (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    readJSON: (req: Request) => req.json(),
    matchRoute,
    broadcastToAll: (m: any) => { broadcasts.push(m); },
    getTopicBySessionKey: () => null,
  } as unknown as AppContext;
}

function call(router: any, method: string, path: string, body?: any) {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = JSON.stringify(body);
  const req = new Request(`http://x${path}`, init);
  return router(req, new URL(req.url), new URL(req.url).pathname, method) as Promise<Response | null>;
}

const PID = "alpha-abc123";
const TID = "task-1";
const WT: PreviewWorktree = { id: "wt-1", absPath: "/wt/alpha", branchName: "task/1", projectId: PID, mode: "branch" };

/** Un figlio che vive e non muore mai: al test non serve un processo vero. */
function fakeProc(): PreviewProcess {
  return { pid: 4242, alive: () => true, kill: () => {} };
}

describe("POST /api/boards/:p/tasks/:t/preview — ricattura evidenza", () => {
  let db: Database, broadcasts: any[], svc: ReturnType<typeof createTaskService>;
  /** Ogni presa di contatto col dispatcher = un risveglio. Deve restare vuota. */
  let woke: string[];
  let shots: string[];

  beforeEach(() => {
    db = freshDb();
    broadcasts = []; woke = []; shots = [];
    svc = createTaskService(db);
  });

  /** Card in review, consegnata da un agente, SENZA anteprima: il caso reale. */
  function seedCardInReview(o: { attempts?: number } = {}) {
    const now = new Date().toISOString();
    db.run("INSERT INTO topics (id) VALUES ('topic-1')");
    db.run(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, assigned_topic_id, dispatch_attempts)
       VALUES (?, ?, 'fare la cosa', 'review', ?, ?, 'topic-1', ?)`,
      [TID, PID, now, now, o.attempts ?? 2],
    );
  }

  /**
   * Il router con dentro il preview manager VERO. `worktreeOf: null` è il ramo
   * negativo (nessun worktree ⇒ niente da avviare); `page` decide il cancello
   * sul contenuto; `screenshotOk` se lo scatto riesce.
   */
  function makeRouter(o: {
    worktree?: PreviewWorktree | null;
    page?: { status: number; body: string };
    screenshotOk?: boolean;
  } = {}) {
    const pm = createPreviewManager({
      worktreeOf: () => (o.worktree === undefined ? WT : o.worktree),
      resolveCommand: () => ({ cmd: ["bun", "run", "dev"], deepLinkPath: "/" }),
      spawn: () => fakeProc(),
      probe: async () => true,
      portFree: async () => true,
      fetchPage: async () => o.page ?? { status: 200, body: "<h1>La app del task</h1>" },
      screenshot: async (_url, outPath) => { shots.push(outPath); return o.screenshotOk !== false; },
      currentOutputUrl: (taskId) => svc.get(taskId, { projectId: PID })?.task.outputUrl ?? null,
      setOutputUrl: (taskId, url) => { svc.update({ taskId, actor: "agent", by: "verifier", patch: { outputUrl: url }, projectId: PID }); },
      setPreviewImage: (taskId, absPath) => { svc.update({ taskId, actor: "agent", by: "verifier", patch: { previewImage: absPath }, projectId: PID }); },
      addReviewNote: (taskId, { content, media }) => { svc.addComment({ taskId, author: "verifier", content, media, projectId: PID, kind: "review-note" }); },
      mediaDir: "/tmp/task-previews",
      ensureMediaDir: () => {},
    });
    // Ogni metodo che il dispatcher espone alla route è un modo di svegliare
    // l'agente: qui sono tutti spie, e il test è che nessuna scatti.
    const dispatcherSpy = {
      resume: async (id: string) => { woke.push(`resume:${id}`); },
      onEnterTodo: (_p: string, id: string) => { woke.push(`todo:${id}`); },
      onBlockerDone: (id: string) => { woke.push(`blockerDone:${id}`); },
      dispatch: async (id: string) => { woke.push(`dispatch:${id}`); },
    } as any;
    return createTasksRouter(makeCtx(db, broadcasts), dispatcherSpy, {
      preparePreview: (taskId, opts) => pm.prepareForReview(taskId, opts),
    });
  }

  function comments(kind?: string) {
    const rows = db.query("SELECT author, content, kind FROM task_comments WHERE task_id = ? ORDER BY created_at").all(TID) as any[];
    return kind ? rows.filter((r) => r.kind === kind) : rows;
  }

  test("card senza anteprima + preview manager che risponde ⇒ anteprima, e la card NON si muove", async () => {
    seedCardInReview({ attempts: 2 });
    const router = makeRouter();
    const before = svc.get(TID, { projectId: PID })!.task;
    expect(before.previewImage ?? null).toBeNull();

    const resp = (await call(router, "POST", `/api/boards/${PID}/tasks/${TID}/preview`))!;
    expect(resp.status).toBe(200);
    const body = await resp.json();

    // 1) L'evidenza c'è (ed è la stessa che risponde la route).
    const after = svc.get(TID, { projectId: PID })!.task;
    expect(after.previewImage).toBe(shots[0]!);
    expect(body.previewImage).toBe(shots[0]!);
    expect(after.outputUrl).toMatch(/^http:\/\/localhost:\d+\//);

    // 2) Non si è mosso nient'altro.
    expect(after.status).toBe("review");
    expect(after.dispatchAttempts).toBe(before.dispatchAttempts);
    expect(after.assignedTopicId).toBe(before.assignedTopicId ?? null);
    expect(woke).toEqual([]);

    // 3) L'esito è arrivato sul canale che NON sveglia.
    expect(comments("review-note")).toHaveLength(1);
    expect(comments("comment")).toHaveLength(0);

    // 4) La card si aggiorna su ogni device.
    expect(broadcasts.some((b) => b.type === "task:updated" && b.task?.id === TID)).toBe(true);
  });

  test("nessun worktree ⇒ nessuna anteprima, una review-note col MOTIVO, e comunque nessun risveglio", async () => {
    seedCardInReview({ attempts: 3 });
    const router = makeRouter({ worktree: null });

    const resp = (await call(router, "POST", `/api/boards/${PID}/tasks/${TID}/preview`))!;
    expect(resp.status).toBe(200);

    const after = svc.get(TID, { projectId: PID })!.task;
    expect(after.previewImage ?? null).toBeNull();
    expect(shots).toEqual([]);
    expect(after.status).toBe("review");
    expect(after.dispatchAttempts).toBe(3);
    expect(woke).toEqual([]);

    const notes = comments("review-note");
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain("worktree");
    expect(comments("comment")).toHaveLength(0); // MAI il canale che risveglia
  });

  test("pagina placeholder ⇒ l'evidenza vecchia viene AZZERATA e la nota dice perché", async () => {
    seedCardInReview();
    svc.update({ taskId: TID, actor: "agent", by: "verifier", patch: { previewImage: "/tmp/old.png" }, projectId: PID });
    const router = makeRouter({ page: { status: 503, body: "Bundle not built yet — cd client && bun run build" } });

    await call(router, "POST", `/api/boards/${PID}/tasks/${TID}/preview`);

    const after = svc.get(TID, { projectId: PID })!.task;
    expect(after.previewImage ?? "").toBe("");
    expect(shots).toEqual([]); // non si fotografa nemmeno
    expect(after.status).toBe("review");
    expect(comments("review-note")[0].content).toContain("503");
    expect(woke).toEqual([]);
  });

  test("task non in review ⇒ 409, e non tocca niente (l'azione vive sulla colonna review)", async () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at) VALUES (?, ?, 'x', 'in_progress', ?, ?)`,
      [TID, PID, now, now],
    );
    const router = makeRouter();
    const resp = (await call(router, "POST", `/api/boards/${PID}/tasks/${TID}/preview`))!;
    expect(resp.status).toBe(409);
    expect((await resp.json()).code).toBe("invalid_transition");
    expect(shots).toEqual([]);
    expect(comments()).toHaveLength(0);
  });

  test("task inesistente ⇒ 404", async () => {
    const router = makeRouter();
    const resp = (await call(router, "POST", `/api/boards/${PID}/tasks/nope/preview`))!;
    expect(resp.status).toBe(404);
  });

  test("senza preview manager ⇒ 503 dichiarato, non un finto ok", async () => {
    seedCardInReview();
    const router = createTasksRouter(makeCtx(db, broadcasts), undefined, {});
    const resp = (await call(router, "POST", `/api/boards/${PID}/tasks/${TID}/preview`))!;
    expect(resp.status).toBe(503);
  });
});
