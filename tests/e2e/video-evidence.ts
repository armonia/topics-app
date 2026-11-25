/**
 * The viewport and the clip size of the e2e suite, defined once.
 *
 * When `video.size` is left unset, Playwright records the viewport scaled to
 * fit 800x800: the 1280x800 desktop becomes an 800x500 .webm, and the UI text
 * (counters, labels) does not read at that size. So the clip size is set
 * explicitly, to the viewport the project runs at.
 *
 * playwright.config.ts uses these for the top-level `use` and for the projects
 * with their own viewport. Specs that turn video on with `test.use` import
 * VIDEO_ON: a bare `test.use({ video: "on" })` replaces the whole option and
 * drops the size, so it must not be written as a string.
 */

export const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

export type VideoMode = "on" | "retain-on-failure";

/** A recording option whose clip is exactly as wide and tall as the viewport. */
export function videoAt(mode: VideoMode, viewport: { width: number; height: number }) {
  return { mode, size: { width: viewport.width, height: viewport.height } };
}

/** For specs that always record a clip, on the desktop viewport. */
export const VIDEO_ON = videoAt("on", DESKTOP_VIEWPORT);
