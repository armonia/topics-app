/**
 * The size of each picture a message draws, as it travels with the message
 * (`mediaSizes` on a history row, a `message:new` and a `message:media`
 * frame). Written by the server (`server/lib/media-size.ts`), read by the
 * client to give the picture its box before its bytes
 * (`client/src/components/Chat/mediaBox.ts`). CHAT-MEDIA-BOX-01.
 */

/** `[width, height]` in CSS pixels, as the browser will lay the picture out. */
export type MediaSize = [number, number];

/** By the path the client looks the picture up with. */
export type MediaSizes = Record<string, MediaSize>;
