import {
  useMemo,
  useState,
  useSyncExternalStore,
  type JSX,
} from 'react';
import {
  getRing,
  subscribe,
  clearRing,
  type MutationLogEntry,
} from '../middleware/mutationLog';
import { copyText } from '../../../lib/clipboard';
import { useKeyChord } from './useKeyChord';

const MAX_RENDER = 500;

function accentColor(actionType: string): string {
  const upper = actionType.toUpperCase();
  if (
    upper.includes('OPEN') ||
    upper.includes('RESTORE') ||
    upper.includes('HYDRATE')
  ) {
    return 'var(--color-accent-success)';
  }
  if (upper.includes('CLOSE')) {
    return 'var(--color-accent-warning)';
  }
  return 'var(--color-text-muted)';
}

function extractActionType(entry: MutationLogEntry): string {
  const a = entry.action as { type?: unknown } | null;
  return a && typeof a === 'object' && typeof a.type === 'string'
    ? a.type
    : 'UNKNOWN';
}

function extractGroup(entry: MutationLogEntry): string {
  const a = entry.action as
    | { payload?: { groupId?: unknown; id?: unknown } }
    | null;
  const gid = a?.payload?.groupId;
  if (typeof gid === 'string') return gid;
  const pid = a?.payload?.id;
  if (typeof pid === 'string') return pid;
  return '-';
}

export function MutationLogOverlay(): JSX.Element | null {
  const [visible, setVisible] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState('');
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);

  useKeyChord(() => setVisible((v) => !v));

  // Subscribe to the mutation log via useSyncExternalStore so only this
  // component rerenders when new entries arrive (UI-SPEC §2.5 — isolated).
  const ring = useSyncExternalStore(
    (onStoreChange) => subscribe(onStoreChange),
    () => getRing(),
    () => getRing(),
  );

  const filtered = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const list = term
      ? ring.filter((e) => {
          const t = extractActionType(e).toLowerCase();
          const g = extractGroup(e).toLowerCase();
          return t.includes(term) || g.includes(term);
        })
      : ring;
    return list.slice(-MAX_RENDER);
  }, [ring, filter]);

  if (!visible) return null;

  const handleExport = async (): Promise<void> => {
    const ndjson = getRing()
      .map((e) => JSON.stringify(e))
      .join('\n');
    await copyText(ndjson); // dev tool: best-effort, boolean swallowed
  };

  const buttonStyle = {
    background: 'transparent',
    color: 'var(--color-text-muted)',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'var(--font-ui)',
    fontSize: '0.8125rem',
    padding: '0 0.25rem',
  } as const;

  return (
    <div
      role="region"
      aria-label="Pane Mutation Log"
      data-testid="pane-mutation-log-overlay"
      style={{
        position: 'fixed',
        right: '1rem',
        bottom: '1rem',
        width: '26.25rem', // 420px at 16px root
        maxHeight: collapsed ? '2.25rem' : '20rem', // 36px vs 320px
        background: 'var(--color-surface-raised)',
        color: 'var(--color-text-primary)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: '0.375rem',
        zIndex: 9000,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-ui)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.5rem 0.75rem',
          height: '2.25rem',
          borderBottom: collapsed
            ? 'none'
            : '1px solid var(--color-border-subtle)',
          fontFamily: 'var(--font-ui)',
          fontSize: '0.8125rem', // ~13px
          lineHeight: '1.25rem',
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        <span>Pane Mutation Log</span>
        <span style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            aria-label="Clear"
            onClick={() => clearRing()}
            style={buttonStyle}
          >
            Clear
          </button>
          <button
            aria-label="Export NDJSON"
            onClick={handleExport}
            style={buttonStyle}
          >
            Export
          </button>
          <button
            aria-label={collapsed ? 'Expand' : 'Collapse'}
            onClick={() => setCollapsed((c) => !c)}
            style={buttonStyle}
          >
            {collapsed ? '+' : '−'}
          </button>
          <button
            aria-label="Close"
            onClick={() => setVisible(false)}
            style={buttonStyle}
          >
            ×
          </button>
        </span>
      </header>

      {!collapsed && (
        <>
          <div
            style={{
              padding: '0.5rem 0.75rem',
              borderBottom: '1px solid var(--color-border-subtle)',
              flexShrink: 0,
            }}
          >
            <input
              type="text"
              placeholder="Filter by action or group…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{
                width: '100%',
                background: 'transparent',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: '0.25rem',
                padding: '0.25rem 0.5rem',
                fontFamily: 'var(--font-ui)',
                fontSize: '0.8125rem',
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div
            style={{
              overflowY: 'auto',
              flex: 1,
              fontFamily: 'var(--font-mono)',
              fontSize: '0.75rem', // 12px row size (UI-SPEC §2.3)
              lineHeight: '1rem',
            }}
          >
            {filtered.map((entry) => {
              const actionType = extractActionType(entry);
              const group = extractGroup(entry);
              const isExpanded = expandedSeq === entry.seq;
              return (
                <div
                  key={entry.seq}
                  onClick={() =>
                    setExpandedSeq(isExpanded ? null : entry.seq)
                  }
                  style={{
                    padding: '0.25rem 0.75rem 0.25rem calc(0.75rem + 2px)',
                    borderLeft: `2px solid ${accentColor(actionType)}`,
                    borderBottom: '1px solid var(--color-border-subtle)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    {String(entry.seq).padStart(4, ' ')}
                  </span>{' '}
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    {/* entry.ts is `performance.now()` (see store.ts). */}
                    {/* Convert to wall-clock via performance.timeOrigin so */}
                    {/* the overlay shows the real time-of-day rather than */}
                    {/* `Date(performance.now())` which renders ~1970-01-01. */}
                    {new Date(performance.timeOrigin + entry.ts)
                      .toISOString()
                      .slice(11, 23)}
                  </span>{' '}
                  <span>{actionType}</span>{' '}
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    {group}
                  </span>
                  {isExpanded && (
                    <pre
                      style={{
                        marginTop: '0.25rem',
                        padding: '0.5rem',
                        background: 'var(--color-surface-raised)',
                        border: '1px solid var(--color-border-subtle)',
                        borderRadius: '0.25rem',
                        maxHeight: '10rem',
                        overflow: 'auto',
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.75rem',
                        color: 'var(--color-text-primary)',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {JSON.stringify(entry.action, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
