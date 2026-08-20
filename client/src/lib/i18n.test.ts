/**
 * Due cose vanno provate, e nessuna delle due è «traduce»: che una chiave
 * mancante NON finisca a schermo, e che le due lingue restino allineate — una
 * lingua incompleta è un fatto da scoprire qui, non guardando l'interfaccia a
 * caso.
 */
import { describe, test, expect, afterEach, beforeAll } from 'bun:test';
import {
  t,
  resolveLocale,
  interpolate,
  missingKeys,
  ensureLocaleLoaded,
  chiaviDelCatalogo,
  FALLBACK_LOCALE,
  fetchOutputLanguage,
  pushOutputLanguage,
} from './i18n';

describe('resolveLocale', () => {
  test('una preferenza esplicita vince sempre', () => {
    expect(resolveLocale('en', 'it-IT')).toBe('en');
    expect(resolveLocale('it', 'en-US')).toBe('it');
  });

  test('auto NON segue piu\' il browser: un Mac inglese non sceglie per te', () => {
    // Il caso misurato: preferenza `auto`, sistema in inglese, e sulla stessa
    // card «consegnato» accanto a «Land on main». L'inglese qui non puo' essere
    // completo — i chip del server, il testo degli agenti e le card sono
    // italiani comunque — quindi inferirlo dal sistema impone una schermata
    // META' tradotta a chi non ha scelto niente.
    expect(resolveLocale('auto', 'en-GB')).toBe('it');
    expect(resolveLocale('auto', 'en-US')).toBe('it');
    expect(resolveLocale('auto', 'it-IT')).toBe('it');
  });

  test('l\'inglese resta raggiungibile, ma va CHIESTO', () => {
    // Una scelta esplicita accetta il misto; un'inferenza lo impone.
    expect(resolveLocale('en', 'it-IT')).toBe('en');
  });

  test('senza preferenza e senza browser: italiano', () => {
    // È la lingua di questa casa, non un default universale.
    expect(resolveLocale(undefined, undefined)).toBe('it');
    expect(FALLBACK_LOCALE).toBe('it');
  });

  test('una lingua sconosciuta non diventa inglese per sbaglio', () => {
    expect(resolveLocale('auto', 'de-DE')).toBe('it');
  });
});

describe('t', () => {
  // L'inglese vive nel suo chunk (`i18n-en.ts`) e arriva su richiesta, quindi
  // `t(k, 'en')` prima del caricamento ripiega LEGITTIMAMENTE sull'italiano.
  // Senza questa riga i due test qui sotto passavano solo se qualche altro file
  // della suite aveva gia' chiesto l'inglese per conto suo: verdi tutti insieme,
  // rossi da soli. Una dipendenza dall'ordine e' un verde che non significa
  // niente, e questa e' la sua cura.
  beforeAll(async () => { await ensureLocaleLoaded('en'); });

  test('traduce nelle due lingue', () => {
    expect(t('board.night.title', 'it')).toBe('Modalità notturna');
    expect(t('board.night.title', 'en')).toBe('Night mode');
  });

  test('una chiave inesistente NON esplode e non inventa', () => {
    expect(t('non.esiste.proprio', 'it')).toBe('non.esiste.proprio');
  });

  test('interpola i valori', () => {
    expect(t('board.night.sessions.many', 'it', { n: 3 })).toBe('3 sessioni attive');
    expect(t('board.night.sessions.many', 'en', { n: 3 })).toBe('3 active sessions');
  });

  test('un segnaposto senza valore resta com’è invece di sparire', () => {
    // Un buco visibile si nota e si corregge; un testo mutilato in silenzio no.
    expect(interpolate('ciao {nome}', {})).toBe('ciao {nome}');
  });
});

