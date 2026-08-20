import { describe, expect, test } from 'bun:test';
import { pickWaitedEntry } from './useWaitedProcess';
import { shellProcessKey } from '../../../shared/background-shell-registry';
import type { ScriptProcessInfo } from '../lib/api';

const riga = (over: Partial<ScriptProcessInfo>): ScriptProcessInfo => ({
  processId: 'p1', scriptName: 'dev', command: 'bun dev', projectPath: '/p',
  status: 'running', pid: 1, startedAt: '2025-01-01T00:00:00.000Z', ports: [],
  ...over,
});

describe('pickWaitedEntry', () => {
  test('senza id non si aggancia a niente: meglio muta che sbagliata', () => {
    expect(pickWaitedEntry([riga({})], undefined)).toBeUndefined();
  });

  test('l\'id di processo e\' la chiave piu\' forte', () => {
    const found = pickWaitedEntry([riga({ processId: 'p9', scriptName: 'test' })], 'p9');
    expect(found?.scriptName).toBe('test');
  });

  test('a parita\' di id vince la voce VIVA: la stessa riga compare anche fra le recenti', () => {
    const scripts = [
      riga({ processId: 'p1', status: 'done', exitCode: 0 }),
      riga({ processId: 'p1', status: 'running' }),
    ];
    expect(pickWaitedEntry(scripts, 'p1')?.status).toBe('running');
  });

  test('l\'id di una shell si traduce nella sua chiave, come fa la rotta', () => {
    const key = shellProcessKey('topic:abc', 'bash_1');
    const scripts = [riga({ processId: key, source: 'shell', shellId: 'bash_1' })];
    expect(pickWaitedEntry(scripts, 'bash_1', 'topic:abc')?.processId).toBe(key);
    // Senza la sessione non si indovina: sarebbe la shell di un'altra chat.
    expect(pickWaitedEntry(scripts, 'bash_1')).toBeUndefined();
  });

  test('un processo che il registro non conosce non diventa un altro processo', () => {
    expect(pickWaitedEntry([riga({ processId: 'p1' })], 'p2')).toBeUndefined();
  });
});
