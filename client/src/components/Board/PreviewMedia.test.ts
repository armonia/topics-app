/**
 * UN VIDEO DI CARD NON PARTE DA SOLO.
 *
 * Il ramo `card` rendeva `<video autoPlay loop preload="metadata">`: ogni card
 * con un `.webm` di consegna teneva un ciclo di decodifica aperto, comprese
 * quelle mai entrate nel viewport, in una colonna che non era virtualizzata. Il
 * ramo `<img>` accanto diceva già la cosa giusta con `loading="lazy"`; a un
 * `<video>` quell'attributo non esiste, quindi il gate è scritto a mano
 * (IntersectionObserver sul wrapper) e la partenza non è più un attributo.
 *
 * Qui si misura ciò che il markup DICHIARA, che è la metà della fix che
 * sopravvive a un renderer senza DOM: `renderToStaticMarkup` non esegue gli
 * effetti (jsdom/happy-dom non sono dipendenze di questo progetto, vedi
 * `ThreadRuns.test.tsx`), quindi l'osservatore non si arma e il video resta
 * fermo — che è esattamente lo stato di partenza preteso. Che poi si avvii
 * entrando in vista lo prova la spec E2E `board-preview-autoplay`.
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviewMedia } from './PreviewMedia';

/** Minuscolo: React serializza `autoPlay`, non `autoplay`, e cercare la forma
 *  HTML avrebbe dato un verde anche col difetto in piedi. */
const markup = (props: { path: string; variant: 'card' | 'drawer' }) =>
  renderToStaticMarkup(createElement(PreviewMedia, props)).toLowerCase();

describe('PreviewMedia, ramo video', () => {
  test('card: niente autoplay e niente prefetch, ma il loop resta', () => {
    const html = markup({ path: 'topics/t1/clip.webm', variant: 'card' });
    expect(html).toContain('<video');
    // Le due righe della fix: la partenza non è dichiarata nel markup…
    expect(html).not.toContain('autoplay');
    // …e fuori dallo schermo non si scarica nemmeno il primo frame.
    expect(html).toContain('preload="none"');
    // Quando parte, l'evidenza è il MOVIMENTO: continua a ripetersi, muto.
    expect(html).toContain('loop');
    expect(html).toContain('muted');
  });

  test('drawer: la clip è una sola e la stai già guardando', () => {
    const html = markup({ path: 'topics/t1/clip.webm', variant: 'drawer' });
    expect(html).toContain('controls');
    // NON c'è un `not.toContain('autoplay')` qui, e la sua assenza è il punto:
    // il ramo drawer non ha MAI dichiarato autoplay, quindi quella riga era
    // verde anche prima della fix — un'asserzione che non poteva fallire.
    // Le due che restano possono: sono il ROVESCIO della fix, cioè ciò che si
    // romperebbe applicando il gate della card a tutti e due i rami (l'errore
    // naturale di chi la riscrivesse). Nel drawer la clip è una e la stai già
    // guardando: i metadati si scaricano…
    expect(html).not.toContain('preload="none"');
    expect(html).toContain('preload="metadata"');
    // …e non si ripete da sola, perché sotto ci sono i controlli.
    expect(html).not.toContain('loop');
  });

  test('un\'immagine non passa da qui: resta pigra come prima', () => {
    const html = markup({ path: 'topics/t1/shot.png', variant: 'card' });
    expect(html).toContain('<img');
    expect(html).toContain('loading="lazy"');
  });
});
