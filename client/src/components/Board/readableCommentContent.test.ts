import { describe, expect, test } from 'bun:test';
import { readableCommentContent } from './readableCommentContent';

const tr = (k: string) => `T:${k}`;

describe('readableCommentContent', () => {
  test('the English incomplete-card notice becomes the catalogue sentence', () => {
    expect(readableCommentContent('Incomplete card: an agent opened it without a bar.', tr)).toBe('T:board.task.incompleteCardNotice');
  });
  test('a leaked human_ask field name is dropped', () => {
    expect(readableCommentContent('human_ask: Approvi?', tr)).toBe('Approvi?');
  });
  test('plain text passes through', () => {
    expect(readableCommentContent('ciao', tr)).toBe('ciao');
  });
});
