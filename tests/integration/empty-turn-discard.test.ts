/**
 * "Un turno che non ha prodotto niente non lascia niente."
 *
 * Fermare una risposta PRIMA che il modello dicesse qualcosa finalizzava il
 * segnaposto creato all'inizio dello stream: contenuto vuoto, `partial: 0`.
 * Risultato in chat una bolla vuota, che sopravvive a ogni reload. In DB se ne
 * contavano a decine nei giorni di dispatch (26 il 19/07, 20 il 20/07). Al
 * modello non arrivavano: la history verso il provider scarta i turni vuoti
 * (`empty-after-strip`) — il danno è nel thread salvato e in pagina.
 *
 * Qui si verifica il lato store: `discardIfEmptyTurn` cancella il segnaposto e
 * lascia il thread coerente, ma NON tocca un turno che aveva prodotto qualcosa
 * (mezza frase, un ragionamento, una tool call) — quello è lavoro fatto.
 * Il predicato è `shared/empty-turn.ts`, con i suoi test di unità; la prova che
 * la bolla sparisce anche in pagina sta nell'E2E `empty-turn-on-stop.spec.ts`.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir, cleanupTestDataDir } from "./helpers";
import type { AppContext, StoredMessage } from "../../server/types";

const TEST_DATA = testTmpDir("empty-turn-data");

beforeAll(() => setupTestDataDir(TEST_DATA));
afterAll(() => cleanupTestDataDir(TEST_DATA));

let seq = 0;
function msg(p: Partial<StoredMessage> & Pick<StoredMessage, "id" | "role" | "content">): StoredMessage {
  return { timestamp: new Date(Date.now() + seq++ * 1000).toISOString(), ...p };
}

/** Una domanda dell'utente + il segnaposto che lo stream crea subito dopo. */
function seedTurnInFlight(ctx: AppContext, sessionKey: string, p: string): StoredMessage {
  ctx.saveLocalMessages(sessionKey, [msg({ id: `${p}-u1`, role: "user", content: "che ore sono?" })]);
  return ctx.createBranchPartialMessage(sessionKey, `${p}-u1`);
}

/** Quello che fa l'abort: finalizza con quel che c'è, poi scarta se è niente. */
function finalizeAborted(ctx: AppContext, sessionKey: string, content = "", thinking?: string) {
  const finalized = ctx.updateLastMessage(sessionKey, {
    content, thinking: thinking || undefined, partial: undefined, streamedAt: undefined,
  });
  return ctx.discardIfEmptyTurn(sessionKey, finalized);
}

describe("stop su un turno che non ha prodotto niente", () => {
  test("il segnaposto vuoto sparisce e il thread resta alla domanda", async () => {
    const ctx = await createTestAppContext();
    const placeholder = seedTurnInFlight(ctx, "topic:empty-1", "e1");

    const discarded = finalizeAborted(ctx, "topic:empty-1");

    expect(discarded).toBe(placeholder.id);
    expect(ctx.getMessageById(placeholder.id)).toBeNull();
    // La domanda dell'utente NON viene toccata: `updateLastMessage` è
    // posizionale, e dopo la cancellazione l'ultima riga è la sua.
    const thread = ctx.loadActiveThread("topic:empty-1");
    expect(thread.map(m => m.id)).toEqual(["e1-u1"]);
    expect(thread[0].content).toBe("che ore sono?");
  });

  test("mezza frase è lavoro: la bolla resta, finalizzata", async () => {
    const ctx = await createTestAppContext();
    const placeholder = seedTurnInFlight(ctx, "topic:empty-2", "e2");

    const discarded = finalizeAborted(ctx, "topic:empty-2", "Sto guard");

    expect(discarded).toBeNull();
    const kept = ctx.getMessageById(placeholder.id);
    expect(kept?.content).toBe("Sto guard");
    expect(kept?.partial).toBeFalsy();
    expect(ctx.loadActiveThread("topic:empty-2").map(m => m.id)).toEqual(["e2-u1", placeholder.id]);
  });

  test("solo ragionamento, nessun testo: resta comunque", async () => {
    const ctx = await createTestAppContext();
    const placeholder = seedTurnInFlight(ctx, "topic:empty-3", "e3");

    const discarded = finalizeAborted(ctx, "topic:empty-3", "", "L'utente vuole l'ora");

    expect(discarded).toBeNull();
    expect(ctx.getMessageById(placeholder.id)?.thinking).toBe("L'utente vuole l'ora");
  });

  test("una tool call fatta è roba fatta, anche senza una parola scritta", async () => {
    const ctx = await createTestAppContext();
    const placeholder = seedTurnInFlight(ctx, "topic:empty-4", "e4");
    ctx.addToolCallToLastMessage("topic:empty-4", { id: "tc-1", name: "Read", args: { file_path: "/tmp/x" }, status: "success" });

    const discarded = finalizeAborted(ctx, "topic:empty-4");

    expect(discarded).toBeNull();
    expect(ctx.getMessageById(placeholder.id)?.toolCalls?.[0]?.name).toBe("Read");
  });

  test("scartare un rigenera rimette il ramo attivo su quello buono", async () => {
    // Rigenera: la risposta esistente è il ramo 0, il nuovo tentativo il ramo 1
    // e diventa attivo. Se lo si ferma subito, sparire NON basta: senza riparare
    // la contabilità dei rami il puntatore attivo resterebbe su un indice che
    // non esiste più e le frecce dei fratelli finirebbero a vuoto.
    const ctx = await createTestAppContext();
    ctx.saveLocalMessages("topic:empty-5", [
      msg({ id: "e5-u1", role: "user", content: "q" }),
      msg({ id: "e5-a0", role: "assistant", content: "la prima risposta", parentId: "e5-u1", branchIndex: 0 }),
    ]);
    const retry = ctx.createBranchPartialMessage("topic:empty-5", "e5-u1");
    expect(retry.branchIndex).toBe(1);

    const discarded = finalizeAborted(ctx, "topic:empty-5");

    expect(discarded).toBe(retry.id);
    const thread = ctx.loadActiveThread("topic:empty-5");
    expect(thread.map(m => m.id)).toEqual(["e5-u1", "e5-a0"]);
    // Un solo figlio superstite → niente frecce, nessun puntatore appeso.
    expect(ctx.getSiblingMessages("e5-u1").map(s => s.branchIndex)).toEqual([0]);
    expect(thread[1].siblingCount ?? 1).toBe(1);
  });
});
