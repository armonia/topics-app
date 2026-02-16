import { useState, useEffect } from 'react';
import { X, TrendingUp, BarChart3 } from 'lucide-react';
import type { UsageSummary } from '../lib/api';

interface UsagePanelProps {
  isOpen: boolean;
  onClose: () => void;
  summary: UsageSummary | null;
  loading: boolean;
  error?: string | null;
  onLoad: () => void;
  topicNames?: Record<string, string>;
}

function formatCost(cost: number): string {
  if (cost < 0.01) return '$0.00';
  return `$${cost.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}

const MODEL_COLORS: Record<string, string> = {
  'claude-opus': '#8b5cf6',
  'claude-sonnet': '#3b82f6',
  'claude-haiku': '#06b6d4',
  'gpt-4o': '#22c55e',
  'gpt-o3': '#f59e0b',
  'default': '#6b7280',
};

function getModelColor(model: string): string {
  const lower = model.toLowerCase();
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (key !== 'default' && lower.includes(key)) return color;
  }
  return MODEL_COLORS.default;
}

function getModelShortName(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'Opus';
  if (lower.includes('sonnet')) return 'Sonnet';
  if (lower.includes('haiku')) return 'Haiku';
  if (lower.includes('gpt-4o-mini')) return 'GPT-4o Mini';
  if (lower.includes('gpt-4o')) return 'GPT-4o';
  if (lower.includes('o3-mini')) return 'o3-mini';
  if (lower.includes('o3')) return 'o3';
  return model.split('-').slice(0, 2).join('-');
}

export function UsagePanel({ isOpen, onClose, summary, loading, error, onLoad, topicNames }: UsagePanelProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'models' | 'topics'>('overview');

  useEffect(() => {
    if (isOpen) {
      onLoad();
      const interval = setInterval(onLoad, 30000);
      return () => clearInterval(interval);
    }
  }, [isOpen, onLoad]);

  if (!isOpen) return null;

  // Get last 7 days for bar chart
  const last7Days = (() => {
    const days: { date: string; cost: number; tokens: number; label: string }[] = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const day = summary?.daily[key];
      days.push({
        date: key,
        cost: day?.costUsd || 0,
        tokens: day?.totalTokens || 0,
        label: d.toLocaleDateString('en-US', { weekday: 'short' }),
      });
    }
    return days;
  })();

  const hasAnyDayCost = last7Days.some(d => d.cost > 0);
  const maxDayCost = hasAnyDayCost ? Math.max(...last7Days.map(d => d.cost)) : 1;

  // Model breakdown
  const models = summary ? Object.values(summary.byModel)
    .sort((a, b) => b.costUsd - a.costUsd) : [];
  const totalModelCost = models.reduce((s, m) => s + m.costUsd, 0) || 1;

  // Topic breakdown
  const topics = summary ? Object.values(summary.byTopic)
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 10) : [];
  const maxTopicCost = Math.max(...topics.map(t => t.costUsd), 0.01);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-surface border border-app-border rounded-xl shadow-2xl w-[480px] max-w-[95vw] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
          <div className="flex items-center gap-2">
            <TrendingUp size={16} className="text-app-text-secondary" />
            <span className="font-semibold text-[14px] text-app-text">Usage & Costs</span>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center text-app-text-tertiary hover:text-app-text hover:bg-app-hover rounded-md transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-app-border px-4">
          {(['overview', 'models', 'topics'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-2 text-[12px] font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'text-primary border-primary'
                  : 'text-app-text-secondary border-transparent hover:text-app-text'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && !summary ? (
            <div className="flex items-center justify-center py-8 text-app-text-muted text-[13px]">
              Loading usage data...
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-8 gap-2">
              <span className="text-red-500 text-[13px]">{error}</span>
              <button
                onClick={onLoad}
                className="text-[12px] text-primary hover:underline"
              >
                Retry
              </button>
            </div>
          ) : !summary ? (
            <div className="flex items-center justify-center py-8 text-app-text-muted text-[13px]">
              No usage data yet
            </div>
          ) : (
            <>
              {activeTab === 'overview' && (
                <div className="space-y-4">
                  {/* Summary cards */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="p-3 rounded-lg bg-elevated border border-app-border">
                      <div className="text-[10px] text-app-text-muted uppercase tracking-wider">Total Cost</div>
                      <div className="text-[18px] font-bold text-app-text mt-0.5">{formatCost(summary.totalCostUsd)}</div>
                    </div>
                    <div className="p-3 rounded-lg bg-elevated border border-app-border">
                      <div className="text-[10px] text-app-text-muted uppercase tracking-wider">Total Tokens</div>
                      <div className="text-[18px] font-bold text-app-text mt-0.5">{formatTokens(summary.totalTokens)}</div>
                    </div>
                    <div className="p-3 rounded-lg bg-elevated border border-app-border">
                      <div className="text-[10px] text-app-text-muted uppercase tracking-wider">Requests</div>
                      <div className="text-[18px] font-bold text-app-text mt-0.5">{summary.totalRequests}</div>
                    </div>
                  </div>

                  {/* 7-day bar chart */}
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <BarChart3 size={13} className="text-app-text-secondary" />
                      <span className="text-[12px] font-medium text-app-text">Last 7 Days</span>
                    </div>
                    {!hasAnyDayCost ? (
                      <div className="flex items-center justify-center h-[80px] text-[11px] text-app-text-muted">
                        No usage in the last 7 days
                      </div>
                    ) : (
                      <div className="flex items-end gap-1 h-[80px]">
                        {last7Days.map((day) => {
                          const height = day.cost > 0 ? Math.max((day.cost / maxDayCost) * 100, 3) : 0;
                          const isToday = day.date === new Date().toISOString().slice(0, 10);
                          return (
                            <div key={day.date} className="flex-1 flex flex-col items-center gap-1">
                              <div className="text-[9px] text-app-text-muted">
                                {day.cost > 0 ? formatCost(day.cost) : ''}
                              </div>
                              <div className="w-full flex-1 flex items-end">
                                <div
                                  className={`w-full rounded-t transition-all ${
                                    isToday ? 'bg-primary' : 'bg-primary/40'
                                  }`}
                                  style={{ height: `${height}%`, minHeight: day.cost > 0 ? '3px' : '0px' }}
                                />
                              </div>
                              <div className={`text-[9px] ${isToday ? 'text-app-text font-medium' : 'text-app-text-muted'}`}>
                                {day.label}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Model donut preview */}
                  {models.length > 0 && (
                    <div>
                      <div className="text-[12px] font-medium text-app-text mb-2">By Model</div>
                      <div className="space-y-1.5">
                        {models.slice(0, 5).map((m) => {
                          const pct = (m.costUsd / totalModelCost) * 100;
                          const color = getModelColor(m.model);
                          return (
                            <div key={m.model} className="flex items-center gap-2">
                              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                              <span className="text-[11px] text-app-text flex-1 truncate">{getModelShortName(m.model)}</span>
                              <div className="w-16 h-1.5 rounded-full bg-elevated overflow-hidden">
                                <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                              </div>
                              <span className="text-[10px] text-app-text-muted w-12 text-right">{formatCost(m.costUsd)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'models' && (
                <div className="space-y-2">
                  {models.length === 0 ? (
                    <div className="text-[13px] text-app-text-muted text-center py-4">No model data</div>
                  ) : (
                    models.map((m) => {
                      const color = getModelColor(m.model);
                      return (
                        <div key={m.model} className="p-3 rounded-lg bg-elevated border border-app-border">
                          <div className="flex items-center gap-2 mb-1.5">
                            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                            <span className="text-[12px] font-medium text-app-text">{getModelShortName(m.model)}</span>
                            <span className="text-[11px] text-app-text-muted ml-auto">{formatCost(m.costUsd)}</span>
                          </div>
                          <div className="grid grid-cols-3 gap-2 text-[10px] text-app-text-secondary">
                            <div>
                              <span className="text-app-text-muted">Tokens: </span>
                              {formatTokens(m.totalTokens)}
                            </div>
                            <div>
                              <span className="text-app-text-muted">Requests: </span>
                              {m.requestCount}
                            </div>
                            <div>
                              <span className="text-app-text-muted">Avg: </span>
                              {formatCost(m.costUsd / (m.requestCount || 1))}/req
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {activeTab === 'topics' && (
                <div className="space-y-1.5">
                  {topics.length === 0 ? (
                    <div className="text-[13px] text-app-text-muted text-center py-4">No topic data</div>
                  ) : (
                    topics.map((t) => {
                      const barWidth = (t.costUsd / maxTopicCost) * 100;
                      const name = topicNames?.[t.topicId] || t.topicId.slice(0, 8);
                      return (
                        <div key={t.topicId} className="flex items-center gap-2 py-1">
                          <span className="text-[11px] text-app-text w-24 truncate flex-shrink-0" title={name}>
                            {name}
                          </span>
                          <div className="flex-1 h-2 rounded-full bg-elevated overflow-hidden">
                            <div
                              className="h-full rounded-full bg-primary transition-all"
                              style={{ width: `${barWidth}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-app-text-muted w-12 text-right flex-shrink-0">
                            {formatCost(t.costUsd)}
                          </span>
                          <span className="text-[10px] text-app-text-muted w-10 text-right flex-shrink-0">
                            {formatTokens(t.totalTokens)}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
