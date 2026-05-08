/**
 * Phase 30.1 polish — Minimal download strip for the native browser pane.
 *
 * Renders a horizontal list of active+recent downloads at the bottom of
 * the pane (same pattern as Chrome's bottom-of-window download shelf).
 * Subscribes to the IPC stream emitted by Electron's download manager
 * (will-download → updated → done) and keeps a per-pane in-memory list.
 *
 * Hidden in web mode (no electronAPI.browserNative).
 */
import { useEffect, useState, useCallback } from 'react';
import { Check, X as XIcon, FolderOpen, Loader2 } from 'lucide-react';

interface DownloadEntry {
  id: string;
  url: string;
  filename: string;
  totalBytes: number;
  received: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted' | 'paused';
  savedPath?: string;
}

const RECENT_KEEP_MS = 30_000;

export function DownloadStrip() {
  const [downloads, setDownloads] = useState<DownloadEntry[]>([]);

  useEffect(() => {
    const api = window.electronAPI?.browserNative;
    if (!api) return;
    const unsubs: Array<() => void> = [];

    unsubs.push(api.onDownloadStart((info) => {
      setDownloads((prev) => [
        ...prev,
        { ...info, received: 0, state: 'progressing' as const },
      ]);
    }));
    unsubs.push(api.onDownloadProgress((info) => {
      setDownloads((prev) => prev.map((d) => d.id === info.id
        ? { ...d, received: info.received, totalBytes: info.total, state: info.isPaused ? 'paused' as const : 'progressing' as const }
        : d));
    }));
    unsubs.push(api.onDownloadDone((info) => {
      setDownloads((prev) => prev.map((d) => d.id === info.id
        ? { ...d, state: info.state as DownloadEntry['state'], savedPath: info.savedPath }
        : d));
      setTimeout(() => {
        setDownloads((prev) => prev.filter((d) => d.id !== info.id));
      }, RECENT_KEEP_MS);
    }));

    return () => { for (const u of unsubs) u(); };
  }, []);

  const showInFolder = useCallback((path: string) => {
    void window.electronAPI?.browserNative?.showDownloadInFolder(path);
  }, []);
  const dismiss = useCallback((id: string) => {
    setDownloads((prev) => prev.filter((d) => d.id !== id));
  }, []);

  if (downloads.length === 0) return null;

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 bg-elevated dark:bg-app-panel border-t border-app-border text-[11px] overflow-x-auto"
      data-testid="browser-download-strip"
    >
      {downloads.map((d) => {
        const pct = d.totalBytes > 0 ? Math.round((d.received / d.totalBytes) * 100) : 0;
        const isDone = d.state === 'completed';
        const isFailed = d.state === 'cancelled' || d.state === 'interrupted';
        return (
          <div
            key={d.id}
            className="flex items-center gap-1.5 px-2 py-1 bg-surface dark:bg-elevated border border-app-border rounded-md"
            data-testid="browser-download-entry"
          >
            {isDone ? (
              <Check size={12} className="text-green-600 dark:text-green-400 flex-shrink-0" />
            ) : isFailed ? (
              <XIcon size={12} className="text-red-600 dark:text-red-400 flex-shrink-0" />
            ) : (
              <Loader2 size={12} className="animate-spin text-app-text-muted flex-shrink-0" />
            )}
            <span className="truncate max-w-[160px] text-app-text" title={d.filename}>{d.filename}</span>
            {!isDone && !isFailed && d.totalBytes > 0 && (
              <span className="text-app-text-muted tabular-nums">{pct}%</span>
            )}
            {isDone && d.savedPath && (
              <button
                type="button"
                onClick={() => showInFolder(d.savedPath!)}
                className="ml-1 w-4 h-4 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-muted"
                title="Show in folder"
              >
                <FolderOpen size={11} />
              </button>
            )}
            <button
              type="button"
              onClick={() => dismiss(d.id)}
              className="ml-1 w-4 h-4 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-muted"
              title="Dismiss"
            >
              <XIcon size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
