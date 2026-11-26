/**
 * A finished card's branch leaves origin; open, unknown and moved branches stay.
 *
 * @covers WORKTREE-17
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  archiveTagFor,
  branchLives,
  readBranchLives,
  sweepFinishedBranchesOnOrigin,
  sweepGit,
  type BranchLife,
} from "./finished-branches-on-origin";
import type { GitRunner } from "./own-commits";
import { freshDb } from "./tasks-test-db";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: gitEnv() });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const configure = (cwd: string) => {
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"], ["core.hooksPath", "/dev/null"]]) git(cwd, "config", k, v);
};
const commit = (cwd: string, f: string) => { writeFileSync(join(cwd, f), f); git(cwd, "add", f); git(cwd, "commit", "-qm", f); return git(cwd, "rev-parse", "HEAD"); };

/** Bare origin + the board's clone + a second clone standing for a node or a cloud session. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "fboo-"));
  const origin = join(root, "origin.git"); const work = join(root, "work"); const other = join(root, "other");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: gitEnv() });
  spawnSync("git", ["clone", "-q", origin, work], { env: gitEnv() });
  configure(work);
  git(work, "checkout", "-q", "-b", "main");
  commit(work, "a");
  git(work, "push", "-q", "origin", "main");
  spawnSync("git", ["clone", "-q", origin, other], { env: gitEnv() });
  configure(other);
  return { root, origin, work, other };
}
/** A branch with one commit of its own, pushed; `merge` lands it into main and pushes main too. */
function branch(cwd: string, name: string, opts: { merge?: boolean } = {}) {
  git(cwd, "checkout", "-q", "-b", name, "main");
  const tip = commit(cwd, name.replaceAll("/", "_"));
  git(cwd, "push", "-q", "origin", name);
  git(cwd, "checkout", "-q", "main");
  if (opts.merge) { git(cwd, "merge", "-q", "--no-ff", "-m", `merge ${name}`, name); git(cwd, "push", "-q", "origin", "main"); }
  return tip;
}
const onOrigin = (origin: string) => git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();
const lives = (m: Record<string, BranchLife>) => () => (b: string) => m[b] ?? null;
// Three real repositories and a push per test: with the machine loaded the 30 s
// default ran out in the middle of the setup (22/11, load 3.4 per core).
const REPO_TEST_TIMEOUT_MS = 120_000;

