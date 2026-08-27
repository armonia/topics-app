/**
 * La BARRA della sonda: ricostruire una misura presa A MANO su una chat vera.
 *
 * Il conto di una sessione reale è stato fatto a mano, guardando la UI: 46
 * messaggi, 104 chiamate a tool, ~320k di contesto, ~20,5M di prompt spediti,
 * $14,67, e un singolo turno da 3,07M. Se la sonda non ricostruisce quei numeri
 * sta misurando un'altra cosa, e il fatto che il suo output sia plausibile non
 * conta niente.
 *
 * PERCHÉ UNA FIXTURE E NON IL DATABASE VIVO. Due motivi, e il secondo è quello
 * che decide. Primo: quella chat è andata avanti — nel giro di un'ora era già a
 * 126 chiamate e 27,7M, quindi un test contro il DB vivo cambierebbe risposta
 * ogni giorno. Secondo: un test che gira solo sulla macchina di chi ha quella
 * chat non è un cancello, è un aneddoto. La fixture è il PREFISSO di 46
 * messaggi congelato (`scripts/extract-cost-probe-fixture.ts`), ridotto ai soli
 * numeri: nessun contenuto della conversazione entra in repo.
 *
 * ANONIMIZZATA, E I NUMERI RESTANO. Dalla fixture sono spariti l'id reale della
 * sessione (anche dal nome del file) e il titolo della chat: quelli sono ciò
 * che identifica, e in un repo pubblico non hanno niente da fare. I token e i
 * costi invece restano, e non è una svista. Scalarli tutti per un fattore
 * terrebbe in piedi l'aritmetica — è stato provato, e le otto asserzioni della
 * BARRA passano, perché sono tutte rapporti — ma costerebbe al test la sua
 * unica ancora: `misuraAMano` oggi è una lettura INDIPENDENTE da `rows`, e
 * scosta del 5,8% sulle chiamate, 3,3% sul contesto, 6,1% sui prompt. Scalare
 * vorrebbe dire ricavare `misuraAMano` DA `rows`, cioè far collassare quelle
 * distanze a zero: la tolleranza del 10% smetterebbe di misurare l'accordo fra
 * due fonti e misurerebbe una moltiplicazione contro sé stessa. Senza id e
 * senza titolo, quello che resta è una curva di costo che non si attacca a
 * nessuno — ed è esattamente la cosa che questa sonda esiste per calcolare.
 *
 * LA TOLLERANZA È 10%, e serve tutta: la misura a mano è stata letta da schermi
 * che arrotondano («104 chiamate» comprendeva anche i due blocchi finali senza
 * misura, «320k» era un anello). Uno scarto sotto il 10% dice che i due conti
 * parlano della stessa cosa; sotto l'1% direbbe solo che ho scritto il test
 * dopo aver visto il risultato.
 *
 * @covers USAGE-10, USAGE-11
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { basename, resolve } from "path";
import { computeCostProbe, probeSessionCost, readCostProbeRows, type CostProbeRow } from "./cost-probe";
import fixture from "../../tests/fixtures/cost-probe-46-messages.json";

/** Scarto relativo fra ciò che dice la sonda e ciò che è stato misurato a mano. */
function scarto(sonda: number, aMano: number): number {
  return Math.abs(sonda - aMano) / aMano;
}

