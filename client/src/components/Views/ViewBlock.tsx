/**
 * A generative view inside the chat transcript (GENUI-01).
 *
 * Lifted out of the tool run like a page the agent opened (CHAT-BROWSER-01):
 * a view is a RESULT, the thing the reader came for, and folded inside «N
 * actions» it would be the 602-of-624 story again. The header says what it is
 * and offers the same view as a page, opened as a tab of the Topics browser
 * (or the system browser with the usual modifier gesture).
 */
import { memo, Suspense, type MouseEvent } from 'react';
import { ArrowUpRight, LayoutGrid, ListOrdered, Table2 } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { openLink, isExternalLinkGesture } from '../../lib/openLink';
import { viewSummary, type ViewSpec } from '../../../../shared/views';
import { lazyWarm } from '../../lib/lazyWarm';
import { viewPageUrl } from './viewRoute';

// The renderers are a chunk of their own: a chat without views does not pay
// for three of them in the eager bundle (`check:bundle`). The header above is
// eager, so the block keeps its place while the body arrives.
// Destructured with `await` so knip sees which export is read (check:deadcode-blindspots).
const loadViewBody = async () => {
  const { ViewBody } = await import('./ViewBody');
  return { ViewBody };
};
const ViewBody = lazyWarm(loadViewBody, (m) => m.ViewBody);

export const ViewBlock = memo(function ViewBlock({ spec, viewId }: { spec: ViewSpec; viewId?: string }) {
  const tr = useT();
  const locale = useLocale();
  const pageUrl = viewId ? viewPageUrl(viewId) : null;
  const summary = viewSummary(spec);
  const KindIcon = spec.view === 'table' ? Table2 : spec.view === 'timeline' ? ListOrdered : LayoutGrid;
  return (
    <div
      data-testid="view-block"
      data-view={spec.view}
      data-view-id={viewId ?? ''}
      className="my-2 rounded-lg border border-app-border bg-app-bg p-3"
    >
      <div className="mb-2 flex items-center gap-2 text-mini text-app-text-muted">
        <KindIcon size={12} aria-hidden />
        <span>{tr(`views.${summary.kind}.kind`, { n: summary.count })}</span>
        {pageUrl && (
          <a
            data-testid="view-open-page"
            href={pageUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e: MouseEvent<HTMLAnchorElement>) => {
              e.preventDefault();
              openLink(pageUrl, { external: isExternalLinkGesture(e), origin: e.target });
            }}
            className="ml-auto inline-flex min-h-7 items-center gap-1 rounded px-1.5 font-medium text-app-text-secondary hover:bg-app-hover hover:text-app-text coarse:min-h-11"
          >
            {tr('views.openPage')}
            <ArrowUpRight size={12} aria-hidden />
          </a>
        )}
      </div>
      <Suspense fallback={<div className="min-h-24" aria-busy="true" />}>
        <ViewBody spec={spec} variant="chat" locale={locale} />
      </Suspense>
    </div>
  );
});
