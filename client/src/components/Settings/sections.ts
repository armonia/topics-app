/**
 * THE SETTINGS ENTRIES, as data and not as JSX.
 *
 * The panel holds the FORMS only: the five things that need something typed
 * (a key, a URL, a code, a token) and cannot be a direct control in a 288px
 * menu level. Everything else moved (USERMENU-01..06):
 *  · appearance and notifications are levels of the user menu, where each
 *    control applies on change;
 *  · profile, followers and organization are the Profile tab, the one place
 *    that answers "who are you";
 *  · the devices are managed in their level of the user menu.
 * What was left of «Devices» here is the node pairing and the requests from
 * other computers, which is «Nodes».
 *
 * The list is exported as DATA so a test can read it without a DOM.
 */
import { CalendarDays, Cpu, CreditCard, Plug, Server } from 'lucide-react';

export type SectionId = 'providers' | 'tools' | 'calendar' | 'plan' | 'nodes';

export interface SettingsSection {
  id: SectionId;
  labelKey: string;
  icon: typeof Cpu;
}

// THE ORDER IS AN ARGUMENT: the engine first (what the app runs on), what it
// can reach (tools, calendar), what you pay for it, the machines it spans.
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'providers', labelKey: 'settings.section.providers', icon: Cpu },
  { id: 'tools', labelKey: 'settings.section.tools', icon: Plug },
  { id: 'calendar', labelKey: 'settings.section.calendar', icon: CalendarDays },
  { id: 'plan', labelKey: 'settings.section.plan', icon: CreditCard },
  { id: 'nodes', labelKey: 'settings.section.nodes', icon: Server },
];
