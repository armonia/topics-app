/**
 * A generative view inside the chat transcript (GENUI-01).
 *
 * Lifted out of the tool run like a page the agent opened (CHAT-BROWSER-01):
 * a view is a RESULT, the thing the reader came for, and folded inside «N
 * actions» it would be the 602-of-624 story again. The header says what it is
 * and offers the same view as a page, opened as a tab of the Topics browser
 * (or the system browser with the usual modifier gesture).
 */
import { memo, type MouseEvent } from 'react';
import { ArrowUpRight, LayoutGrid } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { openLink, isExternalLinkGesture } from '../../lib/openLink';
import type { ViewSpec } from '../../../../shared/views';
import { CompareView } from './CompareView';
import { viewPageUrl } from './viewRoute';

export const ViewBlock = memo(function ViewBlock({ spec, viewId }: { spec: ViewSpec; viewId?: string }) {
  const tr = useT();
  const locale = useLocale();
  const pageUrl = viewId ? viewPageUrl(viewId) : null;
  return (
    <div
      data-testid="view-block"
      data-view={spec.view}
      data-view-id={viewId ?? ''}
      className="my-2 rounded-lg border border-app-border bg-app-bg p-3"
    >
      <div className="mb-2 flex items-center gap-2 text-mini text-app-text-muted">
        <LayoutGrid size={12} aria-hidden />
        <span>{tr('views.compare.kind', { n: spec.options.length })}</span>
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
      <CompareView spec={spec} variant="chat" locale={locale} />
    </div>
  );
});
