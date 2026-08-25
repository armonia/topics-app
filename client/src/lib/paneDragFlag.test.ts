import { describe, expect, it } from 'bun:test';
import { isPaneTabDrag, PANE_DRAG_ATTR } from './paneDragFlag';
import { DND_TYPES, paneTabScopeType } from './dndTypes';

/**
 * Quali gesti bucano gli iframe.
 *
 * Rendere gli iframe trasparenti ai puntatori è ciò che fa funzionare «lascio
 * un browser sopra un altro browser», ma è anche una pane browser che per
 * qualche istante non si può cliccare: va acceso per il gesto che ne ha
 * bisogno, e SOLO per quello. Una trascinata di file dal Finder o una riga
 * della sidebar non atterrano mai dentro il corpo di una pane, quindi qui non
 * devono entrare.
 *
 * @covers LAYOUT-02
 */
describe('isPaneTabDrag', () => {
  it('la trascinata di una TAB accende (tipo + gruppo, come li scrive PaneTabBar)', () => {
    expect(isPaneTabDrag([
      DND_TYPES.PANE_TAB,
      DND_TYPES.PANE_TAB_GROUP,
      DND_TYPES.PANEL_ID,
      paneTabScopeType('main'),
    ])).toBe(true);
  });

  it('un file dal Finder non accende', () => {
    expect(isPaneTabDrag(['Files', 'text/uri-list'])).toBe(false);
  });

  it('una riga della sidebar (solo PANEL_ID) non accende', () => {
    expect(isPaneTabDrag([DND_TYPES.PANEL_ID])).toBe(false);
  });

  it('PANE_TAB senza il gruppo non basta: è la mezza trascinata di una barra senza gruppo', () => {
    expect(isPaneTabDrag([DND_TYPES.PANE_TAB])).toBe(false);
  });

  it('senza types (dataTransfer assente) non accende', () => {
    expect(isPaneTabDrag(undefined)).toBe(false);
  });
});

describe('PANE_DRAG_ATTR', () => {
  it('è lo stesso attributo su cui si aggancia la regola CSS', () => {
    // Se questo cambia senza toccare `index.css`, il flag si accende e non
    // succede niente: il gesto tornerebbe morto in silenzio.
    expect(PANE_DRAG_ATTR).toBe('data-pane-drag');
  });
});