describe("BARRA — la sonda ricostruisce la misura presa a mano su una chat reale", () => {
  const rows = fixture.rows as CostProbeRow[];
  const atteso = fixture.misuraAMano;
  const probe = computeCostProbe(rows);

  test("46 messaggi: la fixture è il prefisso giusto", () => {
    expect(probe.messages).toBe(atteso.messaggi);
  });

  test("104 chiamate a tool, scarto < 10%", () => {
    expect(probe.toolCalls).toBeGreaterThan(0);
    expect(scarto(probe.toolCalls, atteso.toolCalls)).toBeLessThan(0.1);
  });

  test("~320k di contesto, scarto < 10%", () => {
    expect(scarto(probe.contextTokens, atteso.contextTokens)).toBeLessThan(0.1);
  });

  test("~20,5M di prompt spediti, scarto < 10%", () => {
    expect(scarto(probe.promptTokens, atteso.promptTokens)).toBeLessThan(0.1);
  });

  test("$14,67 di costo, scarto < 10%", () => {
    expect(scarto(probe.costUsd, atteso.costUsd)).toBeLessThan(0.1);
  });

  test("l'ultimo turno è quello da 3,07M — sette volte l'intera conversazione salvata", () => {
    expect(probe.lastTurn).not.toBeNull();
    expect(scarto(probe.lastTurn!.promptTokens, atteso.ultimoTurnoPromptTokens)).toBeLessThan(0.1);
  });

  /**
   * Il punto di tutta la sonda, non un corollario: il costo è contesto ×
   * chiamate. Il prodotto proiettato (104 × 320k ≈ 33M) deve stare SOPRA il
   * misurato (20,5M) e nello stesso ordine di grandezza — sopra perché il
   * contesto cresceva (i primi turni costavano meno di quelli di adesso),
   * stesso ordine perché altrimenti la moltiplicazione non descrive la spesa.
   */
  test("il prodotto proiettato spiega il misurato: sopra, e nello stesso ordine di grandezza", () => {
    expect(probe.projectedTokens).toBeGreaterThan(probe.promptTokens);
    expect(probe.projectedTokens / probe.promptTokens).toBeLessThan(3);
    // Il conto fatto a mano nel task: 104 × 320k ≈ 33M.
    expect(scarto(probe.projectedTokens, atteso.toolCalls * atteso.contextTokens)).toBeLessThan(0.15);
  });
});

/** Righe sintetiche: `role` e i soli campi che la sonda guarda. */
function riga(p: Partial<CostProbeRow> & { role: "user" | "assistant" }): CostProbeRow {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costCents: 0,
    model: null,
    callTokens: [],
    ...p,
  };
}

describe("computeCostProbe — aritmetica", () => {
  test("il prodotto è contesto × chiamate, non la somma dei prompt", () => {
    const probe = computeCostProbe([
      riga({ role: "user" }),
      riga({ role: "assistant", promptTokens: 500, callTokens: [100, 200, 300] }),
    ]);
    expect(probe.contextTokens).toBe(300);
    expect(probe.toolCalls).toBe(3);
    expect(probe.projectedTokens).toBe(900);
    expect(probe.promptTokens).toBe(500);
  });

  test("il contesto è l'ULTIMA misura, non la più grande: una compattazione lo abbassa davvero", () => {
    const probe = computeCostProbe([
      riga({ role: "assistant", callTokens: [900_000] }),
      riga({ role: "assistant", callTokens: [40_000] }),
    ]);
    expect(probe.contextTokens).toBe(40_000);
  });

  test("una chiamata senza misura conta come chiamata, non come contesto", () => {
    const probe = computeCostProbe([riga({ role: "assistant", callTokens: [1000, null, null] })]);
    expect(probe.toolCalls).toBe(3);
    expect(probe.contextTokens).toBe(1000);
    expect(probe.projectedTokens).toBe(3000);
  });

  test("la misura persistita vince: è il turno in corso, che la riga del messaggio non ha ancora scritto", () => {
    const probe = computeCostProbe([riga({ role: "assistant", callTokens: [100_000] })], {
      usedTokens: 180_000,
      windowTokens: 1_000_000,
      model: "claude-opus-5",
    });
    expect(probe.contextTokens).toBe(180_000);
    expect(probe.windowTokens).toBe(1_000_000);
  });

  test("una sessione senza misure non inventa: zero, non NaN", () => {
    const probe = computeCostProbe([riga({ role: "user" })]);
    expect(probe.contextTokens).toBe(0);
    expect(probe.projectedTokens).toBe(0);
    expect(probe.perCallUsd).toBe(0);
    expect(probe.lastTurn).toBeNull();
  });

  test("l'ultimo turno salta la risposta a costo zero: il moltiplicatore resta quello del turno che è costato", () => {
    const probe = computeCostProbe([
      riga({ role: "assistant", promptTokens: 300_000, callTokens: [100_000, 120_000] }),
      // Turno interrotto prima della prima chiamata: nessun token, nessuna chiamata.
      riga({ role: "assistant" }),
    ]);
    expect(probe.lastTurn?.toolCalls).toBe(2);
    expect(probe.lastTurn?.contextTokens).toBe(120_000);
    expect(probe.lastTurn?.projectedTokens).toBe(240_000);
  });

  test("il prezzo di una chiamata in più è una rilettura di cache, non token freschi", () => {
    const probe = computeCostProbe([riga({ role: "assistant", model: "claude-opus-5", callTokens: [1_000_000] })]);
    // Opus: $5/1M in input, ×0,1 in rilettura ⇒ $0,50 per un milione riletto.
    expect(probe.perCallUsd).toBeCloseTo(0.5, 2);
  });

  test("la finestra non scende sotto la misura: un prompt servito ci stava, per definizione", () => {
    const probe = computeCostProbe([riga({ role: "assistant", model: "claude-opus-5", callTokens: [900_000] })], {
      usedTokens: 900_000,
      windowTokens: 200_000,
      model: "claude-opus-5",
    });
    expect(probe.windowTokens).toBeGreaterThanOrEqual(900_000);
  });
});

