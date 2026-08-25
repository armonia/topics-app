/**
 * La regola «dove finisce un file che apro» viveva incollata in tre punti
 * (`handleOpenFile`, `handleOpenDiff`, `handleOpenProcessLog`) e non aveva un
 * test: per eseguirla serviva un ProjectWindow montato. Qui è un array.
 *
 * @covers LAYOUT-01, TAB-SYNC-03
 */
import { describe, expect, test } from 'bun:test';
import type { Pane, PaneGroup } from '../../../types';
import { planOpenPane } from './paneOpenPlan';

const file = (id: string, path: string, preview = false): Pane => ({
  id,
  type: 'file',
  filePath: path,
  title: path,
  preview,
});
const group = (id: string, paneIds: string[], type: PaneGroup['type'] = 'file'): PaneGroup => ({
  id,
  paneIds,
  activePaneId: paneIds[0],
  type,
});
const newFile = file('file:new', '/a/new.ts', true);
const byPath = (path: string) => (p: Pane) => p.type === 'file' && p.filePath === path;

describe('planOpenPane — già aperto', () => {
  test('lo si mette a fuoco nel suo gruppo, senza crearne un altro', () => {
    const panes = [file('file:1', '/a/x.ts')];
    const plan = planOpenPane(panes, [group('g1', ['file:1'])], 'g1', newFile, {
      matchExisting: byPath('/a/x.ts'),
    });
    expect(plan).toEqual({ kind: 'focus', paneId: 'file:1', groupId: 'g1' });
  });

  test('esiste ma è ORFANA ⇒ `groupId: null`, non c’è niente da attivare', () => {
    const plan = planOpenPane([file('file:1', '/a/x.ts')], [], null, newFile, {
      matchExisting: byPath('/a/x.ts'),
    });
    expect(plan).toEqual({ kind: 'focus', paneId: 'file:1', groupId: null });
  });
});

describe('planOpenPane — gruppo bersaglio', () => {
  test('il gruppo A FUOCO vince sul primo', () => {
    const plan = planOpenPane([], [group('g1', ['a']), group('g2', ['b'])], 'g2', newFile, {
      matchExisting: () => false,
    });
    expect(plan).toMatchObject({ kind: 'append', groupId: 'g2' });
  });

  test('nessun fuoco ⇒ il primo gruppo', () => {
    const plan = planOpenPane([], [group('g1', ['a']), group('g2', ['b'])], null, newFile, {
      matchExisting: () => false,
    });
    expect(plan).toMatchObject({ kind: 'append', groupId: 'g1' });
  });

  test('un fuoco che punta a un gruppo MORTO ricade sul primo', () => {
    const plan = planOpenPane([], [group('g1', ['a'])], 'sparito', newFile, {
      matchExisting: () => false,
    });
    expect(plan).toMatchObject({ kind: 'append', groupId: 'g1' });
  });

  test('nessun gruppo ⇒ la pane si aggiunge orfana (la colloca l’orphan-sync)', () => {
    const plan = planOpenPane([], [], null, newFile, { matchExisting: () => false });
    expect(plan).toEqual({ kind: 'append', pane: newFile, groupId: null });
  });
});

describe('planOpenPane — anteprima', () => {
  test('sostituisce l’anteprima al SUO posto nella barra, non in coda', () => {
    const panes = [file('file:pinned', '/a/p.ts'), file('file:prev', '/a/old.ts', true)];
    const plan = planOpenPane(
      panes,
      [group('g1', ['file:pinned', 'file:prev'])],
      'g1',
      newFile,
      { matchExisting: () => false, replacePreviewOfType: 'file' },
    );
    expect(plan).toEqual({
      kind: 'replace-preview',
      pane: newFile,
      groupId: 'g1',
      replacedPaneId: 'file:prev',
      paneIds: ['file:pinned', 'file:new'],
    });
  });

  test('senza anteprima da sostituire si accoda', () => {
    const plan = planOpenPane(
      [file('file:pinned', '/a/p.ts')],
      [group('g1', ['file:pinned'])],
      'g1',
      newFile,
      { matchExisting: () => false, replacePreviewOfType: 'file' },
    );
    expect(plan).toMatchObject({ kind: 'append', groupId: 'g1' });
  });

  test('senza `replacePreviewOfType` (log di processo) l’anteprima resta dov’è', () => {
    const plan = planOpenPane(
      [file('file:prev', '/a/old.ts', true)],
      [group('g1', ['file:prev'])],
      'g1',
      { id: 'process-log:1', type: 'process-log', processId: '1', title: 'dev' },
      { matchExisting: () => false },
    );
    expect(plan).toMatchObject({ kind: 'append', groupId: 'g1' });
  });

  test('l’anteprima si cerca solo fra le pane del TIPO indicato', () => {
    const panes: Pane[] = [
      { id: 'chat:prev', type: 'chat', topicId: 'prev', title: 'chat', preview: true },
    ];
    const plan = planOpenPane(panes, [group('g1', ['chat:prev'], 'chat')], 'g1', newFile, {
      matchExisting: () => false,
      replacePreviewOfType: 'file',
    });
    expect(plan).toMatchObject({ kind: 'append', groupId: 'g1' });
  });
});
