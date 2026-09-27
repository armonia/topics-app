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
 * alone do not bound the request body. So every raster image is re-encoded to
 * JPEG at a fixed quality, unconditionally, which bounds both at once.
 *
 * WHEN IT CANNOT BE MADE SAFE — `sips` missing (non-darwin), a format `sips`
 * cannot decode, or the result still over the hard ceiling — the caller gets
 * TEXT naming the problem, never an oversized or mislabelled image block: an
 * image the API is going to reject is worse than no image, because the
 * rejection kills the turn and, unfixed, every turn after it.
 */

import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { imageShapeFromBuffer, type ImageShape } from "../../services/image-shape";

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
 * why an edge is still too big.
 */
export const HARD_IMAGE_EDGE = 2000;

/** Quality for the JPEG every raster image is re-encoded to. */
const JPEG_QUALITY = 80;

export interface NormalizedImage { mediaType: string; data: string }

export type NormalizeOutcome =
  | { kind: "image"; image: NormalizedImage; shape: ImageShape }
  | { kind: "text"; text: string };

const EXT_FOR_FORMAT: Record<NonNullable<ImageShape["format"]>, string> = {
  png: ".png", jpeg: ".jpg", gif: ".gif", webp: ".webp",
};

/**
 * Re-encodes to JPEG at `MAX_IMAGE_EDGE`, macOS only. `sips` needs real files,
 * not pipes, so the bytes make a short round trip through a temp directory
 * that is always removed, success or failure.
 */
function recompressBestEffort(bytes: Buffer, format: ImageShape["format"]): Buffer | null {
  if (process.platform !== "darwin") return null;
  const dir = mkdtempSync(join(tmpdir(), "topics-img-"));
  const inPath = join(dir, `in${format ? EXT_FOR_FORMAT[format] : ""}`);
  const outPath = join(dir, "out.jpg");
  try {
    writeFileSync(inPath, bytes);
    const res = spawnSync("/usr/bin/sips", [
      "-s", "format", "jpeg",
      "-s", "formatOptions", String(JPEG_QUALITY),
      "-Z", String(MAX_IMAGE_EDGE),
      inPath, "--out", outPath,
    ], { stdio: "ignore" });
    if (res.status !== 0 || !existsSync(outPath)) return null;
    return readFileSync(outPath);
  } catch {
    return null;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

/**
 * Turns raw image bytes into either a safe `image` content block or a text
 * explanation of why it could not become one. `label` is what the model has
 * to work with when the answer is text — normally the path or a short name.
 */
export function normalizeImage(bytes: Buffer, label: string): NormalizeOutcome {
  const shape = imageShapeFromBuffer(bytes);
  if (!shape) {
    return { kind: "text", text: `${label}: formato immagine non riconosciuto (i byte non corrispondono a nessun formato noto)` }; // allow-italian: testo che legge il modello
  }

  // Un SVG è testo, non un raster: niente sips capace di ridimensionarlo in
  // modo affidabile, e i pesi in gioco sono kilobyte, non megabyte.
  if (shape.vector) {
    return { kind: "image", image: { mediaType: "image/svg+xml", data: bytes.toString("base64") }, shape };
  }

  const resized = recompressBestEffort(bytes, shape.format);
  if (!resized) {
    const why = process.platform !== "darwin"
      ? "richiede macOS (sips)" // allow-italian: testo che legge il modello
      : `sips non è riuscito a ridimensionare questo ${shape.format ?? "formato"}`; // allow-italian: testo che legge il modello
    return { kind: "text", text: `${label}: immagine non ridimensionabile (${why}), non inviata per evitare un rifiuto dell'API` }; // allow-italian: testo che legge il modello
  }

  const outShape = imageShapeFromBuffer(resized);
  if (!outShape || outShape.width > HARD_IMAGE_EDGE || outShape.height > HARD_IMAGE_EDGE) {
    return { kind: "text", text: `${label}: l'immagine ridimensionata supera comunque il limite di ${HARD_IMAGE_EDGE}px, non inviata` }; // allow-italian: testo che legge il modello
  }
  return { kind: "image", image: { mediaType: "image/jpeg", data: resized.toString("base64") }, shape: outShape };
}
