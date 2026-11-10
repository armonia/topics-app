/**
 * The places the container owns: the full results of a search (`/cerca/:q`) (allow-italian: quotes the Italian interface)
 * and the launcher of a new tab (`/nuova`). (allow-italian: quotes the Italian interface)
 */
import type { NavKind } from '../../../ui/types';
import type { AreaModule, Params, ScreenCtx, SearchEntry } from '../kit';
import { NewTabScreen } from '../../../ui/shell/NewTabScreen';
import type { OrgKey } from '../../../ui/fixtures/org/types';
import { isSearchKind } from '../search';
import { resultsPath } from '../palette';
import { ResultsPage } from './search-results';
import { P } from '../paths';
import type { SurfaceEntry } from '../edition';

/** Set by the container: what search can find for the current person. */
export interface PlacesHooks {
  entries: (ctx: ScreenCtx) => SearchEntry[];
  placeOf: (path: string, ctx: ScreenCtx) => { label: string; kind: NavKind } | undefined;
  /** The organization these places belong to: the edition's own. */
  org: OrgKey;
  /** Every surface the person may open, as the sidebar lists them. */
  surfaces: (ctx: ScreenCtx) => SurfaceEntry[];
}

export function appPlaces(hooks: PlacesHooks): AreaModule {
  const sampleQueries = hooks.org === 'nocera' ? ['2418', 'art. 9'] : ['variante', 'FIR'];
  const results = (p: Params, ctx: ScreenCtx) => <ResultsPage q={p.q} kind={isSearchKind(p.kind) ? p.kind : undefined} ctx={ctx} entries={hooks.entries(ctx)} />;
  return {
    screens: [
      {
        id: 'search', path: '/cerca/:q', org: hooks.org, nav: 'search', samples: sampleQueries.map((q) => P.search(q)),
        tabKey: () => 'search',
        tab: () => ({ kind: 'search' }),
        title: (p) => p.q,
        render: results,
      },
      {
        id: 'search', path: '/cerca/:q/:kind', org: hooks.org, nav: 'search', samples: [resultsPath(sampleQueries[0], 'card')],
        tabKey: () => 'search',
        tab: () => ({ kind: 'search' }),
        title: (p, ctx) => (isSearchKind(p.kind) ? ctx.copy.app.search.kindTitle(ctx.copy.app.search.groups[p.kind], p.q) : p.q),
        render: results,
      },
      {
        id: 'new-tab', path: '/nuova', org: hooks.org, nav: 'new', samples: [P.newTab()],
        tabKey: () => 'new',
        tab: () => ({ kind: 'new' }),
        title: (_p, ctx) => ctx.copy.shell.addTab,
        render: (_p, ctx) => {
          const recent = ctx.state.recent
            .filter((path) => path !== P.newTab())
            .map((path) => ({ path, place: hooks.placeOf(path, ctx) }))
            .flatMap((r) => (r.place ? [{ id: r.path, ...r.place }] : []))
            .slice(0, 6);
          const surfaces = hooks.surfaces(ctx);
          return (
            <NewTabScreen
              title={ctx.copy.app.newTab.title}
              copy={ctx.copy}
              groups={[
                { id: 'recent', label: ctx.copy.app.newTab.recent, items: recent },
                { id: 'places', label: ctx.copy.app.newTab.places, items: surfaces },
              ]}
              onOpen={(path) => ctx.go(path)}
            />
          );
        },
      },
    ],
  };
}
