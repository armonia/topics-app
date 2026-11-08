/**
 * The picture a paused pane shows instead of its page.
 *
 * `browser_screenshot` returns the page at DEVICE resolution as base64 PNG: on a
 * 2x display a 1200x800 slot is a 2400x1600 bitmap, ~15.4 MB decoded, kept for
 * as long as the pane stays paused. The still is drawn once at the slot's CSS
 * size and kept as a JPEG object URL instead: ~3.8 MB decoded, and the base64
 * string is dropped. The page is not being read through it, only recognised.
 */

/** The size the still is drawn at: the slot in CSS pixels, never device pixels. */
export function stillSize(cssWidth: number, cssHeight: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(cssWidth)), height: Math.max(1, Math.round(cssHeight)) };
}

/** An object URL of the still, or null when it cannot be made (no DOM, decode
 *  failure): the paused card then sits on the neutral surface. */
export async function toPausedStill(dataUrl: string, cssWidth: number, cssHeight: number): Promise<string | null> {
  try {
    if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const { width, height } = stillSize(cssWidth, cssHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // Same anchoring as the frozen still (`object-left-top`): the page keeps its
    // top-left corner and the scale follows the width of the slot.
    const scale = width / Math.max(1, img.naturalWidth);
    ctx.drawImage(img, 0, 0, img.naturalWidth * scale, img.naturalHeight * scale);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}
