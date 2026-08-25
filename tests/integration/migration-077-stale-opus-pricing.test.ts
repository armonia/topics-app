/**
 * Bonifica dello storico: `077-fix-stale-opus-pricing.sql`.
 *
 * `server/usage/pricing.ts` non conteneva nessun modello in uso, quindi ogni
 * Opus cadeva sul ripiego di famiglia e veniva tariffato 15$/75$ per milione
 * invece dei 5$/25$ veri: il TRIPLO. La migration divide per tre — e la parte
 * che conta non è la divisione, è QUALI righe la prendono.
 *
 * Il modello non è salvato sulla riga (la colonna arriva con la 076, senza
 * backfill), quindi la migration deduce il prezzo applicato dividendo il costo
 * per le quote pesate. Il rischio è tutto lì: dedurre male e dividere per tre
 * una riga già giusta — un errore che nessuno noterebbe, perché il numero
 * sbagliato ha lo stesso aspetto di quello giusto. Questi casi fissano i confini
 * della deduzione: chi entra, chi resta fuori, e perché.
 *
 * Il test esegue il FILE della migration, non una sua copia.
  * @covers SCHEMA-07
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { PROJECT_ROOT } from "./helpers";

const MIGRATION_SQL = fs.readFileSync(
  path.join(PROJECT_ROOT, "server/db/migrations/077-fix-stale-opus-pricing.sql"),
  "utf-8",
);

/** Le stesse tariffe di `pricing.ts`, per costruire righe realistiche. */
const OUT_RATIO = 5;
const W_READ = 0.1;
const W_5M = 1.25;
const W_1H = 2;

interface Turn {
  id: string;
  prompt: number;
  completion: number;
  read: number | null;
  write5m?: number;
  write1h?: number;
  /** Il prezzo di input ($/1M) col quale la riga è stata tariffata all'epoca. */
  pricedAt: number;
  toolCalls?: unknown[];
  blocks?: unknown[];
}

/** Il costo che il server AVREBBE scritto tariffando a `pricedAt`. */
function costCentsFor(t: Turn): number {
  const read = t.read ?? 0;
  const w5 = t.write5m ?? 0;
  const w1h = t.write1h ?? 0;
  // Prima della 070 la cache non era separata: tutto il prompt contava fresco.
  const fresh = t.read === null ? t.prompt : Math.max(0, t.prompt - read - w5 - w1h);
  const units = t.read === null
    ? fresh + t.completion * OUT_RATIO
    : fresh + read * W_READ + w5 * W_5M + w1h * W_1H + t.completion * OUT_RATIO;
  return Math.round(((units * t.pricedAt) / 1_000_000) * 100);
}

/** Un DB minimo con la sola forma che la migration tocca. */
function seed(turns: Turn[]): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    cost_cents INTEGER,
    usage_prompt_tokens INTEGER,
    usage_completion_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_creation_tokens INTEGER,
    cache_creation_1h_tokens INTEGER,
    tool_calls TEXT,
    blocks TEXT
  )`);
  const stmt = db.prepare(
    `INSERT INTO messages (id, cost_cents, usage_prompt_tokens, usage_completion_tokens,
                           cache_read_tokens, cache_creation_tokens, cache_creation_1h_tokens,
                           tool_calls, blocks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const t of turns) {
    stmt.run(
      t.id,
      costCentsFor(t),
      t.prompt,
      t.completion,
      t.read,
      t.read === null ? null : (t.write5m ?? 0),
      t.read === null ? null : (t.write1h ?? 0),
      t.toolCalls ? JSON.stringify(t.toolCalls) : null,
      t.blocks ? JSON.stringify(t.blocks) : null,
    );
  }
  return db;
}

const costOf = (db: Database, id: string): number =>
  (db.query("SELECT cost_cents c FROM messages WHERE id = ?").get(id) as { c: number }).c;

const jsonOf = (db: Database, id: string, col: "tool_calls" | "blocks"): unknown => {
  const raw = (db.query(`SELECT ${col} v FROM messages WHERE id = ?`).get(id) as { v: string | null }).v;
  return raw === null ? null : JSON.parse(raw);
};

/** Una riga Opus grande e realistica: quasi tutto rilettura, come un turno vero. */
const opus = (id: string, extra: Partial<Turn> = {}): Turn => ({
  id, prompt: 2_000_000, completion: 20_000, read: 1_900_000, write5m: 50_000, write1h: 20_000,
  pricedAt: 15, ...extra,
});

