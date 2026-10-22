/**
 * The words of the generative views (GENUI), in Italian.
 *
 * In `shared/` and not in the chat catalogue alone because two renderers read
 * them: the client's components (spread into the chat catalogue) and the
 * server's self-contained page for MCP Apps hosts (`server/views/view-html.ts`),
 * which has no client to translate for it.
 */
export const VIEWS_IT: Record<string, string> = {
  'views.compare.kind': 'Confronto · {n} opzioni',
  'views.table.kind': 'Tabella · {n} righe',
  'views.timeline.kind': 'Piano · {n} tappe',
  'views.timeline.or': 'Oppure',
  'views.timeline.deadline': 'Scadenza',
  'views.mode.walk': 'A piedi',
  'views.mode.bus': 'Bus',
  'views.mode.train': 'Treno',
  'views.mode.metro': 'Metro',
  'views.mode.plane': 'Volo',
  'views.mode.taxi': 'Taxi',
  'views.mode.car': 'Auto',
  'views.mode.boat': 'Traghetto',
  'views.mode.wait': 'Attesa',
  'views.mode.stay': 'Soggiorno',
  'views.mode.other': 'Tappa',
  'views.recommended': 'Consigliata',
  'views.verdict': 'Verdetto',
  'views.openPage': 'Apri come pagina',
  'views.openLink': 'Apri',
  'views.pro': 'A favore',
  'views.con': 'Contro',
  'views.metric.best': 'il migliore',
  'views.metric.worst': 'il peggiore',
  'views.metric.missing': 'n/d',
  'views.gallery.prev': 'Foto precedente',
  'views.gallery.next': 'Foto successiva',
  'views.gallery.count': '{i} di {n}',
  'views.gallery.label': 'Foto di {title}',
  'views.page.loading': 'Caricamento della vista',
  'views.page.notFound': 'Questa vista non esiste più.',
  'views.page.from': 'Vista creata in Topics il {date}',
  'views.page.openInTopics': 'Apri in Topics',
};
