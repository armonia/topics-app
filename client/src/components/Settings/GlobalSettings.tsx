import { useState, useEffect, useRef } from 'react';
import { X, Bell, Cpu, CreditCard, Palette, UserRound, MonitorSmartphone } from 'lucide-react';
import type { AppSettings, ThemeMode } from '../../types';
import { saveSettings } from '../../lib/settings';
import { MODAL_OVERLAY, MODAL_PANEL } from '../../lib/modalStyles';
import { AppearanceSection } from './AppearanceSection';
import { NotificationsSection } from './NotificationsSection';
import { AIProvidersSection } from './AIProvidersSection';
import { DevicesSection } from './DevicesSection';
import { IdentitySection } from './IdentitySection';
import { AccountSection } from './AccountSection';
import { PlanSection } from './PlanSection';
import { ProfileStatsSection } from './ProfileStatsSection';
import { DiscordSection } from './DiscordSection';
import { FriendsSection } from './FriendsSection';
import { useModalDialog } from '../../hooks/useModalDialog';
import { useT } from '../../hooks/useT';

interface GlobalSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  themeMode?: ThemeMode;
  onThemeChange?: (mode: ThemeMode) => void;
  /** Apre la finestra «Keyboard Shortcuts» (⌘?). Il pannello non la possiede:
   *  la governa `App.tsx`, che deve anche chiudere questo modale prima. */
  onOpenShortcuts?: () => void;
}

// Due schede rimosse, e nessuna delle due va riaperta.
//
// «Features» (2026-08-06) conteneva UN solo interruttore, `enableNewChat`, e
// quell'interruttore poteva solo rompere — spento una volta, faceva sparire
// "New Chat" da tutti e sei gli host del menu "+" senza dirlo, e il valore
// salvato scavalcava per sempre il default acceso. Il gate è stato tolto dal
// codice, non nascosto.
//
// «Shortcuts» era una TERZA scrittura a mano delle scorciatoie, e diceva il
// falso: dava ⌘F per «Find project» (⌘F apre la ricerca nei file; il progetto
// è ⌘⇧P) e ⌘⇧N per «New chat» (⌘⇧N è la new chat CON template; quella secca è
// ⌘T, che lì non compariva), e ne mancavano una decina. Il registro unico è
// `shared/shortcuts.ts` — da cui derivano sia la finestra ⌘? sia il forwarder
// nativo, con un test che fallisce se divergono. Non va reintrodotta nemmeno
// leggendo `SHORTCUT_GROUPS`: sarebbe la stessa lista in due finestre. Resta
// il RIMANDO in fondo ad Aspetto, che è l'unica cosa che non può mentire.
//
// «Permessi» non è stata rimossa, è stata SPOSTATA: gli «strumenti sempre
// consentiti» sono in fondo alla scheda «AI Providers». Erano una voce di nav di
// primo livello che nella stragrande maggioranza dei casi mostrava lo stato
// vuoto — un pannello vuoto per default non merita un posto fisso nel menu —
// mentre il controllo che si cerca pensando «permessi», il livello di autonomia,
// è per-chat e sta nel composer.
type SectionId = 'appearance' | 'notifications' | 'providers' | 'profile' | 'devices' | 'plan';

// L'id resta `devices` — è la chiave interna a cui punta il deep-link della
// riga d'identità nella sidebar (`onOpenDevices` in App.tsx). L'ETICHETTA no:
// la scheda porta il profilo (chi sei, le tue statistiche d'uso, lo stato
// pubblicato su Discord) prima delle persone e dei dispositivi, e chi cerca
// «come mi chiamo qui» non apre uno smartphone. Da «Account» a «Profile»
// perché l'account è ormai UNA delle cose che ci sono dentro, e nemmeno la
// prima: su un'installazione senza servizio degli account quella sezione non
// si disegna affatto, mentre le statistiche ci sono sempre.
// `plan` è una voce di PRIMO livello e non un riquadro dentro «Profile», per
// due ragioni. La prima: non è mai vuota — c'è sempre un piano, e sul gratuito
// dice cosa hai invece di cosa ti manca, quindi l'obiezione qui sopra non la
// tocca. La seconda: quanto paghi e chi sei sono domande diverse, e chi cerca
// «dove si paga» non apre la scheda dell'identità.
// L'ETICHETTA E' UNA CHIAVE, non una parola. Erano cinque stringhe inglesi in
// un'app italiana: quando una voce non si chiama come la parola che hai in
// testa, la lista si scorre senza vederla e la conclusione e' «non c'e'» -
// che e' letteralmente cio' che e' successo con le organizzazioni, presenti
// dentro una voce chiamata «Profile».
const SECTIONS: Array<{ id: SectionId; labelKey: string; icon: typeof Palette }> = [
  { id: 'appearance', labelKey: 'settings.section.appearance', icon: Palette },
  { id: 'notifications', labelKey: 'settings.section.notifications', icon: Bell },
  { id: 'providers', labelKey: 'settings.section.providers', icon: Cpu },
  // CHI SEI e CHE FERRI HAI sono due domande, e per un anno sono state una
  // voce sola: la sezione si chiamava `devices` e l'etichetta diceva
  // «Profile». Chi cercava i dispositivi apriva il profilo, chi cercava il
  // profilo apriva i dispositivi, e dentro trovavano entrambi cinque schede.
  // Il nome interno e quello mostrato che non coincidono non sono un dettaglio
  // di stile: sono la prova che la voce risponde a due domande.
  { id: 'profile', labelKey: 'settings.section.profile', icon: UserRound },
  { id: 'devices', labelKey: 'settings.section.devices', icon: MonitorSmartphone },
  { id: 'plan', labelKey: 'settings.section.plan', icon: CreditCard },
];

