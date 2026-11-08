import { fadeSegments, useStreamArrivals } from '../../lib/streamFade';

/**
 * A plain string that is still being written (a tool command while its input
 * streams in): each piece is its own span, and the ones that just arrived fade
 * in. Recomputed on every render, so a piece that has aged loses the fade class
 * on the same node and never gets it back.
 */
export function FadedText({ text, live }: { text: string; live: boolean }) {
  const { arrivals, now } = useStreamArrivals(text, live);
  if (arrivals.length === 0) return <>{text}</>;
  return (
    <>
      {fadeSegments(text, 0, arrivals, now).map((s, i) =>
        s.piece ? <span key={i} className={s.fresh ? 'stream-fade' : undefined}>{s.text}</span> : s.text,
      )}
    </>
  );
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
