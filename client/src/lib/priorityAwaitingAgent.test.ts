/**
 * «PRIORITÀ AUTO» SCADE QUANDO IL TASK PARTE.
 *
 * Segnalato guardando la scheda di un task in lavorazione da 17 minuti: il chip
 * diceva ancora «Priorità auto». Non è un dettaglio estetico — è una promessa
 * («la valuta l'agent appena inquadra il task») fatta su un momento che è già
 * passato, e nel frattempo nasconde il valore in vigore.
 *
 * La priorità ordina la CODA. Dopo il dispatch non ordina più niente.
 */
import { describe, expect, test } from 'bun:test';
import { priorityAwaitingAgent } from './board';

const t = (status: string, priorityAuto: boolean) =>
  ({ status, priorityAuto }) as Parameters<typeof priorityAwaitingAgent>[0];

describe('priorityAwaitingAgent', () => {
  test('in coda e senza scelta: la promessa vale', () => {
    expect(priorityAwaitingAgent(t('backlog', true))).toBe(true);
    expect(priorityAwaitingAgent(t('todo', true))).toBe(true);
  });

  test('partito: la promessa è scaduta, si mostra il valore vero', () => {
    // È il caso segnalato.
    expect(priorityAwaitingAgent(t('in_progress', true))).toBe(false);
    expect(priorityAwaitingAgent(t('review', true))).toBe(false);
    expect(priorityAwaitingAgent(t('done', true))).toBe(false);
  });

  test('scelta da qualcuno: non è mai «auto», in nessuno stato', () => {
    for (const s of ['backlog', 'todo', 'in_progress', 'review', 'done']) {
      expect(priorityAwaitingAgent(t(s, false))).toBe(false);
    }
  });
});
