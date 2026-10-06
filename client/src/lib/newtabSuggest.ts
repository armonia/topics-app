/**
 * The rows under the new-tab field (NEWTAB-ARC-02): open browser tabs, recent
 * pages, top sites, commands. Four sections from the sources the app already
 * has — the pane store, the site history both the tab sheet and the grid read,
 * the slash commands the composer offers — filtered by the query, deduplicated
 * across sections, capped per section.
 *
 * Precedence is the reading order: a url already shown as an open tab is not
 * repeated under recent, and neither repeats under top. The top section stays
 * out while the query is empty: unfiltered, it would say what the grid below
 * already says. Pure, so the rule is unit-tested without React.
 */
import type { Pane } from '../state/pane/types';
import { isRealUrl } from '../state/pane/browserPaneUrl';
import { rankSites, type PageVisit, type SiteEntry } from '../state/browserSiteHistory';
import { displayUrl, prettyUrl } from './browserNavUrl';

/** Each list contributes at most this many rows — the tab sheet's own cap. */
export const NEWTAB_SUGGESTIONS_PER_SECTION = 5;

export type NewTabSectionId = 'tabs' | 'recent' | 'top' | 'commands';

export interface NewTabSuggestionRow {
  key: string;
  kind: 'tab' | 'recent' | 'top' | 'command';
  primary: string;
  secondary?: string;
  /** The full address behind the row, for the tooltip. */
  title: string;
  /** tab/recent/top: where the row navigates or which tab it is. */
  url?: string;
  /** tab: the pane to focus. */
  paneId?: string;
  /** command: `/name` as typed. */
  cmd?: string;
  /** recent/top: the favicon the page declared, when it declared one. */
  favicon?: string;
}

export interface NewTabSuggestionSection {
  id: NewTabSectionId;
  rows: NewTabSuggestionRow[];
}

function matchesQuery(candidates: readonly (string | undefined)[], q: string): boolean {
  if (!q) return true;
  return candidates.some((c) => !!c && c.toLowerCase().includes(q));
}

function primaryFor(title: string | undefined, url: string): { primary: string; secondary?: string } {
  const name = (title ?? '').trim();
  return name ? { primary: name, secondary: prettyUrl(url) } : { primary: prettyUrl(url) };
}

export function buildNewTabSuggestions(opts: {
  query: string;
  panes: Readonly<Record<string, Pane>> | readonly Pane[];
  sites: readonly SiteEntry[];
  pages: readonly PageVisit[];
  /** The `/names` offered — `SLASH_COMMANDS`, passed in so this module stays a leaf. */
  commands: readonly { cmd: string }[];
  now?: number;
}): NewTabSuggestionSection[] {
  const q = opts.query.trim().toLowerCase();
  const now = opts.now ?? Date.now();
  const panes = Array.isArray(opts.panes) ? opts.panes : Object.values(opts.panes);
  const shown = new Set<string>();
  const sections: NewTabSuggestionSection[] = [];

  const tabs: NewTabSuggestionRow[] = [];
  for (const pane of panes) {
    if (tabs.length >= NEWTAB_SUGGESTIONS_PER_SECTION) break;
    if (pane.type !== 'browser' || !isRealUrl(pane.url)) continue;
    const url = pane.url;
    if (shown.has(url)) continue;
    if (!matchesQuery([pane.title, url], q)) continue;
    shown.add(url);
    tabs.push({ key: `tab:${pane.id}`, kind: 'tab', ...primaryFor(pane.title, url), title: displayUrl(url), url, paneId: pane.id });
  }
  if (tabs.length) sections.push({ id: 'tabs', rows: tabs });

  const recent: NewTabSuggestionRow[] = [];
  for (const page of opts.pages) {
    if (recent.length >= NEWTAB_SUGGESTIONS_PER_SECTION) break;
    if (!isRealUrl(page.url) || shown.has(page.url)) continue;
    if (!matchesQuery([page.title, page.url], q)) continue;
    shown.add(page.url);
    recent.push({ key: `recent:${page.url}`, kind: 'recent', ...primaryFor(page.title, page.url), title: displayUrl(page.url), url: page.url, favicon: page.favicon || undefined });
  }
  if (recent.length) sections.push({ id: 'recent', rows: recent });

  // The grid below already says the unfiltered top: this section only filters.
  if (q) {
    const top: NewTabSuggestionRow[] = [];
    const ranked = rankSites(
      opts.sites.filter((s) => matchesQuery([s.host, s.title, s.url], q)),
      opts.sites.length,
      now,
    );
    for (const site of ranked) {
      if (top.length >= NEWTAB_SUGGESTIONS_PER_SECTION) break;
      if (shown.has(site.url)) continue;
      shown.add(site.url);
      top.push({
        key: `top:${site.host}`, kind: 'top', primary: site.host,
        secondary: site.title || undefined, title: displayUrl(site.url), url: site.url,
        favicon: site.favicon || undefined,
      });
    }
    if (top.length) sections.push({ id: 'top', rows: top });
  }

  const commands: NewTabSuggestionRow[] = [];
  for (const c of opts.commands) {
    if (commands.length >= NEWTAB_SUGGESTIONS_PER_SECTION) break;
    if (!matchesQuery([c.cmd], q)) continue;
    commands.push({ key: `cmd:${c.cmd}`, kind: 'command', primary: c.cmd, title: c.cmd, cmd: c.cmd });
  }
  if (commands.length) sections.push({ id: 'commands', rows: commands });

  return sections;
}
