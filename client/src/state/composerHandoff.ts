/**
 * The handoff between a draft and the real chat.
 *
 * The first message of a new chat is not a state update: it is a CHANGE OF
 * PANE. `promoteDraft` creates the topic on the server and remaps the pane id
 * (`draft:<uuid>` -> `<topicId>`), so the draft's ChatPane unmounts and another
 * one is born. For React they are two different components, and the second
 * knows nothing about the first.
 *
 * The motion that matters most there, the composer sliding from the centre to
 * the bottom as the conversation begins, has to cross that remount. It starts
 * in the DRAFT, on Enter: waiting for the topic to exist (the server round trip
 * plus the remount, 100-140 ms measured) left the composer standing still
 * after the key, which reads as lag. The draft records here WHEN the descent
 * began and from how high; the promoted pane claims that once at mount and
 * plays the same animation from that instant, so it continues from the very
 * frame the draft had reached (`useComposerDock`).
 *
 * WHEN is the instant the draft's animation was first PAINTED, never the key:
 * the send keeps the main thread busy for 60-120 ms before the next frame, and
 * the promotion can land inside that window. A promoted pane that took the key
 * as its start painted its first frame already 47-86% down, with the greeting
 * losing up to 0.8 of its opacity in that one frame (verifier, 30/09). Until
 * the draft has painted, `at` is null and the promoted pane starts on its own
 * first frame, from the top.
 *
 * `claim` and not `peek`: the entry is consumed by reading it. A second mount
 * of the same topic (a tab switch, a reopen) must not find the composer
 * starting its descent again.
 */

/** Past this window the handoff has expired: it is no longer the same gesture. */
const HANDOFF_TTL_MS = 3000;

/**
 * A descent in flight: the document-timeline time of its first painted frame
 * (null until the draft has painted one) and its height, if known. `at` is set
 * by the draft when its animation really starts: the object is moved, not
 * copied, by the remap, so a pane promoted afterwards still sees it. `born`
 * (performance clock) only ages the entry.
 */
export type Descent = { at: number | null; offset: number | null; born: number };

/** Keyed by pane id: the draft's until the remap, the topic's after it. */
const descents = new Map<string, Descent>();

/**
 * Topic id -> the draft id it was promoted from. Never shrinks: one entry per
 * first send in this window's life, a few bytes each (and the same below).
 */
const promotedFrom = new Map<string, string>();
/** Draft id -> the topic it became: the reverse of `promotedFrom`. */
const draftPromotedTo = new Map<string, string>();

// Capability, not existence: under bun:test some files install a partial fake
// `window` on globalThis (and do not always remove it), so `typeof window !==
// 'undefined'` can be true while the method about to be called is missing.
// This block runs at IMPORT: a throw here would sink the module for everyone.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('topics:pane-id-remap', (e: Event) => {
    const { from, to } = (e as CustomEvent<{ from?: string; to?: string }>).detail ?? {};
    if (!to) return;
    // A draft promoted without a descent in flight (sent from outside its
    // pane) still lands docked and slides from the centre, starting now.
    const started = from ? descents.get(from) : undefined;
    if (from) descents.delete(from);
    if (from) notePromotion(from, to);
    descents.set(to, started ?? { at: null, offset: null, born: performance.now() });
  });
}

/** The draft `paneId` starts its descent from `offset` px above the bottom; its start time comes with its first frame. */
export function beginDescent(paneId: string, offset: number): Descent {
  const d: Descent = { at: null, offset, born: performance.now() };
  descents.set(paneId, d);
  return d;
}

/** A descent that led nowhere: the draft was not promoted and stays centred. */
export function cancelDescent(paneId: string): void {
  descents.delete(paneId);
}

/**
 * Was this pane just born from a promoted draft? Once only, and only inside
 * {@link HANDOFF_TTL_MS}: when the descent began, and from how high.
 */
export function claimDescent(topicId: string): Descent | null {
  const d = descents.get(topicId);
  if (d === undefined) return null;
  descents.delete(topicId);
  return performance.now() - d.born < HANDOFF_TTL_MS ? d : null;
}

/**
 * Record that `to` is the topic the draft `from` became. `promoteDraft` calls it
 * BEFORE it remaps anything: a render can land between the pane store's remap
 * and the window event (measured, two of them), and a render that saw the new
 * id without its lineage gave the pane a new key, then the old one back: the
 * body parked and put back twice under the user's bubble.
 */
export function notePromotion(from: string, to: string): void {
  promotedFrom.set(to, promotedFrom.get(from) ?? from);
  draftPromotedTo.set(from, to);
}

/** The topic id the draft `draftId` was promoted to, if it was. */
export function promotedTo(draftId: string): string | undefined {
  return draftPromotedTo.get(draftId);
}

/**
 * The identity of the CONVERSATION a pane shows, as opposed to the id of its
 * topic: a topic promoted from a draft keeps the draft's id here. The pane that
 * showed the draft is the pane that shows the topic (its shell key, its list),
 * so the first send renames what is on screen instead of rebuilding it.
 */
export function conversationViewKey(id: string): string {
  return promotedFrom.get(id) ?? id;
}

