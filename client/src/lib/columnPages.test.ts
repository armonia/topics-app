import { describe, expect, test } from 'bun:test';
import { COLUMN_PAGE } from './boardOrder';
import { recallColumnPages, rememberColumnPages } from './columnPages';

/**
 * The pages a reader reached in a paged column outlive the column's unmount.
 *
 * @covers LIST-PAGE-01
 */
describe('columnPages', () => {
  test('a view never seen starts from the first page', () => {
    expect(recallColumnPages('p-unseen:live', 'done')).toBe(COLUMN_PAGE);
  });

  test('the pages reached come back per view and per column, and no other', () => {
    rememberColumnPages('p-a:live', 'done', COLUMN_PAGE * 2);
    expect(recallColumnPages('p-a:live', 'done')).toBe(COLUMN_PAGE * 2);
    expect(recallColumnPages('p-a:live', 'review')).toBe(COLUMN_PAGE);
    expect(recallColumnPages('p-a:archive', 'done')).toBe(COLUMN_PAGE);
    expect(recallColumnPages('p-b:live', 'done')).toBe(COLUMN_PAGE);
  });

  test('a column that shrank back to one page forgets the slot', () => {
    rememberColumnPages('p-c:live', 'done', COLUMN_PAGE * 3);
    rememberColumnPages('p-c:live', 'done', COLUMN_PAGE);
    expect(recallColumnPages('p-c:live', 'done')).toBe(COLUMN_PAGE);
  });
});
