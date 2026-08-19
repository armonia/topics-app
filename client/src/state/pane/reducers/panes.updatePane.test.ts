/**
 * LA GUARDIA DI `UPDATE_PANE`: non aggiornare a vuoto, ma non perdere un
 * aggiornamento vero.
 *
 * Il rimedio al ciclo di scritture (75 KB ogni 1,15 s a schermo fermo) fa
 * uscire il reducer quando NESSUN campo cambia. Sbagliarlo nella direzione
 * opposta è molto peggio del difetto che toglie: un titolo che non si aggiorna
 * più, un URL che resta indietro dopo una navigazione. Questi test tengono
 * ferme entrambe le metà, e in particolare il caso misto — un campo uguale e
 * uno diverso nella stessa patch — che è la forma in cui gli aggiornamenti
 * veri arrivano davvero (`persistBrowserPaneTitle` manda title + titleSource
 * insieme, e nel caso comune uno dei due è già a posto).
 */
import { describe, test, expect } from 'bun:test';
import { paneReducer } from './index';
import type { PaneState } from '../types';
import { DEFAULT_SPACE_ID } from '../types';

function statoCon(pane: Record<string, unknown>): PaneState {
  return {
    panes: { p1: { id: 'p1', type: 'browser', ...pane } as never },
    groups: {}, closedStack: [], tombstones: {}, focusedPaneId: null,
    groupOrder: [], spaces: {}, activeSpaceId: DEFAULT_SPACE_ID,
    lastSeq: 0, lastServerSeq: 0,
  } as unknown as PaneState;
}

describe("UPDATE_PANE — la guardia non perde aggiornamenti veri", () => {
  test("un campo DIVERSO passa", () => {
    const s = statoCon({ title: 'vecchio' });
    paneReducer(s, { type: 'UPDATE_PANE', payload: { id: 'p1', updates: { title: 'nuovo' } } } as never);
    expect((s.panes.p1 as { title?: string }).title).toBe('nuovo');
  });

  test("IL CASO MISTO: un campo uguale e uno diverso — l'aggiornamento passa", () => {
    // È la forma vera: `persistBrowserPaneTitle` manda `title` + `titleSource`
    // insieme, e quando la sorgente è già 'auto' solo il titolo cambia. Una
    // guardia che chiedesse «TUTTI diversi» perderebbe questo.
    const s = statoCon({ title: 'vecchio', titleSource: 'auto' });
    paneReducer(s, {
      type: 'UPDATE_PANE',
      payload: { id: 'p1', updates: { title: 'nuovo', titleSource: 'auto' } },
    } as never);
    const p = s.panes.p1 as { title?: string; titleSource?: string };
    expect(p.title).toBe('nuovo');
    expect(p.titleSource).toBe('auto');
  });

  test("un campo che passa da ASSENTE a valorizzato passa", () => {
    // `undefined` contro un valore: `Object.is` li distingue, ma la patch
    // arriva su una pane che quel campo non ce l'ha proprio.
    const s = statoCon({ title: 'x' });
    paneReducer(s, { type: 'UPDATE_PANE', payload: { id: 'p1', updates: { url: 'https://a' } } } as never);
    expect((s.panes.p1 as { url?: string }).url).toBe('https://a');
  });

  test("tutto uguale: l'oggetto non viene sostituito (è ciò che ferma il ciclo)", () => {
    // L'IDENTITÀ è il punto, non il contenuto: un oggetto nuovo con gli stessi
    // valori fa salire `lastSeq` e fa partire un PUT da 75 KB.
    const s = statoCon({ title: 'uguale', url: 'https://a' });
    const prima = s.panes.p1;
    paneReducer(s, {
      type: 'UPDATE_PANE',
      payload: { id: 'p1', updates: { title: 'uguale', url: 'https://a' } },
    } as never);
    expect(s.panes.p1).toBe(prima);
  });

  test("`id` e `type` restano fuori dal confronto come dalla scrittura", () => {
    // Sono scartati prima: una patch che prova a cambiarli non deve nemmeno
    // contare come «qualcosa è cambiato», o rientrerebbe dalla finestra.
    const s = statoCon({ title: 'uguale' });
    const prima = s.panes.p1;
    paneReducer(s, {
      type: 'UPDATE_PANE',
      payload: { id: 'p1', updates: { id: 'ALTRO', type: 'chat', title: 'uguale' } },
    } as never);
    expect(s.panes.p1).toBe(prima);
    expect((s.panes.p1 as { id: string }).id).toBe('p1');
  });
});
