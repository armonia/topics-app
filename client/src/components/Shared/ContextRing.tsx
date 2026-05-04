/**
 * Mini context ring SVG used to indicate context budget consumption.
 * Reused across PaneTabBar tabs and the ChatInput action bar so the same
 * visual semantics (blue → amber → red) apply everywhere.
 */
interface ContextRingProps {
  percent: number;
  onClick?: () => void;
  size?: number;
}

export function ContextRing({ percent, onClick, size = 14 }: ContextRingProps) {
  const r = (size / 14) * 5;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (percent / 100) * circumference;
  const isCritical = percent > 90;
  const isWarning = percent > 70;
  const color = isCritical ? '#ef4444' : isWarning ? '#f59e0b' : '#3b82f6';
  const bgColor = isCritical
    ? 'rgba(239,68,68,0.2)'
    : isWarning
      ? 'rgba(245,158,11,0.2)'
      : 'rgba(59,130,246,0.2)';

  return (
    <svg
      width={size}
      height={size}
      className={`flex-shrink-0 ${onClick ? 'cursor-pointer hover:opacity-80' : ''}`}
      viewBox={`0 0 ${size} ${size}`}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      aria-label="Context Inspector"
      data-testid="context-ring"
    >
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={bgColor} strokeWidth="2" />
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${cx} ${cy})`}
        className="transition-all duration-300"
      />
    </svg>
  );
}
