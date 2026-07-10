/**
 * BRW-REL-01 — browserSingletonReducer must never "steal" (rebind) another
 * context's browser pane when an explicit contextId is given: one browser
 * pane per context. Legacy context-less opens keep the old singleton reuse.
 */
import { describe, test, expect } from 'bun:test';
import { browserSingletonReducer } from './usePaneOrdering';

describe('browserSingletonReducer', () => {
  test('exact contextId match reuses the existing pane', () => {
    const prev = ['topic-a', 'browser:ctx-a'];
    const { next, resolvedId } = browserSingletonReducer(prev, 'ctx-a');
    expect(resolvedId).toBe('browser:ctx-a');
    expect(next).toBe(prev); // untouched
  });

  test('contextId with no match CREATES a new pane — never rebinds another context\'s pane', () => {
    const prev = ['topic-a', 'browser:ctx-a', 'topic-b'];
    const { next, resolvedId } = browserSingletonReducer(prev, 'ctx-b');
    expect(resolvedId).toBe('browser:ctx-b');
    // The old pane survives untouched and the new one is appended.
    expect(next).toContain('browser:ctx-a');
    expect(next).toContain('browser:ctx-b');
    expect(next.length).toBe(prev.length + 1);
  });

  test('context-less open reuses the first browser pane in the group (legacy)', () => {
    const prev = ['topic-a', 'browser:ctx-a'];
    const { next, resolvedId } = browserSingletonReducer(prev);
    expect(resolvedId).toBe('browser:ctx-a');
    expect(next).toBe(prev);
  });

  test('context-less open with no browser anywhere creates a fresh pane', () => {
    const prev = ['topic-a'];
    const { next, resolvedId } = browserSingletonReducer(prev);
    expect(resolvedId.startsWith('browser:')).toBe(true);
    expect(next).toContain(resolvedId);
  });
});
