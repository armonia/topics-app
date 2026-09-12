import { describe, expect, it } from 'bun:test';
import { CHECKLIST_WINDOW, checklistWindow } from './checklistWindow';

/** @covers KANBAN-81 */
const row = (id: string, speaks = false) => ({ id, subtaskWork: speaks ? { kind: 'unattended' } : null });

describe('checklistWindow', () => {
  it('shows everything, and folds nothing, up to the cap', () => {
    const rows = [row('a'), row('b'), row('c'), row('d'), row('e')];
    expect(checklistWindow(rows)).toEqual({ shown: rows, hidden: 0 });
  });

  it('keeps the step that has something to say, even when it is last', () => {
    // The shape measured on card e1cdd61d: five done steps, then the one
    // nobody is working. `slice(0, 5)` dropped exactly that one.
    const rows = [row('1'), row('2'), row('3'), row('4'), row('5'), row('live', true)];
    const { shown, hidden } = checklistWindow(rows);
    expect(shown.map((r) => r.id)).toEqual(['1', '2', '3', '4', 'live']);
    expect(hidden).toBe(1);
  });

  it('hands the rows back in the checklist order, not in the order it picked them', () => {
    const rows = [row('1'), row('2', true), row('3'), row('4'), row('5'), row('6')];
    expect(checklistWindow(rows).shown.map((r) => r.id)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('folds the surplus when more steps speak than there are slots', () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(String(i), true));
    const { shown, hidden } = checklistWindow(rows);
    expect(shown).toHaveLength(CHECKLIST_WINDOW);
    expect(hidden).toBe(2);
  });
});
