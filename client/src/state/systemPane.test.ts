/**
 * The System pane is a pane kind: it opens through the utility door like
 * Dashboard and Board, «open full view» is the grid's zoom on its cell, and on
 * the phone the same content is a sheet kept on this device.
 * @covers HUBBR-05
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  SYSTEM_PANE_ID, _readSystemSheetForTests, closeSystemSheet, openSystemPane, openSystemSheet, toggleSystemPaneMaximized,
} from './systemPane';
import { PANE_TYPES } from './pane/types';
import { isUtilityPanelType, parseUtilityPanelType } from './pane/adapters/utilityPanelId';
import { getPaneConfig } from './pane/adapters/paneConfig';
import { STANDALONE_ZOOM_SURFACE_ID, paneZoomActions, usePaneZoomStore } from './paneZoom';

afterEach(() => {
  closeSystemSheet();
  paneZoomActions.exit(STANDALONE_ZOOM_SURFACE_ID);
});

describe('HUBBR-05: the System pane kind', () => {
  test('a registered pane type with a utility id, so it persists and opens like the others', () => {
    expect(PANE_TYPES).toContain('system');
    expect(isUtilityPanelType('system')).toBe(true);
    expect(SYSTEM_PANE_ID).toBe('__system__');
    expect(parseUtilityPanelType(SYSTEM_PANE_ID)).toBe('system');
    expect(getPaneConfig('system').icon).toBe('Gauge');
    // Not offered in the tab bar «+»: its doors are the strip and the palette.
    expect(getPaneConfig('system').addableScopes).toBeUndefined();
  });

  test('opening goes through the one utility door', () => {
    // No DOM in this bench: an EventTarget is all the door needs.
    const g = globalThis as { window?: unknown };
    const had = 'window' in g;
    const prev = g.window;
    const bus = new EventTarget();
    g.window = bus;
    const seen: unknown[] = [];
    bus.addEventListener('topics:open-utility', (e) => { seen.push((e as CustomEvent).detail); });
    try {
      openSystemPane();
    } finally {
      if (had) g.window = prev; else delete g.window;
    }
    expect(seen).toEqual([{ type: 'system' }]);
  });

  test('open full view is the grid zoom on the System cell, and back', () => {
    toggleSystemPaneMaximized();
    expect(usePaneZoomStore.getState().bySurface[STANDALONE_ZOOM_SURFACE_ID]).toMatchObject({ anchorPaneId: SYSTEM_PANE_ID, scope: 'cell' });
    toggleSystemPaneMaximized();
    expect(usePaneZoomStore.getState().bySurface[STANDALONE_ZOOM_SURFACE_ID]).toBeUndefined();
  });

  test('the phone sheet opens and closes on this device only', () => {
    expect(_readSystemSheetForTests()).toBe(false);
    openSystemSheet();
    expect(_readSystemSheetForTests()).toBe(true);
    closeSystemSheet();
    expect(_readSystemSheetForTests()).toBe(false);
  });
});
