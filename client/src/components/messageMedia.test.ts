/**
 * A media marker is drawn WHERE IT IS WRITTEN, and never as prose.
 *
 * Two defects met here. The marker reached the screen verbatim, because the
 * cleaning ran on `content` while a message with a timeline paints from
 * `blocks` (measured 2026-08-31 on a live row: two markers at the tail of block
 * 57 of 58). And the images always came out at the END, because nobody had
 * placed them: `updateLastMessageWithMedia` (server/utils.ts) finds them with a
 * directory scan by mtime and staples them to the last message.
 *
 * The split fixes both with one rule. What the server appends is at the end of
 * the last block, so it still lands at the end; what an agent writes mid-prose
 * lands mid-prose.
 *
 * @covers CHAT-MEDIA-01
 */
import { describe, expect, it } from 'bun:test';
import { splitBlockMedia } from './messageMedia';

const kinds = (t: string) => splitBlockMedia(t).map((p) => p.kind);
const paths = (t: string) => splitBlockMedia(t).flatMap((p) => (p.kind === 'media' ? [p.path] : []));

describe('splitBlockMedia', () => {
  it('keeps a block with no marker whole, and does not rebuild it', () => {
    const raw = 'Una risposta qualunque, con del **grassetto** e un path /Users/x/file.ts citato.';
    const parts = splitBlockMedia(raw);
    expect(parts).toEqual([{ kind: 'text', text: raw }]);
  });

  it('what the server appends stays at the END, which is where it was written', () => {
    const raw = 'Fatto, ecco le due viste.\nMEDIA:/Users/x/.topics/media/a.png\nMEDIA:/Users/x/.topics/media/b.png';
    expect(kinds(raw)).toEqual(['text', 'media', 'media']);
    expect(paths(raw)).toEqual(['/Users/x/.topics/media/a.png', '/Users/x/.topics/media/b.png']);
    expect(splitBlockMedia(raw)[0]).toEqual({ kind: 'text', text: 'Fatto, ecco le due viste.' });
  });

  it('what an agent writes MID-PROSE comes out mid-prose: this is the whole point', () => {
    const raw = 'Prima era così:\nMEDIA:/tmp/prima.png\ne dopo la cura è così:\nMEDIA:/tmp/dopo.png\nLa differenza è il velo.';
    expect(kinds(raw)).toEqual(['text', 'media', 'text', 'media', 'text']);
    const parts = splitBlockMedia(raw);
    expect(parts[0]).toEqual({ kind: 'text', text: 'Prima era così:' });
    expect(parts[2]).toEqual({ kind: 'text', text: 'e dopo la cura è così:' });
    expect(parts[4]).toEqual({ kind: 'text', text: 'La differenza è il velo.' });
  });

  it('a block that is nothing but a marker leaves no empty bubble behind', () => {
    expect(splitBlockMedia('MEDIA:/Users/x/.topics/media/solo.png')).toEqual([
      { kind: 'media', path: '/Users/x/.topics/media/solo.png' },
    ]);
    expect(splitBlockMedia('   \n  ')).toEqual([]);
  });

  it('takes the attachment and voice forms, which travel the same way', () => {
    const raw = 'Ecco [Attached file: /tmp/a.pdf] e poi [Voice message: /tmp/v.m4a] .';
    expect(paths(raw)).toEqual(['/tmp/a.pdf', '/tmp/v.m4a']);
    expect(splitBlockMedia(raw).every((p) => p.kind !== 'text' || !p.text.includes('Attached'))).toBe(true);
  });

  it('does not eat a word that merely starts with the marker name', () => {
    const raw = 'Il campo si chiama MEDIALIBRARY e non va toccato.';
    expect(splitBlockMedia(raw)).toEqual([{ kind: 'text', text: raw }]);
  });
});
