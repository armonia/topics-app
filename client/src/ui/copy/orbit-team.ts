/**
 * SARIM edition, area «Squadra»: the teams with their leader and numbers, the
 * page of one team, and the permission matrix (rows = sections, flows and
 * actions, columns = teams, a cell = a level). The person and agent pages keep
 * their words in `sarimAdmin.team`.
 * Values in `i18n-ui-sarim-team-it.ts` and `i18n-ui-sarim-team-en.ts`.
 */
/** The ids the matrix is made of: the same as `AccessLevel`, `AccessSection` and `AccessAction` of the app. */
type Level = 'none' | 'view' | 'work' | 'manage';
type Section = 'inbox' | 'flows' | 'documents' | 'contracts' | 'data' | 'rules' | 'programs';
type Action = 'approve:contracts' | 'sign:contracts' | 'export' | 'admin';

export interface SarimTeamCopy {
  title: string;
  /** The accessible name of the strip under the header (Team, Permessi). */
  navLabel: string;
  nav: { team: string; permissions: string };
  /** The name of the team the six agents of Topics form. */
  agentsTeam: string;
  /** The badge of the person who leads a team. */
  lead: string;
  people: (n: number) => string;
  agents: (n: number) => string;
  inHand: (n: number) => string;
  waiting: (n: number) => string;
  /** The team a person belongs to, on a person's page. */
  teamOf: string;
  filters: {
    team: string;
    person: string;
    inHand: string;
    yes: string;
    no: string;
    withCards: string;
    onlyAgents: string;
  };
  empty: { title: string; body: string; clear: string };
  page: {
    notFound: string;
    notFoundBody: string;
    back: string;
    openList: string;
    stats: { people: (n: number) => string; agents: (n: number) => string; inHand: string; waiting: string; flows: string };
    peopleTitle: string;
    agentsTitle: string;
    flowsTitle: string;
    flowsNone: string;
    flowsAgents: string;
    openFlow: string;
    permissionsTitle: string;
    sectionsLabel: string;
    actionsLabel: string;
    actionsNone: string;
    openPermissions: string;
    openInHand: string;
  };
  levels: Record<Level, { label: string; hint: string }>;
  permissions: {
    crumb: string;
    matrixTitle: string;
    matrixLabel: string;
    rowColumn: string;
    /** The label of the team picker the matrix gives way to on a phone. */
    teamPick: string;
    groups: { sections: string; flows: string; actions: string };
    sections: Record<Section, string>;
    actions: Record<Action, { label: string; hint: string }>;
    yes: string;
    no: string;
    cellTitle: (team: string, row: string) => string;
    changed: string;
    onlyAdmin: string;
    agentsRow: { label: string; does: string; never: string };
    logLevel: (team: string, row: string, level: string) => string;
    logAction: (team: string, row: string, on: boolean) => string;
    toastLevel: (team: string, row: string, level: string) => string;
    toastAction: (team: string, row: string, on: boolean) => string;
    selfAdminTitle: string;
    selfAdminBody: string;
    selfAdminConfirm: string;
    reset: string;
    resetNone: string;
    resetTitle: string;
    resetBody: (n: number) => string;
    resetConfirm: string;
    resetToast: string;
    resetLog: (n: number) => string;
    previewTitle: string;
    previewPerson: string;
    previewSees: string;
    previewCan: string;
    previewNothing: string;
    previewCards: (shown: number, total: number) => string;
    recentTitle: string;
    recentEmpty: string;
    exceptions: {
      title: string;
      empty: string;
      add: string;
      dialogTitle: string;
      person: string;
      row: string;
      level: string;
      confirm: string;
      cancel: string;
      remove: (person: string, row: string) => string;
      rowOf: (kind: 'section' | 'flow' | 'action', name: string) => string;
      rowLabel: (person: string, row: string) => string;
      duplicate: string;
      logAdd: (person: string, row: string, value: string) => string;
      logChange: (person: string, row: string, value: string) => string;
      logRemove: (person: string, row: string) => string;
      toastAdd: (person: string) => string;
      toastRemove: (person: string) => string;
    };
  };
  /** On a person's page: the permissions in brief. */
  person: {
    permissionsTitle: string;
    team: string;
    can: string;
    exceptions: string;
    noExceptions: string;
    open: string;
  };
}
