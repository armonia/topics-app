/**
 * L'intento di fuoco, misurato dove si decide: `resolveStoreFocus` è la
 * riconciliazione che Effect A (usePanelLifecycle) esegue a ogni bump di
 * `lastSeq` dello store, cioè a OGNI dispatch — un click su una tab ne produce
 * uno. Il guasto che questi test recintano è quello riportato dall'utente:
 * «sono su board, apro un progetto dalla sidebar, faccio una chat nuova e mi
 * riporta a board».
 *
 * @covers LAYOUT-02
 */
import { describe, expect, test } from 'bun:test';
import {
  armFocusIntent,
  liveFocusIntent,
  resolveStoreFocus,
  FOCUS_INTENT_TTL_MS,
} from './focusIntent';

const BOARD = '__board__';
const PROJECT = 'project:%2Ftmp%2Fdark-room';

/** Lo stato tipico del guasto: board e progetto aperti, il fuoco sul progetto. */
function afterOpeningTheProject(boardIntent: string | null) {
  return {
    prev: PROJECT,
    storeFocus: PROJECT,
    storeOrder: [BOARD, PROJECT],
    visibleOrder: [BOARD, PROJECT],
    boardIntent,
    tabIntent: null,
  };
}

describe('liveFocusIntent', () => {
  test('un intento appena armato è vivo, uno scaduto è inerte', () => {
    const t0 = 1_000_000;
    const intent = armFocusIntent(BOARD, t0);
    expect(liveFocusIntent(intent, t0)).toBe(BOARD);
    expect(liveFocusIntent(intent, t0 + FOCUS_INTENT_TTL_MS)).toBe(BOARD);
    expect(liveFocusIntent(intent, t0 + FOCUS_INTENT_TTL_MS + 1)).toBeNull();
  });

  test('nessun intento = nessuna pretesa sul fuoco', () => {
    expect(liveFocusIntent(null)).toBeNull();
  });
});

describe('resolveStoreFocus', () => {
  test('un intento VIVO della board tiene la board davanti (è il suo mestiere)', () => {
    // Questo è il comportamento VOLUTO durante la finestra di boot: il
    // deep-link ha appena aperto la board e l'idratazione proverebbe a
    // restituire la scena alla pane di prima.
    expect(resolveStoreFocus(afterOpeningTheProject(BOARD))).toBe(BOARD);
  });

  test('rilasciato l\'intento, il fuoco resta dove l\'utente l\'ha messo', () => {
    // IL GUASTO: prima, l'intento della board non scadeva e il click sul
    // progetto in sidebar non lo rilasciava. Ogni dispatch successivo ripassava
    // di qui e rispondeva `__board__`. La creazione di una chat nuova bastava.
    expect(resolveStoreFocus(afterOpeningTheProject(null))).toBe(PROJECT);
  });

  test('un intento scaduto non conta: `liveFocusIntent` lo spegne prima', () => {
    const armedLongAgo = armFocusIntent(BOARD, 0);
    const boardIntent = liveFocusIntent(armedLongAgo, FOCUS_INTENT_TTL_MS + 1);
    expect(resolveStoreFocus(afterOpeningTheProject(boardIntent))).toBe(PROJECT);
  });

  test('un intento senza riscontro nello store è inerte, non blocca il fuoco', () => {
    // Una chat che si è aperta DENTRO un progetto non compare in group:default:
    // pretendere quel fuoco lascerebbe la finestra su una pane che non c'è.
    expect(resolveStoreFocus({
      prev: PROJECT,
      storeFocus: PROJECT,
      storeOrder: [BOARD, PROJECT],
      visibleOrder: [BOARD, PROJECT],
      boardIntent: null,
      tabIntent: 'terminal:mai-vista',
    })).toBe(PROJECT);
  });

  test('la board batte il permalink di tab quando sono vivi tutti e due', () => {
    expect(resolveStoreFocus({
      prev: PROJECT,
      storeFocus: PROJECT,
      storeOrder: [BOARD, PROJECT],
      visibleOrder: [BOARD, PROJECT],
      boardIntent: BOARD,
      tabIntent: PROJECT,
    })).toBe(BOARD);
  });

  test('senza intenti vince il fuoco dello store, poi quello locale', () => {
    expect(resolveStoreFocus({
      prev: BOARD,
      storeFocus: PROJECT,
      storeOrder: [BOARD, PROJECT],
      visibleOrder: [BOARD, PROJECT],
      boardIntent: null,
      tabIntent: null,
    })).toBe(PROJECT);

    // Lo store non sa dove siamo (fuoco su una pane che non ha più): il locale
    // regge, perché la sua pane c'è ancora.
    expect(resolveStoreFocus({
      prev: PROJECT,
      storeFocus: 'chat:sparita',
      storeOrder: [BOARD, PROJECT],
      visibleOrder: [BOARD, PROJECT],
      boardIntent: null,
      tabIntent: null,
    })).toBe(PROJECT);
  });

  test('ultimo appiglio: la prima pane VISIBILE, mai una nascosta in un altro Spazio', () => {
    expect(resolveStoreFocus({
      prev: 'chat:chiusa',
      storeFocus: 'chat:sparita',
      storeOrder: [BOARD, PROJECT],
      visibleOrder: [PROJECT],
      boardIntent: null,
      tabIntent: null,
    })).toBe(PROJECT);
  });
});
