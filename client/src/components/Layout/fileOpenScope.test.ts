import { describe, test, expect } from 'bun:test';
import { shouldHandleOpenFile } from './fileOpenScope';

describe('shouldHandleOpenFile — open-file event scoping (no "opens on all splits")', () => {
  const A = 'project:/Users/me/a';
  const B = 'project:/Users/me/b';

  test('explicit topicId routes to the matching window only', () => {
    expect(shouldHandleOpenFile({ topicId: A }, A, A)).toBe(true);
    // the OTHER project window in split view must ignore the same global event
    expect(shouldHandleOpenFile({ topicId: A }, B, A)).toBe(false);
  });

  test('topicId wins over focus — opens in the target even if another window is focused', () => {
    expect(shouldHandleOpenFile({ topicId: A }, A, B)).toBe(true);
    expect(shouldHandleOpenFile({ topicId: A }, B, B)).toBe(false);
  });

  test('no topicId (e.g. breadcrumb) falls back to the focused window', () => {
    expect(shouldHandleOpenFile({}, A, A)).toBe(true);
    expect(shouldHandleOpenFile({}, B, A)).toBe(false);
    expect(shouldHandleOpenFile({ topicId: null }, A, A)).toBe(true);
    expect(shouldHandleOpenFile({ topicId: undefined }, A, A)).toBe(true);
  });

  test('no topicId and nothing focused → nobody handles it (no phantom open)', () => {
    expect(shouldHandleOpenFile({}, A, null)).toBe(false);
  });

  test('exactly one window handles a given event across a split (the invariant)', () => {
    const windows = [A, B];
    const handlers = windows.filter((w) => shouldHandleOpenFile({ topicId: A }, w, A));
    expect(handlers).toEqual([A]); // never both, never zero when target is open
  });
});
