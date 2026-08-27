/**
 * Lo scorporo della cache nel piede di un messaggio.
 *
 * Perché esiste. Il piede mostrava `<durata> · <token> · $<costo>` e il numero dei
 * token è dominato dalle RILETTURE: in un turno agentico lungo lo stesso prompt
 * viene riletto dalla cache a ogni chiamata al modello e si arriva a milioni su una
 * finestra da 200k. Il commento nel componente lo spiegava già a parole — non
 * poteva mostrare il numero, perché il server lo calcolava per il prezzo e lo
 * buttava (`routes/chat.ts`, e solo nel ramo in cui il provider NON dà il costo,
 * cioè quasi mai su claude-code). Ora il numero c'è, e questa funzione è la parte
 * che si può sbagliare.
 *
 * Le tre trappole che i test fissano:
 *   1. "non lo sappiamo" ≠ "nessuna cache" — un `?? 0` renderebbe indistinguibili
 *      un messaggio vecchio e un turno senza cache, e farebbe sembrare che milioni
 *      di token di rilettura non siano mai esistiti.
 *   2. quote DISGIUNTE — `write1h` NON è dentro `write5m`: sommarle è contarle due
 *      volte (stessa convenzione di `usage/pricing.ts`).
 *   3. il fresco è il RESTO, non un dato — è la sola definizione che fa tornare i
 *      conti a `prompt` anche quando il provider arrotonda fra chiamate.
 *
 * @covers USAGE-02, USAGE-04
 */
import { describe, test, expect } from 'bun:test';
import { cacheBreakdown, costBreakdown } from './cacheBreakdown';

describe('cacheBreakdown — noto contro non noto', () => {
  test('senza cacheReadTokens NON è noto: nessuno scorporo inventato', () => {
    const bd = cacheBreakdown({ promptTokens: 500_000 });
    expect(bd.known).toBe(false);
    // I numeri restano a zero, ma `known: false` è ciò che impedisce alla UI di
    // presentarli come una misura.
    expect(bd.read).toBe(0);
    expect(bd.pct).toBe(0);
  });

  test('cacheReadTokens a ZERO è noto: misurato, nessuna rilettura', () => {
    const bd = cacheBreakdown({ promptTokens: 1000, cacheReadTokens: 0 });
    expect(bd.known).toBe(true);
    expect(bd.read).toBe(0);
    expect(bd.fresh).toBe(1000);
    expect(bd.pct).toBe(0);
  });

  test('null è non noto, 0 è noto — la differenza è tutto il punto', () => {
    expect(cacheBreakdown({ promptTokens: 10, cacheReadTokens: null }).known).toBe(false);
    expect(cacheBreakdown({ promptTokens: 10, cacheReadTokens: undefined }).known).toBe(false);
    expect(cacheBreakdown({ promptTokens: 10, cacheReadTokens: 0 }).known).toBe(true);
  });
});

describe('cacheBreakdown — le quattro quote sommano al prompt', () => {
  test('il caso reale di un turno agentico: quasi tutto è rilettura', () => {
    const bd = cacheBreakdown({
      promptTokens: 2_000_000,
      cacheReadTokens: 1_950_000,
      cacheCreationTokens: 40_000,
      cacheCreation1hTokens: 8_000,
    });
    expect(bd.fresh).toBe(2_000_000 - 1_950_000 - 40_000 - 8_000);
    expect(bd.read + bd.write5m + bd.write1h + bd.fresh).toBe(2_000_000);
    expect(bd.pct).toBe(98);
  });

  test('write1h è DISGIUNTA da write5m, non annidata', () => {
    // Se fossero annidate, il fresco risulterebbe più alto di 8000 e la somma non
    // tornerebbe: è esattamente l'errore che questa asserzione impedisce.
    const bd = cacheBreakdown({
      promptTokens: 100,
      cacheReadTokens: 50,
      cacheCreationTokens: 30,
      cacheCreation1hTokens: 10,
    });
    expect(bd.fresh).toBe(10);
    expect(bd.read + bd.write5m + bd.write1h + bd.fresh).toBe(100);
  });

  test('il fresco non va MAI negativo, anche se le quote superano il prompt', () => {
    // Capita: il provider somma l'usage di più chiamate e arrotonda. Un fresco
    // negativo avvelenerebbe la somma mostrata e, a monte, anche il prezzo.
    const bd = cacheBreakdown({
      promptTokens: 100,
      cacheReadTokens: 90,
      cacheCreationTokens: 30,
      cacheCreation1hTokens: 20,
    });
    expect(bd.fresh).toBe(0);
    // MA il clamp non ripara: rende solo mostrabile un dato impossibile. Le due
    // voci in chiaro continuano a non tornare, ed è giusto che il test lo dica
    // invece di fermarsi a `fresh === 0`. Per anni questa asserzione mancava, e
    // il caso «quote che superano il prompt» sembrava coperto proprio perché
    // c'era un test col suo nome sopra: 351 righe in produzione lo violavano.
    // La riparazione sta A MONTE (il server non scrive più quote annidate,
    // `tests/unit/no-raw-turn-usage.test.ts`); qui si registra il limite.
    expect(bd.read + bd.newTokens).not.toBe(100);
  });
});

