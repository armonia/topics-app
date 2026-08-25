/**
 * Merging the browser storage state kept per topic, so restoring a context
 * never signs out the session the other side already held.
 *
 * @covers BROWSER-CHAT-01
 */
import { test, expect } from 'bun:test';
import { mergeStorageState, type StorageState } from './browser-login-state';

const empty: StorageState = { cookies: [], origins: [] };

test('un cookie che c\'è solo nella base sopravvive al merge', () => {
  const base: StorageState = {
    cookies: [{ name: 'phone_sid', value: 'p', domain: 'shared.example', path: '/' }],
    origins: [],
  };
  const incoming: StorageState = {
    cookies: [{ name: 'mac_sid', value: 'm', domain: 'native.example', path: '/' }],
    origins: [],
  };
  const out = mergeStorageState(base, incoming);
  // Il punto del merge: passare la sessione nativa NON deve sloggare chi si era
  // loggato dal telefono sulla sessione condivisa.
  expect(out.cookies.map((c) => c.name).sort()).toEqual(['mac_sid', 'phone_sid']);
  expect(out.cookies.find((c) => c.name === 'phone_sid')?.value).toBe('p');
});

test('in conflitto vince la BASE: il nativo non puo\' sloggare la sessione condivisa', () => {
  const base: StorageState = {
    cookies: [
      { name: 'a', value: 'base-a', domain: 'example.com', path: '/' },
      { name: 'sid', value: 'FRESCO-DAL-TELEFONO', domain: 'example.com', path: '/' },
      { name: 'z', value: 'base-z', domain: 'example.com', path: '/' },
    ],
    origins: [],
  };
  // Il barattolo nativo puo\' contenere una sessione lasciata li\' mesi fa: non
  // e\' scaduta, quindi arriva, ma non e\' piu\' buona. Se sostituisse, quel
  // cookie morto butterebbe fuori il login appena fatto dal telefono — e il
  // risultato si scrive su disco, quindi per sempre.
  const extra: StorageState = {
    cookies: [{ name: 'sid', value: 'VECCHIO-DAL-MAC', domain: 'example.com', path: '/' }],
    origins: [],
  };
  const out = mergeStorageState(base, extra);
  expect(out.cookies).toHaveLength(3);
  expect(out.cookies[1]!.value).toBe('FRESCO-DAL-TELEFONO');
  expect(out.cookies.map((c) => c.name)).toEqual(['a', 'sid', 'z']);
});

test('stesso nome su domini diversi sono DUE cookie, non un conflitto', () => {
  const base: StorageState = {
    cookies: [{ name: 'session', value: 'github', domain: 'github.com', path: '/' }],
    origins: [],
  };
  const incoming: StorageState = {
    cookies: [{ name: 'session', value: 'gitlab', domain: 'gitlab.com', path: '/' }],
    origins: [],
  };
  const out = mergeStorageState(base, incoming);
  expect(out.cookies).toHaveLength(2);
  expect(out.cookies.map((c) => c.value).sort()).toEqual(['github', 'gitlab']);
});

test('stesso nome e dominio ma path diverso sono DUE cookie', () => {
  const base: StorageState = {
    cookies: [{ name: 'sid', value: 'root', domain: 'example.com', path: '/' }],
    origins: [],
  };
  const incoming: StorageState = {
    cookies: [{ name: 'sid', value: 'admin', domain: 'example.com', path: '/admin' }],
    origins: [],
  };
  expect(mergeStorageState(base, incoming).cookies).toHaveLength(2);
});

test('path assente vale "/" — lo stesso cookie non si sdoppia fra le due parti', () => {
  // Il pane nativo inietta con path "/" quando manca (cookies_set_blocking), il
  // dump di Playwright lo riporta esplicito: senza normalizzazione la stessa
  // sessione tornerebbe indietro come due cookie e uno dei due vincerebbe a caso.
  const base: StorageState = {
    cookies: [{ name: 'sid', value: 'della-base', domain: 'example.com', path: '/' }],
    origins: [],
  };
  const extra: StorageState = {
    cookies: [{ name: 'sid', value: 'del-nativo', domain: 'example.com' }],
    origins: [],
  };
  const out = mergeStorageState(base, extra);
  expect(out.cookies).toHaveLength(1);
  expect(out.cookies[0]!.value).toBe('della-base');
});

test('il dominio è confrontato senza distinzione di maiuscole', () => {
  const base: StorageState = {
    cookies: [{ name: 'sid', value: 'vecchio', domain: 'Example.COM', path: '/' }],
    origins: [],
  };
  const incoming: StorageState = {
    cookies: [{ name: 'sid', value: 'nuovo', domain: 'example.com', path: '/' }],
    origins: [],
  };
  expect(mergeStorageState(base, incoming).cookies).toHaveLength(1);
});

