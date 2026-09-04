/**
 * THE NEW TAB AND THE BAR ABOVE ARE THE SAME DOOR.
 *
 * The field in the middle of the empty tab normalised with `normalizeUrl`, the
 * bar with `toNavigableUrl`: two centimetres apart and two different rules.
 * Typing `/Users/x/doc.pdf` in here ended in a 404 on our own origin (no route
 * serves that path) and `file:///Users/x/doc.pdf` hit the scheme refusal, while
 * the bar opened both.
 *
 * The test submits the real form (the host node's `onSubmit`, via
 * `test/reactHarness`) instead of calling the library: it is the COMPONENT that
 * has to pick the door, and an assertion on `toNavigableUrl` alone could not
 * fail.
 *
 * @covers BROWSER-01
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { createElement } from 'react';
import { mount, type Harness } from '../../test/reactHarness';
import { NewTabPage } from './NewTabPage';
import { toNavigableUrl } from '../../lib/browserNavUrl';

const ORIGIN = 'http://127.0.0.1:13333';

function setWindow(): void {
  (globalThis as { window?: unknown }).window = {
    location: { hostname: '127.0.0.1', protocol: 'http:', origin: ORIGIN },
  };
}

afterEach(() => { delete (globalThis as { window?: unknown }).window; });

/**
 * Types into the field and presses Enter, through the form the component draws.
 *
 * The `form` is read AFTER the `onChange`: the keystroke changes the state and
 * therefore the pass, and the previous pass's handler would close over a field
 * that is still empty - that is, not over what was just typed.
 */
function typeAndSubmit(h: Harness, text: string): void {
  const input = h.last().hosts.find((n) => n.type === 'input');
  if (!input) throw new Error('the new tab drew no field');
  (input.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: text } });
  const form = h.last().hosts.find((n) => n.type === 'form');
  if (!form) throw new Error('the new tab drew no form');
  (form.props.onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
}

describe('the field of the new tab', () => {
  it('opens a local file the way the bar would', () => {
    setWindow();
    const seen: string[] = [];
    const h = mount(createElement(NewTabPage, { onNavigate: (u: string) => seen.push(u) }));
    try {
      typeAndSubmit(h, '/Users/a/b.pdf');
      expect(seen).toEqual([toNavigableUrl('/Users/a/b.pdf')]);
      expect(seen[0]).toBe(`${ORIGIN}/api/media?path=${encodeURIComponent('/Users/a/b.pdf')}`);
    } finally {
      h.unmount();
    }
  });

  it('a host stays a host and a sentence stays a search', () => {
    setWindow();
    const seen: string[] = [];
    const h = mount(createElement(NewTabPage, { onNavigate: (u: string) => seen.push(u) }));
    try {
      typeAndSubmit(h, 'github.com');
      typeAndSubmit(h, 'come fare la pasta'); // allow-italian: the search phrase the omnibox rule is written against
      expect(seen[0]).toBe('https://github.com');
      expect(seen[1]).toContain('google.com/search');
    } finally {
      h.unmount();
    }
  });
});
