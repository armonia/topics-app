import { ProgramSearchScreen, type SearchMode } from '../../../../ui/programs/ProgramSearchScreen';
import type { CatalogHitModel, WhereHitModel } from '../../../../ui/programs/model';
import {
  CATALOG_STATS, DEFAULT_CATALOG_QUERY, RECENTLY_ARCHIVED, WHERE_SUGGESTIONS, programSeed,
} from '../../../../ui/fixtures/programs';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { INITIAL_PROGRAMS } from './state';
import { facetsOf, searchCatalog, searchDocuments, withDefaults } from './derive';

const fetchJobId = (doc: string) => `programs.fetch.${doc}`;

/** p03: where a kind of document lives, and the catalogue of programs to add. */
export function ProgramSearchPage({ ctx }: { ctx: ScreenCtx }) {
  const c = ctx.copy.programs;
  const s = c.search;
  const [slice, update] = ctx.slice('programs', INITIAL_PROGRAMS);
  const st = withDefaults(slice);
  const [mode, setMode] = ctx.ui<SearchMode>('programs.search.mode', 'catalog');
  const [whereQ, setWhereQ] = ctx.ui('programs.search.q.where', '');
  const [catalogQ, setCatalogQ] = ctx.ui('programs.search.q.catalog', DEFAULT_CATALOG_QUERY);
  const [off, setOff] = ctx.ui<string[]>('programs.search.off', []);
  const [link, setLink] = ctx.ui('programs.search.link', '');
  const query = mode === 'where' ? whereQ : catalogQ;

  const whereHits: WhereHitModel[] = mode === 'where'
    ? searchDocuments(whereQ).map((d) => {
      const program = programSeed(d.program);
      const kind = program?.connection ?? 'file';
      const running = ctx.job(fetchJobId(d.id))?.status === 'running';
      return {
        id: d.id,
        document: d.document,
        holds: d.keywords,
        program: { id: d.program, name: program?.name ?? d.program, onOpen: () => ctx.go(P.program(d.program)) },
        path: d.path,
        fetch: d.fetch,
        fetchKind: kind,
        fetchLabel: c.common.connection[kind],
        fetched: st.fetched[d.id],
        busy: running,
        onFetch: ctx.allow('view:programs', () => ctx.startJob({
          id: fetchJobId(d.id),
          title: s.where.jobTitle(d.document),
          steps: s.where.steps[kind].map((label, i) => ({ label, ms: 600 + i * 150 })),
          onDone: () => {
            update((prev) => {
              const w = withDefaults(prev);
              return { ...w, fetched: { ...w.fetched, [d.id]: d.example } };
            });
            ctx.toast({ tone: 'ok', title: s.where.toast(d.document), body: d.example, action: { label: s.where.openProgram, path: P.program(d.program) } });
            ctx.log(s.where.log(d.document, program?.name ?? ''), 'access', P.programSearch());
          },
        })),
      };
    })
    : [];

  const catalogHits: CatalogHitModel[] = mode === 'catalog'
    ? searchCatalog(catalogQ, off).map((e) => {
      const archived = st.archived.includes(e.id);
      const inUse = e.tag === 'in-use' && e.program;
      return {
        id: e.id,
        initial: e.initial,
        color: e.color,
        name: e.name,
        maker: e.maker,
        tag: e.tag === 'in-use' ? { text: s.catalog.tags['in-use'], tone: 'green' as const } : e.tag === 'competitor' ? { text: s.catalog.tags.competitor, tone: 'neutral' as const } : undefined,
        description: e.description,
        connection: { kind: e.connection, label: e.connectionNote ?? c.common.connection[e.connection] },
        facts: e.facts,
        links: e.links.map((label) => ({ id: label, label })),
        archived,
        primaryLabel: inUse ? s.catalog.open : archived ? s.catalog.archived : s.catalog.archive,
        primaryIcon: inUse ? 'open' as const : 'plus' as const,
        onPrimary: inUse
          ? () => ctx.go(P.program(e.program as string))
          : ctx.allow('edit:structure', () => {
            update((prev) => {
              const w = withDefaults(prev);
              return { ...w, archived: archived ? w.archived.filter((id) => id !== e.id) : [...w.archived, e.id] };
            });
            if (!archived) {
              ctx.toast({ tone: 'ok', title: s.catalog.toastArchived(e.name), body: s.catalog.toastArchivedBody });
              ctx.log(s.catalog.log(e.name), 'knowledge', P.programSearch());
            }
          }),
      };
    })
    : [];

  const facets = mode === 'catalog'
    ? facetsOf(catalogQ).map((f) => ({ id: f.id, label: s.facet[f.rule.kind](f.rule.value), on: !off.includes(f.id) }))
    : [];

  const archivedEntries = st.archived.map((id) => searchCatalog('', []).find((e) => e.id === id)?.name).filter((n): n is string => Boolean(n));
  return (
    <ProgramSearchScreen
      copy={ctx.copy}
      mode={mode}
      onMode={setMode}
      query={query}
      onQuery={mode === 'where' ? setWhereQ : (q) => {
        setCatalogQ(q);
        setOff([]);
      }}
      suggestions={WHERE_SUGGESTIONS}
      onSuggestion={setWhereQ}
      facets={facets}
      onFacet={(id) => setOff(off.includes(id) ? off.filter((x) => x !== id) : [...off, id])}
      whereHits={whereHits}
      catalogHits={catalogHits}
      openLink={link || undefined}
      onLink={(hit, label) => setLink(link === `${hit}:${label}` ? '' : `${hit}:${label}`)}
      stats={[
        [s.side.programs, CATALOG_STATS.programs],
        [s.side.officialMcp, CATALOG_STATS.officialMcp],
        [s.side.api, CATALOG_STATS.api],
        [s.side.robotOrAgent, CATALOG_STATS.robotOrAgent],
      ]}
      latest={[...archivedEntries.map((name) => ({ name, where: s.side.todayShort })), ...RECENTLY_ARCHIVED]}
      backLabel={c.common.programs}
      onBack={() => ctx.go(P.programs())}
      onEmptyAction={() => {
        if (mode === 'where') {
          setCatalogQ(whereQ);
          setOff([]);
          setMode('catalog');
        } else {
          setOff([]);
        }
      }}
      phone={ctx.phone}
    />
  );
}
