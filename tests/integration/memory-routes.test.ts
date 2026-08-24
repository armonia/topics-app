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
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";

const ROOT = testTmpDir("memory-routes");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

type Router = ReturnType<typeof import("../../server/routes/memory").createMemoryRouter>;

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

async function banco(): Promise<Router> {
  const { createMemoryRouter } = await import("../../server/routes/memory");
  return createMemoryRouter(await createTestAppContext());
}

const leggiTopic = async (router: Router, id: string) =>
  ((await (await chiama(router, "GET", `/api/memory/${id}`)).json()) as { topicContent: string }).topicContent;

const leggiGlobale = async (router: Router) =>
  ((await (await chiama(router, "GET", "/api/memory")).json()) as { content: string }).content;

describe("aggiungere alla memoria di un topic", () => {
  test("l'aggiunta si aggiunge: quello che c'era resta", async () => {
    const router = await banco();
    const id = `t-append-${Date.now()}`;

    await chiama(router, "PUT", `/api/memory/${id}`, { content: "La prima cosa detta." });
    expect(await leggiTopic(router, id)).toBe("La prima cosa detta.");

    const res = await chiama(router, "POST", `/api/memory/${id}/append`, { content: "La seconda." });
    expect(res.status).toBe(200);

    const dopo = await leggiTopic(router, id);
    expect(dopo, "l'aggiunta ha sovrascritto invece di aggiungere").toContain("La prima cosa detta.");
    expect(dopo).toContain("La seconda.");
    // La voce nuova porta una data, ed e' la sola cosa che distingue due
    // aggiunte con lo stesso testo.
    expect(dopo).toMatch(/- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] La seconda\./);
  });

  test("aggiungere due volte lascia due righe, in ordine", async () => {
    const router = await banco();
    const id = `t-ordine-${Date.now()}`;
    await chiama(router, "POST", `/api/memory/${id}/append`, { content: "uno" });
    await chiama(router, "POST", `/api/memory/${id}/append`, { content: "due" });

    const testo = await leggiTopic(router, id);
    expect(testo.indexOf("uno")).toBeGreaterThanOrEqual(0);
    expect(testo.indexOf("due")).toBeGreaterThan(testo.indexOf("uno"));
  });

  test("senza contenuto e' 400, e non crea niente", async () => {
    const router = await banco();
    const id = `t-vuoto-${Date.now()}`;
    expect((await chiama(router, "POST", `/api/memory/${id}/append`, {})).status).toBe(400);
    expect(await leggiTopic(router, id)).toBe("");
  });

  test("un'aggiunta che sfora il tetto viene rifiutata E non tocca il file", async () => {
    // Il caso che conta: il controllo sta FRA la lettura e la scrittura. Se
    // scivolasse sotto la `saveMemory`, la richiesta rifiutata sarebbe anche
    // quella che tronca — cioe' il 413 arriverebbe DOPO aver fatto il danno.
    const router = await banco();
    const id = `t-tetto-${Date.now()}`;
    const prezioso = "Questo non deve sparire.";
    await chiama(router, "PUT", `/api/memory/${id}`, { content: prezioso });

    const tetto = ((await (await chiama(router, "GET", `/api/memory/${id}`)).json()) as { maxTopicBytes: number }).maxTopicBytes;
    expect(tetto).toBeGreaterThan(0);

    const res = await chiama(router, "POST", `/api/memory/${id}/append`, { content: "x".repeat(tetto + 1) });
    expect(res.status).toBe(413);
    expect(await leggiTopic(router, id), "il rifiuto ha comunque scritto").toBe(prezioso);
  });
});

describe("le due memorie sono due cose separate", () => {
  test("cancellare la globale non tocca quella del topic", async () => {
    const router = await banco();
    const id = `t-scope-a-${Date.now()}`;
    await chiama(router, "PUT", "/api/memory", { content: "memoria globale" });
    await chiama(router, "PUT", `/api/memory/${id}`, { content: "memoria del topic" });

    const res = await chiama(router, "DELETE", "/api/memory/global");
    expect(res.status).toBe(200);

    expect(await leggiGlobale(router)).toBe("");
    expect(await leggiTopic(router, id), "la cancellazione globale si e' portata via il topic").toBe("memoria del topic");
  });

  test("cancellare quella di un topic non tocca la globale ne' gli altri topic", async () => {
    const router = await banco();
    const uno = `t-scope-b-${Date.now()}`;
    const due = `t-scope-c-${Date.now()}`;
    await chiama(router, "PUT", "/api/memory", { content: "globale intatta" });
    await chiama(router, "PUT", `/api/memory/${uno}`, { content: "primo topic" });
    await chiama(router, "PUT", `/api/memory/${due}`, { content: "secondo topic" });

    const res = await chiama(router, "DELETE", `/api/memory/topic/${uno}`);
    expect(res.status).toBe(200);

    expect(await leggiTopic(router, uno)).toBe("");
    expect(await leggiTopic(router, due), "cancellato il topic sbagliato").toBe("secondo topic");
    expect(await leggiGlobale(router), "la cancellazione di un topic si e' portata via la globale").toBe("globale intatta");
  });

  test("`/append` non viene inghiottita dalla rotta del singolo topic", async () => {
    // Due modelli che si somigliano — `/api/memory/:topicId` e
    // `/api/memory/:topicId/append` — e l'ordine in cui il router li prova e'
    // l'unica cosa che li tiene distinti. Se il primo cominciasse ad accettare
    // anche il secondo, un `append` diventerebbe una lettura: 200, nessun
    // errore, e niente scritto.
    const router = await banco();
    const id = `t-rotta-${Date.now()}`;
    await chiama(router, "POST", `/api/memory/${id}/append`, { content: "arrivata a destinazione" });
    expect(await leggiTopic(router, id)).toContain("arrivata a destinazione");
  });
});
