/**
 * THE ROW THAT COUNTS A DELIVERY'S ROUNDS, and the two ways it miscounted.
 *
 * The count exists so the boot resume can stop restarting the SAME round for
 * ever (`MAX_DELIVERY_ROUNDS`, routes/tasks.ts). Which makes every way of
 * counting the WRONG round a way of giving up on a delivery that never had one.
 *
 * @covers KANBAN-87
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { bumpPendingDeliveryRound, forgetPendingDelivery, loadPendingDeliveries, savePendingDelivery } from "./pending-delivery-store";

/** migration 20260915230316 + 20260917003149. */
function freshDb(withRounds = true): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE pending_deliveries (
    task_id TEXT PRIMARY KEY, pathname TEXT NOT NULL, body_json TEXT NOT NULL,
    commit_sha TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    ${withRounds ? ", rounds INTEGER NOT NULL DEFAULT 0" : ""}
  )`);
  return db;
}

const save = (db: Database, commit: string | null) =>
  savePendingDelivery(db, { taskId: "card", pathname: "/api/sessions/s1/tasks/card", body: { status: "review" }, commit });
const rounds = (db: Database) =>
  (db.prepare("SELECT rounds FROM pending_deliveries WHERE task_id = 'card'").get() as { rounds: number } | null)?.rounds ?? null;

describe("il conteggio dei giri", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test("i giri si accumulano finche' la consegna e' la stessa", () => {
    save(db, "aaa");
    expect(rounds(db)).toBe(0);
    expect(bumpPendingDeliveryRound(db, "card")).toBe(1);
    save(db, "aaa");
    expect(rounds(db)).toBe(1);
    expect(bumpPendingDeliveryRound(db, "card")).toBe(2);
  });

  test("un commit nuovo azzera il conto: e' un'altra consegna", () => {
    save(db, "aaa");
    bumpPendingDeliveryRound(db, "card");
    bumpPendingDeliveryRound(db, "card");
    save(db, "bbb");
    expect(rounds(db)).toBe(0);
  });

  /**
   * IL CASO CHE BRUCIA I GIRI PIU' FACILMENTE E' PROPRIO QUELLO SENZA COMMIT.
   *
   * La gamba `interrupted` della rotta scrive la riga mentre il server sta
   * uscendo, PRIMA che il checkout sia risolto: `commit_sha` resta NULL, e ogni
   * boot successivo ne brucia un giro. Se un NULL memorizzato conta come
   * «stessa consegna», la consegna VERA che arriva dopo - con un commit suo -
   * eredita quei giri e viene abbandonata senza averne fatto nemmeno uno.
   */
  test("una riga nata senza commit non spende i giri della consegna dopo", () => {
    save(db, null);
    expect(bumpPendingDeliveryRound(db, "card")).toBe(1);
    expect(bumpPendingDeliveryRound(db, "card")).toBe(2);
    expect(bumpPendingDeliveryRound(db, "card")).toBe(3);
    save(db, "bbb");
    expect(rounds(db)).toBe(0);
    expect(loadPendingDeliveries(db)[0]!.commit).toBe("bbb");
  });

  test("una gamba senza commit non cancella quello gia' letto, ne' azzera il conto", () => {
    save(db, "aaa");
    bumpPendingDeliveryRound(db, "card");
    save(db, null);
    expect(loadPendingDeliveries(db)[0]!.commit).toBe("aaa");
    expect(rounds(db)).toBe(1);
  });

  test("senza riga il conteggio e' zero, non un errore", () => {
    expect(bumpPendingDeliveryRound(db, "mai-esistita")).toBe(0);
    save(db, "aaa");
    forgetPendingDelivery(db, "card");
    expect(loadPendingDeliveries(db)).toEqual([]);
  });
});

/**
 * UN DB CHE LA MIGRATION NON HA RAGGIUNTO (un ripristino da backup) NON PERDE
 * LE CONSEGNE.
 *
 * Nominare `rounds` in un `ON CONFLICT` fa lanciare SQLite al PREPARE, e il
 * `catch` che protegge questa tabella si mangerebbe la scrittura intera: la
 * riga non verrebbe mai scritta e ogni riavvio perderebbe la sua consegna. La
 * promessa del docstring - perdere la riga costa un riallineamento, lanciare
 * costa la consegna - vale anche li'.
 */
test("senza la colonna rounds la riga si scrive lo stesso", () => {
  const db = freshDb(false);
  save(db, "aaa");
  expect(loadPendingDeliveries(db)).toEqual([{
    taskId: "card", pathname: "/api/sessions/s1/tasks/card", body: { status: "review" }, commit: "aaa",
  }]);
  // E il contatore risponde zero, cioe' «riparti come prima che la tabella
  // contasse»: il boot riprende la consegna invece di rinunciarci.
  expect(bumpPendingDeliveryRound(db, "card")).toBe(0);
});
