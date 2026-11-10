/**
 * The view models of the UI layer: what a screen needs to draw itself, and
 * nothing about where it comes from. In the gallery and on the landing they are
 * filled by `fixtures/`; in the product an adapter fills them from the API.
 * Icons travel as names (a kind), never as components, so a model is plain
 * data that can cross a network boundary unchanged.
 */

import type { MenuItemModel } from './primitives/menu-model';

/** The colour families a chip or a value can take, the ones the Board uses. */
export type Tone = 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'pink';

/** What a piece of data is, which decides its glyph. */
export type FieldKind = 'mail' | 'file' | 'legal' | 'record' | 'number' | 'folder' | 'calendar' | 'person' | 'link' | 'bolt';

/** A named piece of data that a step reads or writes, e.g. `PEC.mittente`. */
export interface FieldRef {
  kind: FieldKind;
  name: string;
}

export interface StatusModel {
  text: string;
  tone: Tone;
}

/** The same three tiers as the product's sidebar and tab bar. */
export type Attention = 'needs-you' | 'error' | 'done';

/**
 * What a control does when pressed. `false`: the action exists but is not
 * available here (a prototype, a missing permission), so the control is drawn
 * disabled. Omitted: a picture of the screen, so the control is drawn as is.
 */
export type Action = (() => void) | false;

/**
 * Per-item actions of a list where only some items lead somewhere, keyed by
 * item id: an item without an entry is drawn as plain content, not as a link.
 */
export type ItemLinks = Partial<Record<string, () => void>>;

/** A citation of an original: the file and, when known, the page. */
export interface SourceModel {
  /** What is cited (a document, an article), as an id the caller resolves. */
  id?: string;
  /** The file; omitted when the text already named it and only the page changes. */
  label?: string;
  page?: number;
}

/**
 * Text with emphasis and citations inline: plain strings, bold runs, sources,
 * and marked passages (the words a rule was derived from).
 */
export type RichTextModel = Array<string | { strong: string } | { source: SourceModel } | { mark: string }>;

/* ---------- shell ---------- */

/** The surfaces an organization opens in the sidebar. */
export type NavKind =
  | 'inbox' | 'flows' | 'data' | 'knowledge' | 'views' | 'channels' | 'programs'
  | 'overview' | 'settings' | 'assistant' | 'records' | 'today' | 'callcenter' | 'contracts' | 'team';

export interface NavItemModel {
  id: string;
  kind: NavKind;
  /** Overrides the product label, for words that come from a sector package. */
  label?: string;
  count?: number;
  /** A count that needs action reads red. */
  urgent?: boolean;
}

export interface SidebarChatModel {
  id: string;
  title: string;
  age?: string;
  subagents?: number;
}

export interface OrgModel {
  id: string;
  name: string;
  monogram: string;
  /** The organization's own colour, used by its monogram. */
  color: string;
  expanded?: boolean;
  attention?: Attention;
  age?: string;
  count?: number;
  nav?: NavItemModel[];
  chats?: SidebarChatModel[];
  /** The chats sit under a heading with a «+» for a new one; `newChatActive` lights it while the page of a new chat is on show. */
  newChatActive?: boolean;
  /**
   * What belongs to the organization as a whole (settings, team, log): right
   * click on its row, or the ⋯ button, opens it. Absent: the row has no menu.
   * (The one exception to «icons travel as names»: a menu item carries its glyph.)
   */
  menu?: MenuItemModel[];
}

export interface PinnedTileModel {
  id: string;
  label: string;
  monogram?: string;
  color?: string;
  kind?: FieldKind;
}

export interface SidebarFilterModel {
  id: string;
  label: string;
  count: number;
  urgent?: boolean;
}

export interface SystemStripModel {
  tone: 'ok' | 'warn';
  headline: string;
  detail: string;
  numbers: Array<[string, string]>;
}

export interface IdentityModel {
  name: string;
  monogram: string;
  color: string;
  /** The second line, under the name (the organization). */
  detail: string;
  /** What the tooltip of the row says when it is more than the name. */
  tip?: string;
}

export interface SidebarModel {
  inboxCount?: number;
  board?: { flows: number; inbox: number };
  pinned?: PinnedTileModel[];
  pinnedChats?: SidebarChatModel[];
  orgs: OrgModel[];
  filters?: SidebarFilterModel[];
  /** Id of the selected row (a nav item, a chat or a filter). */
  activeId?: string;
  /** One quiet line above the identity, e.g. whose view this is. */
  note?: string;
  system?: SystemStripModel;
  identity: IdentityModel;
}

export type UiTabKind =
  | 'flows' | 'record' | 'board' | 'data' | 'knowledge' | 'overview' | 'views' | 'inbox' | 'new' | 'other'
  | 'today' | 'settings' | 'channels' | 'programs' | 'chat' | 'callcenter' | 'search' | 'org' | 'contracts' | 'team';

export interface TabModel {
  id: string;
  kind: UiTabKind;
  label: string;
  count?: number;
  active?: boolean;
  /**
   * The one transient tab: shown in italics and replaced by the next place the
   * reader opens until something is done in it. `false` is a pinned tab; absent
   * (a picture of the strip) draws neither.
   */
  preview?: boolean;
}

/** One crumb of a pane header; the last one is the current place. */
export interface CrumbModel {
  label: string;
  /** Quiet text after the crumb, e.g. a count or the record it belongs to. */
  detail?: string;
  /** Opens the place this crumb names; the last crumb (the place itself) ignores it. */
  onSelect?: () => void;
}
