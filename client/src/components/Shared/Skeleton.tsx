/** Pulse-animated skeleton placeholder shapes */

// Fixed, varied widths (%) cycled by row index so the placeholder list looks
// staggered without an impure Math.random() call during render.
const SKELETON_WIDTHS = [78, 56, 88, 64, 72, 50, 84, 60];

export function SkeletonTopicList({ count = 5 }: { count?: number }) {
  return (
    <div className="px-2 py-1 space-y-1">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 min-h-[44px] h-11 md:min-h-8 md:h-8 pl-3 pr-2 animate-pulse">
          <div className="w-5 h-5 rounded bg-black/8 dark:bg-white/8 flex-shrink-0" />
          <div
            className="h-3 rounded bg-black/8 dark:bg-white/8"
            // Deterministic per-row width (was Math.random() during render,
            // which is impure and re-rolled every re-render). A fixed cycle of
            // widths keyed on the row index keeps the staggered look while
            // staying pure and stable across re-renders.
            style={{ width: `${SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]}%` }}
          />
        </div>
      ))}
    </div>
  );
}
