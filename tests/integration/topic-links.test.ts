/**
 * Topic-to-topic links: both routes, against a real SQLite.
 *
 * Why this file exists. `POST /api/topics/:id/link` and
 * `DELETE /api/topics/:id/link/:targetId` are the whole "linked topics"
 * feature, and on 2026-08-25 an audit of the 310 HTTP routes found that
 * **neither of them is named by any test** — not directly, not through the UI.
 * The feature could stop working entirely and every gate would stay green.
 *
 * What is pinned here is the property the route's own comment claims and that
 * nothing was checking: the link is SYMMETRIC and written ATOMICALLY. Both
 * sides go in one `db.transaction`, precisely so a crash in the middle cannot
 * leave A->B without B->A. A half-link is the failure that hurts, because it is
 * silent: the topic you opened shows the connection, the other one does not,
 * and which of the two is right depends on which one you opened.
 *
 * The removal side has an asymmetry worth pinning too: DELETE tolerates a
 * target that no longer exists (the topic was deleted meanwhile) and still
 * cleans the surviving side. That is deliberate - refusing would leave a
 * dangling id nobody can ever remove.
 *
 * Note on traceability: this behaviour has NO requirement in
 * `openspec/specs/topics/` - TOPIC-01 is CRUD/lifecycle and TOPIC-02 is search
 * and reorder. So there is deliberately no `@covers` line here: claiming one
 * would be a dangling claim, which `check:spec-coverage` reports as R1. The
 * honest state is "tested surface, undeclared requirement".
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";

/**
 * Hermetic by construction. The first version of this file did NOT do this and
 * ran against `data/topics.db` — the PRODUCTION database — creating 24 topics
 * in it. `createTestAppContext()` reads `process.env.DATA_DIR` and falls back
 * to the repo root, so forgetting this block is silent: the tests pass, and
 * they pass against the user's live data.
 */
const ROOT = testTmpDir("topic-links");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

type Router = ReturnType<typeof import("../../server/routes/topics").createTopicsRouter>;

