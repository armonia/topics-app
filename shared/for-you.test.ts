/** @covers KANBAN-73 */
import { describe, expect, test } from 'bun:test';
import { parseForYou, hasJargon } from './for-you';

const good = { asked: 'Niente: va solo chiusa.', happened: 'Le stesse cose tornavano ogni volta.', done: 'Ho solo guardato, era già a posto.', remains: 'Chiuderla.', options: ['Chiudila'] };

describe('parseForYou', () => {
  test('reads four lines and the choices out of a model answer wrapped in prose', () => {
    expect(parseForYou(`Ecco:\n${JSON.stringify(good)}`)).toEqual(good);
  });
  test('refuses an answer with a line missing', () => {
    expect(parseForYou(JSON.stringify({ ...good, done: '' }))).toBeNull();
  });
  test('refuses jargon: hashes, paths, file names, card or PR numbers', () => {
    for (const bad of ['commit 4f1a2b9c0', 'in /srv/app/file', 'server/foo.ts', 'la PR #36', 'card #8812']) {
      expect(hasJargon(bad)).toBe(true);
      expect(parseForYou(JSON.stringify({ ...good, done: bad }))).toBeNull();
    }
  });
  test('refuses text that is not JSON', () => {
    expect(parseForYou('non so')).toBeNull();
  });
});