test('il localStorage riempie i buchi per origine, senza sostituire', () => {
  const base: StorageState = {
    cookies: [],
    origins: [
      {
        origin: 'https://example.com',
        localStorage: [
          { name: 'theme', value: 'dark' },
          { name: 'token', value: 'VECCHIO' },
        ],
      },
      { origin: 'https://altro.com', localStorage: [{ name: 'k', value: 'v' }] },
    ],
  };
  const incoming: StorageState = {
    cookies: [],
    origins: [
      {
        origin: 'https://example.com',
        localStorage: [
          { name: 'token', value: 'NUOVO' },
          { name: 'extra', value: 'e' },
        ],
      },
    ],
  };
  const out = mergeStorageState(base, incoming);
  expect(out.origins).toHaveLength(2);
  const ex = out.origins.find((o) => o.origin === 'https://example.com')!;
  // `token` c'era gia\': resta quello della base. `extra` mancava: entra.
  expect(ex.localStorage).toEqual([
    { name: 'theme', value: 'dark' },
    { name: 'token', value: 'VECCHIO' },
    { name: 'extra', value: 'e' },
  ]);
  // L'origine che l'arrivo non nomina resta intatta.
  expect(out.origins.find((o) => o.origin === 'https://altro.com')!.localStorage).toEqual([
    { name: 'k', value: 'v' },
  ]);
});

test('i campi che il tipo non nomina (IndexedDB) sopravvivono al merge', () => {
  // La sessione condivisa si persiste con `storageState({ indexedDB: true })`
  // (browser-service.ts:1049): un'origine porta più di quello che StorageOrigin
  // dichiara. Un merge che ricostruisce `{origin, localStorage}` da zero
  // cancella l'IndexedDB, cioè metà dei login moderni — e lo fa in silenzio.
  const base = {
    cookies: [],
    origins: [
      {
        origin: 'https://example.com',
        localStorage: [{ name: 'a', value: '1' }],
        indexedDB: [{ name: 'firebaseLocalStorageDb', version: 1 }],
      },
    ],
  } as unknown as StorageState;
  const incoming: StorageState = {
    cookies: [],
    origins: [{ origin: 'https://example.com', localStorage: [{ name: 'b', value: '2' }] }],
  };
  const out = mergeStorageState(base, incoming) as unknown as {
    origins: Array<{ origin: string; localStorage: unknown[]; indexedDB?: unknown[] }>;
  };
  expect(out.origins[0]!.indexedDB).toEqual([{ name: 'firebaseLocalStorageDb', version: 1 }]);
  expect(out.origins[0]!.localStorage).toEqual([
    { name: 'a', value: '1' },
    { name: 'b', value: '2' },
  ]);
});

test('un\'origine che sta SOLO nella base tiene i suoi campi in più', () => {
  const base = {
    cookies: [],
    origins: [{ origin: 'https://solo-base.com', localStorage: [], indexedDB: [{ name: 'db' }] }],
  } as unknown as StorageState;
  const out = mergeStorageState(base, { cookies: [], origins: [] }) as unknown as {
    origins: Array<{ indexedDB?: unknown[] }>;
  };
  expect(out.origins[0]!.indexedDB).toEqual([{ name: 'db' }]);
});

test('fondere con un arrivo vuoto non tocca la base', () => {
  const base: StorageState = {
    cookies: [{ name: 'sid', value: 's', domain: 'example.com', path: '/' }],
    origins: [{ origin: 'https://example.com', localStorage: [{ name: 'k', value: 'v' }] }],
  };
  expect(mergeStorageState(base, empty)).toEqual(base);
});

test('il merge è idempotente: rifarlo non cambia il risultato', () => {
  const base: StorageState = {
    cookies: [{ name: 'a', value: '1', domain: 'x.com', path: '/' }],
    origins: [{ origin: 'https://x.com', localStorage: [{ name: 'k', value: 'v' }] }],
  };
  const incoming: StorageState = {
    cookies: [{ name: 'b', value: '2', domain: 'y.com', path: '/' }],
    origins: [{ origin: 'https://y.com', localStorage: [{ name: 'j', value: 'w' }] }],
  };
  const once = mergeStorageState(base, incoming);
  // Il flip può ballare (debounce 1200ms): lo stesso passaggio rifatto due volte
  // deve dare lo stesso file, o il salvataggio su disco sbatte a vuoto ogni giro.
  expect(mergeStorageState(once, incoming)).toEqual(once);
});

test('il merge non muta gli input', () => {
  const base: StorageState = {
    cookies: [{ name: 'a', value: '1', domain: 'x.com', path: '/' }],
    origins: [{ origin: 'https://x.com', localStorage: [{ name: 'k', value: 'v' }] }],
  };
  const incoming: StorageState = {
    cookies: [{ name: 'a', value: '2', domain: 'x.com', path: '/' }],
    origins: [{ origin: 'https://x.com', localStorage: [{ name: 'k', value: 'w' }] }],
  };
  mergeStorageState(base, incoming);
  expect(base.cookies[0]!.value).toBe('1');
  expect(base.origins[0]!.localStorage).toEqual([{ name: 'k', value: 'v' }]);
});

test('voci malformate vengono scartate invece di finire nel barattolo', () => {
  const base = { cookies: [null, { value: 'senza nome' }], origins: [{ origin: '' }, null] } as unknown as StorageState;
  const out = mergeStorageState(base, empty);
  expect(out).toEqual(empty);
});
