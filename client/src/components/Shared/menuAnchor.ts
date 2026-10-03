/**
 * THE ELEMENT A MENU HANGS FROM, for the rows inside it.
 *
 * A row that opens something beside the menu's trigger once the menu has gone
 * (the model selector's «Provider e chiavi» opens the providers panel next to
 * the selector) needs that trigger, and the rows are written once for four
 * selectors that each keep their own ref. `Menu` provides it; outside a `Menu`
 * it is `null`. A module of its own: a component file that also exports a hook
 * loses fast refresh.
 */
import { createContext, useContext, type RefObject } from 'react';

export const MenuAnchorContext = createContext<RefObject<HTMLElement | null> | null>(null);

export function useMenuAnchor(): RefObject<HTMLElement | null> | null {
  return useContext(MenuAnchorContext);
}
