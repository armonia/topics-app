/**
 * UN MONITOR ARMATO NON È UNA COSA FINITA.
 *
 * Il tool torna SUBITO — la sua risposta è «Monitor started (task …)», cioè la
 * ricevuta dell'armamento, non l'esito dell'attesa — e il turno chiude un
 * istante dopo. La riga in chat diventava quindi una tool call verde,
 * indistinguibile da un `Read` andato bene, mentre in realtà c'era qualcosa che
 * sorvegliava un build e la risposta sarebbe arrivata fra minuti come messaggio
 * nuovo (il risveglio: `server/providers/claude/woken-turn.ts`).
 *
 * Con il turno chiuso e la card muta, l'attesa e una chat che ha smesso di
 * parlare si assomigliano troppo. Qui si misura ciò che il markup DICE: che si
 * sta ascoltando, e che la risposta arriverà da sé.
 *
 * `renderToStaticMarkup` e non un DOM: jsdom/happy-dom non sono dipendenze di
 * questo progetto (scelta dichiarata in `ThreadRuns.test.tsx` e altrove), e per
 * quello che c'è da provare — quali parole compaiono e quando — basta il markup.
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MonitorCard } from './ToolCards';

const html = (props: Parameters<typeof MonitorCard>[0]) =>
  renderToStaticMarkup(createElement(MonitorCard, props));

describe('MonitorCard', () => {
  test('armato: dice che sta in ascolto e che la risposta arriverà da sola', () => {
    // Niente `command` qui: quel ramo monta `HighlightedPre`, che si appoggia a
    // un `useSyncExternalStore` senza snapshot lato server e fa alzare il
    // renderer statico. Il comando sorvegliato è già coperto da `ToolCards`
    // altrove; quello che questo test deve provare sono le parole dell'attesa.
    const out = html({ description: 'esito build', isRunning: true });
    // Il fatto: non è finito, sta sorvegliando.
    expect(out).toContain('in ascolto');
    // E il perché la chat sembra ferma senza esserlo — è la riga che toglie
    // l'ambiguità fra «sta aspettando» e «ha smesso di rispondere».
    expect(out).toContain('come messaggio nuovo');
    // Quello che sorveglia resta visibile.
    expect(out).toContain('esito build');
  });

  test('con un esito vero la card smette di dire «in ascolto»', () => {
    // `result` qui è l'esito consegnato (una riga rimasta da una sessione
    // vecchia, o un monitor chiuso): l'attesa non è più aperta, e insistere
    // sarebbe una bugia in una riga che l'utente rilegge il giorno dopo.
    const out = html({ description: 'esito build', result: 'BUILD-FALLITO-XYZ' });
    expect(out).not.toContain('in ascolto');
    expect(out).toContain('BUILD-FALLITO-XYZ');
  });

  test('a turno fermo il pallino non pulsa: la riga si sta solo rileggendo', () => {
    // `isRunning` assente = nessun turno in volo (si sta scorrendo il
    // trascritto). Il fatto «era in ascolto» resta scritto, ma un'animazione
    // perpetua su ogni Monitor mai armato sarebbe lavoro del compositor a
    // riposo — la stessa lezione dei tre pallini di «sta scrivendo».
    const out = html({ description: 'esito build' });
    expect(out).toContain('in ascolto');
    expect(out).not.toContain('animate-pulse');
  });

  test('il turno in volo lo fa pulsare', () => {
    const out = html({ description: 'esito build', isRunning: true });
    expect(out).toContain('animate-pulse');
  });
});
