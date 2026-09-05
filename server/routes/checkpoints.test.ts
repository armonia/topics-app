/**
 * The checkpoint routes against a REAL repository with a second pair of
 * hands in it.
 *
 * THE DEFECT THIS FILE HOLDS SHUT. The manual rollback used to stash every
 * uncommitted change in the folder and run `git restore --source <HEAD at
 * save time> -- .`: it stashed whoever else was working there and rewrote
 * every path from a commit that could be hours older than the checkpoint.
 * Now a rollback is a PLAN over the paths this session changed since the
 * checkpoint's own tree, refused outright while a turn is still writing, and
 * a checkpoint saved before trees existed rolls back the conversation only.
 *
 * Real git and a real SQLite: the claims are about what survives on disk and
 * in the message tree, and a fake would only restate the author's belief.
 *
 * @covers CHAT-05
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpointsRouter } from "./checkpoints";
import { captureTurnCheckpoint } from "../services/turn-checkpoints";
import type { Checkpoint } from "../../shared/types";

const SESSION = "topic:aaaaaaaa";
const TOPIC = "t1";
const FOLDERLESS = "t2";

let repo: string;
let stateDir: string;
let db: Database;
let activeStreams: Map<string, unknown>;
let router: ReturnType<typeof createCheckpointsRouter>;

const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
const read = (name: string) => readFileSync(join(repo, name), "utf8");
const write = (name: string, content: string) => writeFileSync(join(repo, name), content);

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const pp = pattern.split("/"); const xs = pathname.split("/");
  if (pp.length !== xs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i]!.startsWith(":")) params[pp[i]!.slice(1)] = xs[i]!;
    else if (pp[i] !== xs[i]) return null;
  }
  return params;
}

async function call(method: string, path: string, body?: unknown) {
  const req = new Request(`http://x${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
  const res = await router(req, new URL(req.url), path, method);
  return { status: res?.status ?? 0, body: res ? await res.json() : null };
}

let order = 0;
const lastIdOf = new Map<string, string>();
/** Messages are a TREE (`server/db/message-tree.ts`): each one hangs off the
 *  previous one of its session, which is what the truncation walks. */
function message(id: string, session = SESSION) {
  db.prepare(
    `INSERT INTO messages (id, session_key, role, content, timestamp, sort_order, parent_id, branch_index)
     VALUES (?, ?, 'user', ?, ?, ?, ?, 0)`,
  ).run(id, session, id, new Date().toISOString(), order++, lastIdOf.get(session) ?? null);
  lastIdOf.set(session, id);
}
const messageIds = (session = SESSION): string[] =>
  (db.prepare(`SELECT id FROM messages WHERE session_key = ? ORDER BY sort_order`).all(session) as { id: string }[])
    .map((r) => r.id);

function loadLocalMessages(session: string) {
  return (db.prepare(`SELECT id, role, content, timestamp FROM messages WHERE session_key = ? ORDER BY sort_order`)
    .all(session) as Array<{ id: string; role: "user"; content: string; timestamp: string }>);
}

