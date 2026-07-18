/**
 * Pure coordinate mapping for the web streaming browser pane. Extracted from
 * useRemoteBrowser so it can be unit-tested without the React/WS runtime.
 *
 * Translates a click on the displayed screenshot <img> back to the page's CSS-px
 * coordinate space that the server's page.mouse.* expects.
 */
import type React from 'react';

// Fallback viewport used only when the <img> has no natural size yet.
export const VIEWPORT_WIDTH = 1280;
export const VIEWPORT_HEIGHT = 720;

/** Metadata needed to map a display click to page CSS-px coordinates. */
export interface CoordMeta {
  pageScaleFactor?: number;
  /** CDP frame `deviceWidth`/`deviceHeight` — CSS px (DIP), DPR-independent. */
  deviceWidth?: number;
  deviceHeight?: number;
  /** This client's DPR, used only for the metadata-absent fallback basis. */
  deviceScaleFactor?: number;
}

export function mapCoordinates(
  e: React.MouseEvent<HTMLImageElement>,
  img: HTMLImageElement,
  meta: CoordMeta = {},
): { x: number; y: number } | null {
  const rect = img.getBoundingClientRect();
  const naturalW = img.naturalWidth || VIEWPORT_WIDTH;
  const naturalH = img.naturalHeight || VIEWPORT_HEIGHT;
  // Letterbox math uses the ACTUAL image pixels (naturalW/H) — at HiDPI the
  // frame is deviceW×dsf but its aspect ratio is unchanged, so this is correct.
  const imgAspect = naturalW / naturalH;
  const containerAspect = rect.width / rect.height;

  let displayW: number, displayH: number, offsetX: number, offsetY: number;

  if (containerAspect > imgAspect) {
    displayH = rect.height;
    displayW = displayH * imgAspect;
    offsetX = (rect.width - displayW) / 2;
    offsetY = 0;
  } else {
    displayW = rect.width;
    displayH = displayW / imgAspect;
    offsetX = 0;
    offsetY = (rect.height - displayH) / 2;
  }

  const localX = e.clientX - rect.left - offsetX;
  const localY = e.clientY - rect.top - offsetY;

  if (localX < 0 || localX > displayW || localY < 0 || localY > displayH) {
    return null;
  }

  // CRITICAL (HiDPI): the coordinate basis must be CSS px, NOT the frame's pixel
  // dimensions. At DPR>1 naturalW = deviceWidth×dsf, so mapping against naturalW
  // would return ~dsf× the intended x and every click would land off-target
  // (pageScaleFactor is the pinch-zoom factor, ≈1 headless — it does NOT undo
  // this). deviceWidth/Height from CDP frame metadata are DPR-independent CSS px
  // → use them. When absent (mock frames in tests), fall back to naturalW÷dsf
  // (÷1 = the legacy behaviour, which keeps the existing streaming tests green).
  const dsf = meta.deviceScaleFactor || 1;
  const basisW = meta.deviceWidth ?? (naturalW / dsf);
  const basisH = meta.deviceHeight ?? (naturalH / dsf);
  const scale = meta.pageScaleFactor || 1;
  return {
    x: Math.round(((localX / displayW) * basisW) / scale),
    y: Math.round(((localY / displayH) * basisH) / scale),
  };
}
