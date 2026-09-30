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
 * plays the same animation with a negative delay, so it continues from the
 * very frame the draft had reached (`useComposerDock`).
 *
 * `claim` and not `peek`: the entry is consumed by reading it. A second mount
 * of the same topic (a tab switch, a reopen) must not find the composer
 * starting its descent again.
 */

/** Past this window the handoff has expired: it is no longer the same gesture. */
const HANDOFF_TTL_MS = 3000;

/**
 * A descent in flight: when it began (document timeline time) and its height,
 * if known. `at` is corrected by the draft once its animation really starts
 * (the next frame after the key): the object is moved, not copied, by the remap.
 */
export type Descent = { at: number; offset: number | null };

/** Keyed by pane id: the draft's until the remap, the topic's after it. */
const descents = new Map<string, Descent>();

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
    descents.set(to, started ?? { at: performance.now(), offset: null });
  });
}

/** The draft `paneId` starts its descent about `at`, from `offset` px above the bottom. */
export function beginDescent(paneId: string, at: number, offset: number): Descent {
  const d = { at, offset };
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
  return performance.now() - d.at < HANDOFF_TTL_MS ? d : null;
}
