/**
 * THE PLAN TAB RENDERS THE PLAN, NOT THE FENCE.
 *
 * What was on screen (card 78c3c527): the Plan tab showed «proposit plan» and a
 * word cut down to «legata». The word was «allegata», clipped because this tab
 * was the only one of the three surfaces that rendered the agent's comment RAW,
 * inside a block that does not wrap: the plan could be read only by scrolling
 * sideways. The thread and the card already dropped the ```question fence and
 * ran the body through markdown; this surface did not.
 *
 * The cure landed with the drawer rework (34e49f33e) and never got a guard. It
 * is three lines — `parseQuestionBlock`, `ChatMarkdown`, `break-words` — which
 * is exactly the size of change a later refactor drops without noticing.
 *
 * WHY THIS TEST READS THE SOURCE INSTEAD OF MOUNTING. Mounting is the stronger
 * proof and it is what `ThreadRuns.test.tsx` and `VersionChip.test.tsx` do. It
 * is not available here: `TaskDetail.tsx` imports through the `@/…` alias, which
 * Vite resolves and `bun test` does not (measured: "Cannot find module
 * '@/lib/popoverStyles'"). The file's other guards — `queueReason.test.ts`,
 * `boardOrder.test.ts` — read the source for the same reason, so this follows
 * the house rule instead of dragging a 3000-line component into a resolver that
 * cannot load it. What it can prove: the surface still passes through markdown
 * and still breaks words. What it cannot: what a browser paints — that is the
 * E2E's job.
 *
 * Seen on card 78c3c527.
 *
 * @covers PLANTAB-01
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dir, 'TaskDetail.tsx'), 'utf8');

/** The body of `SurfaceContent`, from its signature to the end of the function. */
const surface = (() => {
  const start = src.indexOf('export function SurfaceContent');
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, start + 2200);
})();

describe('the Plan tab', () => {
  test('the body goes through the markdown renderer', () => {
    // A raw `{surface.content}` here is the regression: it prints the fence and
    // clips the words.
    expect(surface).toContain('<ChatMarkdown');
    expect(surface).toContain('data-testid="plan-surface-body"');
  });

  test('the container breaks long words instead of scrolling sideways', () => {
    const body = surface.slice(surface.indexOf('data-testid="plan-surface-body"') - 260);
    expect(body.slice(0, 260)).toContain('break-words');
  });

  test('nothing in this surface renders inside a non-wrapping block', () => {
    // `whitespace-pre` (without `-wrap`) and `<pre` are the two shapes that
    // brought back the sideways scroll. Measured on the JSX only: the comment
    // above the function NAMES `<pre>` as the thing that went wrong, and a
    // grep over the whole slice would fail on the explanation instead of on
    // the code.
    const jsx = surface.slice(surface.indexOf('return ('));
    expect(jsx).not.toContain('whitespace-pre"');
    expect(jsx).not.toContain('<pre');
  });

  test('the question fence is parsed, not printed', () => {
    expect(surface).toContain('parseQuestionBlock(surface.content)');
    expect(surface).toContain('```question');
  });
});
