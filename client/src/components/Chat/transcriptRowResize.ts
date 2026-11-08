/**
 * A ROW THAT CHANGES ITS OWN HEIGHT TELLS THE TRANSCRIPT.
 *
 * A tool row's body opens and closes on its own (the live preview of a running
 * tool, CHAT-TOOL-03) or on a click. That is local state of the row, so no
 * commit of the message list sees it, and in a chat pinned to its bottom every
 * change of height moves the whole conversation. Measured in the UI audit of
 * 2026-09-29: a running tool's body +35/+34 px on open and -70 px on close,
 * each in one frame (core:F02); a click on a finished row near the bottom, the
 * body below the fold and then the whole column -266 px a frame later, pinned
 * by Virtuoso's own "size increased" scroll (core:F09).
 *
 * The body now animates its height (`ToolCallRow`, `MOTION.base`), and the row
 * calls this in the layout phase of the change with the animation's length.
 * The list pins in that same frame and keeps pinning, frame by frame, until
 * the animation is over, so the conversation travels with the body instead of
 * jumping after it.
 *
 * WHY HEIGHT AND NOT A TRANSFORM. The house rule is to animate transform and
 * opacity only, and a transform was tried first: the content, re-pinned at
 * once, was drawn back where it had been and slid into place. A downward
 * translate of the scroller's content enlarges its scrollable overflow
 * (measured: scrollHeight 3198 -> 3802 for a 302 px body), so every pin, the
 * browser's clamp and Virtuoso's "at bottom" read a bottom that was not there,
 * and the row jumped back 240 px mid-slide. A height animation keeps every
 * geometry true on every frame, and it lasts one row for 240 ms.
 *
 * `null` outside a transcript (a row rendered elsewhere): nothing to tell.
 */
import { createContext } from 'react';

export const TranscriptRowResizeContext = createContext<((durationMs: number) => void) | null>(null);

/** Past the end of the height animation, how long its growth is still followed:
 *  the last frame lands a little after the nominal duration on a loaded machine. */
export const ROW_RESIZE_SLACK_MS = 120;
