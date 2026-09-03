/**
 * @covers BOARD-DRAFT-01
 */
import { describe, expect, test } from 'bun:test';
import { titoloDaTesto } from '../../../../shared/task-title';
import { draftPreviewOf } from './draftPreview';

const img = { path: '/tmp/uploads/shot.png', name: 'shot.png', isImage: true };
const pdf = { path: '/tmp/uploads/spec.pdf', name: 'spec.pdf', isImage: false };

describe('the ghost card of the floating composer', () => {
  test('nothing typed and nothing attached is no card', () => {
    expect(draftPreviewOf('', [], 'todo')).toBeNull();
    expect(draftPreviewOf('   \n ', [], 'backlog')).toBeNull();
  });

  test('the title is the one the create will send, not a second cut', () => {
    const text = 'Sidebar spacing\nThe chevron column wastes space.';
    const ghost = draftPreviewOf(text, [], 'todo');
    expect(ghost).toEqual({
      title: titoloDaTesto(text).title,
      description: titoloDaTesto(text).description,
      status: 'todo',
      images: [],
      files: [],
    });
    expect(ghost?.title).toBe('Sidebar spacing');
    expect(ghost?.description).toBe('The chevron column wastes space.');
  });

  test('attachments ride along, images by path and files by name', () => {
    const ghost = draftPreviewOf('Fix it', [img, pdf], 'backlog');
    expect(ghost?.images).toEqual([img.path]);
    expect(ghost?.files).toEqual([pdf.name]);
    expect(ghost?.status).toBe('backlog');
  });

  test('an attachment alone is still a card, named after the file', () => {
    const ghost = draftPreviewOf('', [img], 'todo');
    expect(ghost).not.toBeNull();
    expect(ghost?.title).toBe('shot.png');
    expect(ghost?.images).toEqual([img.path]);
  });
});
