/**
 * Settings: general, appearance, sector package, product, security, where it runs, anonymization, compliance, start-up.
 * The words of the `settings` area of the preview; values in `i18n-ui-settings-it.ts`
 * and `i18n-ui-settings-en.ts`. Only product words: sector words arrive with the data.
 */
import type {
  DeployId, FunctionId, PrincipleId, ProtectionId, ProtectionState, RegionId, StandardGroup, StandardStatus,
  StartupStepId, TermId,
} from '../settings/model';

type Kind = 'goal' | 'estimate' | 'example';
type AnonCat = 'fiscal-code' | 'vat-iban' | 'names' | 'contacts';

export interface SettingsCopy {
  common: {
    kinds: Record<Kind, string>;
    open: string;
    add: string;
    remove: string;
    cancel: string;
    save: string;
    clear: string;
    clearFilters: string;
    exampleData: string;
    /** «Name: saved» toast title. */
    saved: (what: string) => string;
    /** Log line for a setting that changed. */
    changedTo: (what: string, value: string) => string;
    on: string;
    off: string;
    done: string;
    failed: string;
  };
  general: {
    identity: { title: string; name: string; shortName: string; shortNameHint: string; legalForm: string; legalSource: string; seat: string };
    regional: { title: string; language: string; languages: { it: string; en: string }; languageNote: string; timeZone: string };
    notifications: { title: string; intro: string; items: Record<'deadlines' | 'failures' | 'digest' | 'jobs', { label: string; description: string }> };
    facts: { title: string; intro: (source: string) => string; labels: Record<'founded' | 'area' | 'network' | 'basins' | 'ponds' | 'irrigation' | 'staff', string> };
    preview: {
      title: string;
      body: string;
      reset: string;
      confirmTitle: string;
      confirmBody: string;
      confirmLabel: string;
      toast: string;
      toastBody: string;
    };
  };
  appearance: {
    intro: string;
    theme: { title: string; options: { light: { label: string; hint: string }; dark: { label: string; hint: string }; system: { label: string; hint: string } } };
    density: { title: string; hint: string; options: { compact: string; comfortable: string; spacious: string } };
    motion: { label: string; description: string };
    preview: { title: string; sidebar: string; rows: string[] };
    changed: (label: string) => string;
  };
  product: {
    intro: string;
    principles: Record<PrincipleId, { name: string; text: string; measure: string }>;
    functionsTitle: string;
    functionsSub: string;
    search: string;
    filters: { all: string; active: string; testing: string; next: string };
    columns: { area: string; status: string; exists: string; toBuild: string; base: string };
    status: { active: string; testing: string; next: string };
    functions: Record<FunctionId, { name: string; exists: string; toBuild: string; base: string }>;
    openIn: (name: string) => string;
    count: (shown: number, total: number) => string;
    empty: { title: string; body: (q: string) => string };
  };
  sector: {
    intro: string;
    packagesTitle: string;
    badges: { active: string; example: string; preview: string };
    activate: (name: string) => string;
    isActive: string;
    vocab: {
      title: string;
      intro: (pkg: string) => string;
      columns: { generic: string; word: string; other: (pkg: string) => string };
      terms: Record<TermId, string>;
      editLabel: (term: string) => string;
      reset: string;
      resetAll: string;
      search: string;
      empty: string;
      edited: string;
    };
    preview: { title: string; intro: (pkg: string) => string; lines: (w: Record<TermId, string>) => Array<{ where: string; text: string }> };
    brings: {
      title: (pkg: string) => string;
      caseTypes: string;
      templates: string;
      connections: string;
      norms: string;
      standards: string;
      perMonth: (n: number) => string;
      undefined: string;
      useTemplate: string;
      openFlow: string;
      openPrograms: string;
      openKnowledge: string;
      openStandards: string;
      count: (n: number) => string;
    };
    confirm: { title: (name: string) => string; body: (name: string) => string; label: string; toast: (name: string) => string; toastBody: string };
    help: Array<{ title: string; text: string }>;
    log: { word: (term: string, from: string, to: string) => string; wordReset: (term: string) => string; allReset: string; activated: (name: string) => string };
  };
  startup: {
    title: (org: string) => string;
    internal: string;
    progress: (since: string, today: string, week: number, total: number) => string;
    states: { done: string; current: string; next: string; later: string; always: string };
    weeks: (a: number, b: number) => string;
    from: (day: string) => string;
    panel: {
      stepTag: (n: number) => string;
      tasks: string;
      tasksDone: (done: number, total: number) => string;
      progress: string;
      interviewed: string;
      of: (a: number, b: number) => string;
      activities: string;
      documented: string;
      documentedValue: (n: number, pct: number) => string;
      next: string;
      interviewWith: (office: string) => string;
      today: string;
      markDone: string;
      openInterview: string;
      plan: string;
      noneScheduled: string;
      allScheduled: string;
      doneOn: (day: string) => string;
      completeStep: string;
    };
    links: Record<StartupStepId, string>;
    openMap: string;
    confirm: { title: (step: string) => string; body: string; label: string };
    toasts: { stepDone: (step: string) => string; interviewDone: (office: string) => string; planned: (office: string) => string };
    notify: { stepDone: (step: string) => string; body: string };
    log: { stepDone: (step: string) => string; interviewDone: (office: string) => string; planned: (office: string) => string; task: (task: string, on: boolean) => string };
  };
  security: {
    kpis: Array<{ label: string; value: string; detail: string }>;
    lastCheck: (when: string) => string;
    checkNow: string;
    checkJob: { title: string; steps: string[]; done: string; doneBody: string };
    access: {
      title: string;
      twoFactor: { label: string; description: string; confirmOff: { title: string; body: string; label: string } };
      sessions: {
        title: string;
        current: string;
        lastSeen: (minutes: number) => string;
        signOut: string;
        signOutOthers: string;
        empty: string;
        confirm: { title: string; body: string; label: string };
        confirmAll: { title: string; body: string; label: string };
        toast: string;
      };
      passkeys: {
        title: string;
        add: string;
        remove: string;
        created: (day: string) => string;
        empty: string;
        newName: (n: number) => string;
        job: { title: string; steps: string[]; done: string };
        confirm: { title: string; body: string; label: string };
      };
      ip: {
        title: string;
        toggle: string;
        description: string;
        placeholder: string;
        add: string;
        invalid: string;
        duplicate: string;
        empty: string;
        confirmOn: { title: string; body: string; label: string };
        newNote: string;
      };
    };
    data: {
      title: string;
      region: string;
      backupRegion: string;
      sameRegion: string;
      regions: Record<RegionId, string>;
      encryptedAtRest: string;
      encryptedInTransit: string;
      backup: { title: string; last: (when: string) => string; keep: (days: number) => string; run: string; job: { title: string; steps: string[]; done: string } };
    };
    robots: {
      title: string;
      robots: string;
      robotsValue: (n: number, total: number) => string;
      secrets: string;
      connectors: string;
      connectorsValue: (n: number) => string;
      injection: string;
      password: (robot: string) => string;
      renewed: (when: string) => string;
      /** The robot password Halley changed on 05/11 and nobody renewed since. */
      expired: (when: string) => string;
      renew: string;
      job: { title: string; steps: string[]; done: string };
    };
    speed: {
      title: string;
      badge: string;
      columns: { step: string; median: string; p95: string; limit: string };
      seconds: (n: number) => string;
      note: string;
    };
  };
  hosting: {
    intro: string;
    deployments: Record<DeployId, { name: string; text: string }>;
    states: { current: string; possible: string; onRequest: string; requested: (day: string) => string };
    facts: { labels: { data: string; ai: string; upkeep: string; pcs: string }; values: Record<DeployId, { data: string; ai: string; upkeep: string; pcs: string }> };
    whatChanges: (name: string) => string;
    request: {
      button: (name: string) => string;
      cancel: string;
      confirm: { title: (name: string) => string; body: (name: string) => string; label: string };
      job: { title: (name: string) => string; steps: string[] };
      receiptTitle: string;
      receiptLine: (name: string, ref: string, day: string) => string;
      toast: (name: string) => string;
      cancelled: string;
    };
    level: { title: string; names: { base: string; raised: string; high: string }; summary: (on: number, total: number) => string; note: string };
    protections: { title: string; columns: { name: string; how: string; state: string }; items: Record<ProtectionId, { name: string; how: string }> };
    protectionStates: Record<ProtectionState, string>;
    actions: { enable: string; evaluate: string; complete: string };
    protectionJob: { title: (name: string) => string; steps: string[]; done: (name: string) => string; evaluating: (name: string) => string };
    side: {
      tag: (org: string) => string;
      title: Record<DeployId, string>;
      text: string;
      noVm: { title: string; text: string };
      notPromised: { title: string; text: string };
    };
  };
  anonymization: {
    tabs: { see: string; rules: string; try: string };
    see: { inTopics: string; stays: string; example: string; sent: string; leaves: string; reply: string; fromAi: string; inTopicsLabel: string; clear: string };
    rules: {
      columns: { data: string; how: string; becomes: string; monthly: string };
      categories: Record<AnonCat, { name: string; how: string; becomes: string }>;
      cadastral: { name: string; how: string; becomes: string };
      total: string;
      toggled: (name: string, on: boolean) => string;
      custom: { title: string; hint: string; placeholder: string; add: string; empty: string; remove: (term: string) => string; becomes: string; duplicate: string };
      exceptions: { title: string; health: string; healthValue: string; table: string; tableValue: string };
    };
    try: {
      intro: string;
      placeholder: string;
      useSample: string;
      clear: string;
      input: string;
      output: string;
      empty: { title: string; body: string };
      found: (n: number) => string;
      none: string;
      table: { title: string; note: string; token: string; value: string; masked: string; clear: string };
    };
    side: {
      chip: string;
      chipOff: string;
      masterLabel: string;
      how: { title: string; text: string };
      goals: { title: string; real: string; realValue: string; sample: string; sampleValue: string; overhead: string; overheadValue: (ms: number) => string };
      base: { title: string; text: string };
      confirmOff: { title: string; body: string; label: string };
      offWarning: string;
    };
    fallbackReply: string;
  };
  compliance: {
    scopes: { nocera: string; orbit: string; topics: string };
    groups: Record<StandardGroup, string>;
    columns: { standard: string; about: string; how: string; proof: string; state: string };
    statuses: Record<StandardStatus, string>;
    items: Record<'gdpr' | 'iso27001' | 'acn' | 'nis2' | 'iso25012' | 'iso8000' | 'aiact' | 'iso42001' | 'wcag', { about: string; how: string; proof: string }>;
    search: string;
    allStatuses: string;
    empty: { title: string; body: string };
    verify: string;
    checkedOn: (day: string) => string;
    verifyJob: { title: (name: string) => string; steps: string[] };
    results: {
      pass: (name: string, day: string) => string;
      external: string;
      fail: (name: string) => string;
      failBody: Record<'gdpr' | 'iso8000' | 'wcag', string>;
    };
    detail: { tag: string; lastCheck: (day: string) => string; proofTitle: string; openProof: string; download: string; downloaded: (file: string) => string; howTitle: string; close: string };
    summary: { title: string; covered: string; progress: string; others: string };
    legend: { title: string; covered: string; todo: string; others: string };
    fromWhere: { title: string; text: string };
    notPromised: { title: string; text: string };
    export: { button: string; job: { title: string; steps: string[] }; receiptTitle: string; receiptLine: (file: string, n: number) => string; toast: string; file: (day: string) => string };
  };
  search: Record<
    'generale' | 'aspetto' | 'prodotto' | 'settore' | 'avvio' | 'sicurezza' | 'dove-gira' | 'anonimizzazione' | 'conformita', // allow-italian: address slugs of the settings sections
    { title: string; detail: string; keywords: string }
  >;
}
