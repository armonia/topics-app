/**
 * Lo storico dei siti serve a una cosa sola: mettere in griglia OTTO
 * destinazioni che valga la pena riaprire. Quindi qui si prova cosa entra
 * (niente `about:blank`, niente pagine d'errore), cosa conta come visita (non
 * un ricarico), e soprattutto l'ordine: un sito di ieri visitato tre volte deve
 * stare davanti a uno di due mesi fa visitato dieci, altrimenti la griglia
 * racconta il passato invece del presente.
  * @covers BROWSER-STATE-03
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  recordSiteVisit,
  noteSiteMeta,
  forgetSite,
  rankSites,
  frecency,
  siteKeyOf,
  sitesSnapshot,
  subscribeSites,
  MAX_SITES,
  MAX_PAGES,
  VISIT_DEDUPE_MS,
  pagesSnapshot,
  clearPageHistory,
  __resetSiteHistory,
} from './browserSiteHistory';

const T0 = Date.parse('2026-05-10T12:00:00Z');
const DAY = 86_400_000;

beforeEach(() => __resetSiteHistory());

describe('cosa è un sito', () => {
  test('host normalizzato: maiuscole e www non fanno due voci', () => {
    expect(siteKeyOf('https://WWW.Example.com/a')).toBe('example.com');
    recordSiteVisit('https://www.example.com/a', T0);
    recordSiteVisit('https://example.com/b', T0 + 60_000);
    expect(sitesSnapshot()).toHaveLength(1);
    expect(sitesSnapshot()[0].visits).toBe(2);
  });

  test('quello che non è una destinazione non entra', () => {
    for (const u of ['', 'about:blank', 'chrome-error://chromewebdata/', 'file:///tmp/x.html', 'non un indirizzo']) {
      expect(siteKeyOf(u)).toBe('');
      recordSiteVisit(u, T0);
    }
    expect(sitesSnapshot()).toEqual([]);
  });
});

describe('cosa conta come visita', () => {
  test('ricaricare lo stesso indirizzo non è una visita nuova', () => {
    recordSiteVisit('https://a.dev/x', T0);
    recordSiteVisit('https://a.dev/x', T0 + VISIT_DEDUPE_MS - 1);
    expect(sitesSnapshot()[0].visits).toBe(1);
  });

  test('lo stesso indirizzo molto dopo, invece, sì', () => {
    recordSiteVisit('https://a.dev/x', T0);
    recordSiteVisit('https://a.dev/x', T0 + VISIT_DEDUPE_MS);
    expect(sitesSnapshot()[0].visits).toBe(2);
  });

  test('navigare DENTRO il sito conta, e il riquadro punta all\'ultima pagina', () => {
    recordSiteVisit('https://a.dev/x', T0);
    recordSiteVisit('https://a.dev/y', T0 + 1);
    const [s] = sitesSnapshot();
    expect(s.visits).toBe(2);
    expect(s.url).toBe('https://a.dev/y');
  });
});

describe('ordine (frecency)', () => {
  test('il recente battuto poco batte il vecchio battuto molto', () => {
    recordSiteVisit('https://fresco.dev/', T0 - DAY);
    recordSiteVisit('https://fresco.dev/2', T0 - DAY + 1);
    recordSiteVisit('https://fresco.dev/3', T0 - DAY + 2);
    for (let i = 0; i < 10; i++) recordSiteVisit(`https://vecchio.dev/${i}`, T0 - 60 * DAY);
    expect(rankSites(sitesSnapshot(), 2, T0).map((s) => s.host)).toEqual(['fresco.dev', 'vecchio.dev']);
  });

  test('a parità di freschezza decide il numero di visite', () => {
    recordSiteVisit('https://uno.dev/', T0);
    recordSiteVisit('https://due.dev/', T0);
    recordSiteVisit('https://due.dev/2', T0 + 1);
    expect(rankSites(sitesSnapshot(), 2, T0 + 2).map((s) => s.host)).toEqual(['due.dev', 'uno.dev']);
  });

  test('un sito antico non vale zero: resta in coda, non sparisce', () => {
    const antico = { host: 'a.dev', url: 'https://a.dev/', title: '', favicon: '', visits: 5, lastVisit: T0 - 400 * DAY };
    expect(frecency(antico, T0)).toBeGreaterThan(0);
  });

  test('il tetto sfratta il peggiore, non l\'ultimo arrivato', () => {
    for (let i = 0; i < MAX_SITES; i++) recordSiteVisit(`https://vecchio${i}.dev/`, T0 - 200 * DAY);
    recordSiteVisit('https://nuovo.dev/', T0);
    expect(sitesSnapshot()).toHaveLength(MAX_SITES);
    expect(rankSites(sitesSnapshot(), 1, T0)[0].host).toBe('nuovo.dev');
  });
});

describe('titolo, favicon e oblio', () => {
  test('il meta si attacca alla pagina corrente e non è una visita', () => {
    recordSiteVisit('https://a.dev/x', T0);
    noteSiteMeta('https://a.dev/x', { title: 'Ciao', favicon: 'https://a.dev/f.ico' });
    const [s] = sitesSnapshot();
    expect(s.title).toBe('Ciao');
    expect(s.favicon).toBe('https://a.dev/f.ico');
    expect(s.visits).toBe(1);
    expect(s.lastVisit).toBe(T0);
  });

  test('il titolo di una pagina che il sito ha già lasciato non si scrive', () => {
    recordSiteVisit('https://a.dev/x', T0);
    recordSiteVisit('https://a.dev/y', T0 + 1);
    noteSiteMeta('https://a.dev/x', { title: 'vecchio' });
    expect(sitesSnapshot()[0].title).toBe('');
  });

  test('dimenticare un sito lo toglie e avvisa chi ascolta', () => {
    let beats = 0;
    const off = subscribeSites(() => { beats++; });
    recordSiteVisit('https://a.dev/', T0);
    expect(forgetSite('a.dev')).toBe(true);
    expect(forgetSite('a.dev')).toBe(false);
    expect(sitesSnapshot()).toEqual([]);
    expect(beats).toBe(2);
    off();
  });
});

/**
 * The second view of the same store: the PAGES, in time order. This is the
 * navigation history, and it must answer "where have I been" with the same
 * dedupe as the visit, or else three ⌘R leave three identical rows in a stack.
 */
