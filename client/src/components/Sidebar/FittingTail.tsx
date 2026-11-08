/**
 * THE TAIL THAT GIVES WAY, so the row's name never has to.
 *
 * A sidebar row is glyph, name, tail. When the column narrows (180px, a
 * scrollbar, open projects pushing one in) something must yield, and it has to
 * be the tail: «Auto…» next to a whole «4 da sistemare» hides what the row IS
 * to keep a detail about it. So the name is not shrinkable and the tail picks
 * the longest of its variants that fits the room left: the full sentence, then
 * the short form (usually the bare number), then nothing.
 *
 * The full sentence always stays reachable: it is the tail's title (the
 * pointer) and, when a shorter variant or nothing is painted, a screen-reader
 * text next to it (the painted short form is hidden from assistive tech so
 * the count is not read twice). No `aria-label`: on a role-less span axe
 * flags it.
 *
 * NO FEEDBACK LOOP. The slot is `flex-1 min-w-0` with a zero basis, so its
 * width is the room left after the name and does not depend on what is drawn
 * inside. The variants are measured in zero-size boxes (`scrollWidth` reads
 * their natural width), the same trick `PinnedLabelMeasure` uses.
 */
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface TailVariant {
  /** What is painted. */
  node: ReactNode;
}

export function FittingTail({
  label,
  variants,
  className = '',
  testId,
}: {
  /** The full sentence: title and aria-label, whatever is painted. */
  label: string;
  /** Longest first. The first that fits wins; none fitting paints nothing. */
  variants: readonly TailVariant[];
  className?: string;
  testId?: string;
}) {
  const [slot, setSlot] = useState<number | null>(null);
  const [widths, setWidths] = useState<number[]>([]);
  const measures = useRef<Array<HTMLSpanElement | null>>([]);
  const observer = useRef<ResizeObserver | null>(null);

  // Ref callback rather than an effect: the slot can mount after the first
  // render (the hub answers late) and an effect with empty deps would miss it.
  const slotRef = useCallback((el: HTMLSpanElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setSlot((prev) => (prev !== null && Math.abs(prev - w) < 0.5 ? prev : w));
    });
    ro.observe(el);
    observer.current = ro;
  }, []);

  // Natural widths are re-read when the variants change (a new count, a
  // language switch) and when fonts finish loading, which moves them.
  const key = variants.length + label;
  useLayoutEffect(() => {
    const read = () => setWidths(measures.current.slice(0, variants.length).map((m) => m?.scrollWidth ?? 0));
    read();
    void document.fonts?.ready.then(read);
  }, [key, variants.length]);

  // Before the first measurement the longest variant is shown, as before this
  // component existed: a silent first frame would make the tail flicker in.
  let chosen = slot === null || widths.length < variants.length ? 0 : -1;
  if (chosen === -1) chosen = widths.findIndex((w) => w <= slot! + 0.5);

  // The test id and the title sit on the painted part only, so its text is
  // exactly what the eye reads (the measuring boxes are siblings, not inside).
  const short = chosen > 0;
  return (
    <span ref={slotRef} className={`relative flex min-w-0 flex-1 items-center justify-end overflow-hidden whitespace-nowrap ${className}`}>
      {variants.map((v, i) => (
        <span
          key={i}
          ref={(el) => { measures.current[i] = el; }}
          aria-hidden="true"
          className="pointer-events-none invisible absolute left-0 top-0 h-0 w-0 overflow-hidden whitespace-nowrap"
        >
          {v.node}
        </span>
      ))}
      <span data-testid={testId} data-variant={chosen} title={label}>
        {chosen === 0 ? variants[0]!.node : short ? <span aria-hidden="true">{variants[chosen]!.node}</span> : null}
        {chosen !== 0 && <span className="sr-only">{label}</span>}
      </span>
    </span>
  );
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
