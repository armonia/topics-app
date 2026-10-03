/**
 * EVERY FORM BY ITS NAME, in the palette (SETHOME-01).
 *
 * There is no «Settings» to open any more: each command opens the form where it
 * lives (beside the model selector, the composer's «+», the calendar tile, or
 * the user menu) and, with that home not on screen, as a sheet of its own
 * (`Settings/HomePanelHost`). Searchable rows of the palette's action list, so
 * the arrows and Enter reach them like any other command.
 */
import { Bell, CalendarDays, CreditCard, KeyRound, Palette, Plug, Server } from 'lucide-react';
import { openHome, type SettingHome } from '../../lib/openHome';
import type { CommandAction } from './CommandPalette';
import type { Translate } from '../../../../shared/queue-reason-text';

const HOMES: Array<{ home: SettingHome; label: string; hint: string; icon: React.ReactNode }> = [
  { home: 'providers', label: 'home.providers', hint: 'home.palette.providers', icon: <KeyRound size={14} /> },
  { home: 'tools', label: 'home.tools', hint: 'home.palette.tools', icon: <Plug size={14} /> },
  { home: 'calendar', label: 'home.calendar', hint: 'home.palette.calendar', icon: <CalendarDays size={14} /> },
  { home: 'plan', label: 'settings.section.plan', hint: 'home.palette.plan', icon: <CreditCard size={14} /> },
  { home: 'machines', label: 'home.machines', hint: 'home.palette.machines', icon: <Server size={14} /> },
  { home: 'appearance', label: 'settings.section.appearance', hint: 'home.palette.appearance', icon: <Palette size={14} /> },
  { home: 'notifications', label: 'settings.section.notifications', hint: 'home.palette.notifications', icon: <Bell size={14} /> },
];

/** The rows, translated; each closes the palette and opens its home. */
export function homeCommands(t: Translate, onClose: () => void): CommandAction[] {
  return HOMES.map((h) => ({
    id: `home-${h.home}`,
    label: t(h.label),
    description: t(h.hint),
    icon: h.icon,
    category: 'action' as const,
    testId: `palette-home-${h.home}`,
    action: () => { onClose(); openHome(h.home); },
  }));
}