describe('cronologia di navigazione (pagine)', () => {
  test('una riga per pagina, la più recente in testa', () => {
    recordSiteVisit('https://a.dev/uno', T0);
    recordSiteVisit('https://b.dev/due', T0 + 60_000);
    expect(pagesSnapshot().map((p) => p.url)).toEqual(['https://b.dev/due', 'https://a.dev/uno']);
    expect(pagesSnapshot()[0].at).toBe(T0 + 60_000);
  });

  test('un ricarico non aggiunge una riga: aggiorna quella in testa', () => {
    recordSiteVisit('https://a.dev/uno', T0);
    recordSiteVisit('https://a.dev/uno', T0 + 1_000);
    expect(pagesSnapshot()).toHaveLength(1);
    expect(pagesSnapshot()[0].at).toBe(T0 + 1_000);
  });

  test('tornare su una pagina vecchia la riporta in testa, senza duplicarla', () => {
    recordSiteVisit('https://a.dev/uno', T0);
    recordSiteVisit('https://b.dev/due', T0 + 60_000);
    recordSiteVisit('https://a.dev/uno', T0 + 120_000);
    expect(pagesSnapshot().map((p) => p.url)).toEqual(['https://a.dev/uno', 'https://b.dev/due']);
  });

  test('titolo e icona arrivano dopo e finiscono anche sulla riga', () => {
    recordSiteVisit('https://a.dev/uno', T0);
    noteSiteMeta('https://a.dev/uno', { title: 'Uno', favicon: 'https://a.dev/f.ico' });
    expect(pagesSnapshot()[0].title).toBe('Uno');
    expect(pagesSnapshot()[0].favicon).toBe('https://a.dev/f.ico');
  });

  test('oltre il tetto esce la più vecchia', () => {
    for (let i = 0; i < MAX_PAGES + 5; i++) recordSiteVisit(`https://a.dev/p${i}`, T0 + i * 60_000);
    expect(pagesSnapshot()).toHaveLength(MAX_PAGES);
    expect(pagesSnapshot()[0].url).toBe(`https://a.dev/p${MAX_PAGES + 4}`);
    expect(pagesSnapshot().some((p) => p.url === 'https://a.dev/p0')).toBe(false);
  });

  test('dimenticare un sito porta via anche le sue pagine', () => {
    recordSiteVisit('https://a.dev/uno', T0);
    recordSiteVisit('https://b.dev/due', T0 + 60_000);
    expect(forgetSite('a.dev')).toBe(true);
    expect(pagesSnapshot().map((p) => p.url)).toEqual(['https://b.dev/due']);
  });

  test('svuotare la cronologia lascia in piedi i siti', () => {
    recordSiteVisit('https://a.dev/uno', T0);
    clearPageHistory();
    expect(pagesSnapshot()).toEqual([]);
    expect(sitesSnapshot()).toHaveLength(1);
  });
});
