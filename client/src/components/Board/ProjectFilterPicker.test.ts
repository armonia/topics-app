/**
 * IL FONDINO DEVE ESISTERE IN TUTTI E DUE I TEMI.
 *
 * Il fondino e' l'unica cosa che dice, a chi guarda la riga dei filtri, che i
 * progetti in fila SONO il selettore sporto sulla riga e non dei chip capitati
 * li' accanto. Nato `border-white/15 bg-white/[0.05]`, era bianco su bianco in
 * tema chiaro: c'era nel DOM, si misurava, e non si vedeva. Rimandato indietro
 * tre volte con la stessa frase, «ancora non sono wrappati dal selettore»,
 * mentre il codice sembrava a posto ogni volta che lo si rileggeva.
 *
 * La REGOLA in cima a `client/src/index.css` lo dice gia' a parole: un rialzo
 * si dichiara `bg-black/N dark:bg-white/N`, oppure con i token opachi. Quella
 * regola pero' vive in un commento, e un commento non ferma niente. Questo e'
 * il pezzo che la fa valere sul punto dove si e' gia' rotta.
 *
 * Controllo sul SORGENTE, con lo stesso metodo e lo stesso motivo di
 * `Card.test.ts`: `ProjectFilterPicker.tsx` importa per alias `@/`, che
 * `bun test` non risolve, quindi il componente qui non si monta.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'ProjectFilterPicker.tsx'),
  'utf8',
);

/** La riga del fondino: quella con il suo testid, che e' il suo nome proprio. */
const shellLine = src
  .split('\n')
  .find((l) => l.includes('rounded-md border') && l.includes('bg-'))
  ?? '';

describe('il fondino del selettore progetto', () => {
  test("esiste, ed e' l'elemento che porta il testid", () => {
    expect(src).toContain('data-testid="project-filter-shell"');
    expect(shellLine).not.toBe('');
  });

  test("non e' bianco su bianco: ogni rialzo dichiara il tema chiaro", () => {
    // `bg-white/N` BARE (senza la meta' `bg-black/N` che copre il chiaro) e'
    // esattamente il difetto che ha fatto sparire il fondino.
    const bareWhiteFill = /(?<!dark:)bg-white\//.test(shellLine);
    expect(bareWhiteFill).toBe(false);
    expect(shellLine).toContain('dark:bg-white/');
    expect(shellLine).toContain('bg-black/');
  });

  test("il bordo usa il token che i due temi risolvono da se'", () => {
    // La variante `-light`, non il bordo base: in chiaro il base vale 91,4%
    // di lightness su fondo 93 e sparisce di nuovo, in scuro e' piu' debole
    // del bianco/15 che sostituisce. Vedi il commento nel componente.
    expect(shellLine).toContain('border-app-border-light');
    expect(shellLine.includes('border-white/')).toBe(false);
  });

  test('sta dietro: non ruba i click e non entra in nessuna misura', () => {
    // Se il fondino intercettasse gli eventi, coprirebbe il chip che avvolge;
    // se entrasse nel flusso, falserebbe la misura di quanti chip ci stanno.
    expect(shellLine).toContain('pointer-events-none');
    expect(shellLine).toContain('absolute');
  });

  test('non passa rasente ai chip: ha respiro anche in verticale', () => {
    // `inset-y-0` faceva il fondino alto ESATTAMENTE quanto i chip (l'ospite
    // non ha padding verticale: la barra e' alta 36px e un e2e lo verifica).
    // Un riquadro che tocca il suo contenuto si legge come un allineamento
    // sbagliato, non come un raggruppamento. Sporge fuori dal flusso, dentro
    // il `py-1.5` della barra: nessun pixel in piu' di altezza.
    expect(shellLine).toContain('-inset-y-');
    expect(shellLine.includes('inset-y-0')).toBe(false);
  });
});

/**
 * LE DIMENSIONI DENTRO IL RIQUADRO.
 *
 * Segnalato dopo che il fondino si vedeva: «dovrebbero essere ben spaziate,
 * eventualmente qualcosa piu' piccolo o piu' grande, e tutto consistente in
 * termini di dimensioni». Erano tre misure diverse per lo stesso oggetto, e
 * nessuna si nota da sola: si nota il risultato, cioe' una fila che non e'
 * incolonnata.
 */
describe('i chip del selettore hanno una misura sola', () => {
  test('una sola larghezza massima, non due', () => {
    // Erano `max-w-[11rem]` sul chip che apre il menu e `max-w-[13rem]` sui
    // suggerimenti: lo stesso nome troncato a due misure nella stessa riga.
    const larghezze = new Set(src.match(/max-w-\[[^\]]+\]/g) ?? []);
    expect(larghezze.size).toBe(1);
  });

  test("la scatola dell'icona e' una sola, e la riserva sempre", () => {
    // `ProjectFavicon` disegna il fallback NUDO, senza larghezza riservata:
    // col punto da 6px al posto dell'icona da 12, i chip senza icona
    // rientravano di meta'. La scatola sta fuori dal favicon.
    expect(src).toContain('const ICON_BOX = 12');
    expect(src).toContain('function ChipIcon');
    // Nessun chip disegna piu' il favicon (o il suo ripiego) per conto suo.
    expect(src.includes('<ProjectFavicon path={p.path}')).toBe(false);
    expect(src.includes('<ProjectFavicon path={soleProject.path}')).toBe(false);
  });
});
