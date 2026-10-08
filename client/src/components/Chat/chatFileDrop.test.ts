/**
 * D15: the chat's file drop claimed every drag that did not carry PANEL_ID. A
 * PROJECT tab never carries it (only top-level tabs do, see PaneTabBar), so a
 * project tab dragged over a chat body lit the "drop files here" frame, and the
 * handler's stopPropagation kept the layout from ever seeing the dragover: no
 * split bands over the message list, and a release that did nothing.
 *
 * @covers DNDSPLIT-07
 */
import { describe, it, expect } from 'bun:test';
import { chatAcceptsFileDrag, watchFileDragEnd } from './chatFileDrop';
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

/**
 * The frame stayed up for good on topic:64095902 (07/10): a drag released off
 * the transcript, or cancelled, never reached its dragleave/drop in WKWebView.
 */
describe('watchFileDragEnd', () => {
  const fire = (target: EventTarget, type: string, buttons?: number) =>
    target.dispatchEvent(Object.assign(new Event(type), buttons === undefined ? {} : { buttons }));
  const watch = () => {
    const win = new EventTarget();
    let ended = 0;
    const detach = watchFileDragEnd(win, () => { ended += 1; });
    return { win, detach, ended: () => ended };
  };

  it('ends on a drop or a dragend anywhere in the window', () => {
    for (const type of ['drop', 'dragend']) {
      const w = watch();
      fire(w.win, type);
      expect(w.ended()).toBe(1);
    }
  });

  it('ends on the pointer events the drag was holding back, and on blur', () => {
    for (const type of ['pointerup', 'blur']) {
      const w = watch();
      fire(w.win, type);
      expect(w.ended()).toBe(1);
    }
  });

  it('ends on the first pointermove with no button held, not while one is', () => {
    const w = watch();
    fire(w.win, 'pointermove', 1);
    expect(w.ended()).toBe(0);
    fire(w.win, 'pointermove', 0);
    expect(w.ended()).toBe(1);
  });

  it('stops listening once detached', () => {
    const w = watch();
    w.detach();
    for (const type of ['drop', 'dragend', 'pointerup', 'blur']) fire(w.win, type);
    fire(w.win, 'pointermove', 0);
    expect(w.ended()).toBe(0);
  });
});
