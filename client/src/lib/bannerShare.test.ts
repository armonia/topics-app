import { describe, test, expect } from 'bun:test';
import { bannerMarkdown } from './bannerShare';

/**
 * UN LINK CHE FUNZIONA SOLO SUL MIO COMPUTER NON È CONDIVISIBILE.
 *
 * Stamattina ho aggiunto il bottone «Copia per il README»: costruiva l'URL con
 * `window.location.origin`, che su un'installazione locale è
 * `http://localhost:13333`. Incollato in un README su GitHub, quel markdown è
 * un'immagine rotta per chiunque — me compreso, da un altro computer.
 *
 * Il gesto era nuovo, quindi il difetto è mio e non ereditato.
 *
 * La risposta giusta NON è inventare un dominio pubblico che non esiste: il
 * banner lo serve il processo locale, e finché non c'è un indirizzo
 * raggiungibile da fuori nessuna stringa può renderlo condivisibile. La
 * risposta è DIRLO — copiare il markdown quando l'origine è pubblica, e
 * avvisare quando non lo è, invece di consegnare in silenzio un link che si
 * scopre rotto solo dopo averlo incollato.
 */
describe('il markdown del banner', () => {
  test('da un indirizzo PUBBLICO: markdown pronto, senza avvisi', () => {
    const r = bannerMarkdown('https://app.topics.armonia.io', 'Attilio');
    expect(r.condivisibile).toBe(true);
    expect(r.testo).toMatch(/^!\[Topics\]\(https:\/\/app\.topics\.armonia\.io\/api\/profile\/banner\.svg/);
    expect(r.avviso).toBeNull();
  });

  test("da localhost: il markdown c'è ma l'avviso lo accompagna", () => {
    const r = bannerMarkdown('http://localhost:13333', null);
    // Il testo resta utile: chi ha un tunnel o un reverse proxy lo adatta.
    expect(r.testo).toContain('/api/profile/banner.svg');
    // Ma non si spaccia per condivisibile.
    expect(r.condivisibile).toBe(false);
    expect(r.avviso, 'senza avviso il link si scopre rotto solo su GitHub').not.toBeNull();
  });

  test('127.0.0.1 e gli indirizzi di rete locale contano come locali', () => {
    for (const o of ['http://127.0.0.1:13333', 'http://192.168.1.40:13333', 'http://10.0.0.5:13333', 'http://topics.local:13333']) {
      expect(bannerMarkdown(o, null).condivisibile, `${o} non è raggiungibile da GitHub`).toBe(false);
    }
  });

  test('il nome finisce nella query, e non rompe il markdown', () => {
    const r = bannerMarkdown('https://esempio.io', 'Mario Rossi & Co');
    expect(r.testo).toContain('name=Mario%20Rossi%20%26%20Co');
    // Nessuna parentesi tonda grezza dentro l'URL: chiuderebbe il markdown a
    // metà, e l'immagine si romperebbe per un motivo diverso.
    expect(r.testo.slice(0, -1)).not.toContain(')');
  });

  test('senza nome non si scrive una query vuota', () => {
    expect(bannerMarkdown('https://esempio.io', null).testo).toBe('![Topics](https://esempio.io/api/profile/banner.svg)');
  });
});
