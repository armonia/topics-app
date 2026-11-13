/**
 * ADOPTING A CLAUDE CODE SESSION THAT WORKS IN A LINKED WORKTREE.
 * @covers EXTSESS-04
 *
 * The sessions Attilio moved from Claude Desktop into Topics on 13/11 had three
 * shapes the route did not handle:
 *  - the turn after the adoption went to Topics' own engine (switch ON by
 *    default in a chat), which reads the imported rows as a recap and never
 *    runs `claude --resume`: the CLI's memory stayed behind;
 *  - a session in `<repo>/.claude/worktrees/x` became a project of its own
 *    (`projectPath` = the worktree), outside the repository's board;
 *  - model and effort fell back to the defaults.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { claudeProjectDirName } from "../lib/claude-transcript-path";
import { createTopicsRouter } from "./topics";
import { gitEnv } from "../../tests/setup/bun-test-preload";

/**
 * The route finds a transcript under `homedir()`, and Bun's `homedir()` reads
 * HOME once at start: changing `process.env.HOME` here would not move it. So
 * the file runs itself again in a child whose HOME is a temporary folder, and
 * the parent only reports the child's verdict. Never the real `~/.claude`.
 */
const FAKE_HOME_MARK = "adopt-claude-home-";
const inFakeHome = homedir().includes(FAKE_HOME_MARK);

if (!inFakeHome) {
  test("adopt-claude suite (in a child with a temporary HOME)", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), FAKE_HOME_MARK)));
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home };
    delete env.DATA_DIR;
    const out = Bun.spawnSync(["bun", "test", import.meta.path], { env, stdout: "pipe", stderr: "pipe" });
    const log = out.stdout.toString() + out.stderr.toString();
    if (out.exitCode !== 0) console.error(log);
    expect(out.exitCode).toBe(0);
    expect(log).toMatch(/\b5 pass\b/);
  }, 120_000);
}

