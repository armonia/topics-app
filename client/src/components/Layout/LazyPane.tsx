/**
 * LazyPane — `<Suspense fallback={spinner}>` wrapper used by every
 * lazy-loaded pane body in the layout layer (ProjectWindow,
 * StandaloneChatGroup, ChatPanel, …).
 *
 * Before extraction the same five-line wrapper was repeated 12+ times
 * across the codebase. Centralised here so adding a new lazy pane is
 * `<LazyPane><MyNewPane /></LazyPane>` instead of remembering the
 * fallback markup; and the spinner styling can be tweaked in one
 * place.
 */

import { Suspense, type ReactNode } from 'react';

/** Small inline spinner used as the Suspense fallback. */
export const LazySpinner = (
  <div className="flex items-center justify-center h-full">
    <div className="w-4 h-4 border-2 border-app-border-light border-t-primary rounded-full animate-spin" />
  </div>
);

export function LazyPane({ children }: { children: ReactNode }) {
  return <Suspense fallback={LazySpinner}>{children}</Suspense>;
}
