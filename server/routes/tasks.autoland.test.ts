/**
 * THE INVISIBLE CARD WITH A GREEN BAR LANDS ITSELF.  @covers LAND-05
 *
 * `whoCloses` said `conductor` for such a card since 11/08 and nothing ever
 * executed it: on 08/11 27 cards sat in review and the only way out was a
 * person's gesture. These cases pin the executor, end to end through the
 * agent's door: a delivery PATCH, the bar measured on the delivered commit, the
 * land queued, and the card closed only by a merge main confirms.
 *
 * Each refusal below is one of the things that must keep the card in review.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTasksRouter } from "./tasks";
import { createTaskService, type TaskService } from "../services/tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";
import type { TaskFile } from "../../shared/task-labels";

const MERGED = {
  status: "merged", commit: "a5f83e0e", branch: "topics/auto", repoPath: "/repo",
  touchedClient: false, touchedServer: true, touchedNative: false,
  landedNotLive: false, checkoutBranch: "main", deliveryDrift: null, realigned: null,
};

interface Knobs {
  files?: TaskFile[];
  checksCommit?: string;
  deliveryCommit?: string;
  autoMerge?: boolean;
  turns?: () => number;
  deliveryFiles?: string[] | null | ((commit: string) => string[] | null);
  /** Runs when the land is put in the queue, before its turn: the world moves here. */
  onQueued?: (taskId: string) => void;
  /** Runs inside `tryMerge`, before the last look (the fetch and the chain happen here): the world moves here too. */
  inTryMerge?: (taskId: string) => void;
  /** The board runs the `armonia` workflow (it has the AI review column). */
  armonia?: boolean;
}

let sweep: (() => Promise<number>) | null = null;
/** The land queue answers `skipped` (the branch fell behind main): the card stays in review. */
let skip = false;

const GLOBAL_TOPIC = "global-coordinator";
const GLOBAL_KEY = "topic:global-coordinator";

