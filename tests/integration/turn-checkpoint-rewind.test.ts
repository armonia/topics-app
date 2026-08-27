/**
 * THE BAR OF CARD b69a9c07, end to end over the HTTP route.
 *
 * "From a turn that wrote a file, `/rewind` puts the tree back the way it was
 * before that turn, WITHOUT detached HEAD, and says so in chat."
 *
 * The unit tests next to the service (`server/services/turn-checkpoints.test.ts`)
 * measure what git does. This one measures the path the user actually travels:
 * a topic bound to a real repository, a checkpoint taken the way the chat route
 * takes it, a turn that writes and deletes files, then the same POST that
 * `/rewind` issues from the composer - and the three assertions the card names.
 *
 * The two that matter and are easy to get wrong:
 *
 *  - `git symbolic-ref HEAD` STILL RESOLVES TO A BRANCH. The manual rollback
 *    used to run `git checkout <hash>`, which puts the files back and leaves
 *    the repository on no branch at all, silently. Undoing one turn is a small
 *    request; being dropped into detached HEAD is not a small answer.
 *  - THE RESPONSE SAYS THE CONVERSATION DID NOT MOVE. Files coming back and the
 *    chat coming back are two different promises. Topics keeps the first. The
 *    wire carries `conversationRewound: false` so no UI can imply the second by
 *    accident.
 *
 * @covers CHAT-05
 * @covers CMD-06
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import { captureTurnCheckpoint } from "../../server/services/turn-checkpoints";

const ROOT = testTmpDir("turn-checkpoint-rewind");
const REPO = join(ROOT, "repo");

beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

const git = (...a: string[]) => execFileSync("git", a, { cwd: REPO, encoding: "utf8" }).trim();

function seedRepo() {
  mkdirSync(REPO, { recursive: true });
  git("init", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(REPO, "app.ts"), "export const answer = 42\n");
  git("add", "-A");
  git("commit", "-m", "base");
}

type Router = ReturnType<typeof import("../../server/routes/checkpoints").createCheckpointsRouter>;

async function call(router: Router, method: string, path: string, body?: unknown) {
  const url = new URL(`http://h${path}`);
  const req = new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const res = await router(req, url, url.pathname, method);
  if (!res) throw new Error(`no route handled ${method} ${path}`);
  return res;
}

async function banco(): Promise<{ router: Router; topicId: string }> {
  const { createCheckpointsRouter } = await import("../../server/routes/checkpoints");
  const ctx = await createTestAppContext();
  const data = ctx.loadTopics();
  const id = crypto.randomUUID();
  data.topics[id] = {
    id, name: "Rewind", slug: "rewind", parentId: null, links: [],
    sessionKey: "topic:" + id.slice(0, 8),
    color: "#fff", icon: "💬",
    projectPath: REPO,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archived: false,
  };
  ctx.saveTopics(data);
  return { router: createCheckpointsRouter(ctx), topicId: id };
}

describe("/rewind sul checkpoint automatico del turno", () => {
  test("riporta l'albero com'era prima del turno, e HEAD resta su un ramo", async () => {
    seedRepo();
    const { router, topicId } = await banco();
    const data = (await createTestAppContext()).loadTopics();
    const sessionKey = data.topics[topicId].sessionKey;

    // BEFORE THE TURN: the checkpoint the chat route takes on its own.
    const ckpt = await captureTurnCheckpoint(REPO, sessionKey, "aggiungi la feature");
    expect(ckpt, "il checkpoint di partenza deve esistere").not.toBeNull();

    // THE TURN: the agent edits a file, creates a new one, deletes another.
    writeFileSync(join(REPO, "app.ts"), "export const answer = 'rotto'\n");
    mkdirSync(join(REPO, "src"), { recursive: true });
    writeFileSync(join(REPO, "src", "nato-nel-turno.ts"), "export const x = 1\n");

    // The automatic strip sees it.
    const list = (await (await call(router, "GET", `/api/topics/${topicId}/turn-checkpoints`)).json()) as {
      checkpoints: Array<{ commit: string; label: string }>;
    };
    expect(list.checkpoints.length).toBe(1);
    expect(list.checkpoints[0].label).toBe("aggiungi la feature");

    // `/rewind`: the same POST the composer sends.
    const res = await call(router, "POST", `/api/topics/${topicId}/turn-checkpoints/restore`, {});
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      ok: boolean; restored: number; removed: number; branch: string | null; conversationRewound: boolean;
    };

    // 1. The file content goes back.
    expect(readFileSync(join(REPO, "app.ts"), "utf8")).toBe("export const answer = 42\n");
    // 2. The file BORN in the turn goes away: the tree as it was includes births.
    expect(existsSync(join(REPO, "src", "nato-nel-turno.ts"))).toBe(false);
    expect(out.removed).toBe(1);
    // 3. No detached HEAD. `symbolic-ref` fails on a detached head,
    //    so this is the assertion that would catch a return to `checkout`.
    expect(git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(out.branch).toBe("main");
    // 4. And it says so: the files came back, the conversation did not.
    expect(out.conversationRewound).toBe(false);
  });

  test("senza checkpoint la rotta risponde 404, non un successo vuoto", async () => {
    const { router, topicId } = await banco();
    const res = await call(router, "POST", `/api/topics/${topicId}/turn-checkpoints/restore`, {});
    expect(res.status).toBe(404);
  });
});
