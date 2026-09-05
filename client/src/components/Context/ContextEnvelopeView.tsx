/**
 * Optional inspector panel surfacing the canonical envelope: provider
 * strategy, history diagnostics, adaptation notes, and the snapshot ring.
 *
 * Lives alongside the existing `ContextInspector` (which renders the
 * legacy source/budget UI). A parent can drop this component below the
 * existing inspector to expose the new diagnostics introduced by the
 * change `topic-context-canonical` — zero impact on the legacy view.
 *
 * Renders nothing while the preview is loading or absent so it never
 * pushes layout when there's no data to show.
 */

import { useMemo, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { WSMessage } from '../../types';
import {
  useContextPreview,
  useContextSnapshots,
} from '../../hooks/useContextInspector';
import type { ContextEnvelope, EnvelopeHistoryEntry } from '../../lib/api';

interface Props {
  topicId: string;
  /** Optional override; defaults to the topic's configured provider. */
  providerName?: string;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

export function ContextEnvelopeView({ topicId, providerName, onMessage }: Props) {
  const { preview, loading, error } = useContextPreview(topicId, providerName, onMessage);
  const { snapshots, clear } = useContextSnapshots(topicId, onMessage);
  const [tab, setTab] = useState<'preview' | 'history' | 'snapshots'>('preview');

  if (loading && !preview) {
    return (
      <div className="text-xs text-gray-400 px-3 py-2">Loading canonical envelope…</div>
    );
  }
  if (error) {
    return (
      <div className="text-xs text-red-500 px-3 py-2">Envelope error: {error}</div>
    );
  }
  if (!preview) return null;

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 mt-3 pt-3">
      <div className="flex items-center justify-between px-3 mb-2">
        <h3 className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold">
          Canonical Envelope
        </h3>
        <ProviderBadge envelope={preview.envelope} />
      </div>

      <div className="flex gap-1 px-3 mb-2 text-xs">
        <TabButton active={tab === 'preview'} onClick={() => setTab('preview')}>Preview</TabButton>
        <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
          History ({preview.envelope.history.length})
        </TabButton>
        <TabButton active={tab === 'snapshots'} onClick={() => setTab('snapshots')}>
          Last sent ({snapshots.length})
        </TabButton>
      </div>

      {tab === 'preview' && <PreviewTab preview={preview} />}
      {tab === 'history' && <HistoryTab entries={preview.envelope.diagnostics.historyEntries} dropped={preview.envelope.diagnostics.droppedHistoryTurns} />}
      {tab === 'snapshots' && <SnapshotsTab snapshots={snapshots} onClear={clear} />}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────

function ProviderBadge({ envelope }: { envelope: ContextEnvelope }) {
  const strategyColors: Record<string, string> = {
    'history-aware': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    'inline-system': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    'gateway-stateful': 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  };
  const cls = strategyColors[envelope.providerStrategy] || 'bg-gray-100 text-gray-600';
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span className="font-mono text-gray-500 dark:text-gray-400">{envelope.providerName}</span>
      <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${cls}`}>
        {envelope.providerStrategy}
      </span>
    </span>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 rounded text-xs ${
        active
          ? 'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100'
          : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
      }`}
    >
      {children}
    </button>
  );
}

function PreviewTab({ preview }: { preview: { envelope: ContextEnvelope; payload: { adaptationNotes: string[]; userContent: string; history?: { role: string; content: string }[] } } }) {
  const composed = useMemo(() => {
    const enabled = preview.envelope.systemBlocks.filter((b) => b.enabled && b.injectedByTopicsApp);
    return enabled.length;
  }, [preview]);
  const meta = preview.envelope.sessionMeta;
  return (
    <div className="px-3 space-y-2 text-xs">
      {meta && (
        <div className="text-[11px] text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 rounded p-2 space-y-0.5">
          {meta.topicName && (
            <div><span className="text-gray-400">topic:</span> <strong>{meta.topicName}</strong></div>
          )}
          {meta.modelName !== undefined && (
            <div><span className="text-gray-400">model:</span> {meta.modelName ?? <em>provider default</em>}</div>
          )}
          {meta.workingDir && (
            <div className="truncate"><span className="text-gray-400">cwd:</span> <span className="font-mono">{meta.workingDir}</span></div>
          )}
          {meta.worktreeId && (
            <div><span className="text-gray-400">worktree:</span> <span className="font-mono text-[11px]">{meta.worktreeId}</span></div>
          )}
          {typeof meta.totalStoredMessages === 'number' && (
            <div><span className="text-gray-400">messages in DB:</span> {meta.totalStoredMessages}</div>
          )}
          {meta.planMode && (
            <div className="text-amber-600 dark:text-amber-400">plan mode: ON</div>
          )}
        </div>
      )}
      <div className="text-gray-600 dark:text-gray-300">
        <strong>{composed}</strong> system block(s) emitted ·{' '}
        <strong>{preview.envelope.history.length}</strong> historic turn(s) ·{' '}
        <strong>{preview.envelope.diagnostics.droppedHistoryTurns}</strong> dropped
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-gray-500 dark:text-gray-400">Adaptation notes</summary>
        <ul className="mt-1 list-disc list-inside text-gray-600 dark:text-gray-300 space-y-0.5">
          {preview.payload.adaptationNotes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      </details>
      <details className="text-xs">
        <summary className="cursor-pointer text-gray-500 dark:text-gray-400">Raw envelope JSON</summary>
        <pre className="mt-1 p-2 bg-gray-50 dark:bg-gray-800 rounded overflow-auto max-h-64 text-[11px]">
          {JSON.stringify(preview.envelope, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function HistoryTab({ entries, dropped }: { entries: EnvelopeHistoryEntry[]; dropped: number }) {
  return (
    <div className="px-3 space-y-1 text-xs max-h-72 overflow-auto">
      {dropped > 0 && (
        <div className="text-amber-700 dark:text-amber-300 mb-2">
          <TriangleAlert className="w-3.5 h-3.5 inline-block align-[-2px] mr-1" aria-hidden="true" />
          {dropped} older turn(s) dropped due to history limit
        </div>
      )}
      {entries.length === 0 && (
        <div className="text-gray-500 dark:text-gray-400">No messages in history yet.</div>
      )}
      {entries.map((e) => (
        <div
          key={e.storedMessageId}
          className={`flex gap-2 items-start py-1 px-2 rounded ${
            e.excluded
              ? 'bg-gray-50 dark:bg-gray-800/50 text-gray-400 dark:text-gray-500'
              : 'text-gray-700 dark:text-gray-300'
          }`}
        >
          <span className="font-mono text-[11px] text-gray-400 mt-0.5">{e.role}</span>
          <span className="flex-1 truncate">
            {e.excluded ? (
              <em className="text-xs">excluded · {e.excludeReason}</em>
            ) : e.strippedMarkers.length > 0 ? (
              <span className="text-amber-600 dark:text-amber-400">
                stripped {e.strippedMarkers.length} marker(s) · {e.bytesDropped}B dropped
              </span>
            ) : (
              <span className="text-gray-500 dark:text-gray-400">included unchanged</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function SnapshotsTab({ snapshots, onClear }: { snapshots: ContextEnvelope[]; onClear: () => Promise<void> }) {
  if (snapshots.length === 0) {
    return (
      <div className="px-3 text-xs text-gray-500 dark:text-gray-400">
        No snapshots yet. Snapshots are kept in memory only. They reset on server restart.
        Send a message to capture one.
      </div>
    );
  }
  return (
    <div className="px-3 text-xs space-y-2 max-h-72 overflow-auto">
      {snapshots.map((s, i) => {
        const ts = new Date(s.diagnostics.assembledAt).toLocaleTimeString();
        const enabled = s.systemBlocks.filter((b) => b.enabled && b.injectedByTopicsApp).length;
        return (
          <div key={i} className="border border-gray-200 dark:border-gray-700 rounded p-2">
            <div className="flex justify-between text-[11px] text-gray-500 mb-1">
              <span>{ts} · {s.providerName} ({s.providerStrategy})</span>
              <span>{enabled} blocks · {s.history.length} turns</span>
            </div>
            <div className="text-gray-700 dark:text-gray-300 truncate">
              <span className="font-mono text-[11px] text-gray-400">user:</span>{' '}
              {s.userMessage.content.slice(0, 120)}{s.userMessage.content.length > 120 ? '…' : ''}
            </div>
          </div>
        );
      })}
      <button
        onClick={onClear}
        className="text-[11px] text-red-500 hover:underline mt-1"
      >
        Clear snapshots
      </button>
    </div>
  );
}
