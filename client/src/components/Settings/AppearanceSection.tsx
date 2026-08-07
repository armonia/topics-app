import { Type, AlignJustify, Rows3, Sun, Moon, Monitor, LayoutGrid, Keyboard, ChevronRight } from 'lucide-react';
import type { AppSettings, ThemeMode } from '../../types';
import { isDesktop } from '../../lib/shell';
import { ToggleRow } from './ToggleRow';

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
          Larghezza chat
          <span className="ml-auto text-[12px] text-app-text-muted font-normal">
            {settings.chatMaxWidth > 0 ? `${settings.chatMaxWidth}px` : 'Piena larghezza'}
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
          aria-label="Larghezza massima della colonna di chat"
        />
        <div className="flex justify-between text-[11px] text-app-text-muted mt-1">
          <span>Piena</span>
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
            vibrancy underneath — making the split layout easier to read.
          </p>

          <ToggleRow
            label="Floating splits"
            description="Render splits and the sidebar as separate floating panels."
            value={settings.floatingSplits}
            onChange={(v) => onChange('floatingSplits', v)}
          />
        </div>
      )}

      {/* Lingua. La migrazione delle stringhe è PER SUPERFICIE (vedi
          `lib/i18n.ts`): cambiare lingua sposta le superfici già convertite e
          lascia le altre com'erano. È detto qui sotto invece di lasciarlo
          scoprire — un selettore che sembra non fare niente è peggio di un
          selettore che dice cosa fa. */}
      <div className="mt-6">
        <h3 className="text-[13px] font-medium text-app-text mb-1">Lingua · Language</h3>
        <p className="text-[12px] text-app-text-muted mb-3">
          Le superfici già tradotte seguono questa scelta; le altre restano come sono
          finché non vengono convertite. · Translated surfaces follow this setting;
          the rest stay as they are until converted.
        </p>
        <select
          value={settings.language ?? 'auto'}
          onChange={(e) => onChange('language', e.target.value as 'auto' | 'it' | 'en')}
          className="rounded bg-white/5 px-2 py-1 text-[12px] text-app-text outline-none"
          data-testid="settings-language"
        >
          <option value="auto">Automatica · Automatic</option>
          <option value="it">Italiano</option>
          <option value="en">English</option>
        </select>
      </div>

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
          className="mt-6 w-full flex items-center gap-2 rounded-lg border border-app-border bg-app-hover/40 px-3 py-2 text-left transition-colors hover:bg-app-hover"
        >
          <Keyboard size={14} className="flex-shrink-0 text-app-text-secondary" />
          <span className="text-[12.5px] text-app-text">Scorciatoie da tastiera</span>
          <kbd className="kbd ml-auto">⌘?</kbd>
          <ChevronRight size={13} className="flex-shrink-0 text-app-text-muted" />
        </button>
      )}

    </div>
  );
}
