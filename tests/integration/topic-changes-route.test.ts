/**
 * `GET /api/topics/:id/changes` against a REAL repository.
 *
 * The unit test pins the aggregator; what it cannot pin is the half that
 * matters to the person reading the panel: the line counts and the kinds come
 * from git, and they must describe THIS topic. So this file builds a throwaway
 * repo with a committed file, has a fake conversation write two new files and
 * edit the committed one, and then asks the route.
 *
 * The regression it guards is the one that makes the panel a lie: dirt that
 * belongs to somebody else. A file changed in the repo but never named by the
 * conversation must NOT appear, which is exactly what a plain `git status`
 * would have shown.
 *
 * @covers CHAT-CHANGES-01
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StoredMessage } from "../../server/types";
import type { TopicChanges } from "../../shared/topic-changes";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";

const ROOT = testTmpDir("topic-changes");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A repo with one committed file, and nothing else. */
function makeRepo(label: string): string {
  const dir = join(ROOT, label);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "base.ts"), "one\ntwo\nthree\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  // The real path, not the one we built: on macOS `/tmp` is a symlink to
  // `/private/tmp`, the PATCH canonicalizes what it stores, and a path that
  // disagrees with the topic's own would make every relative path wrong.
  return realpathSync(dir);
}

type Router = ReturnType<typeof import("../../server/routes/topics").createTopicsRouter>;

async function call(router: Router, method: string, path: string, body?: unknown): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const req = new Request(url, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const res = await router(req, url, url.pathname, method);
  if (!res) throw new Error(`no route handled ${method} ${path}`);
  return res;
}

describe("GET /api/topics/:id/changes", () => {
  test("two writes and one edit: kinds and line counts come out of git", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);
    const repo = makeRepo(`repo-${Date.now()}`);

    const created = await call(router, "POST", "/api/topics", { name: `changes-${Date.now()}` });
    const { id } = (await created.json()) as { id: string };
    await call(router, "PATCH", `/api/topics/${id}`, { projectPath: repo });
    const topic = ctx.getTopicById(id);
    expect(topic?.projectPath).toBe(repo);

    // What the turn did on disk...
    writeFileSync(join(repo, "new-a.ts"), "alpha\nbeta\n");
    writeFileSync(join(repo, "new-b.ts"), "gamma\n");
    writeFileSync(join(repo, "base.ts"), "one\ntwo\nthree\nfour\n");
    // ...and a file the conversation never named: somebody else's dirt.
    writeFileSync(join(repo, "stranger.ts"), "not mine\n");

    // ...and what the transcript says about it.
    const message: StoredMessage = {
      id: `m-${Date.now()}`,
      role: "assistant",
      content: "done",
      timestamp: new Date().toISOString(),
      toolCalls: [
        { id: "t1", name: "Write", args: {}, detail: { type: "write", filePath: join(repo, "new-a.ts") } },
        { id: "t2", name: "Write", args: {}, detail: { type: "write", filePath: join(repo, "new-b.ts") } },
        { id: "t3", name: "Edit", args: {}, detail: { type: "edit", filePath: join(repo, "base.ts") } },
      ],
    };
    ctx.appendImportedMessages(topic!.sessionKey, [message]);

    const res = await call(router, "GET", `/api/topics/${id}/changes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TopicChanges;

    expect(body.git?.branch).toBe("main");
    expect(body.files.map((f) => f.path).sort()).toEqual(["base.ts", "new-a.ts", "new-b.ts"]);
    const byPath = Object.fromEntries(body.files.map((f) => [f.path, f]));
    expect(byPath["new-a.ts"]).toMatchObject({ kind: "created", added: 2, removed: 0, turns: 1 });
    expect(byPath["new-b.ts"]).toMatchObject({ kind: "created", added: 1, removed: 0 });
    expect(byPath["base.ts"]).toMatchObject({ kind: "modified", added: 1, removed: 0 });
    expect(body.git?.dirty).toBe(3);
  });

  test("a topic that wrote nothing has nothing to show", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);

    const created = await call(router, "POST", "/api/topics", { name: `quiet-${Date.now()}` });
    const { id } = (await created.json()) as { id: string };
    const res = await call(router, "GET", `/api/topics/${id}/changes`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [], git: null });
  });

  test("an unknown topic is a 404, not an empty panel", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);
    const res = await call(router, "GET", "/api/topics/nope-does-not-exist/changes");
    expect(res.status).toBe(404);
  });
});
