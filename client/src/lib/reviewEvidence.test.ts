import { describe, test, expect } from 'bun:test';
import { reviewEvidence } from './reviewEvidence';

/**
 * UNA CARD IN REVIEW DEVE DIRE COSA SI STA APPROVANDO.
 *
 * Segnalato: «quelli in review non mi sembrano pronti da sistema per essere
 * fatti review da me, sembrano solo i task spostati, ma una volta in review
 * dovrei vedere aggiornamenti, no?» — e subito dopo: «forse non sono manco
 * mergiati, o non abbiamo gestito in termini di UI come si differenzia il
 * workflow fra i progetti».
 *
 * Misurato sul database vero il 17/08: 33 card in review, 31 senza fotografia
 * di consegna, e di quelle 30 senza nemmeno una sessione agente. La card non
 * mostrava niente, e quel niente voleva dire tre cose diverse:
 *
 *   1. un agente kanban ha lavorato su un ramo isolato e la misura c'è;
 *   2. il lavoro è stato fatto sul checkout condiviso (in-place): i commit
 *      esistono ma stanno su `main`, dove «commit propri di questa card» non
 *      è una domanda che git sappia rispondere;
 *   3. nessuno ha lavorato: la card è stata trascinata in review a mano.
 *
 * Il secondo e il terzo caso si vedevano IDENTICI, ed è la ragione per cui una
 * colonna piena sembra vuota. Questa funzione li separa: non inventa una
 * misura che non c'è, dice PERCHÉ non c'è.
 */
describe('cosa mostra una card in review', () => {
  const base = { status: 'review' as const, deliveryBranch: null, deliveryFilesChanged: null, assignedTopicId: null };

  test('con la misura: si mostra la misura, ed è il caso buono', () => {
    const e = reviewEvidence({ ...base, deliveryBranch: 'topics/purple-finch', deliveryFilesChanged: 7 });
    expect(e.kind).toBe('measured');
    // Chi rivede non deve chiedersi da dove venga il numero.
    expect(e.isolated).toBe(true);
  });

  test('lavorato in-place: la card lo DICE, invece di tacere come chi non ha fatto niente', () => {
    // Una sessione c'è stata, ma senza ramo isolato: i commit sono su main e
    // non sono attribuibili alla card. Il silenzio qui è onesto, la sua
    // ragione va detta.
    const e = reviewEvidence({ ...base, assignedTopicId: 'topic-123' });
    expect(e.kind).toBe('in-place');
    expect(e.isolated).toBe(false);
  });

  test('spostata a mano: nessun ramo, nessuna sessione, e si vede', () => {
    const e = reviewEvidence(base);
    expect(e.kind).toBe('manual');
  });

  test('i tre casi NON collassano: era esattamente il difetto', () => {
    const misurata = reviewEvidence({ ...base, deliveryBranch: 'topics/x', deliveryFilesChanged: 3 });
    const inPlace = reviewEvidence({ ...base, assignedTopicId: 't1' });
    const manuale = reviewEvidence(base);
    const tipi = new Set([misurata.kind, inPlace.kind, manuale.kind]);
    expect(tipi.size, 'tre situazioni diverse devono avere tre esiti diversi').toBe(3);
  });

  test('un ramo senza misura non è «non ha prodotto niente»', () => {
    // `deliveryBranch` c'è ma `filesChanged` è NULL: git non ha risposto.
    // Zero direbbe «misurato, non ha prodotto niente», che è un'altra frase.
    const e = reviewEvidence({ ...base, deliveryBranch: 'topics/x' });
    expect(e.kind).toBe('unmeasured');
    expect(e.isolated).toBe(true);
  });

  test('fuori da review non si dice niente: la domanda non esiste', () => {
    const e = reviewEvidence({ ...base, status: 'in_progress', assignedTopicId: 't1' });
    expect(e.kind).toBe('none');
  });
});
