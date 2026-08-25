/**
 * How many tabs each pane group holds, and whether the tab-bar chrome is drawn
 * at all: an empty group is not enough, unless it is a window of its own.
 *
 * @covers LAYOUT-02
 */
import { describe, test, expect } from 'bun:test';
import { tabsPerSpace, groupChromeActive } from './spaceHelpers';
import { DEFAULT_SPACE_ID, type Pane, type SpaceMeta } from '../../state/pane/types';

/** Una pane minima: qui contano solo `id` e `spaceId`. */
const pane = (id: string, spaceId?: string): Pane =>
  ({ id, type: 'chat', title: id, ...(spaceId ? { spaceId } : {}) }) as Pane;

const space = (id: string, extra: Partial<SpaceMeta> = {}): SpaceMeta =>
  ({ id, name: id, order: 0, updatedAt: 1, ...extra }) as SpaceMeta;

describe('tabsPerSpace — quante tab tiene ciascun gruppo', () => {
  test('una pane senza spaceId sta nel Principale', () => {
    const panes = { a: pane('a'), b: pane('b') };
    expect(tabsPerSpace(['a', 'b'], panes, {})).toEqual(new Map([[DEFAULT_SPACE_ID, 2]]));
  });

  test('conta per gruppo, e il gruppo SCIOLTO ricade nel Principale', () => {
    const spaces = { 'space:1': space('space:1'), 'space:2': space('space:2', { deleted: true }) };
    const panes = { a: pane('a', 'space:1'), b: pane('b', 'space:2'), c: pane('c') };
    expect(tabsPerSpace(['a', 'b', 'c'], panes, spaces)).toEqual(
      new Map([['space:1', 1], [DEFAULT_SPACE_ID, 2]]),
    );
  });

  test('conta le TAB, non le pane: ciò che non è nella fila non conta', () => {
    // Una pane che il pane-store conosce ma che non è nella fila delle tab non
    // tiene su niente — è il caso che faceva sopravvivere una scatola vuota.
    const spaces = { 'space:1': space('space:1') };
    const panes = { a: pane('a', 'space:1'), fantasma: pane('fantasma', 'space:1') };
    expect(tabsPerSpace([], panes, spaces).get('space:1')).toBeUndefined();
    expect(tabsPerSpace(['a'], panes, spaces).get('space:1')).toBe(1);
  });
});

describe('groupChromeActive — le scatole si disegnano solo se qualcuna tiene qualcosa', () => {
  const spaces = { 'space:1': space('space:1') };

  test('zero gruppi ⇒ niente impalcatura', () => {
    expect(groupChromeActive({}, null, new Map())).toBe(false);
  });

  test('un gruppo che tiene una tab accende tutto', () => {
    expect(groupChromeActive(spaces, null, new Map([['space:1', 1]]))).toBe(true);
  });

  test('IL CASO: un gruppo che ESISTE ma è vuoto non basta', () => {
    // Era `liveSpacesOrdered(spaces).length > 0`: un record nella registry
    // teneva accese le card anche dopo che l'ultima tab se n'era andata, e la
    // colonna si riempiva di scatole vuote.
    expect(groupChromeActive(spaces, null, new Map([[DEFAULT_SPACE_ID, 3]]))).toBe(false);
  });

  test('ma un gruppo vuoto che vive in una FINESTRA sua conta: è da lì che lo richiami', () => {
    expect(groupChromeActive(spaces, null, new Map(), new Map([['space:1', 'win-2']]))).toBe(true);
  });

  test('una finestra-gruppo disegna sempre il suo gruppo, anche a zero tab', () => {
    expect(groupChromeActive({}, 'space:1', new Map())).toBe(true);
  });

  test('un gruppo sciolto non conta, nemmeno con le sue vecchie tab ancora marchiate', () => {
    const morto = { 'space:1': space('space:1', { deleted: true }) };
    expect(groupChromeActive(morto, null, new Map([['space:1', 2]]))).toBe(false);
  });
});
