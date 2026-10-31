/**
 * The one monospace stack for chat code and the terminal. JetBrains Mono is
 * bundled (index.css, @font-face, font-display: swap); the rest is only the
 * fallback while it loads or if the file is missing.
 */
export const TERMINAL_FONT_FAMILY = "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace";

/** Inner gap between the terminal edge and its text, in px. */
export const TERMINAL_PADDING_PX = 12;

/**
 * xterm `lineHeight` multiplies the font's own cell (about 1.32 em for JetBrains
 * Mono), so 1 gives the nearest row to a 1.25 CSS leading at 13 px: 17 px rows
 * against 16.25 px. 1.25 here would give 21 px rows.
 */
export const TERMINAL_LINE_HEIGHT = 1;