/**
 * Il pezzo che la fixture non copre: la traduzione SQL → righe.
 *
 * La fixture entra da `computeCostProbe`, cioè a valle del lettore; un errore
 * nella `SELECT` (colonna sbagliata, ordinamento per `timestamp` invece che per
 * `sort_order`, `LIMIT` che non taglia) passerebbe il test della BARRA senza
 * fare una piega. Qui il database c'è, e le righe sono quelle vere della
 * fixture rimesse dentro.
 */
function dbWithRowsOfFixture(): Database {
  const db = new Database(":memory:");
  // Le sole colonne che la sonda legge — un `messages` completo qui vorrebbe
  // dire trascinarsi dietro tutta la catena delle migration per contare
  // chiamate a tool.
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_key TEXT NOT NULL, role TEXT NOT NULL,
    tool_calls TEXT, usage_prompt_tokens INTEGER, usage_completion_tokens INTEGER,
    cache_read_tokens INTEGER, cache_creation_tokens INTEGER, cost_cents INTEGER,
    model TEXT, timestamp TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0)`);
  db.run(`CREATE TABLE session_context (
    session_key TEXT PRIMARY KEY, used_tokens INTEGER NOT NULL, window_tokens INTEGER NOT NULL,
    estimated INTEGER NOT NULL DEFAULT 0, model TEXT, measured_at TEXT NOT NULL)`);
  const ins = db.prepare(
    `INSERT INTO messages (id, session_key, role, tool_calls, usage_prompt_tokens,
       usage_completion_tokens, cache_read_tokens, cache_creation_tokens, cost_cents, model, timestamp, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  (fixture.rows as CostProbeRow[]).forEach((r, i) => {
    ins.run(
      `m${i}`, fixture.sessionKey, r.role,
      JSON.stringify(r.callTokens.map((t) => (t == null ? {} : { tokens: t }))),
      r.promptTokens, r.completionTokens, r.cacheReadTokens, r.cacheCreationTokens, r.costCents,
      r.model, `2026-08-1${i % 2}T00:00:00.000Z`, i,
    );
  });
  return db;
}

describe("probeSessionCost — dal database", () => {
  test("rilegge dalla SELECT gli stessi numeri della BARRA", () => {
    const db = dbWithRowsOfFixture();
    const probe = probeSessionCost(db, fixture.sessionKey);
    expect(probe.messages).toBe(46);
    expect(probe.toolCalls).toBe(98);
    expect(probe.contextTokens).toBe(309_335);
    expect(probe.promptTokens).toBe(19_250_777);
  });

  test("l'ordine è `sort_order`, non il timestamp: il contesto corrente è l'ULTIMO, e sbagliare ordine lo cambia", () => {
    // I timestamp della fixture rimessa dentro alternano apposta fra due giorni:
    // ordinare per data metterebbe in fondo un messaggio di metà conversazione.
    const rows = readCostProbeRows(dbWithRowsOfFixture(), fixture.sessionKey);
    expect(rows.map((r) => r.role)).toEqual((fixture.rows as CostProbeRow[]).map((r) => r.role));
  });

  test("il prefisso taglia davvero: 12 messaggi non sono 46", () => {
    const db = dbWithRowsOfFixture();
    const corto = probeSessionCost(db, fixture.sessionKey, { limitMessages: 12 });
    expect(corto.messages).toBe(12);
    expect(corto.toolCalls).toBeLessThan(98);
    expect(corto.promptTokens).toBeLessThan(19_250_777);
  });

  test("sul prefisso la misura persistita NON entra: sarebbe il contesto di adesso, fuori dalla finestra misurata", () => {
    const db = dbWithRowsOfFixture();
    db.run(`INSERT INTO session_context (session_key, used_tokens, window_tokens, estimated, model, measured_at)
            VALUES (?, 999999, 1000000, 0, 'claude-opus-5', '2026-08-11T18:00:00.000Z')`, [fixture.sessionKey]);
    expect(probeSessionCost(db, fixture.sessionKey, { limitMessages: 46 }).contextTokens).toBe(309_335);
    // Senza taglio invece vince lei: è il turno in corso.
    expect(probeSessionCost(db, fixture.sessionKey).contextTokens).toBe(999_999);
  });

  test("una sessione che non esiste non esplode", () => {
    const probe = probeSessionCost(dbWithRowsOfFixture(), "topic:non-esiste");
    expect(probe.messages).toBe(0);
    expect(probe.toolCalls).toBe(0);
    expect(probe.contextTokens).toBe(0);
  });
});

