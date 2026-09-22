/**
 * D15: a dragleave that only crossed into a child must not clear a hover. The
 * old test was `relatedTarget && host.contains(relatedTarget)`, and WebKit fires
 * dragleave with a NULL relatedTarget: every child crossed inside a pane body
 * read as "left", so the split preview blinked off under a still pointer.
 */
import { describe, it, expect } from 'bun:test';
import { dragLeftHost, type LeaveHost } from './dragLeave';

const child = { id: 'child' };
const stranger = { id: 'stranger' };
const host: LeaveHost = {
  contains: (n) => n === child,
  getBoundingClientRect: () => ({ left: 100, top: 50, right: 500, bottom: 350 }),
};

describe('dragLeftHost', () => {
  it('stays when the pointer moved onto a child (Chromium reports it)', () => {
    expect(dragLeftHost(host, { relatedTarget: child, clientX: 200, clientY: 200 })).toBe(false);
  });

  it('stays when WebKit reports no relatedTarget and the pointer is still inside', () => {
    expect(dragLeftHost(host, { relatedTarget: null, clientX: 200, clientY: 200 })).toBe(false);
  });

  it('leaves when WebKit reports no relatedTarget and the pointer is outside', () => {
    expect(dragLeftHost(host, { relatedTarget: null, clientX: 90, clientY: 200 })).toBe(true);
    expect(dragLeftHost(host, { relatedTarget: null, clientX: 200, clientY: 351 })).toBe(true);
  });

  it('counts the boundary pixel as outside, so the next host can take over', () => {
    expect(dragLeftHost(host, { relatedTarget: null, clientX: 500, clientY: 200 })).toBe(true);
  });

  it('leaves for a named element outside the host, whatever the geometry says', () => {
    // A strip or a band layered over the body is not a child: it owns the
    // gesture from here, and it clears this hover itself on its dragover.
    expect(dragLeftHost(host, { relatedTarget: stranger, clientX: 200, clientY: 200 })).toBe(true);
  });
});
