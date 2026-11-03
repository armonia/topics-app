import { describe, expect, test } from 'bun:test';
import { blockingReason, createRows, followParents, proposeCards, shouldPropose, submitAction } from './intake-plan';

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

describe('followParents', () => {
  test('a child follows its parent when the parent moves project', () => {
    const rows = proposeCards('@topics-app parent\n  child\n    grandchild', PROJECTS, 'p-app');
    rows[0].projectId = 'p-land';
    expect(followParents(rows).map((r) => r.projectId)).toEqual(['p-land', 'p-land', 'p-land']);
  });

  test('a child of an unresolved parent is blocked until the parent is resolved', () => {
    const rows = proposeCards('@ghost parent\n  child', PROJECTS, 'p-app');
    expect(followParents(rows).map((r) => r.projectId)).toEqual([null, null]);
    expect(blockingReason(rows)).not.toBeNull();
    rows[0].projectId = 'p-app';
    expect(blockingReason(rows)).toBeNull();
  });

  test('createRows sends the child to the parent project even when the row kept the old one', async () => {
    const rows = proposeCards('@topics-app parent\n  child', PROJECTS, 'p-app');
    rows[0].projectId = 'p-land';
    const seen: (string | null)[] = [];
    await createRows(rows, async (r) => { seen.push(r.projectId); return 'id-' + r.key; });
    expect(seen).toEqual(['p-land', 'p-land']);
  });
});

describe('existing cards', () => {
  test('under: the new card is created under the existing one', async () => {
    const rows = proposeCards('@topics-app new', PROJECTS, 'p-app');
    rows[0].existingParentTaskId = 'old-1';
    const parents: (string | null)[] = [];
    await createRows(rows, async (_r, p) => { parents.push(p); return 'id-new'; });
    expect(parents).toEqual(['old-1']);
  });

  test('above: the existing card is adopted by the new one, and an adopt failure is reported', async () => {
    const rows = proposeCards('@topics-app new', PROJECTS, 'p-app');
    rows[0].existingChildTaskId = 'old-2';
    const adopted: string[] = [];
    const ok = await createRows(rows, async () => 'id-new', [], async (r, id) => { adopted.push(`${r.existingChildTaskId}>${id}`); });
    expect(adopted).toEqual(['old-2>id-new']);
    const bad = await createRows(rows, async () => 'id-new', [], async () => { throw new Error('nope'); });
    expect(ok.adoptFailed).toEqual([]);
    expect(bad.adoptFailed).toEqual([{ key: 'r1', error: 'nope' }]);
    expect(bad.created).toHaveLength(1);
  });
});

describe('shouldPropose', () => {
  test('one card stays one card, as before', () => {
    expect(shouldPropose('@topics-app fix the relay timeout', PROJECTS)).toBe(false);
    expect(shouldPropose('title\nbody text', PROJECTS)).toBe(false);
  });

  test('a prose description holding a landing: line stays one card', () => {
    expect(shouldPropose('Fix the page\nit breaks on mobile\nlanding: check it too\nand the footer', PROJECTS)).toBe(false);
  });

  test('a list naming a known project opens the proposal', () => {
    expect(shouldPropose('@topics-app fix relay\n[landing] document it', PROJECTS)).toBe(true);
    expect(shouldPropose('- landing: page\n  - screenshots', PROJECTS)).toBe(true);
    expect(shouldPropose('- one\n- two', PROJECTS)).toBe(false);
    expect(shouldPropose('mail @someone\n[nowhere] x', PROJECTS)).toBe(false);
  });
});

describe('submitAction', () => {
  const list = '@topics-app a\n[landing] b';
  test('with the panel open Enter confirms and never creates', () => {
    expect(submitAction(true, list, false, PROJECTS)).toBe('confirm-plan');
    expect(submitAction(true, 'plain', false, null)).toBe('confirm-plan');
  });
  test('closed: a list proposes, anything else creates as today', () => {
    expect(submitAction(false, list, false, PROJECTS)).toBe('propose');
    expect(submitAction(false, list, true, PROJECTS)).toBe('create');
    expect(submitAction(false, '@topics-app single', false, PROJECTS)).toBe('create');
    expect(submitAction(false, list, false, null)).toBe('create');
  });
});
