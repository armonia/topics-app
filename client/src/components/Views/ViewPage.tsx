/**
 * The standalone page of a generative view: `/v/<id>` (GENUI-01).
 *
 * The same `ViewBody` the chat draws, given the room of a page. It mounts
 * its own small React tree from `main.tsx` and nothing of the app (no panes,
 * no socket, no sidebar): it is something to look at, share on the LAN, or
 * keep open beside the chat. The theme comes from `boot.js` like the app's,
 * so dark stays dark.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useLocale, useT } from '../../hooks/useT';
import { apiFetch } from '../../lib/shell/net';
import { parseViewSpec, type ViewSpec } from '../../../../shared/views';
import { ViewBody } from './ViewBody';

type Loaded = { state: 'loading' } | { state: 'missing' } | { state: 'ready'; spec: ViewSpec; createdAt?: string };

export function ViewPage({ id }: { id: string }) {
  const tr = useT();
  const locale = useLocale();
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });

  useEffect(() => {
    let live = true;
    apiFetch(`/api/views/${id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { spec?: unknown; createdAt?: string };
        const spec = parseViewSpec(body.spec);
        if (!live) return;
        setLoaded(spec ? { state: 'ready', spec, createdAt: body.createdAt } : { state: 'missing' });
      })
      .catch(() => { if (live) setLoaded({ state: 'missing' }); });
    return () => { live = false; };
  }, [id]);

  useEffect(() => {
    if (loaded.state === 'ready') document.title = loaded.spec.title;
  }, [loaded]);

  return (
    // The app root is fixed and clips; a page scrolls, so it brings its own scroller.
    <div data-testid="view-page" className="h-full overflow-y-auto bg-app-bg text-app-text">
      <main className="mx-auto w-full max-w-6xl px-4 pb-10 pt-6 sm:px-6">
        {loaded.state === 'loading' && (
          <p role="status" className="text-compact text-app-text-muted">{tr('views.page.loading')}</p>
        )}
        {loaded.state === 'missing' && (
          <p role="alert" data-testid="view-page-missing" className="text-body-lg text-app-text">{tr('views.page.notFound')}</p>
        )}
        {loaded.state === 'ready' && (
          <>
            <ViewBody spec={loaded.spec} variant="page" locale={locale} />
            {loaded.createdAt && (
              <footer className="mt-6 border-t border-app-border pt-3 text-mini text-app-text-muted">
                {tr('views.page.from', { date: new Date(loaded.createdAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) })}
              </footer>
            )}
          </>
        )}
      </main>
    </div>
  );
}

export function mountViewPage(container: HTMLElement, id: string): void {
  createRoot(container).render(
    <StrictMode>
      <ViewPage id={id} />
    </StrictMode>,
  );
}
