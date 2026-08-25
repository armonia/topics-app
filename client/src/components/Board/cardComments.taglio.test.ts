/**
 * The card prints the comment it picked, whole: the pick and the clamp read
 * the SAME comment, so a review card never shows a truncated summary of a
 * different row.
 *
 * @covers KANBAN-05
 */
import { describe, test, expect } from 'bun:test';
import { selectCardComments } from './cardComments';

/**
 * IL TAGLIO SEGUE LA PAROLA, NON LA POSIZIONE.
 *
 * Il server manda alla card gli ultimi tre commenti, e ne taglia UNO solo per
 * intero (1.200 caratteri): quello più recente. Gli altri due prendono 200
 * caratteri, perché possono comparire solo come riga di contesto, che il CSS
 * tronca comunque.
 *
 * La regola era giusta finché il più recente era anche quello che la card
 * stampa. Ma la nota di sistema («Consegna SENZA anteprima…», «Anteprima viva
 * pronta») la scrive la macchina a OGNI ingresso in review, quindi arriva
 * sempre DOPO il riassunto di chi ha consegnato: il taglio pieno finiva alla
 * nota, e il riassunto — che è ciò che la card disegna — arrivava mozzato a
 * 200 caratteri. Misurato sulla board vera il 17/08: sette card su otto con il
 * commento troncato a esattamente 201 caratteri.
 *
 * Segnalato: «potremmo mostrare tutta la risposta dell'AI senza troncarla
 * quando in review».
 *
 * Qui si verifica il lato client della regola: chiunque la card scelga come
 * `latest`, quello dev'essere il testo INTERO. Il lato server (quale commento
 * riceve i 1.200 caratteri) sta in `services/tasks.ts`.
 */
describe('la card non stampa un riassunto mozzato', () => {
  const lungo = 'A'.repeat(900);
  const nota = { author: 'system', content: 'Consegna SENZA anteprima: la card resta cieca.', kind: 'review-note' as const };

  test('il testo scelto arriva intero, non tagliato a 200', () => {
    const consegna = { author: 'claude', content: lungo, kind: 'comment' as const };
    const c = selectCardComments([consegna, nota]);
    expect(c).not.toBeNull();
    // Il taglio del server mette «…» in coda: se la card mostra quello, il
    // riassunto è arrivato mozzato.
    expect(c!.latest.content.length,
      `la card stampa ${c!.latest.content.length} caratteri invece di ${lungo.length}`,
    ).toBe(lungo.length);
    expect(c!.latest.content.endsWith('…')).toBe(false);
  });

  test('la scelta e il taglio guardano lo STESSO commento', () => {
    // È l'invariante che si era rotta: il server tagliava per intero il più
    // recente, la card ne sceglieva un altro. Due regole sullo stesso fatto,
    // che è la forma esatta del difetto già visto con `hasMetaRow`.
    const consegna = { author: 'claude', content: lungo, kind: 'comment' as const };
    const c = selectCardComments([consegna, nota]);
    expect(c!.latest.kind, 'la card sceglie la parola, non la nota').toBe('comment');
  });
});
