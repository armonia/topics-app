/**
 * The bus between the ⇧⌘I chord (`useKeyboardShortcuts`) and the inbox's
 * button (`components/Sidebar/Inbox.tsx`): the chord announces the intent, the
 * button opens its panel. A leaf module, so neither side imports the other.
 */
export const OPEN_INBOX_EVENT = 'topics:open-inbox';
