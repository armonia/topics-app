/**
 * @covers LAND-16
 * THE CI OF MAIN, THROUGH THE ROUTER: the red no card owns becomes a card (`services/main-ci-watch.ts`).
 * The sweep that already runs for the auto-land is what looks at main; no poller of its own.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { createTaskService, type TaskService } from "../services/tasks";
import { freshDb, makeCtx, call, setCiPhaseMode } from "./tasks-test-support";
import type { MainCiPort, MainCiVerdict } from "../services/main-ci-watch";

describe("main's CI watch", () => {
  let db: Database; let svc: TaskService;
  let verdict: MainCiVerdict; let enters: string[]; let asked: number;
  let sweep: (() => Promise<number>) | null = null;
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const SHA2 = "89abcdef0123456789abcdef0123456789abcdef";
  const SHA3 = "fedcba9876543210fedcba9876543210fedcba98";
  /** The newest commit of main: a test moves it to say that main went red again on another one. */
  let head = SHA;

  beforeEach(() => {
    db = setCiPhaseMode(freshDb(), "after"); svc = createTaskService(db);
    verdict = { state: "fail", failed: ["gates", "unit"], url: "https://github.example/run/42" };
    enters = []; asked = 0; head = SHA;
  });

  async function setup(withCiRows = true) {
    const port: MainCiPort = {
      recent: async () => { asked += 1; return [{ sha: head, subject: "fix a typo from a chat", at: Math.floor(Date.now() / 1000) - 3600 }]; },
      verdict: async () => verdict,
      entersAt: async (_commit, sha) => enters.includes(sha),
    };
    const router = createTasksRouter(makeCtx(db, []), undefined, {
      onAutoLand: (api: { sweepAutoLand: () => Promise<number> }) => { sweep = api.sweepAutoLand; },
      mainCiPort: async () => port,
      // The CI phase is on for the board (`after`): a mark that is not settled stays in the queue instead of being dropped.
      integrationMeasure: async (_p: string, ids: string[]) => ({ measured: ids, conflicts: [], verdict: "pass" as const, commit: "1ae9ca7e" }),
      integrationCollectMs: 60_000,
    } as Parameters<typeof createTasksRouter>[2]);
    const task = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "una card qualsiasi della board" }))!.json();
    const projectId = task.projectId as string;
    svc.updateBoardSettings(projectId, { dispatchAutoMerge: true, reviewChecks: withCiRows ? [{ name: "unit-ci", cmd: "github-ci:unit" }] : [{ name: "ok", cmd: "true" }] });
    const redCards = () => db.query("SELECT id, text, description, model, status, created_by AS by, archived FROM tasks WHERE text LIKE 'CI rossa su main%'").all() as Array<{ id: string; text: string; description: string; model: string | null; status: string; by: string; archived: number }>;
    return { projectId, redCards };
  }

  test("a red on a sha no card owns: ONE card with sha, red jobs and run link; the second sweep opens none, even once it is archived", async () => {
    const s = await setup();
    await sweep!();
    const [card, ...rest] = s.redCards();
    expect(rest).toEqual([]);
    expect(card!.text).toBe(`CI rossa su main dopo ${SHA.slice(0, 8)}: riparare`);
    expect(card!.status).toBe("todo");
    expect(card!.by).toBe("cron:main-ci");
    expect(card!.description).toContain(SHA);
    expect(card!.description).toContain("`gates`");
    expect(card!.description).toContain("https://github.example/run/42");
    expect(card!.description).toContain("--ff-only origin/main");
    expect(card!.description).toContain("gh run view <id> --log-failed");
    expect(card!.model).toBe("claude-sonnet-5-5");
    await sweep!();
    expect(s.redCards()).toHaveLength(1);
    db.prepare("UPDATE tasks SET archived = 1 WHERE id = ?").run(card!.id);
    await sweep!();
    expect(s.redCards()).toHaveLength(1);
  }, 30_000);

  test("main red AGAIN on another sha while the first red card is open: that card is told, no second card; once per sha", async () => {
    const s = await setup();
    await sweep!();
    const [first] = s.redCards();
    head = SHA2;
    verdict = { state: "fail", failed: ["unit"], url: "https://github.example/run/43" };
    await sweep!();
    await sweep!();
    expect(s.redCards()).toHaveLength(1);
    const lines = db.query("SELECT author, kind, content FROM task_comments WHERE task_id = ? AND instr(content, ?) > 0").all(first!.id, SHA2) as Array<{ author: string; kind: string; content: string }>;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.author).toBe("system");
    expect(lines[0]!.content).toContain("https://github.example/run/43");
    expect(lines[0]!.content).toContain("`unit`");
    // Back on the sha that opened the card: it is already the card's own, so nothing is written about it.
    head = SHA;
    await sweep!();
    expect(db.query("SELECT 1 FROM task_comments WHERE task_id = ? AND instr(content, ?) > 0").all(first!.id, `rossa anche sul commit \`${SHA}\``)).toHaveLength(0);
    expect(s.redCards()).toHaveLength(1);
  }, 30_000);

  test("the earlier red card is done (repaired): a new red opens a new card, as before", async () => {
    const s = await setup();
    await sweep!();
    const [first] = s.redCards();
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(first!.id);
    head = SHA3;
    await sweep!();
    const cards = s.redCards();
    expect(cards).toHaveLength(2);
    expect(cards.some((c) => c.text === `CI rossa su main dopo ${SHA3.slice(0, 8)}: riparare`)).toBe(true);
  }, 30_000);

  test("the open red card of ANOTHER project does not stand in for this project's red", async () => {
    const s = await setup();
    db.prepare("INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, claude_task_id) VALUES ('elsewhere', 'other-board', 'CI rossa su main dopo 12345678: riparare', 'todo', 'x', 'x', 'main-ci-red:other-board:12345678')").run();
    await sweep!();
    expect(s.redCards().filter((c) => c.id !== "elsewhere")).toHaveLength(1);
  }, 30_000);

  test("a green main opens nothing", async () => {
    verdict = { state: "pass", failed: [], url: null };
    const s = await setup();
    await sweep!();
    expect(s.redCards()).toEqual([]);
  }, 30_000);

  test("a red the after rule already carries (a pending mark whose commit came in with that sha) opens nothing", async () => {
    const s = await setup();
    const owner = svc.create({ projectId: s.projectId, text: "card landata, misura in corso" });
    db.prepare("UPDATE tasks SET ci_after = ? WHERE id = ?").run(JSON.stringify({ commit: "feedface", who: "human", repo: null, at: new Date().toISOString() }), owner.id);
    enters = [SHA];
    await sweep!();
    expect(s.redCards()).toEqual([]);
    // A mark the measure settled green does not hold a red back: the measure said green, the push said red.
    db.prepare("UPDATE tasks SET ci_after = ? WHERE id = ?").run(JSON.stringify({ commit: "feedface", who: "human", repo: null, at: new Date().toISOString(), settled: "green" }), owner.id);
    await sweep!();
    expect(s.redCards()).toHaveLength(1);
  }, 30_000);

  test("a board without CI rows, or with the CI turned off, is not looked at", async () => {
    const s = await setup(false);
    await sweep!();
    expect(s.redCards()).toEqual([]);
    expect(asked).toBe(0);
    svc.updateBoardSettings(s.projectId, { reviewChecks: [{ name: "unit-ci", cmd: "github-ci:unit" }] });
    setCiPhaseMode(db, "off");
    await sweep!();
    expect(s.redCards()).toEqual([]);
    expect(asked).toBe(0);
    setCiPhaseMode(db, "before");
    await sweep!();
    expect(s.redCards()).toHaveLength(1); // the same red, now that the board looks: proof the two silences were the board's
  }, 30_000);
});
