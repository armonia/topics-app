/**
 * La passata righe↔gruppi era un `useEffect` che leggeva `rows`/`rowHeights`
 * dalle proprie ref — corretto, ma verificabile solo montando l'albero: nessun
 * test copriva «chiudere una colonna non azzera le larghezze delle sorelle»,
 * che è esattamente il tipo di regola che si rompe in silenzio.
 *
 * @covers LAYOUT-01
 */
import { describe, expect, test } from 'bun:test';
import type { GroupLayoutRow, PaneGroup } from '../../../types';
import { reconcileRowsWithGroups } from './rowLayoutReconcile';

const g = (id: string): PaneGroup => ({ id, paneIds: [`p:${id}`], activePaneId: `p:${id}`, type: 'chat' });
const row = (groupIds: string[], widths?: number[]): GroupLayoutRow => ({
  groupIds,
  widths: widths ?? groupIds.map(() => 1 / groupIds.length),
});

describe('reconcileRowsWithGroups — niente da fare', () => {
  test('griglia già coerente ⇒ `null` (nessun setRows, nessun render)', () => {
    expect(reconcileRowsWithGroups([row(['a', 'b'])], [1], [g('a'), g('b')])).toBeNull();
  });

  test('griglia vuota e nessun gruppo ⇒ `null`', () => {
    expect(reconcileRowsWithGroups([], [1], [])).toBeNull();
  });
});

describe('reconcileRowsWithGroups — potatura', () => {
  test('una colonna morta esce e le larghezze delle SORELLE restano in proporzione', () => {
    const out = reconcileRowsWithGroups([row(['a', 'b', 'c'], [0.5, 0.3, 0.2])], [1], [g('a'), g('c')]);
    expect(out).not.toBeNull();
    expect(out!.rows[0].groupIds).toEqual(['a', 'c']);
    // 0.5 : 0.2 conservato come rapporto, rinormalizzato a somma 1.
    expect(out!.rows[0].widths[0]).toBeCloseTo(0.5 / 0.7, 6);
    expect(out!.rows[0].widths[1]).toBeCloseTo(0.2 / 0.7, 6);
  });

  test('una riga svuotata sparisce e le ALTEZZE delle superstiti restano in proporzione', () => {
    const out = reconcileRowsWithGroups(
      [row(['a']), row(['b']), row(['c'])],
      [0.6, 0.1, 0.3],
      [g('a'), g('c')],
    );
    expect(out!.rows).toHaveLength(2);
    expect(out!.rowHeights).not.toBeNull();
    expect(out!.rowHeights![0]).toBeCloseTo(0.6 / 0.9, 6);
    expect(out!.rowHeights![1]).toBeCloseTo(0.3 / 0.9, 6);
  });

  test('potatura senza cambio di NUMERO di righe ⇒ le altezze non si toccano', () => {
    const out = reconcileRowsWithGroups([row(['a', 'b'])], [1], [g('a')]);
    expect(out!.rows[0].groupIds).toEqual(['a']);
    expect(out!.rowHeights).toBeNull();
  });
});

describe('reconcileRowsWithGroups — gruppi non ancora in griglia', () => {
  test('griglia vuota con gruppi vivi ⇒ una riga sola, larghezze pari', () => {
    const out = reconcileRowsWithGroups([], [1], [g('a'), g('b')]);
    expect(out!.rows).toEqual([{ groupIds: ['a', 'b'], widths: [0.5, 0.5] }]);
  });

  test('un gruppo nuovo si accoda alla PRIMA riga, senza resettare le larghezze esistenti', () => {
    const out = reconcileRowsWithGroups([row(['a', 'b'], [0.8, 0.2])], [1], [g('a'), g('b'), g('c')]);
    expect(out!.rows[0].groupIds).toEqual(['a', 'b', 'c']);
    // Le due colonne preesistenti mantengono il loro rapporto 4:1 nello spazio
    // che resta dopo aver dato la sua quota alla nuova.
    const [wa, wb, wc] = out!.rows[0].widths;
    expect(wa / wb).toBeCloseTo(4, 6);
    expect(wa + wb + wc).toBeCloseTo(1, 6);
  });

  test('un gruppo già impilato in una cella NON viene ri-aggiunto come colonna', () => {
    const rows: GroupLayoutRow[] = [
      { groupIds: ['a'], widths: [1], cellStacks: { a: { groupIds: ['a', 'stacked'], heights: [0.5, 0.5] } } },
    ];
    expect(reconcileRowsWithGroups(rows, [1], [g('a'), g('stacked')])).toBeNull();
  });

  test('un membro impilato che muore viene tolto dalla pila', () => {
    const rows: GroupLayoutRow[] = [
      { groupIds: ['a'], widths: [1], cellStacks: { a: { groupIds: ['a', 'dead'], heights: [0.5, 0.5] } } },
    ];
    const out = reconcileRowsWithGroups(rows, [1], [g('a')]);
    expect(out).not.toBeNull();
    const stack = out!.rows[0].cellStacks?.a;
    expect(stack?.groupIds ?? ['a']).not.toContain('dead');
  });
});
