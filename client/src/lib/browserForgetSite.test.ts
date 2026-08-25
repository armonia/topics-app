/**
 * Il patto del comando «Dimentica questo sito», provato dove si può rompere.
 *
 * Due cose devono reggere, e sono le due che l'umano ha chiesto:
 *  · si cancella SOLO questo sito (il resto dello store non compare nel piano);
 *  · si cancella ESATTAMENTE quello che il dialogo ha mostrato (i nomi che
 *    tornano al nativo sono i nomi elencati, non un secondo filtro fatto dopo).
 *
 * Né il nativo né il server ci sono, e non servono: `planForgetSite` e
 * `forgetSite` prendono il `SiteDataBackend` come parametro, ed è la stessa
 * interfaccia che alimenta il dialogo sulla pane nativa e su quella condivisa.
  * @covers FORGET-02
 */
import { test, expect } from 'bun:test';
import {
  siteHostOf,
  matchSiteRecords,
  describeSiteData,
  siteRecordNames,
  planForgetSite,
  forgetSite,
  nativeSiteData,
  sharedSiteData,
  type SiteDataRecord,
} from './browserForgetSite';

const STORE: SiteDataRecord[] = [
  { displayName: 'google.com', types: ['cookies', 'localStorage', 'diskCache'] },
  { displayName: 'github.com', types: ['cookies', 'indexedDB'] },
  { displayName: 'cdn.github.com', types: ['diskCache'] },
  { displayName: 'example.org', types: ['fetchCache'] },
];

function invokeWith(records: SiteDataRecord[]) {
  const calls: Array<[string, unknown]> = [];
  const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push([cmd, args]);
    if (cmd === 'browser_site_data_records') return JSON.stringify(records) as unknown as T;
    if (cmd === 'browser_forget_site') {
      const names = (args?.displayNames as string[]) ?? [];
      return names.length as unknown as T;
    }
    return undefined as unknown as T;
  };
  return { backend: nativeSiteData(invoke), calls };
}

/** Un `fetch` finto per il backend condiviso: registra le chiamate e risponde
 *  con quello che risponderebbe il server. */
function fetchWith(body: unknown, opts: { ok?: boolean } = {}) {
  const calls: Array<[string, string, unknown]> = [];
  const fake = async (input: unknown, init?: { method?: string; body?: string }) => {
    calls.push([String(input), init?.method ?? 'GET', init?.body ? JSON.parse(init.body) : undefined]);
    return {
      ok: opts.ok !== false,
      status: opts.ok === false ? 500 : 200,
      json: async () => body,
    } as Response;
  };
  return { fake: fake as unknown as typeof fetch, calls };
}

function withFetch<T>(fake: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  return fn().finally(() => { globalThis.fetch = real; });
}

test('siteHostOf: solo pagine vere, senza www', () => {
  expect(siteHostOf('https://www.Google.com/mail')).toBe('google.com');
  expect(siteHostOf('http://localhost:3333/x')).toBe('localhost');
  expect(siteHostOf('about:blank')).toBeNull();
  expect(siteHostOf('file:///tmp/a.html')).toBeNull();
  expect(siteHostOf('')).toBeNull();
});

test('un sottodominio prende il silo registrabile che lo contiene', () => {
  // WebKit tiene un record per dominio registrabile: su mail.google.com la
  // roba sta sotto `google.com`, e cercare l'host esatto non troverebbe nulla.
  const hit = matchSiteRecords(STORE, 'mail.google.com');
  expect(hit.map((r) => r.displayName)).toEqual(['google.com']);
});

test('e anche i siloni più specifici che stanno sotto di lui', () => {
  const hit = matchSiteRecords(STORE, 'github.com');
  expect(hit.map((r) => r.displayName).sort()).toEqual(['cdn.github.com', 'github.com']);
});

test('IL PUNTO: il resto dello store non entra nel piano', () => {
  const hit = matchSiteRecords(STORE, 'github.com');
  expect(hit.some((r) => r.displayName === 'google.com')).toBe(false);
  expect(hit.some((r) => r.displayName === 'example.org')).toBe(false);
});

test('un vicino di casa non è lo stesso sito', () => {
  // `notgithub.com` finisce per «github.com» come stringa, ma il confine è il
  // punto: senza, dimenticare un sito ne porterebbe via un altro.
  const hit = matchSiteRecords([{ displayName: 'notgithub.com', types: ['cookies'] }], 'github.com');
  expect(hit).toEqual([]);
});

test('le voci dicono le cose per nome, in ordine di gravità', () => {
  const items = describeSiteData(matchSiteRecords(STORE, 'google.com'));
  expect(items.map((i) => i.group)).toEqual(['session', 'storage', 'cache']);
  expect(items[0].label).toBe('Sessione e cookie');
});

test('niente sessione salvata, nessuna riga che promette di cancellarla', () => {
  const items = describeSiteData(matchSiteRecords(STORE, 'example.org'));
  expect(items.map((i) => i.group)).toEqual(['cache']);
});

test('un tipo che non conosciamo finisce nei dati del sito, non sparisce', () => {
  const items = describeSiteData([{ displayName: 'x.com', types: ['WKWebsiteDataTypeQualcosaDiNuovo'] }]);
  expect(items.map((i) => i.group)).toEqual(['storage']);
});

