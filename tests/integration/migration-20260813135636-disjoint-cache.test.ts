/**
 * Bonifica dello storico: `20260813135636-disjoint-cache-creation.sql`.
 *
 * Le tre colonne di cache dei messaggi hanno un contratto DISGIUNTO (migration
 * 070): `cache_creation_tokens` non include `cache_creation_1h_tokens`, e le
 * quote sommate col fresco fanno `usage_prompt_tokens`. Il gestore del consumo
 * VIVO ci scriveva invece i valori annidati dell'API di Anthropic, dove il
 * primo è il TOTALE e il secondo una sua parte. Su questa macchina la CLI
 * scrive in cache sempre a un'ora, quindi le due colonne finivano UGUALI e la
 * stessa scrittura veniva contata due volte: 360 righe al momento del fix.
 *
 * Quello che conta qui non è che la migration corregga, è COSA NON TOCCA. Una
 * riga già disgiunta, una senza scorporo, una con la quota a un'ora più grande
 * del totale: nessuna deve muoversi, perché in ognuna la sottrazione o non
 * serve o inventerebbe un numero. Meglio una riga incoerente dichiarata che una
 * riga sbagliata che sembra a posto.
 *
 * Il test esegue il FILE della migration, non una sua copia: se il predicato
 * cambia, cambia sotto questi casi.
 *
 * @covers USAGE-02
 */
import { describe, expect, test, beforeAll } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { setupTestDataDir, createTestAppContext, testTmpDir, PROJECT_ROOT } from "./helpers";
import type { AppContext } from "../../server/types";

// `testTmpDir`, non un path fisso: due suite in parallelo sullo stesso path si
// cancellano i dati a vicenda, ed e' il cancello di `setupTestDataDir` a
// pretenderlo (questo file lo faceva cadere).
const TEST_DATA = testTmpDir("migration-disjoint-cache-data");

const MIGRATION_SQL = fs.readFileSync(
  path.join(PROJECT_ROOT, "server/db/migrations/20260813135636-disjoint-cache-creation.sql"),
  "utf-8",
);

beforeAll(() => setupTestDataDir(TEST_DATA));

interface Riga {
  id: string;
  prompt: number;
  read: number | null;
  creation: number | null;
  creation1h: number | null;
}

let seq = 0;

