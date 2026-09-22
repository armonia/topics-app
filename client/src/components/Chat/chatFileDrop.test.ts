/**
 * D15: the chat's file drop claimed every drag that did not carry PANEL_ID. A
 * PROJECT tab never carries it (only top-level tabs do, see PaneTabBar), so a
 * project tab dragged over a chat body lit the "drop files here" frame, and the
 * handler's stopPropagation kept the layout from ever seeing the dragover: no
 * split bands over the message list, and a release that did nothing.
 */
import { describe, it, expect } from 'bun:test';
import { chatAcceptsFileDrag } from './chatFileDrop';
import { DND_TYPES, paneTabScopeType } from '../../lib/dndTypes';

describe('chatAcceptsFileDrag', () => {
  it('declines a project tab drag, which carries no PANEL_ID', () => {
    expect(chatAcceptsFileDrag([
      DND_TYPES.PANE_TAB,
      DND_TYPES.PANE_TAB_GROUP,
      paneTabScopeType('/Users/me/proj'),
      DND_TYPES.PANE_TAB_SCOPE,
    ])).toBe(false);
  });

  it('declines a top-level tab drag and a sidebar row', () => {
    expect(chatAcceptsFileDrag([DND_TYPES.PANE_TAB, DND_TYPES.PANE_TAB_GROUP, DND_TYPES.PANEL_ID])).toBe(false);
    expect(chatAcceptsFileDrag([DND_TYPES.SIDEBAR_REORDER, DND_TYPES.PANEL_ID])).toBe(false);
  });

  it('declines a layout row being reordered', () => {
    expect(chatAcceptsFileDrag([DND_TYPES.LAYOUT_ROW])).toBe(false);
  });

  it('accepts files and text coming from outside the app', () => {
    expect(chatAcceptsFileDrag(['Files'])).toBe(true);
    expect(chatAcceptsFileDrag(['text/plain', 'text/uri-list'])).toBe(true);
  });
});
