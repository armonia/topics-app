/**
 * La riga di uno step ferma dice PERCHE', e si apre.
 *
 * Il caso vero: due card su un progetto sono rimaste in `todo` dodici ore con
 * `dispatch_attempts = 0` e nessun errore. Non erano rotte: erano sottotask, e
 * il dispatcher non prende mai uno step. La spiegazione esisteva gia'
 * (`deriveQueueReason` ha il ramo `parent_review`, e viaggia nel payload di
 * ogni figlio) ma non arrivava a nessuno schermo: uno step non compare in
 * nessuna colonna della board (le colonne sono `rootsOnly`), e nell'albero del
 * padre la riga non era nemmeno apribile.
 *
 * Qui si pinnano le due decisioni, quella che si disegna e quella che si apre,
 * e soprattutto il loro CONFINE: solo `stalled`. Una riga in coda o lavorata
 * dal padre e' la vita normale di uno step; se anche quelle prendessero il
 * chip, la checklist si riempirebbe di colore e la riga davvero ferma
 * sparirebbe dentro il rumore, cioe' la visibilita' sarebbe comprata col
 * rumore che doveva togliere.
 */
import { describe, expect, test } from 'bun:test';
import { subtaskQueueChip, subtaskOpenable, type BoardTask } from './board';
import type { QueueReason } from '../../../shared/board';

const reason = (over: Partial<QueueReason>): QueueReason => ({
  kind: 'parent_review',
  tone: 'stalled',
  head: 'ferma',
  detail: 'il padre aspetta te',
  title: 'Il padre e\' in review: aspetta una persona, non un agente.',
  ...over,
} as QueueReason);

/** Una riga nuda: niente descrizione, niente figli, nessun tab d'agente. */
const bareStep = (queueReason: QueueReason | null): Pick<
  BoardTask, 'description' | 'assignedTopicId' | 'subtaskCount' | 'queueReason'
> => ({
  description: null,
  assignedTopicId: null,
  subtaskCount: 0,
  queueReason,
});

describe('subtaskQueueChip', () => {
  test('uno step fermo perche\' il padre aspetta una persona porta il chip', () => {
    const chip = subtaskQueueChip(bareStep(reason({})));
    expect(chip).not.toBeNull();
    expect(chip!.tone).toBe('stalled');
    expect(chip!.detail).toBe('il padre aspetta te');
  });

  test('ogni altro tono resta muto: la visibilita\' non si compra col rumore', () => {
    for (const tone of ['queued', 'waiting'] as const) {
      expect(subtaskQueueChip(bareStep(reason({ tone })))).toBeNull();
    }
  });

  test('senza ragione non c\'e\' chip', () => {
    expect(subtaskQueueChip(bareStep(null))).toBeNull();
  });
});

describe('subtaskOpenable', () => {
  test('una riga nuda con una ragione FERMA si apre: il motivo per esteso sta nel drawer', () => {
    expect(subtaskOpenable(bareStep(reason({})))).toBe(true);
  });

  test('una riga nuda senza niente da dire resta uno span', () => {
    expect(subtaskOpenable(bareStep(null))).toBe(false);
    expect(subtaskOpenable(bareStep(reason({ tone: 'waiting' })))).toBe(false);
  });

  test('gli altri motivi di apertura restano quelli di prima', () => {
    expect(subtaskOpenable({ ...bareStep(null), description: 'due righe' })).toBe(true);
    expect(subtaskOpenable({ ...bareStep(null), subtaskCount: 2 })).toBe(true);
    expect(subtaskOpenable({ ...bareStep(null), assignedTopicId: 'topic-1' })).toBe(true);
  });
});
