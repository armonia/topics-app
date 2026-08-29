/**
 * A RESTART THAT FAILED HAS TO SHOW, AND A RETRY THAT WORKED HAS TO CLEAR IT.
 *
 * The failure that mattered was invisible: `POST /api/openclaw/restart` answers
 * HTTP 200 with `{ ok: false, exitCode: 1 }` when the command exits non-zero, and
 * the client only looked at the status code. So the most common failure landed
 * in the success branch in silence. The second half is the twin: the red band
 * was set and never cleared except by unmounting, and the panel does not unmount
 * when you click inside it, so a successful retry kept the band on screen.
 *
 * @covers SYSTEM-02
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { openclawControlApi } from './api';
import { runGatewayRestart } from './openclawRestart';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answerWith(body: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
}

/** The panel's state, reduced to what the attempt is allowed to touch. */
function panel() {
  const restarting: boolean[] = [];
  let error: string | null = null;
  const errors: (string | null)[] = [];
  let refreshes = 0;
  return {
    get error() {
      return error;
    },
    errors,
    restarting,
    get refreshes() {
      return refreshes;
    },
    deps: {
      restart: () => openclawControlApi.restart(),
      setRestarting: (v: boolean) => restarting.push(v),
      setError: (m: string | null) => {
        error = m;
        errors.push(m);
      },
      scheduleRefresh: () => {
        refreshes++;
      },
    },
  };
}

describe('runGatewayRestart', () => {
  test('HTTP 200 con ok:false è un fallimento, non un successo silenzioso', async () => {
    answerWith({ ok: false, output: 'gateway not running\n', exitCode: 1 });
    const p = panel();
    await runGatewayRestart(p.deps);
    expect(p.error).toBe('gateway not running');
    expect(p.refreshes).toBe(0);
    expect(p.restarting).toEqual([true, false]);
  });

  test('un fallimento muto porta comunque il codice di uscita', async () => {
    answerWith({ ok: false, exitCode: 3 });
    const p = panel();
    await runGatewayRestart(p.deps);
    expect(p.error).toBe('Riavvio non riuscito (codice 3)');
  });

  test('il secondo tentativo, riuscito, spegne la banda rossa', async () => {
    answerWith({ ok: false, output: 'boom', exitCode: 1 });
    const p = panel();
    await runGatewayRestart(p.deps);
    expect(p.error).toBe('boom');

    answerWith({ ok: true, output: 'restarted', exitCode: 0 });
    await runGatewayRestart(p.deps);
    expect(p.error).toBeNull();
    expect(p.refreshes).toBe(1);
  });

  test('server irraggiungibile: il motivo arriva in pagina', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Failed to fetch');
    }) as unknown as typeof fetch;
    const p = panel();
    await runGatewayRestart(p.deps);
    expect(p.error).toBe('Failed to fetch');
    expect(p.restarting).toEqual([true, false]);
  });

  test('404 (provider non openclaw): il messaggio del server, non un 200 finto', async () => {
    answerWith({ ok: false, error: 'Restart is only supported with the OpenClaw provider' }, 404);
    const p = panel();
    await runGatewayRestart(p.deps);
    expect(p.error).toBe('Restart is only supported with the OpenClaw provider');
  });
});
