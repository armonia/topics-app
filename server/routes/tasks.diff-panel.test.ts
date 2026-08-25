/**
 * `GET /api/boards/:p/tasks/:t/diff` — la route che disegna il pannello
 * «Modifiche», su un repo git VERO.
 *
 * Due cose sole, ed è per quelle che il pannello esisteva a metà:
 *  · il diff è quello dei commit PROPRI della card, e resta leggibile DOPO il
 *    land, quando il worktree è stato potato;
 *  · quando un diff non c'è, il `code` dice PERCHÉ — «verificato: nessun codice»,
 *    «non ricostruibile» e «non dispatchato» erano lo stesso silenzio.
  * @covers KANBAN-43
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../types";
import { createTasksRouter } from "./tasks";
import { projectIdForPath } from "../services/tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

async function git(cwd: string, args: string[]): Promise<string> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: ENV });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

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
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    max_agents_auto INTEGER, review_checks TEXT, dispatch_fanout INTEGER
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
  db.run(`CREATE TABLE task_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, topic_id TEXT, worktree_id TEXT, branch TEXT, model TEXT,
    state TEXT NOT NULL DEFAULT 'running',
    commit_sha TEXT, files_changed INTEGER, insertions INTEGER, deletions INTEGER,
    summary TEXT, error TEXT,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, ended_at TEXT, selected_at TEXT,
    UNIQUE (task_id, idx)
  )`);
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

type Worktree = { id: string; mode: string; absPath: string; branchName: string } | null;

function call(router: any, path: string) {
  const req = new Request(`http://x${path}`, { method: "GET" });
  return router(req, new URL(req.url), new URL(req.url).pathname, "GET") as Promise<Response | null>;
}

describe("GET /tasks/:id/diff", () => {
  let repo: string, db: Database, router: any, pid: string;
  let worktree: Worktree;

  async function commit(file: string, body: string, msg: string): Promise<string> {
    writeFileSync(join(repo, file), body);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", msg]);
    return git(repo, ["rev-parse", "HEAD"]);
  }

  function seedTask(o: {
    id: string; status?: string; topic?: string | null;
    deliveryBranch?: string | null; deliveryCommit?: string | null;
  }) {
    const now = new Date().toISOString();
    if (o.topic) db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [o.topic]);
    db.run(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, assigned_topic_id, delivery_branch, delivery_commit)
       VALUES (?, ?, 'la card', ?, ?, ?, ?, ?, ?)`,
      [o.id, pid, o.status ?? "review", now, now, o.topic ?? null, o.deliveryBranch ?? null, o.deliveryCommit ?? null],
    );
  }

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "diffpanel-"));
    pid = projectIdForPath(repo);
    worktree = null;
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "t@t.t"]);
    await git(repo, ["config", "user.name", "t"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    await commit("base.txt", "base\n", "base");

    db = freshDb();
    const ctx = {
      db,
      json: (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
      readJSON: (req: Request) => req.json(),
      matchRoute,
      broadcastToAll: () => {},
      getTopicById: (id: string) => ({ id, name: id, projectPath: repo, worktreeId: worktree?.id }),
      getTopicBySessionKey: () => null,
      worktreeStore: { get: (id: string) => (worktree && worktree.id === id ? worktree : null) },
    } as unknown as AppContext;
    router = createTasksRouter(ctx, undefined, { listProjectDirs: () => [repo] });
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test("una card che nessun agente ha toccato: `not_dispatched`, non un vuoto muto", async () => {
    seedTask({ id: "T" });
    const body = await (await call(router, `/api/boards/${pid}/tasks/T/diff`))!.json();
    expect(body.code).toBe("not_dispatched");
    expect(body.stat).toEqual([]);
  });

  test("un task che non esiste su questa board non rivela niente", async () => {
    seedTask({ id: "T" });
    const body = await (await call(router, `/api/boards/altra-board/tasks/T/diff`))!.json();
    expect(body.code).toBe("not_dispatched");
    expect(body.stat).toEqual([]);
  });

  test("dispatchata ma senza worktree e senza consegna: `unreadable`", async () => {
    seedTask({ id: "T", topic: "topic-1" });
    const body = await (await call(router, `/api/boards/${pid}/tasks/T/diff`))!.json();
    expect(body.code).toBe("unreadable");
  });

  test("worktree vivo: il diff è quello dei commit PROPRI, non di tutto il ramo", async () => {
    // Un'altra sessione parcheggiata sul checkout condiviso, e la card che nasce
    // da lì: il ramo porta anche i suoi commit, la card non deve intestarseli.
    await git(repo, ["checkout", "-q", "-b", "topics/altra"]);
    await commit("roba-di-un-altro.ts", "non mia\n", "lavoro altrui");
    await git(repo, ["checkout", "-q", "-b", "topics/card"]);
    await commit("mio.ts", "mio\n", "lavoro della card");
    worktree = { id: "wt-1", mode: "branch", absPath: repo, branchName: "topics/card" };

    seedTask({ id: "T", topic: "topic-1" });
    const body = await (await call(router, `/api/boards/${pid}/tasks/T/diff`))!.json();
    expect(body.source).toBe("worktree");
    expect(body.stat.map((s: any) => s.path)).toEqual(["mio.ts"]);
    expect(body.code).toBeUndefined();
  });

  test("worktree vivo che non ha prodotto niente: `no_changes` (verificato)", async () => {
    await git(repo, ["checkout", "-q", "-b", "topics/card"]);
    worktree = { id: "wt-1", mode: "branch", absPath: repo, branchName: "topics/card" };
    seedTask({ id: "T", topic: "topic-1" });

    const body = await (await call(router, `/api/boards/${pid}/tasks/T/diff`))!.json();
    expect(body.code).toBe("no_changes");
    expect(body.source).toBe("worktree");
    expect(body.stat).toEqual([]);
  });

  test("DOPO il land il pannello continua a disegnarsi: risponde il merge su main", async () => {
    await git(repo, ["checkout", "-q", "-b", "topics/card"]);
    const delivered = await commit("consegna.ts", "uno\ndue\n", "la consegna");
    await git(repo, ["checkout", "-q", "main"]);
    await git(repo, ["merge", "--no-ff", "-m", "merge task T: la card", "topics/card"]);
    await git(repo, ["branch", "-qD", "topics/card"]); // il reap
    seedTask({ id: "T", status: "done", topic: "topic-1", deliveryBranch: "topics/card", deliveryCommit: delivered });
    // Il worktree non c'è più: è la condizione in cui il pannello spariva.
    worktree = null;

    const body = await (await call(router, `/api/boards/${pid}/tasks/T/diff`))!.json();
    expect(body.source).toBe("landed-merge");
    expect(body.stat.map((s: any) => s.path)).toEqual(["consegna.ts"]);
    expect(body.stat[0].additions).toBe(2);
    expect(body.patch).toContain("+uno");
    expect(body.branch).toBe("topics/card");
  });
});
