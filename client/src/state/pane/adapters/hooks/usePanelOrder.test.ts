/**
 * `loadPanelOrder` decide quali tab sono ANTEPRIME, e un'anteprima è la tab che
 * la prossima apertura singola sostituisce — cioè chiude, cioè archivia, cioè
 * propaga l'archiviazione a tutti i dispositivi.
 *
 * Tornava `pinned: []` sempre: nessuna tab fissata ⇒ tutte anteprime ⇒ aprire
 * una chat ne archiviava un'altra. Questi test tengono il default sul lato
 * sicuro: nel dubbio la tab è fissata.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { usePaneStore } from '../../store';
import { loadPanelOrder } from './usePanelOrder';
import { findPreviewInList } from '../../../../lib/previewTabs';

type AnyPane = { id: string; type: string; preview?: boolean };

function seed(panes: AnyPane[]) {
  usePaneStore.setState({
    panes: Object.fromEntries(panes.map((p) => [p.id, p])) as never,
    groups: { 'group:default': { id: 'group:default', paneIds: panes.map((p) => p.id) } } as never,
  });
}

describe('loadPanelOrder — pinned dalle pane', () => {
  beforeEach(() => { seed([]); });

  it('una pane senza flag preview è FISSATA (il caso del profilo nuovo)', () => {
    // È lo stato di una tab arrivata dallo snapshot del server: qualcuno l'ha
    // aperta per restarci. Prima finiva fra le anteprime e veniva archiviata.
    seed([{ id: 'chat:a', type: 'chat' }, { id: 'chat:b', type: 'chat' }]);
    expect(loadPanelOrder().pinned).toEqual(['chat:a', 'chat:b']);
  });

  it('preview: false è fissata', () => {
    seed([{ id: 'chat:a', type: 'chat', preview: false }]);
    expect(loadPanelOrder().pinned).toEqual(['chat:a']);
  });

  it('SOLO preview: true resta anteprima', () => {
    seed([
      { id: 'chat:permanente', type: 'chat', preview: false },
      { id: 'chat:anteprima', type: 'chat', preview: true },
    ]);
    expect(loadPanelOrder().pinned).toEqual(['chat:permanente']);
  });

  it("l'invariante torna vera: al massimo UNA tab non fissata", () => {
    seed([
      { id: 'chat:a', type: 'chat' },
      { id: 'chat:b', type: 'chat' },
      { id: 'chat:c', type: 'chat', preview: true },
    ]);
    const { order, pinned } = loadPanelOrder();
    const anteprime = order.filter((id) => !pinned.includes(id));
    expect(anteprime).toEqual(['chat:c']);
  });

  it('order resta quello del gruppo di default', () => {
    seed([{ id: 'chat:a', type: 'chat' }, { id: 'chat:b', type: 'chat' }]);
    expect(loadPanelOrder().order).toEqual(['chat:a', 'chat:b']);
  });

  it('nessun gruppo: liste vuote, nessun crash', () => {
    usePaneStore.setState({ panes: {} as never, groups: {} as never });
    expect(loadPanelOrder()).toEqual({ order: [], pinned: [] });
  });
});

// ── Dove il difetto si manifestava davvero ─────────────────────────────────
//
// `loadPanelOrder().pinned` non è un dato che qualcuno guarda: è l'ingresso di
// `findPreviewInList`, che sceglie QUALE tab la prossima apertura singola
// sostituisce. Sostituire = chiudere = archiviare, e l'archiviazione si
// propaga a tutti i dispositivi. Questo test compone i due pezzi, che è il
// punto in cui il bug viveva — nessuno dei due, guardato da solo, sembrava
// sbagliato.
describe('loadPanelOrder + findPreviewInList — chi viene sostituito', () => {
  beforeEach(() => { seed([]); });

  it('due chat ripristinate dal server: NESSUNA è sostituibile', () => {
    seed([{ id: 'chat:a', type: 'chat' }, { id: 'chat:b', type: 'chat' }]);
    const { order, pinned } = loadPanelOrder();
    const daSostituire = findPreviewInList(order, new Set(pinned), 'chat:nuova');
    expect(daSostituire).toBeNull();
  });

  it('col vecchio comportamento (pinned vuoto) sarebbe caduta la PRIMA', () => {
    // La dimostrazione del danno: stesso ordine, insieme fissate vuoto.
    seed([{ id: 'chat:a', type: 'chat' }, { id: 'chat:b', type: 'chat' }]);
    const { order } = loadPanelOrder();
    expect(findPreviewInList(order, new Set(), 'chat:nuova')).toBe('chat:a');
  });

  it("con un'anteprima vera, è QUELLA a essere sostituita", () => {
    seed([
      { id: 'chat:permanente', type: 'chat', preview: false },
      { id: 'chat:anteprima', type: 'chat', preview: true },
    ]);
    const { order, pinned } = loadPanelOrder();
    expect(findPreviewInList(order, new Set(pinned), 'chat:nuova')).toBe('chat:anteprima');
  });
});
