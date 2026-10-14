/**
 * @covers RUNTIME-11
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { syncAnimationPause } from './useAnimationPause';
import { markBrowserViewDead, markBrowserViewLive } from '../lib/shell/nativeBrowserRoster';

/**
 * The CSS animations park on the same question as the polls (`isWindowAwake`).
 * The case that matters is the third: focus inside a native browser pane is the
 * person using the app, and the loaders beside it must keep turning.
 */

const real = {
  document: (globalThis as { document?: unknown }).document,
};

function stubDocument(over: { hidden?: boolean; hasFocus: () => boolean }): void {
  (globalThis as { document?: unknown }).document = {
    hidden: over.hidden ?? false,
    hasFocus: over.hasFocus,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

/** What `toggle` left on the root, read back as "paused or not". */
function paused(): boolean {
  const names = new Set<string>();
  syncAnimationPause({
    classList: {
      toggle: (name: string, force?: boolean) => {
        if (force) names.add(name);
        else names.delete(name);
        return Boolean(force);
      },
    },
  });
  return names.has('anims-paused');
}

beforeEach(() => {
  stubDocument({ hasFocus: () => true });
});

afterEach(() => {
  if (real.document === undefined) delete (globalThis as { document?: unknown }).document;
  else (globalThis as { document?: unknown }).document = real.document;
});

describe('syncAnimationPause', () => {
  test('a visible, focused window: the animations run', () => {
    expect(paused()).toBe(false);
  });

  test('behind another app, with no native browser pane: they park', () => {
    stubDocument({ hasFocus: () => false });
    expect(paused()).toBe(true);
  });

  test('focus inside a live native browser pane: they keep running', () => {
    stubDocument({ hasFocus: () => false });
    markBrowserViewLive('pane-browser-anim');
    try {
      expect(paused()).toBe(false);
    } finally {
      markBrowserViewDead('pane-browser-anim');
    }
  });

  test('a hidden document parks them, native browser pane or not', () => {
    stubDocument({ hidden: true, hasFocus: () => true });
    markBrowserViewLive('pane-browser-anim');
    try {
      expect(paused()).toBe(true);
    } finally {
      markBrowserViewDead('pane-browser-anim');
    }
  });
});
