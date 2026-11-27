/**
 * A sidebar row that is ARCHIVED leaves the column visibly, instead of
 * vanishing in one frame (26/11, the owner: "when I archive a tab there is still
 * no animation at all").
 *
 * Archiving already counts down like a close (the fill and the ring, 1.5 s).
 * What was missing is the end: at the commit the data changes, React unmounts
 * the row in the same frame, and `useSidebarRowFlip` slides the rows below up
 * into a gap that opened with no transition. Closing has no such end because a
 * closed row stays; an archived one goes, and going is the part to show.
 *
 * How: just before the commit that archives a row, `markRowLeaving` takes an
 * inert copy of the row (`cloneNode`, every handle a test or a screen reader
 * could find stripped) and its place in the column. After the commit, the
 * FLIP pass of the column calls `playLeftRows`: a marked row whose node is gone
 * from the column, and has not come back elsewhere in it, gets its copy laid
 * where it was, out of flow, sliding left and fading over `ROW_EXIT_MS`; the
 * rows below hold still for that time and then close the gap. TWO STEPS, as a
 * native list deletes a row: closing the gap DURING the fade slid the next row
 * under the fading copy, and for a few frames the two names overprinted each
 * other (filmed 27/11). A row that does not leave (shown archived, pinned) is
 * never played: its mark expires.
 *
 * Only an archive marks a row. A row leaving for any other reason (a group
 * collapsing, a filter, another device) keeps the column's usual behaviour.
 * Under prefers-reduced-motion nothing is marked, so nothing moves.
 *
 * The rows carry the key they leave under in `data-row-exit`: `topic:<id>` for
 * a chat, the pane id for every other kind (`terminal:…`, `browser:…`,
 * `project:…`, a utility page's id).
 */
import { animateEl, EASE, MOTION } from './motion';
import { prefersReducedMotion } from './reducedMotion';

/** The attribute a row carries with the key it leaves under. */
export const ROW_EXIT_ATTR = 'data-row-exit';
/** The attribute on a playing copy, so a test can find it. */
export const ROW_GHOST_ATTR = 'data-row-ghost';
/** How long a mark waits for its row to leave before it is dropped. */
const MARK_TTL_MS = 3000;
/** How far left the copy travels as it fades. */
const EXIT_SHIFT_PX = 16;
/** How long the copy takes to leave; the rows below start moving after it. */
export const ROW_EXIT_MS = MOTION.fast;

interface Mark {
  key: string;
  node: HTMLElement;
  column: HTMLElement;
  rect: DOMRect;
  copy: HTMLElement;
  at: number;
}

let marks: Mark[] = [];

/** The key of a chat row. */
export function topicRowExitKey(topicId: string): string {
  return `topic:${topicId}`;
}

/** Strips from a copy everything that would make it findable or focusable. */
function makeInert(copy: HTMLElement): void {
  const all = [copy, ...Array.from(copy.querySelectorAll<HTMLElement>('*'))];
  for (const el of all) {
    for (const name of Array.from(el.getAttributeNames())) {
      if (name === 'id' || name === 'role' || name === 'tabindex' || name === 'title'
        || name === ROW_EXIT_ATTR || name.startsWith('aria-') || name.startsWith('data-testid')
        || name === 'data-order-id' || name === 'data-sidebar-flip') {
        el.removeAttribute(name);
      }
    }
  }
  copy.setAttribute('aria-hidden', 'true');
  copy.setAttribute('inert', '');
  copy.setAttribute(ROW_GHOST_ATTR, '');
}

/**
 * Call just before the commit that archives the row(s) under `key`: records an
 * inert copy of each and where it stands. No-op under reduced motion.
 */
export function markRowLeaving(key: string): void {
  if (typeof document === 'undefined' || prefersReducedMotion()) return;
  const now = performance.now();
  marks = marks.filter((m) => now - m.at < MARK_TTL_MS);
  const selector = `[${ROW_EXIT_ATTR}="${CSS.escape(key)}"]`;
  for (const node of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    const column = node.closest<HTMLElement>('.sidebar-column');
    if (!column) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const copy = node.cloneNode(true) as HTMLElement;
    makeInert(copy);
    marks.push({ key, node, column, rect, copy, at: now });
  }
}

/**
 * Plays the exit of every marked row of `column` that has left it. Called
 * after each commit of the column, before its rows move: true when an exit
 * started, so the moves wait `ROW_EXIT_MS` for it.
 */
export function playLeftRows(column: HTMLElement): boolean {
  if (marks.length === 0) return false;
  const now = performance.now();
  const keep: Mark[] = [];
  let played = false;
  for (const m of marks) {
    if (m.column !== column) { if (now - m.at < MARK_TTL_MS) keep.push(m); continue; }
    if (m.node.isConnected && column.contains(m.node)) {
      // Not left yet (or not leaving at all): wait, or let the mark expire.
      if (now - m.at < MARK_TTL_MS) keep.push(m);
      continue;
    }
    // Gone, but back elsewhere in the column (it moved to another group):
    // that is a move, which the column's FLIP shows as an appearance.
    if (column.querySelector(`[${ROW_EXIT_ATTR}="${CSS.escape(m.key)}"]`)) continue;
    played = play(m) || played;
  }
  marks = keep;
  return played;
}

function play(m: Mark): boolean {
  const { copy, column, rect } = m;
  copy.style.position = 'absolute';
  copy.style.margin = '0';
  copy.style.boxSizing = 'border-box';
  copy.style.width = `${rect.width}px`;
  copy.style.height = `${rect.height}px`;
  copy.style.pointerEvents = 'none';
  copy.style.top = '0px';
  copy.style.left = '0px';
  column.appendChild(copy);
  // Out of flow, the copy sits in its containing block: the column if it is
  // positioned, an ancestor otherwise. Its place is the row's, from there.
  const parent = (copy.offsetParent as HTMLElement | null) ?? document.body;
  const box = parent.getBoundingClientRect();
  const scrolls = parent === column;
  copy.style.top = `${rect.top - box.top - parent.clientTop + (scrolls ? column.scrollTop : 0)}px`;
  copy.style.left = `${rect.left - box.left - parent.clientLeft + (scrolls ? column.scrollLeft : 0)}px`;
  const a = animateEl(
    copy,
    [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: `translateX(-${EXIT_SHIFT_PX}px)` },
    ],
    { duration: ROW_EXIT_MS, easing: EASE.exit, fill: 'forwards' },
  );
  if (!a) { copy.remove(); return false; }
  const done = () => copy.remove();
  a.finished.then(done, done);
  return true;
}

/** Test seam: forget every pending mark. */
export function __resetRowExitForTests(): void {
  marks = [];
}
