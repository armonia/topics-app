/**
 * `POST …/tasks/:taskId/retitle` and `GET …/night-status`.
 *
 * These two routes had no requirement at all until 2026-08-25: the honest
 * state was "tested surface, undeclared requirement", and this file said so
 * rather than claiming a KANBAN- id that meant something else — a false
 * declaration is precisely the defect `check:spec-coverage` was written to
 * catch. The cure was to WRITE the two requirements, not to borrow a number.
 *
 * Why this file exists. On 2026-08-25 an audit of the 310 HTTP routes found the
 * Kanban in good shape — 23 of its 26 routes named by some test — with three
 * left over. These are two of them.
 *
 * RETITLE is the one that earns real assertions, because it is the only route
 * that lets a MODEL rewrite something a person wrote. Its contract is therefore
 * mostly about when it must refuse, and every refusal has to leave the original
 * title exactly where it was:
 *
 *   - no model wired      -> `{ok:false, reason:"no_provider"}`
 *   - the title is fine   -> `{ok:false, reason:"nothing_better"}`
 *   - a better one exists -> `{ok:true, text, before}` AND the card is updated
 *
 * The failure that hurts is not an error page: it is a card whose title quietly
 * becomes something the person never wrote, or a `{ok:true}` whose new title is
 * reported but never persisted. Both are silent, so both are asserted here by
 * READING THE CARD BACK, never by trusting the response body.
 *
 * NIGHT-STATUS earns one assertion and no more: with no dispatcher it must
 * answer `{enabled:false, action:"off"}` rather than fail. It is the branch that
 * runs on every board that never turned night mode on, i.e. almost all of them,
 * and a 500 there would be a permanent red dot on a feature nobody uses.
 *
 * @covers KANBAN-25, NIGHT-03
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";

const ROOT = testTmpDir("board-retitle-night");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

type Router = ReturnType<typeof import("../../server/routes/tasks").createTasksRouter>;

/** The long title that triggers the rewrite: below 60 characters the service
 *  does not even call the model, and that is a choice, not a limit. */
const LONG_TITLE =
  "potremmo fare in modo che quando uno apre la board dopo aver chiuso tutto le colonne " +
  "si ricordino da sole quanto erano larghe, perche' adesso tornano tutte uguali";
const DESCRIPTION =
  "Le larghezze delle colonne della board non sopravvivono alla chiusura della finestra: " +
  "alla riapertura tornano al valore di partenza invece di riprendere quelle scelte. " +
  "Vanno persistite per progetto e ripristinate al montaggio della board, con lo stesso " +
  "meccanismo che gia' tiene l'ordine delle colonne.";

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

/**
 * A fake provider.
 *
 * `complete` has to answer `{ content }` and not a bare string: that is the
 * shape `titoloMigliore` reads (`out.content ?? ""`). With a bare string the
 * content comes out empty, `ripulisci("")` returns `null`, and the route
 * answers "nothing_better" - that is, the test would have been green on the
 * wrong branch, believing it was exercising the refusal while it was only
 * getting the stub wrong.
 */
function provider(risposta: string) {
  return () => ({ complete: async () => ({ content: risposta }) }) as never;
}

async function banco(naming?: () => unknown): Promise<{ router: Router; projectId: string }> {
  const { createTasksRouter } = await import("../../server/routes/tasks");
  const ctx = await createTestAppContext();
  const router = createTasksRouter(
    ctx,
    undefined,
    naming ? ({ namingProvider: naming } as never) : undefined,
  );
  return { router, projectId: await nextProjectId() };
}

let counter = 0;
async function nextProjectId(): Promise<string> {
  const { projectIdForPath } = await import("../../shared/board");
  return projectIdForPath(join(ROOT, `p-${++counter}`));
}

/** A router on the SAME database, with or without a model wired in. */
async function router(naming?: () => unknown): Promise<Router> {
  const { createTasksRouter } = await import("../../server/routes/tasks");
  return createTasksRouter(
    await createTestAppContext(),
    undefined,
    naming ? ({ namingProvider: naming } as never) : undefined,
  );
}

