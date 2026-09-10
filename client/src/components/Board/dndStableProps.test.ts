/**
 * The board's sensor options must stay OUT of the render.
 *
 * dnd-kit memoizes each sensor on `[sensor, options]`. An options object
 * written inline makes `sensors` a new array on every render of the pane, which
 * rebuilds dnd-kit's InternalContext, which re-renders every card that goes
 * through `useSortable` — at identical props, so `memo(Card)` holds nothing.
 * Measured 2026-09-07: 32 cards out of 32 re-rendered 25-29 times in 30 idle
 * seconds, ~550 ms of JS per 30 s with four agents at work. The defect was
 * there from the day `memo(Card)` was written, and no gate could see it.
 *
 * WHAT THIS COVERS AND WHAT IT DOES NOT. It reads the source and refuses an
 * inline literal in the one position that has already caused the failure. It
 * does not measure renders, and it would not notice a DIFFERENT unstable value
 * reaching the cards through some other context — that would need a profiler in
 * the page, and `check:drag` (p95 frame time during a drag, with a baseline) is
 * the measured half of this surface.
 *
 * @covers BOARDIDLE-01
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BOARD_DIR = import.meta.dir;
const board = readFileSync(join(BOARD_DIR, 'KanbanBoardPane.tsx'), 'utf8');
const card = readFileSync(join(BOARD_DIR, 'Card.tsx'), 'utf8');

/** Every `useSensor(<sensor>, <options>)` call in the pane, with its arguments. */
function sensorCalls(source: string): Array<{ call: string; options: string }> {
  const calls: Array<{ call: string; options: string }> = [];
  const re = /useSensor\(([^)]*)\)/g;
  for (const m of source.matchAll(re)) {
    const args = m[1]!.split(',').map((a) => a.trim());
    calls.push({ call: m[0]!, options: args[1] ?? '' });
  }
  return calls;
}

describe('kanban sensors are referentially stable', () => {
  test('the pane really does build its sensors here — otherwise this file guards nothing', () => {
    // A rename or a move would leave every assertion below vacuously true.
    expect(board).toContain('const sensors = useSensors(');
    expect(sensorCalls(board).length).toBeGreaterThanOrEqual(3);
  });

  test('every useSensor call takes its options BY NAME, never an inline literal', () => {
    const offenders = sensorCalls(board).filter(({ options }) => !/^[A-Z][A-Z0-9_]*$/.test(options));
    expect(offenders.map((o) => o.call)).toEqual([]);
  });

  test('those names are module constants, declared above the component', () => {
    const componentAt = board.indexOf('export function KanbanBoardPane');
    expect(componentAt).toBeGreaterThan(0);
    for (const { options } of sensorCalls(board)) {
      const declaredAt = board.indexOf(`const ${options} =`);
      expect(declaredAt, `${options} must be declared at module scope`).toBeGreaterThan(0);
      expect(declaredAt, `${options} is declared inside the component`).toBeLessThan(componentAt);
    }
  });

  test('the card stays memoized: without it a stable context buys nothing', () => {
    expect(card).toContain('memo(');
    expect(card).toMatch(/const Card = memo\(|export const Card = memo\(/);
  });
});
