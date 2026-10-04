/**
 * The shape of the tab sheet, without a DOM: what sits on the first level, in
 * which order, and what a level with one row or none becomes.
 *
 * @covers TABSHEET-02 @covers TABSHEET-03
 */
import { describe, expect, test } from 'bun:test';
import {
  buildTabSheetEntries, shapeLevels, rowCount, FIRST_LEVEL_MAX_ROWS,
  type SheetEntry, type TabSheetModel,
} from './tabSheetEntries';

const t = (key: string, vars?: Record<string, string>) => (vars?.n ? `${key}:${vars.n}` : key);
const noop = () => {};

/** A browser tab of a top-level bar with everything on offer. */
function fullBrowser(over: Partial<TabSheetModel> = {}): TabSheetModel {
  return {
    kind: 'browser', focused: true, t, hints: { find: 'F', close: 'W' },
    contextual: { returnToChat: noop, openInProject: noop, backToSpawner: noop },
    find: noop,
    page: { zoom: true, device: true, forgetSite: noop, tail: '100% · Desktop' },
    tools: { console: true, downloads: true, devTools: noop, errors: 2, downloadCount: 0 },
    session: { share: true, engine: true, render: true, tail: 'shared' },
    tab: { rename: true, pins: [{ scope: 'single', pinned: false, toggle: noop }], copyLink: noop, copyLinkIsTabOfPage: true },
    layout: {
      zoom: { zoomed: false, toggle: noop }, splitRight: noop, splitDown: noop, resetLayout: noop,
      moveToGroup: { groups: [{ id: 'a', name: 'Main', current: true }, { id: 'b', name: 'Two', current: false }], move: noop, newGroup: noop },
      detach: noop, popOutGroup: noop,
    },
    close: noop, closeOthers: noop,
    ...over,
  };
}

const ids = (entries: SheetEntry[]) => entries.filter((e) => e.kind !== 'divider').map((e) => e.id);

/** Every id reachable at any depth. */
function reachable(entries: SheetEntry[]): string[] {
  return entries.flatMap((e) => (e.kind === 'level' ? [e.id, ...reachable(e.children)] : e.kind === 'divider' ? [] : [e.id]));
}

describe('the first level (TABSHEET-02)', () => {
  test('contextual rows, search, the five levels in order, then the closes', () => {
    expect(ids(buildTabSheetEntries(fullBrowser()))).toEqual([
      'return-to-chat', 'open-in-project', 'back-to-spawner', 'find',
      'page', 'tools', 'session', 'tab', 'layout', 'close', 'close-others',
    ]);
  });

  test('never more than eleven rows, even with an agent at the wheel', () => {
    // The widest real tab: an agent drives it, it was lent by the topic window
    // and an agent's chat opened it. «Open in project» lives only in a task's
    // drawer, where a lent sheet does not, so the two never meet.
    const entries = buildTabSheetEntries(fullBrowser({
      contextual: { takeControl: noop, returnToChat: noop, backToSpawner: noop },
    }));
    expect(rowCount(entries)).toBe(FIRST_LEVEL_MAX_ROWS);
  });

  test('the Page level says zoom and device, the Tools level the errors, in its tail', () => {
    const entries = buildTabSheetEntries(fullBrowser());
    const page = entries.find((e) => e.id === 'page');
    const tools = entries.find((e) => e.id === 'tools');
    expect(page?.kind === 'level' && page.tail).toBe('100% · Desktop');
    expect(tools?.kind === 'level' && tools.tail).toBe('tabSheet.tail.errors:2');
    expect(tools?.kind === 'level' && tools.tailDanger).toBe(true);
  });
});

describe('the rule of the levels', () => {
  test('a level with one row does not exist: the row takes its place', () => {
    const entries = buildTabSheetEntries(fullBrowser({
      tab: { rename: false, pins: [], copyLink: noop, copyLinkIsTabOfPage: true },
    }));
    expect(ids(entries)).toContain('copy-link');
    expect(ids(entries)).not.toContain('tab');
  });

  test('a level with no rows is not drawn', () => {
    const entries = buildTabSheetEntries(fullBrowser({ tab: { rename: false, pins: [], copyLinkIsTabOfPage: true } }));
    expect(ids(entries)).not.toContain('tab');
  });

  test('at every depth, and no divider opens, closes or doubles a list', () => {
    const shaped = shapeLevels([
      { kind: 'divider', id: 'd0' },
      { kind: 'level', id: 'layout', label: 'L', children: [
        { kind: 'level', id: 'move-to-group', label: 'G', children: [{ kind: 'action', id: 'only', label: 'only', onSelect: noop }] },
        { kind: 'divider', id: 'd1' },
        { kind: 'divider', id: 'd2' },
        { kind: 'action', id: 'second', label: 'second', onSelect: noop },
      ] },
      { kind: 'divider', id: 'd3' },
    ]);
    expect(shaped).toHaveLength(1);
    const layout = shaped[0];
    expect(layout.kind).toBe('level');
    expect(layout.kind === 'level' && layout.children.map((c) => c.id)).toEqual(['only', 'd1', 'second']);
  });
});

describe('every command has one place (TABSHEET-03)', () => {
  test('a browser tab reaches every command of the old menu and sheet, the page address copy aside', () => {
    const all = reachable(buildTabSheetEntries(fullBrowser()));
    for (const id of [
      'find', 'rename', 'pin-single', 'copy-link', 'close', 'close-others', 'zoom', 'zoom-pane', 'zoom-cell', 'split-right',
      'split-down', 'reset-layout', 'move-to-group', 'console', 'devtools', 'device', 'forget-site',
    ]) expect(all).toContain(id);
    // Nothing copies the page address in the tree: the header's icon does.
    expect(all.filter((id) => /copy-(url|address)/.test(id))).toEqual([]);
    expect(new Set(all).size).toBe(all.length);
  });

  test('no close with a countdown, and no Close on a tab that cannot close', () => {
    const open = reachable(buildTabSheetEntries(fullBrowser()));
    expect(open.filter((id) => id.startsWith('close'))).toEqual(['close', 'close-others']);
    const structural = reachable(buildTabSheetEntries(fullBrowser({ close: undefined })));
    expect(structural).not.toContain('close');
  });

  test('a working chat offers Stop at the first level, a quiet one does not', () => {
    const chat = (stop?: () => void): TabSheetModel => ({
      kind: 'chat', focused: false, t, stopTurn: stop, find: noop, chatSettings: noop,
      tab: { rename: true, pins: [{ scope: 'single', pinned: true, toggle: noop }], copyLink: noop, copyLinkIsTabOfPage: false },
      close: noop,
    });
    expect(ids(buildTabSheetEntries(chat(noop)))).toEqual(['stop-turn', 'find', 'chat-settings', 'tab', 'close']);
    expect(ids(buildTabSheetEntries(chat()))).toEqual(['find', 'chat-settings', 'tab', 'close']);
  });

  test('inside a project the two pins are named apart', () => {
    const entries = buildTabSheetEntries({
      kind: 'utility', focused: false, t,
      tab: {
        rename: false,
        pins: [{ scope: 'project', pinned: false, toggle: noop }, { scope: 'tab', pinned: true, toggle: noop }],
        copyLinkIsTabOfPage: false,
      },
    });
    const tab = entries.find((e) => e.id === 'tab');
    expect(tab?.kind === 'level' && tab.children.map((c) => c.kind === 'action' ? c.label : c.id))
      .toEqual(['tab.menu.pinProject', 'tab.menu.unpinTab']);
  });
});
