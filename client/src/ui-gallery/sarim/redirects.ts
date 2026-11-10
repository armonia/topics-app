/**
 * The addresses of the SARIM edition that moved (8/11: the old day page folded into the
 * list of cards, contracts and data under the knowledge section, the groups of
 * the list became flows, the settings of the person went to the preferences):
 * each old address lands on the place that took its content, once, without a
 * new history entry. The container applies them (`app/Container.tsx`), the
 * crawler and the walk open the old ones to prove it.
 *
 * The group of an old address becomes a `flusso` token on the main flow of that
 * group (and the old stage a `stato` token), written under the key of the (allow-italian: quotes a field id)
 * filters of the list before the view draws. A card has no list to filter, so
 * its address carries no token. Patterns are spelled out one by one where a
 * parameter would also match a new address: a redirect must never answer an
 * address that exists.
 */
import { world } from './world';
import type { Params, RedirectDef } from '../app/kit';
import { INBOX_FILTERS_KEY, inboxFilters } from './model/dafare';
import { SP } from './paths';

/** The old groups of the list and the main flow each one stands for. */
const GROUP_FLOW: Record<string, string | undefined> = {
  tutti: undefined, // allow-italian: old address segment, compared by value
  ...world().legacyGroupFlows,
};

const filtersOf = (group: string, stage?: string) => ({ [INBOX_FILTERS_KEY]: inboxFilters(GROUP_FLOW[group], stage) });

/** The old addresses of the list for one group. */
function groupRedirects(group: string): RedirectDef[] {
  return [
    { from: `/da-fare/${group}`, to: () => SP.inboxKanban(), ui: () => filtersOf(group) },
    { from: `/da-fare/${group}/elenco`, to: () => SP.inbox(), ui: () => filtersOf(group) }, // allow-italian: old address segment, not shown
    { from: `/da-fare/${group}/andamento`, to: () => SP.inboxStages(), ui: () => filtersOf(group) }, // allow-italian: old address segment, not shown
    { from: `/da-fare/${group}/fase/:stage`, to: () => SP.inboxKanban(), ui: (p: Params) => filtersOf(group, p.stage) },
    { from: `/da-fare/${group}/card/:card`, to: (p) => SP.card(p.card) }, // allow-italian: old address segment, not shown
    { from: `/da-fare/${group}/card/:card/originale/:doc`, to: (p) => SP.cardOriginal(p.card, p.doc) }, // allow-italian: old address segment, not shown
  ];
}

/** The old documents of «Conoscenza», one by one: `/conoscenza/documenti` must not be read as the document «documenti». */
const DOC_REDIRECTS: RedirectDef[] = world().knowledge.docs.flatMap((doc): RedirectDef[] => [
  { from: `/conoscenza/${doc.id}`, to: () => SP.knowledgeDoc(doc.id) },
  { from: `/conoscenza/${doc.id}/:part`, to: (p) => SP.knowledgeDoc(doc.id, p.part) },
]);

export const SARIM_REDIRECTS: RedirectDef[] = [
  { from: '/oggi', to: () => SP.home() }, // allow-italian: old address segment, not shown
  ...Object.keys(GROUP_FLOW).flatMap(groupRedirects),

  { from: '/contratti', to: () => SP.contracts() }, // allow-italian: old address segment, not shown
  { from: '/contratti/scadenze', to: () => SP.contractDeadlines() }, // allow-italian: old address segment, not shown
  { from: '/contratti/:id', to: (p) => (p.id === 'scadenze' ? SP.contractDeadlines() : SP.contract(p.id)) }, // allow-italian: old address segment, not shown
  { from: '/contratti/:id/clausola/:clause', to: (p) => SP.clause(p.id, p.clause) }, // allow-italian: old address segment, not shown
  { from: '/contratti/:id/versioni', to: (p) => SP.versions(p.id) }, // allow-italian: old address segment, not shown
  { from: '/contratti/:id/confronto/:from/:to', to: (p) => SP.compare(p.id, Number(p.from), Number(p.to)) }, // allow-italian: old address segment, not shown
  { from: '/contratti/:id/allegati/:doc', to: (p) => SP.attachment(p.id, p.doc) }, // allow-italian: old address segment, not shown
  { from: '/contratti/:id/firme', to: (p) => SP.signatures(p.id) }, // allow-italian: old address segment, not shown

  { from: '/dati', to: () => SP.data() }, // allow-italian: old address segment, not shown
  { from: '/dati/scadenzario', to: () => SP.deadlines() }, // allow-italian: old address segment, not shown
  { from: '/dati/:table', to: (p) => (p.table === 'scadenzario' ? SP.deadlines() : SP.data(p.table)) }, // allow-italian: old address segment, not shown
  { from: '/dati/:table/:row', to: (p) => SP.dataRow(p.table, p.row) }, // allow-italian: old address segment, not shown

  { from: '/conoscenza', to: () => SP.knowledge() }, // allow-italian: old address segment, not shown
  ...DOC_REDIRECTS,

  { from: '/impostazioni/generale', to: () => SP.prefs('aspetto') }, // allow-italian: old address segment, not shown
  { from: '/impostazioni/aspetto', to: () => SP.prefs('aspetto') }, // allow-italian: old address segment, not shown
  { from: '/impostazioni/avvisi', to: () => SP.prefs('notifiche') }, // allow-italian: old address segment, not shown
  { from: '/impostazioni/principio', to: () => SP.settings('agenti') }, // allow-italian: old address segment, not shown
];
