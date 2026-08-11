import { useState, useEffect, useRef } from 'react';
import { X, Bell, Cpu, Palette, UserRound } from 'lucide-react';
import type { AppSettings, ThemeMode } from '../../types';
import { saveSettings } from '../../lib/settings';
import { MODAL_OVERLAY, MODAL_PANEL } from '../../lib/modalStyles';
import { AppearanceSection } from './AppearanceSection';
import { NotificationsSection } from './NotificationsSection';
import { AIProvidersSection } from './AIProvidersSection';
import { DevicesSection } from './DevicesSection';
import { IdentitySection } from './IdentitySection';
import { AccountSection } from './AccountSection';
import { FriendsSection } from './FriendsSection';
import { useModalDialog } from '../../hooks/useModalDialog';

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
type SectionId = 'appearance' | 'notifications' | 'providers' | 'devices';

// L'id resta `devices` — è la chiave interna a cui punta il deep-link della
// riga d'identità nella sidebar (`onOpenDevices` in App.tsx). L'ETICHETTA no:
// la scheda porta il profilo (nome, email, organizzazione, membri) prima dei
// dispositivi, e chi cerca «come mi chiamo qui» non apre uno smartphone.
const SECTIONS: Array<{ id: SectionId; label: string; icon: typeof Palette }> = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'providers', label: 'AI Providers', icon: Cpu },
  { id: 'devices', label: 'Account', icon: UserRound },
];

export function GlobalSettings({ isOpen, onClose, settings, onSettingsChange, themeMode = 'system', onThemeChange, onOpenShortcuts, initialSection }: GlobalSettingsProps & { initialSection?: SectionId }) {
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
        className={`w-full max-w-[760px] mx-4 h-[80vh] max-h-[640px] flex flex-col ${MODAL_PANEL}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-app-border">
          <h2 id="settings-title" className="text-[15px] font-semibold text-app-text">Settings</h2>
          <button aria-label="Chiudi le impostazioni"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-tertiary hover:text-app-text-secondary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Sidebar */}
          <nav className="w-[180px] flex-shrink-0 border-r border-app-border py-3 px-2 space-y-0.5 bg-app-hover/30">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setSection(id)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[12.5px] text-left transition-colors ${
                  section === id
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-app-text-secondary hover:bg-app-hover hover:text-app-text'
                }`}
              >
                <Icon size={14} className="flex-shrink-0" />
                {label}
              </button>
            ))}
          </nav>

          {/* Content */}
          <div className="flex-1 px-5 py-4 overflow-y-auto">
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
            {section === 'devices' && (
              // Chi sei viene PRIMA di che ferri hai: i dispositivi fanno capo
              // a una persona, e leggere l'elenco senza sapere di chi sono è
              // leggere una lista di oggetti.
              <div className="space-y-6">
                {/* L'account viene prima delle persone perché risponde a una
                    domanda che le precede — «chi sono io fuori da questa
                    macchina» — e perché su un'installazione senza servizio
                    degli account non si disegna affatto: in quel caso questa
                    schermata resta esattamente com'era. */}
                <AccountSection />
                <IdentitySection />
                {/* I profili vengono DOPO l'elenco delle persone: quello dice chi
                    c'è, questo dice chi sono. */}
                <FriendsSection />
                <DevicesSection />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
