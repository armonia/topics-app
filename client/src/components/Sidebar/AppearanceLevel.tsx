/**
 * HOW THE APP LOOKS, as direct controls in the user menu (USERMENU-01).
 *
 * This was the «Appearance» page of the Settings panel: a window over the app,
 * a preview of two fake messages, and sliders whose value was written in a
 * label above them. The menu does not cover the chat, so every change is seen
 * live on the real thing and the preview has nothing left to show. Each control
 * applies on change and writes where it always wrote (`saveSettings`,
 * `setTheme`, `pushOutputLanguage`): the surface moved, the storage did not.
 *
 * The board row moved to «View», because it says what the column shows.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ChevronRight, Keyboard, Monitor, Moon, Palette, Sun } from 'lucide-react';
import type { AppSettings, ThemeMode } from '../../types';
import { isDesktop } from '../../lib/shell';
import { fetchOutputLanguage, pushOutputLanguage, failedLocales, subscribeCatalogues, type LocalePreference } from '../../lib/i18n';
import { useProvidersSnapshot } from '../../hooks/useProvidersSnapshot';
import { shortcut } from '../../lib/shortcutLabel';
import { useT } from '@/hooks/useT';
import { SubmenuItem } from '../Shared/SubmenuItem';
import { Segmented } from '../Shared/Segmented';
import { Stepper } from '../Shared/Stepper';
import { Select, type SelectOption } from '../Shared/Select';
import { PreferenceRow, SwitchRow } from './PreferenceRow';
import { menuRowClass } from './menuRow';

/** What the preference levels read and write, as `App` hands it down. */
export interface MenuPreferences {
  settings: AppSettings;
  onSettingChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  /** Opens the keyboard shortcuts window (⌘/). */
  onOpenShortcuts: () => void;
}

// Bilingual on purpose: this is the one control that must stay readable when
// the language in force is the wrong one.
const LANGUAGE_OPTIONS: ReadonlyArray<SelectOption<LocalePreference>> = [
  { value: 'auto', label: 'Automatica · Automatic' },
  { value: 'it', label: 'Italiano' },
  { value: 'en', label: 'English' },
];

const FONT_RANGE = { min: 12, max: 18, step: 1 };

/**
 * The chat width as a stepper: 600 to 1300 px in steps of 20, and one step
 * past the widest is «Full» (stored as `0`, no ceiling). Full is the widest a
 * column can be, so it sits at the top end, where «+» leads.
 */
const WIDTH_MIN = 600;
const WIDTH_MAX = 1300;
const WIDTH_STEP = 20;
const WIDTH_FULL = WIDTH_MAX + WIDTH_STEP;

function widthToStep(chatMaxWidth: number): number {
  if (chatMaxWidth <= 0) return WIDTH_FULL;
  return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, chatMaxWidth));
}

function stepToWidth(step: number): number {
  return step > WIDTH_MAX ? 0 : step;
}

export function AppearanceLevel({ preferences, isMobile, onClose, defaultOpen = false }: {
  preferences: MenuPreferences;
  isMobile: boolean;
  onClose: () => void;
  defaultOpen?: boolean;
}) {
  const tr = useT();
  const { settings, onSettingChange, themeMode, onThemeChange, onOpenShortcuts } = preferences;
  const themeName = tr(`appearance.theme.${themeMode}`);

  return (
    <SubmenuItem
      icon={Palette}
      label={tr('settings.section.appearance')}
      testId="topics-menu-appearance"
      minWidth={288}
      defaultOpen={defaultOpen}
      tail={
        <span data-testid="topics-menu-appearance-tail" className="flex-shrink-0 text-mini text-app-text-tertiary">
          {themeName} · {settings.fontSize} px
        </span>
      }
    >
      <div className="py-1">
        <PreferenceRow label={tr('appearance.theme')}>
          <Segmented<ThemeMode>
            value={themeMode}
            onChange={onThemeChange}
            ariaLabel={tr('appearance.theme')}
            testId="appearance-theme"
            options={[
              { value: 'light', label: tr('appearance.theme.light'), icon: Sun },
              { value: 'dark', label: tr('appearance.theme.dark'), icon: Moon },
              { value: 'system', label: tr('appearance.theme.system'), icon: Monitor },
            ]}
          />
        </PreferenceRow>
        <PreferenceRow label={tr('appearance.fontSize')}>
          <Stepper
            value={settings.fontSize}
            {...FONT_RANGE}
            onChange={(v) => onSettingChange('fontSize', v)}
            ariaLabel={tr('appearance.fontSize')}
            format={(v) => `${v} px`}
            testId="appearance-font-size"
          />
        </PreferenceRow>
        <PreferenceRow label={tr('appearance.chatWidth')}>
          <Stepper
            value={widthToStep(settings.chatMaxWidth)}
            min={WIDTH_MIN}
            max={WIDTH_FULL}
            step={WIDTH_STEP}
            onChange={(v) => onSettingChange('chatMaxWidth', stepToWidth(v))}
            ariaLabel={tr('appearance.chatWidth.aria')}
            format={(v) => (v > WIDTH_MAX ? tr('appearance.full') : `${v} px`)}
            testId="appearance-chat-width"
          />
        </PreferenceRow>
        <PreferenceRow label={tr('appearance.density')}>
          <Segmented<AppSettings['messageDensity']>
            value={settings.messageDensity}
            onChange={(v) => onSettingChange('messageDensity', v)}
            ariaLabel={tr('appearance.density')}
            testId="appearance-density"
            options={[
              { value: 'compact', label: tr('appearance.density.compact') },
              { value: 'comfortable', label: tr('appearance.density.comfortable') },
            ]}
          />
        </PreferenceRow>
        {/* Desktop only: the floating cards reveal the native window
            vibrancy, which a browser or a phone does not have. */}
        {isDesktop && !isMobile && (
          <SwitchRow
            label={tr('appearance.floatingSplits')}
            hint={tr('appearance.floatingSplits.beta')}
            checked={settings.floatingSplits}
            onChange={(v) => onSettingChange('floatingSplits', v)}
            testId="appearance-floating-splits"
          />
        )}
        <LanguageRow
          value={settings.language ?? 'auto'}
          onChange={(v) => onSettingChange('language', v)}
        />
      </div>
      {/* The door to the shortcuts, not a copy of them: the one registry is
          `shared/shortcuts.ts`, and a list written here would drift from it. */}
      <div className="border-t border-app-border py-1">
        <button
          type="button"
          data-testid="appearance-shortcuts"
          onClick={() => { onClose(); onOpenShortcuts(); }}
          className={menuRowClass(isMobile)}
        >
          <Keyboard size={14} className="flex-shrink-0" />
          <span className="flex-1 text-left">{tr('appearance.shortcuts')}</span>
          <kbd className="kbd">{shortcut('/')}</kbd>
          <ChevronRight size={13} className="flex-shrink-0 text-app-text-muted" />
        </button>
      </div>
    </SubmenuItem>
  );
}

