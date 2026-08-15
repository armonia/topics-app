/**
 * Il carve-out sulle BOZZE, fissato dai due lati.
 *
 * Il gesto «condividi questa chat» non si offre su una `draft:`: quella chat
 * non ha ancora una riga sul server, e nulla a valle rimedia — `POST
 * /api/auth/shares` valida il tipo di risorsa, il tipo di soggetto e il
 * confinamento del soggetto, ma non guarda MAI se la risorsa esiste. Una
 * concessione verso `draft:xyz` viene scritta e sopravvive all'id buttato.
 *
 * Prima esisteva solo la copertura E2E sulla PRESENZA del controllo (GUEST-07):
 * togliere la condizione sulle bozze non faceva fallire niente. Qui la
 * condizione ha il suo test, e il caso «topic vera» è il controllo positivo che
 * dimostra che il canale di osservazione funziona — senza, «è assente» passerebbe
 * anche con un componente che non rende mai nulla.
 *
 * Niente renderer e niente DOM: jsdom/happy-dom non sono dipendenze del progetto
 * (stessa scelta di lib/haptics.test.ts e lib/openTaskLink.test.ts).
 * `TopicShareAction` non usa hook e non tocca il documento, quindi è una funzione
 * pura di props: la si chiama e si guarda l'albero che restituisce.
 */
import { describe, test, expect } from 'bun:test';

import { TopicShareAction } from './TopicSettingsModal';
import { ShareControl } from '../Share/ShareControl';

describe('TopicShareAction', () => {
  // CONTROLLO POSITIVO. Se questo si rompe, l'asserzione negativa sotto non
  // vale più niente: un componente che restituisce sempre `null` la farebbe
  // passare lo stesso.
  test('una topic vera offre il controllo di condivisione, sulla risorsa giusta', () => {
    const reso = TopicShareAction({ topicId: 'topic-abc123' });

    expect(reso).not.toBeNull();
    // Lo STESSO controllo delle schede, non un secondo pannello che dice la
    // stessa cosa in un altro modo.
    expect(reso?.type).toBe(ShareControl);
    expect(reso?.props).toMatchObject({ resourceType: 'topic', resourceId: 'topic-abc123' });
    // Il permalink arriva come FUNZIONE: comporlo legge `window.location`, e
    // questo test gira senza DOM proprio per poter provare la guardia sulle
    // bozze senza montare niente.
    expect(typeof (reso?.props as { deepLink?: unknown }).deepLink).toBe('function');
  });

  test('una BOZZA non lo offre: la concessione atterrerebbe su un id che sta per essere buttato', () => {
    expect(TopicShareAction({ topicId: 'draft:abc123' })).toBeNull();
  });

  // La soglia è il PREFISSO, non la parola: un id che comincia per «draft» ma
  // non è una bozza resta una topic vera e condivisibile.
  test('«draft» senza i due punti non è una bozza', () => {
    const reso = TopicShareAction({ topicId: 'drafty-1' });

    expect(reso).not.toBeNull();
    expect(reso?.props).toMatchObject({ resourceType: 'topic', resourceId: 'drafty-1' });
  });
});
