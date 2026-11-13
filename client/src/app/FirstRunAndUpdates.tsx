import { Suspense, type ComponentType, type Dispatch, type SetStateAction } from 'react';
import { HomePanelHost } from '../components/Settings/HomePanelHost';
import { UpdaterToast } from '../components/UpdaterToast';
import { DevBundleToast } from '../components/DevBundleToast';
import { ReloadedFlash } from '../components/ReloadedFlash';
import { ToastOutlet } from '../components/Shared/Toast';
import { ChangelogModal, FirstRunHost } from './lazyHosts';

interface FirstRunAndUpdatesProps {
  /** The DEV-only pane-store overlay, once loaded. */
  DevOverlay: ComponentType | null;
  sidebarCollapsed: boolean;
  showChangelogFromMenu: string | null;
  setShowChangelogFromMenu: Dispatch<SetStateAction<string | null>>;
}

/** The first-run screen, the update and reload prompts, and the root toast outlet. */
export function FirstRunAndUpdates({
  DevOverlay, sidebarCollapsed, showChangelogFromMenu, setShowChangelogFromMenu,
}: FirstRunAndUpdatesProps) {
  return (
    <>
      {/* The one host of the forms that live where they are used: providers,
          tools, calendar (SETHOME-01). */}
      <HomePanelHost />
      <Suspense fallback={null}><FirstRunHost /></Suspense>

      {import.meta.env.DEV && DevOverlay && <DevOverlay />}

      {/* Phase E · UpdaterToast (rendered at root, listens to electron-updater) */}
      <UpdaterToast />
      {/* In-page bundle refresh prompt (dev rebuilds + stale-chunk 404s),
          the manual-reload replacement for the old silent auto-reload. */}
      <DevBundleToast docked={!sidebarCollapsed} />
      {/* «Reloaded» ACK after a user-requested reload: a reload that redraws
          the same screen, without a word, reads as «it is broken». */}
      <ReloadedFlash />

      {/* Root-level fallback outlet for global notifications (e.g. agent
          completion). When a scoped outlet (ProjectWindow's) is mounted,
          this one stays hidden to avoid double-rendering, the scoped
          outlet wins and toasts appear inside the project pane. */}
      <ToastOutlet fixed fallback />

      {/* The changelog, opened from the phone menu's «Version» entry.
          Same modal as the desktop: on the Mac it is reached from the number in
          the status bar, which under 768px no longer exists. */}
      {showChangelogFromMenu !== null && (
        <Suspense fallback={null}>
          <ChangelogModal currentVersion={showChangelogFromMenu} onClose={() => setShowChangelogFromMenu(null)} />
        </Suspense>
      )}
    </>
  );
}