describe('cacheBreakdown — la forma vera che il server salva', () => {
  // I numeri sono presi da una riga di produzione (messaggio b26bd2e2, topic
  // ec3137d0, 13/08/2026): un turno da 13 chiamate su opus dove la CLI ha
  // scritto in cache TUTTO a un'ora, quindi la quota a cinque minuti è zero.
  // È la forma che il footer mostra come «895k tokens · 816k da cache · 70k
  // nuovi», ed è quella che deve tornare al token.
  const REAL_ROW = {
    promptTokens: 886_404,
    completionTokens: 8_216,
    cacheReadTokens: 816_213,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 70_161,
  };

  test('le due voci mostrate sommano ESATTAMENTE al prompt', () => {
    const bd = cacheBreakdown(REAL_ROW);
    expect(bd.read).toBe(816_213);
    expect(bd.newTokens).toBe(70_191);
    expect(bd.read + bd.newTokens).toBe(REAL_ROW.promptTokens);
    expect(bd.fresh).toBe(30);
  });

  test('la forma ANNIDATA che il server scriveva rompe la somma', () => {
    // Lo stesso turno com'era salvato prima del fix: il totale di scrittura
    // copiato pari pari anche nella quota a un'ora.
    const bd = cacheBreakdown({ ...REAL_ROW, cacheCreationTokens: 70_161 });
    // Lo sforo è 70.131, non 70.161: la scrittura contata due volte vale
    // 70.161, ma 30 di quelli il clamp li recupera mangiandosi il fresco vero
    // (`fresh` va da 30 a 0). Cioè l'errore mostrato è la somma di DUE bugie
    // che si accorciano a vicenda, ed è il motivo per cui a occhio non si
    // vedeva: nessuna delle due voci sembrava assurda.
    expect(bd.fresh).toBe(0);
    expect(bd.read + bd.newTokens - REAL_ROW.promptTokens).toBe(70_131);
  });
});

describe('cacheBreakdown — riletto contro nuovo, le due voci mostrate', () => {
  test('le scritture in cache stanno coi NUOVI, e le due voci sommano al prompt', () => {
    // Erano token freschi, pagati di più (×1,25, ×2 a un'ora) per essere
    // memorizzati: contarle come cache farebbe sembrare un risparmio quello che
    // è un anticipo — la stessa scelta che fa `costBreakdown`.
    const bd = cacheBreakdown({
      promptTokens: 2_000_000,
      cacheReadTokens: 1_950_000,
      cacheCreationTokens: 40_000,
      cacheCreation1hTokens: 8_000,
    });
    expect(bd.newTokens).toBe(2_000 + 40_000 + 8_000);
    expect(bd.read + bd.newTokens).toBe(2_000_000);
  });

  test('senza scritture il nuovo è il fresco e basta', () => {
    const bd = cacheBreakdown({ promptTokens: 12_000, cacheReadTokens: 10_800 });
    expect(bd.newTokens).toBe(1_200);
    expect(bd.newTokens).toBe(bd.fresh);
  });

  test('un turno senza cache è tutto nuovo — misurato, non «non lo sappiamo»', () => {
    const bd = cacheBreakdown({ promptTokens: 5_000, cacheReadTokens: 0 });
    expect(bd.known).toBe(true);
    expect(bd.read).toBe(0);
    expect(bd.newTokens).toBe(5_000);
  });
});

describe('cacheBreakdown — la percentuale', () => {
  test('è la quota di RILETTURA sul totale letto, non sulle scritture', () => {
    const bd = cacheBreakdown({ promptTokens: 1000, cacheReadTokens: 900, cacheCreationTokens: 100 });
    expect(bd.pct).toBe(90);
  });

  test('prompt a zero non divide per zero', () => {
    expect(cacheBreakdown({ promptTokens: 0, cacheReadTokens: 0 }).pct).toBe(0);
  });

  test('arrotonda all intero: 2/3 → 67', () => {
    expect(cacheBreakdown({ promptTokens: 3, cacheReadTokens: 2 }).pct).toBe(67);
  });

  test('non supera 100 nemmeno con dati incoerenti', () => {
    const bd = cacheBreakdown({ promptTokens: 100, cacheReadTokens: 100 });
    expect(bd.pct).toBe(100);
  });
});

