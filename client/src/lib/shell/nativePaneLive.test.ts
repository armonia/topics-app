/**
 * WHO IS LIVE: a heavy pane only with the focus, everything else as today.
 *
 * @covers BROWSER-HEAVY-03
 */
import { describe, expect, test } from 'bun:test';
import { paneLive, type PaneLiveInput } from './nativePaneLive';

const HEAVY_FOCUSED: PaneLiveInput = {
  heavy: true, paneFocused: true, windowFocused: true, agentActive: false, opsInFlight: 0, devtoolsOpen: false,
};

describe('paneLive', () => {
  test('a pane that is not heavy is never paused by this rule', () => {
    expect(paneLive({ ...HEAVY_FOCUSED, heavy: false, paneFocused: false, windowFocused: false })).toBe(true);
  });

  test('a heavy pane is live with its own focus in a focused window', () => {
    expect(paneLive(HEAVY_FOCUSED)).toBe(true);
  });

  test('a heavy preview next to the focused chat pauses (the literal reading of answer 3)', () => {
    expect(paneLive({ ...HEAVY_FOCUSED, paneFocused: false })).toBe(false);
  });

  test('an unfocused window pauses it, an unknown window does not', () => {
    expect(paneLive({ ...HEAVY_FOCUSED, windowFocused: false })).toBe(false);
    expect(paneLive({ ...HEAVY_FOCUSED, windowFocused: null })).toBe(true);
  });

  test('an agent, an op in flight or an open inspector keep it live without focus', () => {
    const away = { ...HEAVY_FOCUSED, paneFocused: false, windowFocused: false };
    expect(paneLive({ ...away, agentActive: true })).toBe(true);
    expect(paneLive({ ...away, opsInFlight: 1 })).toBe(true);
    expect(paneLive({ ...away, devtoolsOpen: true })).toBe(true);
  });
});