/**
 * The language: ONE preference with two stores, kept in agreement.
 *
 * localStorage for the interface (where `t()` reads it synchronously) and the
 * `app_settings` row for the model. The one-off re-alignment on mount serves
 * whoever chose a language before the choice reached the model: it writes only
 * when the server answered and has nothing, so it never overwrites a choice
 * made later in another window.
 */
function LanguageRow({ value, onChange }: {
  value: LocalePreference;
  onChange: (v: LocalePreference) => void;
}) {
  const tr = useT();
  const { snapshot } = useProvidersSnapshot();
  const mounted = useRef(value);

  useEffect(() => {
    let live = true;
    void (async () => {
      const onServer = await fetchOutputLanguage();
      if (!live) return;
      if (!onServer.known || onServer.value !== null) return;
      if (mounted.current === 'auto') return;
      void pushOutputLanguage(mounted.current);
    })();
    return () => { live = false; };
  }, []);

  const handle = (next: LocalePreference) => {
    onChange(next);
    void pushOutputLanguage(next);
  };

  const support = languageSupport(snapshot, value);
  // Which catalogue did not arrive, if any: without this line, picking English
  // with the lazy chunk unreachable changes nothing and says nothing.
  const failed = useSyncExternalStore(subscribeCatalogues, failedLocales, failedLocales);
  const catalogueMissing = value !== 'auto' && failed.split(',').includes(value);

  return (
    <PreferenceRow
      label={tr('appearance.language')}
      hint={
        <>
          <span data-testid="settings-language-support" className={support.tone}>{tr(support.key, support.params)}</span>
          {catalogueMissing && (
            <span data-testid="settings-language-catalogue-missing" className="block text-amber-800 dark:text-amber-400">
              {tr('appearance.language.catalogueMissing')}
            </span>
          )}
        </>
      }
    >
      <Select<LocalePreference>
        value={value}
        onChange={handle}
        ariaLabel="Lingua · Language"
        testId="settings-language"
        className="w-[124px]"
        options={LANGUAGE_OPTIONS}
      />
    </PreferenceRow>
  );
}

/**
 * What is known of the default engine's language support. «I do not know» is
 * not «it cannot»: absent or `unknown` is a grey line and nothing else.
 */
function languageSupport(
  snapshot: { providers: Array<{ name: string; label?: string; languages?: { supported: string[] | null; source: string } }>; defaultProvider: string | null } | null,
  value: LocalePreference,
): { key: string; params?: Record<string, string | number>; tone: string } {
  const GREY = 'text-app-text-muted';
  if (value === 'auto') return { key: 'appearance.language.support.none', tone: GREY };
  const entry = snapshot?.providers.find((p) => p.name === snapshot.defaultProvider);
  const declared = entry?.languages;
  if (!declared || declared.source === 'unknown') return { key: 'appearance.language.support.unverified', tone: GREY };
  const named = entry?.label ?? entry?.name ?? null;
  // `supported: null` with a real source means "all of them".
  const ok = declared.supported === null || declared.supported.includes(value);
  const good = 'text-green-800 dark:text-green-400';
  const warn = 'text-amber-800 dark:text-amber-400';
  if (named === null) {
    return ok
      ? { key: 'appearance.language.support.confirmedAnon', tone: good }
      : { key: 'appearance.language.support.missingAnon', tone: warn };
  }
  return ok
    ? { key: 'appearance.language.support.confirmed', params: { engine: named }, tone: good }
    : { key: 'appearance.language.support.missing', params: { engine: named }, tone: warn };
}