async function chiama(router: Router, method: string, path: string, body?: unknown) {
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

async function creaTopic(router: Router, name: string): Promise<string> {
  const res = await chiama(router, "POST", "/api/topics", { name });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/**
 * The links of a topic, read back from the list route rather than from memory.
 *
 * `GET /api/topics` answers with a MAP keyed by id (`{ topics: { <id>: … } }`),
 * not an array: reading it as a list is how the first version of this file
 * failed, and it failed loudly, which is the point of going through the route
 * instead of poking the store.
 */
async function linksDi(router: Router, id: string): Promise<string[]> {
  const res = await chiama(router, "GET", "/api/topics");
  const { topics } = (await res.json()) as { topics: Record<string, { links?: string[] }> };
  const t = topics[id];
  expect(t, `topic ${id} disappeared from the list`).toBeTruthy();
  return t!.links ?? [];
}

async function banco(): Promise<{ router: Router }> {
  const { createTopicsRouter } = await import("../../server/routes/topics");
  const ctx = await createTestAppContext();
  return { router: createTopicsRouter(ctx) };
}

describe("collegamento fra topic", () => {
  test("il collegamento e' simmetrico: si crea da una parte e vale da entrambe", async () => {
    const { router } = await banco();
    const a = await creaTopic(router, `link-a-${Date.now()}`);
    const b = await creaTopic(router, `link-b-${Date.now()}`);

    // It is born with no links: without this, a test that finds the link
    // afterwards would not know whether it was the one that put it there.
    expect(await linksDi(router, a)).toEqual([]);
    expect(await linksDi(router, b)).toEqual([]);

    const res = await chiama(router, "POST", `/api/topics/${a}/link`, { targetId: b });
    expect(res.status).toBe(200);

    expect(await linksDi(router, a)).toContain(b);
    expect(await linksDi(router, b), "half link: A points at B, B does not point back").toContain(a);
  });

  test("ripetere lo stesso collegamento non lo duplica", async () => {
    const { router } = await banco();
    const a = await creaTopic(router, `dup-a-${Date.now()}`);
    const b = await creaTopic(router, `dup-b-${Date.now()}`);

    await chiama(router, "POST", `/api/topics/${a}/link`, { targetId: b });
    await chiama(router, "POST", `/api/topics/${a}/link`, { targetId: b });

    expect(await linksDi(router, a)).toEqual([b]);
    expect(await linksDi(router, b)).toEqual([a]);
  });

  test("senza targetId e' 400, verso un topic che non esiste e' 404", async () => {
    const { router } = await banco();
    const a = await creaTopic(router, `err-a-${Date.now()}`);

    expect((await chiama(router, "POST", `/api/topics/${a}/link`, {})).status).toBe(400);
    expect((await chiama(router, "POST", `/api/topics/${a}/link`, { targetId: "non-esiste" })).status).toBe(404);

    // And the refusal left nothing behind it.
    expect(await linksDi(router, a)).toEqual([]);
  });

  test("togliere il collegamento lo toglie da tutte e due le parti", async () => {
    const { router } = await banco();
    const a = await creaTopic(router, `del-a-${Date.now()}`);
    const b = await creaTopic(router, `del-b-${Date.now()}`);
    await chiama(router, "POST", `/api/topics/${a}/link`, { targetId: b });
    expect(await linksDi(router, b)).toContain(a);

    const res = await chiama(router, "DELETE", `/api/topics/${a}/link/${b}`);
    expect(res.status).toBe(200);

    expect(await linksDi(router, a)).toEqual([]);
    expect(await linksDi(router, b), "the other side kept a link to a topic that dropped it").toEqual([]);
  });

  test("un collegamento verso un topic sparito si puo' comunque togliere", async () => {
    // The case that makes the route's `if (target)` branch useful: B is gone,
    // and without this tolerance the id would stay on A forever.
    const { router } = await banco();
    const a = await creaTopic(router, `orfano-a-${Date.now()}`);
    const b = await creaTopic(router, `orfano-b-${Date.now()}`);
    await chiama(router, "POST", `/api/topics/${a}/link`, { targetId: b });

    const del = await chiama(router, "DELETE", `/api/topics/${b}`);
    expect(del.status).toBeLessThan(300);

    const res = await chiama(router, "DELETE", `/api/topics/${a}/link/${b}`);
    expect(res.status).toBe(200);
    expect(await linksDi(router, a)).toEqual([]);
  });

  test("togliere un collegamento da un topic che non esiste e' 404", async () => {
    const { router } = await banco();
    const b = await creaTopic(router, `404-b-${Date.now()}`);
    expect((await chiama(router, "DELETE", `/api/topics/non-esiste/link/${b}`)).status).toBe(404);
  });
});

describe("il progetto di un topic", () => {
  test("un topic senza progetto risponde 400, non un id inventato", async () => {
    // The `GET /api/topics/:topicId/project-id` route is the one the board
    // derives which project a chat belongs to from. The "no project" branch has
    // to be an explicit refusal: a plausible id returned for a topic that has no
    // project would send the board off to read somebody else's board.
    const { router } = await banco();
    const a = await creaTopic(router, `senza-progetto-${Date.now()}`);
    const res = await chiama(router, "GET", `/api/topics/${a}/project-id`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBeTruthy();
  });

  test("con un progetto collegato risponde con il suo id", async () => {
    const { router } = await banco();
    const a = await creaTopic(router, `con-progetto-${Date.now()}`);
    const cartella = `/tmp/topic-links-${Date.now()}`;
    const patch = await chiama(router, "PATCH", `/api/topics/${a}`, { projectPath: cartella });
    expect(patch.status).toBeLessThan(300);

    const res = await chiama(router, "GET", `/api/topics/${a}/project-id`);
    expect(res.status).toBe(200);
    const { projectId } = (await res.json()) as { projectId: string };
    expect(typeof projectId).toBe("string");
    expect(projectId.length).toBeGreaterThan(0);

    // The same id the board computes from the path: if the two diverged, the
    // chat and its board would be talking about two different projects.
    const { projectIdForPath } = await import("../../shared/board");
    expect(projectId).toBe(projectIdForPath(cartella));
  });
});
