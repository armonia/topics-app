/**
 * Native-browser permission bar.
 *
 * Camera / microphone / geolocation / screen-capture requests from sites in the
 * native browser pane are default-DENIED in the Electron main process
 * (electron-app/main.ts setPermissionRequestHandler) and surfaced here for an
 * explicit user decision — the app no longer silently auto-grants them. Mirrors
 * the DownloadStrip IPC pattern. Hidden in web mode (no electronAPI.browserNative).
 */
import { useEffect, useState, useCallback } from 'react';
import { ShieldAlert, Check, X as XIcon } from 'lucide-react';

interface PermissionRequest {
  requestId: string;
  permission: string;
  url: string;
  partitionId: string;
}

// main auto-denies an unanswered request after 30s; drop the bar a beat earlier
// so a stale prompt can't "grant" after the callback has already fired closed.
const AUTO_DISMISS_MS = 29_000;

const PERMISSION_LABELS: Record<string, string> = {
  media: 'use your camera & microphone',
  geolocation: 'access your location',
  'display-capture': 'capture your screen',
  notifications: 'show notifications',
  midi: 'access MIDI devices',
  midiSysex: 'access MIDI devices',
};

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function PermissionBar() {
  const [requests, setRequests] = useState<PermissionRequest[]>([]);

  useEffect(() => {
    const api = window.electronAPI?.browserNative;
    if (!api?.onPermissionRequest) return;
    return api.onPermissionRequest((info) => {
      setRequests((prev) =>
        prev.some((r) => r.requestId === info.requestId) ? prev : [...prev, info],
      );
      setTimeout(() => {
        setRequests((prev) => prev.filter((r) => r.requestId !== info.requestId));
      }, AUTO_DISMISS_MS);
    });
  }, []);

  const respond = useCallback((requestId: string, granted: boolean) => {
    window.electronAPI?.browserNative?.respondPermission?.(requestId, granted);
    setRequests((prev) => prev.filter((r) => r.requestId !== requestId));
  }, []);

  if (requests.length === 0) return null;

  return (
    <div className="flex flex-col" data-testid="browser-permission-bar">
      {requests.map((r) => (
        <div
          key={r.requestId}
          className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 dark:bg-amber-950/40 border-t border-amber-300/60 dark:border-amber-800/60 text-[11px]"
          data-testid="browser-permission-entry"
        >
          <ShieldAlert size={13} className="text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <span className="text-app-text truncate">
            <span className="font-medium">{hostOf(r.url)}</span> wants to{' '}
            {PERMISSION_LABELS[r.permission] ?? `use ${r.permission}`}
          </span>
          <div className="ml-auto flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              onClick={() => respond(r.requestId, true)}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-amber-600 hover:bg-amber-700 text-white"
              data-testid="browser-permission-allow"
            >
              <Check size={11} /> Allow
            </button>
            <button
              type="button"
              onClick={() => respond(r.requestId, false)}
              className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 text-app-text-muted"
              data-testid="browser-permission-deny"
            >
              <XIcon size={11} /> Deny
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
