/**
 * A `run_command` row in the Processes panel: which rows are commands, and
 * what a finished one says. A command's outcome is why it was launched, so it
 * stays readable after the end: an exit code, «stopped», or unknown, never a
 * guess.
 *
 * @covers CMDRUN-02
 */
import { expect, test } from 'bun:test';
import { commandOutcome, commandRows } from './commandOutcome';
import type { ScriptProcessInfo } from './api';

function sp(over: Partial<ScriptProcessInfo>): ScriptProcessInfo {
  return {
    processId: 'p', scriptName: 'sleep 1', command: 'sleep 1', projectPath: '/p',
    status: 'running', pid: 1, startedAt: '2026-09-27T10:00:00.000Z', ports: [], source: 'command',
    ...over,
  };
}

test('running, exit N, stopped and unknown are four different things', () => {
  expect(commandOutcome(sp({}))).toEqual({ kind: 'running' });
  expect(commandOutcome(sp({ status: 'done', exitCode: 0 }))).toEqual({ kind: 'exit', code: 0 });
  expect(commandOutcome(sp({ status: 'error', exitCode: 3 }))).toEqual({ kind: 'exit', code: 3 });
  expect(commandOutcome(sp({ status: 'error', exitCode: -1, stopped: true }))).toEqual({ kind: 'stopped' });
  expect(commandOutcome(sp({ status: 'error' }))).toEqual({ kind: 'unknown' });
});

test('the panel lists the commands, live first, and keeps the finished ones', () => {
  const rows = commandRows([
    sp({ processId: 'done', status: 'error', exitCode: 3 }),
    sp({ processId: 'script', source: 'script' }),
    sp({ processId: 'live' }),
    sp({ processId: 'shell', source: 'shell' }),
  ]);
  expect(rows.map((r) => r.processId)).toEqual(['live', 'done']);
});
