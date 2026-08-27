/**
 * I DUE PERCORSI DEVONO DARE LO STESSO NUMERO.
 *
 * Lo stesso consumo arriva in tabella per due strade completamente diverse:
 *
 *  A. TRANSCRIPT — la CLI scrive il JSONL, `transcript-usage.ts` lo legge a
 *     incrementi e il dispatcher scrive `tasks.agent_tokens` /
 *     `agent_cache_read_tokens`. È la strada di un task della board.
 *  B. STREAM — il provider emette gli eventi, `readResultUsage` li traduce,
 *     `accumulateTurnUsage` li somma e `turnUsageWire` li porta sulla riga di
 *     `messages`. È la strada di una chat.
 *
 * Le due tabelle scompongono le stesse quantità in modo DIVERSO
 * (`messages.usage_prompt_tokens` contiene già la rilettura di cache,
 * `tasks.agent_tokens` no), ed è da lì che nascevano due numeri: la card
 * mostrava il 2,8% di quello che la dashboard mostrava.
 *
 * QUESTO TEST NON FABBRICA LA RIGA A MANO. La prima versione costruiva il
 * valore di `usage_prompt_tokens` sommando la fixture, cioè verificava la
 * propria aritmetica invece del codice di produzione — e un avversario l'ha
 * demolita proprio lì: rifatta con le funzioni vere, i due percorsi NON
 * collassavano (398.374 contro 381.471). Qui ogni numero passa dalle stesse
 * funzioni che girano in produzione, e l'uguaglianza è la tesi.
 *
 * @covers USAGE-17
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranscriptUsageReader } from "../../server/services/transcript-usage";
import { readResultUsage } from "../../server/providers/claude/events";
import { accumulateTurnUsage, emptyTurnUsage, turnUsageWire } from "../../server/usage/turn-usage";
import { contextTokens, costTokens, partsFromMessage, partsFromTask } from "../../shared/token-cost";

/** Un giro di chiamate al modello, come lo vedrebbero i due lati. */
const CHIAMATE = [
  { id: "msg_1", input: 1_200, output: 800, cacheWrite: 20_000, cacheRead: 150_000 },
  { id: "msg_2", input: 300, output: 2_400, cacheWrite: 0, cacheRead: 180_000 },
  { id: "msg_3", input: 90, output: 120, cacheWrite: 4_000, cacheRead: 195_000 },
];

/** La riga che la CLI scrive nel JSONL (percorso A). */
const rowTranscript = (c: (typeof CHIAMATE)[number]) =>
  JSON.stringify({
    type: "assistant",
    message: {
      id: c.id,
      model: "claude-sonnet-5",
      usage: {
        input_tokens: c.input,
        output_tokens: c.output,
        cache_creation_input_tokens: c.cacheWrite,
        cache_read_input_tokens: c.cacheRead,
      },
    },
  }) + "\n";

/** L'evento `result` che il provider emette (percorso B). */
const eventResult = (c: (typeof CHIAMATE)[number]) => ({
  type: "result",
  usage: {
    input_tokens: c.input,
    output_tokens: c.output,
    cache_creation_input_tokens: c.cacheWrite,
    cache_read_input_tokens: c.cacheRead,
  },
});

describe("token: i due percorsi collassano su una definizione sola", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "token-one-def-"));
    path = join(dir, "session.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("percorso A (transcript) e percorso B (stream) danno lo STESSO costo", () => {
    // ── A: il lettore vero sul JSONL vero ────────────────────────────────
    writeFileSync(path, CHIAMATE.map(rowTranscript).join(""));
    const sessione = createTranscriptUsageReader().read(path);
    // Il dispatcher scrive queste due colonne, e nient'altro.
    const daTask = partsFromTask({
      agentTokens: sessione.billableTokens,
      agentCacheReadTokens: sessione.cacheReadTokens,
    });

    // ── B: il traduttore vero sugli eventi veri ──────────────────────────
    let turno = emptyTurnUsage();
    for (const c of CHIAMATE) {
      const u = readResultUsage(eventResult(c));
      turno = accumulateTurnUsage(turno, {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheRead: u.cacheRead ?? 0,
        cacheCreation: u.cacheCreation ?? 0,
        cacheCreation1h: u.cacheCreation1h ?? 0,
      });
    }
    // `turnUsageWire` è la porta da cui passa CHI PERSISTE: sono esattamente i
    // valori che finiscono nelle colonne di `messages`.
    const wire = turnUsageWire(turno);
    const daMessaggio = partsFromMessage({
      usagePromptTokens: wire.promptTokens,
      usageCompletionTokens: wire.completionTokens,
      cacheReadTokens: wire.cacheReadTokens,
    });

    // La tesi: stesso consumo, stesso numero, da qualunque parte lo si guardi.
    expect(daMessaggio).toEqual(daTask);
    expect(costTokens(daMessaggio)).toBe(costTokens(daTask));
    expect(contextTokens(daMessaggio)).toBe(contextTokens(daTask));

    // E i numeri sono quelli attesi, così un cambio di formula si vede qui.
    expect(daTask.billable).toBe(1_590 + 3_320 + 24_000); // input + output + cacheWrite
    expect(daTask.cacheRead).toBe(525_000);
    expect(costTokens(daTask)).toBe(81_410);
  });

  test("la RILETTURA non sparisce e non vale come un token fresco", () => {
    // I due errori opposti, in un test solo: la vecchia card la buttava via
    // (mostrava 28.910 su 553.910 passati), la vecchia dashboard la contava a
    // prezzo pieno.
    writeFileSync(path, CHIAMATE.map(rowTranscript).join(""));
    const s = createTranscriptUsageReader().read(path);
    const parts = partsFromTask({ agentTokens: s.billableTokens, agentCacheReadTokens: s.cacheReadTokens });

    expect(costTokens(parts)).toBeGreaterThan(parts.billable);        // non buttata via
    expect(costTokens(parts)).toBeLessThan(contextTokens(parts));      // non a prezzo pieno
  });
});

describe("nessuna superficie ha una formula sua", () => {
  /**
   * Il difetto non era una formula sbagliata: erano TRE formule, ognuna scritta
   * dove serviva. La regressione da impedire non è «il numero cambia», è «uno
   * dei posti torna a calcolarselo da sé» — ed è successo di nuovo mentre si
   * unificava, su due superfici che prima combaciavano.
   */
  const SUPERFICI = [
    "client/src/components/Board/Card.tsx",
    "client/src/components/Chat/MessageMetaFooter.tsx",
    "client/src/components/MessageParts.tsx",
    "server/routes/dashboard.ts",
  ];

  for (const f of SUPERFICI) {
    test(`${f} chiede il numero alla regola, non se lo calcola`, async () => {
      const src = await Bun.file(`${import.meta.dir}/../../${f}`).text();
      expect(src).toMatch(/token-cost|token-sql/);
    });
  }

  test("e nessuna di loro somma prompt e completion per conto suo", async () => {
    // La firma della vecchia formula, nelle due grafie in cui compariva.
    const vecchia = [
      /promptTokens\s*\?\?\s*0\)\s*\+\s*\(completionTokens/,
      /usage_prompt_tokens,\s*0\)\s*\+\s*COALESCE\(usage_completion_tokens/,
    ];
    for (const f of SUPERFICI) {
      const src = await Bun.file(`${import.meta.dir}/../../${f}`).text();
      for (const re of vecchia) {
        expect(re.test(src), `${f} contiene ancora la vecchia formula ${re}`).toBe(false);
      }
    }
  });
});
