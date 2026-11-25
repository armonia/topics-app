/**
 * The sections of the ORBIT settings and of the person's preferences, with
 * their icons and addresses. The organization's (`/impostazioni/<section>`, allow-italian: address segment):
 * Organization, Agents, Log. The person's (`/preferenze/<section>`, open to
 * everyone): Appearance, Notifications.
 */
import { Bell, Bot, Landmark, Palette, ScrollText, type LucideIcon } from 'lucide-react';
import type { OrbitSettingsSection } from '../../../../ui/copy/orbit-admin';
import { SP } from '../../paths';

export const SECTION_ICON: Record<OrbitSettingsSection, LucideIcon> = {
  organizzazione: Landmark, // allow-italian: section ids, address segments
  agenti: Bot, // allow-italian: section ids, address segments
  registro: ScrollText, // allow-italian: section ids, address segments
  aspetto: Palette, // allow-italian: section ids, address segments
  notifiche: Bell, // allow-italian: section ids, address segments
};

/** Where each section lives: the ones of the organization under Impostazioni, the ones of the person under Preferenze. (allow-italian: quotes the Italian interface) */
export const SECTION_PATH: Record<OrbitSettingsSection, string> = {
  organizzazione: SP.settings('organizzazione'), // allow-italian: section ids, address segments
  agenti: SP.settings('agenti'), // allow-italian: section ids, address segments
  registro: SP.settings('registro'), // allow-italian: section ids, address segments
  aspetto: SP.prefs('aspetto'), // allow-italian: section ids, address segments
  notifiche: SP.prefs('notifiche'), // allow-italian: section ids, address segments
};

/** The sections of the organization, in the order of their strip. */
export const ORG_SECTIONS: OrbitSettingsSection[] = ['organizzazione', 'agenti', 'registro']; // allow-italian: section ids, address segments

/** The sections of the person, in the order of their strip. */
export const PERSON_SECTIONS: OrbitSettingsSection[] = ['aspetto', 'notifiche']; // allow-italian: section ids, address segments

/** Every section, the organization's first. */
export const SECTIONS: OrbitSettingsSection[] = [...ORG_SECTIONS, ...PERSON_SECTIONS];

/** Whether a section belongs to the person (and is open to everyone). */
export const isPersonSection = (section: OrbitSettingsSection) => PERSON_SECTIONS.includes(section);
