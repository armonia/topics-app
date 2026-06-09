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

export function SkeletonMessageList({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={`flex gap-1.5 ${i % 2 === 0 ? 'justify-start' : 'justify-end'} animate-pulse`}
        >
          <div
            className={`rounded-lg px-3 py-2 max-w-[85%] ${
              i % 2 === 0
                ? 'bg-app-hover'
                : 'bg-primary/20'
            }`}
          >
            <div className="h-3 rounded w-32 mb-1.5 bg-black/10 dark:bg-white/10" />
            <div className="h-3 rounded w-20 bg-black/5 dark:bg-white/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
