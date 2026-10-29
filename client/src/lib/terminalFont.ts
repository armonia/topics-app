/**
 * The one monospace stack for chat code and the terminal. JetBrains Mono is
 * bundled (index.css, @font-face, font-display: swap); the rest is only the
 * fallback while it loads or if the file is missing.
 */
export const TERMINAL_FONT_FAMILY = "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace";

/** Inner gap between the terminal edge and its text, in px. */
export const TERMINAL_PADDING_PX = 12;

/** Line height as a multiple of the font size. */
export const TERMINAL_LINE_HEIGHT = 1.25;
