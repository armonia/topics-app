/**
 * THE SIZE OF EVERY PICTURE A MESSAGE SHOWS, sent along with the message.
 *
 * An `<img>` without a declared size is zero pixels tall until its bytes
 * arrive, and the moment they do everything under it moves. Inside a chat that
 * is a jump under the reader's eyes: a reply with an image, landed while the
 * reader was away and drawn by the early reveal of a visited topic, measured
 * CLS 0.034 against a contract of 0.01 (cloud-quality-pass, T1). The client
 * cannot know the size before the bytes; the server can, from the first bytes
 * of the file (`services/image-shape.ts`, no decoder, no dependency).
 *
 * WHY ON THE WIRE AND NOT IN THE ROW. Nothing is stored: the size is read when
 * the message leaves (a history page, a `message:new`, a `message:media`), so
 * every row ever written gets it, and no column is needed. A client that does
 * not know the field ignores it; a server that does not send it leaves the
 * client drawing as before. The reads are cached by path and mtime.
 *
 * WHICH PATHS. The ones the client draws as `MediaImage` (`MessageContent.tsx`):
 * the `MEDIA:` marker the server appends, an `[Attached file: …]`, the `media`
 * array, and a markdown image on a local path. The same patterns as
 * `client/src/components/messageMedia.ts`, read from `content` and from the text
 * of the timeline blocks, keyed by the string the client will look up.
 *
 * A size that cannot be read is simply absent: the picture then grows when it
 * loads, as it always did.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { imageShape } from "../services/image-shape";

/** `[width, height]` in CSS pixels, as the browser will lay the picture out. */
export type MediaSize = [number, number];
export type MediaSizes = Record<string, MediaSize>;

/** What `MediaImage` draws as a picture (`isImage` in `MessageContent.tsx`), minus SVG, whose laid-out size is not its header's. */
const RASTER_EXT = /\.(png|jpe?g|gif|webp)$/i;

const MEDIA_MARKER = /MEDIA:([^\s\n]+)/g;
const ATTACHED = /\[Attached file:\s*([^\]]+)\]/g;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g;

/**
 * The path a markdown image is drawn under, or null when it is not drawn as a
 * `MediaImage`. Mirror of the `img` renderer of `markdownComponents`.
 */
function markdownImagePath(src: string): string | null {
  if (/^(data|blob|https?):/i.test(src)) return null;
  let path = src;
  if (path.includes("uploads/") && !path.startsWith("/")) path = "/uploads/" + path.split("uploads/").pop();
  return path.startsWith("/uploads/") || path.startsWith("/Users/") || path.startsWith("/tmp/") ? path : null;
}

function collectFromText(text: string, into: Set<string>): void {
  // Most rows draw no picture: one `includes` each instead of three regex walks.
  if (!text || (!text.includes("MEDIA:") && !text.includes("[Attached file:") && !text.includes("!["))) return;
  for (const m of text.matchAll(MEDIA_MARKER)) into.add(m[1]!);
  for (const m of text.matchAll(ATTACHED)) into.add(m[1]!.trim());
  if (text.includes("![")) {
    for (const m of text.matchAll(MARKDOWN_IMAGE)) {
      const path = markdownImagePath(m[1]!);
      if (path) into.add(path);
    }
  }
}

/** The raster image paths a message draws, by the key the client looks them up with. */
export function imagePathsOf(msg: { content?: unknown; blocks?: unknown; media?: unknown }): string[] {
  const found = new Set<string>();
  if (typeof msg.content === "string") collectFromText(msg.content, found);
  if (Array.isArray(msg.blocks)) {
    for (const b of msg.blocks) {
      // Tool blocks carry no prose of the turn; every other kind with text is drawn as prose.
      if (b && typeof b === "object" && (b as { kind?: unknown }).kind !== "tool") {
        const text = (b as { text?: unknown }).text;
        if (typeof text === "string") collectFromText(text, found);
      }
    }
  }
  if (Array.isArray(msg.media)) for (const p of msg.media) if (typeof p === "string") found.add(p);
  return [...found].filter((p) => RASTER_EXT.test(p));
}

