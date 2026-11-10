/**
 * The organizations preview as one app that moves like Topics. This is the
 * container: the only place with state and I/O (the address, history,
 * localStorage, timers, keyboard). The areas (`screens/*.tsx`) declare their
 * places and draw them from a `ScreenCtx`; the components of `client/src/ui/`
 * stay props-only.
 *
 * Tabs: one per surface, record or flow (the area may say otherwise). The
 * address after `#` names the place on show, so back/forward, a reload and a
 * shared link land on the same screen. Everything the reader changes is kept
 * in localStorage until «Ripristina demo» in Settings. (allow-italian: quotes the Italian interface)
 */
import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { Bell, Menu as MenuIcon, Search, Undo2 } from 'lucide-react';
import type { UiCopy } from '../../ui/copy/types';
import type { NavKind, UiTabKind, TabModel } from '../../ui/types';
import { AppFrame } from '../../ui/shell/AppFrame';
import { Sidebar } from '../../ui/shell/Sidebar';
import { TabBar } from '../../ui/shell/TabBar';
import { CommandPalette } from '../../ui/shell/CommandPalette';
import { NotificationsPanel } from '../../ui/shell/NotificationsPanel';
import { PersonaMenu } from '../../ui/shell/PersonaMenu';
import { UserMenu } from '../../ui/shell/UserMenu';
import { PhoneShell } from '../../ui/shell/PhoneShell';
import { NoAccess } from '../../ui/shell/NoAccess';
import { ToastStack } from '../../ui/primitives/Toast';
import { ConfirmDialog } from '../../ui/primitives/Dialog';
import { ErrorState } from '../../ui/primitives/States';
import { EmptyState } from '../../ui/primitives/EmptyState';
import { Button, IconButton } from '../../ui/primitives/Button';
import { DEMO_NOW, DEMO_TODAY } from '../../ui/fixtures/org/clock';
import type { Permission } from '../../ui/fixtures/org/people';
import type { AreaModule, ConfirmInput, Params, ScreenCtx, ScreenDef, SearchEntry, ShellMenuCtx, TabInfo, ToastInput } from './kit';
import { appPlaces } from './screens/app-places';
import { compile, match, pathOfHash, type Match } from './router';
import { compileRedirects, resolveRedirect, type CompiledRedirect } from './redirects';
import { initialState, reduce, type AuditEntry, type CaseLive, type DemoAction, type DemoState, type NotificationEntry } from './store/state';
import { loadState, saveState } from './store/persist';
import { canDo, personaOf, roleOf } from './store/permissions';
import type { Edition } from './edition';
import { buildPalette } from './palette';
import { NAV_ICON } from '../../ui/icons';
import { useJobs } from './useJobs';
import { TooltipLayer } from './TooltipLayer';
import { P } from './paths';

/* ---------- places ---------- */

const NAV_TAB: Partial<Record<string, UiTabKind>> = {
  today: 'today', inbox: 'inbox', flows: 'flows', data: 'data', knowledge: 'knowledge', views: 'views', channels: 'channels',
  programs: 'programs', overview: 'overview', settings: 'settings', board: 'board', callcenter: 'callcenter', org: 'org', search: 'search', new: 'new',
  contracts: 'contracts', team: 'team',
};

const NAV_KIND: Partial<Record<string, NavKind>> = {
  today: 'today', inbox: 'inbox', flows: 'flows', data: 'data', knowledge: 'knowledge', views: 'views', channels: 'channels',
  programs: 'programs', overview: 'overview', settings: 'settings', callcenter: 'callcenter', contracts: 'contracts', team: 'team',
};

/** An edition with its places compiled once: the areas plus the container's own places (search, new tab). */
interface Prepared {
  areas: AreaModule[];
  defs: ScreenDef[];
  table: ReturnType<typeof compile>;
  redirects: CompiledRedirect[];
  seed: NotificationEntry[];
}

const PREPARED = new Map<string, Prepared>();

/* Search and the new tab read the table of places, which includes them: the
   functions below are only called at render, after it exists. */
function prepare(edition: Edition): Prepared {
  const known = PREPARED.get(edition.id);
  if (known) return known;
  const prep = { areas: [], defs: [], table: [], redirects: [], seed: [] } as Prepared;
  prep.areas = [...edition.areas, appPlaces({ org: edition.org, surfaces: edition.surfaces, entries: (ctx) => searchAll(prep, ctx), placeOf: (path, ctx) => placeOf(prep, path, ctx) })];
  prep.defs = prep.areas.flatMap((a) => a.screens);
  prep.table = compile(prep.defs);
  prep.redirects = compileRedirects(edition.redirects);
  prep.seed = edition.notifications();
  PREPARED.set(edition.id, prep);
  return prep;
}

/** The id of the edition that joins every organization: the others are editions of one organization. */
const COMBINED_EDITION = 'nocera';

/** Every place of an edition, for the gallery and the tests (PascalCase so the fast-refresh rule reads it as part of this component module). */
export const PlacesOfEdition = (edition: Edition): ScreenDef[] => prepare(edition).defs;

