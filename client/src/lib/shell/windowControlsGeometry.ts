/**
 * WHERE THE WINDOW COMMANDS LAND, in numbers, so the row can make room for them.
 *
 * On Windows the three commands (close, minimise, maximise) are drawn INSIDE the
 * Topics button, absolutely positioned, and they light up with the Topics menu
 * (`WindowControls.tsx`, which is where the why lives). Absolute means they
 * reserve nothing: the room they need is whatever the word "Topics" happens to
 * measure underneath, and the word is set in the SYSTEM font. On Windows 11 that
 * is Segoe UI, which is narrower than the Mac's: the group ended flush against
 * the chevron, with two or three pixels between them - reported from a Windows
 * build (card 3198947b), "the window buttons sit far too tight to the Topics
 * button".
 *
 * A font is not a layout contract, so the room is DECLARED here instead of being
 * inherited from a glyph width. The label carries a minimum width, always, on
 * both states of the menu: reserving it only while the commands are showing
 * would move the chevron the moment the menu opens, i.e. under the pointer that
 * just clicked it.
 *
 * The arithmetic, in coordinates local to the Topics button wrapper (which is
 * the positioning context of the group, and starts at ROW_INSET from the window
 * edge):
 *
 *     group:   LEFT_PX .. LEFT_PX + CELL_PX * CELLS          =  6 .. 60
 *     label:   BUTTON_PAD_PX .. BUTTON_PAD_PX + width        =  8 .. 8 + width
 *     chevron: BUTTON_PAD_PX + width + LABEL_GAP_PX
 *
 * asking for `chevron >= group end + GAP_PX` gives the minimum width below.
 */

/** One command cell, `h-[18px] w-[18px]` in `WindowControls.tsx`. */
const CELL_PX = 18;
/** Close, minimise, maximise. */
const CELLS = 3;
/** The group's `left-[6px]`, which puts the first cell at x=12 in the window:
 *  the Mac's `trafficLightPosition.x`. */
const LEFT_PX = 6;
/** The Topics button's own left padding (`ROW_PX` = `px-2`). */
const BUTTON_PAD_PX = 8;
/** The button's `gap-1` between the label and the chevron. */
const LABEL_GAP_PX = 4;
/** The breathing room asked for between the two groups: the window commands on
 *  one side, the Topics button's own chevron on the other. Twice ROW_INSET, the
 *  same distance the row keeps from the window edge. */
const GAP_PX = 12;

/**
 * How wide the "Topics" label must be, at least, for the commands not to touch
 * the chevron. 6 + 54 + 12 - 8 - 4 = 60.
 */
export const TOPICS_LABEL_MIN_PX =
  LEFT_PX + CELL_PX * CELLS + GAP_PX - BUTTON_PAD_PX - LABEL_GAP_PX;

/**
 * The same number as a class, written out in full because Tailwind scans the
 * SOURCE: a class assembled at runtime from `TOPICS_LABEL_MIN_PX` would never be
 * generated. The test in `WindowControls.test.tsx` keeps the two in step.
 */
export const TOPICS_LABEL_MIN_W_WINDOWS = 'min-w-[60px]';