describe("a delivery that needs no one lands itself", () => {
  let db: Database; let svc: TaskService; let broadcasts: unknown[];
  let merges: Array<{ taskId: string; delivery: unknown }>;
  const cwd = mkdtempSync(join(tmpdir(), "tasks-autoland-"));

  beforeEach(() => { db = freshDb(); svc = createTaskService(db); broadcasts = []; merges = []; skip = false; });
  afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });

  async function deliver(k: Knobs = {}, patch: Record<string, unknown> = {}, how: { global?: boolean } = {}) {
    if (how.global) {
      db.run("INSERT INTO topics (id, session_key, project_path, worktree_id, parent_id, provider) VALUES (?, ?, NULL, NULL, NULL, 'codex')", [GLOBAL_TOPIC, GLOBAL_KEY]);
      db.run("INSERT INTO global_orchestrator_sessions (scope, topic_id, created_at, updated_at) VALUES ('global', ?, ?, ?)", [GLOBAL_TOPIC, "2026-11-09T10:00:00.000Z", "2026-11-09T10:00:00.000Z"]);
    }
    const router = createTasksRouter(makeCtx(db, broadcasts, how.global ? { [GLOBAL_KEY]: { projectPath: "/proj/one", name: "coordinator", topicId: GLOBAL_TOPIC } } : undefined), undefined, {
      taskCheckoutRef: async () => ({ cwd, commit: k.checksCommit ?? "abc1234" }),
      realignForChecks: async () => ({ ok: true, note: null }),
      taskDeliveryRef: async () => ({ branch: "topics/auto", commit: k.deliveryCommit ?? "abc1234", repoPath: "/repo" }),
      ownCommitFiles: async () => k.files ?? [{ path: "server/lib/git-numstat.ts", added: true }],
      deliveryFiles: async (_taskId: string, commit: string) => (typeof k.deliveryFiles === "function" ? k.deliveryFiles(commit) : k.deliveryFiles === undefined ? ["docs/note.md"] : k.deliveryFiles),
      // Nothing in the fixture's bar configuration names the delivered files.
      deliveryReferenced: async () => [],
      markLandPending: (taskId: string) => k.onQueued?.(taskId),
      liveTurnCount: k.turns,
      autoLandPollMs: 5,
      onAutoLand: (api: { sweepAutoLand: () => Promise<number> }) => { sweep = api.sweepAutoLand; },
      autoMerge: {
        tryMerge: async (taskId: string, _t: string, delivery: { beforeMerge?: (sha: string) => Promise<string | null>; commit: string | null }) => {
          // What the real one does under its chain: the world may move while it fetches, and the last look is asked right before the merge.
          k.inTryMerge?.(taskId);
          const stop = await delivery.beforeMerge?.(delivery.commit ?? "");
          if (stop) return { status: "skipped", code: "auto-land-stopped", reason: stop };
          merges.push({ taskId, delivery });
          return skip ? { status: "skipped", code: "realign-needed", reason: "il ramo e' indietro" } : MERGED;
        },
        buildClient: async () => ({ code: 0, stderr: "" }),
      } as never,
      confirmLandedOnMain: async () => true,
      stampLanding: async (taskId: string, verdict: string) => {
        if (verdict !== "ask") svc.recordLandingState({ taskId, state: verdict as never, checkedAt: new Date().toISOString(), witnessed: true });
      },
    } as Parameters<typeof createTasksRouter>[2]);
    const task = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "riordina gli script" }))!.json();
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(task.id);
    await call(router, "POST", `/api/sessions/s1/tasks/${task.id}/comments`, { content: "fatto, guarda scripts/" });
    svc.updateBoardSettings(task.projectId, { dispatchAutoMerge: k.autoMerge ?? true, reviewChecks: [{ name: "ok", cmd: "true" }] });
    if (k.armonia) {
      db.run("CREATE TABLE IF NOT EXISTS board_workflows (scope TEXT PRIMARY KEY, preset TEXT NOT NULL, updated_at TEXT NOT NULL)");
      db.run("INSERT INTO board_workflows (scope, preset, updated_at) VALUES (?, 'armonia', '2026-11-09T10:00:00.000Z')", [task.projectId]);
    }
    const door = how.global ? `/api/orchestrator-sessions/${encodeURIComponent(GLOBAL_KEY)}/tasks/${task.id}` : `/api/sessions/s1/tasks/${task.id}`;
    const resp = (await call(router, "PATCH", door, { status: "review", summary: "riordinati", legMs: 10_000, ...patch }))!;
    // The land is queued behind the response: let the queue drain.
    await Bun.sleep(80);
    return { id: task.id as string, resp, read: () => svc.get(task.id)!, router };
  }

  test("invisible + green bar on the delivered commit + no question: the merge is asked and the card closes", async () => {
    const d = await deliver();
    expect(d.resp.status).toBe(200);
    expect(merges.map((m) => m.taskId)).toEqual([d.id]);
    // The land is told not to realign: the bar measured THIS commit.
    expect(merges[0]!.delivery).toMatchObject({ branch: "topics/auto", commit: "abc1234", noRealign: true });
    const after = d.read();
    expect(after.task.status).toBe("done");
    expect(after.task.landingState).toBe("landed");
    expect(after.comments.some((c) => c.content.includes("Atterrata da sola"))).toBe(true);
  }, 30_000);

  test("a delivery that touches only documents is a decision: it stays in review", async () => {
    const d = await deliver({ files: [{ path: "docs/piano.md", added: true }] });
    expect(merges).toEqual([]);
    expect(d.read().task.status).toBe("review");
  }, 30_000);

  test("a human_ask on the delivery keeps it in review", async () => {
    const d = await deliver({}, { human_ask: "guarda il testo del messaggio ai canali" });
    expect(merges).toEqual([]);
    expect(d.read().task.status).toBe("review");
  }, 30_000);

  test("the agent's last word being a question keeps it in review", async () => {
    const router = createTasksRouter(makeCtx(db, broadcasts), undefined, {
      taskCheckoutRef: async () => ({ cwd, commit: "abc1234" }),
      realignForChecks: async () => ({ ok: true, note: null }),
      taskDeliveryRef: async () => ({ branch: "topics/auto", commit: "abc1234", repoPath: "/repo" }),
      ownCommitFiles: async () => [{ path: "scripts/check-tidy.ts", added: true }],
      autoMerge: { tryMerge: async (taskId: string) => { merges.push({ taskId, delivery: null }); return MERGED; }, buildClient: async () => ({ code: 0, stderr: "" }) } as never,
    } as Parameters<typeof createTasksRouter>[2]);
    const task = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "riordina" }))!.json();
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(task.id);
    await call(router, "POST", `/api/sessions/s1/tasks/${task.id}/comments`, {
      content: "```question\nLo cancello o lo tengo?\n- Cancella\n- Tieni\n```",
    });
    svc.updateBoardSettings(task.projectId, { dispatchAutoMerge: true, reviewChecks: [{ name: "ok", cmd: "true" }] });
    await call(router, "PATCH", `/api/sessions/s1/tasks/${task.id}`, { status: "review", summary: "serve una scelta", legMs: 10_000 });
    await Bun.sleep(60);
    expect(merges).toEqual([]);
    expect(svc.get(task.id)!.task.status).toBe("review");
  }, 30_000);

  test("the board's automatic merge being off keeps it in review", async () => {
    const d = await deliver({ autoMerge: false });
    expect(merges).toEqual([]);
    expect(d.read().task.status).toBe("review");
  }, 30_000);

  test("the sweep lands what a lost wait left in review, once the verdict allows it", async () => {
    // The board's switch is off at delivery, as if the wait had been lost to a reload.
    const d = await deliver({ autoMerge: false });
    expect(merges).toEqual([]);
    svc.updateBoardSettings(d.read().task.projectId, { dispatchAutoMerge: true });
    expect(await sweep!()).toBe(1);
    await Bun.sleep(80);
    expect(merges.map((m) => m.taskId)).toEqual([d.id]);
    expect(d.read().task.status).toBe("done");
  }, 30_000);

  test("a bar measured on another commit than the delivered one keeps it in review", async () => {
    const d = await deliver({ checksCommit: "aaaaaaa1", deliveryCommit: "bbbbbbb2" });
    expect(merges).toEqual([]);
    expect(d.read().task.status).toBe("review");
  }, 30_000);

  test("a server diff waits for ZERO open turns, then lands", async () => {
    let turns = 2;
    const d = await deliver({ deliveryFiles: ["server/lib/x.test.ts"], turns: () => turns });
    expect(merges).toEqual([]);
    expect(d.read().task.status).toBe("review");
    turns = 0;
    await Bun.sleep(120);
    expect(merges.map((m) => m.taskId)).toEqual([d.id]);
    expect(d.read().task.status).toBe("done");
  }, 30_000);

  test("a card archived while the land waits for the turns does not land", async () => {
    // `Task` carries no `archived` field: the verdict used to read `undefined` and say yes.
    let turns = 2;
    const d = await deliver({ deliveryFiles: ["server/lib/x.test.ts"], turns: () => turns });
    expect(merges).toEqual([]);
    db.prepare("UPDATE tasks SET archived = 1 WHERE id = ?").run(d.id);
    turns = 0;
    await Bun.sleep(120);
    expect(merges).toEqual([]);
    expect(d.read().task.status).toBe("review");
  }, 30_000);

  test("a delivery whose files cannot be read does not land: a land that does not know what it changes does not happen", async () => {
    const d = await deliver({ deliveryFiles: null });
    expect(merges).toEqual([]);
    expect(d.read().task.status).toBe("review");
  }, 30_000);

  test("a delivery under a path that reaches a person (push, presence, channels) stays in review", async () => {
    const d = await deliver({ deliveryFiles: ["server/push-triggers.ts"] });
    expect(merges).toEqual([]);
    expect(d.read().task.status).toBe("review");
  }, 30_000);

  test("the files are read again when the land's turn in the queue comes: a change in between stops the merge", async () => {
    // Read 1: the ask. Read 2: the recheck the queue runs just before the merge, after the world moved.
    let reads = 0;
    const d = await deliver({ deliveryFiles: () => (++reads >= 2 ? ["server/routes/auth.ts", "PRIVACY.md"] : ["docs/note.md"]) });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(merges).toEqual([]);
    const after = d.read();
    expect(after.task.status).toBe("review");
    expect(after.comments.some((c) => c.content.includes("si è fermato"))).toBe(true);
  }, 30_000);

  test("the paths are read on the delivered commit, and the merge is asked for that same commit", async () => {
    const asked: string[] = [];
    const d = await deliver({ deliveryFiles: (commit) => { asked.push(commit); return ["docs/note.md"]; } });
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(new Set(asked)).toEqual(new Set(["abc1234"]));
    expect(merges.map((m) => (m.delivery as { commit: string }).commit)).toEqual(["abc1234"]);
    expect(d.read().task.status).toBe("done");
  }, 30_000);

  test("a card that moved to another green commit while its land waited is not merged on the old offer; it starts again", async () => {
    // Harmless paths and a green bar on the NEW commit too: the verdict on it would be yes, but nobody asked about it.
    const moveTo = (id: string) => { db.prepare("UPDATE tasks SET delivery_commit = 'bbbbbbb2', checks_commit = 'bbbbbbb2' WHERE id = ?").run(id); };
    const asked: string[] = [];
    const d = await deliver({ onQueued: moveTo, deliveryFiles: (commit) => { asked.push(commit); return ["docs/note.md"]; } });
    expect(merges).toEqual([]);
    const stopped = d.read();
    expect(stopped.task.status).toBe("review");
    expect(stopped.comments.some((c) => c.content.includes("si è fermato"))).toBe(true);
    // Starting again: the sweep asks about the new commit, reads ITS paths, and that one lands.
    await sweep!(); await Bun.sleep(80);
    expect(asked.at(-1)).toBe("bbbbbbb2");
    expect(merges.map((m) => (m.delivery as { commit: string }).commit)).toEqual(["bbbbbbb2"]);
  }, 30_000);

  test("a land the queue refused is not asked again at every sweep", async () => {
    skip = true;
    const d = await deliver();
    expect(merges.length).toBe(1);
    expect(d.read().task.status).toBe("review");
    await sweep!(); await Bun.sleep(40);
    await sweep!(); await Bun.sleep(40);
    await sweep!(); await Bun.sleep(40);
    expect(merges.length).toBe(1);
  }, 30_000);

  test("the global coordinator's door lands a green invisible delivery too", async () => {
    const d = await deliver({}, {}, { global: true });
    expect(merges.map((m) => m.taskId)).toEqual([d.id]);
    expect(d.read().task.status).toBe("done");
  }, 30_000);
  test("a card archived and asking something while the land is inside tryMerge (the fetch, the chain) is not merged", async () => {
    // The verifier's scenario B: the verdict was yes when the land was queued and yes when its turn came; the card changes during the fetch.
    const d = await deliver({ inTryMerge: (id) => { db.prepare("UPDATE tasks SET archived = 1, human_ask = 'Non landare, aspetta me' WHERE id = ?").run(id); } });
    expect(merges).toEqual([]);
    const after = d.read();
    expect(after.task.status).toBe("review");
    expect(after.comments.some((c) => c.content.includes("si è fermato prima del merge"))).toBe(true);
    expect(after.comments.some((c) => c.content.includes("Atterrata da sola"))).toBe(false);
  }, 30_000);

  test("the note 'landed alone' is written inside the last look, so a refusal never stands under it", async () => {
    const d = await deliver({ inTryMerge: (id) => { db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(id); } });
    expect(merges).toEqual([]);
    expect(d.read().comments.some((c) => c.content.includes("Atterrata da sola"))).toBe(false);
  }, 30_000);

  describe("server code goes through the board's AI review", () => {
    const FULL = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const server = { deliveryFiles: ["server/lib/git-numstat.ts"], deliveryCommit: FULL, checksCommit: FULL };

    function reviewer(id: string, model: string | null) {
      try { db.run("ALTER TABLE topics ADD COLUMN model TEXT"); } catch { /* already there */ }
      db.run("INSERT OR REPLACE INTO topics (id, name, session_key, model) VALUES (?, ?, ?, ?)", [id, id, `topic:${id}`, model]);
    }
    /** The card is in the AI review column, written by a sonnet session (the fixture's agent, topic `top-s1`). */
    function inAiReview(id: string) {
      reviewer("top-s1", "claude-sonnet-5-5");
      db.prepare("UPDATE tasks SET stage = 'ai_review', model = 'claude-sonnet-5-5' WHERE id = ?").run(id);
    }

    test("a board without an AI review column: server code stays in review, even with an approval on the card", async () => {
      reviewer("rev1", "claude-opus-4-7");
      const d = await deliver(server);
      inAiReview(d.id);
      svc.addComment({ taskId: d.id, author: "agent:rev1", content: `AI-REVIEW approved ${FULL}\nok` });
      await sweep!(); await Bun.sleep(80);
      expect(merges).toEqual([]);
      expect(d.read().task.status).toBe("review");
    }, 30_000);

    test("on an armonia board it lands only after another session on another model approved THIS commit", async () => {
      reviewer("rev1", "claude-opus-4-7");
      const d = await deliver({ ...server, armonia: true });
      inAiReview(d.id);
      expect(merges).toEqual([]);
      // No approval yet.
      await sweep!(); await Bun.sleep(80);
      expect(merges).toEqual([]);
      // The same model family reviews: no.
      reviewer("rev2", "claude-sonnet-4-6");
      svc.addComment({ taskId: d.id, author: "agent:rev2", content: `AI-REVIEW approved ${FULL}\nok` });
      await sweep!(); await Bun.sleep(80);
      expect(merges).toEqual([]);
      // Another model, another session, this sha: yes.
      svc.addComment({ taskId: d.id, author: "agent:rev1", content: `AI-REVIEW approved ${FULL}\nLetto il diff: solo helper di git.` });
      await sweep!(); await Bun.sleep(80);
      expect(merges.map((m) => m.taskId)).toEqual([d.id]);
      expect(d.read().task.status).toBe("done");
      expect(d.read().comments.some((c) => c.content.includes("revisione AI"))).toBe(true);
    }, 30_000);
  });
});
