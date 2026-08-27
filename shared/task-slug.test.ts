/**
 * @covers TASKLINK-01
 */
import { describe, test, expect } from 'bun:test';
import { taskLinkSlug, taskLinkSegment, taskIdFromSegment, isTaskUuid } from './task-slug';

const UUID = '1f4c2a8e-4b21-4a1e-9d0f-0c7b6a5e4d31';

describe('task-slug — lo slug decorativo del link di un task', () => {
  test('un titolo diventa un segmento leggibile e senza caratteri da codificare', () => {
    expect(taskLinkSlug('Leggibilità del link condiviso di un task'))
      .toBe('leggibilita-del-link-condiviso-di-un-task');
    expect(taskLinkSlug('Fix: Cmd/Ctrl+, su Windows')).toBe('fix-cmd-ctrl-su-windows');
  });

  test('un titolo senza lettere non produce decorazione: resta il solo uuid', () => {
    expect(taskLinkSlug('🎉🎉')).toBe('');
    expect(taskLinkSlug('   ')).toBe('');
    expect(taskLinkSegment(UUID, '🎉')).toBe(UUID);
    expect(taskLinkSegment(UUID)).toBe(UUID);
  });

  test('lo slug si accorcia su un confine di parola, e non finisce mai con un trattino', () => {
    const slug = taskLinkSlug('parola '.repeat(20));
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.startsWith('parola-parola')).toBe(true);
    const unico = taskLinkSlug('a'.repeat(120));
    expect(unico.length).toBe(48);
  });

  test('il segmento fa il giro: costruito con il titolo, letto torna l uuid', () => {
    const segment = taskLinkSegment(UUID, 'Un titolo qualunque');
    expect(segment).toBe(`un-titolo-qualunque-${UUID}`);
    expect(taskIdFromSegment(segment)).toBe(UUID);
  });

  test('UNO SLUG SBAGLIATO NON SPOSTA IL BERSAGLIO: la chiave è solo l uuid finale', () => {
    // The case that matters: a title renamed after the link was sent, or a slug
    // mangled by hand. The day this stopped holding, the slug would have
    // stopped being decoration and gone back to being addressing.
    expect(taskIdFromSegment(`tutt-altro-titolo-${UUID}`)).toBe(UUID);
    expect(taskIdFromSegment(UUID)).toBe(UUID);
    expect(taskIdFromSegment(`-${UUID}`)).toBe(UUID);
  });

  test('un id che non è un uuid resta il segmento intero, e non si decora', () => {
    expect(taskIdFromSegment('t1')).toBe('t1');
    expect(taskIdFromSegment('k-1')).toBe('k-1');
    expect(taskLinkSegment('k-1', 'Un titolo')).toBe('k-1');
    expect(isTaskUuid('k-1')).toBe(false);
    expect(isTaskUuid(UUID)).toBe(true);
  });
});
