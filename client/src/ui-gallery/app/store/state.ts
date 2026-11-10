/**
 * What the preview remembers: who is using it, what they did to the example
 * cases, the settings they changed, the log of every action, and the screen
 * state each place keeps (filters, toggles, selections). It is kept in
 * localStorage (`persist.ts`), so a reload lands where the reader left, and
 * «Ripristina demo» in Settings puts it back to the start. (allow-italian: quotes the Italian interface)
 *
 * The example data itself never changes (`client/src/ui/fixtures/`): the state
 * holds only what the reader changed on top of it.
 */
import type { CaseStatus, StepState } from '../../../ui/fixtures/org/types';
import type { Permission } from '../../../ui/fixtures/org/people';
import { DEFAULT_PERSONA } from '../../../ui/fixtures/org/people';
import { personaOf } from './permissions';

/** Bump when the shape changes: a stored state of another version is dropped. */
/** 2: the Halley robot's password lives in the vault only (an older save told it in four places). */
export const STATE_VERSION = 2;

export type Theme = 'light' | 'dark';

/** What the reader changed on one case. */
export interface CaseLive {
  status?: CaseStatus;
  /** Steps marked by hand, by step id. */
  steps?: Record<string, StepState>;
  /** Corrected values of classified fields, by field id. */
  values?: Record<string, string>;
  /** Decisions on the AI proposals of the draft, by proposal index. */
  proposals?: Record<string, 'accept' | 'discard'>;
  /** Text the reader added to the draft. */
  draftAdded?: string[];
  assignee?: string;
  /** Set when the case is confirmed: the protocol number is assigned by that confirmation, so a case still to be confirmed has none. */
  protocol?: { number: string; date: string };
  /** Checklist items ticked, by id. */
  checklist?: Record<string, boolean>;
  /** Receipts of actions that left the system (PEC sent, filing, payment). */
  receipts?: Array<{ at: string; title: string; lines: string[] }>;
  /** Events added to the case history. */
  events?: Array<{ at: string; who: string; what: string }>;
  /** Messages exchanged with the assistant of the case. */
  chat?: Array<{ role: 'user' | 'assistant'; text: string }>;
}

/** One line of the log that cannot be edited (n15). */
export interface AuditEntry {
  id: string;
  /** ISO date-time. */
  at: string;
  /** Persona id. */
  who: string;
  /** What was done, in plain words. */
  what: string;
  /** Where it happened, a path of the app. */
  path?: string;
  /** Category, for the filters of the log. */
  kind: 'case' | 'structure' | 'permission' | 'test' | 'knowledge' | 'access' | 'setting' | 'share';
}

export interface NotificationEntry {
  id: string;
  at: string;
  title: string;
  body?: string;
  path: string;
  tone: 'info' | 'warn' | 'error' | 'ok';
  /** Persona ids it is for; empty = everyone who can open the path. */
  to?: string[];
}

export interface DemoState {
  version: number;
  persona: string;
  theme: Theme;
  cases: Record<string, CaseLive>;
  audit: AuditEntry[];
  notifications: { read: string[]; added: NotificationEntry[] };
  /** Permission changes by role id: true adds, false removes. */
  permissions: Record<string, Partial<Record<Permission, boolean>>>;
  /** Screen state by key (`ctx.ui`). */
  ui: Record<string, unknown>;
  /** Domain state by slice name (`ctx.slice`): added flows, test results, approvals. */
  slices: Record<string, unknown>;
  /** Paths opened most recently, newest first, for the search palette. */
  recent: string[];
  /** A counter for ids made in the preview. */
  seq: number;
}

export type DemoAction =
  /** Back to the start; `persona` is the edition's default person (the container fills it in). */
  | { type: 'reset'; persona?: string }
  | { type: 'persona'; id: string }
  | { type: 'theme'; theme: Theme }
  | { type: 'ui'; key: string; update: (prev: unknown) => unknown }
  | { type: 'slice'; name: string; update: (prev: unknown) => unknown }
  | { type: 'case'; id: string; patch: (live: CaseLive) => CaseLive }
  | { type: 'audit'; entry: Omit<AuditEntry, 'id'> }
  | { type: 'notify'; entry: Omit<NotificationEntry, 'id'> }
  | { type: 'read'; ids: string[] }
  | { type: 'permission'; role: string; permission: Permission; value: boolean | undefined }
  | { type: 'visit'; path: string }
  /** Opens an organization in the sidebar (the one of the place on screen), keeping the others as they are. */
  | { type: 'open-org'; org: string };

export function initialState(persona: string = DEFAULT_PERSONA): DemoState {
  return {
    version: STATE_VERSION,
    persona,
    theme: 'light',
    cases: {},
    audit: [],
    notifications: { read: [], added: [] },
    permissions: {},
    ui: {},
    slices: {},
    recent: [],
    seq: 1,
  };
}

const RECENT_MAX = 8;

export function reduce(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'reset':
      return { ...initialState(action.persona), theme: state.theme };
    case 'persona':
      return { ...state, persona: action.id };
    case 'theme':
      return { ...state, theme: action.theme };
    case 'ui':
      return { ...state, ui: { ...state.ui, [action.key]: action.update(state.ui[action.key]) } };
    case 'slice':
      return { ...state, slices: { ...state.slices, [action.name]: action.update(state.slices[action.name]) } };
    case 'case':
      return { ...state, cases: { ...state.cases, [action.id]: action.patch(state.cases[action.id] ?? {}) } };
    case 'audit':
      return { ...state, seq: state.seq + 1, audit: [{ ...action.entry, id: `log-${state.seq}` }, ...state.audit] };
    case 'notify':
      return {
        ...state,
        seq: state.seq + 1,
        notifications: { ...state.notifications, added: [{ ...action.entry, id: `n-${state.seq}` }, ...state.notifications.added] },
      };
    case 'read': {
      const read = new Set([...state.notifications.read, ...action.ids]);
      return { ...state, notifications: { ...state.notifications, read: [...read] } };
    }
    case 'permission': {
      const role = { ...(state.permissions[action.role] ?? {}) };
      if (action.value === undefined) delete role[action.permission];
      else role[action.permission] = action.value;
      return { ...state, permissions: { ...state.permissions, [action.role]: role } };
    }
    case 'open-org': {
      // Unset, the sidebar shows the person's first organization open: keep it open next to the new one.
      const open = (state.ui['app.expanded'] as string[] | undefined) ?? personaOf(state).orgs.slice(0, 1);
      if (open.includes(action.org)) return state;
      return { ...state, ui: { ...state.ui, 'app.expanded': [...open, action.org] } };
    }
    case 'visit': {
      if (state.recent[0] === action.path) return state;
      return { ...state, recent: [action.path, ...state.recent.filter((p) => p !== action.path)].slice(0, RECENT_MAX) };
    }
  }
}
