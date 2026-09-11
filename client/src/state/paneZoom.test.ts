/**
 * One zoom per surface, and one state — not two modes.
 *
 * The three things that can only break here: a repeated gesture on the same
 * anchor LEAVES (whatever scope either gesture carried, because the scope is
 * fixed at entry and is not a switch), a surface never holds two records, and
 * `exitTop` — the synchronous getter the Escape branch calls from App level —
 * closes the most recent zoom and says whether there was one.
 *
 * @covers LAYOUT-37, LAYOUT-40
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { usePaneZoomStore, paneZoomActions } from './paneZoom';

const GRID = 'standalone-grid';
const PROJECT = 'project:/tmp/demo';

const records = () => usePaneZoomStore.getState().bySurface;

beforeEach(() => {
  usePaneZoomStore.setState({ bySurface: {} });
});

describe('toggle', () => {
  test('opens a zoom on the anchor, with the scope the gesture asked for', () => {
    paneZoomActions.toggle(GRID, 'topic-a', 'derived');
    expect(records()[GRID]).toMatchObject({ anchorPaneId: 'topic-a', scope: 'derived' });
  });

  test('the same anchor a second time LEAVES, even with the other scope', () => {
    paneZoomActions.toggle(GRID, 'topic-a', 'derived');
    paneZoomActions.toggle(GRID, 'topic-a', 'cell');
    expect(records()[GRID]).toBeUndefined();
  });

  test('two gestures with different scopes leave ONE record, never two', () => {
    paneZoomActions.toggle(GRID, 'topic-a', 'derived');
    paneZoomActions.toggle(GRID, 'topic-b', 'cell');
    expect(Object.keys(records())).toEqual([GRID]);
    expect(records()[GRID]).toMatchObject({ anchorPaneId: 'topic-b', scope: 'cell' });
  });

  test('a nested project keeps its own zoom: one record per SURFACE', () => {
    paneZoomActions.toggle(GRID, 'topic-a', 'derived');
    paneZoomActions.toggle(PROJECT, 'chat:topic-x', 'cell');
    expect(Object.keys(records()).sort()).toEqual([PROJECT, GRID].sort());
  });
});

describe('exit', () => {
  test('closes its own surface and leaves the others alone', () => {
    paneZoomActions.toggle(GRID, 'topic-a', 'derived');
    paneZoomActions.toggle(PROJECT, 'chat:topic-x', 'cell');
    paneZoomActions.exit(GRID);
    expect(records()[GRID]).toBeUndefined();
    expect(records()[PROJECT]).toMatchObject({ anchorPaneId: 'chat:topic-x' });
  });

  test('a surface that is not zoomed is not a state change', () => {
    // It is called from unmount effects and from every reorganise command, so a
    // no-op that allocated would re-render every subscriber for nothing.
    const before = records();
    paneZoomActions.exit(GRID);
    expect(records()).toBe(before);
  });
});

describe('exitTop', () => {
  test('says false when nothing is zoomed, so Escape can fall through', () => {
    expect(paneZoomActions.exitTop()).toBe(false);
  });

  test('closes the LAST zoom opened, and only that one', () => {
    paneZoomActions.toggle(GRID, 'topic-a', 'derived');
    paneZoomActions.toggle(PROJECT, 'chat:topic-x', 'cell');
    expect(paneZoomActions.exitTop()).toBe(true);
    expect(records()[PROJECT]).toBeUndefined();
    expect(records()[GRID]).toMatchObject({ anchorPaneId: 'topic-a' });
  });

  test('a zoom reopened after an exit becomes the last one', () => {
    paneZoomActions.toggle(GRID, 'topic-a', 'derived');
    paneZoomActions.toggle(PROJECT, 'chat:topic-x', 'cell');
    paneZoomActions.exit(PROJECT);
    paneZoomActions.toggle(PROJECT, 'chat:topic-x', 'cell');
    expect(paneZoomActions.exitTop()).toBe(true);
    expect(records()[PROJECT]).toBeUndefined();
    expect(records()[GRID]).toBeDefined();
  });

  test('emptying every surface one exitTop at a time ends in false', () => {
    paneZoomActions.toggle(GRID, 'topic-a', 'derived');
    paneZoomActions.toggle(PROJECT, 'chat:topic-x', 'cell');
    expect(paneZoomActions.exitTop()).toBe(true);
    expect(paneZoomActions.exitTop()).toBe(true);
    expect(paneZoomActions.exitTop()).toBe(false);
    expect(records()).toEqual({});
  });
});