describe("migration 077 — il costo Opus era il triplo", () => {
  test("una riga tariffata a 15$ viene divisa per tre", () => {
    const db = seed([opus("a")]);
    const prima = costOf(db, "a");
    db.exec(MIGRATION_SQL);
    expect(costOf(db, "a")).toBe(Math.round(prima / 3));
  });

  test("una riga GIA' giusta non viene toccata", () => {
    // E' il caso che fa più danno se la deduzione sbaglia: dividere per tre un
    // costo corretto lo rende sbagliato, con lo stesso aspetto di prima.
    const db = seed([opus("giusta", { pricedAt: 5 })]);
    const prima = costOf(db, "giusta");
    db.exec(MIGRATION_SQL);
    expect(costOf(db, "giusta")).toBe(prima);
  });

  test("Sonnet non cambia tariffa, quindi non cambia costo", () => {
    const db = seed([opus("sonnet", { pricedAt: 3 })]);
    const prima = costOf(db, "sonnet");
    db.exec(MIGRATION_SQL);
    expect(costOf(db, "sonnet")).toBe(prima);
  });

  test("Haiku sale del 25%: 0,80$ era sotto il vero, non sopra", () => {
    const db = seed([opus("haiku", { pricedAt: 0.8 })]);
    const prima = costOf(db, "haiku");
    db.exec(MIGRATION_SQL);
    // Dividere per 0,8 = moltiplicare per 1,25.
    expect(costOf(db, "haiku")).toBe(Math.round(prima / 0.8));
  });

  test("le righe PRE-070 restano dov'erano: il loro errore è di fattore IGNOTO", () => {
    // Senza lo scorporo della cache il costo è sbagliato due volte — il prezzo
    // (×3) e la cache contata come input fresco (fino a ~10×) — e il secondo
    // fattore non è ricostruibile. Correggerne metà darebbe un numero ancora
    // sbagliato, ma con l'aria di essere stato sistemato.
    const db = seed([opus("vecchia", { read: null })]);
    const prima = costOf(db, "vecchia");
    db.exec(MIGRATION_SQL);
    expect(costOf(db, "vecchia")).toBe(prima);
  });

  test("un costo che non cade su nessuna tariffa nota resta intatto", () => {
    // E' il costo arrivato dal provider (`total_cost_usd`), che è già giusto e
    // non passa dalla nostra tabella.
    const db = seed([opus("provider", { pricedAt: 7.3 })]);
    const prima = costOf(db, "provider");
    db.exec(MIGRATION_SQL);
    expect(costOf(db, "provider")).toBe(prima);
  });

  test("i costi PER TOOL scalano insieme all'intestazione", () => {
    // Correggere solo il totale lascerebbe le righe dei tool a sommare il triplo
    // del numero che le sovrasta.
    const db = seed([opus("tool", {
      toolCalls: [
        { id: "t1", name: "Bash", costCents: 300, tokens: 100 },
        { id: "t2", name: "Read" },
      ],
      blocks: [
        { kind: "tool", toolCall: { id: "t1", name: "Bash", costCents: 300 } },
        { kind: "text", text: "ciao" },
      ],
    })]);
    db.exec(MIGRATION_SQL);

    const tc = jsonOf(db, "tool", "tool_calls") as Array<Record<string, unknown>>;
    expect(Array.isArray(tc)).toBe(true);
    expect(tc[0].costCents).toBe(100);
    expect(tc[0].name).toBe("Bash");
    expect(tc[0].tokens).toBe(100); // gli altri campi passano invariati
    expect(tc[1]).toEqual({ id: "t2", name: "Read" }); // chi non ha costo non cambia

    const bl = jsonOf(db, "tool", "blocks") as Array<Record<string, unknown>>;
    expect((bl[0].toolCall as Record<string, unknown>).costCents).toBe(100);
    expect(bl[1]).toEqual({ kind: "text", text: "ciao" });
  });

  test("il JSON resta un ARRAY, non un array di stringhe", () => {
    // `json_group_array(value)` invece di `json_group_array(json(value))`
    // ri-quoterebbe ogni oggetto: il thread resterebbe leggibile dal DB e
    // illeggibile dal client.
    const db = seed([opus("forma", { toolCalls: [{ id: "t1", costCents: 300 }] })]);
    db.exec(MIGRATION_SQL);
    const raw = (db.query("SELECT tool_calls v FROM messages WHERE id = 'forma'").get() as { v: string }).v;
    expect(raw.startsWith("[{")).toBe(true);
    expect(JSON.parse(raw)[0]).toBeTypeOf("object");
  });

  test("un JSON assente o non conforme non fa fallire la migration", () => {
    const db = seed([
      opus("senza-json"),
      opus("json-rotto", { toolCalls: undefined }),
    ]);
    db.exec("UPDATE messages SET tool_calls = 'non-json' WHERE id = 'json-rotto'");
    expect(() => db.exec(MIGRATION_SQL)).not.toThrow();
    expect(jsonOf(db, "senza-json", "tool_calls")).toBe(null);
    expect((db.query("SELECT tool_calls v FROM messages WHERE id = 'json-rotto'").get() as { v: string }).v).toBe("non-json");
    // ...ma il COSTO delle due righe è stato corretto lo stesso.
    expect(costOf(db, "senza-json")).toBe(Math.round(costCentsFor(opus("x")) / 3));
  });

  test("un costo minuscolo non viene azzerato dall'arrotondamento", () => {
    // `MAX(1, ...)`: una riga che è costata qualcosa non deve diventare gratis.
    const db = seed([{ id: "micro", prompt: 200, completion: 1, read: 100, pricedAt: 15 }]);
    db.exec("UPDATE messages SET cost_cents = 1 WHERE id = 'micro'");
    db.exec(MIGRATION_SQL);
    expect(costOf(db, "micro")).toBeGreaterThanOrEqual(1);
  });

  test("rieseguirla non ri-divide: la seconda passata è un no-op", () => {
    // Le migration girano una volta sola per costruzione, ma una bonifica di
    // dati che non è idempotente è una mina se qualcuno la riapplica a mano.
    const db = seed([opus("due-volte")]);
    db.exec(MIGRATION_SQL);
    const dopoUna = costOf(db, "due-volte");
    db.exec(MIGRATION_SQL);
    expect(costOf(db, "due-volte")).toBe(dopoUna);
  });
});
