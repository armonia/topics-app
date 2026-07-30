/**
 * LAN-PAIR-01 client pairing unit tests. No DOM env under `bun test:unit`, so we
 * stub the three browser globals the module touches (`localStorage`, `history`,
 * `location`) directly on `window`/`globalThis`. Each test re-imports the module
 * fresh so the storage state is deterministic.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  capturePairingTokenFromUrl,
  getPairingToken,
  withTokenHeader,
  withTokenQuery,
} from './pairing';

const TOKEN = 'a'.repeat(64);

// ── Minimal browser-global stubs ────────────────────────────────────────────
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

let replaceCalls: Array<string>;

function stubWindow(href: string): void {
  const url = new URL(href);
  const w = globalThis as unknown as {
    window?: unknown;
    localStorage?: unknown;
    history?: unknown;
    location?: unknown;
  };
  const location = {
    get href() { return url.href; },
    get pathname() { return url.pathname; },
    get search() { return url.search; },
    get hash() { return url.hash; },
  };
  const history = {
    replaceState(_state: unknown, _title: string, nextUrl: string) {
      replaceCalls.push(nextUrl);
      // Reflect the new URL so subsequent reads see the stripped form.
      const abs = new URL(nextUrl, url.origin);
      url.href = abs.href;
    },
  };
  const storage = new MemoryStorage();
  const windowObj = { localStorage: storage, history, location };
  w.window = windowObj;
  w.localStorage = storage;
  w.history = history;
  w.location = location;
}

beforeEach(() => {
  replaceCalls = [];
});

describe('pairing · capturePairingTokenFromUrl', () => {
  test('captures token, strips ONLY it, preserves other params + hash', () => {
    stubWindow(`http://192.168.1.12:3333/app?foo=1&token=${TOKEN}&bar=2#section`);
    capturePairingTokenFromUrl();

    expect(getPairingToken()).toBe(TOKEN);
    expect(replaceCalls).toHaveLength(1);
    const next = new URL(replaceCalls[0], 'http://192.168.1.12:3333');
    expect(next.searchParams.get('token')).toBeNull();
    expect(next.searchParams.get('foo')).toBe('1');
    expect(next.searchParams.get('bar')).toBe('2');
    expect(next.hash).toBe('#section');
  });

  test('no token in URL → no-op (no store, no replaceState)', () => {
    stubWindow('http://192.168.1.12:3333/app?foo=1#h');
    capturePairingTokenFromUrl();
    expect(getPairingToken()).toBeNull();
    expect(replaceCalls).toHaveLength(0);
  });

  test('idempotent: a second capture on the stripped URL does nothing new', () => {
    stubWindow(`http://192.168.1.12:3333/?token=${TOKEN}`);
    capturePairingTokenFromUrl();
    expect(replaceCalls).toHaveLength(1);
    capturePairingTokenFromUrl(); // URL now has no token
    expect(replaceCalls).toHaveLength(1);
    expect(getPairingToken()).toBe(TOKEN);
  });
});

describe('pairing · getPairingToken', () => {
  test('round-trips a stored token', () => {
    stubWindow(`http://192.168.1.12:3333/?token=${TOKEN}`);
    capturePairingTokenFromUrl();
    expect(getPairingToken()).toBe(TOKEN);
  });

  test('null when nothing stored (desktop/loopback)', () => {
    stubWindow('http://localhost:3333/');
    expect(getPairingToken()).toBeNull();
  });
});

describe('pairing · withTokenHeader', () => {
  test('adds x-topics-token when a token is stored', () => {
    stubWindow(`http://192.168.1.12:3333/?token=${TOKEN}`);
    capturePairingTokenFromUrl();
    const h = new Headers(withTokenHeader({ 'Content-Type': 'application/json' }));
    expect(h.get('x-topics-token')).toBe(TOKEN);
    expect(h.get('content-type')).toBe('application/json');
  });

  test('leaves headers untouched when no token (returns the same value)', () => {
    stubWindow('http://localhost:3333/');
    const input = { 'Content-Type': 'application/json' };
    expect(withTokenHeader(input)).toBe(input);
  });
});

describe('pairing · withTokenQuery', () => {
  test('appends ?token= when none present in URL yet', () => {
    stubWindow(`http://192.168.1.12:3333/?token=${TOKEN}`);
    capturePairingTokenFromUrl();
    expect(withTokenQuery('ws://192.168.1.12:3333/ws')).toBe(
      `ws://192.168.1.12:3333/ws?token=${TOKEN}`,
    );
  });

  test('uses & when the URL already has a query', () => {
    stubWindow(`http://192.168.1.12:3333/?token=${TOKEN}`);
    capturePairingTokenFromUrl();
    expect(withTokenQuery('/api/activity/stream?since=5')).toBe(
      `/api/activity/stream?since=5&token=${TOKEN}`,
    );
  });

  test('URL-encodes the token', () => {
    stubWindow('http://192.168.1.12:3333/?token=a%2Fb%2Bc');
    capturePairingTokenFromUrl();
    // stored value is decoded 'a/b+c'; re-encoded on attach
    expect(getPairingToken()).toBe('a/b+c');
    expect(withTokenQuery('/ws')).toBe('/ws?token=a%2Fb%2Bc');
  });

  test('no-op when no token stored', () => {
    stubWindow('http://localhost:3333/');
    expect(withTokenQuery('ws://127.0.0.1:3333/ws')).toBe('ws://127.0.0.1:3333/ws');
  });
});
