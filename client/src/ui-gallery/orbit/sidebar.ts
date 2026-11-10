/**
 * The sidebar of the ORBIT edition: ORBIT is the only organization, so there
 * is one group, always open, with the surfaces the person's role may open and
 * no selector of other organizations. Four rows: «Da fare», «Flussi», (allow-italian: quotes the Italian interface)
 * «Conoscenza» (documents, contracts, data, rules) and «Programmi»; the team,
 * the settings and the log live in the menu of the ORBIT row (`menus.ts`).
 * «Da fare» counts what waits for this person, from the same live cards the (allow-italian: quotes the Italian interface)
 * kanban draws; the system strip counts the stopped cards, the flows that run and
 * the cards in the agents' hands, each number once and with its unit.
 */
import type { NavItemModel, SidebarModel } from '../../ui/types';
import type { Permission, Persona } from '../../ui/fixtures/org/people';
import { world } from './world';
import type { DemoState } from '../app/store/state';
import type { NavId } from '../app/kit';
import { DEMO_NOW } from '../../ui/fixtures/org/clock';
import { stuckCards } from './model/stages';
import { agentsInHand, runningFlows } from './model/flows';
import { liveCards, waitingFor } from './model/live';
import { SP } from './paths';
import type { ChatCopy } from '../../ui/copy/chat';
import { CHAT_COPY_EN } from '../../ui/copy/i18n-ui-chat-en';
import { CHAT_COPY_IT } from '../../ui/copy/i18n-ui-chat-it';
import { allChats, chatAge } from './model/chats';

/** The surfaces of ORBIT, in sidebar order, with their address. */
export const ORBIT_NAV: Array<[NavId & NavItemModel['kind'], string]> = [
  ['inbox', SP.inbox()], ['flows', SP.flows()], ['knowledge', SP.knowledge()], ['programs', SP.programs()],
];

/** What opens a row: «Conoscenza» holds documents, contracts, data and rules, so any of those lets the person in. */
const NAV_NEEDS: Record<string, Permission[]> = {
  knowledge: ['view:knowledge', 'view:contracts', 'view:data'],
};

/** Whether the person may open the surface of a sidebar row. */
export function canOpenNav(kind: string, can: (p: Permission) => boolean): boolean {
  return (NAV_NEEDS[kind] ?? [`view:${kind}` as Permission]).some((p) => can(p));
}

/** The rows of the chats, under their heading: the latest three, then all of them (the «+» of the heading starts a new one). */
const RECENT_CHATS = 3;

/** The longest title a chat row shows before it is cut at a word. */
const ROW_TITLE_CHARS = 22;

/** A title cut at a word, never in the middle of one, and never ending on an article or a preposition. */
function rowTitle(title: string, stop: readonly string[]): string {
  if (title.length <= ROW_TITLE_CHARS) return title;
  const words = title.split(' ');
  const kept: string[] = [];
  for (const w of words) {
    if ([...kept, w].join(' ').length > ROW_TITLE_CHARS - 1) break;
    kept.push(w);
  }
  while (kept.length > 1 && stop.includes(kept[kept.length - 1].toLowerCase())) kept.pop();
  return `${(kept.length ? kept : [title.slice(0, ROW_TITLE_CHARS - 1)]).join(' ')}\u2026`;
}

/** A role or a person without the mark «(esempio)»: the mark belongs to the tooltip and to the team page, not to the foot of the sidebar. allow-italian: quotes the words on screen */
const withoutExampleMark = (name: string): string => name.replace(/\s*\(esempio\)\s*$/i, ''); // allow-italian: the mark of the fixture data

/** The words of the chat rows: the sidebar is drawn without the copy of the container, so it picks the language the same way it is saved. */
function chatWords(state: DemoState): ChatCopy {
  /* A `?lang=` in the address wins over the saved choice, as it does for the container. */
  const asked = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('lang');
  const saved = (state.slices['settings.general'] as { language?: 'it' | 'en' } | undefined)?.language;
  return (asked ?? saved) === 'en' ? CHAT_COPY_EN : CHAT_COPY_IT;
}

/** The row an open chat lights: the page of one conversation lights its own row when it is one of the latest, else the row of all the chats. */
function chatRowOf(activeId: string | undefined, state: DemoState, shown: string[]): string | undefined {
  if (activeId !== 'chat:all') return activeId;
  const open = /^\/chat\/([^/]+)$/.exec(state.recent[0] ?? '')?.[1];
  const id = open && decodeURIComponent(open);
  return id && shown.includes(id) ? `chat:${id}` : activeId;
}

export function orbitRowPath(id: string): string | undefined {
  if (id === 'chat:new') return SP.chatNew();
  if (id === 'chat:all') return SP.chats();
  if (id.startsWith('chat:')) return SP.chat(id.slice(5));
  if (id.startsWith('pin:')) return SP.program(id.slice(4));
  if (id === world().key) return SP.home();
  const nav = id.split('/')[1];
  return ORBIT_NAV.find(([n]) => n === nav)?.[1];
}

export function orbitSidebar(state: DemoState, persona: Persona, can: (p: Permission) => boolean, activeId: string | undefined): SidebarModel {
  const cards = liveCards(state);
  const mine = waitingFor(cards, persona.id);
  const nav = ORBIT_NAV.filter(([kind]) => canOpenNav(kind, can)).map(([kind]): NavItemModel => ({
    id: `${world().key}/${kind}`,
    kind,
    count: kind === 'inbox' && mine.length ? mine.length : undefined,
    urgent: kind === 'inbox' && mine.some((c) => c.priority === 'alta'),
  }));
  /* Running = active and not paused, in hand to the agents = the open cards an agent holds (the same definition as the saved filter of «Da fare»). (allow-italian: quotes the Italian interface) */
  const live = runningFlows(state).length;
  const inHand = agentsInHand(cards).length;
  /* Stopped = blocked, or too long in the same column: the same count as the kanban and the stages view. */
  const blocked = stuckCards(cards, DEMO_NOW).length;
  /* Each number is written once, with its unit: the stopped cards are the headline, the flows are the detail, the agents' cards the only pair. */
  const flowsLine = `${live} flussi attivi su ${world().opsFlows.length}`; // allow-italian: fixture data, shown as written
  const numbers: Array<[string, string]> = [['agli agenti', `${inHand} card`]]; // allow-italian: fixture data, shown as written
  const words = chatWords(state);
  const recent = allChats(state, { copy: words, state, persona, now: DEMO_NOW }, false).slice(0, RECENT_CHATS);
  const chats = [
    ...recent.map((c) => ({ id: `chat:${c.id}`, title: rowTitle(c.title, words.titleStop), age: chatAge(c.at, words) })),
    { id: 'chat:all', title: words.allChats },
  ];
  return {
    orgs: [{
      id: world().key,
      name: world().name,
      monogram: world().monogram,
      color: world().color,
      nav,
      chats,
      newChatActive: activeId === 'chat:new',
      expanded: true,
      attention: mine.length ? 'needs-you' : undefined,
      count: mine.length || undefined,
    }],
    activeId: chatRowOf(activeId, state, recent.map((c) => c.id)),
    system: can('view:flows')
      ? blocked
        ? { tone: 'warn', headline: blocked === 1 ? '1 card ferma' : `${blocked} card ferme`, detail: flowsLine, numbers } // allow-italian: fixture data, shown as written
        : { tone: 'ok', headline: 'Tutto ok', detail: flowsLine, numbers } // allow-italian: fixture data, shown as written
      : undefined,
    identity: { name: withoutExampleMark(persona.name), monogram: persona.monogram, color: persona.color, detail: world().name, tip: persona.name },
  };
}
