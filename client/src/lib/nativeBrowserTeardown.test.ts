import { describe, it, expect } from 'bun:test';
import {
  NATIVE_BROWSER_TEARDOWN_COMMANDS,
  teardownNativeBrowserPane,
} from './nativeBrowserTeardown';

/**
 * Il test guarda l'ORDINE, che è la cosa che si rompe in silenzio: invertire le
 * due righe non fallisce niente su un Mac, e su Windows e Linux fa tornare il
 * purge a essere un no-op muto. Vedi il commento del modulo.
 *
 * @covers BROWSER-01
 */
describe('teardownNativeBrowserPane', () => {
  function record() {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    const invoke = (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return Promise.resolve();
    };
    return { calls, invoke };
  }

  it('svuota la cache PRIMA di chiudere la webview', () => {
    const { calls, invoke } = record();
    teardownNativeBrowserPane('browser:abc', invoke);
    expect(calls.map((c) => c.cmd)).toEqual(['browser_purge_cache', 'browser_close']);
  });

  it('manda a entrambi il contextId della pane', () => {
    const { calls, invoke } = record();
    teardownNativeBrowserPane('browser:abc', invoke);
    expect(calls.map((c) => c.args)).toEqual([{ id: 'browser:abc' }, { id: 'browser:abc' }]);
  });

  it('la lista dichiarata e i comandi mandati sono la stessa cosa', () => {
    const { calls, invoke } = record();
    teardownNativeBrowserPane('browser:abc', invoke);
    expect(calls.map((c) => c.cmd)).toEqual([...NATIVE_BROWSER_TEARDOWN_COMMANDS]);
  });

  it('un comando che fallisce non ferma quello dopo', () => {
    const calls: string[] = [];
    const invoke = (cmd: string) => {
      calls.push(cmd);
      return Promise.reject(new Error('not running under Tauri'));
    };
    expect(() => teardownNativeBrowserPane('browser:abc', invoke)).not.toThrow();
    expect(calls).toEqual(['browser_purge_cache', 'browser_close']);
  });
});
