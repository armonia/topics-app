import { useEffect, useState } from 'react';
import { X, Circle } from 'lucide-react';

/**
 * Phase 30 BROWSER-CHAT-04 — per-topic browser tab card for the sidebar.
 * Displays a live thumbnail (refreshed via the snapshot REST endpoint every 2s),
 * the truncated current URL, and a 'live' badge when the agent is acting on
 * the browser. The actual sidebar mounting is OUT OF SCOPE for this plan;
 * the component is exported here so plan 30-05 (or a follow-up UX phase) can
 * place it without re-implementing the thumbnail polling.
 */

interface BrowserSidebarTabProps {
  contextId: string;
  url: string;
  agentActive: boolean;
  onClick: () => void;
  onClose: () => void;
}

export function BrowserSidebarTab({ contextId, url, agentActive, onClick, onClose }: BrowserSidebarTabProps) {
  const [thumb, setThumb] = useState<string | null>(null);

  // Thumbnail polling — uses the existing /api/browsers/:id/snapshot endpoint
  // (cheap CDP-driven JPEG). Cancellable on unmount; ?t= query bypasses HTTP
  // caching so the user sees a fresh frame each refresh.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (cancelled) return;
      const img = new Image();
      img.onload = () => {
        if (!cancelled) setThumb(img.src);
      };
      img.onerror = () => {
        // keep prev thumbnail on transient error
      };
      img.src = `/api/browsers/${encodeURIComponent(contextId)}/snapshot?t=${Date.now()}`;
    };
    refresh();
    const t = setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [contextId]);

  const truncatedUrl = url.length > 30 ? url.slice(0, 27) + '…' : url;

  return (
    <div
      onClick={onClick}
      className="group relative flex items-center gap-2 px-2 py-1.5 hover:bg-app-hover rounded cursor-pointer"
      data-testid="browser-sidebar-tab"
    >
      {thumb ? (
        <img
          src={thumb}
          alt=""
          className="w-20 h-15 object-cover rounded border border-app-border"
        />
      ) : (
        <div className="w-20 h-15 bg-surface border border-app-border rounded" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-app-text truncate">{truncatedUrl || 'about:blank'}</div>
        {agentActive && (
          <div className="flex items-center gap-1 text-[11px] text-red-500">
            <Circle size={6} className="fill-red-500" />
            live
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-app-hover-strong rounded"
        title="Close browser"
        data-testid="browser-sidebar-tab-close"
      >
        <X size={12} />
      </button>
    </div>
  );
}