describe("rami di card chiuse su origin", () => {
  test("card chiusa: il ramo dentro main va via senza tag, quello fuori main lascia prima il tag archive/", async () => {
    const { root, origin, work } = setup();
    try {
      branch(work, "topics/landed", { merge: true });
      const abandoned = branch(work, "topics/abandoned");
      git(work, "branch", "-D", "topics/landed", "topics/abandoned");
      const r = await sweepFinishedBranchesOnOrigin(work, lives({ "topics/landed": "finished", "topics/abandoned": "finished" }));
      expect(r?.deleted.sort()).toEqual(["topics/abandoned", "topics/landed"]);
      expect(r?.archived).toEqual({ "topics/abandoned": "archive/topics-abandoned" });
      expect(onOrigin(origin)).toEqual(["main"]);
      expect(git(work, "rev-parse", "archive/topics-abandoned")).toBe(abandoned);
      expect(spawnSync("git", ["-C", work, "rev-parse", "--verify", "-q", "refs/tags/archive/topics-landed"], { env: gitEnv() }).status).not.toBe(0);
      // The archive tag is local: the public origin gets no tag in exchange for the branch.
      expect(git(origin, "tag", "-l")).toBe("");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, REPO_TEST_TIMEOUT_MS);

  test("card aperta, ramo che nessuna card conosce e main restano", async () => {
    const { root, origin, work } = setup();
    try {
      branch(work, "topics/open");
      branch(work, "fix/by-hand");
      const r = await sweepFinishedBranchesOnOrigin(work, lives({ "topics/open": "open", main: "finished" }));
      expect(r).toEqual({ deleted: [], archived: {}, problems: [] });
      expect(onOrigin(origin)).toEqual(["fix/by-hand", "main", "topics/open"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, REPO_TEST_TIMEOUT_MS);

  test("ramo spinto da un'altra macchina: la punta mai vista qui finisce nel tag prima del delete", async () => {
    const { root, origin, work, other } = setup();
    try {
      const tip = branch(other, "claude/card-remote");
      const r = await sweepFinishedBranchesOnOrigin(work, lives({ "claude/card-remote": "finished" }));
      expect(r?.deleted).toEqual(["claude/card-remote"]);
      expect(git(work, "rev-parse", "archive/claude-card-remote")).toBe(tip);
      expect(onOrigin(origin)).toEqual(["main"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, REPO_TEST_TIMEOUT_MS);

  test("nome di tag gia' preso da un altro commit: il tag nuovo porta lo sha, il vecchio resta", async () => {
    const { root, work } = setup();
    try {
      const old = git(work, "rev-parse", "main");
      git(work, "tag", archiveTagFor("topics/reused"), old);
      const tip = branch(work, "topics/reused");
      const r = await sweepFinishedBranchesOnOrigin(work, lives({ "topics/reused": "finished" }));
      expect(r?.archived["topics/reused"]).toBe(`archive/topics-reused-${tip.slice(0, 8)}`);
      expect(git(work, "rev-parse", "archive/topics-reused")).toBe(old);
      expect(r?.deleted).toEqual(["topics/reused"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, REPO_TEST_TIMEOUT_MS);

  test("ramo mosso fra la lettura e il delete: il lease lo tiene, il giro dopo ci riprova", async () => {
    const { root, origin, work, other } = setup();
    try {
      branch(work, "topics/moving", { merge: true });
      git(other, "fetch", "-q", "origin");
      git(other, "checkout", "-q", "-b", "topics/moving", "origin/topics/moving");
      let moved = false;
      const racing: GitRunner = async (cwd, args) => {
        if (args[0] === "push" && !moved) { moved = true; commit(other, "late"); git(other, "push", "-q", "origin", "topics/moving"); }
        return sweepGit(cwd, args);
      };
      const r = await sweepFinishedBranchesOnOrigin(work, lives({ "topics/moving": "finished" }), racing);
      expect(r?.deleted).toEqual([]);
      expect(r?.problems.join()).toContain("topics/moving");
      expect(onOrigin(origin)).toEqual(["main", "topics/moving"]);
      const again = await sweepFinishedBranchesOnOrigin(work, lives({ "topics/moving": "finished" }));
      expect(again?.deleted).toEqual(["topics/moving"]);
      expect(again?.archived["topics/moving"]).toBe("archive/topics-moving");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, REPO_TEST_TIMEOUT_MS);

  test("card riaperta mentre il giro archiviava: il ramo resta, il tag no danno", async () => {
    const { root, origin, work } = setup();
    try {
      branch(work, "topics/reopened");
      let reads = 0;
      const readLives = () => { reads++; return (b: string): BranchLife => (b === "topics/reopened" && reads === 1 ? "finished" : "open"); };
      const r = await sweepFinishedBranchesOnOrigin(work, readLives);
      expect(r?.deleted).toEqual([]);
      expect(r?.problems.join()).toContain("reopened during the pass");
      expect(onOrigin(origin)).toEqual(["main", "topics/reopened"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, REPO_TEST_TIMEOUT_MS);

  test("senza origin non tocca niente", async () => {
    const root = mkdtempSync(join(tmpdir(), "fboo-"));
    try {
      spawnSync("git", ["init", "-q", "-b", "main", root], { env: gitEnv() });
      expect(await sweepFinishedBranchesOnOrigin(root, () => () => "finished")).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, REPO_TEST_TIMEOUT_MS);
});

describe("vita di un ramo letta dal database della board", () => {
  test("done e archiviate chiudono, un land unpushed no, i tentativi contano", () => {
    // The real `tasks` and `task_attempts` DDL, so a renamed column breaks here.
    const db = freshDb();
    const card = (id: string, status: string, extra: Record<string, string | number> = {}) => {
      const cols = { id, project_id: "p", text: id, status, created_at: "2026-11-22", updated_at: "2026-11-22", ...extra };
      db.prepare(`INSERT INTO tasks (${Object.keys(cols).join(",")}) VALUES (${Object.keys(cols).map(() => "?").join(",")})`).run(...Object.values(cols));
    };
    card("landed", "done", { delivery_branch: "topics/landed", past_delivery_branches: "topics/old1 topics/old2" });
    card("archived", "backlog", { archived: 1, prior_branch: "topics/archived" });
    card("unpushed", "done", { delivery_branch: "topics/unpushed", landing_state: "unpushed" });
    card("working", "in_progress", { delivery_branch: "topics/working" });
    db.run(`INSERT INTO task_attempts (id, task_id, idx, branch, state, created_at)
            VALUES ('a1', 'landed', 1, 'topics/loser', 'failed', '2026-11-22'), ('a2', 'working', 1, 'topics/landed', 'running', '2026-11-22')`);
    const lifeOf = readBranchLives(db);
    expect(["topics/old1", "topics/old2", "topics/archived", "topics/loser"].map(lifeOf)).toEqual(["finished", "finished", "finished", "finished"]);
    expect(lifeOf("topics/unpushed")).toBe("open");
    expect(lifeOf("topics/working")).toBe("open");
    // Delivered by a done card, tried again by an open one: the open one wins.
    expect(lifeOf("topics/landed")).toBe("open");
    expect(lifeOf("fix/by-hand")).toBeNull();
  });

  test("sul nodo la copia specchio archiviata non chiude il ramo della card vera", () => {
    const db = freshDb();
    const card = (id: string, cols: Record<string, string | number>) => {
      const all = { id, project_id: "p", text: id, status: "done", archived: 1, created_at: "2026-11-22", updated_at: "2026-11-22", ...cols };
      db.prepare(`INSERT INTO tasks (${Object.keys(all).join(",")}) VALUES (${Object.keys(all).map(() => "?").join(",")})`).run(...Object.values(all));
    };
    // Round 1 mirror, key given back on resend: only base_branch says it is a mirror.
    card("m1", { delivery_branch: "topics/node-wt", base_branch: "topics/carried" });
    // A mirror still holding its key.
    card("m2", { claude_task_id: "node-run:abc", delivery_branch: "topics/node-wt2" });
    const lifeOf = readBranchLives(db);
    expect(lifeOf("topics/carried")).toBe("open");
    expect(lifeOf("topics/node-wt")).toBe("open");
    expect(lifeOf("topics/node-wt2")).toBe("open");
  });
});

describe("vita di un ramo secondo la board", () => {
  test("chiuso solo se TUTTE le card che lo nominano sono chiuse; elenchi separati da spazi", () => {
    const lifeOf = branchLives([
      { finished: true, branches: ["topics/a", null, "topics/old1 topics/shared"] },
      { finished: false, branches: [undefined, "topics/shared"] },
      { finished: true, branches: ["topics/a"] },
    ]);
    expect(lifeOf("topics/a")).toBe("finished");
    expect(lifeOf("topics/old1")).toBe("finished");
    expect(lifeOf("topics/shared")).toBe("open");
    expect(lifeOf("topics/never")).toBeNull();
  });
});
