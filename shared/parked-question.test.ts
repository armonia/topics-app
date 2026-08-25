/**
 * La domanda sui sottotask fermi deve spegnersi quando i sottotask si muovono —
 * e NON deve spegnersi un minuto prima. Il verso sbagliato qui non e' rumore in
 * piu': e' una card che aspetta una decisione e non lo dice piu' a nessuno.
 *
 * @covers KANBAN-19
 */
import { describe, test, expect } from 'bun:test';
import {
  isParkedChildrenQuestion,
  isParkedChild,
  isResolvedParkedQuestion,
  isSettledParkedQuestion,
} from './parked-question';

/** Le due frasi come il server le scrive davvero (`askParkedChildren`). */
const PRIMA = '```question\nFermo su 1 sottotask che non lavorerà nessuno («Applicare la 2026…»): uno step lo muove solo l\'agente di questa card dentro il proprio turno, e con un sottotask aperto questo task non si può chiudere. Li rimetto in coda, o archivio ciò che non serve più?\n```';
const SECONDA = '```question\nFermo di nuovo sugli stessi 1 sottotask («Composer dei task…»), e rimetterli in coda l\'ha gia\' fatto: non basta. Archivio cio\' che non serve piu\', oppure la prendi in mano tu?\n```';

const sys = (content: string) => ({ content, author: 'system' });

describe('isParkedChildrenQuestion', () => {
  test('riconosce entrambe le varianti che il server scrive', () => {
    expect(isParkedChildrenQuestion(sys(PRIMA))).toBe(true);
    expect(isParkedChildrenQuestion(sys(SECONDA))).toBe(true);
  });

  test('solo da `system`: un agente non puo\' far sparire una richiesta ripetendone la frase', () => {
    expect(isParkedChildrenQuestion({ content: PRIMA, author: 'agent:9f3a' })).toBe(false);
    expect(isParkedChildrenQuestion({ content: PRIMA, author: 'user' })).toBe(false);
  });

  test('CITARE la domanda non e\' farla: l\'ancora e\' in testa alla riga', () => {
    expect(isParkedChildrenQuestion(sys('Non capisco il messaggio "Fermo su 1 sottotask che non lavorerà nessuno" — che vuol dire?'))).toBe(false);
  });

  test('una domanda di sistema DIVERSA non si spegne per sbaglio', () => {
    expect(isParkedChildrenQuestion(sys('```question\nHo trovato due strade per il deploy. Quale prendo?\n```'))).toBe(false);
  });
});

describe('isParkedChild', () => {
  test('fermo = vivo in backlog o todo — le stesse due colonne del server', () => {
    expect(isParkedChild({ status: 'backlog' })).toBe(true);
    expect(isParkedChild({ status: 'todo' })).toBe(true);
  });
  test('in volo o chiuso non e\' fermo', () => {
    for (const status of ['in_progress', 'review', 'done']) {
      expect(isParkedChild({ status })).toBe(false);
    }
  });
  test('archiviato non conta: non c\'e\' piu\' niente da sbloccare', () => {
    expect(isParkedChild({ status: 'todo', archived: 1 })).toBe(false);
    expect(isParkedChild({ status: 'todo', archived: true })).toBe(false);
  });
});

describe('isResolvedParkedQuestion', () => {
  test('CON un figlio ancora fermo la domanda RESTA viva', () => {
    // Il verso che conta: spegnerla qui vorrebbe dire lasciare una card ferma
    // senza piu' nessuno che lo dica.
    expect(isResolvedParkedQuestion(sys(PRIMA), [{ status: 'todo' }])).toBe(false);
    expect(isResolvedParkedQuestion(sys(PRIMA), [{ status: 'done' }, { status: 'backlog' }])).toBe(false);
  });

  test('quando i figli si sono mossi, la domanda e\' risolta', () => {
    expect(isResolvedParkedQuestion(sys(PRIMA), [{ status: 'done' }])).toBe(true);
    expect(isResolvedParkedQuestion(sys(SECONDA), [{ status: 'done' }, { status: 'in_progress' }])).toBe(true);
  });

  test('un figlio archiviato e\' come se non ci fosse (e\' l\'uscita «Archivia»)', () => {
    expect(isResolvedParkedQuestion(sys(PRIMA), [{ status: 'todo', archived: 1 }])).toBe(true);
  });

  test('senza figli del tutto: risolta, perche\' non ha piu\' nessuno a cui riferirsi', () => {
    expect(isResolvedParkedQuestion(sys(PRIMA), [])).toBe(true);
  });

  test('un commento che non e\' quella domanda non si risolve mai, figli o no', () => {
    const altro = sys('```question\nQuale porta uso?\n```');
    expect(isResolvedParkedQuestion(altro, [])).toBe(false);
    expect(isResolvedParkedQuestion(altro, [{ status: 'done' }])).toBe(false);
  });
});

describe('isSettledParkedQuestion (la vista della card, piu\' stretta)', () => {
  test('tutti i sottotask chiusi: risolta', () => {
    expect(isSettledParkedQuestion(sys(PRIMA), { subtaskCount: 4, subtaskDoneCount: 4 })).toBe(true);
    expect(isSettledParkedQuestion(sys(PRIMA), { subtaskCount: 0, subtaskDoneCount: 0 })).toBe(true);
  });

  test('uno aperto: RESTA viva — ed e\' il verso che conta', () => {
    expect(isSettledParkedQuestion(sys(PRIMA), { subtaskCount: 4, subtaskDoneCount: 3 })).toBe(false);
  });

  test('un figlio IN VOLO tiene viva la domanda: la card non sa distinguerlo da uno fermo', () => {
    // Rumore in piu\', mai una domanda spenta per sbaglio. Il drawer, che ha i
    // figli veri, la risolve.
    const conteggi = { subtaskCount: 1, subtaskDoneCount: 0 };
    expect(isSettledParkedQuestion(sys(PRIMA), conteggi)).toBe(false);
    expect(isResolvedParkedQuestion(sys(PRIMA), [{ status: 'in_progress' }])).toBe(true);
  });

  test('conteggi assenti: si comporta come «niente sottotask»', () => {
    expect(isSettledParkedQuestion(sys(PRIMA), {})).toBe(true);
  });

  test('un altro commento non si risolve mai', () => {
    expect(isSettledParkedQuestion(sys('ciao'), { subtaskCount: 0 })).toBe(false);
  });
});
