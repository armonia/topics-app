/**
 * Le quote di cache di un turno VIVO non si copiano a mano.
 *
 * ── Il guasto che questo test avrebbe fermato ───────────────────────────────
 * `TurnUsage` porta le quote come le manda l'API di Anthropic: ANNIDATE, cioè
 * `cacheCreation` è il totale scritto in cache e `cacheCreation1h` una sua
 * parte (`providers/claude/events.ts`, e la fixture `RESULT_OK` lo mostra:
 * 1.024 = 24 a cinque minuti + 1.000 a un'ora). Le colonne di `messages`
 * (migration 070) e il frame `stream:usage` (`shared/ws-outbound.ts`) usano
 * invece quote DISGIUNTE.
 *
 * Il gestore del consumo vivo in `routes/chat.ts` copiava i campi grezzi nei
 * due posti: `cacheCreationTokens: live.cacheCreation`. Su questa macchina la
 * CLI scrive in cache SEMPRE a un'ora, quindi totale e quota coincidono e la
 * stessa scrittura veniva contata due volte. In produzione: 351 righe con
 * `cache_creation_tokens = cache_creation_1h_tokens`, ~60M token di eccesso, il
 * «fresco» clampato a zero, e la striscia sotto al messaggio che mostrava «X da
 * cache · Y nuovi» con X+Y diverso dal totale che stava due voci più in là.
 * 339 di quelle righe erano già FINALIZZATE: il consuntivo non le ripara,
 * perché quando il turno muore senza `result` la UPDATE fa COALESCE e tiene il
 * valore vivo. Cioè il numero sbagliato resta lì per sempre.
 *
 * ── Perché una guardia sul SORGENTE e non solo un test sulla funzione ───────
 * La funzione che traduce annidato→disgiunto era già lì, giusta e testata
 * (`usage/turn-usage.test.ts`), e serviva al PREZZO: il prezzo infatti era
 * corretto. Non è mancato il codice, è mancato il collegamento. Un test sulla
 * funzione sarebbe rimasto verde per tutto il tempo in cui la riga salvata era
 * sbagliata. L'unica cosa che tiene fermo il collegamento è vietare i nomi
 * grezzi nel file che scrive e trasmette: chi ha bisogno di quelle quote passa
 * da `turnUsageWire` (per la riga e per il filo) o da `turnUsageParts` (per il
 * prezzo).
 *
 * @covers USAGE-04
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

/** I campi ANNIDATI: leggerli va bene, COPIARLI in un campo disgiunto no. */
const CAMPI_GREZZI = ['cacheCreation', 'cacheCreation1h'] as const;

describe('routes/chat.ts non copia a mano le quote annidate di un turno', () => {
  const src = readFileSync(join(ROOT, 'server', 'routes', 'chat.ts'), 'utf8');

  test('nessun `live.cacheCreation…`: la traduzione passa da turnUsageWire/turnUsageParts', () => {
    // `live` è l'accumulatore del turno in corso. Ogni suo uso diretto delle
    // due quote di scrittura è il guasto che stiamo impedendo: sono annidate,
    // e ogni destinazione nel repo le vuole disgiunte.
    const colpevoli = CAMPI_GREZZI
      .map((campo) => ({ campo, righe: righeCon(src, `live.${campo}`) }))
      .filter((x) => x.righe.length > 0);

    expect(
      colpevoli.map((c) => `live.${c.campo} alle righe ${c.righe.join(', ')}`),
    ).toEqual([]);
  });

  test('la porta è usata davvero: chat.ts importa e chiama turnUsageWire', () => {
    // Senza questo, il test sopra si potrebbe soddisfare cancellando il codice
    // invece di collegarlo — verde per assenza, che è il modo in cui una
    // guardia smette di guardare.
    expect(src).toContain('turnUsageWire');
    expect(righeCon(src, 'turnUsageWire(live)').length).toBeGreaterThan(0);
  });
});

describe('turnUsageWire è la sola forma che i due contratti condividono', () => {
  test('i nomi dei campi combaciano con lo schema del frame stream:usage', async () => {
    // Se qualcuno rinomina un campo nello schema WS e non qui, il frame passa
    // lo `z.looseObject` con un campo in meno e il client mostra zero: un
    // silenzio, non un errore. Il confronto lo rende rumoroso.
    const { turnUsageWire } = await import(join(ROOT, 'server', 'usage', 'turn-usage.ts'));
    const wire = turnUsageWire({
      calls: 3, prompt: 1_000, completion: 10,
      cacheRead: 800, cacheCreation: 150, cacheCreation1h: 150,
    });
    const schema = readFileSync(join(ROOT, 'shared', 'ws-outbound.ts'), 'utf8');
    const blocco = schema.slice(schema.indexOf("z.literal('stream:usage')"));
    for (const campo of Object.keys(wire)) {
      expect(blocco.slice(0, blocco.indexOf('});'))).toContain(`${campo}:`);
    }
    // E il contratto disgiunto vale sul risultato: la scrittura a un'ora non si
    // ripete nella quota a cinque minuti.
    expect(wire.cacheCreationTokens).toBe(0);
    expect(wire.cacheCreation1hTokens).toBe(150);
    expect(wire.cacheReadTokens + wire.cacheCreationTokens + wire.cacheCreation1hTokens)
      .toBeLessThanOrEqual(wire.promptTokens);
  });
});

/** I numeri di riga (1-based) su cui compare un ago. Servono al messaggio. */
function righeCon(src: string, ago: string): number[] {
  return src
    .split('\n')
    .map((riga, i) => (riga.includes(ago) ? i + 1 : 0))
    .filter((n) => n > 0);
}
