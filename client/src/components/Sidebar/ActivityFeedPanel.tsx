import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { Pause, Play, Search, X, ArrowDown } from 'lucide-react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useActivity } from '../../hooks/useActivity';
import { ActivityItem, CATEGORY_CONFIG } from './ActivityItem';
import { ErrorBoundary } from '../Shared/ErrorBoundary';
import type { ActivityCategory } from '../../hooks/useActivity';

const JournalPanel = lazy(() => import('../Journal/JournalPanel').then(m => ({ default: m.JournalPanel })));

type ActivityTab = 'live' | 'digest';

interface ActivityFeedPanelProps {
  enabled?: boolean;
}

export function ActivityFeedPanel({ enabled = true }: ActivityFeedPanelProps) {
  const [activeTab, setActiveTab] = useState<ActivityTab>('live');
  const {
    events,
    connected,
    filters,
    setFilters,
    paused,
    pause,
    resume,
  } = useActivity(enabled);

  const [showSearch, setShowSearch] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  // Auto-scroll to bottom when new events arrive (if not scrolled up)
  useEffect(() => {
    if (!isScrolledUp && events.length > 0) {
      virtuosoRef.current?.scrollToIndex({ index: events.length - 1, behavior: 'smooth' });
    }
  }, [events.length, isScrolledUp]);

  // Jump to bottom
  const jumpToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({ index: events.length - 1, behavior: 'smooth' });
    setIsScrolledUp(false);
  }, [events.length]);

  // Track scroll: atBottom callback from Virtuoso
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setIsScrolledUp(!atBottom);
  }, []);

  // Search debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters(prev => ({ ...prev, search: searchInput }));
    }, 200);
    return () => clearTimeout(timer);
  }, [searchInput, setFilters]);

  const toggleCategory = useCallback((cat: ActivityCategory) => {
    setFilters(prev => {
      const next = new Set(prev.categories);
      if (next.has(cat)) {
        next.delete(cat);
      } else {
        next.add(cat);
      }
      return { ...prev, categories: next };
    });
  }, [setFilters]);

  // Count events by category for filter badges
  const categoryCounts = new Map<ActivityCategory, number>();
  for (const e of events) {
    categoryCounts.set(e.category, (categoryCounts.get(e.category) || 0) + 1);
  }

  return (
    <div className="flex flex-col h-full relative" data-testid="activity-feed">
      {/* Tab bar */}
      <div className="flex items-center border-b border-app-border flex-shrink-0">
        {(['live', 'digest'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 px-3 py-1.5 text-[11px] font-medium transition-colors ${
              activeTab === tab
                ? 'text-primary border-b-2 border-primary'
                : 'text-app-text-muted hover:text-app-text-secondary'
            }`}
          >
            {tab === 'live' ? 'Live' : 'Digest'}
          </button>
        ))}
      </div>

      {activeTab === 'digest' ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="w-4 h-4 border-2 border-app-border-light border-t-primary rounded-full animate-spin" /></div>}>
            <JournalPanel enabled={enabled} />
          </Suspense>
        </div>
      ) : (
      <>
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-app-border flex-shrink-0">
        {/* Pause/Resume */}
        <button
          onClick={() => paused ? resume() : pause()}
          className={`p-1 rounded transition-colors ${
            paused
              ? 'text-yellow-500 bg-yellow-500/10'
              : 'text-app-text-muted hover:text-app-text-secondary hover:bg-app-hover'
          }`}
          title={paused ? 'Resume feed' : 'Pause feed'}
        >
          {paused ? <Play size={12} /> : <Pause size={12} />}
        </button>

        {/* Search toggle */}
        <button
          onClick={() => setShowSearch(!showSearch)}
          className={`p-1 rounded transition-colors ${
            showSearch
              ? 'text-primary bg-primary/10'
              : 'text-app-text-muted hover:text-app-text-secondary hover:bg-app-hover'
          }`}
          title="Search"
        >
          <Search size={12} />
        </button>

        {/* Filter toggle */}
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`p-1 rounded text-[11px] font-medium transition-colors ${
            filters.categories.size > 0
              ? 'text-primary bg-primary/10'
              : 'text-app-text-muted hover:text-app-text-secondary hover:bg-app-hover'
          }`}
          title="Filter by type"
        >
          {filters.categories.size > 0 ? `${filters.categories.size} filters` : 'Filter'}
        </button>

        <div className="flex-1" />

        {/* Connection status */}
        {!connected && (
          <span className="text-[11px] text-red-500">disconnected</span>
        )}
        {paused && (
          <span className="text-[11px] text-yellow-500">paused</span>
        )}
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="px-2 py-1 border-b border-app-border flex-shrink-0">
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-app-text-muted" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Filter events..."
              className="w-full pl-6 pr-6 py-1 text-[11px] bg-transparent border border-app-border rounded focus:outline-none focus:border-primary text-app-text"
              autoFocus
            />
            {searchInput && (
              <button
                onClick={() => setSearchInput('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-app-text-muted hover:text-app-text-secondary"
              >
                <X size={10} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Category filters */}
      {showFilters && (
        <div className="px-2 py-1.5 border-b border-app-border flex flex-wrap gap-1 flex-shrink-0">
          {(Object.keys(CATEGORY_CONFIG) as ActivityCategory[]).map(cat => {
            const config = CATEGORY_CONFIG[cat];
            const count = categoryCounts.get(cat) || 0;
            const active = filters.categories.size === 0 || filters.categories.has(cat);
            return (
              <button
                key={cat}
                onClick={() => toggleCategory(cat)}
                className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] transition-colors ${
                  active
                    ? 'bg-primary/10 text-primary'
                    : 'bg-elevated text-app-text-muted opacity-50'
                }`}
                title={cat}
              >
                <config.icon size={10} />
                <span>{config.label}</span>
                {count > 0 && <span className="ml-0.5 opacity-70">{count}</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* Virtualized event list */}
      <div className="flex-1 min-h-0">
        {events.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-app-text-muted">
            {connected ? 'No activity yet' : 'Connecting to activity stream...'}
          </div>
        ) : (
          <ErrorBoundary fallbackMessage="Activity feed error">
            <Virtuoso
              ref={virtuosoRef}
              data={events}
              style={{ height: '100%' }}
              atBottomStateChange={handleAtBottomStateChange}
              atBottomThreshold={40}
              followOutput="smooth"
              itemContent={(_index, event) => {
                if (!event?.id) return null;
                return <ActivityItem event={event} />;
              }}
            />
          </ErrorBoundary>
        )}
      </div>

      {/* Jump to bottom button */}
      {isScrolledUp && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-2 right-2 flex items-center gap-1 px-2 py-1 text-[11px] bg-primary text-white rounded-full shadow-md hover:bg-primary-hover transition-colors"
        >
          <ArrowDown size={10} />
          Latest
        </button>
      )}
      </>
      )}
    </div>
  );
}
