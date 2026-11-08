import { useSyncExternalStore } from 'react';
import { Globe2 } from 'lucide-react';
import { forgetKeptSite, keptSites, subscribeKeptSites } from '@/lib/keptSites';
import { useT } from '@/hooks/useT';
import { LevelHeading } from './PreferenceRow';

/**
 * THE SITES KEPT ALWAYS LIVE, and the gesture to stop keeping one.
 *
 * A heavy tab's pause card can keep its site live «always», and until now
 * nothing listed those sites or took one back: a choice made once, in a hurry,
 * held forever. They live with the performance figures because they are a
 * performance decision: each one is a page that never sleeps. Nothing to list,
 * nothing drawn.
 */
export function KeptSites() {
  const tr = useT();
  const sites = useSyncExternalStore(subscribeKeptSites, keptSites, keptSites);
  if (sites.length === 0) return null;
  return (
    <div data-testid="kept-sites" className="border-t border-app-border py-1">
      <LevelHeading>{tr('perf.keptSites.title')}</LevelHeading>
      {sites.map((origin) => (
        <div key={origin} data-testid="kept-site" className="flex items-center gap-2 px-3 py-1 text-compact coarse:min-h-11">
          <Globe2 size={12} className="shrink-0 text-app-text-muted" />
          <span className="min-w-0 flex-1 truncate text-app-text" title={origin}>{origin.replace(/^https?:\/\//, '')}</span>
          <button
            type="button"
            data-testid="kept-site-forget"
            onClick={() => forgetKeptSite(origin)}
            className="flex-shrink-0 rounded px-1.5 py-0.5 text-mini text-app-text-secondary hover:bg-app-hover hover:text-app-text coarse:min-h-11 coarse:px-3"
          >
            {tr('perf.keptSites.forget')}
          </button>
        </div>
      ))}
    </div>
  );
}
