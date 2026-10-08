/**
 * THE SIZE OF A PICTURE THE PERSON SENDS, read from the file in the composer.
 *
 * The bubble of a send is drawn before the server has its row, so it has no
 * `mediaSizes` from the server (`server/lib/media-size.ts`): its picture was
 * zero pixels tall until its bytes came back from `/api/media`, then grew to
 * 320 px under the reader's eyes (CLS 0.0488 measured on
 * `chat-image-box.spec.ts`, T7b). The file is already here, so its size is
 * read here and goes on the bubble under the path `MediaImage` looks it up by
 * (`Chat/mediaBox.ts`).
 *
 * Read by an `<img>`, the same element that will draw it: its natural size is
 * the one the box has to match, EXIF orientation included. A `load` on a local
 * file comes in milliseconds and does not wait for the decode; it runs while
 * the file uploads, and the send never waits for it longer than `WAIT_MS`.
 * No size (not a raster picture, a file the browser refuses, no DOM): the
 * picture behaves as before.
 */
import type { MediaSize, MediaSizes } from '../../../../shared/media-sizes';

const WAIT_MS = 500;

/** The natural size of a picture file (or of a `data:` URL), if the browser reads one. */
export function readPictureSize(source: Blob | string): Promise<MediaSize | undefined> {
  if (typeof Image === 'undefined') return Promise.resolve(undefined);
  // An SVG has no size of its own the box could rely on (the server sends none either).
  if (typeof source !== 'string' && (!source.type.startsWith('image/') || source.type === 'image/svg+xml')) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const url = typeof source === 'string' ? source : URL.createObjectURL(source);
    const img = new Image();
    const done = (size: MediaSize | undefined) => {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      if (typeof source !== 'string') URL.revokeObjectURL(url);
      resolve(size);
    };
    const timer = setTimeout(() => done(undefined), WAIT_MS);
    img.onload = () => done(img.naturalWidth > 0 && img.naturalHeight > 0 ? [img.naturalWidth, img.naturalHeight] : undefined);
    img.onerror = () => done(undefined);
    img.src = url;
  });
}

/** An uploaded picture's path, and the reading of its size still under way. */
export type PendingSize = readonly [path: string, size: Promise<MediaSize | undefined>];

/** The sizes of the uploaded pictures, by the path each one is attached under. */
export async function sizesByPath(uploads: readonly PendingSize[]): Promise<MediaSizes | undefined> {
  const sizes: MediaSizes = {};
  for (const [path, size] of uploads) {
    const s = await size;
    if (s) sizes[path] = s;
  }
  return Object.keys(sizes).length > 0 ? sizes : undefined;
}