/**
 * La fixture resta ANONIMA — il cancello che rende esecutivo l'avviso scritto
 * in cima a `scripts/extract-cost-probe-fixture.ts`.
 *
 * PERCHÉ NON BASTA L'AVVISO. Quello script rigenera la fixture dal database
 * VIVO, e ciò che ne esce porta l'id reale della sessione. Fino a qui l'unica
 * difesa era prosa: un commento che dice «non committarlo così». La prosa non
 * esce non-zero. Questo sì.
 *
 * PERCHÉ NON LO PRENDE `no-personal-data-tracked.test.ts`. Quel cancello cerca
 * NOMI (li deriva da `id -F`, da git, da `.personal-terms`), e qui il dato non
 * è un nome: è un id, un titolo di chat e una cifra. Due cancelli, due
 * domande diverse — vedi il commento sull'esenzione lì.
 *
 * L'ID NON È SCRITTO QUI, per la stessa ragione per cui non ci sono i nomi
 * nell'altro cancello: incollarlo dentro il test sarebbe la fuga che il test
 * vuole impedire, in un file in più. Si cerca la FORMA di un id, non il valore.
 */
describe("la fixture resta anonima", () => {
  const percorso = resolve(import.meta.dir, "..", "..", "tests/fixtures/cost-probe-46-messages.json");
  const testo = readFileSync(percorso, "utf8");

  /** La forma di un id di sessione vero: `topic:` + una corsa di esadecimale. */
  const ALIVE_ID = /topic:[0-9a-f]{8}/i;

  test("nessun id di sessione reale, né nel file né nel suo nome", () => {
    // `topic:fixture-barra` passa: «fixture» non è tutto esadecimale. Un
    // `topic:` seguito da otto cifre esadecimali no — ed è esattamente la forma
    // che uscirebbe da una rigenerazione contro il database vivo.
    expect(ALIVE_ID.test(testo)).toBe(false);
    expect(ALIVE_ID.test(percorso.replace(/[/\\]/g, ":"))).toBe(false);
    expect(/[0-9a-f]{8}/i.test(basename(percorso))).toBe(false);
  });

  test("la `note` non rimanda al database vivo né a un titolo di chat", () => {
    // «database vivo» lega la misura alla macchina di chi l'ha estratta; le
    // virgolette caporali sono la forma in cui il titolo della chat era citato.
    const note = String((JSON.parse(testo) as { note?: unknown }).note ?? "");
    expect(note.length).toBeGreaterThan(40);
    expect(note.toLowerCase()).not.toContain("database vivo");
    expect(note).not.toMatch(/«[^»]+»/);
  });

  test("il cancello sta guardando davvero il file, non una stringa vuota", () => {
    // Se il percorso cambiasse e la lettura tornasse vuota, i test sopra
    // passerebbero misurando niente: il modo più comune in cui un cancello
    // smette di guardare senza che nessuno se ne accorga.
    expect(testo.length).toBeGreaterThan(1000);
    expect(JSON.parse(testo).rows).toHaveLength(46);
  });
});