const ROOT = testTmpDir("topics-adopt-worktree");
let HOME = "";
let REPO = "";
let WT = "";

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", env: gitEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** The transcript a CLI leaves after one turn, filed under its cwd. */
function seedTranscript(cwd: string, sessionId: string, opts: { model?: string; branch?: string } = {}) {
  const dir = join(HOME, ".claude", "projects", claudeProjectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const base = { cwd, sessionId, gitBranch: opts.branch ?? "main", entrypoint: "claude-desktop", permissionMode: "bypassPermissions" };
  const lines = [
    { ...base, type: "user", uuid: "u1", timestamp: "2026-11-13T01:00:00Z", message: { role: "user", content: "domanda" } },
    { ...base, type: "assistant", uuid: "a1", timestamp: "2026-11-13T01:00:01Z", message: { role: "assistant", model: opts.model ?? "claude-sonnet-5-5", content: [{ type: "text", text: "risposta" }] } },
  ];
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

beforeAll(() => {
  if (!inFakeHome) return;
  setupTestDataDir(`${ROOT}/data`);
  HOME = homedir();
  REPO = join(ROOT, "repo");
  mkdirSync(REPO, { recursive: true });
  REPO = realpathSync(REPO);
  git(REPO, "init", "-q", "-b", "main");
  git(REPO, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  WT = join(REPO, ".claude", "worktrees", "specflow-npm-abc");
  git(REPO, "worktree", "add", "-q", "-b", "claude/specflow-npm-abc", WT);
});

afterAll(async () => {
  if (!inFakeHome) return;
  await cleanupTestDataDir(ROOT);
});

async function adopt(body: Record<string, unknown>) {
  const ctx = await createTestAppContext();
  const router = createTopicsRouter(ctx);
  const url = new URL("http://t.test/api/topics/adopt-claude");
  const res = await router(new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), url, url.pathname, "POST");
  return { ctx, status: res!.status, body: (await res!.json()) as any };
}

describe.if(inFakeHome)("POST /api/topics/adopt-claude", () => {
  test("the adopted chat runs on the CLI (resume), not on the engine", async () => {
    const sid = "11111111-1111-4111-8111-111111111111";
    seedTranscript(REPO, sid);
    const { ctx, status, body } = await adopt({ sessionId: sid });
    expect(status).toBe(201);
    expect(body.provider).toBe("claude-code");
    expect(body.topicsRouting).toBe(false);
    expect(ctx.getTopicById(body.id)?.topicsRouting).toBe(false);
    const row = ctx.db.query("SELECT claude_session_id AS id FROM claude_code_sessions WHERE session_key = ?").get(body.sessionKey) as { id: string };
    expect(row.id).toBe(sid);
  });

  test("model from the transcript, effort and model from the caller win", async () => {
    const sid = "22222222-2222-4222-8222-222222222222";
    seedTranscript(REPO, sid, { model: "claude-opus-5-5" });
    const fromTranscript = await adopt({ sessionId: sid });
    expect(fromTranscript.body.model).toBe("claude-opus-5-5");
    expect(fromTranscript.body.effort ?? null).toBeNull();

    const sid2 = "33333333-3333-4333-8333-333333333333";
    seedTranscript(REPO, sid2, { model: "claude-opus-5-5" });
    const fromCaller = await adopt({ sessionId: sid2, model: "claude-fable-5-2", effort: "Max" });
    expect(fromCaller.body.model).toBe("claude-fable-5-2");
    expect(fromCaller.body.effort).toBe("max");

    const sid3 = "44444444-4444-4444-8444-444444444444";
    seedTranscript(REPO, sid3);
    const bad = await adopt({ sessionId: sid3, effort: "turbo" });
    expect(bad.status).toBe(201);
    expect(bad.body.effort ?? null).toBeNull();
  });

  test("a session in a linked worktree belongs to the repository and works in the worktree", async () => {
    const ctx0 = await createTestAppContext();
    ctx0.projectStore.create({ name: "repo", slug: "repo", path: REPO });
    const sid = "55555555-5555-4555-8555-555555555555";
    seedTranscript(WT, sid, { branch: "claude/specflow-npm-abc" });
    const { ctx, status, body } = await adopt({ sessionId: sid });
    expect(status).toBe(201);
    expect(body.projectPath).toBe(REPO);
    expect(body.worktreePath).toBe(WT);
    const wt = ctx.worktreeStore.get(body.worktreeId);
    expect(wt?.absPath).toBe(WT);
    expect(wt?.mode).toBe("reuse");
    expect(wt?.status).toBe("ready");
    expect(wt?.branchName).toBe("claude/specflow-npm-abc");
    // The CLI spawns where the worktree is.
    expect(ctx.resolveTopicCwd(ctx.getTopicById(body.id))).toBe(WT);

    // A second session in the same folder reuses the row.
    const sid2 = "66666666-6666-4666-8666-666666666666";
    seedTranscript(WT, sid2, { branch: "claude/specflow-npm-abc" });
    const again = await adopt({ sessionId: sid2 });
    expect(again.body.worktreeId).toBe(body.worktreeId);
  });

  test("a worktree of a repo Topics does not know is adopted as before: the worktree folder is the project", async () => {
    const other = join(ROOT, "other");
    mkdirSync(other, { recursive: true });
    const otherReal = realpathSync(other);
    git(otherReal, "init", "-q", "-b", "main");
    git(otherReal, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const wt = join(otherReal, "wt-x");
    git(otherReal, "worktree", "add", "-q", "-b", "x", wt);
    const sid = "77777777-7777-4777-8777-777777777777";
    seedTranscript(wt, sid);
    const { ctx, status, body } = await adopt({ sessionId: sid });
    expect(status).toBe(201);
    expect(body.projectPath).toBe(wt);
    expect(body.worktreeId ?? null).toBeNull();
    expect(body.worktreePath).toBeNull();
    expect(ctx.worktreeStore.getByAbsPath(wt)).toBeNull();
    expect(ctx.resolveTopicCwd(ctx.getTopicById(body.id))).toBe(wt);
  });

  test("a worktree under Topics' own worktree root never becomes an adopted row", async () => {
    // The delete and the sweep spare an adopted folder because it is OUTSIDE
    // that root: a row inside it would read as Topics' own and be removed.
    const ctx0 = await createTestAppContext();
    if (!ctx0.projectStore.getByPath(REPO)) ctx0.projectStore.create({ name: "repo", slug: "repo", path: REPO });
    // A folder of its own: the one above already has its row.
    const root = join(REPO, ".topics-root");
    const nested = join(root, "repo", "inside");
    git(REPO, "worktree", "add", "-q", "-b", "claude/inside", nested);
    const orig = process.env.TOPICS_WORKTREES_DIR;
    process.env.TOPICS_WORKTREES_DIR = root;
    try {
      const sid = "88888888-8888-4888-8888-888888888888";
      seedTranscript(nested, sid, { branch: "claude/inside" });
      const { ctx, status, body } = await adopt({ sessionId: sid });
      expect(status).toBe(201);
      expect(body.worktreeId ?? null).toBeNull();
      expect(body.projectPath).toBe(nested);
      expect(ctx.worktreeStore.getByAbsPath(nested)).toBeNull();
    } finally {
      if (orig === undefined) delete process.env.TOPICS_WORKTREES_DIR; else process.env.TOPICS_WORKTREES_DIR = orig;
    }
  });
});
