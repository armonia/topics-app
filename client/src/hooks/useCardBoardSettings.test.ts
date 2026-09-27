/**
 * AICTRL-05 in the all-boards view: the task drawer judges a card (its routing
 * switch, the model the dispatcher runs on Automatic) with its own board's
 * settings, while the project pane around it holds its own board's. The hook
 * runs here for real on test/reactHarness, fetch included: settings fetched
 * for a foreign card but filed under the pane's board leave that card with no
 * default, and only a test that drives the fetch into the drawer's value sees it.
 *
 * @covers AICTRL-05
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement, useEffect } from 'react';
import { mount } from '../test/reactHarness';
import { boardApi, type BoardSettings } from '../lib/board';
import { useCardBoardSettings } from './useCardBoardSettings';

const realGetSettings = boardApi.getSettings;
let asked: Array<{ boardId: string; answer: (settings: BoardSettings) => void }> = [];

beforeEach(() => {
  asked = [];
  boardApi.getSettings = ((boardId: string) => new Promise<BoardSettings>((answer) => {
    asked.push({ boardId, answer });
  })) as typeof boardApi.getSettings;
});
afterEach(() => { boardApi.getSettings = realGetSettings; });

const settingsWith = (dispatchModel: string) => ({ dispatchModel }) as unknown as BoardSettings;
const PANE = settingsWith('codex');

/** The drawer's read for the selected card, on the pane of board `alpha`. */
function mountDrawer(cardBoardId: string | undefined) {
  const box: { card: string | undefined; seen: BoardSettings | null } = { card: cardBoardId, seen: null };
  const Probe = (): null => {
    const settings = useCardBoardSettings(box.card, 'alpha', PANE);
    useEffect(() => { box.seen = settings; });
    return null;
  };
  const h = mount(createElement(Probe));
  return {
    seen: () => box.seen,
    select(card: string) { box.card = card; h.rerender(); },
    unmount: () => h.unmount(),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('useCardBoardSettings', () => {
  test("a card of another board: that board's settings are fetched and reach the drawer", async () => {
    const drawer = mountDrawer('beta');
    expect(asked.map((a) => a.boardId)).toEqual(['beta']);
    expect(drawer.seen()).toBeNull();
    asked[0]!.answer(settingsWith('claude-sonnet-5'));
    await settle();
    expect(drawer.seen()).toEqual(settingsWith('claude-sonnet-5'));
    drawer.unmount();
  });

  test("a card of the pane's board, or no card: nothing is fetched and the pane's settings apply", () => {
    for (const card of ['alpha', undefined]) {
      const drawer = mountDrawer(card);
      expect(drawer.seen()).toBe(PANE);
      drawer.unmount();
    }
    expect(asked).toEqual([]);
  });

  test('an answer for a card no longer selected never reaches the next one', async () => {
    const drawer = mountDrawer('beta');
    drawer.select('gamma');
    expect(asked.map((a) => a.boardId)).toEqual(['beta', 'gamma']);
    asked[0]!.answer(settingsWith('claude-opus-5'));
    await settle();
    expect(drawer.seen()).toBeNull();
    asked[1]!.answer(settingsWith('claude-sonnet-5'));
    await settle();
    expect(drawer.seen()).toEqual(settingsWith('claude-sonnet-5'));
    drawer.unmount();
  });
});
