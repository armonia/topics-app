import { useEffect, useState } from 'react';
import type { AreaRef } from './useAreaRect';
import type { ComposerBand } from '../../state/topicBrowserWindow';

/** Where the composer lies inside the area, in px from the area's top.
 *
 *  Measured, never assumed: the composer grows with the text, carries the
 *  queue box and the strips above it, slides on a transform when the
 *  transcript pushes it, and sits in the MIDDLE while the topic is empty.
 *  The floating window keeps off that band, so the send button stays
 *  clickable. Null while there is nothing to measure. */
export function useComposerBand(areaRef: AreaRef): ComposerBand | null {
  const [band, setBand] = useState<ComposerBand | null>(null);
  useEffect(() => {
    const root = areaRef.current;
    if (!root) return;
    let composer: Element | null = null;
    const sizes = new ResizeObserver(() => read());
    // The composer slides with an INLINE transform and changes class when it
    // docks: neither is a resize, and both move its top edge.
    const styles = new MutationObserver(() => read());
    // The composer is a direct child of the pane root: watching the root's own
    // child list catches it appearing, without walking the transcript.
    const mounts = new MutationObserver(() => read());
    const areaSize = new ResizeObserver(() => read());

    function read(): void {
      // Re-read the ref: an observer can fire in the same frame the pane
      // unmounts, and then there is no area left to measure against.
      const host = areaRef.current;
      if (!host) return;
      const next = host.querySelector('[data-testid="chat-input-area"]');
      if (next !== composer) {
        sizes.disconnect();
        styles.disconnect();
        composer = next;
        if (composer) {
          sizes.observe(composer);
          styles.observe(composer, { attributes: true, attributeFilter: ['style', 'class'] });
        }
      }
      const box = (composer?.querySelector('form') ?? composer)?.getBoundingClientRect();
      const bounds = host.getBoundingClientRect();
      setBand(
        box && box.height > 0
          ? {
              top: Math.max(0, Math.round(box.top - bounds.top)),
              bottom: Math.max(0, Math.round(box.bottom - bounds.top)),
              centered: composer?.getAttribute('data-composer-centered') === 'true',
            }
          : null,
      );
    }

    read();
    mounts.observe(root, { childList: true });
    areaSize.observe(root);
    window.addEventListener('resize', read);
    return () => {
      sizes.disconnect();
      styles.disconnect();
      mounts.disconnect();
      areaSize.disconnect();
      window.removeEventListener('resize', read);
    };
  }, [areaRef]);
  return band;
}
