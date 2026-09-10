/**
 * The board carries the typed correction with its send-back decision.
 * Pure text handling and the card's wiring live here. The drawer's button,
 * Enter key and attachments are verified against persisted API data in
 * board-conversation-details.spec.ts.
 * @covers KANBAN-05
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendBackComment } from './taskChoices';

const src = (file: string): string => readFileSync(join(import.meta.dir, file), 'utf8');

describe('sendBackComment — cosa viaggia con il rimando', () => {
  test("l'indicazione scritta parte con la decisione", () => {
    expect(sendBackComment('guarda il bordo destro')).toBe('guarda il bordo destro');
  });

  test('gli spazi attorno non fanno parte di quello che si è scritto', () => {
    expect(sendBackComment('  manca il caso vuoto \n')).toBe('manca il caso vuoto');
  });

  // I tre modi in cui «non ho scritto niente» arriva qui. Tutti e tre devono
  // dare `undefined` e non la stringa vuota: `undefined` è un reject nudo,
  // `''` scriverebbe nel thread un commento vuoto firmato dall'umano.
  test('la casella vuota resta un rimando senza indicazione', () => {
    expect(sendBackComment('')).toBeUndefined();
    expect(sendBackComment('   \n  ')).toBeUndefined();
    expect(sendBackComment(undefined)).toBeUndefined();
    expect(sendBackComment(null)).toBeUndefined();
  });
});

describe('le saldature — chi chiama la regola, e chi non chiama più il gemello', () => {
  test('la riga di scelte manda il testo insieme al reject', () => {
    const row = src('TaskChoiceRow.tsx');
    // Il caso `send-back` deve passare per la regola. Un `review(projectId, id,
    // 'reject')` nudo è precisamente il difetto: stessa riga, un argomento in meno.
    expect(row).toContain("case 'send-back': await boardApi.review(projectId, id, 'reject', sendBackComment(pendingText?.()));");
    expect(/import \{[^}]*sendBackComment[^}]*\} from '\.\/taskChoices'/.test(row)).toBe(true);
  });

  test('la card passa alla riga di scelte quello che hai battuto nel suo campo', () => {
    const card = src('Card.tsx');
    expect(/pendingText=\{\(\) => freeText\}/.test(card)).toBe(true);
    // E lo svuota dopo: un testo che resta nella casella dopo essere partito
    // sembra non essere partito, e al secondo click parte due volte.
    expect(/const choiceDone = \(\) => \{[^}]*setFreeText\(''\)/.test(card)).toBe(true);
  });

  // Drawer submission is exercised through the browser and persisted API
  // data in board-conversation-details.spec.ts (button, Enter and media).
});
