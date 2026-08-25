/**
 * Il percorso che vale come piano — verificato contro i due file veri prodotti
 * dalla CLI in plan mode (uno dal turno dell'utente, uno da un probe).
 *
 * @covers CHAT-02
 */
import { describe, expect, test } from 'bun:test';
import { isPlanFile } from './plan-file';

describe('isPlanFile', () => {
  test('i percorsi veri prodotti dalla CLI', () => {
    expect(isPlanFile('/Users/utente/.claude/plans/context-you-are-working-deep-locket.md')).toBe(true);
    expect(isPlanFile('/Users/utente/.claude/plans/crea-un-file-note-txt-cozy-wilkes.md')).toBe(true);
  });

  test('una home qualunque, e Windows', () => {
    expect(isPlanFile('/home/x/.claude/plans/p.md')).toBe(true);
    expect(isPlanFile('C:\\Users\\x\\.claude\\plans\\p.md')).toBe(true);
  });

  test('una scrittura normale resta una scrittura', () => {
    expect(isPlanFile('/Users/x/Projects/app/README.md')).toBe(false);
    expect(isPlanFile('/Users/x/.claude/CLAUDE.md')).toBe(false);
    expect(isPlanFile('/Users/x/.claude/plans/sub/p.md')).toBe(false);
    expect(isPlanFile('/Users/x/plans/p.md')).toBe(false);
  });

  test('solo markdown', () => {
    expect(isPlanFile('/Users/x/.claude/plans/p.txt')).toBe(false);
    expect(isPlanFile('/Users/x/.claude/plans/')).toBe(false);
  });

  test('non esplode su input strani', () => {
    expect(isPlanFile('')).toBe(false);
    expect(isPlanFile(undefined as unknown as string)).toBe(false);
  });
});
