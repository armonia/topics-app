/**
 * THE SETTINGS ENTRIES, as data and not as JSX.
 *
 * They used to live inside `GlobalSettings.tsx`, and while there were five of
 * them that was enough. The defect this module closes is a different one:
 * "Profile" was ONE entry holding six boxes, and six things answering three
 * different questions in a single scrolling column mean that whoever looked for
 * one of them concluded it did not exist, not that it was further down.
 *
 * -- WHY THE PROFILE PAGES ARE NOT THE SETTINGS PAGES ANY MORE ---------------
 * `SETTINGS_SECTIONS` is the settings PANEL: it still carries "organization",
 * because creating a group, adding members and handing out roles is
 * administration and it has to live somewhere.
 *
 * `IDENTITY_SECTIONS` is the PROFILE TAB, and it deliberately no longer
 * contains the organisation. A profile answers "who is this person", and on
 * every surface people actually read one, the answer is a face, a bio and how
 * many people follow them. The org still decides what a person can SEE (grants,
 * project visibility): it just stopped being what a person IS.
 *
 * The list is exported as DATA so a test can read it: that the entries exist,
 * that the labels are in the dictionary in both languages, without mounting a
 * DOM the project does not have.
 */
import { Bell, Building2, Cpu, CreditCard, MonitorSmartphone, Palette, ShieldCheck, UserRound, Users } from 'lucide-react';

export type SectionId =
  | 'appearance'
  | 'notifications'
  | 'providers'
  | 'profile'
  | 'organization'
  | 'followers'
  | 'privacy'
  | 'devices'
  | 'plan';

export interface SettingsSection {
  id: SectionId;
  labelKey: string;
  icon: typeof Palette;
}

// THE ORDER IS AN ARGUMENT: first how the app looks and how it warns you
// (appearance, notifications), then which engine it works with (providers),
// then who you are and who is around you (profile, followers, privacy), then
// the group you administer, then the machines and the plan.
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'appearance', labelKey: 'settings.section.appearance', icon: Palette },
  { id: 'notifications', labelKey: 'settings.section.notifications', icon: Bell },
  { id: 'providers', labelKey: 'settings.section.providers', icon: Cpu },
  { id: 'profile', labelKey: 'settings.section.profile', icon: UserRound },
  { id: 'followers', labelKey: 'settings.section.followers', icon: Users },
  { id: 'privacy', labelKey: 'settings.section.privacy', icon: ShieldCheck },
  { id: 'organization', labelKey: 'settings.section.organization', icon: Building2 },
  // The id stays `devices`: it is the key the identity row deep-links to
  // (`onOpenDevices`, and `openSettings('devices')` from the Profile pane).
  { id: 'devices', labelKey: 'settings.section.devices', icon: MonitorSmartphone },
  { id: 'plan', labelKey: 'settings.section.plan', icon: CreditCard },
];

/**
 * The pages of the PROFILE TAB, in the order they are presented everywhere.
 *
 * No organisation here, on purpose: see the header. Privacy is the third one
 * and not a link buried in the first, because "what does this publish about
 * me" is a question you ask WHILE you look at what it publishes.
 */
export const IDENTITY_SECTIONS: readonly SectionId[] = ['profile', 'followers', 'privacy'];
