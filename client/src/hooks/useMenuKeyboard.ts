import { useCallback } from 'react';

/**
 * useMenuKeyboard — la tastiera di un menu, in un posto solo.
 *
 * Due comportamenti, entrambi sul PANNELLO (che deve avere il fuoco:
 * `tabIndex={-1}` + `focus()` all'apertura):
 *
 *   1. **Roving** — ↓/↑ scorrono le righe, Home/End vanno agli estremi. Era già
 *      dentro `Menu.tsx`; qui è estratto perché serve anche alla palette ⌘N,
 *      che non passa da `Menu` (è centrata, non ancorata) e quindi non aveva
 *      NESSUNA navigazione da tastiera.
 *   2. **Mnemonic** — un tasto NUDO attiva la riga che lo dichiara con
 *      `data-mnemonic`. È il pezzo che rende il menu «⌘N poi B = nuovo
 *      browser»: un accordo, non una modalità. Generico apposta — qualunque
 *      menu ci entra mettendo `data-mnemonic` sulle sue righe, senza toccare
 *      questo file.
 *
 * Il tasto nudo NON viene intercettato quando arriva da un campo di testo
 * dentro il menu (un filtro, un rename inline): lì una "b" è una lettera, non
 * un comando. Stesso motivo per cui si ignora ogni combinazione con
 * ⌘/Ctrl/Alt: quelle appartengono alle scorciatoie globali.
 */

/** Righe realmente focalizzabili. I `<button>` entrano senza dover dichiarare
 *  un role, così i menu esistenti diventano navigabili senza modifiche. */
const ITEM_SELECTOR =
  '[role="menuitem"]:not([aria-disabled="true"]), [role="option"]:not([aria-disabled="true"]), button:not([disabled])';

/** L'attributo che una riga usa per dichiarare la propria lettera. */
export const MNEMONIC_ATTR = 'data-mnemonic';

function isTypingSurface(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  if (!n || !n.tagName) return false;
  const tag = n.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || n.isContentEditable === true;
}

/**
 * Quale riga attivare per un tasto nudo, dato l'elenco delle mnemonic. Puro,
 * così la regola (case-insensitive, prima corrispondenza, nessuna = nessuna
 * azione) si testa senza DOM.
 */
export function mnemonicMatch(mnemonics: readonly (string | null)[], key: string): number {
  if (key.length !== 1) return -1;
  const want = key.toLowerCase();
  return mnemonics.findIndex((m) => !!m && m.toLowerCase() === want);
}

export interface UseMenuKeyboardOptions {
  panelRef: React.RefObject<HTMLElement | null>;
  /** false = il pannello gestisce da sé la tastiera (campo di ricerca + lista
   *  custom): nessun roving, nessuna mnemonic. */
  enabled?: boolean;
}

export function useMenuKeyboard({ panelRef, enabled = true }: UseMenuKeyboardOptions) {
  return useCallback(
    (e: React.KeyboardEvent) => {
      if (!enabled) return;
      const panel = panelRef.current;
      if (!panel) return;

      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        const items = Array.from(panel.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
        if (items.length === 0) return;
        e.preventDefault();
        const idx = items.indexOf(document.activeElement as HTMLElement);
        const target =
          e.key === 'Home' ? 0
          : e.key === 'End' ? items.length - 1
          : e.key === 'ArrowDown' ? (idx < 0 ? 0 : (idx + 1) % items.length)
          : idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length;
        items[target]?.focus();
        return;
      }

      // Mnemonic: tasto nudo, fuori da un campo di testo.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingSurface(e.target)) return;
      const rows = Array.from(panel.querySelectorAll<HTMLElement>(`[${MNEMONIC_ATTR}]`));
      if (rows.length === 0) return;
      const hit = mnemonicMatch(rows.map((r) => r.getAttribute(MNEMONIC_ATTR)), e.key);
      if (hit < 0) return;
      e.preventDefault();
      rows[hit].click();
    },
    [panelRef, enabled],
  );
}
