import { useState, useRef } from 'react';
import type { DaySummary } from '../lib/api';

interface UsageBadgeProps {
  todaySummary: DaySummary | null;
  onClick: () => void;
  error?: string | null;
}

function formatCost(cost: number): string {
  if (cost < 0.01) return '$0.00';
  if (cost < 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}

export function UsageBadge({ todaySummary, onClick, error }: UsageBadgeProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  if (error) {
    return (
      <div className="relative app-no-drag">
        <button
          onClick={onClick}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-red-500 bg-red-500/10 hover:opacity-80 transition-opacity cursor-pointer"
          title={`Usage error: ${error}`}
        >
          <span>Usage error</span>
        </button>
      </div>
    );
  }

  if (!todaySummary) return null;

  const cost = todaySummary.costUsd;
  const colorClass = cost > 5 ? 'text-red-500' : cost > 1 ? 'text-amber-500' : 'text-emerald-500';
  const bgClass = cost > 5 ? 'bg-red-500/10' : cost > 1 ? 'bg-amber-500/10' : 'bg-emerald-500/10';

  return (
    <div
      ref={containerRef}
      className="relative app-no-drag"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <button
        onClick={onClick}
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium ${colorClass} ${bgClass} hover:opacity-80 transition-opacity cursor-pointer`}
        title="Today's usage — click for details"
      >
        <span>{formatCost(cost)}</span>
      </button>

      {showTooltip && (
        <div
          className="fixed z-[100] bg-surface border border-app-border rounded-lg shadow-xl p-2.5 min-w-[160px] text-[11px]"
          style={{
            left: Math.min(containerRef.current?.getBoundingClientRect().left ?? 0, window.innerWidth - 180),
            top: (containerRef.current?.getBoundingClientRect().bottom ?? 0) + 6,
          }}
        >
          <div className="font-medium text-app-text mb-1.5">Today's Usage</div>
          <div className="space-y-1 text-app-text-secondary">
            <div className="flex justify-between">
              <span>Cost</span>
              <span className={`font-medium ${colorClass}`}>{formatCost(cost)}</span>
            </div>
            <div className="flex justify-between">
              <span>Tokens</span>
              <span>{formatTokens(todaySummary.totalTokens)}</span>
            </div>
            <div className="flex justify-between">
              <span>Requests</span>
              <span>{todaySummary.requestCount}</span>
            </div>
          </div>
          <div className="mt-1.5 pt-1.5 border-t border-app-border text-[10px] text-app-text-muted">
            Click for full breakdown
          </div>
        </div>
      )}
    </div>
  );
}
