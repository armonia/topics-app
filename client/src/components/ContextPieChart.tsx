import { useState, useEffect, useCallback, useRef } from 'react';
import { PieChart, AlertCircle, Info } from 'lucide-react';

interface ContextUsage {
  total: number;
  limit: number;
  breakdown: {
    label: string;
    tokens: number;
    color: string;
    description?: string;
  }[];
}

interface ContextPieChartProps {
  sessionKey: string;
  compact?: boolean;
}

const COLORS = [
  '#3b82f6', // blue - system/instructions
  '#22c55e', // green - assistant
  '#f59e0b', // amber - user
  '#8b5cf6', // purple - tools
  '#ef4444', // red - context files
  '#06b6d4', // cyan - memory
  '#ec4899', // pink - other
];

export function ContextPieChart({ sessionKey, compact = false }: ContextPieChartProps) {
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  const [hoveredSegment, setHoveredSegment] = useState<number | null>(null);
  const [showTooltip, setShowTooltip] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchContext = useCallback(async () => {
    try {
      const resp = await fetch(`/api/context?sessionKey=${encodeURIComponent(sessionKey)}`);
      if (resp.ok) {
        const data = await resp.json();
        setUsage(data);
      }
    } catch {
      // Silently ignore - chart will just not render
    }
  }, [sessionKey]);

  useEffect(() => {
    fetchContext();
    // Refresh every 30 seconds
    const interval = setInterval(fetchContext, 30000);
    return () => clearInterval(interval);
  }, [fetchContext]);

  if (!usage) return null;
  if (usage.total === 0 && usage.breakdown.length === 0) return null;

  const percentage = Math.round((usage.total / usage.limit) * 100);
  const isWarning = percentage > 70;
  const isCritical = percentage > 90;

  // Calculate pie chart segments
  const total = usage.breakdown.reduce((sum, b) => sum + b.tokens, 0);
  let startAngle = -90; // Start from top

  const segments = usage.breakdown.map((item, i) => {
    const angle = total > 0 ? (item.tokens / total) * 360 : 0;
    const endAngle = startAngle + angle;
    
    // Calculate SVG arc path
    const start = polarToCartesian(50, 50, 40, startAngle);
    const end = polarToCartesian(50, 50, 40, endAngle);
    const largeArc = angle > 180 ? 1 : 0;
    
    const path = [
      `M 50 50`,
      `L ${start.x} ${start.y}`,
      `A 40 40 0 ${largeArc} 1 ${end.x} ${end.y}`,
      `Z`
    ].join(' ');

    const segment = {
      ...item,
      path,
      startAngle,
      endAngle,
      color: item.color || COLORS[i % COLORS.length],
    };
    
    startAngle = endAngle;
    return segment;
  });

  function polarToCartesian(cx: number, cy: number, r: number, angle: number) {
    const rad = (angle * Math.PI) / 180;
    return {
      x: cx + r * Math.cos(rad),
      y: cy + r * Math.sin(rad),
    };
  }

  const formatTokens = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toString();
  };

  if (compact) {
    // Compact mode: ring indicator with percentage arc
    const ringRadius = 12;
    const strokeWidth = 3;
    const circumference = 2 * Math.PI * ringRadius;
    const strokeDashoffset = circumference - (percentage / 100) * circumference;
    const ringColor = isCritical ? '#ef4444' : isWarning ? '#f59e0b' : '#3b82f6';
    const bgColor = isCritical ? 'rgba(239,68,68,0.2)' : isWarning ? 'rgba(245,158,11,0.2)' : 'rgba(59,130,246,0.2)';
    
    return (
      <div 
        ref={containerRef}
        className="relative group cursor-pointer app-no-drag"
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => { setShowTooltip(false); setHoveredSegment(null); }}
      >
        <svg width="28" height="28" className="transform -rotate-90">
          {/* Background ring */}
          <circle
            cx="14"
            cy="14"
            r={ringRadius}
            fill="none"
            stroke={bgColor}
            strokeWidth={strokeWidth}
          />
          {/* Progress ring */}
          <circle
            cx="14"
            cy="14"
            r={ringRadius}
            fill="none"
            stroke={ringColor}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            className="transition-all duration-300"
          />
        </svg>
        {/* Percentage text */}
        <span 
          className={`absolute inset-0 flex items-center justify-center text-[8px] font-semibold leading-none
            ${isCritical ? 'text-red-500' : isWarning ? 'text-amber-500' : 'text-blue-500'}`}
        >
          {percentage}%
        </span>

        {/* Tooltip - positioned below to avoid header overlap */}
        {showTooltip && (
          <div 
            className="fixed z-[100] bg-surface border border-app-border rounded-lg shadow-xl p-3 min-w-[220px]"
            style={{ 
              left: Math.min(containerRef.current?.getBoundingClientRect().left ?? 0, window.innerWidth - 240),
              top: (containerRef.current?.getBoundingClientRect().bottom ?? 0) + 8,
            }}
          >
            <div className="text-[11px] font-medium mb-2 text-app-text">
              Context: {formatTokens(usage.total)} / {formatTokens(usage.limit)} tokens
            </div>
            <svg viewBox="0 0 100 100" className="w-20 h-20 mx-auto mb-2">
              {/* Background ring (remaining capacity) */}
              <circle
                cx="50"
                cy="50"
                r="40"
                fill="none"
                stroke="rgba(128,128,128,0.15)"
                strokeWidth="8"
              />
              {/* Segmented donut - each category has its own color */}
              {segments.map((seg, i) => {
                const segmentPercent = seg.tokens / usage.limit; // Relative to total limit
                const circumference = 2 * Math.PI * 40;
                const segmentLength = circumference * segmentPercent;
                
                // Calculate offset: sum of all previous segments
                const previousTokens = segments.slice(0, i).reduce((sum, s) => sum + s.tokens, 0);
                const offsetPercent = previousTokens / usage.limit;
                // Note: offset is calculated from circumference and used in strokeDashoffset below
                
                return (
                  <circle
                    key={i}
                    cx="50"
                    cy="50"
                    r="40"
                    fill="none"
                    stroke={seg.color}
                    strokeWidth="8"
                    strokeDasharray={`${segmentLength} ${circumference - segmentLength}`}
                    strokeDashoffset={circumference * 0.25 - circumference * offsetPercent}
                    className={`transition-all duration-300 ${hoveredSegment === i ? 'opacity-100' : 'opacity-80'}`}
                    style={{ filter: hoveredSegment === i ? 'brightness(1.1)' : undefined }}
                  />
                );
              })}
              {/* Center text */}
              <text x="50" y="55" textAnchor="middle" className="text-[16px] font-bold fill-app-text">
                {percentage}%
              </text>
            </svg>
            <div className="space-y-1">
              {segments.map((seg, i) => {
                const segPercent = usage.total > 0 ? Math.round((seg.tokens / usage.total) * 100) : 0;
                return (
                  <div 
                    key={i} 
                    className={`flex items-center gap-2 text-[10px] text-app-text ${hoveredSegment === i ? 'font-medium' : ''}`}
                    onMouseEnter={() => setHoveredSegment(i)}
                    onMouseLeave={() => setHoveredSegment(null)}
                  >
                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: seg.color }} />
                    <span className="flex-1 truncate">{seg.label}</span>
                    <span className="text-app-text-secondary">{segPercent}%</span>
                    <span className="text-app-text-muted w-12 text-right">{formatTokens(seg.tokens)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Full mode: larger pie chart with legend
  return (
    <div 
      ref={containerRef}
      className="p-3 border border-app-border rounded-lg bg-elevated"
      onMouseMove={handleMouseMove}
    >
      <div className="flex items-center gap-2 mb-2">
        <PieChart size={14} className={isCritical ? 'text-red-500' : isWarning ? 'text-amber-500' : 'text-blue-500'} />
        <span className="text-[12px] font-medium">Context</span>
        <span className={`text-[11px] ml-auto ${isCritical ? 'text-red-500' : isWarning ? 'text-amber-500' : 'text-app-text-muted'}`}>
          {formatTokens(usage.total)} / {formatTokens(usage.limit)}
        </span>
      </div>

      <div className="flex items-center gap-4">
        {/* Pie chart */}
        <svg viewBox="0 0 100 100" className="w-20 h-20 flex-shrink-0">
          {segments.map((seg, i) => (
            <path
              key={i}
              d={seg.path}
              fill={seg.color}
              className="transition-all cursor-pointer"
              opacity={hoveredSegment === null || hoveredSegment === i ? 1 : 0.4}
              onMouseEnter={() => setHoveredSegment(i)}
              onMouseLeave={() => setHoveredSegment(null)}
            />
          ))}
          {/* Center circle with percentage */}
          <circle cx="50" cy="50" r="22" fill="white" className="dark:fill-surface" />
          <text x="50" y="54" textAnchor="middle" className="text-[12px] font-bold fill-current">
            {percentage}%
          </text>
        </svg>

        {/* Legend */}
        <div className="flex-1 space-y-1 min-w-0">
          {segments.map((seg, i) => (
            <div 
              key={i}
              className={`flex items-center gap-2 text-[10px] cursor-pointer rounded px-1 py-0.5 transition-colors
                ${hoveredSegment === i ? 'bg-app-hover' : ''}`}
              onMouseEnter={() => setHoveredSegment(i)}
              onMouseLeave={() => setHoveredSegment(null)}
            >
              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: seg.color }} />
              <span className="flex-1 truncate">{seg.label}</span>
              <span className="text-app-text-muted flex-shrink-0">{formatTokens(seg.tokens)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Warning message */}
      {isCritical && (
        <div className="mt-2 flex items-center gap-1.5 text-[10px] text-red-500">
          <AlertCircle size={12} />
          Context almost full! Consider starting a new topic.
        </div>
      )}

      {/* Hovered segment detail */}
      {hoveredSegment !== null && segments[hoveredSegment]?.description && (
        <div className="mt-2 text-[10px] text-app-text-secondary bg-surface rounded p-2">
          <Info size={10} className="inline mr-1" />
          {segments[hoveredSegment].description}
        </div>
      )}
    </div>
  );
}
