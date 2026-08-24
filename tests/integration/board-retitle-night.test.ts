/**
 * `POST …/tasks/:taskId/retitle` and `GET …/night-status`.
 *
 * No `@covers` line, deliberately. Neither route has a requirement in
 * `openspec/specs/kanban/`: KANBAN-01 is board rendering and task CRUD, -02
 * workflows, -03 memory and tags, -04 approvals, -10 dispatch resume after a
 * restart. Claiming one of them from here would be a false declaration, which
 * is precisely the defect `check:spec-coverage` was written to catch. The
 * honest state is "tested surface, undeclared requirement".
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
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";

const ROOT = testTmpDir("board-retitle-night");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

type Router = ReturnType<typeof import("../../server/routes/tasks").createTasksRouter>;

/** Il titolo lungo che fa scattare la riscrittura: sotto i 60 caratteri il
 *  servizio non chiama nemmeno il modello, ed e' una scelta, non un limite. */
const TITOLO_LUNGO =
  "potremmo fare in modo che quando uno apre la board dopo aver chiuso tutto le colonne " +
  "si ricordino da sole quanto erano larghe, perche' adesso tornano tutte uguali";
const DESCRIZIONE =
  "Le larghezze delle colonne della board non sopravvivono alla chiusura della finestra: " +
  "alla riapertura tornano al valore di partenza invece di riprendere quelle scelte. " +
  "Vanno persistite per progetto e ripristinate al montaggio della board, con lo stesso " +
  "meccanismo che gia' tiene l'ordine delle colonne.";

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

/**
 * Un provider finto.
 *
 * `complete` deve rispondere `{ content }` e non una stringa nuda: e' la forma
 * che `titoloMigliore` legge (`out.content ?? ""`). Con la stringa nuda il
 * contenuto risulta vuoto, `ripulisci("")` torna `null`, e la rotta risponde
 * «nothing_better» — cioe' il test sarebbe stato verde sul ramo sbagliato,
 * credendo di provare il rifiuto mentre stava solo sbagliando lo stub.
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
  return { router, projectId: await progetto() };
}

let contatore = 0;
async function progetto(): Promise<string> {
  const { projectIdForPath } = await import("../../shared/board");
  return projectIdForPath(join(ROOT, `p-${++contatore}`));
}

/** Un router sullo STESSO database, con o senza modello cablato. */
async function router(naming?: () => unknown): Promise<Router> {
  const { createTasksRouter } = await import("../../server/routes/tasks");
  return createTasksRouter(
    await createTestAppContext(),
    undefined,
    naming ? ({ namingProvider: naming } as never) : undefined,
  );
}

async function creaTask(router: Router, projectId: string, text: string, description?: string): Promise<string> {
  const res = await chiama(router, "POST", `/api/boards/${projectId}/tasks`, { text, description });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return ((await res.json()) as { id: string }).id;
}

/** Il titolo della card, riletto dalla rotta invece che dalla risposta. */
async function titoloDi(router: Router, projectId: string, taskId: string): Promise<string> {
  const res = await chiama(router, "GET", `/api/boards/${projectId}/tasks/${taskId}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { task?: { text: string }; text?: string };
  return body.task?.text ?? body.text ?? "";
}

describe("il modello riscrive il titolo di una card", () => {
  test("senza un modello cablato dice di no, e non tocca niente", async () => {
    const { router, projectId } = await banco();
    const id = await creaTask(router, projectId, TITOLO_LUNGO, DESCRIZIONE);

    const res = await chiama(router, "POST", `/api/boards/${projectId}/tasks/${id}/retitle`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, reason: "no_provider" });
    expect(await titoloDi(router, projectId, id)).toBe(TITOLO_LUNGO);
  });

  test("una card che non esiste e' 404", async () => {
    const { router, projectId } = await banco(provider("qualcosa"));
    const res = await chiama(router, "POST", `/api/boards/${projectId}/tasks/mai-esistita/retitle`);
    expect(res.status).toBe(404);
  });

  test("un titolo gia' corto non si tocca, anche col modello acceso", async () => {
    // Il ramo che protegge la scelta di una PERSONA: sotto i 60 caratteri il
    // titolo e' una decisione, non un ripiego, e il modello non viene nemmeno
    // interrogato. Il provider qui risponde, e la sua risposta deve restare
    // inascoltata.
    const { router, projectId } = await banco(provider("Titolo inventato dal modello"));
    const corto = "Larghezze delle colonne persistenti";
    const id = await creaTask(router, projectId, corto, DESCRIZIONE);

    const res = await chiama(router, "POST", `/api/boards/${projectId}/tasks/${id}/retitle`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, reason: "nothing_better" });
    expect(await titoloDi(router, projectId, id), "ha riscritto un titolo che una persona aveva gia' scelto").toBe(corto);
  });

  test("quando riscrive, la card cambia davvero e la risposta dice anche il prima", async () => {
    // La card nasce SENZA modello cablato, di proposito: la `create` fa gia' un
    // rinomino in sottofondo, quindi creandola con il provider acceso la card
    // arriverebbe a `retitle` gia' rinominata e la rotta risponderebbe
    // «nothing_better» — verde sul ramo sbagliato. Due router sullo stesso
    // database separano i due momenti.
    const nuovo = "Larghezze delle colonne che sopravvivono alla riapertura";
    const projectId = await progetto();
    const senzaModello = await router();
    const id = await creaTask(senzaModello, projectId, TITOLO_LUNGO, DESCRIZIONE);
    expect(await titoloDi(senzaModello, projectId, id), "la card e' gia' stata rinominata prima di retitle").toBe(TITOLO_LUNGO);

    const conModello = await router(provider(nuovo));
    const res = await chiama(conModello, "POST", `/api/boards/${projectId}/tasks/${id}/retitle`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; text: string; before: string; reason?: string };
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.text).toBe(nuovo);
    // `before` non e' decorazione: e' l'unico posto in cui resta quello che la
    // persona aveva scritto, dopo che la card e' stata riscritta.
    expect(body.before).toBe(TITOLO_LUNGO);

    // E la prova che conta: la card, riletta, porta il titolo nuovo. Un
    // `{ok:true}` con la scrittura persa risponderebbe identico.
    expect(await titoloDi(conModello, projectId, id)).toBe(nuovo);
  });
});

describe("la modalita' notte di una board", () => {
  test("senza dispatcher risponde spenta, non fallisce", async () => {
    // Il ramo di ogni board che la notte non l'ha mai accesa, cioe' quasi
    // tutte: deve essere una risposta, non un rosso permanente su un pannello.
    const { router, projectId } = await banco();
    const res = await chiama(router, "GET", `/api/boards/${projectId}/night-status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, action: "off" });
  });
});
