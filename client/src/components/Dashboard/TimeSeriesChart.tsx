import { useState, useRef, useEffect, useCallback } from 'react';
import type { TimeSeriesPoint } from '../../lib/api';

interface TimeSeriesChartProps {
  points: TimeSeriesPoint[];
  metric: string;
  height?: number;
}

const PADDING = { top: 20, right: 16, bottom: 28, left: 48 };

export function TimeSeriesChart({ points, metric, height = 200 }: TimeSeriesChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Responsive width via ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (points.length === 0) {
    return (
      <div ref={containerRef} className="flex items-center justify-center text-app-text-muted text-[12px]" style={{ height }}>
        No data for selected range
      </div>
    );
  }

  const chartW = width - PADDING.left - PADDING.right;
  const chartH = height - PADDING.top - PADDING.bottom;

  const values = points.map(p => p.value);
  const maxVal = Math.max(...values, 1);
  const minVal = Math.min(...values, 0);
  const valRange = maxVal - minVal || 1;

  const xScale = (i: number) => PADDING.left + (chartW * i) / Math.max(points.length - 1, 1);
  const yScale = (v: number) => PADDING.top + chartH - ((v - minVal) / valRange) * chartH;

  // Build SVG path
  const linePoints = points.map((p, i) => `${xScale(i)},${yScale(p.value)}`);
  const linePath = `M${linePoints.join(' L')}`;
  const areaPath = `${linePath} L${xScale(points.length - 1)},${yScale(minVal)} L${xScale(0)},${yScale(minVal)} Z`;

  // Y axis ticks (5 ticks)
  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const v = minVal + (valRange * i) / 4;
    return { value: v, y: yScale(v) };
  });

  // Format Y label
  const formatVal = (v: number): string => {
    if (metric === 'cost') return `$${v.toFixed(2)}`;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return v.toFixed(v % 1 === 0 ? 0 : 1);
  };

  // Format date label
  const formatDate = (d: string): string => {
    const parts = d.split('-');
    if (parts.length >= 3) return `${parts[1]}/${parts[2]}`;
    return d;
  };

  // Show subset of X labels to avoid crowding
  const maxXLabels = Math.max(Math.floor(chartW / 60), 2);
  const xLabelStep = Math.max(1, Math.ceil(points.length / maxXLabels));

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    // Find closest point
    let closest = 0;
    let closestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dist = Math.abs(xScale(i) - mx);
      if (dist < closestDist) { closestDist = dist; closest = i; }
    }
    setHoverIdx(closestDist < 30 ? closest : null);
  }, [points.length, width]);

  const handleMouseLeave = useCallback(() => setHoverIdx(null), []);

  return (
    <div ref={containerRef} className="w-full">
      <svg
        width={width}
        height={height}
        className="select-none"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {/* Grid lines */}
        {yTicks.map((tick, i) => (
          <line
            key={i}
            x1={PADDING.left}
            x2={width - PADDING.right}
            y1={tick.y}
            y2={tick.y}
            stroke="currentColor"
            strokeOpacity={0.06}
            strokeDasharray="2,2"
          />
        ))}

        {/* Y axis labels */}
        {yTicks.map((tick, i) => (
          <text
            key={i}
            x={PADDING.left - 6}
            y={tick.y}
            textAnchor="end"
            dominantBaseline="middle"
            className="fill-app-text-muted"
            fontSize={9}
          >
            {formatVal(tick.value)}
          </text>
        ))}

        {/* X axis labels */}
        {points.map((p, i) => {
          if (i % xLabelStep !== 0 && i !== points.length - 1) return null;
          return (
            <text
              key={i}
              x={xScale(i)}
              y={height - 6}
              textAnchor="middle"
              className="fill-app-text-muted"
              fontSize={9}
            >
              {formatDate(p.date)}
            </text>
          );
        })}

        {/* Area fill */}
        <path d={areaPath} fill="var(--color-primary, #3b82f6)" opacity={0.1} />

        {/* Line */}
        <path
          d={linePath}
          fill="none"
          stroke="var(--color-primary, #3b82f6)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Data points */}
        {points.map((p, i) => (
          <circle
            key={i}
            cx={xScale(i)}
            cy={yScale(p.value)}
            r={hoverIdx === i ? 4 : 2}
            fill="var(--color-primary, #3b82f6)"
            stroke={hoverIdx === i ? 'white' : 'none'}
            strokeWidth={hoverIdx === i ? 1.5 : 0}
            className="transition-all duration-100"
          />
        ))}

        {/* Hover tooltip */}
        {hoverIdx !== null && points[hoverIdx] && (
          <g>
            <line
              x1={xScale(hoverIdx)}
              x2={xScale(hoverIdx)}
              y1={PADDING.top}
              y2={PADDING.top + chartH}
              stroke="currentColor"
              strokeOpacity={0.15}
              strokeDasharray="2,2"
            />
            <rect
              x={xScale(hoverIdx) - 36}
              y={yScale(points[hoverIdx].value) - 26}
              width={72}
              height={20}
              rx={4}
              className="fill-surface"
              stroke="currentColor"
              strokeOpacity={0.1}
            />
            <text
              x={xScale(hoverIdx)}
              y={yScale(points[hoverIdx].value) - 13}
              textAnchor="middle"
              className="fill-app-text"
              fontSize={10}
              fontWeight={600}
            >
              {formatVal(points[hoverIdx].value)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
