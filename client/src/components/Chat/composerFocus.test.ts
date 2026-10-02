/**
 * WHEN A PANE BECOMES THE FOCUSED ONE, its composer takes the focus only if
 * nobody put it somewhere on purpose.
 *
 * Measured: Enter on a fold header activates the pane (the click bubbles to
 * the panel), and 50 ms later the composer took the focus from the header, so
 * the Space that should have closed the fold went into the textarea. A control
 * inside the pane that holds the focus at that moment keeps it; a click on the
 * transcript's text (nothing focusable, or the scroller) still lands in the
 * composer, ready to write.
 * @covers CHAT-FOLD-01
 */
import { describe, expect, test } from 'bun:test';
import { composerMayTakeFocus } from './composerFocus';

/** The two DOM calls the rule makes, on plain objects: no DOM in this bench. */
function el(tag: string, attrs: Record<string, string> = {}, parent: FakeEl | null = null): FakeEl {
  const self: FakeEl = {
    tagName: tag.toUpperCase(),
    attrs,
    parent,
    matches: (selector: string) => selector.split(',').map((s) => s.trim()).some((s) => matchOne(self, s)),
    contains: (other: FakeEl | null) => {
      for (let n = other; n; n = n.parent) if (n === self) return true;
      return false;
    },
  };
  return self;
}
interface FakeEl {
  tagName: string;
  attrs: Record<string, string>;
  parent: FakeEl | null;
  matches(selector: string): boolean;
  contains(other: FakeEl | null): boolean;
}
function matchOne(e: FakeEl, selector: string): boolean {
  const m = selector.match(/^([a-z]*)(?:\[([a-z-]+)(?:="([^"]*)")?\])?$/);
  if (!m) return false;
  const [, tag, attr, value] = m;
  if (tag && e.tagName !== tag.toUpperCase()) return false;
  if (attr && !(attr in e.attrs)) return false;
  if (attr && value !== undefined && e.attrs[attr] !== value) return false;
  return true;
}

const pane = el('div');
const scroller = el('div', { tabindex: '0' }, pane);
const header = el('button', {}, scroller);
const summary = el('summary', {}, scroller);
const outside = el('button');
const body = el('body');

const may = (active: FakeEl | null) => composerMayTakeFocus(active as unknown as Element, pane as unknown as Element);

describe('composerMayTakeFocus', () => {
  test('a fold header that holds the focus keeps it', () => {
    expect(may(header)).toBe(false);
    expect(may(summary)).toBe(false);
  });

  test('a click on the transcript, or a focus outside the pane, still lands in the composer', () => {
    expect(may(scroller)).toBe(true);
    expect(may(body)).toBe(true);
    expect(may(null)).toBe(true);
    // The tab clicked to come here lives outside the pane.
    expect(may(outside)).toBe(true);
  });
});
