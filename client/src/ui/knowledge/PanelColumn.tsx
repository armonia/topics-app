import type { ReactNode } from 'react';
import { SidePanel } from '../primitives/Panel';

/**
 * The column on the right of a pane. On a phone it is not a column: it sits
 * under the content, full width, so nothing scrolls sideways.
 */
export function PanelColumn({ phone, width = 330, children }: { phone?: boolean; width?: number; children: ReactNode }) {
  if (phone) return <aside className="shrink-0 border-t border-app-border bg-surface">{children}</aside>;
  return <SidePanel width={width}>{children}</SidePanel>;
}
