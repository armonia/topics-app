/**
 * When the rest of a chat's history is merged above the reader: only with the list at rest.
 *
 * The merge prepends rows under the reader. Virtuoso keeps them roughly still
 * (`firstItemIndex`, on sizes it has only estimated) and `MessageList` then puts
 * the row being read back to the pixel (`placeRowAt`). Both need a list that is
 * not moving. Page Up, Shift+Space and Home glide over a dozen frames on WebKit,
 * and a merge landing in the middle of that glide was carried on by the browser
 * from the old offset: the rows jumped by thousands of px. A press held on the
 * list (its scrollbar dragged) would have seen the thumb jump under it.
 *
 * So a reader heading into the merge band only WANTS the merge. It happens once
 * nothing has scrolled for `MERGE_REST_MS`, no press is held, the rows are here
 * (staged) and the pane is on screen. Whatever it waits for calls back when it
 * turns (`poke`): the rows landing, the pane shown again. Leaving the band, or
 * the thread becoming whole some other way, drops the wish.
 *
 * Pure on purpose: the clock, the timer and every reading come from the caller.
 */
export const MERGE_REST_MS = 150;

export interface MergeAtRestDeps {
  now(): number;
  /** Runs `fn` after `ms`; returns its cancel. */
  later(fn: () => void, ms: number): () => void;
  /** The thread's completeness: `partial` (rows on their way), `staged` (rows here, held), or whole. */
  state(): string;
  /** The pane has a viewport. */
  visible(): boolean;
  /** The list is close enough to the top of its loaded rows for the merge. */
  inBand(): boolean;
  /** A press is held on the list. */
  pressed(): boolean;
  merge(): void;
}

export interface MergeAtRest {
  /** The reader heads up inside the merge band. */
  want(): void;
  /** A scroll event of the list, whoever caused it. */
  scrolled(): void;
  /** Something the merge waits for has turned. */
  poke(): void;
  dispose(): void;
}

export function mergeAtRest(d: MergeAtRestDeps): MergeAtRest {
  let wanted = false;
  let lastScroll = Number.NEGATIVE_INFINITY;
  let cancel: (() => void) | null = null;
  const arm = (ms: number): void => {
    cancel?.();
    cancel = d.later(attempt, Math.max(0, ms));
  };
  function attempt(): void {
    cancel = null;
    if (!wanted) return;
    const state = d.state();
    if (state !== 'partial' && state !== 'staged') { wanted = false; return; }
    // Hidden: its viewport reads zero, which says nothing about the band. The return pokes.
    if (!d.visible()) return;
    if (!d.inBand()) { wanted = false; return; }
    if (state === 'partial') return; // the rows landing poke
    const quiet = d.now() - lastScroll;
    if (quiet < MERGE_REST_MS) { arm(MERGE_REST_MS - quiet); return; }
    if (d.pressed()) { arm(MERGE_REST_MS); return; }
    wanted = false;
    d.merge();
  }
  return {
    want() {
      wanted = true;
      arm(MERGE_REST_MS - (d.now() - lastScroll));
    },
    scrolled() {
      lastScroll = d.now();
      if (wanted) arm(MERGE_REST_MS);
    },
    poke() {
      if (wanted) arm(0);
    },
    dispose() {
      wanted = false;
      cancel?.();
      cancel = null;
    },
  };
}
