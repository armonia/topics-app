import { useEffect, useRef } from 'react';
import { Type, AlignJustify, Rows3, Sun, Moon, Monitor, LayoutGrid, Kanban, Keyboard, ChevronRight } from 'lucide-react';
import type { AppSettings, ThemeMode } from '../../types';
import { isDesktop } from '../../lib/shell';
import { ToggleRow } from './ToggleRow';
import { fetchOutputLanguage, pushOutputLanguage, type LocalePreference } from '../../lib/i18n';
import { useProvidersSnapshot } from '../../hooks/useProvidersSnapshot';
import { Select, type SelectOption } from '../Shared/Select';
import { useT } from '@/hooks/useT';

// Le etichette restano BILINGUI, per la ragione scritta accanto al controllo:
// è l'unico posto che si deve poter leggere anche quando la lingua in vigore è
// quella sbagliata.
const LANGUAGE_OPTIONS: ReadonlyArray<SelectOption<LocalePreference>> = [
  { value: 'auto', label: 'Automatica · Automatic' },
  { value: 'it', label: 'Italiano' },
  { value: 'en', label: 'English' },
];

interface AppearanceSectionProps {
  settings: AppSettings;
  themeMode: ThemeMode;
  onThemeChange?: (mode: ThemeMode) => void;
  onChange: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void;
  /** Apre la finestra «Keyboard Shortcuts» (⌘?). Opzionale: fuori da App.tsx
   *  il pannello si monta anche senza. */
  onOpenShortcuts?: () => void;
}

