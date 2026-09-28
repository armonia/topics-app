/**
 * The one place an image's bytes are made safe to send to the API, whatever
 * tool produced them: `read_file`, an inline screenshot, or an MCP server's
 * answer.
 *
 * WHY ONE PLACE. Before this, each of the three sources decided its own
 * `mediaType` (usually from a file extension) and resized independently, or
 * not at all (`browser_screenshot inline:true` never resized; Windows/Linux
 * had no resize mechanism at all). Three sources, three sets of gaps: a
 * `.png` that is actually JPEG bytes sent the wrong `media_type` and got a
 * 400 forever, and a screenshot at native device resolution or a Darkroom
 * export well under the resize threshold but multi-megabyte as PNG could
 * still blow the request body into a 413. This is the seam every image now
 * passes through exactly once, right before it becomes an `image` content
 * block (`agent-loop.ts`'s `toolResultContent`).
 *
 * THE FORMAT COMES FROM THE BYTES, never from a name or an extension: see
 * `image-shape.ts`. A file called `v47.png` that is really a JPEG is
 * measured, resized and labelled as what it actually is.
 *
 * THE CAP IS ON BYTES, NOT ONLY ON PIXELS. A screenshot at 1254px (under the
 * 1568px resize threshold) can still be a multi-megabyte PNG: dimensions
 * alone do not bound the request body. So on macOS every raster image is
 * re-encoded to JPEG at a fixed quality, which bounds both at once; it is
 * shrunk only when its long edge is over the cap, never enlarged.
 *
 * WITHOUT `sips` (Windows, Linux) nothing can be re-encoded, so an image goes
 * out as it came when it is already within both caps, and becomes text past
 * either of them.
 *
 * WHEN IT CANNOT BE MADE SAFE (over the caps with no `sips`, a format `sips`
 * cannot decode, an SVG, or a result still over the hard ceiling) the caller
 * gets TEXT naming the problem, never an oversized or mislabelled image block:
 * an image the API is going to reject is worse than no image, because the
 * rejection kills the turn and, unfixed, every turn after it.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { imageShapeFromBuffer, type ImageShape } from "../../services/image-shape";

const execFileAsync = promisify(execFile);

/**
 * Anthropic's own recommendation for the long side of an image: past this it
 * downscales the picture before looking at it anyway, so resizing here loses
 * no information the model would have used, only bytes and tokens on the wire.
 */
export const MAX_IMAGE_EDGE = 1568;

/**
 * NEVER, under any circumstance: even after a resize attempt. `sips -Z` caps
 * the LONG edge, so a very wide, very short image could still have its short
 * edge above a naive check; this is the backstop that refuses regardless of
 * why an edge is still too big. It is also the pixel cap for an image that
 * goes out unresized where there is no `sips`.
 */
export const HARD_IMAGE_EDGE = 2000;

/**
 * The API's ceiling for ONE image, counted on the base64 it receives. Only an
 * image sent without re-encoding (no `sips` on this machine) can come near it.
 */
export const MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024;

/**
 * The caption `read_file` writes beside an image: `"<path> (WxH, image
 * attached)"`. It is what the compaction and the rehydrated history read the
 * path back from once the pixels are gone, so writing and reading it live
 * here, together.
 */
export function imageCaption(path: string, width: number, height: number): string {
  return `${path} (${width}x${height}, image attached)`;
}

/**
 * The path in an `imageCaption`, anchored on the `(WxH, image attached)` tail
 * rather than on the path: real names have spaces (every macOS screenshot,
 * every "ChatGPT Image Aug 15, 2026, 11_25_32 AM.png") and some have their
 * own parentheses. The caption is the first line; a note may follow.
 */
const IMAGE_CAPTION = /^(.+) \(\d+x\d+, image attached\)(?:\n|$)/;

export function pathFromImageCaption(text: string): string | undefined {
  return IMAGE_CAPTION.exec(text)?.[1];
}

/** Quality for the JPEG every raster image is re-encoded to. */
const JPEG_QUALITY = 80;

/**
 * How long one `sips` may run. The largest measured took 209 ms (6000x4000):
 * a run a hundred times longer is stuck, and the turn must not wait on it.
 */
const SIPS_TIMEOUT_MS = 20_000;

/** One image a tool call surfaced, before `normalizeImage` makes it safe to send. */
export interface ToolImage {
  mediaType: string;
  /** The bytes, base64. */
  data: string;
  /**
   * What names the image when it cannot be sent and becomes a text note: its
   * path, or the tool that produced it. Without it the note said "immagine",
   * and the model could not tell which of its reads had failed.
   */
  label: string;
}

export interface NormalizedImage { mediaType: string; data: string }

