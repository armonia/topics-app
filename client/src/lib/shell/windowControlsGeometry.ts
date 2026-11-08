/**
 * WHERE THE WINDOW COMMANDS LAND, in numbers, so the row can make room for them.
 *
 * On Windows the three commands (close, minimise, maximise) are drawn INSIDE the
 * Topics title wrapper, absolutely positioned (`WindowControls.tsx`, which is
 * where the why lives). On the Mac the three traffic lights are NATIVE: AppKit
 * draws them over the webview, and the Tauri shell pins their frames. Absolute
 * and native both mean the same thing for layout: they reserve nothing, so the
 * room they need has to be DECLARED here. A system font is not a layout
 * contract: on Windows 11 (Segoe UI) the word measured narrower and the group
 * ended flush against the chevron, two or three pixels apart (card 3198947b).
 *
 * The title is not a trigger any more on the desktop, so both sets of commands
 * are permanently visible and the word sits to their RIGHT. What is declared is
 * therefore an INSET on the title wrapper, one per system, because the two
 * clusters are not the same width and the Windows cells are hit targets that
 * must not shrink to match the Mac's dots.
 *
 * ONE SOURCE OF NUMBERS. Every figure below is derived from the few that
 * describe the clusters; nothing is repeated as a literal. The Rust side has
 * the same two numbers for the Mac (`LEFT_INSET` and `PITCH` in
 * `desktop-tauri/src-tauri/src/lib.rs`, `apply_traffic_lights`): if one moves,
 * the other must move with it, and the test in `WindowControls.test.tsx` pins
 * the arithmetic so the class and the number cannot drift apart.
 *
 * The arithmetic, in coordinates local to the title wrapper (which is the
 * positioning context of the group and starts at ROW_INSET from the window
 * edge):
 *
 *     mac:      lights at window x=12, 52 wide, then one ROW_INSET of air
 *               12 + 52 - ROW_INSET + ROW_INSET   =  64
 *     windows:  cells at `left-[6px]`, 3 x 18 with 4 of air between them,
 *               then one ROW_INSET of air
 *               6 + 54 + 8 + ROW_INSET            =  74
 *
 * The air between the commands and the word is ROW_INSET on purpose: it is the
 * same step the search and add pair keeps at the other end of the row, so the
 * chrome row has one rhythm from edge to edge.
 */
import { ROW_INSET } from '../selectionStyles';

/** One macOS traffic light, a circle 12px across. */
export const TRAFFIC_LIGHT_DOT_PX = 12;
/** The air between two lights on macOS. */
export const TRAFFIC_LIGHT_GAP_PX = 8;
/** Close, minimise, maximise. */
const CONTROLS = 3;
/** The whole cluster of three lights: 3 x 12 + 2 x 8 = 52. */
export const TRAFFIC_LIGHTS_WIDTH_PX =
  TRAFFIC_LIGHT_DOT_PX * CONTROLS + TRAFFIC_LIGHT_GAP_PX * (CONTROLS - 1);
/**
 * Where the first light starts, in WINDOW coordinates. This mirrors the Rust
 * constant `LEFT_INSET` in `desktop-tauri/src-tauri/src/lib.rs`
 * (`apply_traffic_lights`): the shell pins the close button there, and the
 * client has no way to read it back, so the number is repeated on purpose and
 * this comment is the only link between the two.
 */
export const WINDOW_CONTROLS_INSET_PX = 12;
/** The air between the commands and the word next to them: the row's own step. */
const GAP_PX = ROW_INSET;

/** One Windows command cell, `h-[18px] w-[18px]` in `WindowControls.tsx`. */
const CELL_PX = 18;
/**
 * THE AIR BETWEEN TWO WINDOWS CELLS, and it used to be zero.
 *
 * At rest that reads fine: the ink is a 10px glyph inside an 18px cell, so two
 * glyphs sit 8px apart, the same air the Mac keeps between two dots. The cell is
 * not only ink, though: it is a hit target that FILLS with colour on hover, and
 * three 18px rectangles with nothing between them stop being three buttons the
 * moment one lights up. That is what was reported from a Windows build
 * (card 6df97deb): the commands are not spaced.
 *
 * 4px is the air, not more: the cluster grows from 54 to 62 and the word next to
 * it moves by eight pixels, which keeps this group roughly the size of the Mac's
 * (52) instead of drifting towards the Windows 11 caption bar, whose three cells
 * are 46 wide each and would be a 138px slab over the row.
 */
export const WINDOW_CONTROL_CELL_GAP_PX = 4;
/** The Windows group's `left-[6px]`, which puts the first cell at
 *  WINDOW_CONTROLS_INSET_PX in the window: the Mac's anchor. */
const LEFT_PX = WINDOW_CONTROLS_INSET_PX - ROW_INSET;

/**
 * Where the word «Topics» starts on the Mac, in wrapper coordinates:
 * the cluster ends at 12 + 52 = 64 in the window, i.e. 58 here, plus GAP_PX.
 * 12 + 52 - 6 + 6 = 64.
 */
export const TITLE_INSET_MAC_PX =
  WINDOW_CONTROLS_INSET_PX + TRAFFIC_LIGHTS_WIDTH_PX - ROW_INSET + GAP_PX;

/**
 * Where the word «Topics» starts on Windows, in wrapper coordinates:
 * 6 + 18 x 3 + 4 x 2 + 6 = 74. The cells stay 18px: they are hit targets.
 */
export const TITLE_INSET_WINDOWS_PX =
  LEFT_PX + CELL_PX * CONTROLS + WINDOW_CONTROL_CELL_GAP_PX * (CONTROLS - 1) + GAP_PX;

/**
 * The same numbers as classes, written out in full because Tailwind scans the
 * SOURCE: a class assembled at runtime from the constants would never be
 * generated. The test in `WindowControls.test.tsx` keeps each pair in step.
 */
export const TITLE_INSET_WITH_CONTROLS_MAC = 'pl-[64px]';
export const TITLE_INSET_WITH_CONTROLS_WINDOWS = 'pl-[74px]';

/**
 * THE ROOM THE CONTENT KEEPS WHEN THE SIDEBAR IS AWAY, on the Mac only.
 *
 * With the sidebar collapsed the content's top bar becomes the window's top
 * edge, and the native lights stay where they are: over its first 64 pixels.
 * The bar therefore reserves the lights plus one ROW_INSET of air, in WINDOW
 * coordinates this time: 12 + 52 + 6 = 70. The same air the title keeps on the
 * other side of the same lights, so the word and the tab strip start the same
 * distance from the cluster whichever of the two is under it.
 */
export const CONTENT_CHROME_INSET_PX =
  WINDOW_CONTROLS_INSET_PX + TRAFFIC_LIGHTS_WIDTH_PX + ROW_INSET;

/**
 * The custom property that carries CONTENT_CHROME_INSET_PX from the root of the
 * content (`#main-content`, App.tsx, which knows whether the sidebar is
 * collapsed) to the one top bar that consumes it (the chrome row that owns the
 * sidebar toggle, StandaloneChatGroup.tsx) and to the floating toggle shown
 * when no pane is open. The transition that eases it lives in `index.css`
 * (`.content-chrome-inset`), next to `.sidebar-transition`, because the two
 * must run on the same clock.
 */
export const CONTENT_CHROME_INSET_PROPERTY = '--content-chrome-inset';
