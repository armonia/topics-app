/**
 * UN 409 SULLA REVIVE NON È UN FALLIMENTO, È UNA CODA.
 *
 * IL GUASTO (H9). `reopenClosedTab` faceva `if (revived.ok) return record.pane;`
 * e lasciava cadere TUTTO il resto sul `POST /api/terminal/sessions` qui sotto,
 * che conia un id NUOVO. Un 409 era quindi indistinguibile da un 404, e il 409
 * arriva esattamente quando la sessione sta tornando su sotto il SUO id: doppio
 * ⇧⌘T, oppure l'auto-revive della finestra di progetto che parte nello stesso
 * istante. Risultato: due tab, una piena e una vuota — la duplicazione che il
 * commento di quel file dice di voler impedire.
 *
 * LA BARRA: con un 409 in risposta, nessun `POST /api/terminal/sessions`, e la
 * pane torna con lo STESSO id (è l'id che fa collassare in una sola tab le due
 * strade che riportano su la sessione).
 *
 * Il rovescio è nel test: un 404 vero DEVE ancora coniare una sessione nuova,
 * altrimenti «non duplicare» diventa «non riaprire più niente».
 *
 * Il lato server della stessa storia — il perdente che ASPETTA il vincitore
 * invece di ricevere il 409 — sta in `tests/integration/terminal-revive-race.test.ts`.
 * Questo file copre il client contro un server più vecchio, e contro qualunque
 * altra strada che risponda 409 su quell'id.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { reopenClosedTab, type ClosedTabRecord } from './closedTabRecord';

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

interface FetchCall { url: string; method: string }
interface Reply { status: number; body?: unknown }

let calls: FetchCall[];
let realFetch: typeof fetch | undefined;

/** Uno stub con lo STATUS vero: quello del file accanto lo deriva da `ok`
 *  (200 o 404), e con quello un 409 non si può nemmeno scrivere. */
function installFetch(handler: (url: string, method: string) => Reply): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    url: string,
    init?: { method?: string },
  ) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url: String(url), method });
    const res = handler(String(url), method);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => res.body ?? {},
    } as unknown as Response;
  };
}

const terminalRecord = (sid: string): ClosedTabRecord => ({
  id: `terminal:${sid}`,
  closedAt: 456,
  pane: { id: `terminal:${sid}`, type: 'terminal', title: 'claude', terminalType: 'claude-code' },
  groupId: 'g',
  groupIndex: 0,
  level: 'project',
  projectPath: '/tmp/proj',
  terminal: { cwd: '/tmp/proj', sessionType: 'claude-code', name: 'claude', claudeSessionId: 'cs-1' },
});

const postedAFreshSession = () =>
  calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/terminal/sessions'));

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
});
afterEach(() => {
  if (realFetch) (globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch;
});

describe('reopenClosedTab: la revive che trova la coda occupata', () => {
  test('revive 409 → stessa pane, stesso id, NESSUNA sessione nuova', async () => {
    installFetch((url, method) => {
      if (url.endsWith('/api/terminal/sessions/sid409') && method === 'GET') return { status: 404 };
      if (url.endsWith('/api/terminal/sessions/sid409/revive') && method === 'POST') return { status: 409 };
      throw new Error(`fetch inatteso ${method} ${url}`);
    });
    const rec = terminalRecord('sid409');
    const result = await reopenClosedTab(rec);

    expect(result).toBe(rec.pane);
    expect(result.id).toBe('terminal:sid409');
    expect(postedAFreshSession()).toBe(false);
  });

  test('il rovescio: una 404 vera conia ancora una sessione nuova', async () => {
    installFetch((url, method) => {
      if (url.endsWith('/api/terminal/sessions/sid404') && method === 'GET') return { status: 404 };
      if (url.endsWith('/api/terminal/sessions/sid404/revive') && method === 'POST') return { status: 404 };
      if (url.endsWith('/api/terminal/sessions') && method === 'POST') return { status: 200, body: { id: 'nuovo', name: 'claude' } };
      throw new Error(`fetch inatteso ${method} ${url}`);
    });
    const result = await reopenClosedTab(terminalRecord('sid404'));
    expect(result.id).toBe('terminal:nuovo');
  });

  test('un 500 resta un fallimento: la sessione nuova è meglio di una tab morta', async () => {
    installFetch((url, method) => {
      if (url.endsWith('/api/terminal/sessions/sid500') && method === 'GET') return { status: 404 };
      if (url.endsWith('/api/terminal/sessions/sid500/revive') && method === 'POST') return { status: 500 };
      if (url.endsWith('/api/terminal/sessions') && method === 'POST') return { status: 200, body: { id: 'nuovo500', name: 'claude' } };
      throw new Error(`fetch inatteso ${method} ${url}`);
    });
    const result = await reopenClosedTab(terminalRecord('sid500'));
    expect(result.id).toBe('terminal:nuovo500');
  });
});
