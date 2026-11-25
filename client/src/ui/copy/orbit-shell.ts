/**
 * ORBIT edition: the menu of the organization (right click or the more
 * button on its sidebar row), the menu of the person at the foot of the
 * sidebar, and the page shown after signing out.
 * Values in `i18n-ui-orbit-shell-it.ts` and `i18n-ui-orbit-shell-en.ts`.
 */
export interface OrbitShellCopy {
  /** The accessible name of the organization's menu. */
  orgMenu: string;
  /** What belongs to the organization as a whole. */
  org: {
    settings: string;
    team: string;
    permissions: string;
    log: string;
    markAllRead: string;
  };
  /** What belongs to the person alone. */
  user: {
    /** The accessible name of the person's menu. */
    menu: string;
    appearance: string;
    notifications: string;
    theme: string;
    themeLight: string;
    themeDark: string;
    themeSystem: string;
    /** «Enter as…»: the change of person of the example. */
    enterAs: string;
    /** The quiet word next to it: the people there are made up. */
    enterAsHint: string;
    resetDemo: string;
    signOut: string;
  };
  /** The name of the menu that lists every tab when they do not all fit in the strip. */
  tabsMenu: string;
  /** The tooltip of the preview tab: it is replaced by the next place unless it is pinned, and how to pin it. */
  tabPreviewTip: string;
  /** What the messages about permissions say: in ORBIT a person's group is a team, not a role. */
  access: {
    switchedBody: string;
    /** The page a person may not open. */
    body: (team: string) => string;
    /** The tooltip of an action a person may not do. */
    deniedAction: (team: string) => string;
  };
  resetConfirm: { title: string; body: string; confirm: string; toast: string; toastBody: string };
  signOutConfirm: { title: string; body: string; confirm: string };
  /** The page at the address of signing out. */
  signedOut: { title: string; body: string; back: string };
}
