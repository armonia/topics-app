/** Pulse-animated skeleton placeholder shapes */

export function SkeletonTopicList({ count = 5 }: { count?: number }) {
  return (
    <div className="px-2 py-1 space-y-1">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 h-8 px-2 animate-pulse">
          <div className="w-5 h-5 rounded bg-black/8 dark:bg-white/8 flex-shrink-0" />
          <div
            className="h-3 rounded bg-black/8 dark:bg-white/8"
            style={{ width: `${50 + Math.random() * 40}%` }}
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
                ? 'bg-[#f5f5f5] dark:bg-[#222]'
                : 'bg-[var(--primary)]/20'
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