export type NormalizeOutcome =
  | { kind: "image"; image: NormalizedImage; shape: ImageShape }
  | { kind: "text"; text: string };

const EXT_FOR_FORMAT: Record<NonNullable<ImageShape["format"]>, string> = {
  png: ".png", jpeg: ".jpg", gif: ".gif", webp: ".webp",
};

/**
 * Re-encodes to JPEG, shrinking to `MAX_IMAGE_EDGE` only when the long edge
 * is over it: `sips -Z` scales UP as well, and the rework sent a 64x64 icon
 * out as 1568x1568. `sips` needs real files, not pipes, so the bytes make a
 * short round trip through a temp directory that is always removed.
 *
 * ASYNCHRONOUS, with a timeout. This runs inside the server process on every
 * image, and a `spawnSync` held the event loop for the whole resize: 104 ms
 * on a 1254px Darkroom render, 209 ms on a 6000x4000, during which no socket,
 * timer or other chat moved.
 */
async function recompress(bytes: Buffer, shape: ImageShape): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), "topics-img-"));
  const inPath = join(dir, `in${shape.format ? EXT_FOR_FORMAT[shape.format] : ""}`);
  const outPath = join(dir, "out.jpg");
  const fit = Math.max(shape.width, shape.height) > MAX_IMAGE_EDGE ? ["-Z", String(MAX_IMAGE_EDGE)] : [];
  try {
    await writeFile(inPath, bytes);
    await execFileAsync("/usr/bin/sips", [
      "-s", "format", "jpeg",
      "-s", "formatOptions", String(JPEG_QUALITY),
      ...fit,
      inPath, "--out", outPath,
    ], { timeout: SIPS_TIMEOUT_MS });
    return await readFile(outPath);
  } catch {
    // A non-zero exit, a timeout, or no output file: all mean "not resized".
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort cleanup */ });
  }
}

/** The length of `bytes` once base64-encoded, which is what the API measures. */
function base64Length(bytes: Buffer): number {
  return Math.ceil(bytes.length / 3) * 4;
}

/**
 * Turns raw image bytes into either a safe `image` content block or a text
 * explanation of why it could not become one. `label` is what the model has
 * to work with when the answer is text: the path, or the tool that produced
 * the image. `platform` is only there so the rules for a machine without
 * `sips` can be exercised on any machine.
 */
export async function normalizeImage(
  bytes: Buffer,
  label: string,
  platform: NodeJS.Platform = process.platform,
): Promise<NormalizeOutcome> {
  const shape = imageShapeFromBuffer(bytes);
  if (!shape) {
    return { kind: "text", text: `${label}: formato immagine non riconosciuto (i byte non corrispondono a nessun formato noto)` }; // allow-italian: testo che legge il modello
  }

  // The API decodes png, jpeg, gif and webp only: an `image/svg+xml` block is
  // a 400, and the recovery for it takes every image out of the history. An
  // SVG is text, so the model gets its markup (clipped with the rest of the
  // result by the caller).
  if (shape.vector || !shape.format) {
    return { kind: "text", text: `${label}: SVG ${shape.width}x${shape.height}, che l'API non accetta come immagine; il sorgente:\n${bytes.toString("utf8")}` }; // allow-italian: testo che legge il modello
  }

  if (platform !== "darwin") {
    if (Math.max(shape.width, shape.height) <= HARD_IMAGE_EDGE && base64Length(bytes) <= MAX_IMAGE_BASE64_CHARS) {
      return { kind: "image", image: { mediaType: `image/${shape.format}`, data: bytes.toString("base64") }, shape };
    }
    return { kind: "text", text: `${label}: immagine ${shape.width}x${shape.height} di ${bytes.length} byte, oltre i limiti dell'API (${HARD_IMAGE_EDGE}px, 5 MB); senza macOS (sips) qui non si riduce, non inviata` }; // allow-italian: testo che legge il modello
  }

  const resized = await recompress(bytes, shape);
  if (!resized) {
    return { kind: "text", text: `${label}: immagine non ridimensionabile (sips non è riuscito a convertire questo ${shape.format}), non inviata per evitare un rifiuto dell'API` }; // allow-italian: testo che legge il modello
  }

  const outShape = imageShapeFromBuffer(resized);
  if (!outShape || outShape.width > HARD_IMAGE_EDGE || outShape.height > HARD_IMAGE_EDGE) {
    return { kind: "text", text: `${label}: l'immagine ridimensionata supera comunque il limite di ${HARD_IMAGE_EDGE}px, non inviata` }; // allow-italian: testo che legge il modello
  }
  return { kind: "image", image: { mediaType: "image/jpeg", data: resized.toString("base64") }, shape: outShape };
}