test('i nomi mostrati sono unici e ordinati', () => {
  expect(siteRecordNames([...STORE, STORE[1]])).toEqual([
    'cdn.github.com',
    'example.org',
    'github.com',
    'google.com',
  ]);
});

test('il piano legge lo store e non lo tocca', async () => {
  const { backend, calls } = invokeWith(STORE);
  const plan = await planForgetSite('ctx', 'https://mail.google.com/inbox', backend);
  expect(plan?.host).toBe('mail.google.com');
  expect(plan?.displayNames).toEqual(['google.com']);
  expect(calls.map((c) => c[0])).toEqual(['browser_site_data_records']);
});

test('IL PATTO: si cancellano esattamente i record elencati nel piano', async () => {
  const { backend, calls } = invokeWith(STORE);
  const plan = await planForgetSite('ctx', 'https://github.com/armonia', backend);
  const removed = await forgetSite('ctx', plan!.displayNames, backend);
  expect(removed).toBe(2);
  expect(calls[1]).toEqual(['browser_forget_site', { id: 'ctx', displayNames: plan!.displayNames }]);
});

test('pane vuota: nessun piano, quindi nessun tasto da premere', async () => {
  const { backend, calls } = invokeWith(STORE);
  expect(await planForgetSite('ctx', 'about:blank', backend)).toBeNull();
  expect(calls).toEqual([]);
});

test('store illeggibile: piano vuoto, non una promessa a vuoto', async () => {
  const backend = nativeSiteData(async <T,>(): Promise<T> => {
    throw new Error('no such browser pane');
  });
  const plan = await planForgetSite('ctx', 'https://github.com/', backend);
  expect(plan).toEqual({ host: 'github.com', displayNames: [], items: [], supported: true });
});

test('lista vuota: non si chiama il nativo per cancellare niente', async () => {
  const { backend, calls } = invokeWith(STORE);
  expect(await forgetSite('ctx', [], backend)).toBe(0);
  expect(calls).toEqual([]);
});

// ── La pane CONDIVISA ────────────────────────────────────────────────────────
// Stesso piano, stesso patto, altro magazzino: i silo arrivano dallo
// storageState del contesto Playwright, con i nomi PRECISI invece che per
// dominio registrabile.

const SHARED_STORE: SiteDataRecord[] = [
  { displayName: 'google.com', types: ['cookies'] },
  { displayName: 'mail.google.com', types: ['localStorage', 'indexedDB'] },
  { displayName: 'altro.dev', types: ['cookies'] },
];

test('condivisa: il piano prende il sito e i suoi sottodomini, non i vicini', async () => {
  const { fake, calls } = fetchWith({ supported: true, records: SHARED_STORE });
  const plan = await withFetch(fake, () =>
    planForgetSite('ctx-1', 'https://mail.google.com/inbox', sharedSiteData()),
  );
  // Qui `mail.google.com` è un silo SUO e si vede: sul nativo sarebbe finito
  // dentro `google.com` senza comparire nell'elenco.
  expect(plan?.displayNames).toEqual(['google.com', 'mail.google.com']);
  expect(plan?.items.map((i) => i.group)).toEqual(['session', 'storage']);
  expect(calls).toEqual([['/api/browsers/ctx-1/site-data', 'GET', undefined]]);
});

test('condivisa: nessuna riga «Cache», perché non è per-sito e non si promette', async () => {
  const { fake } = fetchWith({ supported: true, records: SHARED_STORE });
  const plan = await withFetch(fake, () =>
    planForgetSite('ctx-1', 'https://altro.dev/', sharedSiteData()),
  );
  expect(plan?.items.map((i) => i.group)).toEqual(['session']);
});

test('condivisa: si POSTano i NOMI elencati, non l\'host', async () => {
  const { fake, calls } = fetchWith({ supported: true, records: SHARED_STORE, removed: 2 });
  const removed = await withFetch(fake, () =>
    forgetSite('ctx-1', ['google.com', 'mail.google.com'], sharedSiteData()),
  );
  expect(removed).toBe(2);
  expect(calls[0]).toEqual([
    '/api/browsers/ctx-1/forget-site',
    'POST',
    { displayNames: ['google.com', 'mail.google.com'] },
  ]);
});

test('condivisa: motore esterno = «non li teniamo noi», non «non c\'è niente»', async () => {
  const { fake } = fetchWith({ supported: false, records: [] });
  const plan = await withFetch(fake, () =>
    planForgetSite('ctx-1', 'https://altro.dev/', sharedSiteData()),
  );
  expect(plan).toEqual({ host: 'altro.dev', displayNames: [], items: [], supported: false });
});

test('condivisa: server in errore = piano vuoto, non un tasto che promette', async () => {
  const { fake } = fetchWith({}, { ok: false });
  const plan = await withFetch(fake, () =>
    planForgetSite('ctx-1', 'https://altro.dev/', sharedSiteData()),
  );
  expect(plan).toEqual({ host: 'altro.dev', displayNames: [], items: [], supported: true });
});

test('condivisa: il ctx finisce nella URL scappato, non concatenato a mano', async () => {
  const { fake, calls } = fetchWith({ supported: true, records: [] });
  await withFetch(fake, () => planForgetSite('a/b c', 'https://altro.dev/', sharedSiteData()));
  expect(calls[0][0]).toBe('/api/browsers/a%2Fb%20c/site-data');
});