/** Whether the person of `ctx` may open the place at `path`. */
function allowedPath(prep: Prepared, path: string, ctx: ScreenCtx): boolean {
  const m = match(prep.table, path);
  return !!m && ctx.persona.orgs.includes(m.def.org) && (!m.def.needs || ctx.can(m.def.needs));
}

/** Every search entry of every area the person may open. */
function searchAll(prep: Prepared, ctx: ScreenCtx): SearchEntry[] {
  return prep.areas.flatMap((a) => a.search?.(ctx) ?? []).filter((e) => (!e.needs || ctx.can(e.needs)) && allowedPath(prep, e.path, ctx));
}

/** The label and kind of the place at `path`, for the new tab's recent places. */
function placeOf(prep: Prepared, path: string, ctx: ScreenCtx): { label: string; kind: NavKind } | undefined {
  const m = match(prep.table, path);
  if (!m) return undefined;
  return { label: m.def.title(m.params, ctx), kind: NAV_KIND[m.def.nav] ?? 'overview' };
}

/** The id a place draws, set as `data-screen`. */
function screenIdOf(m: Match, ctx: ScreenCtx): string {
  return m.def.screenId?.(m.params, ctx) ?? m.def.id;
}

/** The place the app opens on: the gallery's, the address's, or the person's home. */
function firstPath(state: DemoState, embedPath: string | undefined): string {
  if (embedPath !== undefined) return embedPath;
  const fromHash = location.hash ? pathOfHash(location.hash) : '';
  return fromHash && fromHash !== '/' ? fromHash : personaOf(state).home;
}

/** How many fixed segments the pattern of the place that draws `path` has: a redirect gives way to a place that is more specific than it. */
function fixedSegmentsAt(prep: Prepared, path: string): number {
  const m = match(prep.table, path);
  return m ? m.def.path.split('/').filter((s) => s && !s.startsWith(':')).length : 0;
}

/** Where an address lands after the edition's redirects (the address itself when it did not move), and the screen state that came with the move. */
function landing(prep: Prepared, path: string): { path: string; ui: Record<string, unknown> } {
  return resolveRedirect(prep.redirects, path, (p) => fixedSegmentsAt(prep, p)) ?? { path, ui: {} };
}

/** The tab a place opens in; it never depends on who is looking, so navigation needs no ctx. */
function tabKeyOf(m: Match): string {
  return m.def.tabKey?.(m.params) ?? `${m.def.org}:${m.def.nav}`;
}

function tabInfo(m: Match, ctx: ScreenCtx): TabInfo {
  const own = m.def.tab?.(m.params, ctx) ?? {};
  return {
    key: tabKeyOf(m),
    label: own.label ?? m.def.title(m.params, ctx),
    kind: own.kind ?? NAV_TAB[m.def.nav] ?? (m.def.nav.startsWith('chat:') ? 'chat' : 'other'),
    count: own.count,
  };
}

/** The sidebar row a place lights. */
function sidebarRowOf(def: ScreenDef): string {
  if (def.nav === 'board') return 'board';
  if (def.nav === 'org') return def.org;
  if (def.nav.startsWith('chat:') || def.nav.startsWith('pin:')) return def.nav;
  return `${def.org}/${def.nav}`;
}

/* ---------- tabs ---------- */

interface TabEntry {
  key: string;
  path: string;
  /** Kept by the reader. Not pinned = the preview tab: at most one, replaced by the next new place. A state saved before this field has none. */
  pinned?: boolean;
}

interface TabsState {
  list: TabEntry[];
  active: string;
}

/** The key of the launcher tab: opened on purpose with «+», so it is never a preview. */
const LAUNCHER_KEY = 'new';

/** A state saved before tabs could be pinned reads as ONE preview tab, the active one: the ten tabs left by earlier rounds do not come back. Same object when nothing is missing. */
function normalizeTabs(tabs: TabsState): TabsState {
  if (tabs.list.every((t) => t.pinned !== undefined)) return tabs;
  const active = tabs.list.find((t) => t.key === tabs.active);
  return active ? { list: [{ ...active, pinned: false }], active: active.key } : { list: [], active: '' };
}

/** Opens a place: its tab when it has one; else it takes the place of the preview tab; else a new preview tab opens next to the active one. */
function openIn(tabs: TabsState, key: string, path: string): TabsState {
  if (tabs.list.some((t) => t.key === key)) return { list: tabs.list.map((t) => (t.key === key ? { ...t, path } : t)), active: key };
  /* The launcher of a new tab hands its place to where the reader goes from it. */
  if (tabs.active === LAUNCHER_KEY && tabs.list.some((t) => t.key === LAUNCHER_KEY)) return { list: tabs.list.map((t) => (t.key === LAUNCHER_KEY ? { key, path, pinned: t.pinned } : t)), active: key };
  const launcher = key === LAUNCHER_KEY;
  const preview = launcher ? -1 : tabs.list.findIndex((t) => !t.pinned);
  if (preview >= 0) return { list: tabs.list.map((t, i) => (i === preview ? { key, path, pinned: false } : t)), active: key };
  const at = tabs.list.findIndex((t) => t.key === tabs.active);
  const list = [...tabs.list];
  list.splice(at + 1, 0, { key, path, pinned: launcher });
  return { list, active: key };
}

