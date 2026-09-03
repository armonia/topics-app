/**
 * THE "PIANO" TAB RENDERS THE PLAN, NOT THE FENCE.
 *
 * What was on screen: the tab showed the plan comment verbatim, fence
 * included, and markdown renders a fenced block as a `<pre>` that does not
 * wrap. So the plan could only be read by scrolling sideways, and the visible
 * window cut words in half: the reported symptom was the word «legata», which
 * is the tail of «allegata» in the fixture next to this file.
 *
 * The other two surfaces showing the same comment already drop the envelope
 * (the thread and the card, both through `parseQuestionBlock`). This pins the
 * third one to the same reading, on the REAL content of a plan comment, kept
 * on file so the shape under test is a document and not a string literal
 * trimmed to fit the assertion.
 *
 * Mounting is `renderToStaticMarkup` for the reason `ThreadRuns.test.tsx`
 * states: jsdom/happy-dom are not dependencies here. It is enough, because
 * everything asserted below is in the first paint. What a static tree CANNOT
 * see is the geometry (a `<pre>` is only wide once it is laid out): that half
 * is measured in the browser by `tests/e2e/plan-surface.spec.ts`.
 *
 * @covers KANBAN-07
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanSurface } from './PlanSurface';
import { PLAN_APPROVE_LABEL, PLAN_REVISE_LABEL } from '../../../../shared/board';

/**
 * The comment AS THE SERVER SAVED IT: fence, the plan flattened onto one line
 * (`addComment` is the single writer of that layout), then the options. That
 * one long line is the whole story: rendered raw it becomes a `<pre>` nobody
 * can read without scrolling sideways.
 *
 * The two fixtures are a pair. `plan-comment.md` is what the agent writes and
 * is what `tests/e2e/plan-surface.spec.ts` posts; `plan-comment.saved.md` is
 * what comes back out of the database, and that spec asserts the server really
 * composes it byte for byte. So the shape pinned here cannot drift away from
 * the shape the product produces.
 */
const PLAN_COMMENT = readFileSync(join(import.meta.dir, '__fixtures__', 'plan-comment.saved.md'), 'utf8');
const render = (content: string) => renderToStaticMarkup(createElement(PlanSurface, { content }));

describe('la tab Piano', () => {
  test('rende il piano come prosa: nessun <pre>, almeno un <p>', () => {
    const html = render(PLAN_COMMENT);
    expect(html).not.toContain('<pre');
    expect(html).toContain('<p>');
    // The word that was cut in half is there whole, and it is prose: if the
    // fence came back, this text would be inside the `<pre>` asserted above.
    expect(html).toContain('allegata');
    // The envelope itself never reaches the screen.
    expect(html).not.toContain('```');
    expect(html).not.toContain('question');
  });

  test('le opzioni sono un elenco, una riga per scelta', () => {
    const html = render(PLAN_COMMENT);
    expect(html).toContain('data-testid="plan-surface-options"');
    // Count the rows of the OPTIONS list only: the plan itself has an ordered
    // list of steps, and counting every `<li>` on the page would count those.
    const list = html.slice(html.indexOf('data-testid="plan-surface-options"'));
    expect(list.match(/<li/g)?.length).toBe(2);
    expect(list).toContain(PLAN_APPROVE_LABEL);
    expect(list).toContain(PLAN_REVISE_LABEL);
  });

  /**
   * PUBLISHING IS NOT A PLAN OPTION. "Landa e pubblica" is merge + push at one
   * click, a human-only board action with its own diff preview, and the fixture
   * carries it because old deliveries still do. The parser filters it; this tab
   * must never be the surface that puts it back on screen.
   */
  test('«Landa e pubblica» resta filtrata', () => {
    expect(PLAN_COMMENT).toContain('Landa e pubblica'); // it IS in the source
    expect(render(PLAN_COMMENT)).not.toContain('Landa e pubblica');
  });

  test('un piano senza recinto passa intero', () => {
    const html = render('# Piano\n\nUn paragrafo e basta.');
    expect(html).toContain('Un paragrafo e basta.');
    expect(html).not.toContain('data-testid="plan-surface-options"');
    expect(html).not.toContain('<pre');
  });
});
