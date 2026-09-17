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
    const delays = [];
    globalThis.localStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => { if (failStorage) throw new Error('quota'); saves++; data.set(key, value); },
    };
    globalThis.window = { addEventListener: (name, handler) => windowEvents.set(name, handler) };
    globalThis.document = { visibilityState: 'visible', addEventListener: (name, handler) => documentEvents.set(name, handler) };
    globalThis.setTimeout = (handler, ms) => { delays.push(ms); timers.set(++timerId, handler); return timerId; };
    globalThis.clearTimeout = (id) => timers.delete(id);
    const { setBoardTasks, patchBoardTask, applyBoardTaskFrame, getBoardTasks, subscribeBoardTasks } = await import(${JSON.stringify(storePath)});
    const flushTimers = () => { const work = [...timers.values()]; timers.clear(); for (const run of work) run(); };
    const stringify = JSON.stringify;
    JSON.stringify = (...args) => { serializations++; return stringify(...args); };
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: 't' + i, projectId: 'p', text: 'task', status: 'todo', agentTokens: 0 }));
    setBoardTasks(rows);
    const first = { saves, timers: timers.size };
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
    process.stdout.write(stringify({ first, windowMs: Math.min(...delays), noOp, beforeFlush, burst, pageExit, hidden, quota, recovered }));
  `;
  const child = Bun.spawnSync([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  const result = JSON.parse(new TextDecoder().decode(child.stdout));
  console.info(JSON.stringify({ probe: 'board-cache-persistence', ...result }));
  // The first read of the session is on disk at once (a reload right after
  // still paints from it); every write after that waits a minute. At 2 s the
  // board rewrote 363 KB every 2.5 s with agents at work (15/09/2026).
  expect(result.first).toEqual({ saves: 1, timers: 0 });
  expect(result.windowMs).toBeGreaterThanOrEqual(60_000);
  expect(result.noOp).toEqual({ serializations: 0, saves: 0, callbacks: 0 });
  expect(result.beforeFlush).toEqual({ serializations: 0, saves: 0, callbacks: 20, timers: 1, live: 20 });
  expect(result.burst).toEqual({ serializations: 1, saves: 1, callbacks: 20, saved: 20, cachedRows: 200 });
  expect(result.pageExit).toEqual({ saved: 21, timers: 0 });
  expect(result.hidden).toEqual({ saved: 22, timers: 0 });
  expect(result.quota).toEqual({ live: 23, saved: 22 });
  expect(result.recovered).toEqual({ live: 24, saved: 24 });
});

test('a project board seed goes through the same minute window: first write at once, the next one waits', () => {
  const cachePath = resolve(import.meta.dir, 'boardRowsCache.ts');
  const script = `
    let saves = 0;
    const data = new Map(), timers = new Map(), delays = [];
    let timerId = 0;
    globalThis.localStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => { saves++; data.set(key, value); },
    };
    globalThis.window = { addEventListener: () => {} };
    globalThis.document = { visibilityState: 'visible', addEventListener: () => {} };
    globalThis.setTimeout = (handler, ms) => { delays.push(ms); timers.set(++timerId, handler); return timerId; };
    globalThis.clearTimeout = (id) => timers.delete(id);
    const { writeBoardRowsCache } = await import(${JSON.stringify(cachePath)});
    const row = (tokens) => [{ id: 't0', projectId: 'p', text: 'task', status: 'in_progress', agentTokens: tokens }];
    writeBoardRowsCache('p|live', row(1));
    const first = { saves, timers: timers.size };
    for (let i = 2; i <= 30; i++) writeBoardRowsCache('p|live', row(i));
    const burst = { saves, timers: timers.size, windowMs: Math.min(...delays) };
    for (const run of [...timers.values()]) run();
    const flushed = { saves, saved: JSON.parse(data.get('board-rows-cache:p|live'))[0].agentTokens };
    process.stdout.write(JSON.stringify({ first, burst, flushed }));
  `;
  const child = Bun.spawnSync([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  const result = JSON.parse(new TextDecoder().decode(child.stdout));
  // Before 15/09 the project board wrote synchronously on every read.
  expect(result.first).toEqual({ saves: 1, timers: 0 });
  expect(result.burst).toEqual({ saves: 1, timers: 1, windowMs: 60_000 });
  expect(result.flushed).toEqual({ saves: 2, saved: 30 });
});
