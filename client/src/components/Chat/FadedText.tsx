import { useRef } from 'react';
import { fadeSegments, useStreamArrivals, type FadeSegment } from '../../lib/streamFade';

/**
 * A plain string that is still being written (a tool command while its input
 * streams in): each piece is its own span, and the ones that just arrived fade
 * in. The segments are recomputed only when the text changes, like the markdown
 * blocks, so an old piece never gets the fade back.
 */
export function FadedText({ text, live }: { text: string; live: boolean }) {
  const { arrivals, now } = useStreamArrivals(text, live);
  const drawn = useRef<{ text: string; segments: FadeSegment[] } | null>(null);
  if (arrivals.length === 0) {
    drawn.current = null;
    return <>{text}</>;
  }
  if (drawn.current?.text !== text) drawn.current = { text, segments: fadeSegments(text, 0, arrivals, now) };
  return (
    <>
      {drawn.current.segments.map((s, i) =>
        s.piece ? <span key={i} className={s.fresh ? 'stream-fade' : undefined}>{s.text}</span> : s.text,
      )}
    </>
  );
}