const savedCheckpoints = (): Checkpoint[] => JSON.parse(readFileSync(join(stateDir, "checkpoints", `${TOPIC}.json`), "utf8"));
function writeCheckpoints(list: Checkpoint[], topic = TOPIC) {
  mkdirSync(join(stateDir, "checkpoints"), { recursive: true });
  writeFileSync(join(stateDir, "checkpoints", `${topic}.json`), JSON.stringify(list));
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "topics-ckpt-route-"));
  stateDir = mkdtempSync(join(tmpdir(), "topics-ckpt-state-"));
  git("init", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  write("a.txt", "a before\n");
  write("b.txt", "b before\n");
  git("add", "-A");
  git("commit", "-m", "one");

  db = new Database(":memory:");
  db.run(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_key TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
      timestamp TEXT, sort_order INTEGER, parent_id TEXT REFERENCES messages(id), branch_index INTEGER DEFAULT 0
    );
    CREATE TABLE active_branches (
      parent_id TEXT NOT NULL, session_key TEXT NOT NULL, active_branch_index INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (parent_id, session_key)
    );
    CREATE TABLE compaction_markers (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, after_message_id TEXT);
  `);
  db.run("PRAGMA foreign_keys = ON");
  order = 0;
  lastIdOf.clear();
  for (const id of ["m1", "m2", "m3", "m4"]) message(id);

  activeStreams = new Map();
  const ctx = {
    db,
    STATE_DIR: stateDir,
    activeStreams,
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    matchRoute,
    loadTopics: () => ({
      topics: {
        [TOPIC]: { id: TOPIC, sessionKey: SESSION, projectPath: repo },
        [FOLDERLESS]: { id: FOLDERLESS, sessionKey: "topic:bbbbbbbb" },
      },
    }),
    loadLocalMessages,
  };
  router = createCheckpointsRouter(ctx as never);
});
afterEach(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

/** Save a manual checkpoint through the route, at the current message count. */
async function saveCheckpoint(description: string): Promise<Checkpoint> {
  const r = await call("POST", `/api/topics/${TOPIC}/checkpoints`, { description });
  expect(r.status).toBe(200);
  return r.body.checkpoint;
}

/** What the chat route does at the end of a turn that wrote: the `after` mark. */
const closeTurn = () => captureTurnCheckpoint(repo, SESSION, "the turn", "after");

describe("saving a manual checkpoint", () => {
  test("records HEAD as before AND a snapshot of the worktree", async () => {
    write("a.txt", "a edited by hand, not committed\n");
    const cp = await saveCheckpoint("before the risky turn");
    expect(cp.gitHash).toBe(git("rev-parse", "HEAD"));
    expect(cp.gitBranch).toBe("main");
    expect(cp.treeCommit).toBeDefined();
    expect(cp.treeCommit).not.toBe(cp.gitHash);
    // The tree is the WORKTREE, uncommitted edit included: that is what a
    // rollback from HEAD could never have given back.
    expect(git("show", `${cp.treeCommit}:a.txt`)).toBe("a edited by hand, not committed");
    expect(git("symbolic-ref", "HEAD"), "no branch moved").toBe("refs/heads/main");
  });
});

describe("the plan preflight of a manual checkpoint", () => {
  test("answers 200 with safe:false and canProceed:false while a turn is running", async () => {
    const cp = await saveCheckpoint("cp");
    activeStreams.set(SESSION, {});
    const r = await call("POST", `/api/topics/${TOPIC}/checkpoints/${cp.idx}/plan`, {});
    expect(r.status).toBe(200);
    expect(r.body.plan.safe).toBe(false);
    expect(r.body.plan.blockers.map((b: { code: string }) => b.code)).toEqual(["turn-in-progress"]);
    expect(r.body.canProceed).toBe(false);
    expect(r.body.blockedBy).toBe("turn-in-progress");
    expect(r.body.filesRestorable).toBe(false);
    expect(r.body.checkpoint.idx).toBe(cp.idx);
  });

  test("a legacy checkpoint: canProceed, files not restorable, blocker named", async () => {
    const cp = await saveCheckpoint("cp");
    delete cp.treeCommit;
    writeCheckpoints([cp]);
    const r = await call("POST", `/api/topics/${TOPIC}/checkpoints/0/plan`, {});
    expect(r.status).toBe(200);
    expect(r.body.canProceed).toBe(true);
    expect(r.body.filesRestorable).toBe(false);
    expect(r.body.blockedBy).toBe("legacy-checkpoint");
  });

  test("a topic without a folder: the same, with not-a-repo", async () => {
    writeCheckpoints([{ idx: 0, messageCount: 1, timestamp: "2026-09-05T00:00:00Z", description: "cp" }], FOLDERLESS);
    const r = await call("POST", `/api/topics/${FOLDERLESS}/checkpoints/0/plan`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ canProceed: true, filesRestorable: false, blockedBy: "not-a-repo" });
  });
});

describe("rolling back a manual checkpoint", () => {
  test("a refused plan is a 409 carrying the plan, and touches nothing", async () => {
    const cp = await saveCheckpoint("cp");
    write("a.txt", "a by the turn\n");
    activeStreams.set(SESSION, {});

    const r = await call("POST", `/api/topics/${TOPIC}/checkpoints/${cp.idx}/rollback`);

    expect(r.status).toBe(409);
    expect(r.body.error).toBe("Restore refused");
    expect(r.body.plan.blockers[0].code).toBe("turn-in-progress");
    expect(r.body.canProceed).toBe(false);
    expect(read("a.txt"), "the file the turn is still writing is untouched").toBe("a by the turn\n");
    expect(messageIds(), "the conversation is not truncated on a refusal").toEqual(["m1", "m2", "m3", "m4"]);
    expect(savedCheckpoints().length).toBe(1);
  });

  test("restores only the paths of the turn; the bystander's edit and file survive", async () => {
    // Two messages in, the user saves. Then the turn writes, the turn ends,
    // and somebody else edits a file the turn never touched.
    writeCheckpoints([]);
    const cp = await saveCheckpoint("before the turn");
    expect(cp.messageCount).toBe(4);
    message("m5");
    message("m6");
    write("a.txt", "a by the turn\n");
    write("new.ts", "export const x = 1\n");
    await closeTurn();
    write("b.txt", "b by hand, after the turn\n");
    write("theirs.md", "created by hand\n");

    const r = await call("POST", `/api/topics/${TOPIC}/checkpoints/${cp.idx}/rollback`);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.filesRestorable).toBe(true);
    expect(r.body.files).toMatchObject({ restored: 1, removed: 1, branch: "main", skipped: [] });
    expect(read("a.txt"), "the turn's edit goes back").toBe("a before\n");
    expect(existsSync(join(repo, "new.ts")), "the file the turn created goes").toBe(false);
    expect(read("b.txt"), "the bystander's edit survives").toBe("b by hand, after the turn\n");
    expect(existsSync(join(repo, "theirs.md")), "the bystander's file survives").toBe(true);
    expect(git("stash", "list"), "nothing was stashed").toBe("");
    expect(git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(messageIds(), "the conversation is cut to the checkpoint").toEqual(["m1", "m2", "m3", "m4"]);
    expect(r.body.messageCount).toBe(4);
  });

  test("a path the turn changed and somebody else changed again is skipped and named", async () => {
    const cp = await saveCheckpoint("cp");
    write("a.txt", "a by the turn\n");
    write("b.txt", "b by the turn\n");
    await closeTurn();
    write("b.txt", "b by hand, on top of the turn\n");

    const r = await call("POST", `/api/topics/${TOPIC}/checkpoints/${cp.idx}/rollback`);

    expect(r.status).toBe(200);
    expect(read("a.txt")).toBe("a before\n");
    expect(read("b.txt"), "the contested path is left alone").toBe("b by hand, on top of the turn\n");
    expect(r.body.files.skipped).toEqual([{ path: "b.txt", state: "modified", reason: "changed-after-checkpoint" }]);
    expect(r.body.plan.skipped.length).toBe(1);
  });

  test("a legacy checkpoint truncates the conversation and touches no file", async () => {
    // Saved before trees existed: no `treeCommit`, only a `gitHash` that the
    // old code would have restored the whole tree from.
    writeCheckpoints([{
      idx: 0, messageCount: 2, timestamp: "2026-09-05T00:00:00Z", description: "old",
      gitHash: git("rev-parse", "HEAD"), gitBranch: "main",
    }]);
    write("a.txt", "a edited since, by anybody\n");
    write("new.ts", "created since\n");

    const r = await call("POST", `/api/topics/${TOPIC}/checkpoints/0/rollback`);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.filesRestorable).toBe(false);
    expect(r.body.blockedBy).toBe("legacy-checkpoint");
    expect(r.body.files).toBeNull();
    expect(messageIds(), "the conversation half still happens").toEqual(["m1", "m2"]);
    expect(read("a.txt"), "the old whole-tree restore would have rewritten this").toBe("a edited since, by anybody\n");
    expect(existsSync(join(repo, "new.ts")), "and deleted this").toBe(true);
    expect(git("stash", "list")).toBe("");
  });

  test("a topic without a folder rolls the conversation back, as it always did", async () => {
    for (const id of ["x1", "x2", "x3"]) message(id, "topic:bbbbbbbb");
    writeCheckpoints([{ idx: 0, messageCount: 1, timestamp: "2026-09-05T00:00:00Z", description: "cp" }], FOLDERLESS);
    const r = await call("POST", `/api/topics/${FOLDERLESS}/checkpoints/0/rollback`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, canProceed: true, filesRestorable: false, blockedBy: "not-a-repo", files: null });
    expect(messageIds("topic:bbbbbbbb")).toEqual(["x1"]);
  });
});

describe("the automatic turn checkpoints", () => {
  test("the list offers restore points only: the end-of-turn mark is not one", async () => {
    await captureTurnCheckpoint(repo, SESSION, "before", "before");
    write("a.txt", "a by the turn\n");
    await closeTurn();
    const r = await call("GET", `/api/topics/${TOPIC}/turn-checkpoints`);
    expect(r.status).toBe(200);
    expect(r.body.checkpoints.map((c: { kind: string }) => c.kind)).toEqual(["before"]);
  });

  test("the preflight answers 200 with no-checkpoint when the session has none", async () => {
    const r = await call("POST", `/api/topics/${TOPIC}/turn-checkpoints/plan`, {});
    expect(r.status).toBe(200);
    expect(r.body.checkpoint).toBeNull();
    expect(r.body.plan.safe).toBe(false);
    expect(r.body).toMatchObject({ canProceed: false, blockedBy: "no-checkpoint", filesRestorable: false });
  });

  test("the preflight of a running turn is refused; the restore answers 409 with the plan", async () => {
    await captureTurnCheckpoint(repo, SESSION, "before", "before");
    write("a.txt", "a by the turn\n");
    activeStreams.set(SESSION, {});

    const plan = await call("POST", `/api/topics/${TOPIC}/turn-checkpoints/plan`, {});
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ canProceed: false, blockedBy: "turn-in-progress" });

    const r = await call("POST", `/api/topics/${TOPIC}/turn-checkpoints/restore`, {});
    expect(r.status).toBe(409);
    expect(r.body.plan.blockers[0].code).toBe("turn-in-progress");
    expect(read("a.txt")).toBe("a by the turn\n");
  });

  test("a safe restore applies the plan and returns it with the outcome", async () => {
    const before = await captureTurnCheckpoint(repo, SESSION, "before", "before");
    write("a.txt", "a by the turn\n");
    write("b.txt", "b by the turn\n");
    await closeTurn();
    write("b.txt", "b by hand\n");

    const r = await call("POST", `/api/topics/${TOPIC}/turn-checkpoints/restore`, {});

    expect(r.status).toBe(200);
    expect(r.body.checkpoint.commit).toBe(before!.commit);
    expect(r.body).toMatchObject({ ok: true, restored: 1, removed: 0, conversationRewound: false, filesRestorable: true });
    expect(r.body.skipped).toEqual([{ path: "b.txt", state: "modified", reason: "changed-after-checkpoint" }]);
    expect(r.body.plan.entries).toEqual([{ path: "a.txt", state: "modified" }]);
    expect(read("a.txt")).toBe("a before\n");
    expect(read("b.txt")).toBe("b by hand\n");
  });
});
