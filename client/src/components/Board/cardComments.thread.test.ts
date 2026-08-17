import { describe, test, expect } from 'bun:test';
import { showsCardThread, cardCommentsFromRow } from './cardComments';

/**
 * IL SERVER MANDA I COMMENTI, LA CARD LI BUTTAVA.
 *
 * Segnalato due volte: «quelli in review non mi sembrano pronti da sistema per
 * essere fatti review da me, sembrano solo i task spostati, ma una volta in
 * review dovrei vedere aggiornamenti, no?».
 *
 * Misurato sulla board vera il 17/08: 22 card in review, TUTTE E 22 con
 * `recentComments` nella risposta del feed, e ZERO che li disegnavano. Il
 * riassunto della consegna e le note di sistema («questa card è cieca, manca
 * l'anteprima») viaggiavano fino al browser e finivano in nessun pixel.
 *
 * La causa: `showsCardThread` pretendeva `assignedTopicId`, cioè una sessione
 * agente. È la condizione giusta per DECIDERE SE CHIEDERE il thread al server,
 * ma sbagliata per decidere se MOSTRARLO: quando il server lo ha già mandato,
 * l'unica domanda sensata è «c'è qualcosa da leggere?».
 *
 * Le card senza sessione sono il caso più comune, non un'eccezione: chi lavora
 * dal terminale, chi consegna a mano, chi apre una card e la porta in review
 * scrivendo cos'ha fatto. Erano esattamente quelle che sembravano vuote.
 */
describe('la card in review mostra ciò che il server le ha mandato', () => {
  const commento = { author: 'user', content: 'Quattro cose chieste, quattro chiuse.', kind: 'comment' as const };
  const nota = { author: 'system', content: 'Consegna SENZA anteprima: la card resta cieca.', kind: 'review-note' as const };

  test('con una sessione agente: si vede, e si vedeva anche prima', () => {
    const t = { status: 'review', assignedTopicId: 'topic-1', deliveredReason: null, subtaskCount: 0, recentComments: [commento] };
    expect(showsCardThread(t as never)).toBe(true);
    expect(cardCommentsFromRow(t as never)).not.toBeNull();
  });

  test('SENZA sessione ma con commenti: si vede. Era il difetto', () => {
    // Il caso di 22 card su 22 sulla board vera.
    const t = { status: 'review', assignedTopicId: null, deliveredReason: null, subtaskCount: 0, recentComments: [commento] };
    expect(showsCardThread(t as never), 'una card senza agente ma con un riassunto deve mostrarlo').toBe(true);
    expect(cardCommentsFromRow(t as never)).not.toBeNull();
  });

  test('anche una nota di SISTEMA da sola vale: dice perché la card è cieca', () => {
    const t = { status: 'review', assignedTopicId: null, deliveredReason: null, subtaskCount: 0, recentComments: [nota] };
    expect(showsCardThread(t as never)).toBe(true);
  });

  test('senza niente da leggere non si monta un riquadro vuoto', () => {
    const vuota = { status: 'review', assignedTopicId: null, deliveredReason: null, subtaskCount: 0, recentComments: [] };
    expect(showsCardThread(vuota as never)).toBe(false);
    expect(cardCommentsFromRow(vuota as never)).toBeNull();
  });

  test('il server non li ha ancora mandati: si CHIEDE se c\'è una sessione, non si finge', () => {
    // `undefined` è «non lo so ancora», diverso da `[]` che è «non ce ne sono».
    const inVolo = { status: 'review', assignedTopicId: 'topic-1', deliveredReason: null, subtaskCount: 0, recentComments: undefined };
    expect(showsCardThread(inVolo as never)).toBe(true);
    expect(cardCommentsFromRow(inVolo as never)).toBeNull();
  });

  test('fuori da review non si mostra niente: la domanda non esiste', () => {
    const t = { status: 'in_progress', assignedTopicId: 'topic-1', deliveredReason: null, subtaskCount: 0, recentComments: [commento] };
    expect(showsCardThread(t as never)).toBe(false);
  });
});