function insert(ctx: AppContext, sessionKey: string, righe: Riga[]): void {
  const stmt = ctx.db.prepare(
    `INSERT INTO messages (id, session_key, role, content, partial, timestamp, sort_order,
                           usage_prompt_tokens, cache_read_tokens,
                           cache_creation_tokens, cache_creation_1h_tokens)
     VALUES (?, ?, 'assistant', 'x', 0, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of righe) {
    stmt.run(
      r.id, sessionKey,
      new Date(Date.now() + seq * 1000).toISOString(), seq++,
      r.prompt, r.read, r.creation, r.creation1h,
    );
  }
}

function quote(ctx: AppContext, id: string): { cc: number | null; cc1h: number | null } {
  const r = ctx.db.query(
    `SELECT cache_creation_tokens AS cc, cache_creation_1h_tokens AS cc1h FROM messages WHERE id = ?`,
  ).get(id) as { cc: number | null; cc1h: number | null };
  return r;
}

describe("la riga rotta si scorpora", () => {
  test("TTL a un'ora su tutta la scrittura: il totale va a zero, la quota resta", async () => {
    const ctx = await createTestAppContext();
    // I numeri veri del messaggio b26bd2e2 (topic ec3137d0, 13/08/2026) come li
    // scriveva il path vivo: 70.161 in entrambe le colonne.
    insert(ctx, "topic:reale", [
      { id: "rotta", prompt: 886_404, read: 816_213, creation: 70_161, creation1h: 70_161 },
    ]);

    ctx.db.exec(MIGRATION_SQL);

    expect(quote(ctx, "rotta")).toEqual({ cc: 0, cc1h: 70_161 });
    // E adesso le quote ci stanno dentro il prompt, che è l'invariante che la
    // striscia sotto al messaggio usa per far tornare «X da cache · Y nuovi».
    expect(816_213 + 0 + 70_161).toBeLessThanOrEqual(886_404);
  });

  test("TTL misto: si sottrae solo l'ora, i cinque minuti restano", async () => {
    const ctx = await createTestAppContext();
    // Annidata: 300 scritti in tutto, di cui 100 a un'ora → disgiunta è 200/100.
    insert(ctx, "topic:misto", [
      { id: "mista", prompt: 1_000, read: 700, creation: 300, creation1h: 100 },
    ]);

    ctx.db.exec(MIGRATION_SQL);

    expect(quote(ctx, "mista")).toEqual({ cc: 200, cc1h: 100 });
  });
});

describe("cosa la migration NON tocca", () => {
  test("una riga GIÀ disgiunta resta com'è", async () => {
    const ctx = await createTestAppContext();
    insert(ctx, "topic:sane", [
      // Il consuntivo di fine turno scriveva già così: 5m a zero, tutto a un'ora.
      { id: "sana-1h", prompt: 886_404, read: 816_213, creation: 0, creation1h: 70_161 },
      // E una con entrambe le durate, che ci sta dentro il prompt.
      { id: "sana-mista", prompt: 1_000, read: 600, creation: 300, creation1h: 100 },
      // Scritture solo a cinque minuti: niente da scorporare.
      { id: "solo-5m", prompt: 1_000, read: 700, creation: 300, creation1h: 0 },
    ]);

    ctx.db.exec(MIGRATION_SQL);

    expect(quote(ctx, "sana-1h")).toEqual({ cc: 0, cc1h: 70_161 });
    expect(quote(ctx, "sana-mista")).toEqual({ cc: 300, cc1h: 100 });
    expect(quote(ctx, "solo-5m")).toEqual({ cc: 300, cc1h: 0 });
  });

  test("senza scorporo (provider muto) i NULL restano NULL, non diventano zero", async () => {
    const ctx = await createTestAppContext();
    // NULL significa «non lo sappiamo», 0 significa «misurato, nessuna cache».
    // Un backfill a zero renderebbe indistinguibili le due cose: è la ragione
    // per cui la 070 non ha fatto default a zero.
    insert(ctx, "topic:ignota", [
      { id: "ignota", prompt: 1_000, read: null, creation: null, creation1h: null },
    ]);

    ctx.db.exec(MIGRATION_SQL);

    expect(quote(ctx, "ignota")).toEqual({ cc: null, cc1h: null });
  });

  test("quota a un'ora MAGGIORE del totale: si lascia stare, non si inventa", async () => {
    const ctx = await createTestAppContext();
    // Forma possibile per arrotondamenti fra chiamate. Sottrarre darebbe un
    // negativo; scegliere un altro numero vorrebbe dire inventarlo. Resta
    // incoerente e dichiarata: sul DB di produzione queste righe erano zero.
    insert(ctx, "topic:perverso", [
      { id: "1h-maggiore", prompt: 100, read: 90, creation: 20, creation1h: 50 },
    ]);

    ctx.db.exec(MIGRATION_SQL);

    expect(quote(ctx, "1h-maggiore")).toEqual({ cc: 20, cc1h: 50 });
  });
});

describe("l'invariante, dopo", () => {
  test("nessun negativo e nessuna riga riparabile lasciata indietro", async () => {
    const ctx = await createTestAppContext();
    insert(ctx, "topic:tutte", [
      { id: "t1", prompt: 886_404, read: 816_213, creation: 70_161, creation1h: 70_161 },
      { id: "t2", prompt: 1_000, read: 700, creation: 300, creation1h: 100 },
      { id: "t3", prompt: 1_000, read: 600, creation: 300, creation1h: 100 },
      { id: "t4", prompt: 1_000, read: null, creation: null, creation1h: null },
      { id: "t5", prompt: 500, read: 400, creation: 90, creation1h: 90 },
    ]);

    ctx.db.exec(MIGRATION_SQL);

    const negativi = ctx.db.query(
      `SELECT COUNT(*) n FROM messages WHERE cache_creation_tokens < 0`,
    ).get() as { n: number };
    expect(negativi.n).toBe(0);

    // «Riparabile» = ancora annidata (le due colonne uguali) E ancora fuori dal
    // prompt. Zero: quelle che restano fuori sono solo le non riparabili.
    const restano = ctx.db.query(
      `SELECT COUNT(*) n FROM messages
        WHERE cache_creation_tokens IS NOT NULL
          AND cache_creation_1h_tokens > 0
          AND cache_creation_tokens >= cache_creation_1h_tokens
          AND COALESCE(cache_read_tokens,0) + cache_creation_tokens + cache_creation_1h_tokens
              > COALESCE(usage_prompt_tokens,0)`,
    ).get() as { n: number };
    expect(restano.n).toBe(0);
  });
});