/** The tab is kept: the reader did something in it. Same object when it already is. */
function pinIn(tabs: TabsState, key: string): TabsState {
  if (!tabs.list.some((t) => t.key === key && !t.pinned)) return tabs;
  return { ...tabs, list: tabs.list.map((t) => (t.key === key ? { ...t, pinned: true } : t)) };
}

/** A dragged tab lands at `to` (its index once it is out of the list) and is kept. */
function moveIn(tabs: TabsState, key: string, to: number): TabsState {
  const from = tabs.list.findIndex((t) => t.key === key);
  if (from < 0) return tabs;
  const rest = tabs.list.filter((t) => t.key !== key);
  rest.splice(Math.min(Math.max(0, to), rest.length), 0, { ...tabs.list[from], pinned: true });
  return { ...tabs, list: rest };
}

function closeIn(tabs: TabsState, key: string): TabsState {
  const at = tabs.list.findIndex((t) => t.key === key);
  const list = tabs.list.filter((t) => t.key !== key);
  if (!list.length) return { list: [{ key: LAUNCHER_KEY, path: P.newTab(), pinned: true }], active: LAUNCHER_KEY };
  if (tabs.active !== key) return { list, active: tabs.active };
  return { list, active: list[Math.min(at, list.length - 1)].key };
}

/**
 * Whether the reader did something in the pane since the last navigation (a
 * press, a key, text typed): only then do the writes a screen makes keep its
 * tab. What a screen writes by itself on mounting, or after a redirect, does not,
 * and going somewhere resets it. The refs live in here so the container's ctx,
 * which calls `pinOnGesture`, never reads one while rendering.
 */
function useTabPinning(stateRef: { current: DemoState }, setTabs: (fn: (t: TabsState) => TabsState) => void) {
  const gesture = useRef(false);
  const markGesture = useCallback(() => { gesture.current = true; }, []);
  const resetGesture = useCallback(() => { gesture.current = false; }, []);
  const pinOnGesture = useCallback(() => {
    if (!gesture.current) return;
    const cur = normalizeTabs((stateRef.current.ui['app.tabs'] as TabsState | undefined) ?? { list: [], active: '' });
    if (cur.list.some((t) => t.key === cur.active && !t.pinned)) setTabs((t) => pinIn(t, t.active));
  }, [stateRef, setTabs]);
  return { markGesture, resetGesture, pinOnGesture };
}

/* ---------- the pane's safety net ---------- */

class PaneBoundary extends Component<{ copy: UiCopy; onHome: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const e = this.props.copy.app.error;
    return (
      <ErrorState
        title={e.title}
        body={e.body}
        action={<><Button variant="primary" onClick={() => this.setState({ failed: false })}>{e.retry}</Button><Button onClick={this.props.onHome}>{this.props.copy.app.access.goHome}</Button></>}
      />
    );
  }
}

/* ---------- time ---------- */

/** «12 min fa» from the demo's now. */
function agoOf(at: string, copy: UiCopy): string {
  const minutes = Math.round((Date.parse(DEMO_NOW) - Date.parse(at)) / 60_000);
  const t = copy.app.time;
  if (minutes < 1) return t.now;
  if (minutes < 60) return t.minutes(minutes);
  if (minutes < 24 * 60) return t.hours(Math.round(minutes / 60));
  const days = Math.round(minutes / (24 * 60));
  return days === 1 ? t.yesterday : t.days(days);
}

/** Real time the page opened: the log counts from the demo's now by the real time passed since. */
const OPENED_AT = Date.now();

