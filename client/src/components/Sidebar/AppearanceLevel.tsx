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
import { lazy, Suspense } from 'react';
import { Palette } from 'lucide-react';
import type { AppSettings, ThemeMode } from '../../types';
import { useT } from '@/hooks/useT';
import { SubmenuItem } from '../Shared/SubmenuItem';

/** What the preference levels read and write, as `App` hands it down. */
export interface MenuPreferences {
  settings: AppSettings;
  onSettingChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  /** Opens the keyboard shortcuts window (⌘/). */
  onOpenShortcuts: () => void;
}

// The level's body is loaded the first time the level opens: the row and its
// tail are all the first paint needs.
const AppearanceLevelBody = lazy(async () => {
  const { AppearanceLevelBody: Body } = await import('./AppearanceLevelBody');
  return { default: Body };
});

export function AppearanceLevel({ preferences, isMobile, onClose, defaultOpen = false }: {
  preferences: MenuPreferences;
  isMobile: boolean;
  onClose: () => void;
  defaultOpen?: boolean;
}) {
  const tr = useT();
  const { settings, themeMode } = preferences;
  const themeName = tr(`appearance.theme.${themeMode}`);

  return (
    <SubmenuItem
      icon={Palette}
      label={tr('settings.section.appearance')}
      testId="topics-menu-appearance"
      minWidth={288}
      // A ceiling, so the language's one-line gloss wraps instead of pulling
      // the level out to its length.
      maxWidth={340}
      defaultOpen={defaultOpen}
      tail={
        <span data-testid="topics-menu-appearance-tail" className="flex-shrink-0 text-mini text-app-text-tertiary">
          {themeName} · {settings.fontSize} px
        </span>
      }
    >
      <Suspense fallback={<div className="h-24" />}>
        <AppearanceLevelBody preferences={preferences} isMobile={isMobile} onClose={onClose} />
      </Suspense>
    </SubmenuItem>
  );
}

