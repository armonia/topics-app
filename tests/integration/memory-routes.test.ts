/**
 * The memory routes: append, and the two deletes.
 *
 * Why this file exists. On 2026-08-25 an audit of the 310 HTTP routes found
 * three of the five memory routes named by no test: `POST /api/memory/:id/append`,
 * `DELETE /api/memory/global` and `DELETE /api/memory/topic/:id`. Memory is what
 * gets injected into the system prompt of every turn, so a defect here is not a
 * broken screen — it is the model quietly being told something else, or nothing.
 *
 * Three properties earn a test, and each one fails silently:
 *
 *  - APPEND ADDS. The name promises it, and the implementation reads the file,
 *    concatenates and writes back. The failure mode of a wrong `saveMemory` call
 *    is not an error: it is a memory that keeps only its last line, and nobody
 *    notices until the model forgets something it was told a week ago.
 *  - A REFUSED APPEND LEAVES THE FILE ALONE. The size check happens after the
 *    read and before the write, and returns 413. If it ever moves below the
 *    write, the request that is refused is also the request that truncates.
 *  - THE TWO SCOPES ARE SEPARATE. Global memory and topic memory are two files
 *    and two deletes. Clearing one must not clear the other — and since both
 *    live in the same directory and are addressed by paths that overlap
 *    (`/api/memory/global` vs `/api/memory/:topicId`), a routing change is
 *    enough to make one swallow the other.
 *
 * @covers CTX-01
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";

const ROOT = testTmpDir("memory-routes");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

type Router = ReturnType<typeof import("../../server/routes/memory").createMemoryRouter>;

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
 * The router derives no path from the URL alone: a memory file belongs to a
 * Topic that EXISTS, otherwise a request would be enough to mint one. So the
 * bench creates the Topic rows it is about to address, exactly as the app does
 * before it has any memory to write.
 */
async function banco(...topicIds: string[]): Promise<Router> {
  const { createMemoryRouter } = await import("../../server/routes/memory");
  const ctx = await createTestAppContext();
  const insert = ctx.db.prepare(
    `INSERT INTO topics (id, name, slug, session_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
  );
  for (const id of topicIds) insert.run(id, id, id, `topic:${id}`);
  return createMemoryRouter(ctx);
}

const readTopic = async (router: Router, id: string) =>
  ((await (await call(router, "GET", `/api/memory/${id}`)).json()) as { topicContent: string }).topicContent;

const readGlobal = async (router: Router) =>
  ((await (await call(router, "GET", "/api/memory")).json()) as { content: string }).content;

describe("aggiungere alla memoria di un topic", () => {
  test("l'aggiunta si aggiunge: quello che c'era resta", async () => {
    const id = `t-append-${Date.now()}`;
    const router = await banco(id);

    await call(router, "PUT", `/api/memory/${id}`, { content: "La prima cosa detta." });
    expect(await readTopic(router, id)).toBe("La prima cosa detta.");

    const res = await call(router, "POST", `/api/memory/${id}/append`, { content: "La seconda." });
    expect(res.status).toBe(200);

    const after = await readTopic(router, id);
    expect(after, "l'aggiunta ha sovrascritto invece di aggiungere").toContain("La prima cosa detta.");
    expect(after).toContain("La seconda.");
    // The new entry carries a date, and that is the only thing that tells apart
    // two appends with the same text.
    expect(after).toMatch(/- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] La seconda\./);
  });

  test("aggiungere due volte lascia due righe, in ordine", async () => {
    const id = `t-ordine-${Date.now()}`;
    const router = await banco(id);
    await call(router, "POST", `/api/memory/${id}/append`, { content: "uno" });
    await call(router, "POST", `/api/memory/${id}/append`, { content: "due" });

    const text = await readTopic(router, id);
    expect(text.indexOf("uno")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("due")).toBeGreaterThan(text.indexOf("uno"));
  });

  test("senza contenuto e' 400, e non crea niente", async () => {
    const id = `t-vuoto-${Date.now()}`;
    const router = await banco(id);
    expect((await call(router, "POST", `/api/memory/${id}/append`, {})).status).toBe(400);
    expect(await readTopic(router, id)).toBe("");
  });

  test("un'aggiunta che sfora il tetto viene rifiutata E non tocca il file", async () => {
    // The case that counts: the check sits BETWEEN the read and the write. If it
    // slipped below the `saveMemory`, the request that is refused would also be
    // the one that truncates - that is, the 413 would arrive AFTER the damage.
    const id = `t-tetto-${Date.now()}`;
    const router = await banco(id);
    const precious = "Questo non deve sparire.";
    await call(router, "PUT", `/api/memory/${id}`, { content: precious });

    const cap = ((await (await call(router, "GET", `/api/memory/${id}`)).json()) as { maxTopicBytes: number }).maxTopicBytes;
    expect(cap).toBeGreaterThan(0);

    const res = await call(router, "POST", `/api/memory/${id}/append`, { content: "x".repeat(cap + 1) });
    expect(res.status).toBe(413);
    expect(await readTopic(router, id), "il rifiuto ha comunque scritto").toBe(precious);
  });
});

describe("le due memorie sono due cose separate", () => {
  test("cancellare la globale non tocca quella del topic", async () => {
    const id = `t-scope-a-${Date.now()}`;
    const router = await banco(id);
    await call(router, "PUT", "/api/memory", { content: "memoria globale" });
    await call(router, "PUT", `/api/memory/${id}`, { content: "memoria del topic" });

    const res = await call(router, "DELETE", "/api/memory/global");
    expect(res.status).toBe(200);

    expect(await readGlobal(router)).toBe("");
    expect(await readTopic(router, id), "la cancellazione globale si e' portata via il topic").toBe("memoria del topic");
  });

  test("cancellare quella di un topic non tocca la globale ne' gli altri topic", async () => {
    const first = `t-scope-b-${Date.now()}`;
    const second = `t-scope-c-${Date.now()}`;
    const router = await banco(first, second);
    await call(router, "PUT", "/api/memory", { content: "globale intatta" });
    await call(router, "PUT", `/api/memory/${first}`, { content: "primo topic" });
    await call(router, "PUT", `/api/memory/${second}`, { content: "secondo topic" });

    const res = await call(router, "DELETE", `/api/memory/topic/${first}`);
    expect(res.status).toBe(200);

    expect(await readTopic(router, first)).toBe("");
    expect(await readTopic(router, second), "cancellato il topic sbagliato").toBe("secondo topic");
    expect(await readGlobal(router), "la cancellazione di un topic si e' portata via la globale").toBe("globale intatta");
  });

  test("`/append` non viene inghiottita dalla rotta del singolo topic", async () => {
    // Two patterns that look alike - `/api/memory/:topicId` and
    // `/api/memory/:topicId/append` - and the order in which the router tries
    // them is the only thing keeping them distinct. If the first started
    // accepting the second too, an `append` would become a read: 200, no error,
    // and nothing written.
    const id = `t-rotta-${Date.now()}`;
    const router = await banco(id);
    await call(router, "POST", `/api/memory/${id}/append`, { content: "arrivata a destinazione" });
    expect(await readTopic(router, id)).toContain("arrivata a destinazione");
  });
});
