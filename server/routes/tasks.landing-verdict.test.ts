/**
 * THE LANDING VERDICT ACCUSES ONLY WHEN IT HOLDS PROOF.  @covers LAND-05
 *
 * THE BAR, 13/08: `landing_state` said `landed` on cards that were not on main
 * (`2d3d6051`, `8f1f1b95`), and three cards (`92d61427`, `274d5425`,
 * `95a6794f`) sat at `done` with the branch never landed and worktree pruning
 * ready to carry it away. The field was not a measurement: it copied what
 * `git merge` reports, and that says a merge succeeded, NOT onto which branch.
 *
 * One subject: which verdict gets stamped for each merge outcome — `landed`
 * only with the confirmation on main, `unlanded` for the no, `unverifiable`
 * for the don't-know, `ask` where landing saw nothing — and what does NOT get
 * pruned until the verdict is proof. Split out of `tasks.landing.test.ts` on
 * 17/09, when that file had blown through `check:bloat` at 1,076 lines.
 */
import { test, expect, describe } from "bun:test";
import { createTasksRouter } from "./tasks";
import { createTaskService } from "../services/tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

describe("il verdetto di atterraggio si registra, non si deduce", () => {
  /** A merge that worked, in the shape `tryMerge` hands back. */
  const MERGED = {
    status: "merged", commit: "a5f83e0e", branch: "topics/wooly-saunter", repoPath: "/repo",
    touchedClient: false, touchedServer: false, touchedNative: false,
    landedNotLive: false, checkoutBranch: "main", deliveryDrift: null, realigned: null,
  };
  /**
   * The landing verdict is STAMPED as the land happens, while the branch is
   * still there. Deriving it afterwards from the delivery commit alone gets it
   * wrong: replayed by hand over 108 cards, the reverse-patch heuristic raised
   * 20 false alarms and the distinctive-line one 5. The land that watched the
   * merge has nobody to ask.
   */
  async function landStamping(
    merge: any,
    confirm?: (repoPath: string, commit: string) => Promise<boolean | null>,
  ): Promise<Array<[string, string]>> {
    const stamped: Array<[string, string]> = [];
    const d = freshDb(); const b: any[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: { tryMerge: async () => merge, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
      stampLanding: async (taskId: string, verdict: string) => { stamped.push([taskId, verdict]); },
      // A confirmed land sweeps the draft and the origin branch: stubbed, or the
      // run spawns a real `gh` at a path that does not exist here.
      closeDelivery: async () => ({ pr: null, branchDeleted: false, problems: [] }),
      ...(confirm ? { confirmLandedOnMain: confirm } : {}),
    });
    d.run("INSERT INTO topics (id) VALUES ('top-a')");
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET assigned_topic_id='top-a', status='review' WHERE id = ?").run(t.id);
    d.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('ca', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());
    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((r) => setTimeout(r, 20));
    return stamped.map(([, v]) => [t.id, v] as [string, string]);
  }

  test("merge riuscito E CONFERMATO su main → l'esito si REGISTRA come 'landed'", async () => {
    const [[, v]] = await landStamping(MERGED, async () => true) as any;
    expect(v).toBe("landed");
  });

  /**
   * Here the merge says yes and main says no, which is exactly the shape of
   * `2d3d6051` and `8f1f1b95` on 13/08: `landed` must not be written. Put the
   * old order back — verdict derived from `tryMerge`'s status — and this test
   * goes red.
   */
  test("il merge dice sì ma main dice di no: non si scrive MAI 'landed'", async () => {
    const [[, v]] = await landStamping(MERGED, async () => false) as any;
    expect(v).toBe("unlanded");
  });

  /**
   * The 13/08 failure in its worst shape: the land BELIEVES it worked. `git
   * merge` exited zero, the thread writes «Mergiato su main», the card closes —
   * and main holds nothing (checkout parked on another branch, a throwaway
   * worktree never stitched back). `92d61427`, `274d5425` and `95a6794f` went
   * that way: `done`, branches never landed, worktree pruning queued up behind
   * them.
   *
   * Three things at once, and all three are needed: the card does not close,
   * the worktree (the only copy of the work) is not pruned, and the thread says
   * why.
   */
  test("merge non confermato da main: la card NON si chiude e il worktree resta", async () => {
    const d = freshDb(); const b: any[] = []; const reaped: string[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: { tryMerge: async () => MERGED, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
      confirmLandedOnMain: async () => false,
      deleteTaskWorktree: async (taskId: string) => { reaped.push(taskId); return true; },
      taskBranchStatus: async () => "unmerged" as const,
      taskWorktreeDirt: async () => [],
    });
    d.run("INSERT INTO topics (id) VALUES ('top-nc')");
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET assigned_topic_id='top-nc', status='review' WHERE id = ?").run(t.id);

    const res = await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    expect(res!.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));

    const after = createTaskService(d).get(t.id)!;
    expect(after.task.status).toBe("review");     // NOT done: the land never happened
    expect(reaped).toEqual([]);                   // and the branch stays: it is the only copy
    expect(after.comments.some((c) => c.content.includes("Land NON confermato"))).toBe(true);
  });

  /**
   * CONTRACT DOOR — the probe answers `ok:false` (git did not reply).
   *
   * Before the fix `reapAfterLand` read `taskWorktreeDirt` (string[] | null),
   * so a mute `git status` collapsed into `paths:[]` = «clean» and the reap ran
   * against a tree it knew nothing about.
   *
   * WHEN `git status` REALLY GOES MUTE, measured 2026-08-18 — because the first
   * version of this comment blamed «index.lock», and that is FALSE: with a
   * `.git/index.lock` present, `git status --porcelain` exits 0 and reports the
   * dirt correctly, both unstaged and staged. What makes it exit non-zero is a
   * missing directory or broken git metadata (worktree admin dir pruned →
   * `fatal: not a git repository`, exit 128). The channel for losing work is
   * narrow — dir present + uncommitted changes + broken metadata + branch
   * already merged — but it is real, and above all the two doors onto the same
   * pure contract must stop diverging.
   *
   * A wrong «why» inside a comment is worse than no comment: it gets inherited,
   * and the next person builds on it.
   *
   * With `taskWorktreeDirtProbe`, `ok:false` counts as much as dirt: the reap
   * does NOT run, the thread says why, the branch stays.
   */
  test("sonda illeggibile (ok:false): il worktree NON viene potato anche dopo un land riuscito", async () => {
    const d = freshDb(); const b: any[] = []; const reaped: string[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: { tryMerge: async () => MERGED, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
      confirmLandedOnMain: async () => true,
      closeDelivery: async () => ({ pr: null, branchDeleted: false, problems: [] }),
      deleteTaskWorktree: async (taskId: string) => { reaped.push(taskId); return true; },
      taskBranchStatus: async () => "merged" as const,
      // Fail-open probe: ok:false stands for a `git status` that never answers
      // (half-unmounted directory, a filesystem that hangs).
      taskWorktreeDirtProbe: async () => ({ ok: false, paths: [] }),
    });
    d.run("INSERT INTO topics (id) VALUES ('top-probe')");
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "probe-feature" }))!.json();
    d.prepare("UPDATE tasks SET assigned_topic_id='top-probe', status='review' WHERE id = ?").run(t.id);
    d.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('cp1', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());

    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((r) => setTimeout(r, 30));

    // The land reported success (MERGED, confirmed on main), but the probe said
    // «I don't know»: unreadable != clean, so nothing gets pruned.
    expect(reaped).toEqual([]);
    // The thread has to say why the worktree is still there.
    const comments = d.prepare("SELECT content FROM task_comments WHERE task_id = ?").all(t.id) as Array<{ content: string }>;
    const guardComment = comments.find((c) => c.content.includes("NON ripulito") || c.content.includes("illeggibile"));
    expect(guardComment).toBeDefined();
    expect(guardComment!.content).toMatch(/illeggibile|leggibile/);
  });

  test("main non risponde: il verdetto è «non verificabile», mai 'landed'", async () => {
    // The no and the don't-know stay two different things: `null` accuses
    // nobody, but it acquits nobody either — and `landed` is an acquittal.
    const [[, v]] = await landStamping(MERGED, async () => null) as any;
    expect(v).toBe("unverifiable");
    // Same outcome when the check is simply not wired on this host: a missing
    // capability is absence of proof, not proof that nothing is wrong (missing
    // wiring is precisely how these failures are born).
    const [[, v2]] = await landStamping(MERGED) as any;
    expect(v2).toBe("unverifiable");
  });

  test("land fallito → si registra 'unlanded': anche il no è un fatto osservato", async () => {
    const [[, v]] = await landStamping({ status: "skipped", reason: "x", code: "unisolable" }) as any;
    expect(v).toBe("unlanded");
    const [[, v2]] = await landStamping({ status: "conflict" }) as any;
    expect(v2).toBe("unlanded");
  });

  test("dove il land NON sa (niente ramo, niente da portare) si CHIEDE al repo", async () => {
    // The control on the two tests above: if it always stamped a fact, it would
    // be signing testimony about something it never saw.
    const [[, v]] = await landStamping({ status: "nothing" }) as any;
    expect(v).toBe("ask");
    const [[, v2]] = await landStamping({ status: "skipped", reason: "x", code: "no-branch" }) as any;
    expect(v2).toBe("ask");
  });
});
