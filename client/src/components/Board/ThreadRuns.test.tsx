/**
 * The gate on the READING side of the fold: what the thread actually draws.
 *
 * The rule that decides which rows are bookkeeping is pure and covered next
 * door (`shared/task-comment-service.test.ts`). This file covers the half that
 * can be wrong in silence and that no type checks: a fold that never draws, and
 * a fold that draws its one line and THROWS AWAY the rows behind it. Both
 * render as a perfectly plausible thread. Both were mutated into an earlier
 * version of this branch and the whole unit suite stayed green, which is how a
 * feature ships as a promise instead of a fact.
 *
 * The promise under test is the one the brief made: NESSUN CONTENUTO SI PERDE.
 * The reason a task sat in the queue has to stay readable to whoever goes
 * looking for it, so the assertions are about the rendered document, not about
 * the grouping function.
 *
 * WHY A STATIC RENDER IS ENOUGH TO SAY "still readable when you reopen it": the
 * fold is a native `<details>`, so its rows are in the document whether it is
 * open or shut - the browser hides and shows them, our code never removes them.
 * There is no state in which they have been rendered away, which is a stronger
 * statement than clicking a toggle twice and finding them still there. What the
 * markup has to show is therefore exactly this: the fold is CLOSED (no `open`
 * attribute) and every row it holds is nonetheless present, in order.
 *
 * (jsdom/happy-dom are deliberately not dependencies of this project - same
 * choice as `Shared/Select.test.tsx` - so the mount is `renderToStaticMarkup`.
 * The click-and-look-at-it path is E2E's job.)
  * @covers THREAD-05
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThreadRuns, type ThreadRunsRow } from './ThreadRuns';

/** A machine-written note the dispatcher marked as its own bookkeeping. */
const service = (id: string): ThreadRunsRow =>
  ({ id, author: 'system', kind: 'service', content: `bookkeeping ${id}` });

/** Somebody's word: an agent reply, a human request, a review note. */
const speech = (id: string, author = 'agent'): ThreadRunsRow =>
  ({ id, author, kind: 'comment', content: `speech ${id}` });

/** Render a thread the way the drawer does: one paragraph per row, tagged with its id. */
function draw(rows: ThreadRunsRow[], breaksRun?: (c: ThreadRunsRow, i: number) => boolean): string {
  return renderToStaticMarkup(
    <ThreadRuns
      comments={rows}
      breaksRun={breaksRun}
      renderRow={(c) => <p key={c.id} data-row={c.id}>{c.content}</p>}
    />,
  );
}

/** The ids the document actually paints, in document order. */
function drawnRows(html: string): string[] {
  return [...html.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1]!);
}

/** The `<details>` blocks, as raw markup, in document order. */
function folds(html: string): string[] {
  return [...html.matchAll(/<details\b[\s\S]*?<\/details>/g)].map((m) => m[0]);
}

describe('the thread folds the bookkeeping and keeps every row', () => {
  test('NOTHING IS LOST: every row of the thread is still painted, in the order it happened', () => {
    // A realistic wall: the agent speaks, the dispatcher accounts for itself at
    // length, the agent speaks again, more accounting, a human asks something.
    const rows = [
      speech('s1'), service('a1'), service('a2'), service('a3'),
      speech('s2'), service('b1'), service('b2'), speech('s3', 'user'),
    ];
    expect(drawnRows(draw(rows))).toEqual(rows.map((r) => r.id));
  });

  test('the wall becomes ONE line that says how many, and the rows sit behind it', () => {
    const html = draw([speech('s1'), service('a1'), service('a2'), service('a3'), speech('s2')]);
    const blocks = folds(html);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('3 righe di servizio');
    // Behind THIS fold, and nothing else: the speech stays outside it.
    expect(drawnRows(blocks[0]!)).toEqual(['a1', 'a2', 'a3']);
  });

  test('CLOSED to start with, and its rows are in the document anyway', () => {
    const html = draw([service('a1'), service('a2')]);
    const block = folds(html)[0]!;
    // No `open`: what the reader sees first is the one line, not the wall.
    expect(/<details\b[^>]*\bopen\b/.test(block)).toBe(false);
    // And yet both rows are there. Reopening cannot lose what was never
    // removed - this is the "nessun contenuto si perde" invariant, structural.
    expect(block).toContain('bookkeeping a1');
    expect(block).toContain('bookkeeping a2');
    expect(drawnRows(html)).toEqual(['a1', 'a2']);
  });

  test('a LONE service note does not fold: one click to read one line is a bad trade', () => {
    const html = draw([speech('s1'), service('a1'), speech('s2')]);
    expect(folds(html)).toHaveLength(0);
    expect(drawnRows(html)).toEqual(['s1', 'a1', 's2']);
  });

  test('the fold stays IN ITS PLACE: two walls, two folds, the words between them untouched', () => {
    const html = draw([speech('s1'), service('a1'), service('a2'), speech('s2'), service('b1'), service('b2')]);
    const blocks = folds(html);
    expect(blocks).toHaveLength(2);
    expect(drawnRows(blocks[0]!)).toEqual(['a1', 'a2']);
    expect(drawnRows(blocks[1]!)).toEqual(['b1', 'b2']);
    // The agent's words never went inside a fold.
    expect(blocks.join('')).not.toContain('data-row="s1"');
    expect(blocks.join('')).not.toContain('data-row="s2"');
  });

  test('a wall BREAKS where the agent spoke in the gap, so the session steps stay outside', () => {
    const rows = [service('a1'), service('a2'), service('a3'), service('a4')];
    // "The caller draws something of its own in the gap before a3" - whatever
    // it is, it would otherwise be swallowed whole by the fold above it.
    const html = draw(rows, (_c, i) => i === 2);
    const blocks = folds(html);
    expect(blocks).toHaveLength(2);
    expect(drawnRows(blocks[0]!)).toEqual(['a1', 'a2']);
    expect(drawnRows(blocks[1]!)).toEqual(['a3', 'a4']);
    expect(drawnRows(html)).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  test('a thread with no bookkeeping at all draws exactly as it did before', () => {
    const html = draw([speech('s1'), speech('s2', 'user'), speech('s3')]);
    expect(folds(html)).toHaveLength(0);
    expect(drawnRows(html)).toEqual(['s1', 's2', 's3']);
  });

  test('the DRAWER draws its thread through this component', () => {
    // The component being right is worth nothing if the surface stops calling
    // it, and that is a one-line edit in a 2600-line file. The drawer's own
    // wiring has no unit mount (TaskDetail pulls the API, the pane layout and a
    // dozen stores), so the presence of the call is checked on the source.
    const src = readFileSync(join(import.meta.dir, 'TaskDetail.tsx'), 'utf8');
    // The boundary matters: `<ThreadRunsSomethingElse` must not pass for it.
    expect(/<ThreadRuns[\s/>]/.test(src)).toBe(true);
    expect(/from '\.\/ThreadRuns'/.test(src)).toBe(true);
  });
});
