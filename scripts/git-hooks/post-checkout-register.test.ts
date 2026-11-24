/**
 * The optional `post-checkout` git hook: a bare `git worktree add` registers the
 * new worktree with Topics, and nothing else does. Real git, a test hooksPath
 * and an in-process fake of the registration door; the hook never blocks git.
 *
 * @covers WORKTREE-STD-14, WORKTREE-STD-16
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const HOOK = join(import.meta.dir, "post-checkout-register");
const LIB = join(import.meta.dir, "..", "claude-hooks", "worktree-hook.sh");
const TOKEN = "t".repeat(32);

let base = "";
let repo = "";
let hooksDir = "";
let home = "";
let seen: Array<{ path: string; body: Record<string, unknown> }> = [];
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "post-checkout-register-")));
  repo = join(base, "repo");
  hooksDir = join(base, "hooks");
  home = join(base, "home");
  mkdirSync(hooksDir);
  copyFileSync(HOOK, join(hooksDir, "post-checkout"));
  chmodSync(join(hooksDir, "post-checkout"), 0o755);
  mkdirSync(join(home, "claude-hooks"), { recursive: true });
  writeFileSync(join(home, "claude-hooks", "hook-token"), TOKEN);
  expect((await git(base, "init", "-q", "-b", "main", "repo")).code).toBe(0);
  expect((await git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")).code).toBe(0);
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("no", { status: 401 });
      const url = new URL(req.url);
      seen.push({ path: url.pathname, body: req.method === "POST" ? await req.json() : {} });
      return Response.json({ id: "w1", class: "tracked", inRoot: false, created: true });
    },
  });
});
afterAll(() => {
  server?.stop(true);
  rmSync(base, { recursive: true, force: true });
});
afterEach(() => { seen = []; });

/** git with the test hooksPath, async: the fake server lives in this process and must keep answering. */
async function git(cwd: string, ...args: string[]): Promise<{ code: number; err: string }> {
  return gitWith({}, cwd, ...args);
}
async function gitWith(extra: Record<string, string>, cwd: string, ...args: string[]): Promise<{ code: number; err: string }> {
  const p = Bun.spawn(["git", "-C", cwd, "-c", `core.hooksPath=${hooksDir}`, ...args], {
    env: gitEnv({ TOPICS_HOME: home, TOPICS_WORKTREE_LIB: LIB, TOPICS_APP_URL: `http://127.0.0.1:${server?.port ?? 9}`, ...extra }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await p.exited;
  return { code, err: await new Response(p.stderr).text() };
}

describe("post-checkout-register", () => {
  test("a bare `git worktree add` registers the new worktree, once", async () => {
    const wt = join(base, "bare-add");
    expect((await git(repo, "worktree", "add", "-q", "-b", "bare-add", wt)).code).toBe(0);
    const regs = seen.filter((s) => s.path === "/api/worktrees/register");
    expect(regs).toHaveLength(1);
    expect(regs[0]!.body).toMatchObject({ path: realpathSync(wt), creator: "adopted", branch: "bare-add" });
  });

  test("an ordinary checkout and a main clone register nothing", async () => {
    expect((await git(repo, "checkout", "-q", "-b", "side")).code).toBe(0);
    expect((await git(base, "clone", "-q", repo, join(base, "clone"))).code).toBe(0);
    expect(seen).toHaveLength(0);
  });

  test("the worktree hook's own `git worktree add` is skipped (it registers with its real creator)", async () => {
    const wt = join(base, "skipped");
    expect((await gitWith({ TOPICS_WORKTREE_REGISTER: "skip" }, repo, "worktree", "add", "-q", "-b", "skipped", wt)).code).toBe(0);
    expect(seen).toHaveLength(0);
  });

  test("Topics down: git still succeeds and the worktree is there", async () => {
    const wt = join(base, "server-down");
    const r = await gitWith({ TOPICS_APP_URL: "http://127.0.0.1:9" }, repo, "worktree", "add", "-q", "-b", "server-down", wt);
    expect(r.code).toBe(0);
    expect(existsSync(join(wt, ".git"))).toBe(true);
    expect(seen).toHaveLength(0);
    // Outside the root nothing is marked: the folder is not Topics' to clean.
    expect(existsSync(join(await adminDir(wt), "topics-owner"))).toBe(false);
  });

  test("Topics down, a worktree added inside the root still gets Topics' proof: ledger entry and owner marker", async () => {
    const root = join(home, "worktrees");
    const wt = join(root, "repo", "in-root");
    mkdirSync(join(root, "repo"), { recursive: true });
    const r = await gitWith({ TOPICS_APP_URL: "http://127.0.0.1:9" }, repo, "worktree", "add", "-q", "-b", "in-root", wt);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, ".topics-owned", "repo", "in-root"), "utf8")).creator).toBe("adopted");
    expect(existsSync(join(root, ".topics-worktree-root"))).toBe(true);
    expect(JSON.parse(readFileSync(join(await adminDir(wt), "topics-owner"), "utf8")).creator).toBe("adopted");
  });
});

async function adminDir(wt: string): Promise<string> {
  const p = Bun.spawn(["git", "-C", wt, "rev-parse", "--path-format=absolute", "--git-dir"], { env: gitEnv({}), stdout: "pipe" });
  await p.exited;
  return (await new Response(p.stdout).text()).trim();
}
