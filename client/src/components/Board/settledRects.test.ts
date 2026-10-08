/**
 * The board's collision detection reads each droppable rect once per scroll.
 *
 * dnd-kit's `Rect` exposes `top/left/right/bottom` as getters that re-read the
 * scroll offset of every scrollable ancestor; `pointerWithin` read four of
 * them per droppable per pointer move (~420 forced layout checks per move on a
 * 33-card board). The fake rect below counts its getter reads the same way.
 *
 * @covers DRAGFR-01
 */
import { describe, expect, test } from 'bun:test';
import { closestCorners, pointerWithin, type ClientRect, type UniqueIdentifier } from '@dnd-kit/core';
import { boardCollision } from './format';
import { invalidateSettledRects, settledRects } from './settledRects';

/** A droppable rect shaped like dnd-kit's: measured once, shifted by a live scroll offset on every read. */
function liveRect(measured: { top: number; left: number; width: number; height: number }, scroll: { y: number; x: number }, reads: { n: number }): ClientRect {
  const at = { ...scroll };
  const rect = { width: measured.width, height: measured.height } as ClientRect;
  const axis = { top: 'y', bottom: 'y', left: 'x', right: 'x' } as const;
  const raw = { ...measured, right: measured.left + measured.width, bottom: measured.top + measured.height };
  for (const key of ['top', 'bottom', 'left', 'right'] as const) {
    Object.defineProperty(rect, key, {
      get: () => {
        reads.n += 1;
        return raw[key] + at[axis[key]] - scroll[axis[key]];
      },
      enumerable: true,
    });
  }
  return rect;
}

function board(reads: { n: number }, scroll: { y: number; x: number }) {
  const rects = new Map<UniqueIdentifier, ClientRect>([
    ['todo', liveRect({ top: 0, left: 300, width: 280, height: 800 }, scroll, reads)],
    ['backlog', liveRect({ top: 0, left: 0, width: 280, height: 800 }, scroll, reads)],
    ['card-a', liveRect({ top: 40, left: 308, width: 264, height: 60 }, scroll, reads)],
    ['card-b', liveRect({ top: 110, left: 308, width: 264, height: 60 }, scroll, reads)],
  ]);
  const droppableContainers = [...rects.keys()].map((id) => ({ id })) as unknown as Parameters<typeof pointerWithin>[0]['droppableContainers'];
  return { rects, droppableContainers };
}

const ids = (cs: Array<{ id: UniqueIdentifier }>) => cs.map((c) => c.id);
const COLUMNS = ['backlog', 'todo', 'in_progress', 'review', 'done'];

describe('settledRects', () => {
  test('a copy reads what the getters read, right and bottom included', () => {
    const reads = { n: 0 };
    const { rects } = board(reads, { y: 0, x: 0 });
    const settled = settledRects(rects);
    for (const [id, live] of rects) {
      const s = settled.get(id)!;
      expect([s.top, s.left, s.right, s.bottom, s.width, s.height]).toEqual([live.top, live.left, live.right, live.bottom, live.width, live.height]);
    }
  });

  test('the board collision gives the same answer on plain copies as on the live rects', () => {
    const reads = { n: 0 };
    const scroll = { y: 0, x: 0 };
    const { rects, droppableContainers } = board(reads, scroll);
    const collisionRect = { top: 120, left: 320, width: 200, height: 40, right: 520, bottom: 160 };
    for (const pointer of [{ x: 330, y: 130 }, { x: 330, y: 500 }, { x: 900, y: 900 }]) {
      const args = { active: { id: 'card-a' }, collisionRect, droppableRects: rects, droppableContainers, pointerCoordinates: pointer } as unknown as Parameters<typeof pointerWithin>[0];
      // The board's rule on the live rects: a card under the pointer beats its column.
      const within = pointerWithin(args);
      const card = within.find((c) => !COLUMNS.includes(String(c.id)));
      const expected = within.length ? (card ? [card] : within) : closestCorners(args);
      expect(ids(boardCollision(args))).toEqual(ids(expected));
    }
  });

  test('a second pass with no scroll in between reads no getter at all', () => {
    const reads = { n: 0 };
    const scroll = { y: 0, x: 0 };
    const { rects, droppableContainers } = board(reads, scroll);
    const args = { active: { id: 'card-a' }, collisionRect: { top: 0, left: 0, width: 1, height: 1, right: 1, bottom: 1 }, droppableRects: rects, droppableContainers, pointerCoordinates: { x: 330, y: 130 } } as unknown as Parameters<typeof pointerWithin>[0];
    invalidateSettledRects();
    boardCollision(args);
    // Two getters per rect (top, left): right and bottom come from width and height.
    expect(reads.n).toBe(rects.size * 2);
    for (let i = 0; i < 59; i++) boardCollision(args);
    expect(reads.n).toBe(rects.size * 2);
  });

  test('a scroll makes every copy stale, and the new offset is read', () => {
    const reads = { n: 0 };
    const scroll = { y: 0, x: 0 };
    const { rects } = board(reads, scroll);
    invalidateSettledRects();
    expect(settledRects(rects).get('card-b')!.top).toBe(110);
    scroll.y = 50;
    invalidateSettledRects();
    expect(settledRects(rects).get('card-b')!.top).toBe(60);
    expect(settledRects(rects).get('card-b')!.bottom).toBe(120);
  });

  test('a droppable measured again is a new rect, never answered from the old copy', () => {
    const reads = { n: 0 };
    const scroll = { y: 0, x: 0 };
    const first = liveRect({ top: 10, left: 0, width: 10, height: 10 }, scroll, reads);
    expect(settledRects(new Map([['x', first]])).get('x')!.top).toBe(10);
    const again = liveRect({ top: 90, left: 0, width: 10, height: 10 }, scroll, reads);
    expect(settledRects(new Map([['x', again]])).get('x')!.top).toBe(90);
  });
});
