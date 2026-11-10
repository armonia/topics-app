import type { SarimShellCopy } from './sarim-shell';
import { orgWords } from './org-words';

const W = orgWords();

/** English words of the SARIM organization and person menus. */
export const SARIM_SHELL_COPY_EN: SarimShellCopy = {
  orgMenu: `${W.name} menu`,
  org: {
    settings: 'Settings',
    team: 'Team',
    permissions: 'Permissions',
    log: 'Log',
    markAllRead: 'Mark all as read',
  },
  user: {
    menu: 'Your menu',
    appearance: 'Appearance',
    notifications: 'Notifications',
    theme: 'Theme',
    themeLight: 'Light',
    themeDark: 'Dark',
    themeSystem: 'System',
    enterAs: 'Enter as…',
    enterAsHint: 'example',
    resetDemo: 'Reset the demo',
    signOut: 'Sign out',
  },
  tabsMenu: 'All tabs',
  tabPreviewTip: 'Preview: double-click to keep it',
  access: {
    switchedBody: 'Sidebar, actions and data follow the permissions of this team.',
    body: (team) => `The team "${team}" cannot open it. Permissions are changed in Team, Permissions.`,
    deniedAction: (team) => `The team "${team}" cannot do this`,
  },
  resetConfirm: {
    title: 'Reset the demo?',
    body: 'What you changed in this preview is lost and it starts again from the initial data. Real data is not touched.',
    confirm: 'Reset',
    toast: 'Demo reset',
    toastBody: 'Starting again from the initial data.',
  },
  signOutConfirm: {
    title: `Sign out of ${W.name}?`,
    body: 'Your changes stay saved: signing back in picks up where you were.',
    confirm: 'Sign out',
  },
  signedOut: {
    title: `You signed out of ${W.name}`,
    body: 'Your changes stay saved. Come back whenever you like.',
    back: 'Sign back in',
  },
};
