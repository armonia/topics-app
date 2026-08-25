/**
 * OGNI POLL DELLA PANE NATIVA PASSA DAL CANCELLO, E IL CANCELLO È ESEGUITO.
 *
 * IL GUASTO (2026-08-15). Cinque poll periodici vivono in `useTauriBrowser`, uno
 * per pane browser. Tre controllavano la visibilità, i due drain nativi
 * (`browser_take_nav_state` a 250ms e `browser_take_nav_errors` a 1s) no. Con
 * l'app in ⌘H, minimizzata o su un altro Space facevano ~300 risvegli al minuto
 * PER PANE, e le pane native non si sfrattano mai — `RESIDENCY_BUDGET.native` è
 * `Infinity` per contratto — quindi il conto non cala mai da solo.
 *
 * IL GUASTO DEL TEST, che è il motivo per cui questo file è stato riscritto. La
 * prima versione era tutta `readFileSync(...).includes(...)`: non eseguiva
 * nessun poll, quindi non poteva distinguere un cancello che FUNZIONA da un
 * cancello SCRITTO, e il suo conteggio dei recuperi contava anche la
 * DEFINIZIONE di `onDocumentVisible` (6 contro un'asserzione di `>= 5`, cioè
 * cancellare un call-site vero passava lo stesso).
 *
 * Ora il cancello è una funzione sola — `lib/shell/visibilityPoll` — e il suo
 * comportamento (zero risvegli da nascosti, UN recupero marcato al ritorno, il
 * disarmo che stacca entrambe le metà) è eseguito da `visibilityPoll.test.ts`.
 * Qui resta l'unica affermazione che riguarda QUESTO file e che un test
 * eseguibile non può fare: che i poll di questo hook siano cablati là dentro e
 * che nessuno ne apra uno a mano di fianco.
 *
 * @covers LEAK-01
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(import.meta.dir, 'useTauriBrowser.ts'), 'utf8');

describe('useTauriBrowser: i poll periodici', () => {
  test('i cinque poll sono armati dal cancello condiviso', () => {
    const armed = SOURCE.match(/startVisibilityGatedPoll\(\{/g) ?? [];
    // Se ne nasce un sesto questo numero lo fa notare — ed è l'unico posto in
    // cui aggiungerlo costa una riga di test invece di una regressione muta.
    expect(armed.length).toBe(5);
  });

  test('nessun intervallo aperto a mano di fianco al cancello', () => {
    // L'ECCEZIONE, dichiarata: il poll del PICKER di elementi (`selectPollRef`)
    // non è periodico nel senso degli altri — lo arma un gesto dell'utente su
    // una finestra che sta guardando, e si spegne da solo al primo pick. Tutto
    // il resto deve passare dal cancello.
    const offenders = SOURCE.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /(^|[^a-zA-Z])setInterval\(/.test(line))
      .filter(({ line }) => !line.includes('selectPollRef') && !line.includes('ReturnType<typeof setInterval>'))
      .map(({ line, n }) => `riga ${n}: ${line}`);
    expect(offenders).toEqual([]);
  });

  test('il drain degli errori dice al cancello quando la lettura è un RECUPERO', () => {
    // È la differenza che rende possibile scartare un errore vecchio di tutto il
    // periodo di nascondino invece di dipingerlo su una pagina che sta
    // caricando bene (vedi `pickNavError`): senza il flag, il recupero e il tick
    // periodico sarebbero la stessa lettura.
    expect(/pickNavError\(\s*events,\s*\n?\s*catchUp \?/.test(SOURCE)).toBe(true);
  });
});
