/**
 * The per-pane find registry: who has a finder, and the bar state that
 * belongs to the pane, not to the component.
 *
 * @covers FIND-01
 * @covers FIND-02
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  _resetFindRegistry, closeFind, getFindState, hasFinder, openFind, registerFinder,
  registerFindFallback, reportFindResult, resolveFindPane, runFindFallback, setFindQuery, stepFind,
  type PaneFinder,
} from './findRegistry';

afterEach(() => _resetFindRegistry());

function fakeFinder(total: number): PaneFinder & { cleared: number; at: number } {
  const f = {
    cleared: 0,
    at: 0,
    debounceMs: 0,
    search: () => total,
    step(forward: boolean) {
      f.at = forward ? (f.at % total) + 1 : (f.at <= 1 ? total : f.at - 1);
      return { index: f.at, total };
    },
    clear() { f.cleared++; },
  };
  return f;
}

/** An element whose `closest('[data-find-pane]')` answers `paneId`. */
function inPane(paneId: string | null) {
  return { closest: () => (paneId ? { getAttribute: () => paneId } : null) };
}

describe('openFind', () => {
  test('a pane without a finder answers false and the caller falls back', () => {
    expect(openFind('dashboard')).toBe(false);
    expect(getFindState('dashboard').open).toBe(false);
  });

  test('a pane with a finder opens its bar, and opening again bumps the focus tick', () => {
    registerFinder('chat-1', fakeFinder(3));
    expect(openFind('chat-1')).toBe(true);
    const first = getFindState('chat-1').focusTick;
    expect(openFind('chat-1')).toBe(true);
    expect(getFindState('chat-1').focusTick).toBe(first + 1);
  });
});

describe('the bar belongs to the pane (FIND-01)', () => {
  test('state survives switching focus to another pane and back', async () => {
    registerFinder('chat', fakeFinder(5));
    registerFinder('term', fakeFinder(2));
    openFind('chat');
    setFindQuery('chat', 'deploy');
    await new Promise((r) => setTimeout(r, 5));
    await stepFind('chat', true);
    await stepFind('chat', true);
    // Focus moves to the terminal: nothing about it opens the terminal's bar,
    // and nothing about the chat's bar changes.
    expect(getFindState('term').open).toBe(false);
    const chat = getFindState('chat');
    expect(chat.open).toBe(true);
    expect(chat.query).toBe('deploy');
    expect(chat.index).toBe(2);
    expect(chat.total).toBe(5);
  });

  test('an engine-reported total keeps the current index (a streaming chat)', async () => {
    registerFinder('chat', fakeFinder(5));
    openFind('chat');
    setFindQuery('chat', 'x');
    await new Promise((r) => setTimeout(r, 5));
    await stepFind('chat', true);
    await stepFind('chat', true);
    await stepFind('chat', true);
    reportFindResult('chat', { total: 6 });
    expect(getFindState('chat').index).toBe(3);
    expect(getFindState('chat').total).toBe(6);
  });

  test('closing clears the highlights and keeps the word for the next open', () => {
    const f = fakeFinder(4);
    registerFinder('p', f);
    openFind('p');
    setFindQuery('p', 'w');
    closeFind('p');
    expect(f.cleared).toBeGreaterThan(0);
    expect(getFindState('p').open).toBe(false);
    expect(getFindState('p').query).toBe('w');
  });

  test('a stale unregister (old mount) does not drop the new registration', () => {
    const off = registerFinder('p', fakeFinder(1));
    registerFinder('p', fakeFinder(2));
    off();
    expect(hasFinder('p')).toBe(true);
  });
});

describe('resolveFindPane (FIND-02)', () => {
  test('the pane the keyboard is in wins over the focused tab', () => {
    registerFinder('chat', fakeFinder(1));
    registerFinder('term', fakeFinder(1));
    expect(resolveFindPane(inPane('term'), ['chat'], 'chat')).toBe('term');
  });

  test('with the focus on nothing, the focused tab that has a finder', () => {
    registerFinder('inner-chat', fakeFinder(1));
    expect(resolveFindPane(inPane(null), ['project:x', 'inner-chat'], 'project:x')).toBe('inner-chat');
  });

  test('a pane with only a fallback (the board) is a target too', () => {
    let focused = 0;
    registerFindFallback('board', () => { focused++; });
    expect(resolveFindPane(null, ['board'], 'board')).toBe('board');
    expect(openFind('board')).toBe(false);
    expect(runFindFallback('board')).toBe(true);
    expect(focused).toBe(1);
  });

  test('the keyboard inside a pane with no finder resolves to that pane, so nothing else opens', () => {
    registerFinder('chat', fakeFinder(1));
    expect(resolveFindPane(inPane('dashboard'), ['chat'], 'chat')).toBe('dashboard');
  });
});
