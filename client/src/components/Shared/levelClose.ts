/**
 * CLOSE THE LEVEL YOU ARE IN, from inside it.
 *
 * `SubmenuItem` provides its own `close` to whatever its level renders, so a
 * level that draws its own close button (the header of the user menu's form
 * levels) closes exactly that level and not the menu that hosts it. Outside a
 * level the function does nothing. A module of its own: a component file that
 * also exports a hook loses fast refresh.
 */
import { createContext, useContext } from 'react';

export const LevelCloseContext = createContext<() => void>(() => {});

export function useCloseLevel(): () => void {
  return useContext(LevelCloseContext);
}
