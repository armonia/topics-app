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

  test('una nota di SISTEMA non ruba il posto alla parola della consegna', () => {
    // Segnalato: «gli ultimi commenti che devo da review non hanno senso,
    // saranno messaggi di sistema». Misurato: 19 card su 22 mostravano come
    // ultima cosa «Consegna SENZA anteprima…» o «Anteprima viva pronta —
    // http://localhost:3400/», cioe' il promemoria che il sistema scrive a
    // OGNI ingresso in review. Il riassunto vero stava sotto, invisibile.
    const t = {
      status: 'review', assignedTopicId: null, deliveredReason: null, subtaskCount: 0,
      recentComments: [commento, nota],
    };
    const c = cardCommentsFromRow(t as never);
    expect(c, 'la card deve avere qualcosa da mostrare').not.toBeNull();
    expect(c!.latest.content, 'in cima va la parola di chi ha consegnato, non il promemoria del sistema')
      .toBe(commento.content);
  });

  test('se il sistema e\' l\'UNICA voce, si mostra: e\' meglio del vuoto', () => {
    // Una card senza riassunto ma con la nota che spiega perche' e' cieca:
    // quella nota e' l'unica cosa che c'e', e dice comunque qualcosa.
    const t = {
      status: 'review', assignedTopicId: null, deliveredReason: null, subtaskCount: 0,
      recentComments: [nota],
    };
    const c = cardCommentsFromRow(t as never);
    expect(c).not.toBeNull();
    expect(c!.latest.kind).toBe('review-note');
  });

  test('fuori da review non si mostra niente: la domanda non esiste', () => {
    const t = { status: 'in_progress', assignedTopicId: 'topic-1', deliveredReason: null, subtaskCount: 0, recentComments: [commento] };
    expect(showsCardThread(t as never)).toBe(false);
  });
});
