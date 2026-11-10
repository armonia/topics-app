/**
 * An edition of the preview: which areas it has, who uses it, how its sidebar
 * reads, what it notifies at the start and where it keeps its state. The
 * container (`Container.tsx`) is the same for every edition; `app.html` runs
 * the multi-organization one (`NOCERA_EDITION`), `sarim.html` the one where
 * SARIM is the only organization (`client/src/ui-gallery/sarim/edition.ts`).
 */
import { CalendarCheck, Inbox, Kanban, Menu as MenuIcon, Search, Sun, type LucideIcon } from 'lucide-react';
import type { NavKind, SidebarModel } from '../../ui/types';
import type { UiCopy } from '../../ui/copy/types';
import type { OrgKey } from '../../ui/fixtures/org/types';
import type { Permission, Persona } from '../../ui/fixtures/org/people';
import { DEFAULT_PERSONA, ORGS, PERSONAS } from '../../ui/fixtures/org/people';
import type { AreaModule, RedirectDef, ScreenCtx, ShellMenuCtx, ShellMenuItem, UserMenuModel } from './kit';
import type { DemoState, NotificationEntry } from './store/state';
import { DEFAULT_STORAGE_KEY } from './store/persist';
import { AREAS } from './registry';
import { NAV_PATHS, pathOfSidebarRow, sidebarModel } from './sidebar';
import { seedNotifications } from './notifications';
import { P } from './paths';

/** A surface the launcher of a new tab offers, as the sidebar lists it. */
export interface SurfaceEntry {
  id: string;
  kind: NavKind;
  label: string;
  detail: string;
}

/** What an edition needs to decide the buttons of the phone's bottom bar. */
export interface PhoneTabsInput {
  copy: UiCopy;
  can: (p: Permission) => boolean;
  /** The current person's home address. */
  home: string;
  /** What waits for the person in the queue, for the badge. */
  inboxCount?: number;
}

/**
 * A button of the phone's bottom bar. The ids `search` and `more` are the
 * container's own actions (the search palette, the drawer with the sidebar) and
 * carry no path; every other button goes to its `path`.
 */
export interface PhoneTab {
  id: string;
  label: string;
  icon: LucideIcon;
  path?: string;
  /** The button is lit for this address and everything under it, not only for `path`. */
  litUnder?: string;
  count?: number;
}

export interface Edition {
  id: string;
  /** Where the state is kept in localStorage: two editions never read each other's. */
  storageKey: string;
  /** The organization the container's own places (search, new tab) belong to. */
  org: OrgKey;
  areas: AreaModule[];
  /** The people of the selector at the foot of the sidebar. */
  personas: Persona[];
  defaultPersona: string;
  sidebar: (state: DemoState, persona: Persona, can: (p: Permission) => boolean, activeId: string | undefined, expanded: string[]) => SidebarModel;
  /** The address of a sidebar row, by row id. */
  rowPath: (id: string) => string | undefined;
  notifications: () => NotificationEntry[];
  /** Every surface the person may open, for the new tab. */
  surfaces: (ctx: ScreenCtx) => SurfaceEntry[];
  /** The bottom bar of the phone, in order; the edition decides which buttons and for whom. */
  phoneTabs: (input: PhoneTabsInput) => PhoneTab[];
  /**
   * What belongs to the organization as a whole (the ⋯ button and right click
   * on its sidebar row). Absent: its row has no menu.
   */
  orgMenu?: (m: ShellMenuCtx) => ShellMenuItem[];
  /** The menu of the person at the foot of the sidebar. Absent: that row opens the change of person. */
  userMenu?: (m: ShellMenuCtx) => UserMenuModel;
  /** Addresses that moved, checked before the places (`kit.ts` RedirectDef). */
  redirects?: RedirectDef[];
}

export const NOCERA_EDITION: Edition = {
  id: 'nocera',
  storageKey: DEFAULT_STORAGE_KEY,
  org: 'nocera',
  areas: AREAS,
  personas: PERSONAS,
  defaultPersona: DEFAULT_PERSONA,
  sidebar: sidebarModel,
  rowPath: pathOfSidebarRow,
  notifications: seedNotifications,
  /* Every surface the person may open, organization by organization, as in the sidebar. */
  surfaces: (ctx) => ORGS.filter((o) => ctx.persona.orgs.includes(o.id)).flatMap((o) =>
    (NAV_PATHS[o.id] ?? [])
      .filter(([kind]) => ctx.can(`view:${kind}` as Permission))
      .map(([kind, path]) => ({ id: path, kind, label: ctx.copy.shell.nav[kind], detail: o.name })),
  ),
  phoneTabs: ({ copy, can, home, inboxCount }) => {
    const nav = copy.app.phone.nav;
    return [
      { id: 'today', label: nav.today, icon: can('view:today') ? Sun : CalendarCheck, path: can('view:today') ? P.today() : home },
      ...(can('view:inbox') ? [{ id: 'inbox', label: nav.inbox, icon: Inbox, path: P.inbox(), count: inboxCount }] : []),
      { id: 'search', label: nav.search, icon: Search },
      ...(can('view:board') ? [{ id: 'board', label: nav.board, icon: Kanban, path: P.board() }] : []),
      { id: 'more', label: nav.more, icon: MenuIcon },
    ];
  },
};
