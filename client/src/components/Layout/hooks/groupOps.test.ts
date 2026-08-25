/**
 * Sostituisce il describe "Split handler correctness (unit-level via evaluate)"
 * di grid-split.spec.ts: quattro test che incollavano la logica dentro
 * `page.evaluate` e asserivano l'incollatura — sarebbero rimasti verdi anche
 * cancellando l'implementazione vera. Qui si testa `groupOps.ts`, cioè il
 * codice che l'app esegue davvero, e senza avviare un browser.
 *
 * @covers LAYOUT-01
 */
import { describe, expect, test } from 'bun:test';
import type { PaneGroup } from '../../../types';
import {
  detachPaneFromGroups,
  movePaneBetweenGroups,
  nextActivePaneId,
  paneTypeToGroupType,
} from './groupOps';

const group = (id: string, paneIds: string[], activePaneId = paneIds[0]): PaneGroup => ({
  id,
  paneIds,
  activePaneId,
  type: 'chat',
});

describe('paneTypeToGroupType', () => {
  test('chat sta nel suo gruppo, i file nel loro, tutto il resto è utility', () => {
    expect(paneTypeToGroupType('chat')).toBe('chat');
    expect(paneTypeToGroupType('file')).toBe('file');
    expect(paneTypeToGroupType('files')).toBe('file');
    expect(paneTypeToGroupType('browser')).toBe('utility');
    expect(paneTypeToGroupType('terminal')).toBe('utility');
    expect(paneTypeToGroupType('git')).toBe('utility');
    expect(paneTypeToGroupType('project')).toBe('utility');
  });
});

describe('nextActivePaneId', () => {
  test('la tab che prende l’INDICE di quella che se ne va', () => {
    expect(nextActivePaneId(group('g', ['p1', 'p2', 'p3'], 'p2'), 'p2')).toBe('p3');
  });

  test('clampa all’ultima quando se ne va l’ultima', () => {
    expect(nextActivePaneId(group('g', ['p1', 'p2', 'p3'], 'p3'), 'p3')).toBe('p2');
  });

  test('chiudere una tab di sfondo non ruba il fuoco', () => {
    expect(nextActivePaneId(group('g', ['p1', 'p2', 'p3'], 'p1'), 'p3')).toBe('p1');
  });

  test('senza tab rimaste non inventa un attivo', () => {
    expect(nextActivePaneId(group('g', ['p1'], 'p1'), 'p1')).toBe('p1');
  });
});

describe('detachPaneFromGroups', () => {
  test('lo split di un gruppo a pane singolo fa sparire il gruppo sorgente', () => {
    const groups = [group('g1', ['p1']), group('g2', ['p2', 'p3'])];
    const updated = detachPaneFromGroups(groups, 'g1', 'p1');
    expect(updated.map(g => g.id)).toEqual(['g2']);
    expect(updated[0].paneIds).toEqual(['p2', 'p3']);
  });

  test('con altre tab il gruppo resta e l’attivo scala di uno', () => {
    const updated = detachPaneFromGroups([group('g1', ['p1', 'p2'], 'p1')], 'g1', 'p1');
    expect(updated[0].paneIds).toEqual(['p2']);
    expect(updated[0].activePaneId).toBe('p2');
  });

  test('i gruppi che non c’entrano non vengono toccati (stesso riferimento)', () => {
    const other = group('g2', ['p2']);
    const updated = detachPaneFromGroups([group('g1', ['p1', 'px']), other], 'g1', 'p1');
    expect(updated.find(g => g.id === 'g2')).toBe(other);
  });

  test('un paneId inesistente non svuota nulla', () => {
    const updated = detachPaneFromGroups([group('g1', ['p1', 'p2'])], 'g1', 'assente');
    expect(updated[0].paneIds).toEqual(['p1', 'p2']);
  });
});

describe('movePaneBetweenGroups', () => {
  test('toglie dalla sorgente, inserisce all’indice nella destinazione e la attiva', () => {
    const groups = [group('g1', ['p1', 'p2'], 'p1'), group('g2', ['p3'], 'p3')];
    const updated = movePaneBetweenGroups(groups, 'g1', 'g2', 'p1', 1);
    expect(updated).toHaveLength(2);
    expect(updated.find(g => g.id === 'g1')?.paneIds).toEqual(['p2']);
    expect(updated.find(g => g.id === 'g1')?.activePaneId).toBe('p2');
    expect(updated.find(g => g.id === 'g2')?.paneIds).toEqual(['p3', 'p1']);
    expect(updated.find(g => g.id === 'g2')?.activePaneId).toBe('p1');
  });

  test('spostare l’ultima pane elimina il gruppo che si è svuotato', () => {
    const groups = [group('g1', ['p1'], 'p1'), group('g2', ['p3'], 'p3')];
    const updated = movePaneBetweenGroups(groups, 'g1', 'g2', 'p1', 0);
    expect(updated.map(g => g.id)).toEqual(['g2']);
    expect(updated[0].paneIds).toEqual(['p1', 'p3']);
  });

  test('l’indice di inserimento è clampato agli estremi', () => {
    const groups = [group('g1', ['p1', 'p2']), group('g2', ['p3'])];
    expect(movePaneBetweenGroups(groups, 'g1', 'g2', 'p1', 99).find(g => g.id === 'g2')?.paneIds)
      .toEqual(['p3', 'p1']);
    expect(movePaneBetweenGroups(groups, 'g1', 'g2', 'p1', -5).find(g => g.id === 'g2')?.paneIds)
      .toEqual(['p1', 'p3']);
  });

  test('gruppo mancante o pane altrove: il layout resta identico', () => {
    const groups = [group('g1', ['p1']), group('g2', ['p2'])];
    expect(movePaneBetweenGroups(groups, 'g1', 'assente', 'p1', 0)).toBe(groups);
    expect(movePaneBetweenGroups(groups, 'assente', 'g2', 'p1', 0)).toBe(groups);
    expect(movePaneBetweenGroups(groups, 'g1', 'g2', 'p2', 0)).toBe(groups);
  });
});