export function GlobalSettings({ isOpen, onClose, settings, onSettingsChange, themeMode = 'system', onThemeChange, onOpenShortcuts, initialSection }: GlobalSettingsProps & { initialSection?: SectionId }) {
  const t = useT();
  const [localSettings, setLocalSettings] = useState<AppSettings>(settings);
  const [section, setSection] = useState<SectionId>(initialSection ?? 'appearance');
  // Chi apre il pannello da un punto preciso ci vuole arrivare, non ripartire da
  // «Aspetto». Si riallinea a ogni APERTURA, non solo al montaggio: il pannello
  // resta montato fra un'apertura e l'altra, quindi un `useState` iniziale
  // servirebbe una volta sola.
  useEffect(() => {
    if (isOpen && initialSection) setSection(initialSection);
  }, [isOpen, initialSection]);
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape chiude + Tab resta dentro + il focus torna al bottone che ha aperto.
  // Prima: si usciva SOLO dalla X (o dal velo), e Escape arrivava fino a
  // interrompere il turno dell'AI nella chat sotto.
  useModalDialog({ open: isOpen, onClose, panelRef });

  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  const handleChange = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const newSettings = { ...localSettings, [key]: value };
    setLocalSettings(newSettings);
    onSettingsChange(newSettings);
    saveSettings(newSettings);
  };

  if (!isOpen) return null;

  return (
    <div className={MODAL_OVERLAY} onClick={onClose}>
      <div
        ref={panelRef}
        data-testid="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        // A DUE FORME, e il cardine è il `md:` (768px) — la stessa soglia con
        // cui il resto dell'app decide quante colonne stanno sullo schermo.
        //
        //  · da 768 in su: la finestra di sempre — 760px al centro, la colonna
        //    di navigazione a sinistra, 80vh di altezza.
        //  · sotto: un FOGLIO A TUTTO SCHERMO. Non è un vezzo: il pannello era
        //    `max-w-[760px] mx-4` con dentro una nav larga 180 FISSI, quindi su
        //    un telefono da 390 restavano 178px di contenuto — misurati, non
        //    stimati — e i controlli uscivano dal bordo destro. Sotto i 768 la
        //    navigazione passa in ALTO come riga scorrevole e tutta la larghezza
        //    va al contenuto.
        //
        // `100dvh` e non `100vh`: su iOS la barra degli indirizzi entra ed esce
        // dal viewport, e `vh` conta la finestra grande — cioè il fondo del
        // pannello finirebbe sotto la barra proprio quando è visibile.
        //
        // `max-md:rounded-none` e non `rounded-none`: `MODAL_PANEL` porta già
        // `rounded-xl`, e fra due utility DELLO STESSO gruppo senza variante a
        // vincere è l'ordine nel foglio generato, non quello nell'attributo. La
        // variante `max-md:` toglie l'ambiguità — a schermo intero gli angoli
        // tondi taglierebbero i pixel del bordo dello schermo.
        className={`flex w-full flex-col ${MODAL_PANEL} h-[100dvh] max-h-none max-md:rounded-none md:mx-4 md:h-[80vh] md:max-h-[640px] md:max-w-[760px]`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex flex-shrink-0 items-center justify-between border-b border-app-border px-5 py-3"
          // La tacca. Il foglio parte da `inset-0`, quindi senza questo il
          // titolo finisce SOTTO la status bar di iOS.
          style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 0.75rem)' }}
        >
          <h2 id="settings-title" className="text-[15px] font-semibold text-app-text">Settings</h2>
          {/* 44px dove c'è un dito: era 28×28, cioè sotto la soglia proprio nel
              punto in cui il gesto «esci» non ha alternative — a schermo intero
              non c'è più un velo attorno da toccare. */}
          <button aria-label="Chiudi le impostazioni"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-app-text-tertiary transition-colors hover:bg-black/5 hover:text-app-text-secondary coarse:h-11 coarse:w-11 dark:hover:bg-white/5"
          >
            <X size={14} className="coarse:h-5 coarse:w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* Sidebar (desktop) / riga di schede scorrevole (mobile) */}
          <nav className="flex flex-shrink-0 gap-1 overflow-x-auto overscroll-x-contain border-b border-app-border bg-app-hover/30 px-2 py-2 md:w-[180px] md:flex-col md:gap-0.5 md:overflow-x-visible md:border-b-0 md:border-r md:py-3">
            {SECTIONS.map(({ id, labelKey, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setSection(id)}
                // `whitespace-nowrap` + `flex-shrink-0`: in riga le etichette
                // non devono andare a capo né stringersi, altrimenti la riga
                // smette di scorrere e comincia a impilarsi.
                // `min-h-11` sotto il dito = i 44px della soglia.
                className={`flex flex-shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-left text-[12.5px] transition-colors coarse:min-h-11 md:w-full md:px-2.5 ${
                  section === id
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-app-text-secondary hover:bg-app-hover hover:text-app-text'
                }`}
                aria-current={section === id ? 'page' : undefined}
              >
                <Icon size={14} className="flex-shrink-0" />
                {t(labelKey)}
              </button>
            ))}
          </nav>

          {/* Content */}
          {/* `min-w-0`: senza, un figlio incomprimibile (una riga lunga, una
              tabella) allarga la colonna oltre il pannello e si porta dietro
              una barra di scorrimento ORIZZONTALE — che a 390px era il difetto
              visibile. Il padding di fondo tiene conto della barra gesti. */}
          <div
            className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 md:px-5"
            style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 1rem)' }}
          >
            {section === 'appearance' && (
              <AppearanceSection
                settings={localSettings}
                themeMode={themeMode}
                onThemeChange={onThemeChange}
                onChange={handleChange}
                onOpenShortcuts={onOpenShortcuts}
              />
            )}
            {section === 'notifications' && (
              <NotificationsSection settings={localSettings} onChange={handleChange} />
            )}
            {section === 'providers' && <AIProvidersSection />}
            {section === 'plan' && <PlanSection />}
            {section === 'profile' && (
              // CHI SEI: l'identità dentro e fuori questa macchina.
              <div className="space-y-6">
                {/* Le statistiche aprono la scheda perché sono l'unica cosa
                    che c'è SEMPRE: l'account può non essere configurato, le
                    persone possono essere una sola. */}
                <ProfileStatsSection />
                {/* Lo stato pubblicato fuori viene subito dopo le misure che
                    pubblica: è la stessa materia, vista da chi non è qui. */}
                <DiscordSection />
                {/* L'account viene prima delle persone perché risponde a una
                    domanda che le precede — «chi sono io fuori da questa
                    macchina» — e perché su un'installazione senza servizio
                    degli account non si disegna affatto: in quel caso questa
                    schermata resta esattamente com'era. */}
                <AccountSection />
                {/* I GRUPPI stanno qui e non sotto «Devices», ed è il pezzo che
                    prima non si trovava: `IdentitySection` gestisce già le
                    organizzazioni per intero — elenco da `/api/auth/orgs`,
                    selettore quando sono più di uno, membri, creazione — ma
                    viveva in fondo a una scheda che si chiamava «Profile» e
                    conteneva i dispositivi. «Non vedo più le organizzazioni»
                    non voleva dire che mancassero: voleva dire che erano la
                    quarta cosa dentro la voce sbagliata. */}
                <IdentitySection />
                {/* I profili vengono DOPO l'elenco delle persone: quello dice chi
                    c'è, questo dice chi sono. */}
                <FriendsSection />
              </div>
            )}
            {section === 'devices' && (
              // CHE FERRI HAI: una domanda di sicurezza, non di identità —
              // «quali macchine possono entrare, e come gliela tolgo». Da sola
              // in una voce sua si legge; quinta sotto «Profile» si scorreva.
              <div className="space-y-6">
                <DevicesSection />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
