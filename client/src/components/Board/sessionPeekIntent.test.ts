/**
 * The rest before a card's peek opens, and the session that arrives under a
 * pointer that is already resting on the card (D5e, `board-session-peek.spec.ts`).
 *
 * `Card.tsx` cannot be mounted by `bun test` (its `@/` imports), so the rule
 * lives in `sessionPeekIntent.ts`, plain timers, and the source guard at the
 * bottom reads that the card goes through it.
 * @covers KANBAN-96
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionPeekIntent, SESSION_PEEK_REST_MS } from './sessionPeekIntent';

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('the rest before the peek opens', () => {
  test('a card with a session opens after the rest, not before', () => {
    let opened = 0;
    const intent = createSessionPeekIntent(() => { opened++; });
    intent.enter(true);
    jest.advanceTimersByTime(SESSION_PEEK_REST_MS - 1);
    expect(opened).toBe(0);
    jest.advanceTimersByTime(1);
    expect(opened).toBe(1);
  });

  test('a pointer that leaves before the rest ends opens nothing', () => {
    let opened = 0;
    const intent = createSessionPeekIntent(() => { opened++; });
    intent.enter(true);
    jest.advanceTimersByTime(SESSION_PEEK_REST_MS - 10);
    intent.leave();
    jest.advanceTimersByTime(SESSION_PEEK_REST_MS * 2);
    expect(opened).toBe(0);
  });

  test('a card with no session opens nothing while it has none', () => {
    let opened = 0;
    const intent = createSessionPeekIntent(() => { opened++; });
    intent.enter(false);
    jest.advanceTimersByTime(SESSION_PEEK_REST_MS * 5);
    expect(opened).toBe(0);
  });
});

describe('a session that arrives under the pointer', () => {
  test('starts the same rest, counted from its arrival', () => {
    let opened = 0;
    const intent = createSessionPeekIntent(() => { opened++; });
    intent.enter(false);
    jest.advanceTimersByTime(300);
    intent.sessionChanged(true);
    jest.advanceTimersByTime(SESSION_PEEK_REST_MS - 1);
    expect(opened).toBe(0);
    jest.advanceTimersByTime(1);
    expect(opened).toBe(1);
  });

  test('is ignored when the pointer is not on the card', () => {
    let opened = 0;
    const intent = createSessionPeekIntent(() => { opened++; });
    intent.sessionChanged(true);
    jest.advanceTimersByTime(SESSION_PEEK_REST_MS * 2);
    expect(opened).toBe(0);

    intent.enter(true);
    intent.leave();
    intent.sessionChanged(true);
    jest.advanceTimersByTime(SESSION_PEEK_REST_MS * 2);
    expect(opened).toBe(0);
  });

  test('losing the session under the pointer drops the wait', () => {
    let opened = 0;
    const intent = createSessionPeekIntent(() => { opened++; });
    intent.enter(true);
    jest.advanceTimersByTime(100);
    intent.sessionChanged(false);
    jest.advanceTimersByTime(SESSION_PEEK_REST_MS * 2);
    expect(opened).toBe(0);
  });

  test('a cancelled wait stays cancelled until the session changes again', () => {
    let opened = 0;
    const intent = createSessionPeekIntent(() => { opened++; });
    intent.enter(true);
    intent.cancel();
    jest.advanceTimersByTime(SESSION_PEEK_REST_MS * 2);
    expect(opened).toBe(0);
    intent.sessionChanged(true);
    jest.advanceTimersByTime(SESSION_PEEK_REST_MS);
    expect(opened).toBe(1);
  });
});

describe('the card goes through it', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Card.tsx'), 'utf8');

  test('the pointer events and the session of the task both reach the intent', () => {
    expect(src).toContain('createSessionPeekIntent(');
    expect(src).toContain('onMouseEnter={() => peekIntent.enter(!!task.assignedTopicId)}');
    expect(src).toContain('onMouseLeave={() => { peekIntent.leave(); setSessionPeekOpen(false); }}');
    expect(src).toContain('peekIntent.sessionChanged(!!task.assignedTopicId)');
  });
});
