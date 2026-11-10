import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { CrumbModel } from '../types';
import { EmptyState } from '../primitives/EmptyState';
import { PaneHeader } from './PaneHeader';

/**
 * A pane for a place of the preview that is not built yet, or an example whose
 * data is not loaded: the usual header, then an honest empty state that says
 * so and offers the way on.
 */
export function PlaceholderScreen({ crumbs, icon, title, body, action, leading }: {
  crumbs: CrumbModel[];
  icon?: LucideIcon;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  leading?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={crumbs} leading={leading} />
      <EmptyState icon={icon} title={title} action={action}>{body}</EmptyState>
    </div>
  );
}
