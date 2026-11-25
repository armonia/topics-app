import type { OrbitShellCopy } from './orbit-shell';
import { orgWords } from './org-words';

const W = orgWords();

/** Italian words of the ORBIT organization and person menus. */
export const ORBIT_SHELL_COPY_IT: OrbitShellCopy = {
  orgMenu: `Menu ${W.articled.of}`,
  org: {
    settings: 'Impostazioni',
    team: 'Squadra',
    permissions: 'Permessi',
    log: 'Registro',
    markAllRead: 'Segna tutto come letto',
  },
  user: {
    menu: 'Menu della persona',
    appearance: 'Aspetto',
    notifications: 'Notifiche',
    theme: 'Tema',
    themeLight: 'Chiaro',
    themeDark: 'Scuro',
    themeSystem: 'Sistema',
    enterAs: 'Entra come…',
    enterAsHint: 'esempio',
    resetDemo: 'Ripristina la demo',
    signOut: 'Esci',
  },
  tabsMenu: 'Tutte le schede',
  tabPreviewTip: 'Anteprima: doppio clic per fissarla',
  access: {
    switchedBody: 'Barra laterale, azioni e dati seguono i permessi di questo team.',
    body: (team) => `Il team «${team}» non può aprirla. I permessi si cambiano in Squadra, Permessi.`,
    deniedAction: (team) => `Il team «${team}» non può farlo`,
  },
  resetConfirm: {
    title: 'Ripristinare la demo?',
    body: 'Le modifiche fatte in questa anteprima spariscono e si riparte dai dati di partenza. I dati veri non sono toccati.',
    confirm: 'Ripristina',
    toast: 'Demo ripristinata',
    toastBody: 'Si riparte dai dati di partenza.',
  },
  signOutConfirm: {
    title: `Uscire ${W.articled.from}?`,
    body: 'Le modifiche restano salvate: rientrando si riparte da dove eri.',
    confirm: 'Esci',
  },
  signedOut: {
    title: 'Sessione chiusa',
    body: 'Le modifiche restano salvate. Rientra quando vuoi.',
    back: 'Rientra',
  },
};
