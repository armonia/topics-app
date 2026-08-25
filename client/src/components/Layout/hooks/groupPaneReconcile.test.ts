/**
 * L'orphan-sync era un `setGroups(prev => …)` di 115 righe dentro un
 * `useEffect`: la regola che decide DOVE finisce una pane appena creata non
 * aveva un solo test, perché per eseguirla serviva montare un ProjectWindow.
 * Estratta in `groupPaneReconcile.ts`, si prova con quattro pane e un array.
 *
 * @covers LAYOUT-01, TAB-SYNC-03
 */
import { describe, expect, test } from 'bun:test';
import type { Pane, PaneGroup } from '../../../types';
import { reconcileGroupsWithPanes } from './groupPaneReconcile';

const chatPane = (id: string, preview = false): Pane => ({
  id,
  type: 'chat',
  topicId: id.replace('chat:', ''),
  title: id,
  preview,
});
const filePane = (id: string, preview = false): Pane => ({
  id,
  type: 'file',
  filePath: `/tmp/${id}`,
  title: id,
  preview,
});
const group = (
  id: string,
  paneIds: string[],
  type: PaneGroup['type'] = 'chat',
  activePaneId = paneIds[0],
): PaneGroup => ({ id, paneIds, activePaneId, type });

describe('reconcileGroupsWithPanes — potatura', () => {
  test('niente da fare ⇒ restituisce `prev` PER IDENTITÀ (nessun render inutile)', () => {
    const prev = [group('g1', ['chat:a', 'chat:b'])];
    const out = reconcileGroupsWithPanes(prev, [chatPane('chat:a'), chatPane('chat:b')], 'g1');
    expect(out.groups).toBe(prev);
    expect(out.previewCloseTopicId).toBeNull();
  });

  test('una pane sparita esce dal gruppo e il gruppo resta', () => {
    const out = reconcileGroupsWithPanes(
      [group('g1', ['chat:a', 'chat:b'])],
      [chatPane('chat:a')],
      'g1',
    );
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].paneIds).toEqual(['chat:a']);
  });

  test('se sparisce la pane ATTIVA il fuoco passa alla prima superstite', () => {
    const out = reconcileGroupsWithPanes(
      [group('g1', ['chat:a', 'chat:b'], 'chat', 'chat:b')],
      [chatPane('chat:a')],
      'g1',
    );
    expect(out.groups[0].activePaneId).toBe('chat:a');
  });

  test('un gruppo rimasto senza pane sparisce (niente celle vuote con la barra tab)', () => {
    const out = reconcileGroupsWithPanes(
      [group('g1', ['chat:a']), group('g2', ['chat:b'])],
      [chatPane('chat:b')],
      'g1',
    );
    expect(out.groups.map(g => g.id)).toEqual(['g2']);
  });
});

describe('reconcileGroupsWithPanes — collocazione degli orfani', () => {
  test('l’orfano va nel gruppo A FUOCO quando è del suo tipo', () => {
    const out = reconcileGroupsWithPanes(
      [group('g1', ['chat:a']), group('g2', ['chat:b'])],
      [chatPane('chat:a'), chatPane('chat:b'), chatPane('chat:c')],
      'g2',
    );
    expect(out.groups.find(g => g.id === 'g2')!.paneIds).toEqual(['chat:b', 'chat:c']);
    expect(out.groups.find(g => g.id === 'g1')!.paneIds).toEqual(['chat:a']);
  });

  test('fuoco su un gruppo di ALTRO tipo ⇒ primo gruppo del tipo giusto', () => {
    const out = reconcileGroupsWithPanes(
      [group('gf', ['file:x'], 'file'), group('gc', ['chat:a'], 'chat')],
      [filePane('file:x'), chatPane('chat:a'), chatPane('chat:b')],
      'gf',
    );
    expect(out.groups.find(g => g.id === 'gc')!.paneIds).toEqual(['chat:a', 'chat:b']);
  });

  test('nessun gruppo del tipo giusto e nessun fuoco ⇒ cade sul primo gruppo', () => {
    const out = reconcileGroupsWithPanes(
      [group('gc', ['chat:a'], 'chat')],
      [chatPane('chat:a'), filePane('file:x')],
      null,
    );
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].paneIds).toEqual(['chat:a', 'file:x']);
  });

  test('layout vuoto ⇒ nasce un gruppo del tipo dell’orfano, che ne è la pane attiva', () => {
    const out = reconcileGroupsWithPanes([], [filePane('file:x')], null);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].type).toBe('file');
    expect(out.groups[0].activePaneId).toBe('file:x');
  });

  test('la pane parcheggiata da reopenChatPane resta ORFANA per un tick', () => {
    const out = reconcileGroupsWithPanes(
      [group('g1', ['chat:a'])],
      [chatPane('chat:a'), chatPane('chat:targeted')],
      'g1',
      'chat:targeted',
    );
    expect(out.groups[0].paneIds).toEqual(['chat:a']);
  });
});

describe('reconcileGroupsWithPanes — anteprima', () => {
  test('un orfano di anteprima SOSTITUISCE l’anteprima già lì, non la affianca', () => {
    const out = reconcileGroupsWithPanes(
      [group('g1', ['chat:old', 'chat:pinned'], 'chat', 'chat:pinned')],
      [chatPane('chat:old', true), chatPane('chat:pinned'), chatPane('chat:new', true)],
      'g1',
    );
    expect(out.groups[0].paneIds).toEqual(['chat:new', 'chat:pinned']);
    expect(out.groups[0].activePaneId).toBe('chat:new');
    // La chat sostituita va chiusa fuori di qui: la funzione la SEGNALA.
    expect(out.previewCloseTopicId).toBe('old');
  });

  test('senza un’anteprima da sostituire l’orfano si accoda e non chiude niente', () => {
    const out = reconcileGroupsWithPanes(
      [group('g1', ['chat:pinned'])],
      [chatPane('chat:pinned'), chatPane('chat:new', true)],
      'g1',
    );
    expect(out.groups[0].paneIds).toEqual(['chat:pinned', 'chat:new']);
    expect(out.previewCloseTopicId).toBeNull();
  });

  test('la sostituzione è per TIPO: un file di anteprima non scalza una chat di anteprima', () => {
    const out = reconcileGroupsWithPanes(
      [group('g1', ['chat:old'], 'chat')],
      [chatPane('chat:old', true), filePane('file:new', true)],
      'g1',
    );
    expect(out.groups.find(g => g.paneIds.includes('chat:old'))).toBeTruthy();
    expect(out.previewCloseTopicId).toBeNull();
  });
});