describe('allineamento fra le lingue', () => {
  test("nessuna delle due lingue ha buchi rispetto all'altra", async () => {
    // Se questo test diventa rosso, qualcuno ha aggiunto una chiave a una lingua
    // sola — ed è esattamente il momento in cui va saputo.
    expect(await missingKeys('it')).toEqual([]);
    expect(await missingKeys('en')).toEqual([]);
  });

  /**
   * LE CHIAVI ALLINEATE NON BASTANO: contano anche i SEGNAPOSTI.
   *
   * `interpolate` sostituisce `{nome}` e lascia com'è un segnaposto senza
   * valore. Quindi una traduzione che ne perde uno non esplode e non diventa
   * rossa da nessuna parte: mostra una frase a cui manca il pezzo che la rende
   * utile («Dimentica ?» invece di «Dimentica example.com?»). E una che ne
   * INVENTA uno stampa `{host}` a schermo, letterale.
   *
   * È il difetto che il giro di traduzione del 20/08 poteva introdurre 1286
   * volte in silenzio, ed è l'unica parte di quel lavoro che una rilettura non
   * avrebbe preso: due frasi in due lingue si leggono bene entrambe anche
   * quando una ha un segnaposto in meno.
   */
  test('i segnaposti di una chiave sono gli STESSI nelle due lingue', async () => {
    await ensureLocaleLoaded('en');
    const segnaposti = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    const disallineate: string[] = [];
    for (const k of chiaviDelCatalogo()) {
      const en = t(k, 'en');
      const it = t(k, 'it');
      // `t` ripiega sull'altra lingua quando la chiave manca: quel caso lo
      // copre il test qui sopra, e qui darebbe un falso verde confrontando una
      // stringa con se stessa.
      if (en === it) continue;
      if (segnaposti(it) !== segnaposti(en)) disallineate.push(`${k}: it{${segnaposti(it)}} en{${segnaposti(en)}}`);
    }
    expect(disallineate).toEqual([]);
  });
});

/**
 * Il verso server della stessa preferenza.
 *
 * Quello che conta qui è UNA distinzione: `fetchOutputLanguage` torna `null`
 * per «non lo so» e la stringa `'auto'` per «l'utente ha scelto auto». Sono due
 * cose diverse e chi chiama ci si appoggia: il riallineamento una-tantum in
 * Impostazioni scrive la preferenza locale sul server SOLO quando la riga è
 * davvero vuota. Se un errore di rete tornasse `'auto'` invece di `null`, quel
 * codice concluderebbe «l'utente non ha mai scelto» proprio quando non ne sa
 * niente — e sovrascriverebbe una scelta fatta da un'altra finestra.
 */
describe('la lingua dall’altra parte del filo', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const stub = (impl: () => unknown) => {
    globalThis.fetch = (async () => impl()) as unknown as typeof fetch;
  };

  test('riga vuota: il server SA, e sa che non è stato scelto niente', async () => {
    stub(() => ({ ok: true, json: async () => ({ settings: { outputLanguage: null } }) }));
    expect(await fetchOutputLanguage()).toEqual({ known: true, value: null });
  });

  test("«auto» scritto esplicitamente è una SCELTA, non un'assenza", async () => {
    stub(() => ({ ok: true, json: async () => ({ settings: { outputLanguage: 'auto' } }) }));
    expect(await fetchOutputLanguage()).toEqual({ known: true, value: 'auto' });
  });

  test('una lingua vera torna com’è', async () => {
    stub(() => ({ ok: true, json: async () => ({ settings: { outputLanguage: 'en' } }) }));
    expect(await fetchOutputLanguage()).toEqual({ known: true, value: 'en' });
  });

  test('rete rotta, risposta non ok o valore illeggibile: «non lo so» — MAI «vuoto»', async () => {
    // È la distinzione che conta: chi riallinea i due depositi scrive solo su
    // «vuoto». Se un errore di rete si presentasse come «vuoto», il
    // localStorage di questa finestra sovrascriverebbe una scelta appena fatta
    // da un'altra proprio quando non se ne sa niente.
    stub(() => { throw new Error('offline'); });
    expect(await fetchOutputLanguage()).toEqual({ known: false });
    stub(() => ({ ok: false, json: async () => ({}) }));
    expect(await fetchOutputLanguage()).toEqual({ known: false });
    stub(() => ({ ok: true, json: async () => ({ settings: { outputLanguage: 'fr' } }) }));
    expect(await fetchOutputLanguage()).toEqual({ known: false });
  });

  test('la scrittura manda il campo giusto e non rilancia se la rete cade', async () => {
    let body: string | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = init.body as string;
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
    await pushOutputLanguage('it');
    expect(JSON.parse(body!)).toEqual({ outputLanguage: 'it' });

    stub(() => { throw new Error('offline'); });
    // Il selettore ha già aggiornato la UI: un errore qui non deve propagarsi.
    await pushOutputLanguage('en');
  });
});
