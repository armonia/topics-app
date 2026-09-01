/**
 * THE DOT KEEPS ITS PLACE, AND SAYS WHEN SOMETHING IS WRONG.
 *
 * Two defects were reported live on 2026-08-31 and both live in this one
 * element. «I now see two dots in the trigger»: an alarm lamp had been added
 * next to this one, and two dots four pixels apart are not two signals, they
 * are one signal that looks broken — so the alarm was folded INTO this dot.
 * «It should not resize on click»: the dot was UNMOUNTED while the menu was
 * open, so the row narrowed under the finger that had just clicked it, 93.8px
 * to 79.8px.
 *
 * Both are checked here rather than in the browser because the branch that
 * hides it is `isTauriMac || isTauriWindows` (App.tsx), and the E2E runs over
 * http on localhost, where the shell reads as `web` and both are false: in a
 * browser the before/after measurement compares the trigger with itself. The
 * decision is a prop, so the prop is what gets tested.
 *
 * (jsdom/happy-dom are not dependencies of this project: the mounting is
 * `renderToStaticMarkup`, the same as `VersionChip.test.tsx`.)
 *
 * @covers SIDEBAR-STATUS-01
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TopicsLoadDot } from './TopicsLoadDot';

describe('hidden means invisible, never unmounted', () => {
  test('hidden still renders an element, and marks it invisible', () => {
    const html = renderToStaticMarkup(<TopicsLoadDot hidden />);
    // The element EXISTS: this is the whole defect. An empty string here is the
    // trigger narrowing at the click.
    expect(html).toContain('data-testid="connection-status"');
    expect(html).toContain('invisible');
  });

  test('visible does not carry the invisible class', () => {
    const html = renderToStaticMarkup(<TopicsLoadDot />);
    expect(html).toContain('data-testid="connection-status"');
    expect(html).not.toContain('invisible');
  });

  test('the two states render the SAME element, so the row cannot change width', () => {
    const shown = renderToStaticMarkup(<TopicsLoadDot />);
    const gone = renderToStaticMarkup(<TopicsLoadDot hidden />);
    // Same testid, same size classes: only the visibility differs. `h-2 w-2` is
    // what the row reserves; a hidden dot that stopped reserving it would be
    // the same regression wearing a different shirt.
    for (const marker of ['data-testid="connection-status"', 'h-2', 'w-2', 'flex-shrink-0']) {
      expect(shown).toContain(marker);
      expect(gone).toContain(marker);
    }
  });
});

describe('the alarm is declared, not just painted', () => {
  test('an alarm sets the attribute a test can read and makes the dot pulse', () => {
    const html = renderToStaticMarkup(<TopicsLoadDot alarm />);
    // The attribute, not the colour: reading a hue back out of a pixel is how a
    // guard ends up asserting the palette instead of the state.
    expect(html).toContain('data-alarm="true"');
    expect(html).toContain('animate-pulse');
  });

  test('at rest there is no alarm and no pulse', () => {
    const html = renderToStaticMarkup(<TopicsLoadDot />);
    expect(html).not.toContain('data-alarm="true"');
    expect(html).not.toContain('animate-pulse');
  });

  test('an alarm still shows while hidden: it outranks the window commands', () => {
    // `hidden` exists for the Tauri window buttons painted over this spot. An
    // alarm that let itself be hushed by a decoration would be the one state
    // where the dot has to speak and does not.
    const html = renderToStaticMarkup(<TopicsLoadDot hidden alarm />);
    expect(html).toContain('data-alarm="true"');
    expect(html).toContain('animate-pulse');
  });
});