/** Now as the log writes it: 10:30 of the demo day plus the real time since the page opened, so actions read in order after the seeded ones (the wall clock put them at 03:38). */
function stampNow(): string {
  // DEMO_NOW is at +01:00: shift by an hour to read its wall time from UTC fields.
  const d = new Date(Date.parse(DEMO_NOW) + (Date.now() - OPENED_AT) + 60 * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${DEMO_TODAY}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+01:00`;
}

/* ---------- the app ---------- */

const PHONE_QUERY = '(max-width: 767px)';

export function App({ copy: baseCopy, copies, embedPath, edition }: {
  copy: UiCopy;
  /** Both languages: the one chosen in Settings > General is used. */
  copies?: { it: UiCopy; en: UiCopy };
  /** Gallery mode: the place to show, no address bar, a fresh state. */
  embedPath?: string;
  /** Which preview: the multi-organization one or the edition of one organization. The entry chooses, so a build carries only the edition it runs. */
  edition: Edition;
}) {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const embedded = embedPath !== undefined;
  const prep = prepare(edition);
  const { table: TABLE, defs: DEFS, seed: SEED_NOTIFICATIONS } = prep;
  const [state, dispatch] = useReducer(reduce, undefined, () => {
    const s = loadState(embedded || params.has('fresh'), edition.storageKey, edition.defaultPersona);
    const persona = params.get('persona');
    const theme = params.get('theme');
    const seeded = {
      ...s,
      persona: persona && edition.personas.some((p) => p.id === persona) ? persona : s.persona,
      theme: theme === 'dark' || theme === 'light' ? theme : s.theme,
    };
    /* The place of the address opens in its tab from the first render; a moved address lands on its new place with the state it meant, before anything draws. */
    const moved = landing(prep, firstPath(seeded, embedPath));
    const first = moved.path;
    const m = match(TABLE, first);
    const withMoved = Object.entries(moved.ui).reduce((st, [key, value]) => reduce(st, { type: 'ui', key, update: () => value }), seeded);
    const withTab = reduce(withMoved, { type: 'ui', key: 'app.tabs', update: (prev) => openIn(normalizeTabs((prev as TabsState | undefined) ?? { list: [], active: '' }), m ? tabKeyOf(m) : 'missing', first) });
    const withOrgOpen = m ? reduce(withTab, { type: 'open-org', org: m.def.org }) : withTab;
    return reduce(withOrgOpen, { type: 'visit', path: first });
  });
  /* The latest state and ctx for handlers and the test hook, written after each render (before any effect reads them). */
  const stateRef = useRef(state);
  useLayoutEffect(() => { stateRef.current = state; });
  const language = (state.slices['settings.general'] as { language?: 'it' | 'en' } | undefined)?.language;
  const copy = copies && language ? copies[language] : baseCopy;
  const persona = personaOf(state);
  const role = roleOf(persona);
  const can = useCallback((p: Permission) => canDo(state, persona, p), [state, persona]);
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches);
  const speed = Number(params.get('speed') ?? '1') || 1;
  const { startJob, job, clearJobs } = useJobs(speed);

  /* ---- overlays ---- */
  const [palette, setPalette] = useState<{ query: string; active?: string } | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [personaOpen, setPersonaOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [confirmBox, setConfirmBox] = useState<ConfirmInput | null>(null);
  const [toasts, setToasts] = useState<Array<ToastInput & { id: string }>>([]);
  /* Bumped by every reset of the demo: the pane remounts, so a dialog or menu a screen held open does not survive it. */
  const [epoch, setEpoch] = useState(0);
  /* Whether the page on show is the one after signing out, and the tab it took. */
  const signedOutRef = useRef(false);
  const dispatchAll = useCallback((a: DemoAction) => {
    if (a.type === 'reset') {
      setEpoch((e) => e + 1);
      dispatch({ ...a, persona: a.persona ?? edition.defaultPersona });
      return;
    }
    dispatch(a);
  }, [edition.defaultPersona]);

  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  /* ---- persistence and theme ---- */
  useEffect(() => {
    if (!embedded) saveState(state, edition.storageKey);
  }, [state, embedded, edition.storageKey]);
  useEffect(() => {
    if (!embedded) document.documentElement.classList.toggle('dark', state.theme === 'dark');
  }, [state.theme, embedded]);
  /* Settings > Appearance: density and reduced motion live on <html>; «as the system» follows it while open. */
  const density = (state.ui['aspetto.density'] as string | undefined) ?? 'comfortable';
  const reduceMotion = state.ui['aspetto.motion'] === true;
  const followSystem = state.ui['aspetto.system'] === true;
  useEffect(() => {
    if (embedded) return;
    document.documentElement.setAttribute('data-density', density);
    document.documentElement.classList.toggle('reduce-motion', reduceMotion);
    document.documentElement.lang = language ?? 'it';
  }, [density, reduceMotion, language, embedded]);
  useEffect(() => {
    if (embedded || !followSystem) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = () => dispatch({ type: 'theme', theme: mq.matches ? 'dark' : 'light' });
    follow();
    mq.addEventListener('change', follow);
    return () => mq.removeEventListener('change', follow);
  }, [followSystem, embedded]);

  /* ---- address and tabs ---- */
  const homePath = persona.home;
  const [path, setPath] = useState<string>(() => landing(prep, firstPath(state, embedPath)).path);
  const tabs: TabsState = normalizeTabs((state.ui['app.tabs'] as TabsState | undefined) ?? { list: [], active: '' });
  const setTabs = useCallback((fn: (t: TabsState) => TabsState) => {
    dispatch({ type: 'ui', key: 'app.tabs', update: (prev) => fn(normalizeTabs((prev as TabsState | undefined) ?? { list: [], active: '' })) });
  }, []);
  const { markGesture, resetGesture, pinOnGesture } = useTabPinning(stateRef, setTabs);

  const toast = useCallback((t: ToastInput) => {
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    setToasts((list) => [...list.slice(-3), { ...t, id }]);
    window.setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 6000);
  }, []);

  /* The ctx is rebuilt every render: it is cheap and always current. The test hook reads the latest one. */
  const ctxRef = useRef<ScreenCtx | null>(null);

  const show = useCallback((requested: string, requestedPush: boolean) => {
    /* An address that moved is replaced, once, by its new one: never a new step in the history. */
    /* Going somewhere is never an interaction with the place left, nor with the one reached. */
    resetGesture();
    const moved = landing(prep, requested);
    const redirected = moved.path !== requested;
    const next = moved.path;
    const push = requestedPush && !redirected;
    for (const [key, value] of Object.entries(moved.ui)) dispatch({ type: 'ui', key, update: () => value });
    const m = match(TABLE, next);
    if (!embedded) {
      const hash = `#${next}`;
      /* WebKit throws after 100 history calls in 10 s: the place still changes, only the address lags. */
      try {
        if (push && location.hash !== hash) history.pushState(null, '', hash);
        else if (!push && location.hash !== hash) history.replaceState(null, '', hash);
      } catch {
        /* the next navigation writes the address again */
      }
    }
    setPath(next);
    if (m) {
      if (!m.def.transient) setTabs((t) => openIn(t, tabKeyOf(m), next));
      /* The organization of the place on screen opens in the sidebar: a SARIM screen under a closed SARIM read as Nocera's. */
      dispatch({ type: 'open-org', org: m.def.org });
    } else {
      setTabs((t) => openIn(t, 'missing', next));
    }
    dispatch({ type: 'visit', path: next });
    setDrawer(false);
  }, [embedded, setTabs, resetGesture, TABLE, prep]);

  const go = useCallback((next: string) => show(next, true), [show]);

  useEffect(() => {
    if (embedded) return;
    const onPop = () => show(location.hash ? pathOfHash(location.hash) : homePath, false);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [embedded, show, homePath]);

  /* ---- the ctx every place renders from ---- */
  /* A person's group is a role in Nocera and a team in SARIM (its roles carry the teams' names): the messages about permissions say which. */
  const teamWords = edition.id !== COMBINED_EDITION ? copy.sarimShell.access : undefined;
  const deniedTitle = (p: Permission) => (canDo(state, persona, p) ? undefined : (teamWords ?? copy.app.access).deniedAction(role.label));
  const ctx: ScreenCtx = {
    copy,
    state,
    dispatch: (a) => {
      pinOnGesture();
      dispatchAll(a);
    },
    go,
    path,
    persona,
    can,
    allow: (p, fn) => (canDo(state, persona, p) ? fn : false),
    deniedTitle,
    toast,
    confirm: (c) => setConfirmBox(c),
    ui<T>(key: string, initial: T) {
      const set = (next: T | ((prev: T) => T)) => {
        pinOnGesture();
        dispatch({
          type: 'ui', key,
          update: (prev) => (typeof next === 'function' ? (next as (p: T) => T)((prev as T | undefined) ?? initial) : next),
        });
      };
      return [(state.ui[key] as T | undefined) ?? initial, set] as const;
    },
    slice<T>(name: string, initial: T) {
      const update = (fn: (prev: T) => T) => {
        pinOnGesture();
        dispatch({ type: 'slice', name, update: (prev) => fn((prev as T | undefined) ?? initial) });
      };
      return [(state.slices[name] as T | undefined) ?? initial, update] as const;
    },
    caseLive: (id) => state.cases[id] ?? {},
    updateCase: (id, patch: (live: CaseLive) => CaseLive, log) => {
      pinOnGesture();
      dispatch({ type: 'case', id, patch });
      if (log) dispatch({ type: 'audit', entry: { at: stampNow(), who: persona.id, what: log, path: P.record(id), kind: 'case' } });
    },
    log: (what, kind: AuditEntry['kind'], at) => dispatch({ type: 'audit', entry: { at: stampNow(), who: persona.id, what, path: at ?? path, kind } }),
    notify: (n) => dispatch({ type: 'notify', entry: { ...n, at: stampNow() } }),
    startJob,
    job,
    phone,
    now: DEMO_NOW,
  };
  useLayoutEffect(() => { ctxRef.current = ctx; });


  /* The address in its canonical form (`#/` becomes the person's home). */
  useEffect(() => {
    if (embedded || location.hash === `#${path}`) return;
    try {
      history.replaceState(null, '', `#${path}`);
    } catch {
      /* WebKit's history limit: the next navigation writes it */
    }
  }, [embedded, path]);

  /* A person who cannot open the place on show lands on their own page. */
  const switchPersona = (id: string) => {
    const next = edition.personas.find((p) => p.id === id);
    if (!next) return;
    dispatch({ type: 'persona', id });
    dispatch({ type: 'audit', entry: { at: stampNow(), who: id, what: copy.app.persona.auditLine(next.name), kind: 'access' } });
    setPersonaOpen(false);
    setTabs(() => ({ list: [], active: '' }));
    toast({ tone: 'info', title: copy.app.persona.switched(next.name), body: (teamWords ?? copy.app.persona).switchedBody });
    show(next.home, true);
  };

  /* ---- keyboard: Cmd+K ---- */
  useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (signedOutRef.current) return;
        setPalette((p) => (p ? null : { query: '' }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [embedded]);

  /* ---- test hook: the crawler resets the state and lists the places ---- */
  useEffect(() => {
    if (embedded) return;
    Reflect.set(window, '__demo', {
      reset: (to?: string) => {
        clearJobs();
        dispatchAll({ type: 'reset' });
        setTabs(() => ({ list: [], active: '' }));
        setPalette(null);
        setNotesOpen(false);
        setPersonaOpen(false);
        setUserMenuOpen(false);
        setConfirmBox(null);
        setToasts([]);
        setDrawer(false);
        setSidebarOpen(true);
        show(to ?? personaOf(initialState(edition.defaultPersona)).home, false);
      },
      /* Where this edition keeps its state, so the crawler's snapshot reads the right key. */
      storageKey: edition.storageKey,
      edition: edition.id,
      /* One entry per mockup id: a place whose screen id depends on the address (a step page) gives one per id. */
      places: () => DEFS.flatMap((d) => {
        const c = ctxRef.current;
        const byId = new Map<string, string[]>();
        for (const sample of d.samples) {
          const m = match(TABLE, sample);
          const id = m && c ? screenIdOf(m, c) : d.id;
          byId.set(id, [...(byId.get(id) ?? []), sample]);
        }
        if (byId.size === 0) byId.set(d.id, []);
        return [...byId].map(([id, samples]) => {
          const first = match(TABLE, samples[0] ?? '');
          return { id, path: d.path, samples, org: d.org, needs: d.needs, title: first && c ? first.def.title(first.params, c) : id };
        });
      }),
      state: () => stateRef.current,
    });
  }, [embedded, show, setTabs, clearJobs, dispatchAll, DEFS, TABLE, edition]);

  /* ---- the place on show ---- */
  const m = match(TABLE, path);
  const allowed = m && persona.orgs.includes(m.def.org) && (!m.def.needs || can(m.def.needs));
  const goHome = () => go(homePath);
  let pane: ReactNode;
  let screenId: string;
  const paneKey = m?.def.paneKey?.(m.params as Params) ?? path;
  if (!m) {
    screenId = 'not-found';
    pane = <EmptyState icon={Undo2} title={copy.app.notFound.title} action={<Button variant="primary" onClick={goHome}>{copy.app.access.goHome}</Button>}>{copy.app.notFound.body}</EmptyState>;
  } else if (!allowed) {
    screenId = 'no-access';
    pane = <NoAccess title={copy.app.access.title} body={(teamWords ?? copy.app.access).body(role.label)} action={<Button variant="primary" onClick={goHome}>{copy.app.access.goHome}</Button>} />;
  } else {
    screenId = screenIdOf(m, ctx);
    pane = <PaneBoundary key={`${epoch}:${paneKey}`} copy={copy} onHome={goHome}>{m.def.render(m.params as Params, ctx)}</PaneBoundary>;
  }

  /* After «Esci» nothing of the signed-in chrome stays: no person, no counters, no rows to click, no tab strip, no search; the page and its «Rientra» are all there is. (allow-italian: quotes the Italian interface) */
  const signedOut = screenId === 'sarim-signed-out';
  /* Signing out closes whatever was open over the page; done while rendering the change (React's pattern for state that follows a prop), so no closed panel is drawn for a frame first. */
  const [signedOutSeen, setSignedOutSeen] = useState(signedOut);
  if (signedOutSeen !== signedOut) {
    setSignedOutSeen(signedOut);
    if (signedOut) {
      setPalette(null);
      setNotesOpen(false);
      setUserMenuOpen(false);
      setPersonaOpen(false);
      // A message of the signed-in session (the change of person, an action done) does not outlive it.
      setToasts([]);
    }
  }
  useEffect(() => {
    // Read by the Cmd+K listener, which is registered once: kept in step here, after the render, not during it.
    signedOutRef.current = signedOut;
  }, [signedOut]);

  /* ---- notifications ---- */
  const notifications: NotificationEntry[] = [...state.notifications.added, ...SEED_NOTIFICATIONS]
    .filter((n) => (!n.to || n.to.includes(persona.id)) && allowedPath(prep, n.path, ctx))
    .sort((a, b) => b.at.localeCompare(a.at));
  const unread = notifications.filter((n) => !state.notifications.read.includes(n.id));

  /* ---- sidebar and its menus ---- */
  const expanded = (state.ui['app.expanded'] as string[] | undefined) ?? persona.orgs.slice(0, 1);
  const sidebar = edition.sidebar(state, persona, can, m ? sidebarRowOf(m.def) : undefined, expanded);
  sidebar.inboxCount = unread.length || undefined;
  /* The edition's menus are built from the live ctx on every render, as the places are. */
  const menuCtx: ShellMenuCtx = {
    ctx,
    unread: unread.length,
    markAllRead: () => dispatch({ type: 'read', ids: unread.map((n) => n.id) }),
    openPersonaSwitch: () => setPersonaOpen(true),
  };
  const orgMenu = edition.orgMenu?.(menuCtx);
  if (orgMenu) sidebar.orgs = sidebar.orgs.map((o) => (o.id === edition.org ? { ...o, menu: orgMenu } : o));
  const userMenu = userMenuOpen ? edition.userMenu?.(menuCtx) : undefined;
  /* The foot of the sidebar opens the person's own menu when the edition has one, the change of person otherwise. */
  const identityOpens = edition.userMenu ? userMenuOpen : personaOpen;
  const closeUserMenu = () => {
    setUserMenuOpen(false);
    document.querySelector<HTMLElement>('[data-sidebar-identity]')?.focus({ preventScroll: true });
  };
  const sidebarEl = (
    <Sidebar
      /* Remounted by every reset: a row menu left open (OrgRow's own state) kept its z-9999 click-away layer over the next probe's dialog. */
      key={epoch}
      model={sidebar}
      copy={copy}
      onSelect={(id) => {
        const p = edition.rowPath(id);
        if (p) go(p);
      }}
      onToggleOrg={(id) => dispatch({ type: 'ui', key: 'app.expanded', update: (prev) => {
        const list = (prev as string[] | undefined) ?? persona.orgs.slice(0, 1);
        return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      } })}
      onOrgMenu={orgMenu ? (_org, id) => orgMenu.find((i) => i.id === id)?.run?.() : undefined}
      onNotifications={() => setNotesOpen((v) => !v)}
      onSearch={() => setPalette({ query: '' })}
      onNew={() => go(P.newTab())}
      onIdentity={() => (edition.userMenu ? setUserMenuOpen((v) => !v) : setPersonaOpen((v) => !v))}
      identityOpen={identityOpens}
    />
  );

  /* ---- tabs ---- */
  const tabModels: TabModel[] = tabs.list.map((t) => {
    const tm = match(TABLE, t.path);
    const info = tm ? tabInfo(tm, ctx) : { key: t.key, label: t.path, kind: 'other' as UiTabKind };
    return { id: t.key, kind: info.kind, label: info.label, count: info.count, active: t.key === tabs.active, preview: !t.pinned };
  });
  const activeLabel = tabModels.find((t) => t.active)?.label ?? copy.shell.appName;

  /* ---- search palette ---- */
  const built = (() => {
    if (!palette) return undefined;
    const entries = searchAll(prep, ctx);
    const known = new Map(entries.map((e) => [e.path, e]));
    const visited = state.recent.flatMap((p) => {
      const rm = match(TABLE, p);
      if (!rm || rm.def.nav === 'search' || rm.def.nav === 'new' || !allowedPath(prep, p, ctx)) return [];
      const entry = known.get(p);
      return [{ path: p, title: rm.def.title(rm.params, ctx), detail: entry?.detail ?? (entry?.kind ? copy.app.search.groups[entry.kind] : entry?.group), icon: entry?.icon ?? NAV_ICON[NAV_KIND[rm.def.nav] ?? 'overview'] }];
    });
    /* The place on show is not «recent» while there is anything else to go back to; alone, it still says the list is there. */
    const recents = (visited.some((r) => r.path !== path) ? visited.filter((r) => r.path !== path) : visited).slice(0, 5);
    const suggestions = () => prep.areas.flatMap((a) => a.suggest?.(ctx) ?? []).filter((e) => (!e.needs || ctx.can(e.needs)) && allowedPath(prep, e.path, ctx));
    return buildPalette({ query: palette.query, entries, suggestions, recents, copy });
  })();
  const firstPaletteId = built?.groups[0]?.items[0]?.id;

  const overlays = (
    <>
      {palette && (
        <CommandPalette
          query={palette.query}
          onQuery={(q) => setPalette({ query: q })}
          groups={built?.groups ?? []}
          words={built?.words}
          activeId={palette.active ?? firstPaletteId}
          onActive={(id) => setPalette((p) => (p ? { ...p, active: id } : p))}
          onOpen={(id) => {
            const target = built?.pathOf(id);
            if (!target) return;
            setPalette(null);
            go(target);
          }}
          onClose={() => setPalette(null)}
          placeholder={copy.app.search.placeholder}
          notice={built?.none ? copy.app.search.empty(palette.query.trim()) : undefined}
          empty={built?.none ? <EmptyState icon={Search} title={copy.app.search.empty(palette.query.trim())}>{copy.app.search.emptyHint}</EmptyState> : undefined}
          /* One kind only: the heading of the group already says how many, so the footer does not say it twice. */
          footer={built && built.total > 0 && built.groups.length > 1 ? copy.app.search.footerCount(built.total) : undefined}
          copy={copy}
        />
      )}
      {notesOpen && (
        <NotificationsPanel
          title={copy.app.notifications.title}
          items={notifications.map((n) => ({ id: n.id, title: n.title, body: n.body, when: agoOf(n.at, copy), tone: n.tone, unread: !state.notifications.read.includes(n.id) }))}
          onOpen={(id) => {
            const n = notifications.find((x) => x.id === id);
            dispatch({ type: 'read', ids: [id] });
            setNotesOpen(false);
            if (n) go(n.path);
          }}
          onMarkAllRead={unread.length ? () => dispatch({ type: 'read', ids: unread.map((n) => n.id) }) : undefined}
          markAllLabel={copy.app.notifications.markAllRead}
          empty={copy.app.notifications.empty}
          onClose={() => setNotesOpen(false)}
        />
      )}
      {userMenu && (
        <UserMenu
          header={userMenu.header}
          items={userMenu.items}
          ariaLabel={userMenu.label}
          onSelect={(id) => {
            if (id === userMenu.header.id) userMenu.onHeader?.();
            else userMenu.items.find((i) => i.id === id)?.run?.();
          }}
          onClose={closeUserMenu}
        />
      )}
      {personaOpen && (
        <PersonaMenu
          title={copy.app.persona.switchTitle}
          personas={edition.personas.map((p) => ({
            id: p.id, name: p.name, monogram: p.monogram, color: p.color, current: p.id === persona.id, example: p.example,
            detail: roleOf(p)?.label ?? '',
          }))}
          onSelect={switchPersona}
          onClose={() => setPersonaOpen(false)}
          exampleLabel={copy.app.persona.example}
          currentLabel={copy.app.persona.current}
        />
      )}
      {confirmBox && (
        <ConfirmDialog
          title={confirmBox.title}
          body={confirmBox.body}
          confirmLabel={confirmBox.confirmLabel}
          cancelLabel={copy.app.cancel}
          tone={confirmBox.tone}
          onConfirm={() => {
            const fn = confirmBox.onConfirm;
            setConfirmBox(null);
            fn();
          }}
          onCancel={() => setConfirmBox(null)}
        />
      )}
      <ToastStack
        toasts={toasts.map((t) => ({ id: t.id, tone: t.tone ?? 'ok', title: t.title, body: t.body, actionLabel: t.action?.label }))}
        onDismiss={(id) => setToasts((list) => list.filter((t) => t.id !== id))}
        onAction={(id) => {
          const t = toasts.find((x) => x.id === id);
          setToasts((list) => list.filter((x) => x.id !== id));
          if (t?.action) go(t.action.path);
        }}
        dismissLabel={copy.common.close}
      />
      {!embedded && <TooltipLayer />}
    </>
  );

  const content = (
    <div
      key={`${epoch}:${paneKey}`}
      data-screen={screenId}
      data-route={`#${path}`}
      /* An edition whose crumbs are a trail of places has no «back» arrow beside them (PaneHeader). */
      data-back-in-crumbs={edition.id !== COMBINED_EDITION ? '' : undefined}
      className="ui-pane-enter flex min-h-0 flex-1 flex-col"
      /* The last gesture in the pane, caught before the screen's own handlers: what the screen then writes keeps its tab. */
      onPointerDownCapture={markGesture}
      onClickCapture={markGesture}
      onKeyDownCapture={markGesture}
      onInputCapture={markGesture}
    >
      {pane}
    </div>
  );

  if (phone && !embedded) {
    const phoneTabs = edition.phoneTabs({ copy, can, home: homePath, inboxCount: sidebar.orgs[0]?.count });
    const lit = (t: (typeof phoneTabs)[number]) => t.path !== undefined && (path === t.path || (t.litUnder !== undefined && (path === t.litUnder || path.startsWith(`${t.litUnder}/`))));
    const nav = phoneTabs.map((t) => ({ id: t.id, label: t.label, icon: t.icon, count: t.count, active: lit(t) }));
    return (
      <div className="h-full w-full bg-surface font-sans text-prose text-app-text antialiased">
        <PhoneShell
          title={activeLabel}
          leading={signedOut ? undefined : <IconButton icon={MenuIcon} label={copy.app.phone.menu} onClick={() => setDrawer(true)} />}
          actions={signedOut ? undefined : <IconButton icon={Bell} label={copy.shell.notifications} onClick={() => setNotesOpen((v) => !v)}>{unread.length ? <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" /> : null}</IconButton>}
          nav={signedOut ? [] : nav}
          onNav={(id) => {
            /* `search` and `more` are the container's own buttons; the others go where the edition says. */
            if (id === 'search') setPalette({ query: '' });
            else if (id === 'more') setDrawer(true);
            else {
              const target = phoneTabs.find((t) => t.id === id)?.path;
              if (target) go(target);
            }
          }}
          drawer={drawer && !signedOut ? sidebarEl : undefined}
          onCloseDrawer={() => setDrawer(false)}
        >
          {content}
        </PhoneShell>
        {overlays}
      </div>
    );
  }

  return (
    <>
      <AppFrame
        sidebar={sidebarOpen && !signedOut ? sidebarEl : undefined}
        tabBar={signedOut ? undefined : (
          <TabBar
            tabs={tabModels}
            copy={copy}
            moreLabel={copy.sarimShell.tabsMenu}
            previewTip={copy.sarimShell.tabPreviewTip}
            onPin={(key) => setTabs((t) => pinIn(t, key))}
            onMove={(key, to) => setTabs((t) => moveIn(t, key, to))}
            onSelect={(key) => {
              const t = tabs.list.find((x) => x.key === key);
              if (t) go(t.path);
            }}
            onClose={(key) => {
              const next = closeIn(tabs, key);
              const target = next.list.find((t) => t.key === next.active);
              setTabs(() => next);
              if (target && target.path !== path) show(target.path, false);
            }}
            onAdd={() => go(P.newTab())}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            sidebarOpen={sidebarOpen}
          />
        )}
      >
        {content}
      </AppFrame>
      {overlays}
    </>
  );
}
