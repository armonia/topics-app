/**
 * Exercise the real store and cache writer with browser globals installed
 * BEFORE module import. Other unit files import these document singletons,
 * so an isolated process avoids depending on test-file execution order.
 *
 * @covers KANBAN-06
 */
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('board cache folds distinct updates, flushes the last state on hide, and recovers after quota errors', () => {
  const storePath = resolve(import.meta.dir, 'boardTasksStore.ts');
  const script = `
    let serializations = 0, saves = 0, failStorage = false, callbacks = 0;
    const data = new Map(), timers = new Map(), windowEvents = new Map(), documentEvents = new Map();
    let timerId = 0;
    globalThis.localStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => { if (failStorage) throw new Error('quota'); saves++; data.set(key, value); },
    };
    globalThis.window = { addEventListener: (name, handler) => windowEvents.set(name, handler) };
    globalThis.document = { visibilityState: 'visible', addEventListener: (name, handler) => documentEvents.set(name, handler) };
    globalThis.setTimeout = (handler) => { timers.set(++timerId, handler); return timerId; };
    globalThis.clearTimeout = (id) => timers.delete(id);
    const { setBoardTasks, patchBoardTask, applyBoardTaskFrame, getBoardTasks, subscribeBoardTasks } = await import(${JSON.stringify(storePath)});
    const flushTimers = () => { const work = [...timers.values()]; timers.clear(); for (const run of work) run(); };
    const stringify = JSON.stringify;
    JSON.stringify = (...args) => { serializations++; return stringify(...args); };
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: 't' + i, projectId: 'p', text: 'task', status: 'todo', agentTokens: 0 }));
    setBoardTasks(rows);
    flushTimers();
    serializations = 0; saves = 0;
    subscribeBoardTasks(() => callbacks++);
    for (let i = 0; i < 20; i++) applyBoardTaskFrame(structuredClone(rows[0]));
    flushTimers();
    const noOp = { serializations, saves, callbacks };
    for (let i = 1; i <= 20; i++) patchBoardTask('t0', { agentTokens: i });
    const beforeFlush = { serializations, saves, callbacks, timers: timers.size, live: getBoardTasks()[0].agentTokens };
    flushTimers();
    const persisted = () => JSON.parse(data.get('board-rows-cache:all'));
    const burst = { serializations, saves, callbacks, saved: persisted()[0].agentTokens, cachedRows: persisted().length };

    patchBoardTask('t0', { agentTokens: 21 });
    windowEvents.get('pagehide')?.();
    const pageExit = { saved: persisted()[0].agentTokens, timers: timers.size };
    patchBoardTask('t0', { agentTokens: 22 });
    document.visibilityState = 'hidden';
    documentEvents.get('visibilitychange')?.();
    const hidden = { saved: persisted()[0].agentTokens, timers: timers.size };

    failStorage = true;
    patchBoardTask('t0', { agentTokens: 23 });
    flushTimers();
    const quota = { live: getBoardTasks()[0].agentTokens, saved: persisted()[0].agentTokens };
    failStorage = false;
    patchBoardTask('t0', { agentTokens: 24 });
    flushTimers();
    const recovered = { live: getBoardTasks()[0].agentTokens, saved: persisted()[0].agentTokens };
    process.stdout.write(stringify({ noOp, beforeFlush, burst, pageExit, hidden, quota, recovered }));
  `;
  const child = Bun.spawnSync([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  const result = JSON.parse(new TextDecoder().decode(child.stdout));
  console.info(JSON.stringify({ probe: 'board-cache-persistence', ...result }));
  expect(result.noOp).toEqual({ serializations: 0, saves: 0, callbacks: 0 });
  expect(result.beforeFlush).toEqual({ serializations: 0, saves: 0, callbacks: 20, timers: 1, live: 20 });
  expect(result.burst).toEqual({ serializations: 1, saves: 1, callbacks: 20, saved: 20, cachedRows: 200 });
  expect(result.pageExit).toEqual({ saved: 21, timers: 0 });
  expect(result.hidden).toEqual({ saved: 22, timers: 0 });
  expect(result.quota).toEqual({ live: 23, saved: 22 });
  expect(result.recovered).toEqual({ live: 24, saved: 24 });
});
