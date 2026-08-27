/**
 * L'autore di un messaggio deve SOPRAVVIVERE al giro carica→salva.
 *
 * `saveLocalMessages` non aggiorna: RIMPIAZZA l'intera `session_key`
 * (`DELETE` + reinserimento di ciò che gli si passa). Ogni troncatura, ogni
 * import, ogni riscrittura di ramo passa di lì. Se `rowToMessage` non leggesse
 * l'autore o `metaParams` non lo riscrivesse, l'attribuzione verrebbe azzerata
 * su TUTTI i messaggi già scritti — senza errore, senza log, e senza che nessun
 * test sullo schema se ne accorga: le colonne ci sarebbero, piene di NULL.
 *
 * È lo stesso difetto che la 095 esiste per evitare, ma dal lato del codice
 * invece che dello schema.
  * @covers RES-ATTR-10
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext } from "../../server/types";
import { autoreDaIdentita } from "../../server/lib/message-author";

const TEST_DATA = testTmpDir("message-author-data");
beforeAll(() => setupTestDataDir(TEST_DATA));

const SK = "author-roundtrip-1";

async function ctxConPersona(): Promise<{ ctx: AppContext; personId: string; deviceId: string }> {
  const ctx = await createTestAppContext();
  const db = ctx.db as never as { run: (q: string, p?: unknown[]) => void; query: (q: string) => { get: () => unknown } };
  const personId = "pers-mircea";
  const deviceId = "dev-mircea";
  db.run("INSERT OR IGNORE INTO people (id, display_name, created_at, updated_at) VALUES (?, ?, 0, 0)", [personId, "Mircea"]);
  db.run(
    `INSERT OR IGNORE INTO devices (id, name, token_hash, created_at, last_seen_at, role, person_id)
     VALUES (?, 'Mac di Mircea', 'hash-mircea', 0, 0, 'owner', ?)`,
    [deviceId, personId],
  );
  return { ctx, personId, deviceId };
}

describe("l'autore sui messaggi", () => {
  test("si scrive, si rilegge e sopravvive a un salvataggio dell'intera sessione", async () => {
    const { ctx, personId, deviceId } = await ctxConPersona();

    const scritto = ctx.appendLocalMessage(SK, "user", "chi l'ha detto?", {
      authorPersonId: personId,
      authorDeviceId: deviceId,
    });
    expect(scritto.authorPersonId).toBe(personId);

    const caricati = ctx.loadLocalMessages(SK);
    expect(caricati).toHaveLength(1);
    expect(caricati[0]!.authorPersonId).toBe(personId);
    expect(caricati[0]!.authorDeviceId).toBe(deviceId);

    // IL GIRO CHE CANCELLA: ricarico e risalvo, come fa una troncatura.
    ctx.saveLocalMessages(SK, caricati);
    const dopo = ctx.loadLocalMessages(SK);
    expect(dopo[0]!.authorPersonId).toBe(personId);
    expect(dopo[0]!.authorDeviceId).toBe(deviceId);
  });

  test("senza autore la riga resta senza, e non si inventa nessuno", async () => {
    const { ctx } = await ctxConPersona();
    const sk = "author-roundtrip-2";
    ctx.appendLocalMessage(sk, "assistant", "ecco fatto");
    const [m] = ctx.loadLocalMessages(sk);
    expect(m!.authorPersonId ?? null).toBeNull();
    expect(m!.authorDeviceId ?? null).toBeNull();
  });

  test("l'identità della richiesta diventa l'autore; il dispositivo ignoto non porta una persona ignota", async () => {
    const { ctx, personId, deviceId } = await ctxConPersona();
    const db = ctx.db as never;

    expect(autoreDaIdentita(db, { deviceId })).toEqual({
      authorPersonId: personId,
      authorDeviceId: deviceId,
    });

    // Un dispositivo che non conosciamo: il dispositivo si scrive comunque (è un
    // fatto — quel messaggio è entrato da lì), la persona ricade sul
    // proprietario predefinito o resta null. Ciò che NON deve mai succedere è
    // prendersi la persona SBAGLIATA, cioè quella del dispositivo noto.
    const ignoto = autoreDaIdentita(db, { deviceId: "dev-mai-visto" });
    expect(ignoto.authorDeviceId).toBe("dev-mai-visto");
    expect(ignoto.authorPersonId).not.toBe(personId);
  });
});

/**
 * LA SECONDA PORTA. `POST /api/chat` non è l'unico punto in cui un prompt umano
 * entra: `POST /api/messages/:id/edit` ne crea uno nuovo ogni volta che qualcuno
 * riscrive la propria domanda invece di ribatterla. Senza autore su quel
 * percorso il conteggio di un profilo è più basso del vero, e la differenza non
 * si vede da nessuna parte — non c'è errore, c'è un numero.
 *
 * I due rami sono diversi nel codice e vanno provati tutti e due: la radice
 * riscritta passa da un INSERT scritto a mano dentro la rotta, il fratello sotto
 * lo stesso padre da `createBranchMessage`.
 *
 * Il provider non c'è, quindi lo streaming solleva. Non è un ostacolo: la riga
 * viene INSERITA prima, ed è esattamente ciò che questo test guarda.
 */
