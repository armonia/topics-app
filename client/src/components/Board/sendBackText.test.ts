/**
 * UNA PORTA SOLA PER «RIMANDA INDIETRO», E IL TESTO CI PASSA DENTRO.
 *
 * ── Il difetto che questo file chiude ────────────────────────────────────────
 * In review c'erano due bottoni con due parole diverse che facevano la stessa
 * identica chiamata: «Rimanda indietro» (grande, nella zona di decisione) e
 * «Rimanda» (azzurro, accanto alla casella di testo). Tutti e due
 * `POST …/review` con `decision: 'reject'`, stessa colonna d'arrivo, stesso
 * risveglio dello stesso tab. L'unica differenza era l'argomento `comment`: il
 * gemello del composer lo mandava, il bottone grande no.
 *
 * Quindi il gesto più naturale — scrivo cosa non va, premo il bottone grande
 * che il tooltip stesso mi dice di usare («scrivi nel campo qui sotto per dargli
 * un'indicazione») — rimandava la card MUTA. L'agente ripartiva senza sapere
 * niente e la frase restava nella casella, come se non fosse mai partita.
 *
 * ── Perché il test è fatto così ──────────────────────────────────────────────
 * La regola («che cosa viaggia») è pura e si prova per davvero, qui sotto.
 * La SALDATURA («chi la chiama») non ha un mount unitario in questo progetto:
 * niente jsdom (stessa scelta di `Shared/Select.test.tsx` e `ThreadRuns.test.tsx`),
 * e `TaskDetail` si tira dietro l'API, il layout delle pane e una dozzina di
 * store. Ma la saldatura è esattamente il punto dove si sbaglia: un argomento
 * in meno in una riga sola. Quindi la si guarda sul sorgente, come già fa
 * `ThreadRuns.test.tsx` per la sua, e con lo stesso patto: il giorno che
 * qualcuno rimette il gemello o toglie l'argomento, questo file diventa rosso
 * prima che lo scopra una persona davanti allo schermo.
 *
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

  test('il drawer rimanda passando dal testo, non dal reject nudo', () => {
    const drawer = src('TaskDetail.tsx');
    expect(/onSendBack=\{\(\) => void sendBack\(\)\}/.test(drawer)).toBe(true);
    // `sendBack` sceglie la strada: con del testo (o un allegato) quella lunga,
    // che sa anche dei media; a mani vuote il reject nudo.
    expect(/if \(draft\.trim\(\) \|\| attachments\.length > 0\) \{ await send\(\); return; \}/.test(drawer)).toBe(true);
  });

  test('il gemello «Rimanda» non è più accanto alla casella del drawer', () => {
    const drawer = src('TaskDetail.tsx');
    // Il testid è il nome proprio di quel bottone: finché non c'è, non c'è il
    // doppione. «Nota» invece deve restare — è l'unica cosa che il composer sa
    // fare e che i bottoni di decisione non fanno.
    expect(drawer).not.toContain('task-reply-send-back');
    expect(drawer).toContain('task-reply-quiet-note');
  });

  test('il placeholder del drawer nomina il bottone vero, e lo nomina per interpolazione', () => {
    const drawer = src('TaskDetail.tsx');
    // Scritto a mano direbbe «Rimanda indietro» anche sulle card dove quel
    // bottone si chiama «Rimandalo avanti», mandando a cercare un bottone che
    // sullo schermo non c'è.
    expect(/tr\('board\.task\.replyPlaceholder', \{ sendBack: sendBackLabel \}\)/.test(drawer)).toBe(true);
  });
});
