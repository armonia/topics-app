import type { ReactNode } from 'react';

/**
 * The window of Topics: the sidebar on the chrome surface, a 4px seam, and the
 * main column (tab strip, then the pane) on the content surface. With no
 * sidebar the main column takes the whole window, as a detached pane does.
 */
export function AppFrame({ sidebar, tabBar, children }: { sidebar?: ReactNode; tabBar?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full w-full overflow-hidden bg-app-chrome font-sans text-prose text-app-text antialiased">
      {sidebar}
      {sidebar && <div className="w-1 shrink-0 bg-app-border-light" aria-hidden="true" />}
      <main className="flex min-w-0 flex-1 flex-col bg-surface">
        {tabBar}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </main>
    </div>
  );
}
