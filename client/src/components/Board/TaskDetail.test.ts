/**
 * IL DRAWER NON LEGGE LA CRONOLOGIA QUANDO NESSUNO LO GUARDA.
 *
 * `TaskDetail` interroga `/api/history?limit=200` ogni 3 secondi finché un turno
 * gira. Il tick nasceva senza cancelli, e i due che servono sono DIVERSI, per
 * cui nessuno dei due bastava da solo:
 *
 *  · `PaneKeepAlive` congela i RENDER di una pane nascosta, non gli effetti di
 *    un sottoalbero già montato: un drawer parcheggiato dietro un'altra pane
 *    continuava a leggere. Lo dice il contesto (`state/paneLiveness.ts`);
 *  · la pane VISIBILE, con la finestra in secondo piano, legge lo stesso. Lo
 *    chiudono i due fratelli in questo stesso file (il risveglio del drawer) e
 *    in `KanbanBoardPane` (quello della board), che guardano
 *    `document.visibilityState`.
 *
 * La lettura si controlla sul SORGENTE, stesso metodo e stesso motivo di
 * `Card.test.ts`: `TaskDetail.tsx` importa `@/lib/popoverStyles` e `bun test`
 * non risolve l'alias `@/`, quindi il drawer qui non si monta. Il taglio della
 * sessione fra i commenti, che è l'altra metà di questo giro, è puro e provato
 * per davvero in `sessionBuckets.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'TaskDetail.tsx'), 'utf8');

/** Il corpo del `useEffect` che monta il poll da 3s. */
const pollEffect = (() => {
  const i = src.indexOf('}, 3000);');
  const start = src.lastIndexOf('useEffect(', i);
  return src.slice(start, src.indexOf('\n', i));
})();

describe('il poll della sessione', () => {
  test('non parte se la pane non ha un box nel layout', () => {
    expect(src).toContain('usePaneAlive()');
    expect(pollEffect).toContain('!paneAlive');
  });

  test('salta il giro con la finestra nascosta, senza smontare il timer', () => {
    // Dentro il timer, non nelle dipendenze: spegnere un `setInterval` non
    // richiede un render (`state/paneLiveness.ts`, nota in coda).
    expect(pollEffect).toContain("document.visibilityState !== 'visible'");
  });

  test('al ritorno in vista recupera, sullo STESSO ascoltatore del drawer', () => {
    // Senza il recupero, il drawer resterebbe al giro che è riuscito a fare
    // prima di nascondersi finché non scade il tick: una riga di task di adesso
    // accanto a una coda di sessione di tre tick fa si legge come un agente che
    // ha smesso di parlare.
    expect(src).toContain('sessionCatchUp.current?.()');
    expect(src.match(/addEventListener\('visibilitychange'/g) ?? []).toHaveLength(1);
  });
});

describe('il taglio della sessione fra i commenti', () => {
  test('è UNA passata, non un filtro per riga', () => {
    expect(src).toContain('bucketSessionMsgs(');
    // `sliceBetween` era il filtro per riga: 200 messaggi per ogni commento, a
    // ogni giro del poll.
    expect(src.includes('sliceBetween')).toBe(false);
  });

  test('porta dentro il risultato di prima, o niente resta stabile', () => {
    expect(src).toContain('bucketsRef.current');
  });
});