describe("l'autore entra anche dalla porta dell'edit", () => {
  async function editRouter(deviceId: string) {
    const { createEditRouter } = await import("../../server/routes/edit");
    const { ctx, personId } = await ctxConPersona();
    ctx.requestIdentity = () => ({ role: "owner", deviceId });
    const router = createEditRouter(ctx, {
      resolveProvider: () => { throw new Error("nessun provider in questo test"); },
      updateUnreadCount: () => {},
    });
    return { ctx, personId, router };
  }

  const authorOf = (ctx: AppContext, id: string) =>
    (ctx.db as never as { query: (q: string) => { get: (a: string) => unknown } })
      .query("SELECT author_person_id AS p, author_device_id AS d FROM messages WHERE id = ?")
      .get(id) as { p: string | null; d: string | null };

  /** L'ultimo messaggio utente della sessione che NON è quello di partenza. */
  const newUser = (ctx: AppContext, sk: string, escluso: string) =>
    (ctx.db as never as { query: (q: string) => { get: (...a: string[]) => unknown } })
      .query("SELECT id FROM messages WHERE session_key = ? AND role = 'user' AND id != ? ORDER BY sort_order DESC LIMIT 1")
      .get(sk, escluso) as { id: string } | undefined;

  async function edita(router: Awaited<ReturnType<typeof editRouter>>["router"], id: string) {
    const p = `/api/messages/${id}/edit`;
    const url = new URL(`http://h${p}`);
    try {
      await router(new Request(url, { method: "POST", body: JSON.stringify({ content: "riscritta" }) }), url, p, "POST");
    } catch { /* lo streaming cade: la riga è già stata scritta */ }
  }

  test("la radice riscritta porta la persona di chi l'ha riscritta", async () => {
    const { ctx, personId, router } = await editRouter("dev-mircea");
    const sk = "author-edit-root";
    ctx.saveLocalMessages(sk, [
      { id: "er-u1", role: "user", content: "prima stesura", timestamp: new Date().toISOString() },
    ]);

    await edita(router, "er-u1");

    const nuova = newUser(ctx, sk, "er-u1");
    expect(nuova, "l'edit deve aver creato un fratello").toBeTruthy();
    expect(authorOf(ctx, nuova!.id)).toEqual({ p: personId, d: "dev-mircea" });
  });

  test("il fratello sotto lo stesso padre pure", async () => {
    const { ctx, personId, router } = await editRouter("dev-mircea");
    const sk = "author-edit-sibling";
    const t = new Date().toISOString();
    ctx.saveLocalMessages(sk, [
      { id: "es-u1", role: "user", content: "domanda", timestamp: t },
      { id: "es-a1", role: "assistant", content: "risposta", timestamp: t, parentId: "es-u1" },
      { id: "es-u2", role: "user", content: "seconda domanda", timestamp: t, parentId: "es-a1" },
    ]);

    await edita(router, "es-u2");

    const nuova = (ctx.db as never as { query: (q: string) => { get: (...a: string[]) => unknown } })
      .query("SELECT id FROM messages WHERE parent_id = ? AND role = 'user' ORDER BY branch_index DESC LIMIT 1")
      .get("es-a1") as { id: string } | undefined;
    expect(nuova?.id).toBeTruthy();
    expect(nuova!.id).not.toBe("es-u2");
    expect(authorOf(ctx, nuova!.id)).toEqual({ p: personId, d: "dev-mircea" });
  });
});
