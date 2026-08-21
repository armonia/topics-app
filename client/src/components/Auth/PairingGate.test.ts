/**
 * On a phone, the pairing screen must stay REACHABLE.
 *
 * ── THE DEFECT THIS KEEPS CLOSED ────────────────────────────────────────────
 * Browser bars appear OVER the content and the window shrinks on its own. The
 * gate was `fixed inset-0` with vertical centring: two choices that together
 * make anything that does not fit unreachable, because a `fixed` element does
 * not lengthen the document, so nothing scrolls.
 *
 * Measured with WebKit at 320x420 (a small iPhone with the URL bar open): the
 * content ended at 566px out of 420 visible, with `scrollHeight` equal to
 * `innerHeight`. The status line, the error notice and half the instructions
 * were outside, and no gesture could reach them.
 *
 * ── WHY THIS READS THE SOURCE INSTEAD OF DRIVING A BROWSER ──────────────────
 * The real proof is a measurement in WebKit, and it was taken. But that
 * measurement cannot become a gate of this suite: the screen lives behind
 * pairing, which is the very thing it would have to measure, and `bun test`
 * here has no DOM (jsdom/happy-dom are not dependencies of this project, the
 * same choice as `lib/haptics.test.ts`).
 *
 * What can be guarded without a browser is the DECISION: that the three
 * properties making the screen reachable are still there. Remove any one of
 * them and the defect returns, and it returns in silence. Nothing breaks,
 * nothing fails, and it only shows on a small phone with the bar open. That is
 * exactly the family of defect that deserves a guard.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const GATE = readFileSync(join(import.meta.dir, 'PairingGate.tsx'), 'utf8');

/**
 * The JSX lines, with comments removed.
 *
 * Needed because this file EXPLAINS the defect in prose, and that prose names
 * the very classes being searched for: a naive search would find the sentence
 * describing the cure instead of the cure. A guard satisfied by its own
 * documentation is guarding nothing.
 */
const RIGHE_JSX = GATE.split('\n').filter((l) => {
  const t = l.trim();
  return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
});

/** The full-screen container of the gate, with its classes. */
function contenitore(): string {
  return RIGHE_JSX.find((l) => l.includes('fixed inset-0')) ?? '';
}

/** The child carrying the height and the alignment. */
function corpo(): string {
  return RIGHE_JSX.find((l) => l.includes('min-h-')) ?? '';
}

describe('PairingGate · whatever does not fit must still be reachable', () => {
  test('the container SCROLLS: the net that makes any wrong estimate harmless', () => {
    // Without this, everything else is a bet on the height of the content and
    // on the bars of a browser we do not control.
    expect(contenitore()).toContain('overflow-y-auto');
  });

  test('the height is DYNAMIC (`dvh`), not `vh` which ignores the bars', () => {
    // `vh` counts the full height even while the toolbar covers the bottom:
    // that is why the last line ends up underneath it.
    const c = corpo();
    expect(c).toContain('min-h-dvh');
    expect(c, 'no height in `vh`: on a phone it lies').not.toMatch(/min-h-screen|h-\[100vh\]/);
  });

  test('it centres only when space is left over, otherwise it starts at the top', () => {
    // Centring on a short screen clips SYMMETRICALLY: it hides the heading at
    // the top too, which is the line saying what is going on.
    const c = corpo();
    expect(c).toContain('items-start');
    expect(c).toContain('sm:items-center');
  });

  test('the screen SAYS who it is: icon, version, state', () => {
    // It was a heading in the middle of black, and it is the first thing a
    // person sees of Topics from the phone. An app that does not introduce
    // itself looks like a fault.
    expect(GATE, 'the icon').toContain('/icons/icon-192.png');
    expect(GATE, 'the bundle version').toContain('__APP_VERSION__');
    expect(GATE, 'the status line').toContain('chiaveStato');
  });

  test('the error is not cleared on every attempt: that was the FLASH', () => {
    // `setError(null)` at the head of the loop made the notice vanish as each
    // retry began and reappear an instant later. Against a machine that is
    // off, where attempts follow each other for minutes, it was a steady blink.
    //
    // It used to sit in the start routine, before the first `fetch`.
    const avvia = GATE.slice(GATE.indexOf('async function avvia'), GATE.indexOf('await fetch'));
    expect(avvia, 'the error is replaced, not zeroed before retrying')
      .not.toContain('setError(null)');
    // Positive control: on SUCCESS it is cleared, otherwise a notice would sit
    // forever under a valid code.
    expect(GATE).toContain('setError(null)');
  });
});
