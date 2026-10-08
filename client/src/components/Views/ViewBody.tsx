/**
 * The catalog: one renderer per view kind, the same for the chat block and the
 * standalone page. A kind added to `shared/views.ts` without a branch here is
 * a type error (`never` below), not a blank block.
 */
import type { ViewSpec } from '../../../../shared/views';
import { CompareView } from './CompareView';
import { TableView } from './TableView';
import { TimelineView } from './TimelineView';
import type { ViewVariant } from './ViewChrome';

export function ViewBody({ spec, variant, locale }: { spec: ViewSpec; variant: ViewVariant; locale: string }) {
  switch (spec.view) {
    case 'compare': return <CompareView spec={spec} variant={variant} locale={locale} />;
    case 'table': return <TableView spec={spec} variant={variant} locale={locale} />;
    case 'timeline': return <TimelineView spec={spec} variant={variant} locale={locale} />;
    default: {
      const never: never = spec;
      return never;
    }
  }
}
