/**
 * A POPOVER THAT KEEPS ITS QUESTIONS.
 *
 * The user menu holds forms now, and a form asks before it destroys («remove
 * the licence?», «sign out?») through `useConfirm`. By default a modal clears
 * every popover, which is right for ⌘K and wrong here: the menu would vanish
 * under the person answering a question it asked. A host that provides `true`
 * makes every `useConfirm` below it open its dialog INSIDE the popover: the
 * popover stays, and a press on the dialog does not count as a press outside.
 * A module of its own so `useConfirm.tsx` keeps exporting components only.
 */
import { createContext } from 'react';

export const ConfirmInsidePopoverContext = createContext(false);
