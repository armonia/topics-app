/**
 * Il patto del comando «Dimentica questo sito», provato dove si può rompere.
 *
 * Due cose devono reggere, e sono le due che l'umano ha chiesto:
 *  · si cancella SOLO questo sito (il resto dello store non compare nel piano);
 *  · si cancella ESATTAMENTE quello che il dialogo ha mostrato (i nomi che
 *    tornano al nativo sono i nomi elencati, non un secondo filtro fatto dopo).
 *
 * Il nativo non c'è, e non serve: `planForgetSite`/`forgetSite` prendono
 * l'`invoke` come parametro, come `tauriBrowserOps`.
 */
import { test, expect } from 'bun:test';
import {
  siteHostOf,
  matchSiteRecords,
  describeSiteData,
  siteRecordNames,
  planForgetSite,
  forgetSite,
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
  return { invoke, calls };
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
  const { invoke, calls } = invokeWith(STORE);
  const plan = await planForgetSite('ctx', 'https://mail.google.com/inbox', invoke);
  expect(plan?.host).toBe('mail.google.com');
  expect(plan?.displayNames).toEqual(['google.com']);
  expect(calls.map((c) => c[0])).toEqual(['browser_site_data_records']);
});

test('IL PATTO: si cancellano esattamente i record elencati nel piano', async () => {
  const { invoke, calls } = invokeWith(STORE);
  const plan = await planForgetSite('ctx', 'https://github.com/armonia', invoke);
  const removed = await forgetSite('ctx', plan!.displayNames, invoke);
  expect(removed).toBe(2);
  expect(calls[1]).toEqual(['browser_forget_site', { id: 'ctx', displayNames: plan!.displayNames }]);
});

test('pane vuota: nessun piano, quindi nessun tasto da premere', async () => {
  const { invoke, calls } = invokeWith(STORE);
  expect(await planForgetSite('ctx', 'about:blank', invoke)).toBeNull();
  expect(calls).toEqual([]);
});

test('store illeggibile: piano vuoto, non una promessa a vuoto', async () => {
  const invoke = async <T,>(): Promise<T> => {
    throw new Error('no such browser pane');
  };
  const plan = await planForgetSite('ctx', 'https://github.com/', invoke);
  expect(plan).toEqual({ host: 'github.com', displayNames: [], items: [] });
});

test('lista vuota: non si chiama il nativo per cancellare niente', async () => {
  const { invoke, calls } = invokeWith(STORE);
  expect(await forgetSite('ctx', [], invoke)).toBe(0);
  expect(calls).toEqual([]);
});