export function AppearanceSection({ settings, themeMode, onThemeChange, onChange, onOpenShortcuts }: AppearanceSectionProps) {
  const tr = useT();
  return (
    <div className="space-y-5">
      {/* Font Size */}
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-2">
          <Type size={14} />
          Font Size
          <span className="ml-auto text-[12px] text-app-text-muted font-normal">{settings.fontSize}px</span>
        </label>
        {/* `aria-label` esplicita: la <label> qui sopra NON avvolge l'input e non
            lo lega per `for`, quindi questo cursore non aveva NESSUN nome
            accessibile — e da quando "Larghezza chat" (27ccc796) ha portato un
            secondo `type="range"` nel pannello, i due erano indistinguibili sia
            per uno screen reader sia per chi li cerca per ruolo. Il nome è
            fisso e non include i "13px" del contatore: un nome che cambia col
            valore non è un'ancora. */}
        <input
          type="range"
          min={12}
          max={18}
          step={1}
          value={settings.fontSize}
          onChange={(e) => onChange('fontSize', parseInt(e.target.value))}
          className="w-full h-1.5 bg-app-border rounded-lg appearance-none cursor-pointer accent-primary"
          aria-label="Font Size"
        />
        <div className="flex justify-between text-[11px] text-app-text-muted mt-1">
          <span>12px</span>
          <span>15px</span>
          <span>18px</span>
        </div>
      </div>

      {/* Misura di lettura della chat — il tetto oltre il quale la colonna non
          si allarga più. Una riga lunga quanto una pane larga si legge male:
          tornando a capo l'occhio perde il rigo. Il fondo scala (600) è la
          soglia sotto cui il tetto smette di avere senso e diventa «piena
          larghezza». */}
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-2">
          <Type size={14} />
          {tr('appearance.chatWidth')}
          <span className="ml-auto text-[12px] text-app-text-muted font-normal">
            {settings.chatMaxWidth > 0 ? `${settings.chatMaxWidth}px` : tr('appearance.fullWidth')}
          </span>
        </label>
        <input
          type="range"
          min={580}
          max={1300}
          step={20}
          // 580 = il gradino sotto il minimo utile: lì il tetto si spegne.
          value={settings.chatMaxWidth > 0 ? settings.chatMaxWidth : 580}
          onChange={(e) => {
            const v = parseInt(e.target.value);
            onChange('chatMaxWidth', v <= 580 ? 0 : v);
          }}
          className="w-full h-1.5 bg-app-border rounded-lg appearance-none cursor-pointer accent-primary"
          aria-label={tr('appearance.chatWidth.aria')}
        />
        <div className="flex justify-between text-[11px] text-app-text-muted mt-1">
          <span>{tr('appearance.full')}</span>
          <span>820px</span>
          <span>1300px</span>
        </div>
      </div>

      {/* Theme */}
      {onThemeChange && (
        <div>
          <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-2">
            {themeMode === 'light' ? <Sun size={14} /> : themeMode === 'dark' ? <Moon size={14} /> : <Monitor size={14} />}
            Theme
          </label>
          <div className="flex gap-2">
            {([
              { mode: 'light' as ThemeMode, icon: Sun, label: 'Light' },
              { mode: 'dark' as ThemeMode, icon: Moon, label: 'Dark' },
              { mode: 'system' as ThemeMode, icon: Monitor, label: 'System' },
            ]).map(({ mode, icon: Icon, label }) => (
              <button
                key={mode}
                onClick={() => onThemeChange(mode)}
                className={`flex-1 flex flex-col items-center gap-1.5 py-2.5 px-3 rounded-lg text-[12px] font-medium transition-all border ${
                  themeMode === mode
                    ? 'bg-primary/10 border-primary/30 text-primary'
                    : 'bg-app-hover border-app-border text-app-text-secondary hover:bg-app-hover'
                }`}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Message Density */}
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-2">
          {settings.messageDensity === 'compact' ? <Rows3 size={14} /> : <AlignJustify size={14} />}
          Message Density
        </label>
        <div className="flex gap-2">
          <button
            onClick={() => onChange('messageDensity', 'compact')}
            className={`flex-1 py-2 px-3 rounded-lg text-[12px] font-medium transition-all border ${
              settings.messageDensity === 'compact'
                ? 'bg-primary/10 border-primary/30 text-primary'
                : 'bg-app-hover border-app-border text-app-text-secondary hover:bg-app-hover'
            }`}
          >
            <div className="space-y-0.5 mb-1.5">
              <div className="h-1 bg-current opacity-30 rounded w-3/4" />
              <div className="h-1 bg-current opacity-30 rounded w-1/2" />
              <div className="h-1 bg-current opacity-30 rounded w-2/3" />
            </div>
            Compact
          </button>
          <button
            onClick={() => onChange('messageDensity', 'comfortable')}
            className={`flex-1 py-2 px-3 rounded-lg text-[12px] font-medium transition-all border ${
              settings.messageDensity === 'comfortable'
                ? 'bg-primary/10 border-primary/30 text-primary'
                : 'bg-app-hover border-app-border text-app-text-secondary hover:bg-app-hover'
            }`}
          >
            <div className="space-y-1.5 mb-1.5">
              <div className="h-1 bg-current opacity-30 rounded w-3/4" />
              <div className="h-1 bg-current opacity-30 rounded w-1/2" />
              <div className="h-1 bg-current opacity-30 rounded w-2/3" />
            </div>
            Comfortable
          </button>
        </div>
      </div>

      {/* Preview */}
      <div>
        <label className="text-[13px] font-medium text-app-text mb-2 block">Preview</label>
        <div className="bg-app-hover rounded-lg p-3 border border-app-border">
          <div className={`${settings.messageDensity === 'compact' ? 'space-y-1' : 'space-y-2.5'}`}>
            <div className="flex justify-end">
              <div
                className="bg-primary text-white rounded-lg px-2.5 py-1.5"
                style={{ fontSize: `${settings.fontSize}px` }}
              >
                Hello! How are you?
              </div>
            </div>
            <div className="flex justify-start">
              <div
                className="bg-surface text-app-text rounded-lg px-2.5 py-1.5"
                style={{ fontSize: `${settings.fontSize}px` }}
              >
                I'm doing well, thanks for asking!
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Floating splits — desktop only (relies on native macOS window
          vibrancy to reveal the backdrop through the gaps). Hidden entirely
          on web/PWA, where there's no vibrancy to show underneath. Shown on
          BOTH desktop shells (Electron + Tauri), hence isDesktop not isElectron. */}
      {isDesktop && (
        <div>
          <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-1">
            <LayoutGrid size={14} />
            Floating splits
            <span className="ml-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/15 text-primary">
              Beta
            </span>
          </label>
          <p className="text-[12px] text-app-text-muted mb-3">
            Detach every window split and the sidebar into rounded floating
            cards with a small gap between them, revealing the desktop
            vibrancy underneath. It makes the split layout easier to read.
          </p>

          <ToggleRow
            label="Floating splits"
            description="Render splits and the sidebar as separate floating panels."
            value={settings.floatingSplits}
            onChange={(v) => onChange('floatingSplits', v)}
          />
        </div>
      )}

      {/* La riga «Board generale» in cima alla sidebar. Sta fra le preferenze e
          non fra i segnali di proposito: prima compariva da sé quando c'era
          lavoro aperto, cioè un istante DOPO ogni ricarica, e nel frattempo
          tutto il resto della colonna si spostava (vedi TopicTree,
          `showBoardRow`). Chi non la vuole la spegne qui — la board resta
          raggiungibile dal «+» e dalla sua tab. */}
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-1">
          <Kanban size={14} />
          Board
        </label>
        <ToggleRow
          label={tr('settings.board.showRow')}
          description={tr('settings.board.showRowBlurb')}
          value={settings.showBoardRow}
          onChange={(v) => onChange('showBoardRow', v)}
        />
      </div>

      {/* Lingua — UNA preferenza, due effetti. Le etichette restano bilingui
          perché questo è l'unico posto che si deve poter leggere anche quando
          la lingua scelta è quella sbagliata.

          La migrazione delle stringhe della UI è PER SUPERFICIE (vedi
          `lib/i18n.ts`): cambiare lingua sposta le superfici già convertite e
          lascia le altre com'erano. Le RISPOSTE del modello invece cambiano
          subito e ovunque — chat, terminale, agenti della board — perché la
          scelta finisce nella riga `app_settings.output_language` e da lì in
          `languageDirective`. È detto qui sotto invece di lasciarlo scoprire. */}
      <LanguageSetting
        value={settings.language ?? 'auto'}
        onChange={(v) => onChange('language', v)}
      />

      {/* La porta per le scorciatoie. Qui c'era una SCHEDA che le riscriveva a
          mano — nove righe, e due dicevano il falso (⌘F era dato per «Find
          project», ma apre la ricerca nei file; ⌘⇧N per «New chat», che è ⌘T).
          Il registro unico è `shared/shortcuts.ts`, da cui derivano sia la
          finestra ⌘? sia il forwarder nativo, con un test che fallisce se
          divergono. Riscrivere quella lista qui la farebbe divergere di nuovo:
          resta un RIMANDO, che è l'unica cosa che questo posto sa fare senza
          poter mentire. Serve perché ⌘? era la sola porta, e una scorciatoia è
          l'unica cosa che non si può scoprire con una scorciatoia. */}
      {onOpenShortcuts && (
        <button
          onClick={onOpenShortcuts}
          className="mt-6 w-full flex items-center gap-2 rounded-lg border border-app-border bg-app-hover/40 px-3 py-2 text-left transition-colors hover:bg-app-hover coarse:min-h-11"
        >
          <Keyboard size={14} className="flex-shrink-0 text-app-text-secondary" />
          <span className="text-[12.5px] text-app-text">Scorciatoie da tastiera</span>
          {/* Vedi `shared/shortcuts.ts`: la chord ne accetta due, e questa è
              quella che si scrive uguale su ogni tastiera. */}
          <kbd className="kbd ml-auto">⌘/</kbd>
          <ChevronRight size={13} className="flex-shrink-0 text-app-text-muted" />
        </button>
      )}

    </div>
  );
}

/**
 * Il selettore della lingua, e la riga che dice se il motore la sostiene.
 *
 * Perché è un componente a parte e non due tag in mezzo agli altri: qui c'è
 * uno stato che gli altri controlli di questa scheda non hanno. «Lingua» è una
 * preferenza SOLA con due depositi — localStorage per la UI (dove `t()` la
 * legge in modo sincrono) e la riga `app_settings` per il modello — e i due
 * vanno tenuti d'accordo.
 *
 * Il riallineamento una-tantum al montaggio serve a chi aveva già scelto una
 * lingua PRIMA che la scelta arrivasse fino al modello: la sua preferenza
 * esiste solo in locale, la riga del server è ancora vuota, e senza questo
 * giro dovrebbe riscegliere la stessa lingua per farsi ascoltare. Si scrive
 * solo se il server non ha ancora nulla: se qualcosa c'è, comanda quello che
 * l'utente ha scelto per ultimo, non un'eco del localStorage.
 */
function LanguageSetting({
  value,
  onChange,
}: {
  value: LocalePreference;
  onChange: (v: LocalePreference) => void;
}) {
  const tr = useT();
  const { snapshot } = useProvidersSnapshot();
  // Il valore al montaggio, congelato: il riallineamento deve guardare cosa
  // c'era quando la scheda si è aperta, non inseguire i cambi successivi (che
  // scrivono già per conto loro).
  const mounted = useRef(value);

  useEffect(() => {
    let live = true;
    void (async () => {
      const onServer = await fetchOutputLanguage();
      if (!live) return;
      // Si scrive SOLO se il server ha risposto e la riga è davvero vuota.
      // `known: false` (rete caduta, risposta illeggibile) è «non lo so», e
      // «non lo so» non autorizza a sovrascrivere: da lì potrebbe esserci la
      // scelta appena fatta in un'altra finestra.
      if (!onServer.known || onServer.value !== null) return;
      if (mounted.current === 'auto') return;
      void pushOutputLanguage(mounted.current);
    })();
    return () => { live = false; };
  }, []);

  const handle = (next: LocalePreference) => {
    onChange(next);           // la UI, subito e in modo sincrono
    void pushOutputLanguage(next); // il modello, appena la rete risponde
  };

  const support = languageSupport(snapshot, value);

  return (
    <div className="mt-6">
      <h3 className="text-[13px] font-medium text-app-text mb-1">{tr('appearance.language')}</h3>
      <p className="text-[12px] text-app-text-muted mb-3">
        {tr('appearance.language.blurb')}
      </p>
      {/* Il `<select>` di sistema che stava qui era l'unico pezzo di questo
          pannello disegnato dal sistema operativo: su iOS apriva la ruota
          nativa, col suo carattere e i suoi margini. `Select` è la primitiva
          dell'app (sopra `Menu`), quindi qui arrivano gratis il foglio dal
          basso su mobile, il bersaglio da 44px e il tema. */}
      <Select<LocalePreference>
        value={value}
        onChange={handle}
        ariaLabel="Lingua · Language"
        testId="settings-language"
        className="w-[220px] max-w-full"
        options={LANGUAGE_OPTIONS}
      />
      <p className={`mt-2 text-[11px] ${support.tone}`} data-testid="settings-language-support">
        {support.text}
      </p>
    </div>
  );
}

/**
 * Cosa sappiamo del supporto linguistico del motore di default.
 *
 * REGOLA DI ONESTÀ, la stessa della fast mode: «non lo so» NON è «non si può».
 * Il campo `languages` di `ProviderSnapshotEntry` esiste per essere DICHIARATO
 * dal motore, non indovinato da una tabella scritta qui — una tabella
 * `{ 'claude-opus-5': ['it','en'], … }` invecchia da sola, e il caso che conta
 * (un llama locale, domani) è proprio quello che non potrebbe conoscere.
 * Quindi: assente o `unknown` ⇒ riga grigia e nient'altro. Nessun blocco,
 * nessun selettore disabilitato, nessun popup. Il giorno che un motore non
 * risponde, la funzione non lo dichiara rotto.
 */
function languageSupport(
  snapshot: { providers: Array<{ name: string; label?: string; languages?: { supported: string[] | null; source: string } }>; defaultProvider: string | null } | null,
  value: LocalePreference,
): { text: string; tone: string } {
  const GREY = 'text-app-text-muted';
  if (value === 'auto') {
    return { text: 'Nessuna direttiva: il modello risponde nella lingua in cui gli scrivi.', tone: GREY };
  }
  const entry = snapshot?.providers.find((p) => p.name === snapshot.defaultProvider);
  const declared = entry?.languages;
  if (!declared || declared.source === 'unknown') {
    return { text: 'Supporto non verificato: nessun motore ha dichiarato le lingue che sostiene.', tone: GREY };
  }
  const name = entry?.label ?? entry?.name ?? 'il motore';
  // `supported: null` con una fonte vera = «tutte»: è una dichiarazione, non
  // un'assenza, e va letta come un sì.
  if (declared.supported === null || declared.supported.includes(value)) {
    return { text: `Confermato da ${name}.`, tone: 'text-emerald-400' };
  }
  return {
    text: `${name} non dichiara questa lingua fra quelle che sostiene: la risposta potrebbe arrivare in un'altra.`,
    tone: 'text-amber-400',
  };
}
