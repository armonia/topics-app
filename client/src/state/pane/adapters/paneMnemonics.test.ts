import { describe, expect, it } from 'bun:test';
import {
  ADD_MENU_MNEMONICS,
  ADD_MENU_ROWS_BY_SCOPE,
  type AddMenuItemId,
} from './paneMnemonics';
import { getPaneConfig } from './paneConfig';
import { TERMINAL_AGENT_LABELS } from '../../../lib/terminalAgents';

/**
 * Il cancello delle lettere. Due invarianti, e sono la ragione per cui la mappa
 * è congelata invece di essere calcolata: se una lettera cambia di posto o ne
 * compaiono due uguali nello stesso menu, la funzione diventa peggio che
 * assente — l'utente preme e succede la cosa sbagliata.
 */

/** L'etichetta con cui la riga viene DAVVERO dipinta (stessa fonte del menu). */
const LABELS: Record<AddMenuItemId, string> = {
  'new-chat': 'Chat',
  shell: TERMINAL_AGENT_LABELS.shell,
  'claude-code': TERMINAL_AGENT_LABELS['claude-code'],
  codex: TERMINAL_AGENT_LABELS.codex,
  opencode: TERMINAL_AGENT_LABELS.opencode,
  browser: getPaneConfig('browser').label,
  git: getPaneConfig('git').label,
  files: getPaneConfig('files').label,
  kanban: getPaneConfig('kanban').label,
  board: getPaneConfig('board').label,
  'open-project': 'Progetto…',
};

describe('mnemonics del menu "New…"', () => {
  it('ogni riga dichiarata ha una lettera', () => {
    for (const scope of ['project', 'standalone'] as const) {
      for (const id of ADD_MENU_ROWS_BY_SCOPE[scope]) {
        expect(ADD_MENU_MNEMONICS[id], `${scope}/${id}`).toBeTruthy();
      }
    }
  });

  it('nessuna collisione DENTRO uno stesso menu', () => {
    // L'unicità si misura per scope, non sull'unione: `kanban` (Board) e
    // `board` (Board generale) condividono la D proprio perché non compaiono
    // mai insieme — sono la stessa riga in due contesti.
    for (const scope of ['project', 'standalone'] as const) {
      const letters = ADD_MENU_ROWS_BY_SCOPE[scope].map((id) => ADD_MENU_MNEMONICS[id].toLowerCase());
      const dupes = letters.filter((l, i) => letters.indexOf(l) !== i);
      expect(dupes, `collisioni in scope ${scope}`).toEqual([]);
    }
  });

  it('la lettera è SEMPRE contenuta nella sua etichetta', () => {
    // Così la resa a sottolineatura resta possibile come ripiego, e nessuna
    // lettera è una convenzione arbitraria da imparare a memoria.
    for (const [id, letter] of Object.entries(ADD_MENU_MNEMONICS) as [AddMenuItemId, string][]) {
      expect(
        LABELS[id].toLowerCase().includes(letter.toLowerCase()),
        `${id}: "${letter}" non è in "${LABELS[id]}"`,
      ).toBe(true);
    }
  });

  it('è UNA lettera sola', () => {
    for (const letter of Object.values(ADD_MENU_MNEMONICS)) {
      expect(letter).toHaveLength(1);
    }
  });

  it('C resta a Claude Code: è l\'agente di default', () => {
    // Regressione mirata, e vale per DUE tentazioni: dare C a Codex (viene
    // prima in ordine alfabetico nel blocco terminale) o darla a Chat (è la
    // prima riga). Entrambe sarebbero la scelta sbagliata — la voce che si
    // apre di più è Claude Code, e le altre due hanno una lettera libera più
    // in là nella loro etichetta.
    expect(ADD_MENU_MNEMONICS['claude-code']).toBe('C');
    expect(ADD_MENU_MNEMONICS.codex).toBe('X');
    expect(ADD_MENU_MNEMONICS['new-chat']).toBe('H');
  });

  it('ogni riga dichiarata negli scope esiste nella mappa, e viceversa', () => {
    const declared = new Set<string>([
      ...ADD_MENU_ROWS_BY_SCOPE.project,
      ...ADD_MENU_ROWS_BY_SCOPE.standalone,
    ]);
    expect([...declared].sort()).toEqual(Object.keys(ADD_MENU_MNEMONICS).sort());
  });
});
