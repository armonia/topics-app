/**
 * LE VOCI DELLE IMPOSTAZIONI, come dato e non come JSX.
 *
 * Stavano dentro `GlobalSettings.tsx`, e finché erano cinque bastava. Il
 * difetto che questo modulo chiude è un altro: «Profilo» era UNA voce che
 * conteneva sei riquadri — le tue statistiche, lo stato su Discord, l'account,
 * le organizzazioni con i loro membri, i progetti dell'organizzazione, i
 * profili delle persone. Sei cose che rispondono a tre domande diverse, in una
 * colonna che si scorre: chi cercava «le organizzazioni» o «gli amici» non li
 * trovava, e la conclusione non era «sono più in basso», era «non ci sono».
 * È già successo una volta con le organizzazioni dentro una voce chiamata
 * «Profile» (vedi `tests/e2e/settings-lingua-org.spec.ts`).
 *
 * Tre domande, tre voci: CHI SEI (profilo), CON CHI STAI (organizzazione), CHI
 * C'È INTORNO (amici). Le stesse tre pagine le usa anche il pane «Profilo»
 * standalone, che quindi non può divergere da questa: la fonte è una.
 *
 * L'elenco è esportato come DATO perché un test possa leggerlo — che le tre
 * voci esistano, che le etichette siano nel dizionario in tutte e due le lingue
 * — senza montare un DOM che il progetto non ha.
 */
import { Bell, Building2, Cpu, CreditCard, MonitorSmartphone, Palette, UserRound, Users } from 'lucide-react';

export type SectionId =
  | 'appearance'
  | 'notifications'
  | 'providers'
  | 'profile'
  | 'organization'
  | 'friends'
  | 'devices'
  | 'plan';

export interface SettingsSection {
  id: SectionId;
  labelKey: string;
  icon: typeof Palette;
}

// L'ORDINE È UN DISCORSO: prima come si vede e come avvisa l'app (aspetto,
// notifiche), poi con che motore lavora (provider), poi chi sei e con chi
// (profilo, organizzazione, amici), poi le macchine e il piano. Le tre voci
// dell'identità stanno vicine perché è così che le si cerca, una dopo l'altra.
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'appearance', labelKey: 'settings.section.appearance', icon: Palette },
  { id: 'notifications', labelKey: 'settings.section.notifications', icon: Bell },
  { id: 'providers', labelKey: 'settings.section.providers', icon: Cpu },
  { id: 'profile', labelKey: 'settings.section.profile', icon: UserRound },
  { id: 'organization', labelKey: 'settings.section.organization', icon: Building2 },
  { id: 'friends', labelKey: 'settings.section.friends', icon: Users },
  // L'id resta `devices`: è la chiave a cui punta il deep-link della riga
  // d'identità in fondo alla sidebar (`onOpenDevices` in App.tsx).
  { id: 'devices', labelKey: 'settings.section.devices', icon: MonitorSmartphone },
  { id: 'plan', labelKey: 'settings.section.plan', icon: CreditCard },
];

/** Le tre pagine dell'identità, nell'ordine in cui si presentano ovunque. */
export const IDENTITY_SECTIONS: readonly SectionId[] = ['profile', 'organization', 'friends'];