describe('cacheBreakdown — valori sporchi dal provider', () => {
  test('NaN e Infinity non producono numeri assurdi', () => {
    // I provider mandano NaN (prompt_tokens null → Number()) e Infinity (su abort):
    // il componente lo sapeva già per gli altri campi, e vale anche qui.
    const bd = cacheBreakdown({
      promptTokens: Number.NaN,
      cacheReadTokens: Number.POSITIVE_INFINITY,
      cacheCreationTokens: Number.NaN,
    });
    expect(Number.isFinite(bd.read)).toBe(true);
    expect(Number.isFinite(bd.fresh)).toBe(true);
    expect(Number.isFinite(bd.pct)).toBe(true);
  });

  test('un negativo dal provider viene trattato come zero, non sottratto', () => {
    const bd = cacheBreakdown({ promptTokens: 100, cacheReadTokens: -50 });
    expect(bd.read).toBe(0);
    expect(bd.fresh).toBe(100);
  });
});

describe('costBreakdown — lo scorporo del COSTO, non dei token', () => {
  test('senza scorporo dei token non riparte niente', () => {
    expect(costBreakdown({ promptTokens: 1000, costCents: 500 }).known).toBe(false);
  });

  test('senza un costo misurato non riparte niente', () => {
    // `0` non e' "gratis": e' "non misurato". Mostrare «0$ cache» direbbe una
    // cosa falsa con la stessa faccia di una vera.
    expect(costBreakdown({ promptTokens: 1000, cacheReadTokens: 900, costCents: 0 }).known).toBe(false);
    expect(costBreakdown({ promptTokens: 1000, cacheReadTokens: 900, costCents: null }).known).toBe(false);
  });

  test('le voci SOMMANO al costo misurato', () => {
    // E' l'invariante che rende la ripartizione onesta: qualunque cosa mostri,
    // deve tornare al numero che la riga ha davvero pagato.
    const cb = costBreakdown({
      promptTokens: 1_000_000, completionTokens: 20_000, costCents: 12_345,
      cacheReadTokens: 900_000, cacheCreationTokens: 50_000, cacheCreation1hTokens: 20_000,
    });
    expect(cb.known).toBe(true);
    expect(cb.cacheCents + cb.freshCents).toBeCloseTo(12_345, 6);
  });

  test('la quota di COSTO e quella di TOKEN sono numeri diversi — ed e\' il punto', () => {
    // 92,5% dei token e' rilettura, ma la rilettura costa un decimo: la sua
    // quota di SPESA e' molto piu' bassa. Il chip vecchio mostrava il primo
    // numero mentre stava accanto a un totale in dollari.
    const args = {
      promptTokens: 1_000_000, completionTokens: 10_000, costCents: 10_000,
      cacheReadTokens: 925_000, cacheCreationTokens: 50_000,
    };
    const pctToken = cacheBreakdown(args).pct;
    const cb = costBreakdown(args);
    const pctCosto = (cb.cacheCents / 10_000) * 100;
    expect(pctToken).toBe(93); // arrotondato
    expect(pctCosto).toBeLessThan(pctToken / 2);
  });

  test('la SCRITTURA in cache sta col nuovo, non con la cache', () => {
    // Scrivere in cache vuol dire che quei token erano freschi e li hai pagati
    // 1,25x (o 2x) per memorizzarli: e' un anticipo, non un risparmio.
    const cb = costBreakdown({
      promptTokens: 1_000_000, completionTokens: 0, costCents: 1000,
      cacheReadTokens: 0, cacheCreation1hTokens: 1_000_000,
    });
    expect(cb.cacheCents).toBe(0);
    expect(cb.freshCents).toBeCloseTo(1000, 6);
    expect(cb.writeCents).toBeCloseTo(1000, 6);
  });

  test('una rilettura pura si prende tutto il costo', () => {
    const cb = costBreakdown({
      promptTokens: 1_000_000, completionTokens: 0, costCents: 777,
      cacheReadTokens: 1_000_000,
    });
    expect(cb.cacheCents).toBeCloseTo(777, 6);
    expect(cb.freshCents).toBeCloseTo(0, 6);
  });

  test('un turno di sola risposta non attribuisce niente alla cache', () => {
    const cb = costBreakdown({
      promptTokens: 0, completionTokens: 5000, costCents: 400, cacheReadTokens: 0,
    });
    expect(cb.cacheCents).toBe(0);
    expect(cb.freshCents).toBeCloseTo(400, 6);
  });
});
