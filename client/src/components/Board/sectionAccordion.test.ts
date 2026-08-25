/**
 * What a remembered section has to survive.
 *
 * The five hand-rolled copies this replaces all read `!== '0'`, and that is not
 * an accident worth "cleaning up": a private-mode throw, a cleared profile and
 * an older build's value must all land on OPEN. A section stuck shut is
 * indistinguishable from a section that has nothing in it.
  * @covers KANBAN-36
 */
import { describe, expect, test } from 'bun:test';
import { readSectionOpen, sectionKey, writeSectionOpen } from './sectionAccordion';

function fakeStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
  };
}

describe('la chiave di una sezione', () => {
  test('una sola forma, cosi un rinomino non si applica a meta', () => {
    expect(sectionKey('Desc')).toBe('board:taskDescOpen');
    expect(sectionKey('Workspace')).toBe('board:taskWorkspaceOpen');
  });
});

describe('aperto salvo prova contraria', () => {
  test('mai vista prima: aperta', () => {
    expect(readSectionOpen('Desc', fakeStore())).toBe(true);
  });

  test('solo il valore "0" la tiene chiusa', () => {
    expect(readSectionOpen('Desc', fakeStore({ 'board:taskDescOpen': '0' }))).toBe(false);
    expect(readSectionOpen('Desc', fakeStore({ 'board:taskDescOpen': '1' }))).toBe(true);
    // An older build, or a hand-written value: open, not stuck shut.
    expect(readSectionOpen('Desc', fakeStore({ 'board:taskDescOpen': 'true' }))).toBe(true);
  });

  test('storage che esplode (finestra privata): aperta lo stesso', () => {
    const broken = { getItem: () => { throw new Error('SecurityError'); } };
    expect(readSectionOpen('Desc', broken)).toBe(true);
  });
});

describe('scrivere', () => {
  test('va e torna', () => {
    const s = fakeStore();
    writeSectionOpen('Downloads', false, s);
    expect(s.map.get('board:taskDownloadsOpen')).toBe('0');
    expect(readSectionOpen('Downloads', s)).toBe(false);
    writeSectionOpen('Downloads', true, s);
    expect(readSectionOpen('Downloads', s)).toBe(true);
  });

  test('uno storage che rifiuta non rompe la sezione', () => {
    const broken = { setItem: () => { throw new Error('QuotaExceeded'); } };
    expect(() => writeSectionOpen('Desc', false, broken)).not.toThrow();
  });
});
