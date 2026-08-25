/**
 * When a finished process counts as failed: a non-zero exit inside the window,
 * told apart from a deliberate stop and from a server reload.
 *
 * @covers PROCESS-01
 */
import { test, expect } from 'bun:test';
import { isRecentFailure, lastFailureByScript, FAILURE_WINDOW_MS } from './processFailure';
import type { ScriptProcessInfo } from './api';

const NOW = Date.UTC(2026, 7, 6, 12, 0, 0);
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function sp(over: Partial<ScriptProcessInfo>): ScriptProcessInfo {
  return {
    processId: 'p1', scriptName: 'build', command: 'bun run build',
    projectPath: '/p', status: 'error', pid: null, startedAt: at(60_000),
    completedAt: at(1_000), exitCode: 1, ports: [],
    ...over,
  } as ScriptProcessInfo;
}

test('un exit non-zero recente è un fallimento', () => {
  expect(isRecentFailure(sp({}), NOW)).toBe(true);
});

test('exitCode -1 NON è un fallimento: è uno stop volontario o un reload del server', () => {
  // È il caso che accendeva la pastiglia rossa a ogni salvataggio sotto server/.
  expect(isRecentFailure(sp({ exitCode: -1 }), NOW)).toBe(false);
  expect(isRecentFailure(sp({ exitCode: undefined }), NOW)).toBe(false);
});

test('exit 0 non è un fallimento nemmeno con status error', () => {
  expect(isRecentFailure(sp({ exitCode: 0 }), NOW)).toBe(false);
});

test('un processo ancora vivo non è un fallimento', () => {
  expect(isRecentFailure(sp({ status: 'running', completedAt: undefined }), NOW)).toBe(false);
  expect(isRecentFailure(sp({ status: 'done', exitCode: 0 }), NOW)).toBe(false);
});

test('fuori dalla finestra il segnale si spegne', () => {
  // `recent` è persistito su disco: senza finestra, un rosso di ieri resterebbe
  // acceso per sempre.
  expect(isRecentFailure(sp({ completedAt: at(FAILURE_WINDOW_MS - 1_000) }), NOW)).toBe(true);
  expect(isRecentFailure(sp({ completedAt: at(FAILURE_WINDOW_MS + 1_000) }), NOW)).toBe(false);
});

test('senza completedAt non si può datare, quindi non si segnala', () => {
  expect(isRecentFailure(sp({ completedAt: undefined }), NOW)).toBe(false);
});

test('un completedAt nel futuro (orologio storto) non passa', () => {
  expect(isRecentFailure(sp({ completedAt: at(-60_000) }), NOW)).toBe(false);
});

test('per nome di script vince il fallimento più recente', () => {
  const m = lastFailureByScript([
    sp({ processId: 'a', completedAt: at(300_000) }),
    sp({ processId: 'b', completedAt: at(5_000) }),
    sp({ processId: 'c', scriptName: 'test', completedAt: at(9_000) }),
    sp({ processId: 'd', scriptName: 'dev', exitCode: -1 }),
  ], NOW);
  expect(m.get('build')?.processId).toBe('b');
  expect(m.get('test')?.processId).toBe('c');
  expect(m.has('dev')).toBe(false);
});
