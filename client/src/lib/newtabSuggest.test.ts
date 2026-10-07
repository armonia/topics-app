/**
 * The new-tab suggestion lists: four sections from shared sources, filtered by
 * the query, deduplicated across sections, capped. The precedence that matters:
 * a url shown as an open tab never repeats below.
 *
 * @covers NEWTAB-ARC-02
 */
import { describe, test, expect } from 'bun:test';
import { buildNewTabSuggestions } from './newtabSuggest';
import type { Pane } from '../state/pane/types';
import type { PageVisit, SiteEntry } from '../state/browserSiteHistory';

const NOW = 1_700_000_000_000;

function pane(id: string, extra: Partial<Pane> = {}): Pane {
  return { id, type: 'browser', ...extra };
}

function site(host: string, extra: Partial<SiteEntry> = {}): SiteEntry {
  return { host, url: `https://${host}/`, title: '', favicon: '', visits: 3, lastVisit: NOW - 1000, ...extra };
}

function page(url: string, extra: Partial<PageVisit> = {}): PageVisit {
  return { url, title: '', favicon: '', at: NOW - 1000, ...extra };
}

const COMMANDS = [{ cmd: '/status' }, { cmd: '/model' }, { cmd: '/resume' }];

const PANES: Pane[] = [
  pane('browser:a', { title: 'Example Guide', url: 'https://example.com/guide' }),
  pane('browser:b', { title: 'Arc Docs', url: 'https://docs.arc.test/x' }),
  pane('browser:empty'),
  pane('chat:t1', { type: 'chat', topicId: 't1' }),
];

describe('sections', () => {
  test('empty query shows tabs, recent and commands — the grid already says the top', () => {
    const sections = buildNewTabSuggestions({
      query: '', panes: PANES, sites: [site('example.net')], pages: [page('https://example.org/news')], commands: COMMANDS, now: NOW,
    });
    expect(sections.map((s) => s.id)).toEqual(['tabs', 'recent', 'commands']);
    expect(sections[0]!.rows).toHaveLength(2);
    expect(sections[1]!.rows.map((r) => r.url)).toEqual(['https://example.org/news']);
    expect(sections[2]!.rows.map((r) => r.cmd)).toEqual(['/status', '/model', '/resume']);
  });

  test('a query filters every section and wakes the top one', () => {
    const sections = buildNewTabSuggestions({
      query: 'example', panes: PANES,
      sites: [site('example.net', { title: 'Example Net' }), site('other.test')],
      pages: [page('https://example.org/news', { title: 'News' }), page('https://unrelated.test/')],
      commands: COMMANDS, now: NOW,
    });
    const byId = Object.fromEntries(sections.map((s) => [s.id, s.rows]));
    expect(byId.tabs.map((r: { url?: string }) => r.url)).toEqual(['https://example.com/guide']);
    expect(byId.recent.map((r: { url?: string }) => r.url)).toEqual(['https://example.org/news']);
    expect(byId.top.map((r: { primary: string }) => r.primary)).toEqual(['example.net']);
    expect(byId.commands).toBeUndefined();
  });

  test('each section caps at five rows', () => {
    const many = Array.from({ length: 9 }, (_, i) => page(`https://example.org/p${i}`));
    const sections = buildNewTabSuggestions({
      query: '', panes: [], sites: [], pages: many, commands: [], now: NOW,
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]!.rows).toHaveLength(5);
  });
});

describe('dedupe', () => {
  test('a tab url never repeats in recent or top', () => {
    const sections = buildNewTabSuggestions({
      query: 'example', panes: PANES,
      sites: [site('example.com', { url: 'https://example.com/guide' }), site('example.net')],
      pages: [page('https://example.com/guide'), page('https://example.org/news')],
      commands: [], now: NOW,
    });
    const urls = sections.flatMap((s) => s.rows.map((r) => r.url).filter(Boolean));
    expect(urls.filter((u) => u === 'https://example.com/guide')).toHaveLength(1);
    expect(urls).toContain('https://example.org/news');
    expect(urls).toContain('https://example.net/');
  });
});
