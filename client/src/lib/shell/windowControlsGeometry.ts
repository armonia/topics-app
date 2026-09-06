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
 * THE TITLE MOVED OUT FROM UNDER THEM. While «Topics» was a menu, the commands
 * came out ON TOP of the word (and the Mac's traffic lights did the same), so
 * what had to be declared was the word's MINIMUM WIDTH, for the group not to
 * touch the chevron. The title is not a trigger any anymore on the desktop - the
 * whole submenu lives under the user card at the foot of the column - so both
 * sets of commands are permanently visible and the word sits to their RIGHT.
 * What has to be declared is therefore an INSET, and it is the same arithmetic
 * read the other way round.
 *
 * The arithmetic, in coordinates local to the title wrapper (which is the
 * positioning context of the group, and starts at ROW_INSET from the window
 * edge):
 *
 *     group:  LEFT_PX .. LEFT_PX + CELL_PX * CELLS   =  6 .. 60
 *     title:  group end + GAP_PX                     =  72
 *
 * The Mac needs the same number: its three lights are 12px wide with 8px
 * between them, anchored at x=12 in the window, so they end at 64 there, i.e.
 * 58 in these coordinates - inside the 60 the Windows cells occupy. One inset
 * covers both, which is the point: the word starts in the same place on the two
 * systems.
 */

/** One command cell, `h-[18px] w-[18px]` in `WindowControls.tsx`. */
const CELL_PX = 18;
/** Close, minimise, maximise. */
const CELLS = 3;
/** The group's `left-[6px]`, which puts the first cell at x=12 in the window:
 *  the Mac's `trafficLightPosition.x`. */
const LEFT_PX = 6;
/** The breathing room asked for between the commands and the word next to
 *  them. Twice ROW_INSET, the same distance the row keeps from the window
 *  edge. */
const GAP_PX = 12;

/**
 * Where the word «Topics» starts when the window commands are on screen:
 * 6 + 54 + 12 = 72.
 */
export const TITLE_INSET_PX = LEFT_PX + CELL_PX * CELLS + GAP_PX;

/**
 * The same number as a class, written out in full because Tailwind scans the
 * SOURCE: a class assembled at runtime from `TITLE_INSET_PX` would never be
 * generated. The test in `WindowControls.test.tsx` keeps the two in step.
 */
export const TITLE_INSET_WITH_CONTROLS = 'pl-[72px]';
