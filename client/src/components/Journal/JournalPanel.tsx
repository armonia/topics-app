import { useState, memo } from 'react';
import { BookOpen, ChevronLeft, ChevronRight as ChevronRightIcon, Sparkles, RefreshCw, Terminal, MessageSquare, AlertCircle, Play, Zap } from 'lucide-react';
import { useJournal, type JournalEvent } from '../../hooks/useJournal';

type Tab = 'activity' | 'journal';

function eventIcon(type: JournalEvent['type']) {
  switch (type) {
    case 'tool_call': return <Terminal size={11} className="text-blue-500" />;
    case 'message': return <MessageSquare size={11} className="text-green-500" />;
    case 'session_start': return <Play size={11} className="text-indigo-500" />;
    case 'session_end': return <Zap size={11} className="text-gray-400" />;
    case 'error': return <AlertCircle size={11} className="text-red-500" />;
    default: return <Terminal size={11} className="text-gray-400" />;
  }
}

function formatTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '';
  }
}

function formatDisplayDate(date: string): string {
  try {
    const d = new Date(date + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return date;
  }
}

const EventRow = memo(function EventRow({ event }: { event: JournalEvent }) {
  return (
    <div className="flex items-start gap-2 px-2 py-1.5 hover:bg-app-hover rounded transition-colors">
      <span className="flex-shrink-0 mt-0.5">{eventIcon(event.type)}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-app-text leading-[16px] break-words">
          {event.summary}
        </div>
        <div className="text-[10px] text-app-text-muted mt-0.5">
          {formatTime(event.timestamp)}
          {event.sessionKey && (
            <span className="ml-2 opacity-70">{event.sessionKey.split(':').pop()?.slice(0, 8)}</span>
          )}
        </div>
      </div>
    </div>
  );
});

interface JournalPanelProps {
  enabled?: boolean;
}

export function JournalPanel({ enabled = true }: JournalPanelProps) {
  const [tab, setTab] = useState<Tab>('journal');
  const {
    currentDate,
    events,
    digest,
    digestExists,
    loading,
    generating,
    error,
    isToday,
    goToPreviousDay,
    goToNextDay,
    goToToday,
    generateDigest,
    refresh,
  } = useJournal({ enabled });

  return (
    <div className="flex flex-col h-full">
      {/* Date navigation */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-app-border flex-shrink-0">
        <button
          onClick={goToPreviousDay}
          className="p-0.5 rounded hover:bg-app-hover text-app-text-muted"
          title="Previous day"
        >
          <ChevronLeft size={14} />
        </button>
        <button
          onClick={goToToday}
          className="flex-1 text-center text-[11px] font-medium text-app-text hover:text-primary transition-colors"
          title="Go to today"
        >
          {formatDisplayDate(currentDate)}
          {isToday && <span className="ml-1 text-app-text-muted">(today)</span>}
        </button>
        <button
          onClick={goToNextDay}
          disabled={isToday}
          className={`p-0.5 rounded hover:bg-app-hover ${isToday ? 'text-app-text-muted opacity-30' : 'text-app-text-muted'}`}
          title="Next day"
        >
          <ChevronRightIcon size={14} />
        </button>
        <button
          onClick={refresh}
          disabled={loading}
          className="p-0.5 rounded hover:bg-app-hover text-app-text-muted"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-app-border flex-shrink-0">
        <button
          onClick={() => setTab('journal')}
          className={`flex-1 text-[11px] py-1.5 font-medium transition-colors ${
            tab === 'journal'
              ? 'text-primary border-b-2 border-primary'
              : 'text-app-text-muted hover:text-app-text-secondary'
          }`}
        >
          Journal
        </button>
        <button
          onClick={() => setTab('activity')}
          className={`flex-1 text-[11px] py-1.5 font-medium transition-colors ${
            tab === 'activity'
              ? 'text-primary border-b-2 border-primary'
              : 'text-app-text-muted hover:text-app-text-secondary'
          }`}
        >
          Events ({events.length})
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="px-3 py-1.5 text-[10px] text-red-500 bg-red-50 dark:bg-red-900/10 flex-shrink-0">
          {error}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0 sidebar-scroll">
        {tab === 'journal' ? (
          <div className="p-3">
            {loading && !digest ? (
              <div className="text-center text-[11px] text-app-text-muted py-4">Loading...</div>
            ) : digestExists && digest ? (
              <div className="prose prose-sm max-w-none text-[12px] leading-relaxed text-app-text-secondary">
                <div className="whitespace-pre-wrap">{digest}</div>
              </div>
            ) : (
              <div className="text-center py-4">
                <BookOpen size={20} className="mx-auto mb-2 text-app-text-muted opacity-50" />
                <p className="text-[11px] text-app-text-muted mb-3">
                  {events.length > 0
                    ? 'No journal entry for this day yet.'
                    : 'No activity recorded for this day.'}
                </p>
                {events.length > 0 && (
                  <button
                    onClick={generateDigest}
                    disabled={generating}
                    className="flex items-center gap-1.5 mx-auto px-3 py-1.5 text-[11px] font-medium bg-primary text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {generating ? (
                      <>
                        <RefreshCw size={12} className="animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <Sparkles size={12} />
                        Generate Journal Entry
                      </>
                    )}
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="py-1">
            {events.length === 0 ? (
              <div className="text-center text-[11px] text-app-text-muted py-4">
                {loading ? 'Loading...' : 'No events recorded for this day.'}
              </div>
            ) : (
              events.map(event => <EventRow key={event.id} event={event} />)
            )}
          </div>
        )}
      </div>
    </div>
  );
}
