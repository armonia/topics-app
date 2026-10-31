/**
 * The one monospace stack of the app: chat code and terminal panes both use
 * JetBrains Mono, vendored under client/public/fonts and declared in index.css
 * with `font-display: swap`. The terminal renders with the same family so the
 * scrollback cover and xterm's rows line up.
 */
export const MONO_FONT_FAMILY = "'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace";

/** Terminal font size in px, as passed to xterm. */
export const TERMINAL_FONT_SIZE = 13;

/** Unitless xterm line height: the row is the font size times this. */
export const TERMINAL_LINE_HEIGHT = 1.25;

/** Space between the terminal pane's border and xterm's rows, on all four sides. */
export const TERMINAL_PADDING_PX = 12;
