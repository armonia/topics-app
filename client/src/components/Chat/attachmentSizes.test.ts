/**
 * THE SIZE OF A PICTURE THE PERSON SENDS: what goes on the bubble, by path.
 * The reading itself needs a browser and is covered end to end by
 * `tests/e2e/chat-image-box.spec.ts` (the bubble of who attaches).
 * @covers CHAT-MEDIA-BOX-01
 */
import { describe, expect, test } from 'bun:test';
import { readPictureSize, sizesByPath } from './attachmentSizes';

describe('the sizes of the uploaded pictures', () => {
  test('by the path each is attached under; a picture with no size is left out', async () => {
    expect(await sizesByPath([
      ['/uploads/a.png', Promise.resolve([900, 500])],
      ['/uploads/notes.txt', Promise.resolve(undefined)],
      ['/uploads/b.jpg', Promise.resolve([300, 400])],
    ])).toEqual({ '/uploads/a.png': [900, 500], '/uploads/b.jpg': [300, 400] });
  });

  test('no size at all: nothing, and the bubble draws as before', async () => {
    expect(await sizesByPath([])).toBeUndefined();
    expect(await sizesByPath([['/uploads/a.svg', Promise.resolve(undefined)]])).toBeUndefined();
  });

  test('not a raster picture, or no DOM to read it with: no size, never an error', async () => {
    expect(await readPictureSize(new Blob(['<svg/>'], { type: 'image/svg+xml' }))).toBeUndefined();
    expect(await readPictureSize(new Blob(['text'], { type: 'text/plain' }))).toBeUndefined();
    expect(await readPictureSize(new Blob([new Uint8Array(8)], { type: 'image/png' }))).toBeUndefined();
  });
});
