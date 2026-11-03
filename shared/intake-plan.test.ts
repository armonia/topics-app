import { describe, expect, test } from 'bun:test';
import { blockingReason, createRows, namesKnownProject, proposeCards } from './intake-plan';

const PROJECTS = [
  { projectId: 'p-app', name: 'topics-app' },
  { projectId: 'p-land', name: 'landing' },
];

describe('proposeCards', () => {
  test('two named projects give rows on both', () => {
    const rows = proposeCards('@topics-app fix relay timeout\n[landing] document it', PROJECTS, 'p-app');
    expect(rows.map((r) => [r.title, r.projectId])).toEqual([
      ['fix relay timeout', 'p-app'],
      ['document it', 'p-land'],
    ]);
  });

  test('prefix form and indented sub-card inheriting the parent project', () => {
    const rows = proposeCards('- landing: write the page\n    - add screenshots', PROJECTS, 'p-app');
    expect(rows[0].projectId).toBe('p-land');
    expect(rows[1]).toMatchObject({ parentKey: 'r1', projectId: 'p-land', title: 'add screenshots' });
  });

  test('an unknown project is unresolved, never invented', () => {
    const rows = proposeCards('@ghost do a thing', PROJECTS, 'p-app');
    expect(rows[0]).toMatchObject({ projectId: null, unresolvedName: 'ghost' });
    expect(blockingReason(rows)).not.toBeNull();
  });

  test('a prefix that is not a project stays part of the title', () => {
    const rows = proposeCards('note: remember this', PROJECTS, 'p-app');
    expect(rows[0]).toMatchObject({ title: 'note: remember this', projectId: 'p-app' });
  });

});

describe('createRows', () => {
  const rows = proposeCards('@topics-app parent\n  child\n[landing] other', PROJECTS, 'p-app');

  test('parents are created before children and children carry the parent id', async () => {
    const calls: [string, string | null][] = [];
    const out = await createRows(rows, async (r, parent) => { calls.push([r.title, parent]); return `id-${r.key}`; });
    expect(calls).toEqual([['parent', null], ['child', 'id-r1'], ['other', null]]);
    expect(out.failed).toEqual([]);
  });

  test('unticked parent: the child is created top-level, not lost', async () => {
    const parents: (string | null)[] = [];
    await createRows(rows.map((r) => (r.key === 'r1' ? { ...r, checked: false } : r)), async (r, p) => { parents.push(p); return 'id-' + r.key; });
    expect(parents).toEqual([null, null]);
  });

  test('a failure skips its children, reports, and retry creates only the rest', async () => {
    let fail = true;
    const create = async (r: { key: string }) => {
      if (r.key === 'r1' && fail) throw new Error('boom');
      return `id-${r.key}`;
    };
    const first = await createRows(rows, create);
    expect(first.failed).toEqual([{ key: 'r1', error: 'boom' }]);
    expect(first.skipped).toEqual(['r2']);
    expect(first.created.map((c) => c.key)).toEqual(['r3']);
    fail = false;
    const seen: string[] = [];
    const second = await createRows(rows, async (r) => { seen.push(r.key); return create(r); }, first.created);
    expect(seen).toEqual(['r1', 'r2']);
    expect(second.created.map((c) => c.key).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  test('cancel creates nothing: no ticked rows means no create call', async () => {
    let calls = 0;
    await createRows(rows.map((r) => ({ ...r, checked: false })), async () => { calls++; return 'x'; });
    expect(calls).toBe(0);
  });
});

describe('namesKnownProject', () => {
  test('only a known project name opens the panel', () => {
    expect(namesKnownProject('title\nbody text', PROJECTS)).toBe(false);
    expect(namesKnownProject('mail @someone about it', PROJECTS)).toBe(false);
    expect(namesKnownProject('do it\n[landing] and this', PROJECTS)).toBe(true);
  });
});
