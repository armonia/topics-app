/**
 * Shell fixtures: the four organizations of the "organizzazioni" scenario
 * (`client/src/demo/scenarios/organizzazioni-data.ts`), seen by an Armonia
 * operator (all of them) and by an employee of the Consorzio (only their own
 * steps). Names and colours of the organizations are real; counts and ages are
 * an example, and the fixture keeps the values together.
 */
import type { OrgModel, SidebarModel, TabModel } from '../types';

/* Darker shades of the scenario colours: the monogram carries white text and
 * has to stay legible at 9px. */
const CONSORTIUM: Pick<OrgModel, 'id' | 'name' | 'monogram' | 'color'> = { id: 'org-nocera', name: 'Consorzio di Nocera', monogram: 'CN', color: '#15803d' };
const OTHERS: OrgModel[] = [
  { id: 'org-sarim', name: 'SARIM', monogram: 'SA', color: '#b45309', attention: 'needs-you', age: '4m', count: 4 },
  { id: 'org-armonia', name: 'Armonia', monogram: 'A', color: '#1f2937', age: '1g', count: 3 },
  { id: 'org-euro', name: 'Euro Impianti', monogram: 'EI', color: '#c53030', age: '1g' },
];

export type AdminSurface = 'nav-flows' | 'nav-data' | 'nav-knowledge' | 'nav-overview' | 'nav-views';

/** The operator's sidebar, with the surface of the screen selected. */
export function adminSidebar(activeId: AdminSurface): SidebarModel {
  return {
    inboxCount: 12,
    board: { flows: 13, inbox: 16 },
    pinned: [
      { id: 'pin-m365', label: 'Microsoft 365', monogram: 'M', color: '#c2410c' },
      { id: 'pin-pec', label: 'PEC', kind: 'mail' },
      { id: 'pin-halley', label: 'Halley', monogram: 'H', color: '#1d4ed8' },
      { id: 'pin-prunes', label: 'Prunes', monogram: 'P', color: '#92400e' },
    ],
    pinnedChats: [{ id: 'chat-pa', title: 'Piano commerciale PA' }], // allow-italian: fixture data, shown as written
    orgs: [
      {
        ...CONSORTIUM, expanded: true, attention: 'done', age: 'ora', count: 9, // allow-italian: fixture data, shown as written
        nav: [
          { id: 'nav-inbox', kind: 'inbox', count: 5 },
          { id: 'nav-flows', kind: 'flows', count: 6 },
          { id: 'nav-data', kind: 'data' },
          { id: 'nav-knowledge', kind: 'knowledge' },
          { id: 'nav-views', kind: 'views' },
          { id: 'nav-channels', kind: 'channels' },
          { id: 'nav-programs', kind: 'programs' },
          { id: 'nav-overview', kind: 'overview' },
          { id: 'nav-settings', kind: 'settings' },
        ],
        chats: [{ id: 'chat-fatture', title: 'Nuovo flusso: fatture', age: '2m', subagents: 1 }], // allow-italian: fixture data, shown as written
      },
      ...OTHERS,
    ],
    activeId,
    system: { tone: 'ok', headline: 'Tutto ok', detail: '5 flussi girano', numbers: [['robot', '3'], ['agenti PC', '2'], ['collaudi', '2']] }, // allow-italian: fixture data, shown as written
    identity: { name: 'Attilio', monogram: 'A', color: '#1f2937', detail: '4 organizzazioni' },
  };
}

/** The tabs of the operator's window, with the screen's own tab first. */
export function adminTabs(first: TabModel): TabModel[] {
  return [
    { ...first, active: true },
    { id: 'tab-2418', kind: 'record', label: 'Pratica 2418' },
    { id: 'tab-board', kind: 'board', label: 'Board', count: 16 },
  ];
}
