import { test, expect, describe } from 'bun:test';
import { boardIdForPath, TASK_STATUSES } from './board';

describe('boardIdForPath', () => {
  // Parity lock with the server (services/tasks.ts:projectIdForPath). Must stay
  // byte-identical or the client would address a different board than the API.
  test('exact output matches the server algorithm', () => {
    expect(boardIdForPath('/x/proj')).toBe('proj-xwac8t');
  });
  test('basename prefix + deterministic', () => {
    const a = boardIdForPath('/Users/zorahrel/Projects/topics-app');
    expect(a).toBe(boardIdForPath('/Users/zorahrel/Projects/topics-app'));
    expect(a.startsWith('topics-app-')).toBe(true);
  });
});

describe('TASK_STATUSES', () => {
  test('the five board columns in order', () => {
    expect(TASK_STATUSES).toEqual(['backlog', 'todo', 'in_progress', 'review', 'done']);
  });
});
