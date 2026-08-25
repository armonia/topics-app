/**
 * Il verso di LETTURA delle preferenze (`AppSettings`).
 *
 * `saveSettings` faceva il PUT su `ui_state/settings` da sempre; nessuno ha mai
 * letto indietro. Il server accumulava una chiave che non tornava a nessuno:
 * bastava un secondo dispositivo, un localStorage pulito o la WebView del
 * guscio desktop (che ha il suo storage) per ripartire dai default con il
 * valore giusto fermo sul server.
 *
 * Qui sono inchiodate le tre cose che rendono quel verso sicuro, tutte e tre
 * lezioni già pagate care su `sidebar-state`:
 *  1. si SANIFICA sempre (le buste GET annidate, altrimenti ripersistite);
 *  2. non si SCRIVE prima di aver letto (un client fresco pubblicherebbe i
 *     DEFAULT e cancellerebbe le preferenze di tutti sotto LWW — è così che si
 *     persero i pin della sidebar). Ma la modifica fatta nel frattempo si
 *     PARCHEGGIA, non si butta: un gate non deve perdere dati;
 *  3. la geometria della finestra (`sidebarWidth`, `sidebarCollapsed`) non
 *     viaggia, in nessuno dei due versi.
 *
 * bun:test non ha DOM: qui sotto ci sono uno storage in memoria, un `window`
 * minimo per gli eventi e una `fetch` che registra le chiamate.
 *
 * @covers CMD-01
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  DEVICE_LOCAL_SETTING_KEYS,
  SETTINGS_CHANGED_EVENT,
  SETTINGS_SERVER_KEY,
  applyServerSettings,
  loadSettings,
  markSettingsHydrated,
  msSinceLocalSettingsChange,
  sanitizeSettingsPayload,
  saveSettings,
  syncableSettings,
  __resetSettingsSyncState,
} from './settings';
import type { AppSettings } from '../types';

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
}

type FetchCall = { url: string; method?: string; body?: unknown };
let fetchCalls: FetchCall[] = [];
let dispatched: string[] = [];

const g = globalThis as unknown as {
  localStorage: MemoryStorage;
  window: { dispatchEvent: (e: { type: string }) => boolean };
  fetch: (url: string, init?: { method?: string; body?: string }) => Promise<unknown>;
  Event: unknown;
};

class StubEvent { type: string; constructor(type: string) { this.type = type; } }

// `bun test` esegue TUTTI i file nello stesso processo: uno stub globale che
// resta appeso arriva ai file dopo (una `fetch` finta qui faceva fallire il
// round-trip su WebSocket in `server/browser-native-delegate.socket.test.ts`).
// Si ripristina quello che c'era.
const realGlobals = {
  localStorage: (globalThis as Record<string, unknown>).localStorage,
  window: (globalThis as Record<string, unknown>).window,
  fetch: (globalThis as Record<string, unknown>).fetch,
  Event: (globalThis as Record<string, unknown>).Event,
};
afterAll(() => {
  const gg = globalThis as Record<string, unknown>;
  for (const [k, v] of Object.entries(realGlobals)) {
    if (v === undefined) delete gg[k];
    else gg[k] = v;
  }
});

beforeEach(() => {
  g.localStorage = new MemoryStorage();
  dispatched = [];
  g.window = { dispatchEvent: (e) => { dispatched.push(e.type); return true; } };
  g.Event = StubEvent;
  fetchCalls = [];
  g.fetch = (url, init) => {
    fetchCalls.push({
      url,
      method: init?.method,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return Promise.resolve({ ok: true });
  };
  __resetSettingsSyncState();
});

// ── sanitizeSettingsPayload ─────────────────────────────────────────────────

describe('sanitizeSettingsPayload', () => {
  test('tiene solo le chiavi note, butta la spazzatura', () => {
    const out = sanitizeSettingsPayload({ fontSize: 17, junk: 1, payload_version: 2, server_seq: 9 });
    expect(out).toEqual({ fontSize: 17 });
  });

  test('srotola una busta GET', () => {
    const out = sanitizeSettingsPayload({ value: { fontSize: 18 }, payload_version: 2, server_seq: 42 });
    expect(out).toEqual({ fontSize: 18 });
  });

  test('srotola le buste ANNIDATE — la corruzione già vista su sidebar-state', () => {
    const corrupted = {
      value: {
        payload_version: 2,
        server_seq: 993,
        value: { payload_version: 1, server_seq: 0, value: { fontSize: 19, notificationsSound: false } },
      },
      payload_version: 2,
      server_seq: 1357664,
    };
    expect(sanitizeSettingsPayload(corrupted)).toEqual({ fontSize: 19, notificationsSound: false });
  });

  test('non srotola all’infinito su una busta che si auto-riferisce', () => {
    const loop: Record<string, unknown> = { payload_version: 2 };
    loop.value = loop;
    expect(sanitizeSettingsPayload(loop)).toEqual({});
  });

  test('la geometria della finestra non entra MAI dall’idratazione', () => {
    const out = sanitizeSettingsPayload({ fontSize: 15, sidebarWidth: 999, sidebarCollapsed: true });
    expect(out).toEqual({ fontSize: 15 });
    for (const k of DEVICE_LOCAL_SETTING_KEYS) expect(out && k in out).toBe(false);
  });

  test('null su un payload inutilizzabile', () => {
    expect(sanitizeSettingsPayload(null)).toBe(null);
    expect(sanitizeSettingsPayload(42)).toBe(null);
    expect(sanitizeSettingsPayload([1, 2])).toBe(null);
    expect(sanitizeSettingsPayload({ value: 'stringa', server_seq: 1 })).toBe(null);
  });
});

// ── syncableSettings ────────────────────────────────────────────────────────

describe('syncableSettings', () => {
  test('sale tutto tranne la geometria della finestra', () => {
    const out = syncableSettings({ ...DEFAULT_SETTINGS, sidebarWidth: 512, sidebarCollapsed: true });
    for (const k of DEVICE_LOCAL_SETTING_KEYS) expect(k in out).toBe(false);
    expect(out.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect(out.notificationsEnabled).toBe(DEFAULT_SETTINGS.notificationsEnabled);
  });

  test('non muta l’oggetto passato', () => {
    const s: AppSettings = { ...DEFAULT_SETTINGS, sidebarWidth: 512 };
    syncableSettings(s);
    expect(s.sidebarWidth).toBe(512);
  });
});

// ── applyServerSettings ─────────────────────────────────────────────────────

describe('applyServerSettings', () => {
  test('fonde sopra il locale, scrive localStorage e sveglia i vivi', () => {
    saveSettings({ ...DEFAULT_SETTINGS, fontSize: 13, sidebarWidth: 400 });
    dispatched = [];

    const merged = applyServerSettings({
      value: { fontSize: 20, notificationsEnabled: false },
      payload_version: 2,
      server_seq: 7,
    });

    expect(merged?.fontSize).toBe(20);
    expect(merged?.notificationsEnabled).toBe(false);
    expect(loadSettings().fontSize).toBe(20);
    expect(dispatched).toContain(SETTINGS_CHANGED_EVENT);
  });

  test('la geometria locale sopravvive all’idratazione', () => {
    saveSettings({ ...DEFAULT_SETTINGS, sidebarWidth: 400, sidebarCollapsed: true });
    applyServerSettings({ fontSize: 20, sidebarWidth: 999, sidebarCollapsed: false });
    expect(loadSettings().sidebarWidth).toBe(400);
    expect(loadSettings().sidebarCollapsed).toBe(true);
  });

  test('un payload vuoto NON riporta ai default — il locale è più fresco del nulla', () => {
    saveSettings({ ...DEFAULT_SETTINGS, fontSize: 21 });
    dispatched = [];
    expect(applyServerSettings({})).toBe(null);
    expect(applyServerSettings(null)).toBe(null);
    expect(applyServerSettings({ value: { junk: 1 }, server_seq: 3 })).toBe(null);
    expect(loadSettings().fontSize).toBe(21);
    expect(dispatched).not.toContain(SETTINGS_CHANGED_EVENT);
  });
});

// ── Il gate: non pubblicare prima di aver letto ─────────────────────────────

describe('gate di idratazione', () => {
  test('prima dell’idratazione il PUT non parte — parcheggia', async () => {
    saveSettings({ ...DEFAULT_SETTINGS, fontSize: 22 });
    await Bun.sleep(1100);
    expect(fetchCalls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  test('…e parte appena l’idratazione ha esito, col valore parcheggiato', async () => {
    saveSettings({ ...DEFAULT_SETTINGS, fontSize: 22 });
    await Bun.sleep(1100);
    markSettingsHydrated();

    const puts = fetchCalls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toContain(`/api/ui-state/${SETTINGS_SERVER_KEY}`);
    expect((puts[0].body as AppSettings).fontSize).toBe(22);
  });

  test('dopo l’idratazione il PUT parte da solo, senza la geometria', async () => {
    markSettingsHydrated();
    saveSettings({ ...DEFAULT_SETTINGS, fontSize: 23, sidebarWidth: 512 });
    await Bun.sleep(1100);

    const puts = fetchCalls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    const body = puts[0].body as Record<string, unknown>;
    expect(body.fontSize).toBe(23);
    for (const k of DEVICE_LOCAL_SETTING_KEYS) expect(k in body).toBe(false);
  });

  test('idratare due volte non rimanda il parcheggiato', async () => {
    saveSettings({ ...DEFAULT_SETTINGS, fontSize: 24 });
    await Bun.sleep(1100);
    markSettingsHydrated();
    markSettingsHydrated();
    expect(fetchCalls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });
});

// ── La finestra di grazia ───────────────────────────────────────────────────

describe('msSinceLocalSettingsChange', () => {
  test('un salvataggio appena fatto è "adesso"', () => {
    saveSettings({ ...DEFAULT_SETTINGS });
    expect(msSinceLocalSettingsChange()).toBeLessThan(500);
  });

  test('senza modifiche locali la distanza è enorme — nessuna precedenza', () => {
    expect(msSinceLocalSettingsChange()).toBeGreaterThan(1_000_000);
  });
});