async function creaTask(router: Router, projectId: string, text: string, description?: string): Promise<string> {
  const res = await call(router, "POST", `/api/boards/${projectId}/tasks`, { text, description });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return ((await res.json()) as { id: string }).id;
}

/** The card's title, read back from the route instead of from the response. */
async function titleOf(router: Router, projectId: string, taskId: string): Promise<string> {
  const res = await call(router, "GET", `/api/boards/${projectId}/tasks/${taskId}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { task?: { text: string }; text?: string };
  return body.task?.text ?? body.text ?? "";
}

describe("il modello riscrive il titolo di una card", () => {
  test("senza un modello cablato dice di no, e non tocca niente", async () => {
    const { router, projectId } = await banco();
    const id = await creaTask(router, projectId, LONG_TITLE, DESCRIPTION);

    const res = await call(router, "POST", `/api/boards/${projectId}/tasks/${id}/retitle`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, reason: "no_provider" });
    expect(await titleOf(router, projectId, id)).toBe(LONG_TITLE);
  });

  test("una card che non esiste e' 404", async () => {
    const { router, projectId } = await banco(provider("qualcosa"));
    const res = await call(router, "POST", `/api/boards/${projectId}/tasks/mai-esistita/retitle`);
    expect(res.status).toBe(404);
  });

  test("un titolo gia' corto non si tocca, anche col modello acceso", async () => {
    // The branch that protects a PERSON's choice: below 60 characters the title
    // is a decision, not a fallback, and the model is not even queried. The
    // provider here does answer, and its answer has to go unheard.
    const { router, projectId } = await banco(provider("Titolo inventato dal modello"));
    const shortTitle = "Larghezze delle colonne persistenti";
    const id = await creaTask(router, projectId, shortTitle, DESCRIPTION);

    const res = await call(router, "POST", `/api/boards/${projectId}/tasks/${id}/retitle`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, reason: "nothing_better" });
    expect(await titleOf(router, projectId, id), "ha riscritto un titolo che una persona aveva gia' scelto").toBe(shortTitle);
  });

  test("quando riscrive, la card cambia davvero e la risposta dice anche il prima", async () => {
    // The card is born WITHOUT a model wired in, on purpose: `create` already
    // does a rename in the background, so creating it with the provider on
    // would have the card reach `retitle` already renamed and the route would
    // answer "nothing_better" - green on the wrong branch. Two routers on the
    // same database keep the two moments apart.
    const newTitle = "Larghezze delle colonne che sopravvivono alla riapertura";
    const projectId = await nextProjectId();
    const withoutModel = await router();
    const id = await creaTask(withoutModel, projectId, LONG_TITLE, DESCRIPTION);
    expect(await titleOf(withoutModel, projectId, id), "la card e' gia' stata rinominata prima di retitle").toBe(LONG_TITLE);

    const withModel = await router(provider(newTitle));
    const res = await call(withModel, "POST", `/api/boards/${projectId}/tasks/${id}/retitle`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; text: string; before: string; reason?: string };
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.text).toBe(newTitle);
    // `before` is not decoration: it is the only place where what the person
    // had written survives, once the card has been rewritten.
    expect(body.before).toBe(LONG_TITLE);

    // And the proof that counts: the card, read back, carries the new title. An
    // `{ok:true}` with the write lost would answer identically.
    expect(await titleOf(withModel, projectId, id)).toBe(newTitle);
  });
});

describe("la modalita' notte di una board", () => {
  test("senza dispatcher risponde spenta, non fallisce", async () => {
    // The branch of every board that has never turned night mode on, i.e.
    // almost all of them: it has to be an answer, not a permanent red on a panel.
    const { router, projectId } = await banco();
    const res = await call(router, "GET", `/api/boards/${projectId}/night-status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, action: "off" });
  });
});
