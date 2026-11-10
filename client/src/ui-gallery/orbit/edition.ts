/**
 * The edition of one organization (`orbit.html`, `consorzio.html`): the same
 * container as the multi-organization preview, with that organization as the
 * only one. Its own areas, people, sidebar and notifications read the world
 * (`world.ts`); its own place in localStorage. Four rows in the sidebar (Da fare, Flussi, Conoscenza, Programmi); the (allow-italian: quotes the Italian interface)
 * menu of the organization's row holds its settings and team, the menu
 * of the person at the foot holds theirs (`menus.ts`).
 */
import { BookOpen, Inbox, Menu as MenuIcon, Search } from 'lucide-react';
import type { OrgWorld } from '../../ui/fixtures/world-types';
import type { Edition } from '../app/edition';
import { ORBIT_AREAS } from './registry';
import { ORBIT_ACCOUNT_AREA } from './screens/account';
import { ORBIT_NAV, canOpenNav, orbitRowPath, orbitSidebar } from './sidebar';
import { orbitOrgMenu, orbitUserMenu } from './menus';
import { orbitNotifications } from './notifications';
import { ORBIT_REDIRECTS } from './redirects';
import { SP } from './paths';

/**
 * The edition of the organization `w`. The screens read `world()`, so `w` is
 * the world the entry set with `setWorld()` before it imported this file.
 */
export function makeOrgEdition(w: OrgWorld, opts: { id: string; storageKey: string }): Edition {
  return {
    id: opts.id,
    storageKey: opts.storageKey,
    org: w.key,
    areas: [...ORBIT_AREAS, ORBIT_ACCOUNT_AREA],
    personas: w.people.personas,
    defaultPersona: w.people.defaultPersona,
    /* The foot of the sidebar names the person and nothing else: their role is in their menu. */
    sidebar: (state, persona, can, activeId) => orbitSidebar(state, persona, can, activeId),
    rowPath: orbitRowPath,
    notifications: orbitNotifications,
    surfaces: (ctx) => [
      ...ORBIT_NAV
        .filter(([kind]) => canOpenNav(kind, ctx.can))
        .map(([kind, path]) => ({ id: path, kind, label: ctx.copy.shell.nav[kind], detail: w.name })),
      /* Everyone may talk to the AI: a new tab offers a new chat among the surfaces. */
      { id: SP.chatNew(), kind: 'assistant' as const, label: ctx.copy.chat.newChat, detail: ctx.copy.app.search.suggest.newChatHint },
    ],
    redirects: ORBIT_REDIRECTS,
    orgMenu: orbitOrgMenu,
    userMenu: orbitUserMenu,
    phoneTabs: ({ copy, can, inboxCount }) => {
      const nav = copy.app.phone.nav;
      return [
        ...(can('view:inbox') ? [{ id: 'inbox', label: nav.inbox, icon: Inbox, path: SP.inbox(), litUnder: SP.inbox(), count: inboxCount }] : []),
        { id: 'search', label: nav.search, icon: Search },
        ...(canOpenNav('knowledge', can) ? [{ id: 'knowledge', label: copy.shell.nav.knowledge, icon: BookOpen, path: SP.knowledge(), litUnder: '/conoscenza' }] : []), // allow-italian: address segment, not shown
        { id: 'more', label: nav.more, icon: MenuIcon },
      ];
    },
  };
}
