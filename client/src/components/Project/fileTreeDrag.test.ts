/**
 * D15: the file tree's rows claimed every drag. A project TAB dragged over the
 * Files pane lit the folder under it as a "move here" target, and the row's
 * drop handler stopped the event, so the layout around the pane never saw the
 * release: no split, no merge, only a folder that flashed.
 *
 * @covers DNDSPLIT-07
 */
import { describe, it, expect } from 'bun:test';
import { fileTreeClaimsDrag } from './fileTreeDrag';
import { DND_TYPES, paneTabScopeType } from '../../lib/dndTypes';

const projectTab = [DND_TYPES.PANE_TAB, DND_TYPES.PANE_TAB_GROUP, paneTabScopeType('/p'), DND_TYPES.PANE_TAB_SCOPE];

describe('fileTreeClaimsDrag', () => {
  it('lets a pane tab through to the layout', () => {
    expect(fileTreeClaimsDrag(projectTab, false)).toBe(false);
  });

  it('lets a sidebar row and a layout row through', () => {
    expect(fileTreeClaimsDrag([DND_TYPES.SIDEBAR_REORDER, DND_TYPES.PANEL_ID], false)).toBe(false);
    expect(fileTreeClaimsDrag([DND_TYPES.LAYOUT_ROW], false)).toBe(false);
  });

  it('claims its own rows being moved', () => {
    expect(fileTreeClaimsDrag(['text/plain'], true)).toBe(true);
  });

  it('claims files dragged in from the Finder', () => {
    expect(fileTreeClaimsDrag(['Files'], false)).toBe(true);
  });
});
