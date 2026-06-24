/**
 * OverlayHost — the React entry rendered in the transparent overlay-host window
 * (the app loaded with `?overlay=1`; see electron-app/overlay-host.ts).
 *
 * It is a DUMB modal renderer: it shows nothing until the main renderer sends
 * an `overlay-host:render` payload, then mounts the requested modal with the
 * data snapshot from that payload. Every modal action is relayed back to the
 * main renderer over one generic channel (`overlay-host.action`), so the real
 * callback runs there — no shared store/WS in this window. Esc / backdrop close
 * tells main to clear its open flag.
 *
 * Why a separate window: a native browser pane is an OS-level WebContentsView
 * composited above the main window's DOM, so a modal in the main renderer would
 * be hidden behind the live page. This window is always-on-top, so its modal
 * paints above the browser.
 */
import { useEffect, useState } from 'react';
import { CommandPalette } from './components/Shared/CommandPalette';
import type { Topic } from './types';
import type { ClosedTabRecord } from './state/pane/adapters';
import type { OverlayHostState } from './types/electron-api';

interface CommandPaletteData {
  scope?: 'all' | 'projects';
  topics: Record<string, Topic>;
  workspaceProjects?: string[];
  themeMode: string;
  dark?: boolean;
  projectPath?: string;
  enableNewChat?: boolean;
  closedTabs?: ClosedTabRecord[];
}

export function OverlayHostApp() {
  const [state, setState] = useState<OverlayHostState | null>(null);

  useEffect(() => {
    const off = window.electronAPI?.overlayHost?.onRender((s) => {
      // Sync the theme class so Tailwind dark/light matches the main window.
      if (s?.data && typeof s.data === 'object') {
        const d = s.data as CommandPaletteData;
        document.documentElement.classList.toggle('dark', !!d.dark);
      }
      setState(s);
    });
    return off;
  }, []);

  const relay = (type: string, ...args: unknown[]) => {
    window.electronAPI?.overlayHost?.action({ type, args });
  };
  const close = () => {
    window.electronAPI?.overlayHost?.closed();
    setState(null);
  };
  /** Relay an action then close — ⌘K commands dismiss the palette on selection. */
  const act = (type: string, ...args: unknown[]) => { relay(type, ...args); close(); };

  if (!state) return null;

  if (state.modal === 'command-palette') {
    const d = state.data as CommandPaletteData;
    return (
      <CommandPalette
        isOpen
        onClose={close}
        scope={d.scope}
        topics={d.topics}
        workspaceProjects={d.workspaceProjects}
        themeMode={d.themeMode}
        projectPath={d.projectPath}
        enableNewChat={d.enableNewChat}
        isElectron
        closedTabs={d.closedTabs}
        onOpenTopic={(id) => act('onOpenTopic', id)}
        onOpenProject={(p) => act('onOpenProject', p)}
        onNewTopic={() => act('onNewTopic')}
        onNewProject={() => act('onNewProject')}
        onNewClaude={() => act('onNewClaude')}
        onNewCodex={() => act('onNewCodex')}
        onNewTerminal={() => act('onNewTerminal')}
        onToggleTheme={() => relay('onToggleTheme')}
        onOpenSettings={() => act('onOpenSettings')}
        onOpenFileSearch={() => act('onOpenFileSearch')}
        onOpenFile={(path, line) => act('onOpenFile', path, line)}
        onReopenClosedTab={(rec) => act('onReopenClosedTab', rec)}
      />
    );
  }

  return null;
}