/**
 * EXIF orientation of a JPEG, 1 when absent or unreadable. 5 to 8 turn the
 * picture by a quarter, and the browser lays it out turned
 * (`image-orientation: from-image`), so its width and height swap.
 */
export function jpegOrientation(b: Buffer): number {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return 1;
    const marker = b[i + 1]!;
    if (marker === 0xda || marker === 0xd9) return 1; // image data: no metadata past here
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return 1;
    if (marker === 0xe1 && i + 4 + len - 2 <= b.length && b.toString("latin1", i + 4, i + 10) === "Exif\0\0") {
      return tiffOrientation(b.subarray(i + 10, i + 2 + len));
    }
    i += 2 + len;
  }
  return 1;
}

function tiffOrientation(t: Buffer): number {
  if (t.length < 8) return 1;
  const order = t.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") return 1;
  const le = order === "II";
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ifd = u32(4);
  if (ifd + 2 > t.length) return 1;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > t.length) return 1;
    if (u16(entry) === 0x0112) {
      const v = u16(entry + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

const HEAD_BYTES = 64 * 1024;

function readHead(path: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return n > 0 ? buf.subarray(0, n) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** The laid-out size of one file, or null. */
function readSize(file: string): MediaSize | null {
  const shape = imageShape(file);
  if (!shape || shape.vector || !shape.format) return null;
  const { width, height } = shape;
  if (shape.format === "jpeg") {
    const head = readHead(file);
    if (head && jpegOrientation(head) >= 5) return [height, width];
  }
  return [width, height];
}

/**
 * Sizes already read, by file and mtime: a page of history asks again for the
 * same pictures every time it is opened. Bounded, oldest first out.
 */
const CACHE_MAX = 1000;
const cache = new Map<string, { mtimeMs: number; size: MediaSize | null }>();

function cachedSize(file: string): MediaSize | null {
  let mtimeMs: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) return null;
    mtimeMs = st.mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.size;
  const size = readSize(file);
  cache.delete(file);
  cache.set(file, { mtimeMs, size });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return size;
}

export interface MediaFileRules {
  /** Where `/uploads/…` is served from (server.ts). */
  uploadsDir: string;
  /** The allowlist `/api/media` reads through. */
  isPathAllowed: (file: string) => boolean;
}

/** The file a client path is served from, or null when the server would not serve it. */
export function mediaFileOf(path: string, rules: MediaFileRules): string | null {
  if (path.startsWith("/uploads/")) {
    const root = resolve(rules.uploadsDir);
    const file = resolve(join(root, path.slice("/uploads/".length)));
    const rel = relative(root, file);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? file : null;
  }
  if (!isAbsolute(path)) return null;
  const file = resolve(path);
  return rules.isPathAllowed(file) ? file : null;
}

/** The sizes of the pictures a message draws, or undefined when none is known. */
export function mediaSizesOf(msg: { content?: unknown; blocks?: unknown; media?: unknown }, rules: MediaFileRules): MediaSizes | undefined {
  let out: MediaSizes | undefined;
  for (const path of imagePathsOf(msg)) {
    const file = mediaFileOf(path, rules);
    const size = file ? cachedSize(file) : null;
    if (size) (out ??= {})[path] = size;
  }
  return out;
}

/**
 * The message, or the frame, with `mediaSizes` added when it draws a picture
 * whose size is known. The same object when there is nothing to add.
 */
export function withMediaSizes<T extends object>(msg: T, rules: MediaFileRules): T & { mediaSizes?: MediaSizes } {
  const sizes = mediaSizesOf(msg as { content?: unknown; blocks?: unknown; media?: unknown }, rules);
  return sizes ? { ...msg, mediaSizes: sizes } : msg;
}
