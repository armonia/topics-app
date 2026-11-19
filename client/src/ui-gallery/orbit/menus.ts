/**
 * The two menus of the SARIM shell (`ia-sarim.md`). The menu of the
 * organization (right click or ⋯ on the SARIM row) holds what is shared and
 * configured once: settings, team, permissions, log. The menu of the person
 * (the foot of the sidebar) holds what is theirs alone: how the app looks,
 * what reaches them, who they use it as, the way out.
 */
import { Bell, CheckCheck, History, LogOut, Monitor, Moon, Palette, RotateCcw, Settings, ShieldCheck, Sun, UserRoundCog, Users } from 'lucide-react';
import type { Permission } from '../../ui/fixtures/org/people';
import { personaById, teamIdOfPerson, world } from './world';
import type { ShellMenuCtx, ShellMenuItem, UserMenuModel } from '../app/kit';
import type { Theme } from '../app/store/state';
import { roleOf } from '../app/store/permissions';
import { SP } from './paths';

type Mode = 'light' | 'dark' | 'system';

/** The theme the system asks for, read when the choice is made. */
function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** An item that opens a place; off, with the reason on hover, when the person may not. */
function place(m: ShellMenuCtx, item: Omit<ShellMenuItem, 'run' | 'disabled' | 'title'>, path: string, needs: Permission): ShellMenuItem {
  const { ctx } = m;
  const allowed = ctx.can(needs);
  return { ...item, disabled: !allowed, title: allowed ? undefined : ctx.deniedTitle(needs), run: () => ctx.go(path) };
}

export function sarimOrgMenu(m: ShellMenuCtx): ShellMenuItem[] {
  const o = m.ctx.copy.sarimShell.org;
  const items: ShellMenuItem[] = [
    place(m, { id: 'settings', label: o.settings, icon: Settings }, SP.settings(), 'view:settings'),
    place(m, { id: 'team', label: o.team, icon: Users }, SP.team(), 'view:team'),
    place(m, { id: 'permissions', label: o.permissions, icon: ShieldCheck }, SP.teamPermissions(), 'view:team'),
    place(m, { id: 'log', label: o.log, icon: History }, SP.settings('registro'), 'view:settings'),
  ];
  if (m.unread > 0) {
    items.push({ id: 'sep-read', label: '', separator: true });
    items.push({ id: 'mark-read', label: o.markAllRead, icon: CheckCheck, hint: String(m.unread), run: m.markAllRead });
  }
  return items;
}

export function sarimUserMenu(m: ShellMenuCtx): UserMenuModel {
  const { ctx } = m;
  const u = ctx.copy.sarimShell.user;
  const r = ctx.copy.sarimShell;
  const me = personaById(ctx.persona.id);
  const [followSystem, setFollowSystem] = ctx.ui<boolean>('aspetto.system', false);
  const mode: Mode = followSystem ? 'system' : ctx.state.theme;
  const choose = (next: Mode) => () => {
    setFollowSystem(next === 'system');
    ctx.dispatch({ type: 'theme', theme: next === 'system' ? systemTheme() : next });
  };
  const reset = () => ctx.confirm({
    title: r.resetConfirm.title,
    body: r.resetConfirm.body,
    confirmLabel: r.resetConfirm.confirm,
    tone: 'danger',
    onConfirm: () => {
      ctx.dispatch({ type: 'reset' });
      ctx.toast({ tone: 'ok', title: r.resetConfirm.toast, body: r.resetConfirm.toastBody });
      ctx.go(SP.home());
    },
  });
  const signOut = () => ctx.confirm({
    title: r.signOutConfirm.title,
    body: r.signOutConfirm.body,
    confirmLabel: r.signOutConfirm.confirm,
    onConfirm: () => ctx.go(SP.signedOut()),
  });
  return {
    label: u.menu,
    header: {
      id: me ? 'profile' : undefined,
      monogram: ctx.persona.monogram,
      color: ctx.persona.color,
      title: ctx.persona.name,
      /* The team the person works in, as in Squadra; the role only when the person has no team. */
      detail: world().people.teams.find((t) => t.id === teamIdOfPerson(ctx.persona.id))?.label ?? roleOf(ctx.persona)?.label,
    },
    onHeader: me ? () => ctx.go(SP.person(me.id)) : undefined,
    items: [
      { id: 'appearance', label: u.appearance, icon: Palette, run: () => ctx.go(SP.prefs('aspetto')) },
      { id: 'notifications', label: u.notifications, icon: Bell, run: () => ctx.go(SP.prefs('notifiche')) },
      { id: 'sep-theme', label: '', separator: true },
      { id: 'heading-theme', label: u.theme, heading: true },
      { id: 'theme-light', label: u.themeLight, icon: Sun, checked: mode === 'light', run: choose('light') },
      { id: 'theme-dark', label: u.themeDark, icon: Moon, checked: mode === 'dark', run: choose('dark') },
      { id: 'theme-system', label: u.themeSystem, icon: Monitor, checked: mode === 'system', run: choose('system') },
      { id: 'sep-person', label: '', separator: true },
      { id: 'enter-as', label: u.enterAs, icon: UserRoundCog, hint: u.enterAsHint, run: m.openPersonaSwitch },
      { id: 'reset', label: u.resetDemo, icon: RotateCcw, run: reset },
      { id: 'sep-out', label: '', separator: true },
      { id: 'sign-out', label: u.signOut, icon: LogOut, run: signOut },
    ],
  };
}
