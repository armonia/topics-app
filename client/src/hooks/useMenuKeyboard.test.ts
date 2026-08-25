/**
 * @covers GESTURE-05
 */
import { describe, expect, it } from 'bun:test';
import { mnemonicMatch } from './useMenuKeyboard';

/**
 * La regola della lettera nuda, isolata dal DOM. Quello che conta è che sia
 * case-insensitive (l'utente non tiene Shift per premere "b") e che un tasto
 * senza corrispondenza non faccia NIENTE — mai «la prima riga» per ripiego:
 * queste righe creano cose.
 */
describe('mnemonicMatch', () => {
  const rows = ['N', 'S', 'C', 'X', 'O', 'B', 'G', 'F', 'D'];

  it('trova la riga, minuscolo o maiuscolo', () => {
    expect(mnemonicMatch(rows, 'b')).toBe(5);
    expect(mnemonicMatch(rows, 'B')).toBe(5);
  });

  it('nessuna corrispondenza = nessuna azione', () => {
    expect(mnemonicMatch(rows, 'z')).toBe(-1);
  });

  it('ignora i tasti non-carattere (Enter, Tab, frecce)', () => {
    expect(mnemonicMatch(rows, 'Enter')).toBe(-1);
    expect(mnemonicMatch(rows, 'Tab')).toBe(-1);
    expect(mnemonicMatch(rows, 'ArrowDown')).toBe(-1);
  });

  it('salta le righe senza lettera invece di contarle', () => {
    // Una riga può non avere mnemonic (l'ultima risorsa della regola di
    // assegnazione): non deve né matchare né spostare gli indici delle altre.
    expect(mnemonicMatch(['N', null, 'B'], 'b')).toBe(2);
  });

  it('la prima corrispondenza vince', () => {
    expect(mnemonicMatch(['B', 'B'], 'b')).toBe(0);
  });
});
