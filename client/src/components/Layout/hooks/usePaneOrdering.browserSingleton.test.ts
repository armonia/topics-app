/**
 * BRW-REL-01 — browserSingletonReducer must never "steal" (rebind) another
 * context's browser pane when an explicit contextId is given: one browser
 * pane per context. Legacy context-less opens keep the old singleton reuse.
 *
 * @covers BROWSER-CHAT-04
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { browserSingletonReducer, groupClaimsBrowserNavigate } from './usePaneOrdering';
import { usePaneStore } from '../../../state/pane/store';
import { DEFAULT_SPACE_ID } from '../../../state/pane/types';

/**
 * Il reducer NON è del tutto puro: il ramo 2b consulta lo store globale
 * (`findGlobalBrowserPaneId` legge `usePaneStore.groups['group:default']`) per
 * non creare un secondo browser quando una pane esiste altrove nell'app.
 *
 * `usePaneStore` è uno Zustand a livello di modulo, e sotto `bun test` tutti i
 * file condividono un solo registro dei moduli: quello che semina un altro file
 * resta lì. Senza questo reset l'ultimo test — «con NESSUN browser da nessuna
 * parte» — non garantiva la propria precondizione: bastava che un file eseguito
 * prima avesse lasciato una pane browser nello store e il reducer prendeva
 * QUELLA, restituendo un `resolvedId` che non era in `next`.
 *
 * In locale non si vedeva mai, perché l'ordine dei file lo teneva a posto; su
 * CI l'ordine è diverso, e il rosso diceva
 * `Expected to contain: "browser:B" · Received: [ "topic-a" ]` — un id che
 * questo file non ha mai scritto.
 */
function resetPaneStore(): void {
  usePaneStore.setState({
    panes: {},
    groups: {},
    closedStack: [],
    focusedPaneId: null,
    groupOrder: [],
    spaces: {},
    activeSpaceId: DEFAULT_SPACE_ID,
    lastSeq: 0,
    lastServerSeq: 0,
  });
}

describe('browserSingletonReducer', () => {
  beforeEach(resetPaneStore);

  test('exact contextId match reuses the existing pane', () => {
    const prev = ['topic-a', 'browser:ctx-a'];
    const { next, resolvedId } = browserSingletonReducer(prev, 'ctx-a');
    expect(resolvedId).toBe('browser:ctx-a');
    expect(next).toBe(prev); // untouched
  });

  test('contextId with no match CREATES a new pane — never rebinds another context\'s pane', () => {
    const prev = ['topic-a', 'browser:ctx-a', 'topic-b'];
    const { next, resolvedId } = browserSingletonReducer(prev, 'ctx-b');
    expect(resolvedId).toBe('browser:ctx-b');
    // The old pane survives untouched and the new one is appended.
    expect(next).toContain('browser:ctx-a');
    expect(next).toContain('browser:ctx-b');
    expect(next.length).toBe(prev.length + 1);
  });

  test('context-less open reuses the first browser pane in the group (legacy)', () => {
    const prev = ['topic-a', 'browser:ctx-a'];
    const { next, resolvedId } = browserSingletonReducer(prev);
    expect(resolvedId).toBe('browser:ctx-a');
    expect(next).toBe(prev);
  });

  test('context-less open with no browser anywhere creates a fresh pane', () => {
    const prev = ['topic-a'];
    const { next, resolvedId } = browserSingletonReducer(prev);
    expect(resolvedId.startsWith('browser:')).toBe(true);
    expect(next).toContain(resolvedId);
  });

  test('un browser ALTROVE nell\'app viene riusato, non duplicato (ramo globale)', () => {
    // Il ramo 2b, quello che rende il reducer non-puro, e finora mai asserito:
    // ogni StandaloneChatGroup esegue questo reducer sul PROPRIO `prev`, quindi
    // senza lo sguardo globale due istanze creerebbero ognuna la sua pane e ne
    // uscirebbero due browser. Qui si semina lo store come farebbe una pane
    // solo'ata in un'altra cella.
    usePaneStore.setState({
      groups: {
        'group:default': {
          id: 'group:default',
          paneIds: ['browser:altrove'],
          splitRatio: 0.5,
          splitAxis: 'horizontal',
        },
      },
    });

    const prev = ['topic-a'];
    const { next, resolvedId } = browserSingletonReducer(prev);
    expect(resolvedId, 'deve riusare la pane che esiste altrove').toBe('browser:altrove');
    expect(next, "e non aggiungerne una nuova al proprio gruppo").toBe(prev);
  });
});

/**
 * CHI RIVENDICA un `browser:navigate`. La regola stava scritta due volte — nel
 * listener WS e nel gemello DOM — e le due copie sono divergite: la DOM è stata
 * corretta il 10/07/2026 (CHAT-REL-03), la WS no. Il prezzo, visto l'11/08/2026
 * in sessione reale: `open_browser_pane` su una topic SENZA progetto apriva il
 * contesto browser (vivo in `browser_list_tabs`, pilotabile, pagina caricata) e
 * non montava NESSUN pannello — perché il gruppo standalone scaricava il frame
 * sulla finestra di progetto e quella lo rifiutava, non essendo la topic sua.
 */
describe('groupClaimsBrowserNavigate — la regola sta scritta una volta sola', () => {
  test('IL GUASTO: topic senza progetto + una tab di progetto aperta nel gruppo ⇒ rivendica lo stesso', () => {
    expect(groupClaimsBrowserNavigate({
      topicId: 'topic-a',
      hasProjectPane: true,          // ← prima bastava questo per lasciar cadere tutto
      orderedIds: ['topic-a', 'project:/qualcosa'],
    })).toBe(true);
  });

  test('la topic è una tab di questo gruppo ⇒ rivendica', () => {
    expect(groupClaimsBrowserNavigate({
      topicId: 'topic-a', hasProjectPane: false, orderedIds: ['topic-a'],
    })).toBe(true);
  });

  test('la topic NON è una tab di questo gruppo ⇒ non la dirotta (la prende chi la mostra)', () => {
    expect(groupClaimsBrowserNavigate({
      topicId: 'topic-di-progetto', hasProjectPane: false, orderedIds: ['topic-a'],
    })).toBe(false);
  });

  test('frame senza topicId: non attribuibile, quindi il pannello di progetto ha la precedenza', () => {
    expect(groupClaimsBrowserNavigate({
      hasProjectPane: true, orderedIds: ['project:/qualcosa'],
    })).toBe(false);
    expect(groupClaimsBrowserNavigate({
      hasProjectPane: false, orderedIds: ['topic-a'],
    })).toBe(true);
  });
});
