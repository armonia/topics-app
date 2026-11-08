/**
 * The words of the generative views (GENUI), in English.
 *
 * In `shared/` and not in the chat catalogue alone because two renderers read
 * them: the client's components (spread into the chat catalogue) and the
 * server's self-contained page for MCP Apps hosts (`server/views/view-html.ts`),
 * which has no client to translate for it.
 */
export const VIEWS_EN: Record<string, string> = {
  'views.compare.kind': 'Comparison · {n} options',
  'views.table.kind': 'Table · {n} rows',
  'views.timeline.kind': 'Plan · {n} steps',
  'views.timeline.or': 'Or',
  'views.timeline.deadline': 'Deadline',
  'views.mode.walk': 'On foot',
  'views.mode.bus': 'Bus',
  'views.mode.train': 'Train',
  'views.mode.metro': 'Metro',
  'views.mode.plane': 'Flight',
  'views.mode.taxi': 'Taxi',
  'views.mode.car': 'Car',
  'views.mode.boat': 'Ferry',
  'views.mode.wait': 'Wait',
  'views.mode.stay': 'Stay',
  'views.mode.other': 'Step',
  'views.recommended': 'Recommended',
  'views.verdict': 'Verdict',
  'views.openPage': 'Open as page',
  'views.openLink': 'Open',
  'views.pro': 'In favour',
  'views.con': 'Against',
  'views.metric.best': 'the best',
  'views.metric.worst': 'the worst',
  'views.metric.missing': 'n/a',
  'views.gallery.prev': 'Previous photo',
  'views.gallery.next': 'Next photo',
  'views.gallery.count': '{i} of {n}',
  'views.gallery.label': 'Photos of {title}',
  'views.page.loading': 'Loading the view',
  'views.page.notFound': 'This view no longer exists.',
  'views.page.from': 'View created in Topics on {date}',
  'views.page.openInTopics': 'Open in Topics',
};
